// `${…}` holes in mini-notation strings — the pre-pass.
//
// A song keeps its material in variables and arrays. `pick` can swap a whole
// pattern for another, but it cannot reach inside a string, so "this figure,
// repeated however many times `bars` currently says" has nowhere to live.
// JavaScript already has the notation for that, and it does not survive:
// @strudel/transpiler treats every backtick string as mini-notation and reads
// only `quasis[0].value.raw`, so today `` `[bb1, bb2]!${bars}` `` plays as
// `[bb1, bb2]!` — everything from the first hole on is silently dropped. And
// double-quoted strings, which is what the songs are actually written in, are
// not interpolated by JavaScript at all.
//
// So the holes are ours to implement. This module rewrites them out of the
// buffer before Strudel's transpiler ever sees it:
//
//   note(`[bb1]!${bars}`)
//   note(oatMini({c:['[bb1]!',''],h:[[12,19]],o:6},()=>[bars]))
//
// Three properties make that safe:
//
//   * The generated strings are SINGLE-quoted. `isStringWithDoubleQuotes()` in
//     @strudel/transpiler tests `raw[0] === '"'`, so our chunks pass through it
//     untouched while every other string in the buffer is treated as usual.
//   * The hole expressions are copied VERBATIM, so they close over the
//     variables around them and still get Strudel's own treatment — a
//     `slider(…)` or a `"0 1"` inside a hole is transpiled normally.
//   * Nothing is evaluated here. The thunk is what makes the holes re-runnable
//     once per cycle; see lang/mini-template.js.
//
// The rewrite lengthens the code, so every offset after a hole moves. That
// matters — the transpiler reports mini-notation and widget positions as
// character offsets, and the editor draws boxes and slider handles at them — so
// `expandInterpolations` also returns a map from rewritten offsets back to
// document offsets. See mapOffset().
//
// Chunk text is taken RAW from the source, matching how the transpiler already
// treats backtick strings: a `\n` written inside an interpolated mini string
// stays two characters. The one escape processed is `\${`, which is how you
// write a literal `${` now that double-quoted strings interpolate too.

import { parse, parseExpressionAt } from 'acorn';

// The transpiler's own parse options. Anything Strudel accepts — top-level
// await, the `bassline:` label form — has to parse here first.
const ACORN = { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true };

// `\${` is the escape for a literal `${`. The backslash is dropped from the
// chunk, so record where it was: every character after it in that chunk sits
// one further along in the document than in the assembled mini string.
function unescape(raw) {
  const escapes = [];
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && raw[i + 1] === '$' && raw[i + 2] === '{') {
      escapes.push(text.length);
      text += '${';
      i += 2;
      continue;
    }
    text += raw[i];
  }
  return { text, escapes };
}

// A string node, cut into the literal chunks and the holes between them, or
// null if it has no holes and is therefore none of our business. `from`/`to`
// are the document range of the whole `${…}`; `exprFrom`/`exprTo` the
// expression inside it.
export function scanSite(code, node) {
  if (node.type === 'TemplateLiteral') return scanTemplate(node);
  if (node.type === 'Literal' && typeof node.value === 'string' && node.raw[0] === '"') {
    return scanQuoted(code, node);
  }
  return null;
}

