// M3 — segmentation, quantization, and code emission.
//
// This is the actual engineering of voice→code (DESIGN §5.3 step 3): turn the
// continuous f0 curve from yin.js into discrete, rhythmically-snapped notes and
// render them as an editable Strudel mini-notation snippet. Quality bar is
// proof-of-concept — a recognizable, editable transcription — so every step
// here favours a simple, legible rule over musical sophistication.

// Hz → fractional MIDI note. 440Hz = A4 = 69, twelve semitones per octave.
function freqToMidi(freq) {
  return 12 * (Math.log2(freq / 440)) + 69;
}

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

// MIDI note → Strudel mini-notation token, e.g. 60 → "c4". Octave numbering
// matches Strudel core (noteToMidi: (oct+1)*12 + chroma, so c4 = 60 = middle C)
// and the M2 MIDI module, so voice and keyboard entry agree.
function midiToToken(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// Median filter over a nullable note sequence. A sung note wobbles and YIN
// occasionally drops a frame or jumps an octave; taking the median of each
// window smooths those out, kills isolated one-frame blips, and fills
// one-frame gaps. A window that is mostly unvoiced stays unvoiced (null).
function medianSmooth(notes, window = 5) {
  const half = window >> 1;
  const out = new Array(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const voiced = [];
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < notes.length && notes[j] != null) voiced.push(notes[j]);
    }
    if (voiced.length <= half) {
      out[i] = null; // window is majority silence
    } else {
      voiced.sort((a, b) => a - b);
      out[i] = voiced[voiced.length >> 1];
    }
  }
  return out;
}

// Convert the frame-wise f0 curve into a list of {note, steps} segments snapped
// to a 16th-note grid at the given tempo. `note` is a MIDI number, or null for
// a rest; `steps` counts 16th-note grid cells.
function segment(freqs, { hop, sampleRate, bpm }) {
  // Map each frame to a rounded semitone (or null when unvoiced), then smooth.
  const rawNotes = freqs.map((f) => (f > 0 ? Math.round(freqToMidi(f)) : null));
  const notes = medianSmooth(rawNotes);

  // Group consecutive equal values into runs of frames.
  const runs = [];
  for (const note of notes) {
    const last = runs[runs.length - 1];
    if (last && last.note === note) last.frames++;
    else runs.push({ note, frames: 1 });
  }

  // Quantize each run's duration to whole 16th-note steps. A 16th note lasts
  // (60/bpm)/4 seconds; runs shorter than half a step are dropped as blips.
  const frameSec = hop / sampleRate;
  const stepSec = 60 / bpm / 4;
  const segs = [];
  for (const run of runs) {
    const steps = Math.round((run.frames * frameSec) / stepSec);
    if (steps < 1) continue; // sub-16th → too short to notate
    const prev = segs[segs.length - 1];
    // Merge into the previous segment if it is the same note/rest (a dropped
    // blip can leave two like segments adjacent).
    if (prev && prev.note === run.note) prev.steps += steps;
    else segs.push({ note: run.note, steps });
  }

  // Trim leading/trailing rests — silence before the first and after the last
  // sung note carries no musical information.
  while (segs.length && segs[0].note == null) segs.shift();
  while (segs.length && segs[segs.length - 1].note == null) segs.pop();
  return segs;
}

// Render one segment as a mini-notation token: a note name or `~` rest, with an
// `@n` weight when it spans more than one grid step (Strudel elongation).
function token({ note, steps }) {
  const head = note == null ? '~' : midiToToken(note);
  return steps > 1 ? `${head}@${steps}` : head;
}

// Full pipeline tail: f0 curve → Strudel snippet string, or null if nothing was
// sung. The snippet is self-contained and immediately playable/editable:
//   setcps(bpm/240)  → one cycle = one 4/4 bar at `bpm`
//   .slow(bars)      → stretch the phrase to its real length in bars
// so weighted tokens sum to the recorded rhythm at the recorded tempo.
export function transcribe(freqs, { hop, sampleRate, bpm }) {
  const segs = segment(freqs, { hop, sampleRate, bpm });
  if (!segs.length) return null;

  const seq = segs.map(token).join(' ');
  const totalSteps = segs.reduce((sum, s) => sum + s.steps, 0);
  const bars = totalSteps / 16; // 16 sixteenth-notes per 4/4 bar
  const slow = Number(bars.toFixed(3));

  const lines = [
    `// voice → code — ${bpm} BPM, 16th-note grid`,
    `setcps(${bpm}/240)`,
    `note("${seq}")`,
    `  .s("sawtooth")`,
  ];
  if (slow !== 1) lines.push(`  .slow(${slow})`);
  return lines.join('\n') + '\n';
}
