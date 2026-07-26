// Tests for the half of `${…}` interpolation that has no engine in it: joining
// the chunks with the hole values, refusing values that are not text, mapping
// offsets in the assembled string back to the document, and building at most
// once per cycle.
//
// The metadata here is what src/lang/interpolate.js emits — see the tests
// there for how it is derived from the source. `src/lang/mini-template.js`
// puts these together with @strudel/web, which cannot be imported under node
// (it assigns to `window` at module scope), so it is verified in the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assemble, mapLeaf, createCache } from '../src/lang/assemble.js';

// note(`[bb1]!${bars}`)
//      ^6           ^ hole ${bars} at 12..19
const META = { c: ['[bb1]!', ''], h: [[12, 19]], o: 6 };

test('values are spliced into the chunks as text', () => {
  assert.equal(assemble(META, ['16']).string, '[bb1]!16');
});

test('a number is stringified', () => {
  // A replication count or a factor is the obvious thing to compute, so
  // demanding String(n) at every hole would be ceremony.
  assert.equal(assemble(META, [16]).string, '[bb1]!16');
  assert.equal(assemble(META, [0.5]).string, '[bb1]!0.5');
  assert.equal(assemble(META, [-2]).string, '[bb1]!-2');
});

test('anything else throws, naming the hole and the type', () => {
  class Pattern {}
  assert.throws(() => assemble(META, [{}]), /hole 1 .*expected a string or number.*got Object/);
  assert.throws(() => assemble(META, [new Pattern()]), /got Pattern/);
  assert.throws(() => assemble(META, [undefined]), /got undefined/);
  assert.throws(() => assemble(META, [null]), /got null/);
  assert.throws(() => assemble(META, [['a']]), /got Array/);
  assert.throws(() => assemble(META, [true]), /got boolean/);
});

test('a number that is not finite is not text either', () => {
  // "bd*NaN" would reach the mini parser and fail there, much further from
  // the mistake.
  assert.throws(() => assemble(META, [NaN]), /got NaN/);
  assert.throws(() => assemble(META, [Infinity]), /got Infinity/);
});

test('the hole named is the one that is wrong', () => {
  const meta = { c: ['a', 'b', 'c'], h: [[1, 2], [3, 4]], o: 0 };
  assert.throws(() => assemble(meta, ['ok', {}]), /hole 2/);
});

test('a leaf inside a chunk maps to its true document range', () => {
  const { segments } = assemble(META, ['16']);
  // "[bb1]" is 0..5 of the assembled string and 6..11 in the document.
  assert.deepEqual(mapLeaf(segments, 0, 5), { start: 6, end: 11 });
});

test('a leaf that came out of a hole boxes the whole ${…}', () => {
  const { segments } = assemble(META, ['16']);
  // "16" is 6..8 assembled — two characters that exist nowhere in the
  // document. The `${bars}` that produced them does.
  assert.deepEqual(mapLeaf(segments, 6, 8), { start: 12, end: 19 });
});

test('a leaf spanning chunk and hole takes the union', () => {
  const { segments } = assemble(META, ['16']);
  assert.deepEqual(mapLeaf(segments, 5, 8), { start: 11, end: 19 });
});

test('a leaf in the chunk after a hole is not shifted by the value length', () => {
  const meta = { c: ['a ', ' b'], h: [[8, 15]], o: 6 };
  const { string, segments } = assemble(meta, ['xxxxxxxxxx']);
  assert.equal(string, 'a xxxxxxxxxx b');
  // " b" is assembled 12..14 but sits at 15..17 in the document.
  assert.deepEqual(mapLeaf(segments, 13, 14), { start: 16, end: 17 });
});

test('an escaped ${ shifts everything after it in that chunk', () => {
  // "a\${b}c" — seven characters in the document, six in the mini string.
  const meta = { c: ['a${b}c', ''], h: [[11, 15]], o: 4, e: [[1], []] };
  const { string, segments } = assemble(meta, ['2']);
  assert.equal(string, 'a${b}c2');
  assert.deepEqual(mapLeaf(segments, 0, 1), { start: 4, end: 5 });
  assert.deepEqual(mapLeaf(segments, 5, 6), { start: 10, end: 11 });
});

// --- the per-cycle memo ------------------------------------------------------

test('a cycle is built once however often it is queried', () => {
  // The scheduler queries the current cycle on every tick, ~20 times a second.
  let builds = 0;
  const cache = createCache(() => ++builds);
  assert.equal(cache.at(3), 1);
  assert.equal(cache.at(3), 1);
  assert.equal(cache.at(3), 1);
  assert.equal(builds, 1);
});

test('the next cycle builds again', () => {
  let builds = 0;
  const cache = createCache(() => ++builds);
  cache.at(3);
  cache.at(4);
  assert.equal(builds, 2);
});

test('a visualizer looking two cycles ahead does not evict the audible one', () => {
  let builds = 0;
  const cache = createCache(() => ++builds);
  for (const cycle of [10, 8, 9, 10, 11, 12, 10]) cache.at(cycle);
  assert.equal(builds, 5); // 10, 8, 9, 11, 12 — the later 10s are hits
});

test('priming builds now without claiming a cycle', () => {
  // So that a broken hole fails on Cmd+Enter rather than a cycle later.
  let builds = 0;
  const cache = createCache(() => ++builds);
  cache.prime();
  cache.at(0);
  assert.equal(builds, 2);
});