function scanTemplate(node) {
  if (!node.expressions.length) return null; // a plain backtick string: Strudel's job
  const parts = node.quasis.map((quasi) => unescape(quasi.value.raw));
  return {
    contentStart: node.start + 1,
    contentEnd: node.end - 1,
    chunks: parts.map((p) => p.text),
    escapes: parts.map((p) => p.escapes),
    // Acorn records the quasis, not the `${` and `}`, so a hole is the gap
    // between the quasi before it and the quasi after it.
    holes: node.expressions.map((expr, i) => ({
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
      i++; // an escape — including the `\${` that says "not a hole"
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

// Where does a hole end? Let acorn answer: it knows where an expression stops,
// including nested braces, strings and arrow functions. Counting braces by hand
// gets `${ x ? "}" : y }` wrong.
function readHole(code, dollar, contentEnd) {
  let open = dollar + 2;
  while (open < contentEnd && /\s/.test(code[open])) open++;
  if (code[open] === '}') throw new Error(`empty \${} in mini string at offset ${dollar}`);
  let expr;
  try {
    expr = parseExpressionAt(code, dollar + 2, ACORN);
  } catch {
    // Acorn reads past the closing quote, so an unterminated hole usually
    // fails as a tokenizer error rather than a missing brace.
    throw new Error(`unclosed or unparseable \${ in mini string at offset ${dollar}`);
  }
  let close = expr.end;
  while (close < code.length && /\s/.test(code[close])) close++;
  // Acorn does not know the string ends at the closing quote, so a hole that
  // runs past it has to be caught here.
  if (code[close] !== '}' || expr.end > contentEnd) {
    throw new Error(`unclosed \${ in mini string at offset ${dollar}`);
  }
  return { from: dollar, to: close + 1, exprFrom: expr.start, exprTo: expr.end };
}

// --- the rewrite -------------------------------------------------------------

// A `// mini-off` … `// mini-on` pair opts a region out of mini-notation, and
// therefore out of interpolation: inside one, a backtick string is an ordinary
// JavaScript template literal again. Mirrors findMiniDisableRanges() in
// @strudel/transpiler.
function miniDisableRanges(comments, end) {
  const ranges = [];
  const stack = [];
  for (const comment of comments) {
    const value = comment.value.trim();
    if (value.startsWith('mini-off')) stack.push(comment.start);
    else if (value.startsWith('mini-on')) ranges.push([stack.pop(), comment.end]);
  }
  while (stack.length) ranges.push([stack.pop(), end]);
  return ranges;
}

const inRange = (pos, ranges) => ranges.some(([from, to]) => pos >= from && pos <= to);

// Returning false from `visit` skips the node's children.
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

// Every site in the buffer, in source order. A hole inside a *double-quoted*
// string is invisible to the main parse — it is just text in a Literal — so its
// expression is parsed again and searched for sites of its own. Holes in a
// template literal are already in the AST, and the walker reaches them.
function findSites(code, ast, disabled) {
  const sites = [];
  const collect = (node, parent) => {
    // A tagged template belongs to Strudel's language registry (mondo`…`).
    if (node.type === 'TemplateLiteral' && parent?.type === 'TaggedTemplateExpression') return false;
    if (node.type !== 'TemplateLiteral' && node.type !== 'Literal') return;
    if (inRange(node.start, disabled)) return false;
    const site = scanSite(code, node);
    if (!site) return;
    sites.push(site);
    if (node.type !== 'Literal') return;
    for (const hole of site.holes) {
      walk(parseExpressionAt(code, hole.exprFrom, ACORN), null, collect);
    }
  };
  walk(ast, null, collect);
  return sites.sort((a, b) => a.contentStart - b.contentStart);
}

const quote = (text) =>
  `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

// Rewrite every interpolated mini string in `code` into an oatMini() call.
// Returns the new code and the map that puts offsets in it back where they came
// from. Throws on a syntax error, unchanged — it is the same error the next
// stage would have raised.
export function expandInterpolations(code) {
  const comments = [];
  const ast = parse(code, { ...ACORN, onComment: comments });
  const sites = findSites(code, ast, miniDisableRanges(comments, code.length));
  if (!sites.length) return { code, map: [{ orig: 0, out: 0, len: code.length }] };

  const out = [];
  const map = [];
  let length = 0;

  // Verbatim source: remembered, so its offsets can be mapped back.
  const copy = (from, to) => {
    if (to <= from) return;
    map.push({ orig: from, out: length, len: to - from });
    out.push(code.slice(from, to));
    length += to - from;
  };
  // Our own text: no offsets in the document correspond to it.
  const gen = (text) => {
    out.push(text);
    length += text.length;
  };

  const emitRange = (from, to) => {
    let cursor = from;
    for (const site of sites) {
      const start = site.contentStart - 1; // the opening quote
      const end = site.contentEnd + 1; // past the closing one
      if (start < cursor || end > to) continue;
      copy(cursor, start);
      emitSite(site);
      cursor = end;
    }
    copy(cursor, to);
  };

  const emitSite = (site) => {
    const chunks = site.chunks.map(quote).join(',');
    const holes = site.holes.map((hole) => `[${hole.from},${hole.to}]`).join(',');
    // The escape table is the uncommon case, so it is omitted when empty.
    const escapes = site.escapes.some((e) => e.length)
      ? `,e:[${site.escapes.map((e) => `[${e.join(',')}]`).join(',')}]`
      : '';
    gen(`oatMini({c:[${chunks}],h:[${holes}],o:${site.contentStart}${escapes}},()=>[`);
    site.holes.forEach((hole, i) => {
      if (i) gen(',');
      // Recursive: a hole may itself contain an interpolated string.
      emitRange(hole.exprFrom, hole.exprTo);
    });
    gen(`])`);
  };

  emitRange(0, code.length);
  return { code: out.join(''), map };
}

// An offset in the rewritten code, back to where it came from in the document.
// Offsets that land in generated text are pinned to the end of the verbatim
// span before them — the closest true position there is.
export function mapOffset(map, offset) {
  let lo = 0;
  let hi = map.length - 1;
  let span = map[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].out <= offset) {
      span = map[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return span.orig + Math.min(offset - span.out, span.len);
}
