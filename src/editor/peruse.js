// `:peruse` — build a browsable index of every sound this file imports.
//
// A sample bank is a black box until you've heard it. `samples('github:…')`
// registers a few hundred names you have no list of, so auditioning one means
// guessing, or leaving the editor to go read a JSON file. `:peruse` reads the
// `samples()` calls in the buffer, fetches the banks they point at, and appends
// a block like this:
//
//   const dirtSamples = ["808", "808bd", …];   // every sound in the bank
//   const dirtSamplesI = 0;                    // which one
//   const dirtSamplesN = 0;                    // which variant of it
//   peruse_dirtSamples: s(pickmod(dirtSamples, dirtSamplesI)).n(dirtSamplesN)
//
// so perusing is just editing a number and hitting `:w`. `pickmod` wraps, so
// any number is in range — you can hold a digit down and keep listening.
//
// The block is delimited by marker comments and regenerated in place on every
// run, carrying the index values (and which bank's line is uncommented) across,
// so re-running after adding a bank doesn't lose your place.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

const BEGIN_RE = /^\/\/ >>> peruse\b.*$/m;
const END_RE = /^\/\/ <<< peruse\b.*$/m;
const BEGIN = '// >>> peruse — generated from the samples() calls in this file';
const END = '// <<< peruse';

// --- reading the buffer's samples() calls ------------------------------------

// Walks the JavaScript syntax tree rather than the raw text, which gets us two
// things for free: commented-out `samples()` calls are invisible (comments
// aren't parsed into expressions), and nested parens/quotes inside arguments
// can't confuse the match the way a regex would.
function readSampleCalls(state) {
  const doc = state.doc;
  const calls = [];
  // CodeMirror only parses as far as the viewport by default; a samples() call
  // below the fold would otherwise be invisible to us.
  const tree = ensureSyntaxTree(state, doc.length, 5000) ?? syntaxTree(state);
  tree.iterate({
    enter: (ref) => {
      if (ref.name !== 'CallExpression') return;
      const node = ref.node;
      const callee = node.firstChild;
      if (!callee || callee.name !== 'VariableName') return;
      if (doc.sliceString(callee.from, callee.to) !== 'samples') return;
      const args = elementsOf(node.getChild('ArgList'));
      if (!args.length) return;
      const [first] = args;
      if (first.name === 'String') {
        calls.push({ kind: 'url', spec: unquote(doc.sliceString(first.from, first.to)) });
      } else if (first.name === 'ObjectExpression') {
        calls.push({ kind: 'inline', sounds: soundsFromObject(doc, first) });
      } else {
        // A variable, template literal or spread — we can't know its contents
        // without running it, so say so rather than silently skipping it.
        calls.push({ kind: 'unsupported', spec: doc.sliceString(first.from, first.to) });
      }
    },
  });
  return calls;
}

// The children of an ArgList / ArrayExpression include their own delimiters, so
// the elements are whatever's left once the punctuation is dropped.
const DELIMITERS = new Set(['(', ')', '[', ']', '{', '}', ',']);

function elementsOf(node) {
  const elements = [];
  if (!node) return elements;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (DELIMITERS.has(child.name)) continue;
    elements.push(child);
  }
  return elements;
}

function unquote(text) {
  return text.replace(/^['"`]|['"`]$/g, '');
}

// `samples({ bd: ['a.wav','b.wav'], piano: { c3: '…' } }, base)` — the keys are
// the sound names, an array value means indexable variants, and an object value
// means the samples are pitch-mapped (selected with `note`, not `n`).
function soundsFromObject(doc, obj) {
  const sounds = [];
  for (let prop = obj.firstChild; prop; prop = prop.nextSibling) {
    if (prop.name !== 'Property') continue;
    const key = prop.firstChild;
    if (!key) continue;
    let value = key.nextSibling;
    while (value && value.name === ':') value = value.nextSibling;
    sounds.push({
      name: unquote(doc.sliceString(key.from, key.to)),
      variants: value?.name === 'ArrayExpression' ? elementsOf(value).length : 1,
      pitched: value?.name === 'ObjectExpression',
    });
  }
  return sounds;
}

// --- resolving and fetching banks --------------------------------------------

// The same resolution Strudel's own `samples()` does, so `:peruse` reads exactly
// the bank the engine will load — and fails in exactly the same places.
export function bankUrl(spec) {
  if (spec.startsWith('github:')) {
    let path = spec.slice('github:'.length).replace(/\/+$/, '');
    if (path.split('/').length === 2) path += '/main';
    return `https://raw.githubusercontent.com/${path}/strudel.json`;
  }
  if (spec.startsWith('shabda:')) {
    return `https://shabda.ndre.gr/${spec.slice('shabda:'.length)}.json?strudel=1`;
  }
  if (spec.startsWith('local:')) return 'http://localhost:5432';
  return spec;
}

// Banks are static JSON and a buffer usually names the same few, so a run of
// `:peruse` after adding one line shouldn't refetch megabytes of manifests.
const bankCache = new Map();

function fetchBank(url) {
  if (!bankCache.has(url)) {
    bankCache.set(
      url,
      fetch(url).then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        return res.json();
      }),
    );
  }
  return bankCache.get(url);
}

