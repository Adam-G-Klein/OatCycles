import './style.css';
import { initStrudel, evaluate, hush, samples } from '@strudel/web';
// General MIDI soundfonts (gm_acoustic_bass, gm_acoustic_grand_piano, gm_*, etc.).
// NB: we import registerSoundfonts from our OWN module, not @strudel/soundfonts.
// @strudel/soundfonts registers into a second copy of @strudel/webaudio, which
// the @strudel/web engine never reads — so its gm_* sounds come out silent.
// Our version registers through @strudel/web's registry. See sounds/soundfonts.js.
import { registerSoundfonts } from './sounds/soundfonts.js';
import { Drawer, getDrawContext } from '@strudel/draw';
import { createEditor } from './editor/editor.js';
import { setupCheatsheet } from './editor/cheatsheet.js';
import { registerSliders } from './editor/slider.js';
import { registerWidgets, clearWidgetCanvases } from './editor/widget.js';
import { setupMidiPanel } from './midi/midi.js';
import { setupVoicePanel } from './voice/voice.js';
import { setupSongsPanel } from './songs/songs.js';
import { writeOut } from './songs/writeout.js';
import { createSession } from './net/session.js';
import { setupNetPanel } from './net/panel.js';
import { loadIdentity, parseCredentials } from './net/identity.js';

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

// How much of the pattern a visualizer can see: two cycles either side of the
// playhead, so a punchcard has something to scroll in from the right and a
// tail to scroll out to the left. Plain highlighting wants [0, 0] instead —
// only what is sounding this instant — so afterEval picks between the two.
const DRAW_TIME = [-2, 2];

