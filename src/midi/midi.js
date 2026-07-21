import { evalScope } from '@strudel/web';

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

export function setupMidiPanel({ enableBtn, deviceSelect, insertBtn, typeToggle, activity, onInsertSnippet, onInsertNote, onStatus }) {
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

  function typingArmed() {
    return !!(typeToggle && typeToggle.checked);
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
    // Drop any half-formed chord so it can't leak into a new device/context.
    clearChord();
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
      const noteon = e.message.command === 9 && e.dataBytes[1] > 0;
      if (!noteon) return;
      const midiNote = e.dataBytes[0];
      flash(noteName(midiNote));
      // When note-entry is armed, feed the note through the chord buffer, which
      // decides between a bare note and a stack once the window closes.
      if (typingArmed()) bufferNote(midiNote);
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
  insertBtn.addEventListener('click', () => {
    const name = selectedName();
    if (name) onInsertSnippet?.(snippetFor(name));
  });
}
