// MIDI take → code — quantize a recorded keyboard take to a 16th-note grid and
// emit weighted Strudel mini-notation. This is the timing-aware counterpart to
// the streaming "Type notes" path in midi.js: instead of one token per key, a
// whole phrase is captured (note-on/off with timestamps) and turned into a
// rhythmic, editable snippet — mirroring the voice pipeline's output format
// (see src/voice/transcribe.js) so voice and keyboard code look the same.
//
// Pure and event-based: no Web MIDI, no DOM. `events` is a list of played notes
//   { midi, on, off }   // on/off are DOMHighResTimeStamps (ms); off may be
//                        // null for a note still held when the take ended.

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

// MIDI number → lowercase mini-notation token, e.g. 60 → "c4" (middle C).
// Octave numbering matches Strudel core and the M2/M3 modules so all three
// note-entry paths agree.
function noteToken(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// A rest spanning `steps` grid cells: `~` alone, or `~@n` when elongated.
function rest(steps) {
  return steps > 1 ? `~@${steps}` : '~';
}

// One attack: a bare note or a chord stack `[c4,e4,g4]`, with an `@n` weight
// when it spans more than one grid step (Strudel elongation).
function attackToken(notes, steps) {
  const head = notes.length > 1 ? `[${notes.join(',')}]` : notes[0];
  return steps > 1 ? `${head}@${steps}` : head;
}

// Recorded events → { seq, totalSteps } on a 16th-note grid at `bpm`, or null
// when nothing usable was played. Notes that share a quantized onset become a
// chord; each attack lasts until the next one, so overlapping/held voices are
// linearized into a single legible sequence (block chords render exactly; truly
// independent overlapping lines get merged — acceptable at this quality bar,
// matching how the monophonic voice pipeline treats runs).
function quantize(events, bpm) {
  const stepMs = (60 / bpm / 4) * 1000; // one 16th note in milliseconds

  // Establish the take's time window. A note still held at stop (off == null)
  // is clamped to the end of the last released note (or its own onset).
  const ons = events.map((e) => e.on).filter((t) => Number.isFinite(t));
  if (!ons.length) return null;
  const t0 = Math.min(...ons);
  const offs = events.map((e) => e.off).filter((t) => Number.isFinite(t));
  const takeEnd = offs.length ? Math.max(...offs) : t0;

  // Quantize each note to (startStep, steps ≥ 1) relative to the first onset.
  const notes = [];
  for (const e of events) {
    if (!Number.isFinite(e.on)) continue;
    const end = Number.isFinite(e.off) ? e.off : takeEnd;
    const startStep = Math.round((e.on - t0) / stepMs);
    const endStep = Math.round((end - t0) / stepMs);
    notes.push({ midi: e.midi, startStep, steps: Math.max(1, endStep - startStep) });
  }

  // Group notes by shared onset into chords; a chord lasts as long as its
  // longest member.
  const byStart = new Map();
  for (const n of notes) {
    const g = byStart.get(n.startStep);
    if (g) {
      g.midis.push(n.midi);
      g.steps = Math.max(g.steps, n.steps);
    } else {
      byStart.set(n.startStep, { startStep: n.startStep, midis: [n.midi], steps: n.steps });
    }
  }
  const groups = [...byStart.values()].sort((a, b) => a.startStep - b.startStep);
  if (!groups.length) return null;

  // Walk the grid: emit rests for gaps, then each attack clamped so it never
  // runs into the next one (keeps the sequence monophonic in time).
  const tokens = [];
  let pos = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const start = Math.max(g.startStep, pos);
    if (start > pos) tokens.push(rest(start - pos));
    const nextStart = i + 1 < groups.length ? Math.max(groups[i + 1].startStep, start + 1) : Infinity;
    const steps = Math.max(1, Math.min(g.steps, nextStart - start));
    const labels = [...new Set(g.midis)].sort((a, b) => a - b).map(noteToken);
    tokens.push(attackToken(labels, steps));
    pos = start + steps;
  }

  return { seq: tokens.join(' '), totalSteps: pos };
}

// Full pipeline: recorded events → a self-contained, playable/editable Strudel
// snippet, or null when nothing was recorded. Same wrapper as voice→code:
//   setcps(bpm/240)  → one cycle = one 4/4 bar at `bpm`
//   .slow(bars)      → stretch the phrase to its real length in bars
// so the weighted tokens sum back to the recorded rhythm at the recorded tempo.
export function midiTake(events, { bpm }) {
  const q = quantize(events, bpm);
  if (!q) return null;

  const bars = q.totalSteps / 16; // 16 sixteenth-notes per 4/4 bar
  const slow = Number(bars.toFixed(3));

  const lines = [
    `// midi → code — ${bpm} BPM, 16th-note grid`,
    `setcps(${bpm}/240)`,
    `note("${q.seq}")`,
    `  .s("sawtooth")`,
  ];
  if (slow !== 1) lines.push(`  .slow(${slow})`);
  return lines.join('\n') + '\n';
}
