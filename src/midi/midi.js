import { evalScope } from '@strudel/web';
import { midiTake } from './record.js';

// M2 — MIDI keyboard UX (Chrome).
//
// Per DESIGN §5.2 Phase 1, MIDI keyboard *input* already works in Strudel via
// `@strudel/midi`'s `midikeys()` (Web MIDI). Our job here is to surface it: an
// on-demand "Enable MIDI" gesture, a device picker, an "insert midikeys
// snippet" button, and a live activity indicator. (Held-note sustain is a
// separate core patch, deferred to M5.)
//
// `@strudel/midi` is loaded lazily so its Web MIDI side effects and the browser
// permission prompt only happen once the user opts in.

let midiModulePromise = null;
function loadMidi() {
  if (!midiModulePromise) {
    midiModulePromise = import('@strudel/midi').then(async (mod) => {
      // Register midikeys()/midin()/etc. into the Strudel evaluate scope so they
      // are callable from user code. evalScope comes from the same (deduped)
      // @strudel/core instance @strudel/web uses, so the audio/scheduler
      // singletons midikeys relies on are shared.
      await evalScope(mod);
      return mod;
    });
  }
  return midiModulePromise;
}

// Panic: silence anything still ringing on external hardware. The audio graph's
// own panic can't reach MIDI — it leaves the machine entirely — so a pattern
// routed through .midi() needs its own note-offs. Called by the second press of
// Stop (see main.js).
//
// Deliberately passive: if MIDI was never enabled there is nothing to hang, and
// asking for Web MIDI here would raise a permission prompt on a keypress whose
// whole purpose is to make things quieter.
export function panicMidi() {
  if (!midiModulePromise) return;
  midiModulePromise
    .then(({ WebMidi }) => {
      if (!WebMidi?.enabled) return;
      for (const output of WebMidi.outputs) {
        // CC 120 before CC 123: all-notes-off only lifts held keys, so a voice
        // already in its release stage ignores it. Both go to all 16 channels.
        output.sendAllSoundOff();
        output.sendAllNotesOff();
      }
    })
    .catch((err) => console.error(err));
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n) {
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// Lowercase mini-notation label for a MIDI note. Strudel accepts `c#4` inside a
// note(\"...\") string; octave follows scientific pitch (middle C = c4).
function noteLabel(n) {
  return noteName(n).toLowerCase();
}

// A ready-to-evaluate snippet targeting the selected device. Uses top-level
// await (supported by Strudel's transpiler) exactly like the midikeys docs.
function snippetFor(deviceName) {
  const esc = deviceName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `const kb = await midikeys("${esc}")
kb().s("sawtooth").cutoff(1500).lpq(6).gain(0.7)`;
}

const MIN_BPM = 40;
const MAX_BPM = 300;

export function setupMidiPanel({ enableBtn, deviceSelect, insertBtn, typeToggle, captureToggle, bpmInput, activity, onInsertSnippet, onInsertNote, onStatus }) {
  let WebMidi = null;
  let activeDevice = null;
  let activityListener = null;
  let flashTimer = null;

  // Chord grouping: note-ons that land within a short window are gathered and
  // emitted as a Strudel stack `[c4,e4,g4]`; a lone note emits as a bare `c4`.
  // The window opens on the first note and flushes a fixed time later, so a
  // genuine (near-simultaneous) chord clumps while melodic playing stays split.
  const CHORD_MS = 45;
  let chordBuffer = [];
  let chordTimer = null;

  // Timing capture: when armed, arming "Type notes" records a whole take
  // (note-on/off with timestamps) instead of streaming a token per key. Ending
  // the take quantizes it to a rhythmic snippet (see record.js).
  let recording = false;
  let takeEvents = [];
  const openNotes = new Map(); // midi → index into takeEvents of its note-on

  function typingArmed() {
    return !!(typeToggle && typeToggle.checked);
  }

  function captureArmed() {
    return !!(captureToggle && captureToggle.checked);
  }

  function clampBpm() {
    const bpm = Math.round(Number(bpmInput && bpmInput.value));
    return Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : 120;
  }

  function startTake() {
    clearChord(); // never mix streamed tokens into a timed take
    recording = true;
    takeEvents = [];
    openNotes.clear();
    onStatus?.('recording MIDI take… play, then uncheck to insert', 'playing');
  }

  // Discard an in-progress take without emitting (device change, capture
  // disarmed). Quiet — nothing was inserted, so nothing to announce.
  function cancelTake() {
    recording = false;
    takeEvents = [];
    openNotes.clear();
  }

  function finishTake() {
    if (!recording) return;
    recording = false;
    const events = takeEvents;
    takeEvents = [];
    openNotes.clear();
    if (!events.length) {
      onStatus?.('no notes recorded');
      return;
    }
    const code = midiTake(events, { bpm: clampBpm() });
    if (!code) {
      onStatus?.('no notes recorded');
      return;
    }
    onInsertNote?.(code);
    onStatus?.('MIDI take inserted ✓ — Ctrl+Enter to play');
  }

  function recordOn(midiNote, ts) {
    openNotes.set(midiNote, takeEvents.length);
    takeEvents.push({ midi: midiNote, on: ts, off: null });
  }

  function recordOff(midiNote, ts) {
    const idx = openNotes.get(midiNote);
    if (idx == null) return;
    takeEvents[idx].off = ts;
    openNotes.delete(midiNote);
  }

  function flushChord() {
    chordTimer = null;
    const notes = chordBuffer;
    chordBuffer = [];
    if (!notes.length) return;
    // Dedupe, sort low→high for stable output, then render. Trailing space so
    // successive entries chain into `[c4,e4,g4] c5 …`.
    const labels = [...new Set(notes)].sort((a, b) => a - b).map(noteLabel);
    const text = labels.length > 1 ? `[${labels.join(',')}] ` : labels[0] + ' ';
    onInsertNote?.(text);
  }

  function bufferNote(n) {
    chordBuffer.push(n);
    if (!chordTimer) chordTimer = setTimeout(flushChord, CHORD_MS);
  }

  function clearChord() {
    clearTimeout(chordTimer);
    chordTimer = null;
    chordBuffer = [];
  }

  function selectedName() {
    return deviceSelect.value || null;
  }

  function detachActivity() {
    if (activeDevice && activityListener) {
      activeDevice.removeListener('midimessage', activityListener);
    }
    activeDevice = null;
    activityListener = null;
    // Drop any half-formed chord or take so it can't leak into a new
    // device/context.
    clearChord();
    cancelTake();
  }

  function flash(label) {
    activity.classList.add('on');
    activity.textContent = '● ' + label;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      activity.classList.remove('on');
      activity.textContent = '●';
    }, 250);
  }

  // Attach a passive listener that flashes the indicator on note-on. This is
  // independent of midikeys' own listener — Web MIDI allows several.
  function attachActivity() {
    detachActivity();
    const name = selectedName();
    if (!name || !WebMidi) return;
    const device = WebMidi.inputs.find((i) => i.name === name);
    if (!device) return;
    activeDevice = device;
    activityListener = (e) => {
      const cmd = e.message.command;
      const noteon = cmd === 9 && e.dataBytes[1] > 0;
      // A note-off is command 8, or a note-on with velocity 0 (running status).
      const noteoff = cmd === 8 || (cmd === 9 && e.dataBytes[1] === 0);
      if (noteon) {
        const midiNote = e.dataBytes[0];
        flash(noteName(midiNote));
        if (recording) {
          // Timed take: buffer the onset with its timestamp for quantization.
          recordOn(midiNote, e.timestamp);
        } else if (typingArmed()) {
          // Streaming entry: feed the chord buffer, which decides between a bare
          // note and a stack once the window closes.
          bufferNote(midiNote);
        }
      } else if (noteoff && recording) {
        recordOff(e.dataBytes[0], e.timestamp);
      }
    };
    device.addListener('midimessage', activityListener);
  }

  function refreshDevices() {
    const inputs = WebMidi?.inputs ?? [];
    const prev = deviceSelect.value;
    deviceSelect.innerHTML = '';

    if (!inputs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'no MIDI devices';
      deviceSelect.appendChild(opt);
      deviceSelect.disabled = true;
      insertBtn.disabled = true;
      if (typeToggle) typeToggle.disabled = true;
      if (captureToggle) captureToggle.disabled = true;
      if (bpmInput) bpmInput.disabled = true;
      detachActivity();
      activity.textContent = '●';
      return;
    }

    for (const input of inputs) {
      const opt = document.createElement('option');
      opt.value = input.name;
      opt.textContent = input.name;
      deviceSelect.appendChild(opt);
    }
    if (prev && inputs.some((i) => i.name === prev)) {
      deviceSelect.value = prev;
    }
    deviceSelect.disabled = false;
    insertBtn.disabled = false;
    if (typeToggle) typeToggle.disabled = false;
    if (captureToggle) captureToggle.disabled = false;
    if (bpmInput) bpmInput.disabled = false;
    attachActivity();
  }

  async function enable() {
    enableBtn.disabled = true;
    onStatus?.('enabling MIDI…');
    try {
      const mod = await loadMidi();
      WebMidi = mod.WebMidi;
      await mod.enableWebMidi();
      enableBtn.textContent = 'MIDI on';
      enableBtn.classList.add('on');
      // Keep the device list live as hardware is plugged/unplugged.
      WebMidi.addListener('connected', refreshDevices);
      WebMidi.addListener('disconnected', refreshDevices);
      refreshDevices();
      onStatus?.('MIDI ready');
    } catch (err) {
      console.error(err);
      enableBtn.disabled = false;
      onStatus?.('MIDI error: ' + err.message, 'error');
    }
  }

  enableBtn.addEventListener('click', enable);
  deviceSelect.addEventListener('change', attachActivity);

  // With timing capture armed, "Type notes" becomes record/insert: check it to
  // start a take, uncheck it to quantize and drop the snippet. Without capture
  // it stays the streaming per-key path (handled live in the note listener).
  typeToggle?.addEventListener('change', () => {
    if (!captureArmed()) return;
    if (typeToggle.checked) startTake();
    else finishTake();
  });

  // Toggling capture mid-arm switches an already-armed session between the two
  // behaviours: turning it off ends any take in progress; turning it on while
  // "Type notes" is checked begins one.
  captureToggle?.addEventListener('change', () => {
    if (recording && !captureArmed()) finishTake();
    else if (captureArmed() && typingArmed()) startTake();
  });
  insertBtn.addEventListener('click', () => {
    const name = selectedName();
    if (name) onInsertSnippet?.(snippetFor(name));
  });
}
