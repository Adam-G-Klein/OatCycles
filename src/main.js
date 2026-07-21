import './style.css';
import { initStrudel, evaluate, hush, samples } from '@strudel/web';
// General MIDI soundfonts (gm_acoustic_bass, gm_acoustic_grand_piano, gm_*, etc.).
// NB: we import registerSoundfonts from our OWN module, not @strudel/soundfonts.
// @strudel/soundfonts registers into a second copy of @strudel/webaudio, which
// the @strudel/web engine never reads — so its gm_* sounds come out silent.
// Our version registers through @strudel/web's registry. See sounds/soundfonts.js.
import { registerSoundfonts } from './sounds/soundfonts.js';
import { Drawer } from '@strudel/draw';
import { createEditor } from './editor/editor.js';
import { setupMidiPanel } from './midi/midi.js';
import { setupVoicePanel } from './voice/voice.js';
import { setupSongsPanel } from './songs/songs.js';

// A default pattern that proves the plugin seam end-to-end: mini-notation,
// a synth sound (offline — no sample downloads), and some pattern transforms.
const DEFAULT_CODE = `// OatCycles — press Cmd+Enter to play, Cmd+. to stop
note("c3 eb3 g3 bb3")
  .s("sawtooth")
  .cutoff(sine.range(400, 2000).slow(4))
  .lpq(8)
  .gain(0.7)
  .slow(2)`;

const statusEl = document.getElementById('status');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
  // Full text on hover — error messages can be longer than the topbar shows.
  statusEl.title = kind === 'error' ? text : '';
}

// The Strudel REPL's default sound library (piano, jazz, gm_*, drum machines,
// dirt samples, etc.) is NOT bundled by @strudel/web — it only registers the
// synth waveforms. These are the same sample banks the official REPL preloads,
// hosted on felixroos/dough-samples. Registering the maps is cheap (JSON only);
// the audio itself is lazily fetched the first time a sound is played.
const SAMPLE_BASE = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const DEFAULT_SAMPLE_BANKS = [
  'tidal-drum-machines.json', // RolandTR808/909, LinnDrum, etc.
  'piano.json', // "piano"
  'Dirt-Samples.json', // classic Tidal samples incl. "jazz"
  'EmuSP12.json', // "casio", "east", "space" and friends
  'vcsl.json', // Versilian orchestral instruments
  'mridangam.json', // tuned percussion
];

// Live highlighting: the scheduler drives an animation-frame loop (Drawer) that,
// each frame, hands us the haps sounding right now. We box the source tokens
// that produced them, so the outlines shift as playback advances. `scheduler`
// is captured once the engine is ready; `drawer` is built after the editor
// exists (both are only used at playback time, well after module load).
let scheduler = null;
let drawer = null;