// The full-screen canvas behind the code, which the un-prefixed visualizers
// (.punchcard(), .scope(), …) draw onto — as opposed to the ._ forms, which get
// their own inline canvas. It's a window-sized bitmap, so it's created on the
// first frame that actually has something to paint rather than at boot.
// getDrawContext() reuses the #test-canvas element if it's already there, which
// is how @strudel/web's own inlined copy of @strudel/draw finds the same one.
let drawContext = null;
const fullScreenContext = () => (drawContext ??= getDrawContext());

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
      // Same for the visualizers, which would otherwise freeze mid-frame.
      drawContext?.clearRect(0, 0, drawContext.canvas.width, drawContext.canvas.height);
      clearWidgetCanvases();
    }
  },
  // After each eval, refresh the mini-notation locations the transpiler found
  // and re-seed the drawer so highlighting matches the new pattern.
  afterEval: ({ pattern, meta }) => {
    editor.updateMiniLocations(meta?.miniLocations || []);
    editor.updateSliders(meta?.widgets || []);
    editor.updateWidgets(meta?.widgets || []);
    // Widen the drawer's window only if this pattern actually has something to
    // visualize — querying two cycles ahead every frame isn't free, and plain
    // highlighting has no use for the haps it would return.
    drawer?.setDrawTime(pattern?.getPainters?.().length ? DRAW_TIME : [0, 0]);
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
    // The transpiler rewrites slider(...) into sliderWithID(...), which nothing
    // in @strudel/web defines — it has to be in the eval scope before the first
    // evaluate(), and prebake is the last thing awaited before we're ready.
    await registerSliders();
    // Same deadline for the visualizers: until their types are registered the
    // transpiler doesn't recognise ._punchcard(…) as a widget call at all.
    registerWidgets();
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

// The bottom dock: one preview at a time, either the reference keyboard (:kyb /
// :nkyb) or the mini-notation cheatsheet (:mini / :nmini). They share the space,
// so showing one hides the other.
const keyboardRef = document.getElementById('keyboard-ref');
const cheatsheet = setupCheatsheet(document.getElementById('mini-ref'));

const editor = createEditor({
  parent: document.getElementById('editor'),
  initialCode: DEFAULT_CODE,
  onEvaluate: play,
  onStop: stop,
  onShowKeyboard: () => {
    cheatsheet.hide();
    keyboardRef.hidden = false;
    editor.focus();
  },
  onHideKeyboard: () => {
    keyboardRef.hidden = true;
    editor.focus();
  },
  onShowMini: () => {
    keyboardRef.hidden = true;
    cheatsheet.show();
    editor.focus();
  },
  onHideMini: () => {
    cheatsheet.hide();
    editor.focus();
  },
  onStatus: (text, kind) => setStatus(text, kind),
  vimMode: vimStored,
});

// The Drawer syncs an animation-frame loop to the scheduler's clock. It starts
// on [0, 0] — the present instant, no look-ahead or behind, exactly the window
// needed to box what's sounding now — and afterEval widens it when the pattern
// carries visualizers. Each frame we do two things with the haps it hands us:
// outline the ones active right now, and run the pattern's painters.
//
// The painters come from .onPaint() calls collected during invalidate(), and
// each is `(ctx, time, haps, drawTime) => void`. An inline visualizer closes
// over its own canvas and ignores the context passed here; the un-prefixed
// forms use it, which is what puts them on the full-screen canvas. They always
// get DRAW_TIME rather than the drawer's current window, so the geometry they
// draw doesn't jump on the frame where afterEval switches it.
drawer = new Drawer((haps, time, _drawer, painters) => {
  const active = haps.filter((hap) => hap.isActive(time));
  editor.highlightHaps(time, active);
  if (painters?.length) {
    const ctx = fullScreenContext();
    painters.forEach((painter) => painter(ctx, time, haps, DRAW_TIME));
  }
}, [0, 0]);

// Settings toggle: reflect the persisted value, then keep editor + storage in sync.
const vimCheckbox = document.getElementById('vim-mode');
vimCheckbox.checked = vimStored;
vimCheckbox.addEventListener('change', () => {
  const on = vimCheckbox.checked;
  localStorage.setItem(VIM_KEY, String(on));
  editor.setVimMode(on);
});

// Mobile menu: on narrow screens the topbar's secondary controls (Vim, MIDI,
// voice, Multiplayer, Songs) collapse behind a hamburger, and #menu-items is
// styled as a dropdown (see the max-width rules in style.css). On desktop the
// wrapper is display:contents and the toggle is hidden, so the `.open` class is
// inert there — this wiring is harmless when the hamburger isn't shown.
const menuToggle = document.getElementById('menu-toggle');
const menuItems = document.getElementById('menu-items');

function setMenuOpen(open) {
  menuItems.classList.toggle('open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
}

menuToggle.addEventListener('click', (e) => {
  e.stopPropagation(); // don't let the document handler below close it immediately
  setMenuOpen(!menuItems.classList.contains('open'));
});

// A tap anywhere outside the open menu (and outside the hamburger) closes it.
document.addEventListener('click', (e) => {
  if (!menuItems.classList.contains('open')) return;
  if (menuItems.contains(e.target) || menuToggle.contains(e.target)) return;
  setMenuOpen(false);
});

// Escape closes the menu (only acts while it's open; otherwise it's a no-op and
// the editor/song-panel keep their own Escape handling).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuItems.classList.contains('open')) setMenuOpen(false);
});

// Opening the Songs panel slides it in over the editor, so collapse the menu to
// get it out of the way. (The panel toggle itself is wired up in the songs
// setup below; this listener just closes the menu alongside it.)
document.getElementById('songs-toggle').addEventListener('click', () => setMenuOpen(false));

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

