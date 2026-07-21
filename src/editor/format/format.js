// The `:f` formatter.
//
// Two passes:
//   1. Prettier (standalone browser build) gives a robust, comment-preserving
//      baseline in whatever generic JS style `config.base` describes.
//   2. applyFunctionOverrides() re-parses that clean output and rewrites the
//      argument layout of specific named calls (stack, stepcat, …) per
//      `config.functionOverrides` — the thing Prettier can't do, since it
//      formats every call identically.
//
// Everything is driven by src/editor/format/config.js; this file is the engine.

import * as prettier from 'prettier/standalone';
import prettierBabel from 'prettier/plugins/babel';
import prettierEstree from 'prettier/plugins/estree';
import { parse } from 'acorn';

// Format `code` and return the formatted string. Throws on a syntax error
// (callers should catch and surface it without clobbering the buffer).
export async function formatCode(code, config) {
  const baseline = await prettier.format(code, {
    parser: 'babel',
    plugins: [prettierBabel, prettierEstree],
    ...config.base,
  });
  return applyFunctionOverrides(baseline, config);
}

// ── Pass 2: per-function argument layout ───────────────────────────────────

function applyFunctionOverrides(code, config) {
  const overrides = config.functionOverrides || {};
  if (Object.keys(overrides).length === 0) return code;

  // Apply one override per pass, then re-parse and repeat until nothing more
  // changes. Re-parsing keeps offsets honest and makes nesting Just Work: an
  // outer `stack` can expand, and on the next pass an inner `s` inside it can
  // collapse, each computed against the up-to-date source. Each pass makes at
  // least one call closer to its target layout, so this converges; the cap is
  // just a guard against a pathological custom override that never settles.
  const MAX_PASSES = 1000;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let ast;
    try {
      ast = parse(code, { ecmaVersion: 'latest', ranges: true, sourceType: 'module' });
    } catch {
      // Prettier already succeeded, so this should not happen; if it somehow
      // does, fall back to the current text rather than risk mangling it.
      return code;
    }

    // Ranges of every string / template literal, so the collapse pass never
    // touches whitespace that lives inside a string (mini-notation!).
    const stringRanges = [];
    const calls = [];
    walk(ast, (node) => {
      if (node.type === 'Literal' && typeof node.value === 'string') {
        stringRanges.push([node.start, node.end]);
      } else if (node.type === 'TemplateLiteral') {
        stringRanges.push([node.start, node.end]);
      } else if (node.type === 'CallExpression') {
        const name = calleeName(node);
        const rule = name && overrides[name];
        if (rule && rule.layout !== 'auto') calls.push({ node, name, rule });
      }
    });

    // Find the first call (in source order) whose layout actually needs to
    // change, apply that single edit, and start a fresh pass.
    let changed = false;
    calls.sort((a, b) => a.node.start - b.node.start);
    for (const { node, name, rule } of calls) {
      const edit = buildCallEdit(code, node, name, rule, config, stringRanges);
      if (!edit || edit.text === code.slice(edit.from, edit.to)) continue; // no-op
      code = code.slice(0, edit.from) + edit.text + code.slice(edit.to);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return code;
}

// Build a replacement for a call's parenthesised argument group `(...)`.
// Returns { from, to, text } spanning the opening `(` through the closing `)`,
// or null if there's nothing to do (no args, or custom fn opted out).
function buildCallEdit(code, node, name, rule, config, stringRanges) {
  const args = node.arguments;
  if (args.length === 0) return null;

  const open = code.indexOf('(', node.callee.end);
  const close = node.end - 1; // node ends at the char after `)`
  if (open === -1 || code[close] !== ')') return null;

  const baseIndent = lineIndentAt(code, node.start);
  const oneIndent = config.base.useTabs ? '\t' : ' '.repeat(config.base.tabWidth ?? 2);
  const argText = (a) => code.slice(a.start, a.end);

  // Escape hatch: a function override gets full control and returns the whole
  // paren group (including the parens).
  if (typeof rule === 'function') {
    const text = rule({
      name,
      node,
      code,
      args: args.map(argText),
      baseIndent,
      oneIndent,
    });
    if (typeof text !== 'string') return null;
    return { from: open, to: node.end, text };
  }

  if (rule.layout === 'expand') {
    const innerIndent = baseIndent + oneIndent;
    const parts = args.map((a) => innerIndent + reindent(argText(a), a.start, code, innerIndent.length));
    const comma = config.base.trailingComma && config.base.trailingComma !== 'none' ? ',' : '';
    const text = '(\n' + parts.join(',\n') + comma + '\n' + baseIndent + ')';
    return { from: open, to: node.end, text };
  }

  if (rule.layout === 'collapse') {
    const parts = args.map((a) => collapse(code, a.start, a.end, stringRanges));
    return { from: open, to: node.end, text: '(' + parts.join(', ') + ')' };
  }

  return null;
}

// ── helpers ────────────────────────────────────────────────────────────────

// Name a call is invoking: `stack(...)` → "stack", `x.stepcat(...)` → "stepcat".
function calleeName(node) {
  const c = node.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    return c.property.name;
  }
  return null;
}

// The leading-whitespace string of the line that contains offset `pos`.
function lineIndentAt(code, pos) {
  const lineStart = code.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(code.slice(lineStart, pos));
  return m ? m[0] : '';
}

// Re-indent an argument's source when moving it to a new column. The first line
// of `text` has no leading whitespace (it starts at the node); continuation
// lines carry their original indentation, which we shift by a constant delta so
// the argument's internal structure is preserved.
function reindent(text, start, code, newCol) {
  if (!text.includes('\n')) return text;
  const startCol = start - (code.lastIndexOf('\n', start - 1) + 1);
  const delta = newCol - startCol;
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      if (delta >= 0) return ' '.repeat(delta) + line;
      const strip = Math.min(-delta, /^[ \t]*/.exec(line)[0].length);
      return line.slice(strip);
    })
    .join('\n');
}

// Collapse an argument onto one line: replace runs of newline+whitespace with a
// single space, but never inside a string/template range (that would corrupt
// mini-notation content).
function collapse(code, start, end, stringRanges) {
  const inString = (i) => stringRanges.some(([s, e]) => i >= s && i < e);
  let out = '';
  for (let i = start; i < end; ) {
    if (code[i] === '\n' && !inString(i)) {
      out += ' ';
      i++;
      while (i < end && /[ \t\n]/.test(code[i]) && !inString(i)) i++;
    } else {
      out += code[i];
      i++;
    }
  }
  return out;
}

// Minimal AST walker — visits every node, no external dep. Enter-order so
// parents are seen before children (outermost calls first).
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'range' || key === 'type') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, visit);
    } else if (child && typeof child.type === 'string') {
      walk(child, visit);
    }
  }
}
