// Tests for the pre-pass that gives mini-notation strings `${…}` holes.
//
// Two things are being checked. First, that a string is cut into the right
// chunks and holes — including the awkward cases, where a hole holds an
// expression with braces of its own, or where a backslash says "this `${` is
// literal". Second, that the rewrite is *invisible to everything else*: code
// with no holes must come back byte for byte, and every offset in the rewritten
// code must map back to where it came from, because that is what keeps the
// highlight boxes and the slider widgets on the right characters.
//
// All of this is pure text, so it runs without a browser or an audio context.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';

import { scanSite, expandInterpolations, mapOffset } from '../src/lang/interpolate.js';

const ACORN = { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true };

// The string node in `note("…")` — or in a bare `"…"` / `` `…` ``.
function firstString(code) {
  const { expression } = parse(code, ACORN).body[0];
  return expression.type === 'CallExpression' ? expression.arguments[0] : expression;
}

const scan = (code) => scanSite(code, firstString(code));

test('a string with no hole is not a site', () => {
  // Left for Strudel's own transpiler, exactly as today.
  assert.equal(scan('note("bd sd")'), null);
  assert.equal(scan('note(`bd sd`)'), null);
});

test('a double-quoted hole splits the string into chunks', () => {
  const src = 'note("[bb1, bb2]!${bars}")';
  const site = scan(src);
  assert.deepEqual(site.chunks, ['[bb1, bb2]!', '']);
  assert.equal(site.contentStart, 6);
  assert.equal(src.slice(site.holes[0].from, site.holes[0].to), '${bars}');
  assert.equal(src.slice(site.holes[0].exprFrom, site.holes[0].exprTo), 'bars');
});

test('a backtick hole is read from the quasis', () => {
  const src = 'note(`[bb1, bb2]!${bars} [f1. f2]!${arr[i]}`)';
  const site = scan(src);
  assert.deepEqual(site.chunks, ['[bb1, bb2]!', ' [f1. f2]!', '']);
  assert.deepEqual(
    site.holes.map((h) => src.slice(h.exprFrom, h.exprTo)),
    ['bars', 'arr[i]'],
  );
  assert.equal(src.slice(site.holes[1].from, site.holes[1].to), '${arr[i]}');
});

test('adjacent holes leave an empty chunk between them', () => {
  const site = scan('note(`${a}${b}`)');
  assert.deepEqual(site.chunks, ['', '', '']);
  assert.equal(site.holes.length, 2);
});

test('a hole may hold braces, strings and calls of its own', () => {
  // Hand-matching braces would end this hole at the `}` inside the object, and
  // a naive scan would end it at the `"` inside the ternary. Acorn does not.
  const src = 'note(`${ up ? ({ a: "}" }).a : pick(arr, i) }`)';
  const site = scan(src);
  assert.equal(site.holes.length, 1);
  assert.equal(src.slice(site.holes[0].exprFrom, site.holes[0].exprTo), 'up ? ({ a: "}" }).a : pick(arr, i)');
});

test('a string whose only ${ is escaped is not a site at all', () => {
  // JavaScript has already dropped the backslash by the time the transpiler
  // reads the value, so this one needs nothing from us.
  assert.equal(scan('note("cost \\${5} bd")'), null);
});

test('a backslash escapes a hole and is dropped from the chunk', () => {
  const site = scan('note("cost \\${5} bd ${n}")');
  assert.deepEqual(site.chunks, ['cost ${5} bd ', '']);
  assert.equal(site.holes.length, 1);
  // Where the backslash was, so offsets after it can be corrected.
  assert.deepEqual(site.escapes, [[5], []]);
});

test('an unclosed hole is an error naming the position', () => {
  assert.throws(() => scan('note("a ${b")'), /unclosed .*at offset 8/);
});

test('an empty hole is an error', () => {
  assert.throws(() => scan('note("a ${}")'), /empty \$\{\}/);
});

// --- the rewrite -------------------------------------------------------------

test('code without holes comes back byte for byte', () => {
  const src = 'note("bd sd").fast(2)\n// a comment\n';
  const { code, map } = expandInterpolations(src);
  assert.equal(code, src);
  assert.equal(mapOffset(map, 7), 7);
});

test('a site becomes an oatMini call whose chunks are single-quoted', () => {
  const { code } = expandInterpolations('note(`[bb1]!${bars}`)');
  // Single quotes matter: @strudel/transpiler only turns double-quoted strings
  // into mini-notation, so these pass through it untouched.
  assert.equal(code, "note(oatMini({c:['[bb1]!',''],h:[[12,19]],o:6},()=>[bars]))");
  // And the result is still valid JavaScript.
  assert.doesNotThrow(() => parse(code, ACORN));
});

test('quotes and newlines in a chunk are escaped for the generated string', () => {
  const { code } = expandInterpolations("note(`a'b\nc${x}`)");
  assert.match(code, /c:\['a\\'b\\nc',''\]/);
  assert.doesNotThrow(() => parse(code, ACORN));
});

test('escapes are carried through so the mapper can correct for them', () => {
  const { code } = expandInterpolations('note("a\\${b} c${d}")');
  assert.match(code, /e:\[\[1\],\[\]\]/);
});

test('offsets after a site map back to the document', () => {
  const src = 'note(`a${x}`).lpf(slider(400))';
  const { code, map } = expandInterpolations(src);
  assert.equal(mapOffset(map, code.indexOf('400')), src.indexOf('400'));
  assert.equal(mapOffset(map, code.indexOf('.lpf')), src.indexOf('.lpf'));
});

test('a hole expression is copied verbatim and stays mappable', () => {
  // Whatever is inside a hole still gets Strudel's own treatment, so its
  // offsets have to survive the trip too.
  const src = 'note(`a${pick(arr, "0 1")}`)';
  const { code, map } = expandInterpolations(src);
  assert.ok(code.includes('pick(arr, "0 1")'));
  assert.equal(mapOffset(map, code.indexOf('"0 1"')), src.indexOf('"0 1"'));
});

test('every user-code offset round-trips across several sites', () => {
  const src = 'stack(note(`a${x}`), s("bd*2"), n(`${y} 3`)).fast(2)';
  const { code, map } = expandInterpolations(src);
  for (const needle of ['stack', 'x', '"bd*2"', 'y', '.fast(2)']) {
    assert.equal(mapOffset(map, code.indexOf(needle)), src.indexOf(needle), needle);
  }
});

test('a site inside a hole is rewritten too', () => {
  const { code } = expandInterpolations('note(`a${up ? `b${n}` : "c"}`)');
  assert.equal(code.match(/oatMini/g).length, 2);
  assert.doesNotThrow(() => parse(code, ACORN));
});

test('mini-off regions and tagged templates are left alone', () => {
  const off = '// mini-off\nconst p = `x${y}`;\n// mini-on\nnote("bd")';
  assert.equal(expandInterpolations(off).code, off);
  const tagged = 'mondo`x${y}`';
  assert.equal(expandInterpolations(tagged).code, tagged);
});

test('a syntax error propagates unchanged', () => {
  assert.throws(() => expandInterpolations('note("a"'), SyntaxError);
});