// Boot the Strudel engine (audio + REPL). This is the @strudel/web seam:
// initStrudel() → evaluate(code) → hush().
const strudelReady = initStrudel({
  // Report transport state, and start/stop the highlight loop with playback.
  onToggle: (started) => {
    setStatus(started ? '● playing' : 'stopped', started ? 'playing' : '');
    if (started) {
      scheduler && drawer?.start(scheduler);
    } else {
      drawer?.stop();
      // Clear any lingering boxes when playback stops.
      editor.highlightHaps(0, []);
    }
  },
  // After each eval, refresh the mini-notation locations the transpiler found
  // and re-seed the drawer so highlighting matches the new pattern.
  afterEval: ({ meta }) => {
    editor.updateMiniLocations(meta?.miniLocations || []);
    scheduler && drawer?.invalidate(scheduler);
  },
  // The repl swallows evaluation failures (syntax errors, unknown sounds/
  // commands, etc.) internally and returns undefined, so play()'s try/catch
  // never sees them. Surface them in the topbar instead.
  onEvalError: (err) => {
    console.error(err);
    setStatus('eval error: ' + (err?.message ?? err), 'error');
  },
  // Load the default sound library after the engine's own prebake. A failed
  // bank (offline, etc.) shouldn't sink the whole engine — synths still work.
  prebake: async () => {
    setStatus('loading sounds…');
    const results = await Promise.allSettled([
      // General MIDI soundfonts: gm_acoustic_bass, gm_acoustic_grand_piano, etc.
      registerSoundfonts(),
      // Sample banks (piano, jazz, drum machines, …) from felixroos/dough-samples.
      ...DEFAULT_SAMPLE_BANKS.map((bank) => samples(`${SAMPLE_BASE}/${bank}`)),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      console.warn('Some sounds failed to load:', failed.map((r) => r.reason));
    }
  },
})
  .then((repl) => {
    scheduler = repl.scheduler;
    setStatus('ready');
  })
  .catch((err) => {
    console.error(err);
    setStatus('engine failed to init', 'error');
  });

// Vim setting persists across sessions in localStorage; on by default until the
// user explicitly turns it off.
const VIM_KEY = 'oat.vimMode';
const vimSaved = localStorage.getItem(VIM_KEY);
const vimStored = vimSaved === null ? true : vimSaved === 'true';

// Reference keyboard docked at the bottom of the screen. Toggled by the :kyb
// (show) and :nkyb (hide) vim commands.
const keyboardRef = document.getElementById('keyboard-ref');

const editor = createEditor({
  parent: document.getElementById('editor'),
  initialCode: DEFAULT_CODE,
  onEvaluate: play,
  onStop: stop,
  onShowKeyboard: () => {
    keyboardRef.hidden = false;
    editor.focus();
  },
  onHideKeyboard: () => {
    keyboardRef.hidden = true;
    editor.focus();
  },
  onStatus: (text, kind) => setStatus(text, kind),
  vimMode: vimStored,
});

// The Drawer syncs an animation-frame loop to the scheduler's clock. drawTime
// [0, 0] means we only care about the present instant (no look-ahead/behind) —
// exactly the window needed to box what's sounding now. Each frame we keep the
// haps active at `time` and hand them to the editor to outline.
drawer = new Drawer((haps, time) => {
  const active = haps.filter((hap) => hap.isActive(time));
  editor.highlightHaps(time, active);
}, [0, 0]);

// Settings toggle: reflect the persisted value, then keep editor + storage in sync.
const vimCheckbox = document.getElementById('vim-mode');
vimCheckbox.checked = vimStored;
vimCheckbox.addEventListener('change', () => {
  const on = vimCheckbox.checked;
  localStorage.setItem(VIM_KEY, String(on));
  editor.setVimMode(on);
});

// MIDI panel (M2): device picker + midikeys snippet insertion + activity
// indicator. Opt-in — nothing touches Web MIDI until the user clicks Enable.
setupMidiPanel({
  enableBtn: document.getElementById('midi-enable'),
  deviceSelect: document.getElementById('midi-device'),
  insertBtn: document.getElementById('midi-insert'),
  typeToggle: document.getElementById('midi-type'),
  activity: document.getElementById('midi-activity'),
  onInsertSnippet: (text) => editor.insertAtCursor(text),
  // Note-entry mode: each played key drops its mini-notation token at the cursor.
  onInsertNote: (text) => editor.insertAtCursor(text),
  onStatus: (text, kind) => setStatus(text, kind),
});

// Voice panel (M3): sing a melody → YIN pitch tracking → quantized Strudel
// snippet inserted at the cursor. Opt-in — the mic is only touched on Sing.
setupVoicePanel({
  recordBtn: document.getElementById('voice-record'),
  bpmInput: document.getElementById('voice-bpm'),
  onInsert: (text) => editor.insertAtCursor(text),
  onStatus: (text, kind) => setStatus(text, kind),
});

// Songs panel: on-disk file system for saved works. Restores the last-open
// song into the editor on load (read from ./songs text files via /api/songs,
// falling back to the localStorage mirror), auto-saves on every play, and
// drives the collapsible right-side list. Vim commands (:o open, :name rename,
// :new) route through here. Setup is async because it reads songs from disk.
let songs = null;
const songsReady = setupSongsPanel({
  panel: document.getElementById('song-panel'),
  listEl: document.getElementById('song-list'),
  newBtn: document.getElementById('song-new'),
  filenameEl: document.getElementById('song-name'),
  getCode: () => editor.getCode(),
  setCode: (code) => editor.setCode(code),
  focusEditor: () => editor.focus(),
  onStatus: (text, kind) => setStatus(text, kind),
}).then((api) => {
  songs = api;
  editor.setSongCommands({
    onOpenSongs: () => songs.open(),
    onRenameSong: (name) => songs.renameCurrent(name),
    onNewSong: (name) => songs.newSong(name),
    onCopySong: () => songs.copyCurrent(),
  });
  document.getElementById('songs-toggle').addEventListener('click', () => songs.toggle());
  return api;
});

async function play(code = editor.getCode()) {
  try {
    await songsReady; // ensure the disk-loaded song is current before saving
    songs?.autoSaveCurrent(); // persist the current buffer to its file on every play
    await strudelReady;
    await evaluate(code);
  } catch (err) {
    console.error(err);
    setStatus('eval error: ' + err.message, 'error');
  }
}

function stop() {
  hush();
  setStatus('stopped');
}

document.getElementById('play').addEventListener('click', () => play());
document.getElementById('stop').addEventListener('click', stop);