// Bank JSON is a flat map of name → sample paths. `_base` (and anything else
// underscore-prefixed) is metadata, not a sound.
function soundsFromJson(json) {
  return Object.entries(json)
    .filter(([name]) => !name.startsWith('_'))
    .map(([name, value]) => ({
      name,
      variants: Array.isArray(value) ? value.length : 1,
      pitched: !Array.isArray(value) && typeof value === 'object' && value !== null,
    }));
}

async function loadBank(call) {
  if (call.kind === 'inline') {
    return { label: 'inline map', sounds: call.sounds };
  }
  const url = bankUrl(call.spec);
  try {
    return { label: call.spec, sounds: soundsFromJson(await fetchBank(url)) };
  } catch (err) {
    bankCache.delete(url);
    return { label: call.spec, sounds: [], error: err?.message ?? String(err) };
  }
}

// --- naming ------------------------------------------------------------------

function camelize(text) {
  const parts = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return '';
  const head = parts[0].toLowerCase();
  const tail = parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1));
  const joined = head + tail.join('');
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

// A readable variable name for the bank: the repo for a `github:` spec, the
// filename for a URL. `github:tidalcycles/dirt-samples` → `dirtSamples`.
function bankIdentifier(label) {
  if (label.startsWith('github:')) {
    const [, repo] = label.slice('github:'.length).split('/');
    return camelize(repo ?? '') || 'bank';
  }
  const file = label.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  return camelize(file.replace(/\.json$/i, '')) || 'bank';
}

// Don't shadow anything the musician already declared. Scanning declaration
// keywords with a regex is approximate, but it only ever costs us a numeric
// suffix, never a wrong program.
function declaredNames(code) {
  const names = new Set();
  const re = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = re.exec(code)) !== null) names.add(match[1]);
  return names;
}

// A bank claims four names — `piano`, `pianoI`, `pianoN`, `pianoNote` — and a
// duplicate `const` is a syntax error, not a subtle bug, so all four have to be
// free before we commit to a base.
const SUFFIXES = ['', 'I', 'N', 'Note'];

function uniqueName(base, taken) {
  let name = base;
  for (let i = 2; SUFFIXES.some((suffix) => taken.has(name + suffix)); i++) name = `${base}${i}`;
  for (const suffix of SUFFIXES) taken.add(name + suffix);
  return name;
}

// --- carrying state across regenerations --------------------------------------

// Scrubbing an index means editing inside the block, and the block is replaced
// wholesale on the next run. Read the old one first so the numbers you landed
// on — and which bank you left playing — survive the refresh.
function carriedState(block) {
  const values = new Map();
  const live = new Set();
  if (!block) return { values, live };
  const assign = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*((?:-?\d+)|"[^"]*"|'[^']*')\s*;/gm;
  let match;
  while ((match = assign.exec(block)) !== null) values.set(match[1], match[2]);
  const label = /^(\/\/\s*)?peruse_([A-Za-z_$][\w$]*)\s*:/gm;
  while ((match = label.exec(block)) !== null) {
    if (!match[1]) live.add(match[2]);
  }
  return { values, live };
}

// --- rendering ----------------------------------------------------------------

const WRAP_COLUMN = 92;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderNameList(names) {
  const lines = [];
  let current = '  ';
  names.forEach((name, i) => {
    const token = `"${name}"` + (i === names.length - 1 ? '' : ',');
    if (current.length > 2 && current.length + token.length + 1 > WRAP_COLUMN) {
      lines.push(current.trimEnd());
      current = '  ';
    }
    current += `${token} `;
  });
  if (current.trim()) lines.push(current.trimEnd());
  return lines;
}

