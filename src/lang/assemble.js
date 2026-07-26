// `${…}` holes in mini-notation strings — the part with no engine in it.
//
// Joining chunks with hole values, refusing values that are not text, and
// mapping offsets in the assembled string back to the document the user is
// looking at. `lang/interpolate.js` produces the metadata; `lang/mini-template.js`
// puts this together with Strudel. Keeping the three apart is what lets this
// be tested at all: @strudel/web assigns to `window` at module scope.
//
// The metadata for `` note(`[bb1]!${bars}`) `` is
//
//   { c: ['[bb1]!', ''], h: [[12, 19]], o: 6 }
//
// — the literal chunks, each hole's `${…}` range in the document, and where
// the string's text starts. `e` carries, per chunk, the chunk-relative indices
// where a `\${` lost its backslash; it is omitted when there are none.

// A Pattern is the mistake worth predicting, and by far the easiest one to
// make: every double-quoted string in the buffer is mini-notation, so
// `const arr = ["e3", "g3"]` is an array of *patterns*, and `${arr[i]}` has no
// text in it at all. Duck-typed rather than by class — @strudel/web ships
// minified, so constructor names there are single letters.
const isPattern = (value) =>
  typeof value?.queryArc === 'function' && typeof value?.fmap === 'function';

const typeName = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'number') return String(value); // NaN, Infinity
  if (isPattern(value)) return 'Pattern';
  if (typeof value === 'object' || typeof value === 'function') {
    return value.constructor?.name ?? 'Object';
  }
  return typeof value;
};

// A hole is text substitution, so it has to produce text. Numbers count: a
// replication count or a factor is the obvious thing to compute, and demanding
// String(n) at every one of them would be ceremony. Everything else is a
// mistake worth naming — `${pick(arr, i)}` returns a Pattern, not a string, and
// stringifying it would reach the mini parser as nonsense far from the cause.
function holeText(value, index) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const hint = isPattern(value)
    ? " — a double-quoted string is already mini-notation, so write text you mean to splice in single quotes: ['e3', 'g3']"
    : '';
  throw new Error(
    `hole ${index + 1} in mini string: expected a string or number, got ${typeName(value)}${hint}`,
  );
}

// The mini string for this cycle, plus the segments it was built from: each
// one knows its range in the assembled string and the range of the document it
// came from. Those are what mapLeaf() walks.
export function assemble(meta, values) {
  const segments = [];
  let string = '';
  for (let i = 0; i < meta.c.length; i++) {
    // Chunk 0 starts where the string's text does; every later chunk starts
    // where the hole before it ended.
    const dFrom = i === 0 ? meta.o : meta.h[i - 1][1];
    segments.push({
      kind: 'chunk',
      aFrom: string.length,
      aTo: string.length + meta.c[i].length,
      dFrom,
      dTo: dFrom + meta.c[i].length,
      esc: meta.e?.[i] ?? [],
    });
    string += meta.c[i];
    if (i >= meta.h.length) continue;
    const text = holeText(values[i], i);
    segments.push({
      kind: 'hole',
      aFrom: string.length,
      aTo: string.length + text.length,
      dFrom: meta.h[i][0],
      dTo: meta.h[i][1],
      esc: [],
    });
    string += text;
  }
  return { string, segments };
}

// Where an offset inside a chunk sits in the document: the same distance in,
// plus one for every `\${` whose backslash was dropped before it. An end offset
// is exclusive, so an escape *at* it belongs to the next character, not this
// one.
function chunkOffset(seg, offset, isEnd) {
  const rel = offset - seg.aFrom;
  const dropped = seg.esc.filter((e) => (isEnd ? e < rel : e <= rel)).length;
  return seg.dFrom + rel + dropped;
}

// A leaf of the assembled string, as a range of the document. Chunk text maps
// exactly, so literal tokens box where they always did. Anything that came out
// of a hole boxes the whole `${…}` — the characters it produced exist nowhere
// on screen, and the expression that produced them does.
export function mapLeaf(segments, from, to) {
  let start = null;
  let end = null;
  for (const seg of segments) {
    const overlaps = seg.aFrom < to && seg.aTo > from;
    // A hole whose value is empty has no width to overlap with, but a leaf
    // that reaches it is still partly its doing.
    const touches = seg.kind === 'hole' && seg.aFrom === seg.aTo && seg.aFrom > from && seg.aFrom < to;
    if (!overlaps && !touches) continue;
    const segStart = seg.kind === 'hole' ? seg.dFrom : chunkOffset(seg, Math.max(from, seg.aFrom), false);
    const segEnd = seg.kind === 'hole' ? seg.dTo : chunkOffset(seg, Math.min(to, seg.aTo), true);
    start = start === null ? segStart : Math.min(start, segStart);
    end = end === null ? segEnd : Math.max(end, segEnd);
  }
  return { start: start ?? 0, end: end ?? 0 };
}

// --- the per-cycle memo ------------------------------------------------------

// How many cycles to remember. The scheduler queries the current cycle on every
// tick — around twenty times a second — and a visualizer's draw window reaches
// two cycles either side, so one slot would thrash.
const MEMO = 8;

// "Re-evaluated at the start of each cycle" is this: build once per cycle
// number, however many times that cycle is queried. Without it a hole reading a
// counter that something else is mutating would slew mid-cycle, and the holes
// would run twenty times a second instead of once.
export function createCache(build) {
  const byCycle = new Map();
  return {
    at(cycle) {
      if (byCycle.has(cycle)) return byCycle.get(cycle);
      const value = build();
      byCycle.set(cycle, value);
      if (byCycle.size > MEMO) byCycle.delete(byCycle.keys().next().value);
      return value;
    },
    // Build now, without claiming a cycle: a hole that is broken outright
    // should fail on Cmd+Enter rather than a cycle later.
    prime: () => build(),
  };
}
