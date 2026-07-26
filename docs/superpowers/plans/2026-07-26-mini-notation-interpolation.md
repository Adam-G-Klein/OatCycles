# `${…}` holes in mini-notation strings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any mini string — `"…"` or `` `…` `` — carry `${…}` holes whose code is re-run at the start of every cycle and spliced in as text.

**Architecture:** A pure source-to-source pre-pass (`src/lang/interpolate.js`) rewrites interpolated strings into `oatMini(meta, () => [...holes])` calls before `evaluate()` runs, emitting single-quoted strings that Strudel's own transpiler ignores. A pure assembly/mapping module (`src/lang/assemble.js`) joins chunks with hole values and maps mini leaf offsets back to document offsets. An engine-facing module (`src/lang/mini-template.js`) turns that into a pattern with `pure(1).innerJoin()`, memoised per cycle. `main.js` remaps the transpiler's now-shifted offsets back to document coordinates.

**Tech Stack:** acorn (already a dependency), `@strudel/web` (`pure`, `reify`, `m`, `evalScope`), `node --test`, CodeMirror 6.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-mini-notation-interpolation-design.md`. Read it first.
- No new dependencies. Tests are `node:test` + `node:assert/strict` in `test/`, run with `npm test`.
- Modules under test must not import `@strudel/web` — it does `window.initStrudel = …` at module scope and throws under node. Engine-facing code goes in `mini-template.js`; everything tested goes in `interpolate.js` / `assemble.js`.
- acorn is parsed with exactly the transpiler's options: `{ ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true, onComment: comments }`.
- Never run the app without `?agent=1`, never write to `songs/` (see CLAUDE.md).
- House style: comments explain *why*, in prose, at the top of the module and above anything non-obvious. Match `src/panic.js` and `src/songs/storage.js`.

---

### Task 1: Scanning one string into chunks and holes

**Files:**
- Create: `src/lang/interpolate.js`
- Test: `test/interpolate.test.js`

**Interfaces:**
- Produces: `scanSite(code, node) -> { contentStart, contentEnd, chunks: string[], holes: [{from,to,exprFrom,exprTo}], escapes: number[][] } | null`. `node` is an acorn `Literal` (double-quoted) or `TemplateLiteral`. Returns `null` when there is no hole. `from`/`to` are the document range of the whole `${…}`; `exprFrom`/`exprTo` the expression inside it. `escapes[k]` holds the chunk-relative indices in chunk `k` where a `\` was dropped from `\${`.

- [ ] **Step 1: Write the failing tests**

```js
// test/interpolate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { scanSite } from '../src/lang/interpolate.js';

const ACORN = { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true };
// The first string-ish node in a one-expression program.
const firstString = (code) => {
  const expr = parse(code, ACORN).body[0].expression;
  return expr.type === 'CallExpression' ? expr.arguments[0] : expr;
};
const scan = (code) => scanSite(code, firstString(code));

test('a string with no hole is not a site', () => {
  assert.equal(scan('note("bd sd")'), null);
  assert.equal(scan('note(`bd sd`)'), null);
});

test('a double-quoted hole splits the string into chunks', () => {
  //          0123456789...
  const site = scan('note("[bb1, bb2]!${bars}")');
  assert.deepEqual(site.chunks, ['[bb1, bb2]!', '']);
  assert.equal(site.contentStart, 6);
  const [hole] = site.holes;
  assert.equal(code_at('note("[bb1, bb2]!${bars}")', hole.from, hole.to), '${bars}');
  assert.equal(code_at('note("[bb1, bb2]!${bars}")', hole.exprFrom, hole.exprTo), 'bars');
});

const code_at = (code, from, to) => code.slice(from, to);

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

test('a hole may hold any expression, braces and all', () => {
  const src = 'note("${ pick({a: "x"}.a, i) }")';
  // A double-quoted hole cannot contain a double quote — JS ends the string
  // first — so this one is written with backticks.
  const back = 'note(`${ ({a: "x"}).a }`)';
  assert.equal(scan(back).holes.length, 1);
  assert.equal(scan(back).chunks.length, 2);
  assert.ok(src); // documented limitation, not a behaviour
});

test('a backslash escapes a hole and is dropped from the chunk', () => {
  const site = scan('note("cost \\${5} bd")');
  assert.deepEqual(site.chunks, ['cost ${5} bd']);
  assert.deepEqual(site.holes, []);
  assert.deepEqual(site.escapes, [[5]]);
});

test('an unclosed hole is an error naming the position', () => {
  assert.throws(() => scan('note("a ${b")'), /unclosed \$\{/);
});

test('an empty hole is an error', () => {
  assert.throws(() => scan('note("a ${}")'), /empty \$\{\}/);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/lang/interpolate.js'`.

- [ ] **Step 3: Implement `scanSite`**

`src/lang/interpolate.js`, module header first — explain that Strudel's transpiler reads only `quasis[0].value.raw` so backtick holes are silently dropped today, that chunk text is taken **raw** (matching how the transpiler already treats backticks, and meaning a `\n` inside an interpolated mini string stays two characters), and that `\${` is the one escape processed.

```js
import { parse, parseExpressionAt } from 'acorn';

const ACORN = { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true };

// `\${` is the escape for a literal `${`. The backslash is dropped from the
// chunk, so the mapper is told where it was: everything after it in that chunk
// sits one character later in the document than it does in the mini string.
function unescape(raw) {
  const escapes = [];
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && raw[i + 1] === '$' && raw[i + 2] === '{') {
      escapes.push(out.length);
      out += '${';
      i += 2;
      continue;
    }
    out += raw[i];
  }
  return { text: out, escapes };
}

export function scanSite(code, node) {
  if (node.type === 'TemplateLiteral') return scanTemplate(code, node);
  if (node.type === 'Literal' && typeof node.value === 'string' && node.raw[0] === '"') {
    return scanQuoted(code, node);
  }
  return null;
}

function scanTemplate(code, node) {
  if (!node.expressions.length) return null; // plain backtick string: Strudel's job
  const parts = node.quasis.map((q) => unescape(q.value.raw));
  return {
    contentStart: node.start + 1,
    contentEnd: node.end - 1,
    chunks: parts.map((p) => p.text),
    escapes: parts.map((p) => p.escapes),
    holes: node.expressions.map((expr, i) => ({
      // The hole runs from the end of the quasi before it to the start of the
      // one after: acorn does not record the `${` and `}` themselves.
      from: node.quasis[i].end,
      to: node.quasis[i + 1].start,
      exprFrom: expr.start,
      exprTo: expr.end,
    })),
  };
}

function scanQuoted(code, node) {
  const contentStart = node.start + 1;
  const contentEnd = node.end - 1;
  const holes = [];
  const rawChunks = [];
  let chunkStart = contentStart;
  for (let i = contentStart; i < contentEnd; i++) {
    if (code[i] === '\\') {
      i++;
      continue;
    }
    if (code[i] !== '$' || code[i + 1] !== '{') continue;
    const hole = readHole(code, i, contentEnd);
    rawChunks.push(code.slice(chunkStart, i));
    holes.push(hole);
    chunkStart = hole.to;
    i = hole.to - 1;
  }
  if (!holes.length) return null;
  rawChunks.push(code.slice(chunkStart, contentEnd));
  const parts = rawChunks.map(unescape);
  return {
    contentStart,
    contentEnd,
    chunks: parts.map((p) => p.text),
    escapes: parts.map((p) => p.escapes),
    holes,
  };
}

// Let acorn do the lexing: it knows where an expression ends, including nested
// braces, strings and arrow functions. Hand-matching braces here would get
// `${ x ? "}" : y }` wrong.
function readHole(code, dollar, contentEnd) {
  let expr;
  try {
    expr = parseExpressionAt(code, dollar + 2, ACORN);
  } catch {
    throw new Error(`empty \${} or unparseable hole at offset ${dollar}`);
  }
  let close = expr.end;
  while (close < code.length && /\s/.test(code[close])) close++;
  if (code[close] !== '}' || expr.end > contentEnd) {
    throw new Error(`unclosed \${ in mini string at offset ${dollar}`);
  }
  return { from: dollar, to: close + 1, exprFrom: expr.start, exprTo: expr.end };
}
```

Note the `empty ${}` message must also match the "unparseable" case; the test asserts `/empty \$\{\}/` for `${}` and `/unclosed \$\{/` for `${b`, so keep those two strings distinct as written.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lang/interpolate.js test/interpolate.test.js
git commit -m "Scan mini strings for \${} holes"
```

---

### Task 2: The rewrite and its offset map

**Files:**
- Modify: `src/lang/interpolate.js`
- Modify: `test/interpolate.test.js`

**Interfaces:**
- Consumes: `scanSite` from Task 1.
- Produces: `expandInterpolations(code) -> { code, map }` and `mapOffset(map, offset) -> number`. `map` is an array of `{ orig, out, len }` verbatim spans, ascending by `out`.

- [ ] **Step 1: Write the failing tests**

```js
// appended to test/interpolate.test.js
import { expandInterpolations, mapOffset } from '../src/lang/interpolate.js';

test('code without holes comes back byte for byte', () => {
  const src = 'note("bd sd").fast(2)\n// ${not a string}\n';
  const { code, map } = expandInterpolations(src);
  assert.equal(code, src);
  assert.equal(mapOffset(map, 7), 7);
});

test('a site becomes an oatMini call with single-quoted chunks', () => {
  const { code } = expandInterpolations('note(`[bb1]!${bars}`)');
  assert.equal(
    code,
    "note(oatMini({c:['[bb1]!',''],h:[[12,19]],o:6},()=>[bars]))",
  );
});

test('quotes and newlines in a chunk are escaped for the generated string', () => {
  const { code } = expandInterpolations("note(`a'b\nc${x}`)");
  assert.match(code, /c:\['a\\'b\\nc',''\]/);
});

test('offsets after a site map back to the document', () => {
  const src = 'note(`a${x}`).lpf(slider(400))';
  const { code, map } = expandInterpolations(src);
  const sliderArg = code.indexOf('400');
  assert.equal(mapOffset(map, sliderArg), src.indexOf('400'));
});

test('a hole expression is copied verbatim and stays mappable', () => {
  const src = 'note(`a${pick(arr, "0 1")}`)';
  const { code, map } = expandInterpolations(src);
  assert.equal(mapOffset(map, code.indexOf('"0 1"')), src.indexOf('"0 1"'));
});

test('a site inside a hole is rewritten too', () => {
  const { code } = expandInterpolations('note(`a${up ? `b${n}` : "c"}`)');
  assert.equal(code.match(/oatMini/g).length, 2);
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `expandInterpolations is not a function`.

- [ ] **Step 3: Implement the emitter**

Append to `src/lang/interpolate.js`. Explain in comments why the generated strings are single-quoted (Strudel's `isStringWithDoubleQuotes` tests `raw[0] === '"'`, so single quotes pass through untouched) and why the map exists (the rewrite lengthens the code, so every later offset moves).

```js
// A `// mini-off` … `// mini-on` pair opts a region out of mini-notation, and
// therefore out of interpolation too. Mirrors findMiniDisableRanges() in
// @strudel/transpiler.
function miniDisableRanges(comments, end) {
  const ranges = [];
  const stack = [];
  for (const c of comments) {
    const value = c.value.trim();
    if (value.startsWith('mini-off')) stack.push(c.start);
    else if (value.startsWith('mini-on')) ranges.push([stack.pop(), c.end]);
  }
  while (stack.length) ranges.push([stack.pop(), end]);
  return ranges;
}

const inRange = (pos, ranges) => ranges.some(([from, to]) => pos >= from && pos <= to);

function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, node, visit));
    else walk(child, node, visit);
  }
}

// Every site in the buffer, outermost first. A hole inside a *double-quoted*
// string is invisible to the main parse — it is just text in a Literal — so its
// expression is parsed again and searched for sites of its own.
function findSites(code, ast, disabled) {
  const sites = [];
  const collect = (node, parent) => {
    if (parent?.type === 'TaggedTemplateExpression' && parent.tag === node) return;
    if (inRange(node.start, disabled)) return false;
    const site = scanSite(code, node);
    if (!site) return;
    sites.push(site);
    for (const hole of site.holes) {
      if (node.type !== 'Literal') continue; // template holes are already in the AST
      const expr = parseExpressionAt(code, hole.exprFrom, ACORN);
      walk(expr, null, collect);
    }
  };
  walk(ast, null, collect);
  return sites.sort((a, b) => a.contentStart - b.contentStart);
}

const quote = (s) =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

export function expandInterpolations(code) {
  const comments = [];
  const ast = parse(code, { ...ACORN, onComment: comments });
  const sites = findSites(code, ast, miniDisableRanges(comments, code.length));
  if (!sites.length) return { code, map: [{ orig: 0, out: 0, len: code.length }] };

  const out = [];
  const map = [];
  let len = 0;
  const copy = (from, to) => {
    if (to <= from) return;
    map.push({ orig: from, out: len, len: to - from });
    out.push(code.slice(from, to));
    len += to - from;
  };
  const gen = (text) => {
    out.push(text);
    len += text.length;
  };

  const emitRange = (from, to) => {
    let cursor = from;
    for (const site of sites) {
      const start = site.contentStart - 1; // the opening quote
      const end = site.contentEnd + 1;
      if (start < cursor || end > to) continue;
      copy(cursor, start);
      emitSite(site);
      cursor = end;
    }
    copy(cursor, to);
  };

  const emitSite = (site) => {
    const chunks = site.chunks.map(quote).join(',');
    const holes = site.holes.map((h) => `[${h.from},${h.to}]`).join(',');
    const escapes = site.escapes.some((e) => e.length)
      ? `,e:[${site.escapes.map((e) => `[${e.join(',')}]`).join(',')}]`
      : '';
    gen(`oatMini({c:[${chunks}],h:[${holes}],o:${site.contentStart}${escapes}},()=>[`);
    site.holes.forEach((hole, i) => {
      if (i) gen(',');
      emitRange(hole.exprFrom, hole.exprTo);
    });
    gen(`])`);
  };

  emitRange(0, code.length);
  return { code: out.join(''), map };
}

// An offset in the rewritten code, back to where it came from in the document.
// Offsets that land in generated text are pinned to the end of the verbatim
// span before them, which is the closest true position there is.
export function mapOffset(map, offset) {
  let lo = 0;
  let hi = map.length - 1;
  let span = map[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].out <= offset) {
      span = map[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const delta = Math.min(offset - span.out, span.len);
  return span.orig + delta;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. If the generated-string assertion in test 2 fails on spacing, fix the *test* to match the emitter, not the other way — the exact text is not a requirement, only that it parses and that chunks are single-quoted.

- [ ] **Step 5: Commit**

```bash
git add src/lang/interpolate.js test/interpolate.test.js
git commit -m "Rewrite interpolated mini strings into oatMini calls"
```

---

### Task 3: Assembling the string and checking hole values

**Files:**
- Create: `src/lang/assemble.js`
- Test: `test/assemble.test.js`

**Interfaces:**
- Produces: `assemble(meta, values) -> { string, segments }` where `meta` is `{c, h, o, e?}` as emitted in Task 2 and `segments` is `[{ aFrom, aTo, dFrom, dTo, kind, esc }]` — `kind` is `'chunk'` or `'hole'`, `aFrom`/`aTo` index the assembled string, `dFrom`/`dTo` the document. Also `mapLeaf(segments, from, to) -> { start, end }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/assemble.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, mapLeaf } from '../src/lang/assemble.js';

// note(`[bb1]!${bars}`)  — chunk at doc 6, hole ${bars} at doc 12..19
const META = { c: ['[bb1]!', ''], h: [[12, 19]], o: 6 };

test('values are spliced into the chunks as text', () => {
  assert.equal(assemble(META, ['16']).string, '[bb1]!16');
});

test('a number is stringified', () => {
  assert.equal(assemble(META, [16]).string, '[bb1]!16');
  assert.equal(assemble(META, [0.5]).string, '[bb1]!0.5');
  assert.equal(assemble(META, [-2]).string, '[bb1]!-2');
});

test('anything else throws, naming the hole and the type', () => {
  const pattern = Object.assign(Object.create({ constructor: { name: 'Pattern' } }), {});
  assert.throws(() => assemble(META, [{}]), /hole 1 .*expected a string or number/);
  assert.throws(() => assemble(META, [undefined]), /got undefined/);
  assert.throws(() => assemble(META, [NaN]), /got NaN/);
  assert.throws(() => assemble(META, [Infinity]), /got Infinity/);
  assert.throws(() => assemble(META, [['a']]), /got Array/);
  assert.throws(() => assemble(META, [pattern]), /got Pattern/);
});

test('a leaf inside a chunk maps to its true document range', () => {
  const { segments } = assemble(META, ['16']);
  // "[bb1]" is assembled 0..5, and the document has it at 6..11.
  assert.deepEqual(mapLeaf(segments, 0, 5), { start: 6, end: 11 });
});

test('a leaf that came out of a hole boxes the whole ${…}', () => {
  const { segments } = assemble(META, ['16']);
  assert.deepEqual(mapLeaf(segments, 6, 8), { start: 12, end: 19 });
});

test('a leaf spanning chunk and hole takes the union', () => {
  const { segments } = assemble(META, ['16']);
  assert.deepEqual(mapLeaf(segments, 5, 8), { start: 11, end: 19 });
});

test('an escaped ${ shifts everything after it in that chunk', () => {
  // "a${b}c" written as "a\${b}c": 7 document characters, 6 assembled.
  const meta = { c: ['a${b}c'], h: [], o: 4, e: [[1]] };
  const { segments, string } = assemble(meta, []);
  assert.equal(string, 'a${b}c');
  assert.deepEqual(mapLeaf(segments, 0, 1), { start: 4, end: 5 });
  assert.deepEqual(mapLeaf(segments, 5, 6), { start: 10, end: 11 });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/lang/assemble.js
//
// The half of ${…} interpolation that has no engine in it: joining chunks with
// hole values, refusing values that are not text, and mapping offsets in the
// assembled string back to the document the user is looking at.

const typeName = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'Array';
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v); // NaN/Infinity
  return v?.constructor?.name ?? typeof v;
};

// A hole is text substitution, so it must produce text. Numbers count: a
// replication count or a factor is the obvious thing to compute, and demanding
// String(n) at every one of them would be ceremony. Everything else is a
// mistake worth naming — `${pick(arr, i)}` returns a Pattern, not a string.
function holeText(value, index) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(
    `hole ${index + 1} in mini string: expected a string or number, got ${typeName(value)}`,
  );
}

export function assemble(meta, values) {
  const chunks = meta.c;
  const segments = [];
  let string = '';
  for (let i = 0; i < chunks.length; i++) {
    const dFrom = i === 0 ? meta.o : meta.h[i - 1][1];
    segments.push({
      kind: 'chunk',
      aFrom: string.length,
      aTo: string.length + chunks[i].length,
      dFrom,
      dTo: dFrom + chunks[i].length,
      esc: meta.e?.[i] ?? [],
    });
    string += chunks[i];
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
// plus one for every `\${` whose backslash was dropped before it.
const chunkOffset = (seg, a) => seg.dFrom + (a - seg.aFrom) + seg.esc.filter((e) => e <= a - seg.aFrom).length;

// A leaf of the assembled string, as a document range. Chunk text maps
// exactly; anything that came out of a hole boxes the whole `${…}`, because
// that is the only part of it the user can see.
export function mapLeaf(segments, from, to) {
  let start = null;
  let end = null;
  for (const seg of segments) {
    if (seg.aTo <= from || seg.aFrom >= to) {
      // A zero-width hole still counts if the leaf starts exactly there.
      if (!(seg.aFrom === seg.aTo && seg.aFrom >= from && seg.aFrom <= to)) continue;
    }
    const segStart = seg.kind === 'hole' ? seg.dFrom : chunkOffset(seg, Math.max(from, seg.aFrom));
    const segEnd = seg.kind === 'hole' ? seg.dTo : chunkOffset(seg, Math.min(to, seg.aTo));
    start = start === null ? segStart : Math.min(start, segStart);
    end = end === null ? segEnd : Math.max(end, segEnd);
  }
  return { start: start ?? 0, end: end ?? 0 };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lang/assemble.js test/assemble.test.js
git commit -m "Assemble interpolated mini strings and map their offsets"
```

---

### Task 4: The per-cycle memo

**Files:**
- Modify: `src/lang/assemble.js`
- Modify: `test/assemble.test.js`

**Interfaces:**
- Produces: `createCache(build) -> { at(cycle), prime() }`. `build()` is called with no arguments and returns whatever the caller wants cached; `at(cycle)` returns the value for that cycle, calling `build` at most once per distinct cycle; `prime()` builds now and seeds nothing cycle-keyed.

- [ ] **Step 1: Write the failing tests**

```js
// appended to test/assemble.test.js
import { createCache } from '../src/lang/assemble.js';

test('a cycle is built once however often it is queried', () => {
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

test('the draw window of five cycles does not evict the audio cycle', () => {
  let builds = 0;
  const cache = createCache(() => ++builds);
  for (const c of [10, 8, 9, 10, 11, 12, 10]) cache.at(c);
  assert.equal(builds, 5); // 10, 8, 9, 11, 12 — the second and third 10 are hits
});

test('priming builds once without claiming a cycle', () => {
  let builds = 0;
  const cache = createCache(() => ++builds);
  cache.prime();
  cache.at(0);
  assert.equal(builds, 2);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `createCache is not a function`.

- [ ] **Step 3: Implement**

```js
// appended to src/lang/assemble.js

// How many cycles to remember. The scheduler queries the current cycle on every
// tick (~20 a second) and a visualizer's draw window reaches two cycles either
// side, so a one-slot cache would thrash and the holes would run constantly.
const MEMO = 8;

// "Re-evaluated at the start of each cycle" is this: build once per cycle
// number, no matter how many times that cycle is queried. Without it a hole
// reading a mutating counter would slew mid-cycle.
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
    prime() {
      return build();
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lang/assemble.js test/assemble.test.js
git commit -m "Memoise interpolated strings per cycle"
```

---

### Task 5: `oatMini` — the pattern

**Files:**
- Create: `src/lang/mini-template.js`

No test file: everything here needs `@strudel/web`, which cannot be imported under node. It is verified in the app in Task 7. Keep this module thin — anything that can be tested belongs in `assemble.js`.

**Interfaces:**
- Consumes: `assemble`, `mapLeaf`, `createCache` from Task 3/4.
- Produces: `registerMiniTemplates() -> Promise` (puts `oatMini` in the eval scope), `setLocationSink(fn)`, `resetSites()`.

- [ ] **Step 1: Implement**

```js
// src/lang/mini-template.js
//
// The runtime half of ${…} interpolation. The pre-pass in interpolate.js
// rewrites every interpolated mini string into a call to oatMini(), which
// reaches eval as a bare identifier — so, exactly like sliderWithID() in
// editor/slider.js, this module has to put it in the eval scope before the
// first evaluate().

import { evalScope, pure, reify, m } from '@strudel/web';
import { assemble, mapLeaf, createCache } from './assemble.js';

// Sites of the current evaluation, keyed by where their string starts in the
// document, so that highlighting can be told the ranges a dynamic string
// currently occupies. Cleared on every eval; each site re-registers the first
// time it is queried.
const sites = new Map();
let sink = null;
let pending = false;

export const setLocationSink = (fn) => (sink = fn);
export const resetSites = () => {
  sites.clear();
  report();
};

// Never dispatch into CodeMirror from inside a query — the scheduler is
// mid-tick. Coalesce to a microtask instead.
function report() {
  if (!sink || pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    sink?.([...sites.values()].flat());
  });
}

function createSite(meta, holes) {
  let lastString = null;
  let lastPattern = null;

  const build = () => {
    const { string, segments } = assemble(meta, holes());
    if (string === lastString) return lastPattern;
    // m() parses `"` + string + `"`, so its leaf offsets are one greater than
    // the index into the assembled string.
    const pattern = m(string, 0).withContext((ctx) => ({
      ...ctx,
      locations: (ctx.locations || []).map(({ start, end }) => mapLeaf(segments, start - 1, end - 1)),
    }));
    lastString = string;
    lastPattern = pattern;
    sites.set(meta.o, leafRanges(string, segments));
    report();
    return pattern;
  };

  return createCache(build);
}

// The document ranges this string's leaves occupy right now, so the editor can
// have a mark to draw a box on. Same mapping the haps get.
function leafRanges(string, segments) {
  return getLeafLocations(`"${string}"`, 0).map(([from, to]) => {
    const { start, end } = mapLeaf(segments, from - 1, to - 1);
    return [start, end];
  });
}

export function oatMini(meta, holes) {
  const cache = createSite(meta, holes);
  // Fail on Cmd+Enter rather than a cycle later: a hole that is broken outright
  // should not wait for the transport. The result is memoised on the string, so
  // the first cycle does not pay for it twice.
  cache.prime();
  return pure(1)
    .withHaps((haps) =>
      haps.map((hap) => hap.withValue(() => reify(cache.at(hap.wholeOrPart().begin.sam().valueOf())))),
    )
    .innerJoin();
}

export const registerMiniTemplates = () => evalScope({ oatMini });
```

`getLeafLocations` comes from `@strudel/mini`, which `@strudel/web` re-exports — add it to the import list.

- [ ] **Step 2: Check it at least parses and the app still boots**

Run: `npm test` (unchanged, still passing) and load the app per Task 7's setup — a blank page means a bad import.

- [ ] **Step 3: Commit**

```bash
git add src/lang/mini-template.js
git commit -m "oatMini: an interpolated mini string as a pattern"
```

---

### Task 6: Wiring — offsets, sliders, locations, errors

**Files:**
- Modify: `src/main.js`
- Modify: `src/editor/slider.js:29,56-59`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Keep a slider's identity when its position is remapped**

`slider.js` derives a slider's id from its offset, which must stay the offset in the *transpiled* code even after `main.js` remaps the widget's position back into the document. In `SliderWidget`'s constructor take `srcFrom` and use it when present:

```js
constructor({ from, srcFrom, value, min, max, step }) {
  super();
  this.id = sliderID(srcFrom ?? from);
```

Add a comment saying why: the transpiler mints `slider_<offset in the code it transpiled>`, and after `${…}` interpolation that code is not the document.

- [ ] **Step 2: Run the pre-pass before evaluating**

In `main.js`, import at the top:

```js
import { expandInterpolations, mapOffset } from './lang/interpolate.js';
import { registerMiniTemplates, setLocationSink, resetSites } from './lang/mini-template.js';
```

In `prebake`, alongside `await registerSliders();`:

```js
await registerMiniTemplates();
```

In `play()`, replace `await evaluate(code)` with:

```js
// ${…} holes are ours, not Strudel's: rewrite them before the transpiler runs
// (see lang/interpolate.js). Everything after a hole shifts, so keep the map
// that puts the transpiler's offsets back into document coordinates.
const expanded = expandInterpolations(code);
sourceMap = expanded.map;
resetSites();
await evaluate(expanded.code);
```

with `let sourceMap = null;` declared next to `scheduler`/`drawer`.

- [ ] **Step 3: Remap what the transpiler reports**

In `afterEval`, replace the three `meta` lines with:

```js
const locations = (meta?.miniLocations || []).map(([from, to]) => [
  mapOffset(sourceMap, from),
  mapOffset(sourceMap, to),
]);
const widgets = (meta?.widgets || []).map((w) => ({
  ...w,
  srcFrom: w.from, // the transpiled offset, which is the slider's identity
  from: w.from == null ? w.from : mapOffset(sourceMap, w.from),
  to: w.to == null ? w.to : mapOffset(sourceMap, w.to),
}));
staticLocations = locations;
pushLocations();
editor.updateSliders(widgets);
editor.updateWidgets(widgets);
```

and above, next to the other module state:

```js
// Highlighting has two sources now: the locations the transpiler found in the
// buffer, and the ranges an interpolated string occupies this cycle, which
// change while the music runs. The editor takes the union.
let staticLocations = [];
let dynamicLocations = [];
const pushLocations = () => editor.updateMiniLocations([...staticLocations, ...dynamicLocations]);
setLocationSink((locations) => {
  dynamicLocations = locations;
  pushLocations();
});
```

`setLocationSink` must be called after `editor` exists — put it just below the `createEditor` call.

- [ ] **Step 4: Surface cycle-time errors**

A hole that throws mid-playback is caught by `Cyclist` per tick and only logged (`cyclist.mjs:78`), which means it never reaches the topbar. Below the `initStrudel` block:

```js
// The scheduler catches errors thrown while querying — a ${…} hole that throws,
// a string that no longer parses — logs them and keeps ticking. Without this
// they are console-only, and the pattern just goes quiet for no visible reason.
document.addEventListener('strudel.log', (event) => {
  const message = event.detail?.message ?? '';
  if (message.includes('error:')) setStatus(message, 'error');
});
```

- [ ] **Step 5: Run the tests, then the app**

Run: `npm test` — still passing.
Then Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/editor/slider.js
git commit -m "Wire \${} interpolation into eval, highlighting and errors"
```

---

### Task 7: Verify in the app

**Files:** none.

Per CLAUDE.md: the app is only ever opened with `?agent=1`, and driven through `window.oat` rather than by clicking. Nothing here writes to `songs/`.

- [ ] **Step 1: Start the dev server**

Use the preview tooling with the `oatcycles-dev` configuration in `.claude/launch.json`, then navigate to the URL it gives you **with `?agent=1` appended**. Confirm the yellow banner and `window.oat.agentMode === true`.

- [ ] **Step 2: A hole that changes while it plays**

```js
window.oat.silentPlay('let n = 2\nwindow._n = () => n\nwindow._set = (v) => (n = v)\ns(`bd*${n}`)');
```

Then read `window.oat.getCode()` (unchanged — `silentPlay(code)` never touches the buffer), set `window._set(4)`, and confirm from the console that the pattern queries four events per cycle after the next cycle boundary and not before.

- [ ] **Step 3: The type error**

```js
window.oat.silentPlay('s(`bd*${{}}`)');
```

Expect the topbar red with `hole 1 in mini string: expected a string or number, got Object`, raised on evaluation rather than a cycle later.

- [ ] **Step 4: Sliders after a hole still work**

```js
window.oat.silentPlay('s(`bd*${2}`).lpf(slider(400, 100, 800))');
```

Expect the slider widget to render immediately before the `400` — not shifted — and dragging it to change the sound without a re-eval.

- [ ] **Step 5: Highlighting**

Play an interpolated pattern and confirm boxes appear on the literal tokens and on the whole `${…}` when the events it produced are sounding.

- [ ] **Step 6: Stop, and report**

`window.oat.stop()`. Then `git status` and confirm nothing under `songs/` changed.

---

## Notes for the implementer

- `hap.wholeOrPart().begin.sam()` is a `Fraction`; `.valueOf()` makes it a number so it can key a `Map`.
- `Pattern.withValue` and `Hap.withValue` are different functions. The one used in Task 5 is `Hap.withValue`, called from inside `withHaps` at query time.
- If `m(string, 0)` throws, that is a mini parse error on an assembled string and it should propagate — the spec chose "throw and let it surface".