function renderBank(bank, carried) {
  const lines = [];
  if (bank.error) {
    lines.push(`// ${bank.label} — could not load: ${bank.error}`);
    return lines;
  }
  const id = bank.id;
  const total = bank.sounds.reduce((sum, s) => sum + s.variants, 0);
  lines.push(
    `// ${bank.label} — ${plural(bank.sounds.length, 'sound')}, ${plural(total, 'sample')}`,
  );
  lines.push(`const ${id} = [`);
  lines.push(...renderNameList(bank.sounds.map((s) => s.name)));
  lines.push('];');
  lines.push(`const ${id}I = ${carried.values.get(`${id}I`) ?? 0}; // which sound`);

  // A bank whose samples are pitch-mapped (piano, vcsl) picks by note, not by
  // index — `n` would do nothing there, so offer the knob that works.
  const pitched = bank.sounds.length > 0 && bank.sounds.every((s) => s.pitched);
  let selector;
  if (pitched) {
    lines.push(`const ${id}Note = ${carried.values.get(`${id}Note`) ?? '"c3"'}; // which pitch`);
    selector = `.note(${id}Note)`;
  } else {
    const max = bank.sounds.reduce((most, sound) => Math.max(most, sound.variants), 1);
    lines.push(
      `const ${id}N = ${carried.values.get(`${id}N`) ?? 0}; // which variant, up to ${max} (wraps)`,
    );
    selector = `.n(${id}N)`;
  }
  lines.push(`${bank.muted ? '// ' : ''}peruse_${id}: s(pickmod(${id}, ${id}I))${selector}`);
  return lines;
}

function renderBlock(banks, carried) {
  const playable = banks.filter((b) => !b.error);
  const lines = [BEGIN];
  lines.push('// Scrub the index consts and re-evaluate to walk a bank; :peruse again to');
  lines.push('// rebuild this block in place (your indexes are carried over).');
  if (playable.length > 1) {
    lines.push('// One bank plays at a time — comment/uncomment the peruse_ lines to switch.');
  }
  for (const bank of banks) {
    lines.push('');
    lines.push(...renderBank(bank, carried));
  }
  lines.push('');
  lines.push(END);
  return lines.join('\n');
}

// --- the command ---------------------------------------------------------------

function findBlock(code) {
  const begin = BEGIN_RE.exec(code);
  if (!begin) return null;
  const rest = code.slice(begin.index);
  const end = END_RE.exec(rest);
  if (!end) return null;
  return { from: begin.index, to: begin.index + end.index + end[0].length };
}

export async function peruse(view, onStatus) {
  if (view.state.readOnly) {
    onStatus?.('peruse: buffer is read-only', 'error');
    return;
  }

  const code = view.state.doc.toString();
  const existing = findBlock(code);
  const previous = existing ? code.slice(existing.from, existing.to) : null;
  const carried = carriedState(previous);

  const calls = readSampleCalls(view.state);
  const unsupported = calls.filter((c) => c.kind === 'unsupported');
  const loadable = calls.filter((c) => c.kind !== 'unsupported');
  if (!loadable.length) {
    onStatus?.('peruse: no samples() calls in this file', 'error');
    view.focus();
    return;
  }

  onStatus?.(`peruse: loading ${loadable.length} bank${loadable.length === 1 ? '' : 's'}…`);
  const banks = await Promise.all(loadable.map(loadBank));

  // Names already in the file, minus the block we're about to replace —
  // otherwise every rerun would collide with its own previous output.
  const taken = declaredNames(existing ? code.slice(0, existing.from) + code.slice(existing.to) : code);
  // Restore whichever lines were live last time. Failing that (first run, or
  // the banks changed underneath us) leave exactly the first one playing, so
  // :peruse never drops six banks of simultaneous noise on you.
  const playable = banks.filter((bank) => !bank.error);
  playable.forEach((bank, i) => {
    bank.id = uniqueName(bankIdentifier(bank.label), taken);
    bank.muted = carried.live.size > 0 ? !carried.live.has(bank.id) : i !== 0;
  });
  if (playable.length && playable.every((bank) => bank.muted)) playable[0].muted = false;

  const block = renderBlock(banks, carried);
  let from;
  let insert;
  if (existing) {
    from = existing.from;
    insert = block;
  } else {
    from = view.state.doc.length;
    insert = (code.endsWith('\n\n') ? '' : code.endsWith('\n') ? '\n' : '\n\n') + block;
  }
  const to = existing ? existing.to : from;

  // Land the cursor on the first index const, which is the only line anyone
  // wants to touch first.
  const offset = insert.search(/^const [A-Za-z_$][\w$]*I = /m);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + (offset === -1 ? insert.length : offset) },
    scrollIntoView: true,
  });
  view.focus();

  const failed = banks.length - playable.length;
  const sounds = playable.reduce((sum, bank) => sum + bank.sounds.length, 0);
  const notes = [];
  if (failed) notes.push(`${failed} failed`);
  if (unsupported.length) notes.push(`${unsupported.length} non-literal skipped`);
  onStatus?.(
    `peruse: ${plural(sounds, 'sound')} from ${plural(playable.length, 'bank')}` +
      (notes.length ? ` (${notes.join(', ')})` : ''),
    failed ? 'error' : '',
  );
}