// Networked play: a shared editing session over WebRTC (see NETWORKED-PLAY.md).
//
// What syncs is the document and presence — cursors, selections, names. Not the
// clock, and not playback: every peer evaluates and hears their own engine, and
// nobody can start, stop, or re-evaluate anyone else's audio.
//
// The session is created up front so the songs panel can consult it for its
// lock state, but nothing touches the network until :host / :join.
let netPanel = null;
const session = createSession({
  onStatus: (text, kind) => setStatus(text, kind),
  // Bind the editor to the shared document before the transport comes up.
  onReady: () => enterSession(),
  // A rename by a peer, arriving through the shared `meta` map.
  onSongName: (name) => songs?.applyRemoteName(name),
  onChange: (snap) => {
    netPanel?.update(snap);
    songs?.refresh();
    // Guests are read-only until the first remote update lands — the seeding
    // rule, and the honest thing to show while there's nothing to edit yet.
    editor.setReadOnly(snap.status === 'connecting');
  },
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
  // Networked play: while a session owns the buffer, switching songs would
  // replace everyone's work, and a guest must not write to disk at all.
  sessionLock: () => (session.active ? 'in session — :leave to switch songs' : null),
  suppressSave: () => session.role === 'guest',
  onRename: (name) => session.active && session.setSongName(name),
}).then((api) => {
  songs = api;
  editor.setSongCommands({
    onOpenSongs: () => songs.open(),
    onRenameSong: (name) => songs.renameCurrent(name),
    onNewSong: (name) => songs.newSong(name),
    onCopySong: () => songs.copyCurrent(),
    onWriteOut: (argString) => writeOutCurrent(argString),
  });
  document.getElementById('songs-toggle').addEventListener('click', () => songs.toggle());
  return api;
});

// --- :writeout ---------------------------------------------------------------
//
// Write the buffer out to a path of the user's choosing, for redundancy — a git
// repo, a synced folder, a backup dir. Unlike the songs store this is a copy
// *out*: it never touches the song list, and the app keeps editing the same
// song afterwards. The dev server does the path resolution and the write (see
// vite-writeout-plugin.js).
//
// The path is remembered per song name so a bare `:writeout` repeats the last
// destination for the song you're on — the usual "back it up again" gesture —
// without ever silently writing song B over song A's backup.
const WRITEOUT_KEY = 'oat.writeoutPaths';

function loadWriteOutPaths() {
  try {
    const raw = JSON.parse(localStorage.getItem(WRITEOUT_KEY));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function rememberWriteOutPath(song, target) {
  const paths = loadWriteOutPaths();
  paths[song] = target;
  localStorage.setItem(WRITEOUT_KEY, JSON.stringify(paths));
}

// The server answers with an absolute path, which for anything deep enough
// wraps the topbar onto a second line. Show the tail — the last two segments
// are what identifies the file — once it gets long.
function shortPath(p, max = 52) {
  if (p.length <= max) return p;
  return '…/' + p.split('/').slice(-2).join('/');
}

async function writeOutCurrent(argString) {
  await songsReady;
  const name = songs?.currentName() ?? 'untitled';
  const target = (argString || '').trim() || loadWriteOutPaths()[name] || '';
  if (!target) {
    setStatus('usage: :writeout <path>', 'error');
    editor.focus();
    return;
  }
  try {
    const written = await writeOut({ path: target, code: editor.getCode(), name });
    rememberWriteOutPath(name, target);
    setStatus(`wrote ${shortPath(written)}`);
    statusEl.title = written; // full destination on hover
  } catch (err) {
    console.error(err);
    setStatus('writeout failed: ' + (err?.message ?? err), 'error');
  }
  editor.focus();
}

// --- session lifecycle -------------------------------------------------------
//
// Entering a session flips six things at once (and leaving reverses all six):
// yCollab on, undo switched to the Yjs UndoManager, song switching locked,
// disk autosave suppressed for guests, a visible accent in your own colour, and
// — for guests — read-only until first sync.

// The buffer is auto-saved before hosting or joining, the same guarantee the
// songs panel already makes before any switch/create/rename/delete.
async function saveBeforeSession() {
  await songsReady;
  songs?.autoSaveCurrent();
}

function enterSession() {
  const snap = session.snapshot();
  editor.setCollab(session.collabExtension(), session.initialText());
  editor.setSessionUndo({ undo: session.undo, redo: session.redo });
  editor.setAccent(snap.self.color);
  editor.setReadOnly(snap.status === 'connecting');
  songs?.refresh();
}

async function hostSession(credentials) {
  if (session.active) {
    setStatus('already in a session — :leave first', 'error');
    return;
  }
  await saveBeforeSession();
  const { roomId, passphrase } = credentials ?? netPanel.rollCredentials();
  try {
    await session.host({
      roomId,
      passphrase,
      code: editor.getCode(),
      songName: songs?.currentName() ?? null,
    });
  } catch (err) {
    console.error(err);
    setStatus('host failed: ' + (err?.message ?? err), 'error');
    await leaveSession();
  }
}

async function joinSession({ roomId, passphrase }) {
  if (session.active) {
    setStatus('already in a session — :leave first', 'error');
    return;
  }
  await saveBeforeSession();
  try {
    await session.join({ roomId, passphrase });
  } catch (err) {
    console.error(err);
    setStatus('join failed: ' + (err?.message ?? err), 'error');
    await leaveSession();
  }
}

async function leaveSession() {
  if (!session.active) return;
  const wasGuest = session.role === 'guest';
  const room = session.roomId;
  const hostName = session.snapshot().peers.find((p) => p.isHost)?.name ?? 'host';
  const code = editor.getCode();

  // Order matters: unbind the editor from the Y.Text *before* the session tears
  // the document down, and before anything tries to rewrite the buffer.
  editor.setCollab(null);
  editor.setSessionUndo(null);
  editor.setAccent(null);

  await session.leave();

  // A guest wrote nothing to disk while connected, so the shared buffer would
  // otherwise vanish with the session. Land it as a new local song instead.
  // (Nothing to save if they never synced — that buffer is empty by design.)
  if (wasGuest && code.trim()) {
    await songsReady;
    songs?.importSong(`${room} (from ${hostName})`, code);
  } else if (wasGuest) {
    // Never synced: the blank buffer is an artefact of joining, not work.
    songs?.reopenCurrent();
  }
  songs?.refresh();
  editor.focus();
}

netPanel = setupNetPanel({
  root: document.getElementById('net'),
  toggleBtn: document.getElementById('net-toggle'),
  dropdown: document.getElementById('net-dropdown'),
  nameInput: document.getElementById('net-name'),
  colorInput: document.getElementById('net-color'),
  idleSection: document.getElementById('net-idle'),
  hostRoomEl: document.getElementById('net-host-room'),
  hostPassInput: document.getElementById('net-host-pass'),
  hostCopyBtn: document.getElementById('net-host-copy'),
  rerollBtn: document.getElementById('net-host-reroll'),
  hostBtn: document.getElementById('net-host'),
  joinRoomInput: document.getElementById('net-join-room'),
  joinPassInput: document.getElementById('net-join-pass'),
  joinBtn: document.getElementById('net-join'),
  connectedSection: document.getElementById('net-connected'),
  roomEl: document.getElementById('net-room'),
  copyBtn: document.getElementById('net-copy'),
  peersEl: document.getElementById('net-peers'),
  leaveBtn: document.getElementById('net-leave'),
  onHost: hostSession,
  onJoin: joinSession,
  onLeave: leaveSession,
  onIdentity: (identity) => {
    session.setIdentity(identity);
    if (session.active) editor.setAccent(identity.color);
  },
  onStatus: (text, kind) => setStatus(text, kind),
});

// Seed the session with the persisted name/colour so the first awareness
// broadcast already carries them.
session.setIdentity(loadIdentity());

// Vim equivalents: :host, :join <room> <passphrase>, :leave.
editor.setSessionCommands({
  onHostSession: () => hostSession(netPanel.hostCredentials()),
  onJoinSession: (argString) => {
    const { roomId, passphrase } = parseCredentials(argString);
    if (!roomId || !passphrase) {
      setStatus('usage: :join <room> <passphrase>', 'error');
      return;
    }
    joinSession({ roomId, passphrase });
  },
  onLeaveSession: leaveSession,
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
