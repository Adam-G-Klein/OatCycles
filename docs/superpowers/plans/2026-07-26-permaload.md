# `:permaload` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `:permaload <spec> [sound …]` downloads a remote sample bank into `./samples`, and a song's existing `samples('github:…')` line then resolves to those local files instead of the network.

**Architecture:** Ripping writes into the layout `:banks` already defines, so a permaloaded bank is an ordinary local bank — same panel, same manifest route, same audio route. A dot-prefixed sidecar in the bank directory carries the upstream manifest, which lets the generated manifest advertise the whole bank while un-ripped paths are redirected upstream by the audio route. A thin client wrapper around Strudel's `samples()` swaps a remote spec for the local manifest when one exists.

**Tech Stack:** Plain ESM, Vite dev/preview middleware, `node:test` + `node:assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-permaload-design.md`

## Global Constraints

- No new npm dependencies. Node 20+ built-ins only (`fetch`, `node:test`, `node:fs/promises`).
- ESM throughout (`"type": "module"`).
- Tests run with `npm test` (`node --test "test/**/*.test.js"`). Every task ends green.
- Comments explain **why**, in prose, matching the surrounding files. Do not add narration comments to obvious code.
- The plugin writes only under `samples/`. It must never write to `SavedSongs/` or `AutoSaves/`.
- Any manual check of the running app uses `http://localhost:5173/?agent=1` and `window.oat.silentPlay(code)` — never a click on Play, never a bare `npm run dev`. See `CLAUDE.md`.
- Start the dev server through the preview tooling (`.claude/launch.json` defines `oatcycles-dev`).

## Before you start: check the tree

`vite-banks-plugin.js`, `test/banks-plugin.test.js`, `src/editor/editor.js`, `src/main.js` and `vite.config.js` were being written by a parallel session when this plan was authored. Line numbers below are from that snapshot.

- [ ] Run `git status` and `npm test`. If `test/banks-plugin.test.js` still fails, stop and report — that failure is not yours, and Task 2 and 3 edit that file.
- [ ] Confirm `vite-banks-plugin.js` still exports `manifest`, `resolveInside`, `__internals = { scanBank, listBanks }`, and that `banksPlugin({ dir: 'samples' })` is registered in `vite.config.js`. If those moved, adapt paths rather than reverting anyone's work.

## File Structure

**Created**
- `src/sounds/bank-url.js` — spec → manifest URL. Shared by `:peruse`, the client wrapper, and the rip endpoint.
- `src/sounds/permaload.js` — client: the `/api/banks` cache, the `samples()` wrapper, and the `:permaload` command that streams progress into the status bar.
- `vite-permaload-plugin.js` — server: `POST /api/permaload`, the downloader, sidecar writing.
- `test/bank-url.test.js`, `test/permaload.test.js`

**Modified**
- `vite-banks-plugin.js` — sidecar reading, merged manifest, merged listing counts, upstream redirect on a disk miss.
- `test/banks-plugin.test.js` — cases for the above.
- `src/editor/peruse.js` — import `bankUrl` from its new home; prefer a local manifest.
- `src/editor/editor.js` — the `:permaload` ex-command.
- `src/main.js` — install the wrapper, wire the command.
- `vite.config.js` — register the plugin.

---

### Task 1: Shared spec resolver

`bankUrl()` currently lives in `src/editor/peruse.js`. Three callers need it. Move it, with its tests.

**Files:**
- Create: `src/sounds/bank-url.js`, `test/bank-url.test.js`
- Modify: `src/editor/peruse.js:106-117` (remove the function, import it instead)

**Interfaces:**
- Produces: `bankUrl(spec: string) → string` — `github:user/repo[/branch]`, `shabda:words`, `local:`, or a plain URL returned unchanged.

- [ ] **Step 1: Write the failing test**

```js
// test/bank-url.test.js
// bankUrl is the one place a samples() spec becomes a URL. :peruse, the
// samples() wrapper and the rip endpoint all resolve through it, so
// `github:x/y` and `github:x/y/main` naming the same bank is what makes a
// permaloaded bank match the spec a song actually wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bankUrl } from '../src/sounds/bank-url.js';

test('a github spec without a branch defaults to main', () => {
  assert.equal(
    bankUrl('github:tidalcycles/dirt-samples'),
    'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json',
  );
});

test('an explicit main branch resolves identically', () => {
  assert.equal(
    bankUrl('github:tidalcycles/dirt-samples/main'),
    bankUrl('github:tidalcycles/dirt-samples'),
  );
});

test('a trailing slash does not change the bank', () => {
  assert.equal(bankUrl('github:tidalcycles/dirt-samples/'), bankUrl('github:tidalcycles/dirt-samples'));
});

test('a non-main branch is kept', () => {
  assert.equal(
    bankUrl('github:tidalcycles/dirt-samples/master'),
    'https://raw.githubusercontent.com/tidalcycles/dirt-samples/master/strudel.json',
  );
});

test('shabda specs become the shabda json endpoint', () => {
  assert.equal(bankUrl('shabda:cat'), 'https://shabda.ndre.gr/cat.json?strudel=1');
});

test('a plain url is its own manifest url', () => {
  const url = 'https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json';
  assert.equal(bankUrl(url), url);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/sounds/bank-url.js'`

- [ ] **Step 3: Create the module**

Cut lines 102–117 of `src/editor/peruse.js` (the `--- resolving and fetching banks ---` comment through the end of `bankUrl`) into the new file verbatim:

```js
// src/sounds/bank-url.js
// The same resolution Strudel's own `samples()` does, so everything that reads
// a bank — :peruse, the samples() wrapper, the rip endpoint — reads exactly the
// bank the engine will load, and fails in exactly the same places.
//
// It also settles what "the same bank" means: `github:x/y` and `github:x/y/main`
// resolve to one URL, which is how a ripped bank matches the spec a song wrote.

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
```

- [ ] **Step 4: Point `:peruse` at it**

In `src/editor/peruse.js`, delete the moved function and add to the imports at the top:

```js
import { bankUrl } from '../sounds/bank-url.js';
```

`bankUrl` was `export`ed from peruse.js. Run `grep -rn "from './peruse.js'\|from '../editor/peruse.js'" src/ test/` and confirm nothing imports it from there. If something does, repoint it at the new module.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 6: Commit**

```bash
git add src/sounds/bank-url.js test/bank-url.test.js src/editor/peruse.js
git commit -m "refactor: move bankUrl into src/sounds/bank-url.js"
```

---

### Task 2: The sidecar, and a manifest that merges it

A scanned manifest can only name files on disk, so a partial rip would lose the sounds it didn't take. Teach the banks plugin to read a sidecar and merge it over the scan.

**Files:**
- Modify: `vite-banks-plugin.js` (the `manifest` function, `listBanks`, the manifest route, `__internals`)
- Test: `test/banks-plugin.test.js`

**Interfaces:**
- Produces, all from `vite-banks-plugin.js`:
  - `SIDECAR_NAME = '.permaload.json'`
  - `readSidecar(bankDir: string) → Promise<object|null>`
  - `flattenPaths(value) → string[]` — every path inside an array, a string, or a pitched `{note: paths}` object
  - `manifest(bank: string, sounds: {name, files}[], sidecar?: object|null) → object`
  - `listBanks` entries gain an optional `spec`, and count the merged sounds

Sidecar shape (written in Task 5, read here):

```json
{
  "spec": "github:tidalcycles/dirt-samples",
  "manifestUrl": "https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json",
  "base": "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/",
  "rippedAt": "2026-07-26T16:40:00.000Z",
  "sounds": { "bd": ["bd/BT0A0A7.wav", "bd/BT0AADA.wav"] }
}
```

- [ ] **Step 1: Write the failing tests**

Append to `test/banks-plugin.test.js`. Add `SIDECAR_NAME`, `readSidecar` and `flattenPaths` to the existing import from `../vite-banks-plugin.js`, and `listBanks` is already destructured from `__internals`.

```js
// A permaloaded bank keeps the manifest it was ripped from in a dot-file
// beside the audio. The scan can only see what was downloaded; the sidecar is
// how the bank still advertises the sounds nobody ripped yet.

async function sidecarBank(root, name, sidecar, files = []) {
  const dir = path.join(root, name);
  await tree(dir, files);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.permaload.json'), JSON.stringify(sidecar));
  return dir;
}

const DIRT = {
  spec: 'github:tidalcycles/dirt-samples',
  manifestUrl: 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json',
  base: 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/',
  sounds: { bd: ['bd/BT0A0A7.wav', 'bd/BT0AADA.wav'], sd: ['sd/ST0T0S0.wav'] },
};

test('the sidecar is invisible to the scan', async () => {
  const root = await tmpdir();
  const dir = await sidecarBank(root, 'dirt', DIRT, ['bd/BT0A0A7.wav']);
  const sounds = await scanBank(dir);
  assert.deepEqual(sounds.map((s) => s.name), ['bd']);
});

test('the manifest advertises sounds the sidecar names but disk does not have', () => {
  const scanned = [{ name: 'bd', files: ['bd/BT0A0A7.wav'] }];
  const json = manifest('dirt', scanned, DIRT);
  assert.equal(json._base, '/api/banks/dirt/');
  // Upstream's full list wins, in upstream's order, so n() indexes match what
  // :peruse prints.
  assert.deepEqual(json.bd, ['bd/BT0A0A7.wav', 'bd/BT0AADA.wav']);
  assert.deepEqual(json.sd, ['sd/ST0T0S0.wav']);
});

test('a bank with no sidecar is unchanged', () => {
  const scanned = [{ name: 'hh', files: ['hh/01.wav'] }];
  assert.deepEqual(manifest('kit', scanned, null), {
    _base: '/api/banks/kit/',
    hh: ['hh/01.wav'],
  });
});

test('a hand-dropped sound survives alongside a sidecar', () => {
  const scanned = [{ name: 'mine', files: ['mine/01.wav'] }];
  const json = manifest('dirt', scanned, DIRT);
  assert.deepEqual(json.mine, ['mine/01.wav']);
  assert.ok(json.bd);
});

test('pitched sidecar entries keep their note map', () => {
  const sidecar = { ...DIRT, sounds: { piano: { c3: ['piano/c3.wav'], e3: 'piano/e3.wav' } } };
  const json = manifest('piano', [], sidecar);
  assert.deepEqual(json.piano, { c3: ['piano/c3.wav'], e3: 'piano/e3.wav' });
});

test('sidecar paths are url-encoded segment by segment', () => {
  const sidecar = { ...DIRT, sounds: { bd: ['bd/take #2.wav'] } };
  assert.deepEqual(manifest('dirt', [], sidecar).bd, ['bd/take%20%232.wav']);
});

test('flattenPaths finds every path shape', () => {
  assert.deepEqual(flattenPaths('a.wav'), ['a.wav']);
  assert.deepEqual(flattenPaths(['a.wav', 'b.wav']), ['a.wav', 'b.wav']);
  assert.deepEqual(flattenPaths({ c3: ['a.wav'], e3: 'b.wav' }), ['a.wav', 'b.wav']);
});

test('readSidecar returns null for an ordinary bank', async () => {
  const root = await tmpdir();
  await tree(path.join(root, 'kit'), ['hh/01.wav']);
  assert.equal(await readSidecar(path.join(root, 'kit')), null);
});

test('the listing reports the spec and the merged counts', async () => {
  const root = await tmpdir();
  await sidecarBank(root, 'dirt', DIRT, ['bd/BT0A0A7.wav']);
  const [bank] = await listBanks(root);
  assert.equal(bank.spec, 'github:tidalcycles/dirt-samples');
  // 2 sounds and 3 samples upstream, even though one file is on disk.
  assert.equal(bank.sounds, 2);
  assert.equal(bank.samples, 3);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `SIDECAR_NAME`/`readSidecar`/`flattenPaths` are not exported, and `manifest` ignores its third argument.

- [ ] **Step 3: Implement in `vite-banks-plugin.js`**

Add above `manifest`:

```js
// A bank ripped by `:permaload` keeps the manifest it came from beside its
// audio. The scan can only report files that exist, so a partial rip would
// silently drop every sound it didn't take; the sidecar is what lets the bank
// still advertise the whole thing. Dot-prefixed, so `isHidden` already keeps it
// out of the scan and out of the panel.
export const SIDECAR_NAME = '.permaload.json';

export async function readSidecar(bankDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(bankDir, SIDECAR_NAME), 'utf8'));
  } catch {
    return null; // no sidecar, or unreadable — an ordinary hand-made bank
  }
}

// A manifest entry is a path, a list of paths, or a note → paths map. Anything
// that needs *all* the paths (counting them, deciding what may be redirected)
// goes through here rather than re-deriving the shapes.
export function flattenPaths(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenPaths);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenPaths);
  return [];
}

// Sidecar entries win: their paths are upstream's, in upstream's order, and the
// ones that were ripped resolve to disk because a rip writes to exactly those
// paths. Sounds only on disk (dropped in by hand) are kept as they are.
function mergedSounds(sounds, sidecar) {
  const merged = new Map(sounds.map((sound) => [sound.name, sound.files]));
  for (const [name, value] of Object.entries(sidecar?.sounds ?? {})) merged.set(name, value);
  return merged;
}
```

Replace `manifest` with:

```js
const encodeValue = (value) => {
  if (typeof value === 'string') return encodePath(value);
  if (Array.isArray(value)) return value.map(encodeValue);
  return Object.fromEntries(Object.entries(value).map(([note, v]) => [note, encodeValue(v)]));
};

export function manifest(bank, sounds, sidecar = null) {
  const json = { _base: `${BANKS_API}/${encodeURIComponent(bank)}/` };
  for (const [name, value] of mergedSounds(sounds, sidecar)) json[name] = encodeValue(value);
  return json;
}
```

In `listBanks`, read the sidecar and count the merged list:

```js
  for (const entry of entries) {
    if (!entry.isDirectory() || isHidden(entry.name)) continue;
    const bankDir = path.join(root, entry.name);
    const sounds = await scanBank(bankDir);
    const sidecar = await readSidecar(bankDir);
    const merged = mergedSounds(sounds, sidecar);
    banks.push({
      name: entry.name,
      sounds: merged.size,
      samples: [...merged.values()].reduce((sum, value) => sum + flattenPaths(value).length, 0),
      // Only a ripped bank has a spec; it's what matches this bank to the
      // samples() call a song wrote.
      ...(sidecar?.spec ? { spec: sidecar.spec } : {}),
    });
  }
```

In the manifest route, pass the sidecar through:

```js
        const bankDir = path.join(samplesDir, bank);
        let sounds;
        try {
          sounds = await scanBank(bankDir);
        } catch {
          return sendJson(res, 404, { error: 'no such bank' });
        }
        return sendJson(res, 200, manifest(bank, sounds, await readSidecar(bankDir)));
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vite-banks-plugin.js test/banks-plugin.test.js
git commit -m "feat: merge a permaload sidecar into the bank manifest"
```

---

### Task 3: Redirect un-ripped samples upstream

The merged manifest names paths that may not be on disk. Serve those from where the bank came from.

**Files:**
- Modify: `vite-banks-plugin.js` (the `/api/banks/<bank>/<path>` route)
- Test: `test/banks-plugin.test.js`

**Interfaces:**
- Consumes: `readSidecar`, `flattenPaths`, `SIDECAR_NAME` from Task 2.
- Produces: `redirectTarget(sidecar, relPath) → string|null` — the upstream URL for a path the sidecar names, else `null`.

The route work is HTTP glue; the decision is the pure function, and that is what the tests pin down. Testing the middleware end to end would mean standing up a server, which this suite does not do.

- [ ] **Step 1: Write the failing tests**

Append to `test/banks-plugin.test.js` (add `redirectTarget` to the import):

```js
// A merged manifest names paths that were never downloaded. They must still
// play, so the audio route sends them upstream — but only the paths the
// sidecar actually names, or the route becomes an open redirect.

test('a path the sidecar names redirects to where the bank came from', () => {
  assert.equal(
    redirectTarget(DIRT, 'bd/BT0AADA.wav'),
    'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/BT0AADA.wav',
  );
});

test('a path the sidecar does not name is refused', () => {
  assert.equal(redirectTarget(DIRT, 'bd/invented.wav'), null);
});

test('no sidecar means no redirect', () => {
  assert.equal(redirectTarget(null, 'bd/BT0AADA.wav'), null);
});

test('a sidecar without a base cannot redirect', () => {
  assert.equal(redirectTarget({ ...DIRT, base: undefined }, 'bd/BT0AADA.wav'), null);
});

test('the redirect url is encoded segment by segment', () => {
  const sidecar = { ...DIRT, sounds: { bd: ['bd/take #2.wav'] } };
  assert.equal(
    redirectTarget(sidecar, 'bd/take #2.wav'),
    'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/take%20%232.wav',
  );
});

test('pitched entries are redirectable too', () => {
  const sidecar = { ...DIRT, sounds: { piano: { c3: ['piano/c3.wav'] } } };
  assert.equal(redirectTarget(sidecar, 'piano/c3.wav'), `${DIRT.base}piano/c3.wav`);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `redirectTarget is not a function`.

- [ ] **Step 3: Implement**

Add to `vite-banks-plugin.js`, below `flattenPaths`:

```js
// A permaloaded bank advertises sounds it never downloaded. Rather than 404
// them, hand the browser the upstream URL — the bank plays whole, and the parts
// you ripped are the parts that stop needing the network.
//
// Only paths the sidecar names are redirected. Without that check this route
// would forward any path at all to any host the sidecar mentions.
export function redirectTarget(sidecar, relPath) {
  if (!sidecar?.base) return null;
  const known = new Set(Object.values(sidecar.sounds ?? {}).flatMap(flattenPaths));
  return known.has(relPath) ? sidecar.base + encodePath(relPath) : null;
}
```

In the audio route, replace the `catch` around `fs.readFile`:

```js
      let body;
      try {
        body = await fs.readFile(file);
      } catch {
        const rel = decodeURIComponent(rest.slice(slash + 1));
        const upstream = redirectTarget(await readSidecar(path.join(samplesDir, bank)), rel);
        if (upstream) {
          res.statusCode = 302;
          res.setHeader('Location', upstream);
          res.setHeader('Cache-Control', 'no-cache');
          return res.end();
        }
        return sendJson(res, 404, { error: 'no such sample' });
      }
```

`decodeURIComponent` can throw on a malformed escape; `resolveInside` above already rejected those paths, so by here it is safe.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vite-banks-plugin.js test/banks-plugin.test.js
git commit -m "feat: stream un-ripped samples from upstream"
```

---

### Task 4: Rip planning — the pure parts

Naming the directory, choosing what to download, merging sidecars, and refusing to write outside the bank. All decisions, no network.

**Files:**
- Create: `vite-permaload-plugin.js`, `test/permaload.test.js`

**Interfaces:**
- Consumes: `bankUrl` (Task 1); `resolveInside`, `readSidecar`, `SIDECAR_NAME`, `flattenPaths` from `vite-banks-plugin.js`.
- Produces, from `vite-permaload-plugin.js`:
  - `bankDirName(spec: string) → string`
  - `chooseBankDir(root: string, spec: string, manifestUrl: string) → Promise<string>` — reuses the directory of a bank already ripped from the same manifest URL, else a free name
  - `selectSounds(manifest: object, names: string[]) → Record<string, unknown>` — `names` empty means everything; underscore keys are metadata, never sounds
  - `planFiles(sounds: Record<string, unknown>, base: string) → {rel, url}[]`
  - `mergeSidecar(existing: object|null, next: object) → object`

- [ ] **Step 1: Write the failing tests**

```js
// test/permaload.test.js
// The decisions a rip makes before it touches the network: what to call the
// directory, which sounds to take, and how a second rip adds to the first
// instead of replacing it. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bankDirName,
  chooseBankDir,
  selectSounds,
  planFiles,
  mergeSidecar,
} from '../vite-permaload-plugin.js';

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oat-permaload-'));
}

async function bankWithSidecar(root, name, sidecar) {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, name, '.permaload.json'), JSON.stringify(sidecar));
}

const DIRT_URL = 'https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json';

test('a github spec is named after the repo', () => {
  assert.equal(bankDirName('github:tidalcycles/dirt-samples'), 'dirt-samples');
});

test('a url is named after its manifest file', () => {
  assert.equal(
    bankDirName('https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json'),
    'piano',
  );
});

test('a shabda spec keeps its words', () => {
  assert.equal(bankDirName('shabda:cat,dog'), 'shabda-cat-dog');
});

test('names that could not be a directory are made safe', () => {
  // Nothing that could climb: a repo segment of `..` leaves no usable name at
  // all, so the bank falls back to a generic one rather than a path.
  assert.equal(bankDirName('github:some/../evil'), 'bank');
  assert.match(bankDirName('github:a/My Kit!'), /^[a-z0-9._-]+$/);
});

test('a second rip of the same bank reuses its directory', async () => {
  const root = await tmpdir();
  await bankWithSidecar(root, 'dirt-samples', { manifestUrl: DIRT_URL });
  assert.equal(
    await chooseBankDir(root, 'github:tidalcycles/dirt-samples/main', DIRT_URL),
    'dirt-samples',
  );
});

test('a different bank wanting a taken name is suffixed', async () => {
  const root = await tmpdir();
  await fs.mkdir(path.join(root, 'piano'), { recursive: true }); // hand-made bank
  const dir = await chooseBankDir(root, 'https://example.com/piano.json', 'https://example.com/piano.json');
  assert.equal(dir, 'piano-2');
});

test('an empty samples directory is not an error', async () => {
  const root = path.join(await tmpdir(), 'nothing-here');
  assert.equal(await chooseBankDir(root, 'github:x/kit', 'https://x/kit.json'), 'kit');
});

const MANIFEST = {
  _base: 'https://example.com/dirt/',
  bd: ['bd/one.wav', 'bd/two.wav'],
  sd: ['sd/one.wav'],
  piano: { c3: ['piano/c3.wav'] },
};

test('no names means the whole bank', () => {
  assert.deepEqual(Object.keys(selectSounds(MANIFEST, [])), ['bd', 'sd', 'piano']);
});

test('names select only those sounds', () => {
  assert.deepEqual(selectSounds(MANIFEST, ['bd', 'piano']), {
    bd: ['bd/one.wav', 'bd/two.wav'],
    piano: { c3: ['piano/c3.wav'] },
  });
});

test('a name the bank does not have selects nothing for it', () => {
  assert.deepEqual(selectSounds(MANIFEST, ['nope']), {});
});

test('metadata keys are never sounds', () => {
  assert.equal('_base' in selectSounds(MANIFEST, []), false);
});

test('planning pairs each path with its upstream url', () => {
  const files = planFiles({ bd: ['bd/one.wav'] }, 'https://example.com/dirt/');
  assert.deepEqual(files, [{ rel: 'bd/one.wav', url: 'https://example.com/dirt/bd/one.wav' }]);
});

test('planning encodes the url but keeps the path as-is', () => {
  const [file] = planFiles({ bd: ['bd/take #2.wav'] }, 'https://example.com/dirt/');
  assert.equal(file.rel, 'bd/take #2.wav');
  assert.equal(file.url, 'https://example.com/dirt/bd/take%20%232.wav');
});

test('planning drops a path that would escape the bank', () => {
  assert.deepEqual(planFiles({ bd: ['../../etc/passwd'] }, 'https://example.com/dirt/'), []);
  assert.deepEqual(planFiles({ bd: ['/etc/passwd'] }, 'https://example.com/dirt/'), []);
});

test('a second rip adds its sounds to the sidecar', () => {
  const existing = { spec: 'github:x/y', base: 'https://x/', sounds: { bd: ['bd/one.wav'] } };
  const merged = mergeSidecar(existing, {
    spec: 'github:x/y',
    base: 'https://x/',
    sounds: { sd: ['sd/one.wav'] },
  });
  assert.deepEqual(Object.keys(merged.sounds), ['bd', 'sd']);
});

test('a re-rip of the same sound takes the newer paths', () => {
  const merged = mergeSidecar(
    { sounds: { bd: ['bd/old.wav'] } },
    { spec: 'github:x/y', base: 'https://x/', sounds: { bd: ['bd/new.wav'] } },
  );
  assert.deepEqual(merged.sounds.bd, ['bd/new.wav']);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../vite-permaload-plugin.js'`

- [ ] **Step 3: Implement the pure half**

```js
// vite-permaload-plugin.js
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { bankUrl } from './src/sounds/bank-url.js';
import { SIDECAR_NAME, readSidecar, resolveInside } from './vite-banks-plugin.js';

// `:permaload <spec> [sound …]` — download a remote bank into ./samples.
//
// This plugin owns ripping: the network and the writes. vite-banks-plugin.js
// keeps owning reading and serving, and owns the sidecar format this writes.
// A rip lands in the layout :banks already scans, so a ripped bank is an
// ordinary local bank the moment it finishes.

const API_PATH = '/api/permaload';

// --- naming -------------------------------------------------------------------

// Directory names come off a spec, so they get the same treatment a bank name
// gets on the way in: no separators, nothing that could climb.
function safeDirName(raw) {
  const name = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return name || 'bank';
}

// The name a musician would use for the bank: the repo for a github spec, the
// manifest's filename for a URL, the words for a shabda lookup.
export function bankDirName(spec) {
  if (spec.startsWith('github:')) {
    const parts = spec.slice('github:'.length).split('/').filter(Boolean);
    return safeDirName(parts[1] ?? parts[0]);
  }
  if (spec.startsWith('shabda:')) return safeDirName(`shabda-${spec.slice('shabda:'.length)}`);
  const file = spec.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  return safeDirName(file.replace(/\.json$/i, ''));
}

// Ripping the same bank twice must land in the same directory — that's what
// makes a second :permaload add sounds rather than start a rival copy. Identity
// is the resolved manifest URL, so github:x/y and github:x/y/main are one bank.
export async function chooseBankDir(root, spec, manifestUrl) {
  let entries = [];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return bankDirName(spec); // no ./samples yet
  }
  for (const entry of entries) {
    const sidecar = await readSidecar(path.join(root, entry.name));
    if (sidecar?.manifestUrl === manifestUrl) return entry.name;
  }
  const taken = new Set(entries.map((e) => e.name));
  const base = bankDirName(spec);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  return name;
}

// --- what to download ----------------------------------------------------------

// Underscore keys are the manifest's own metadata (`_base`), not sounds — the
// same rule :peruse applies when it lists a bank.
export function selectSounds(manifest, names = []) {
  const wanted = new Set(names);
  return Object.fromEntries(
    Object.entries(manifest).filter(
      ([name]) => !name.startsWith('_') && (wanted.size === 0 || wanted.has(name)),
    ),
  );
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function pathsOf(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(pathsOf);
  if (value && typeof value === 'object') return Object.values(value).flatMap(pathsOf);
  return [];
}

// Every file the selection implies, as a local path and the URL it comes from.
// A manifest is remote data: a path that climbs out of the bank directory, or
// is absolute, is dropped here rather than trusted downstream.
export function planFiles(sounds, base) {
  const files = [];
  const seen = new Set();
  for (const rel of Object.values(sounds).flatMap(pathsOf)) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (path.isAbsolute(rel) || !resolveInside('/bank', rel)) continue;
    files.push({ rel, url: base + encodePath(rel) });
  }
  return files;
}

// --- the sidecar ----------------------------------------------------------------

// A rip of three more sounds must not erase the twelve already there.
export function mergeSidecar(existing, next) {
  return {
    ...next,
    sounds: { ...(existing?.sounds ?? {}), ...next.sounds },
  };
}
```

Note `planFiles` uses `resolveInside('/bank', rel)` purely as the containment predicate — the real destination is resolved against the actual bank directory in Task 5.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vite-permaload-plugin.js test/permaload.test.js
git commit -m "feat: plan a sample-bank rip"
```

---

### Task 5: The rip endpoint

Download the planned files, report progress as it goes, write the sidecar.

**Files:**
- Modify: `vite-permaload-plugin.js` (add the downloader and the middleware), `vite.config.js`
- Test: `test/permaload.test.js`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces:
  - `ripBank({ root, spec, sounds, fetchImpl, onEvent }) → Promise<{bank, downloaded, skipped, bytes, errors}>`
  - `permaloadPlugin() → VitePlugin` serving `POST /api/permaload`, responding with NDJSON

NDJSON lines, in order:

```
{"type":"start","bank":"dirt-samples","files":1053}
{"type":"progress","done":64,"skipped":12}
{"type":"done","bank":"dirt-samples","downloaded":1041,"skipped":12,"bytes":214000000,"errors":[{"rel":"bd/x.wav","error":"404"}]}
{"type":"error","error":"…"}          ← instead of `done`, if the rip could not start
```

`ripBank` takes `fetchImpl` so the tests never touch the network.

- [ ] **Step 1: Write the failing tests**

Append to `test/permaload.test.js` (add `ripBank` to the import):

```js
// The rip itself, with the network stubbed: what lands on disk, what a second
// run skips, and what a failed file does to the rest.

function stubFetch(files, { fail = new Set() } = {}) {
  return async (url) => {
    if (fail.has(url)) return { ok: false, status: 404, statusText: 'Not Found' };
    if (!(url in files)) return { ok: false, status: 404, statusText: 'Not Found' };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(files[url]).buffer,
    };
  };
}

const BASE = 'https://example.com/dirt/';
const REMOTE = {
  [`${BASE}strudel.json`]: JSON.stringify({
    _base: BASE,
    bd: ['bd/one.wav', 'bd/two.wav'],
    sd: ['sd/one.wav'],
  }),
  [`${BASE}bd/one.wav`]: 'ONE',
  [`${BASE}bd/two.wav`]: 'TWO',
  [`${BASE}sd/one.wav`]: 'SD',
};

test('a rip writes the audio and the sidecar', async () => {
  const root = await tmpdir();
  const result = await ripBank({
    root,
    spec: `${BASE}strudel.json`,
    sounds: [],
    fetchImpl: stubFetch(REMOTE),
  });
  assert.equal(result.downloaded, 3);
  assert.equal(await fs.readFile(path.join(root, 'strudel', 'bd/one.wav'), 'utf8'), 'ONE');
  const sidecar = JSON.parse(await fs.readFile(path.join(root, 'strudel', '.permaload.json'), 'utf8'));
  assert.equal(sidecar.base, BASE);
  assert.deepEqual(Object.keys(sidecar.sounds), ['bd', 'sd']);
});

test('named sounds rip only those files', async () => {
  const root = await tmpdir();
  const result = await ripBank({
    root,
    spec: `${BASE}strudel.json`,
    sounds: ['sd'],
    fetchImpl: stubFetch(REMOTE),
  });
  assert.equal(result.downloaded, 1);
  await assert.rejects(() => fs.stat(path.join(root, 'strudel', 'bd/one.wav')));
});

test('a second rip skips what is already on disk', async () => {
  const root = await tmpdir();
  const args = { root, spec: `${BASE}strudel.json`, sounds: [], fetchImpl: stubFetch(REMOTE) };
  await ripBank(args);
  const again = await ripBank(args);
  assert.equal(again.downloaded, 0);
  assert.equal(again.skipped, 3);
});

test('a second rip keeps the first rip’s sounds in the sidecar', async () => {
  const root = await tmpdir();
  const fetchImpl = stubFetch(REMOTE);
  await ripBank({ root, spec: `${BASE}strudel.json`, sounds: ['bd'], fetchImpl });
  await ripBank({ root, spec: `${BASE}strudel.json`, sounds: ['sd'], fetchImpl });
  const sidecar = JSON.parse(await fs.readFile(path.join(root, 'strudel', '.permaload.json'), 'utf8'));
  assert.deepEqual(Object.keys(sidecar.sounds).sort(), ['bd', 'sd']);
});

test('one bad file does not stop the rip', async () => {
  const root = await tmpdir();
  const result = await ripBank({
    root,
    spec: `${BASE}strudel.json`,
    sounds: [],
    fetchImpl: stubFetch(REMOTE, { fail: new Set([`${BASE}bd/two.wav`]) }),
  });
  assert.equal(result.downloaded, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].rel, 'bd/two.wav');
});

test('progress is reported as files land', async () => {
  const root = await tmpdir();
  const events = [];
  await ripBank({
    root,
    spec: `${BASE}strudel.json`,
    sounds: [],
    fetchImpl: stubFetch(REMOTE),
    onEvent: (e) => events.push(e),
  });
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].files, 3);
  assert.ok(events.some((e) => e.type === 'progress'));
});

test('an unreachable manifest fails before anything is written', async () => {
  const root = await tmpdir();
  await assert.rejects(
    () => ripBank({ root, spec: 'https://example.com/missing.json', sounds: [], fetchImpl: stubFetch({}) }),
    /404/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL — `ripBank is not a function`.

- [ ] **Step 3: Implement the rip**

Append to `vite-permaload-plugin.js`:

```js
// --- ripping ---------------------------------------------------------------------

// Enough parallelism to saturate a home connection, few enough that a bank of a
// thousand files doesn't open a thousand sockets.
const CONCURRENCY = 8;

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return JSON.parse(new TextDecoder().decode(await res.arrayBuffer()));
}

// A file already on disk is a file already ripped. Zero-length means a previous
// run died mid-write, so take it again.
async function alreadyHave(dest) {
  try {
    return (await fs.stat(dest)).size > 0;
  } catch {
    return false;
  }
}

export async function ripBank({ root, spec, sounds = [], fetchImpl = fetch, onEvent = () => {} }) {
  const manifestUrl = bankUrl(spec);
  const json = await fetchJson(fetchImpl, manifestUrl);

  // Where the manifest's own paths resolve from: its `_base` if it has one,
  // otherwise the directory it was fetched from — the same rule superdough uses.
  const base = json._base || manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const selected = selectSounds(json, sounds);
  const files = planFiles(selected, base);

  const bank = await chooseBankDir(root, spec, manifestUrl);
  const bankDir = path.join(root, bank);
  onEvent({ type: 'start', bank, files: files.length });

  let downloaded = 0;
  let skipped = 0;
  let bytes = 0;
  const errors = [];
  let next = 0;

  const worker = async () => {
    while (next < files.length) {
      const { rel, url } = files[next++];
      const dest = resolveInside(bankDir, rel);
      if (!dest) {
        errors.push({ rel, error: 'refused: outside the bank directory' });
        continue;
      }
      try {
        if (await alreadyHave(dest)) {
          skipped++;
        } else {
          const res = await fetchImpl(url);
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
          const body = Buffer.from(await res.arrayBuffer());
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, body);
          downloaded++;
          bytes += body.length;
        }
      } catch (err) {
        errors.push({ rel, error: String(err?.message ?? err) });
      }
      onEvent({ type: 'progress', done: downloaded, skipped });
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  // The sidecar records what the bank *is*, not what this run managed to fetch:
  // the sounds it names are the ones the manifest will advertise, and the ones
  // that didn't land are streamed from `base` until a later rip catches them.
  await fs.mkdir(bankDir, { recursive: true });
  const sidecar = mergeSidecar(await readSidecar(bankDir), {
    spec,
    manifestUrl,
    base,
    rippedAt: new Date().toISOString(),
    sounds: selected,
  });
  await fs.writeFile(path.join(bankDir, SIDECAR_NAME), JSON.stringify(sidecar, null, 2));

  return { bank, downloaded, skipped, bytes, errors };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Add the middleware and register the plugin**

Append to `vite-permaload-plugin.js`:

```js
// --- the endpoint -----------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function permaloadPlugin({ dir = 'samples' } = {}) {
  let samplesDir = dir;

  const middleware = async (req, res, next) => {
    if ((req.url || '').split('?')[0] !== API_PATH) return next();
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }

    // Progress streams as it happens: a bank can be hundreds of megabytes, and
    // a status bar that says nothing for six minutes looks broken.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    const send = (event) => res.write(JSON.stringify(event) + '\n');

    try {
      const raw = await readBody(req);
      const { spec, sounds } = raw ? JSON.parse(raw) : {};
      if (typeof spec !== 'string' || !spec.trim()) throw new Error('expected { spec }');
      const result = await ripBank({
        root: samplesDir,
        spec: spec.trim(),
        sounds: Array.isArray(sounds) ? sounds : [],
        onEvent: send,
      });
      send({ type: 'done', ...result });
    } catch (err) {
      send({ type: 'error', error: String(err?.message ?? err) });
    }
    res.end();
  };

  return {
    name: 'oat-permaload',
    configResolved(config) {
      samplesDir = path.isAbsolute(dir) ? dir : path.join(config.root, dir);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
```

In `vite.config.js`, import it and add it after `banksPlugin` — same `dir`, so both see one directory:

```js
import { permaloadPlugin } from './vite-permaload-plugin.js';
// …
    banksPlugin({ dir: 'samples' }),
    permaloadPlugin({ dir: 'samples' }),
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vite-permaload-plugin.js vite.config.js test/permaload.test.js
git commit -m "feat: add the /api/permaload rip endpoint"
```

---

### Task 6: Local-first `samples()`

The client half: know which banks are local, and swap a remote spec for the local manifest.

**Files:**
- Create: `src/sounds/permaload.js`
- Test: `test/permaload-client.test.js`

**Interfaces:**
- Consumes: `bankUrl` (Task 1); `GET /api/banks` with the `spec` field (Task 2).
- Produces:
  - `localBanks({ refresh }) → Promise<Bank[]>` — cached
  - `localManifestUrl(spec) → Promise<string|null>`
  - `localFirstSamples(samples) → (spec, ...rest) => Promise<any>`
  - `permaload(argString, onStatus) → Promise<void>` — the `:permaload` command

`matchBank` is split out as a pure function so the matching rule is testable without a server.

- [ ] **Step 1: Write the failing test**

```js
// test/permaload-client.test.js
// Which local bank, if any, a samples() spec refers to. The rule has to survive
// the two ways the same bank gets written — github:x/y and github:x/y/main —
// because a song is written by hand and a sidecar is written by the ripper.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchBank } from '../src/sounds/permaload.js';

const BANKS = [
  { name: 'dirt-samples', spec: 'github:tidalcycles/dirt-samples' },
  { name: 'piano', spec: 'https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json' },
  { name: 'my-kit' }, // hand-dropped, no sidecar
];

test('a spec matches the bank ripped from it', () => {
  assert.equal(matchBank(BANKS, 'github:tidalcycles/dirt-samples')?.name, 'dirt-samples');
});

test('the same bank written another way still matches', () => {
  assert.equal(matchBank(BANKS, 'github:tidalcycles/dirt-samples/main')?.name, 'dirt-samples');
});

test('a full url matches the bank ripped from it', () => {
  assert.equal(
    matchBank(BANKS, 'https://raw.githubusercontent.com/felixroos/dough-samples/main/piano.json')?.name,
    'piano',
  );
});

test('a bank nobody ripped never matches', () => {
  assert.equal(matchBank(BANKS, 'github:someone/else'), null);
});

test('a hand-dropped bank has no spec to match', () => {
  assert.equal(matchBank(BANKS, 'my-kit'), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/sounds/permaload.js'`

- [ ] **Step 3: Implement**

```js
// src/sounds/permaload.js
import { bankUrl } from './bank-url.js';

// `:permaload <spec> [sound …]` — rip a remote bank into ./samples, and make the
// samples() call a song already wrote resolve to it.
//
// The song file does not change. It keeps naming the bank the way it always
// did, which is what :peruse reads; only where the audio comes from changes.
// A bank nobody ripped behaves exactly as before, so this is invisible until
// you use it.

const BANKS_API = '/api/banks';
const PERMALOAD_API = '/api/permaload';

// Which local bank a spec refers to. Both sides resolve through bankUrl, so the
// spec a musician typed and the spec the ripper recorded don't have to match
// character for character — only bank for bank.
export function matchBank(banks, spec) {
  if (typeof spec !== 'string') return null;
  const wanted = bankUrl(spec);
  return banks.find((bank) => bank.spec && bankUrl(bank.spec) === wanted) ?? null;
}

// The listing is small and read on every samples() call, so it is fetched once.
// A static build has no /api/banks at all — an empty shelf, not an error.
let banksPromise = null;

export function localBanks({ refresh = false } = {}) {
  if (refresh || !banksPromise) {
    banksPromise = fetch(BANKS_API)
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => []);
  }
  return banksPromise;
}

export async function localManifestUrl(spec) {
  const bank = matchBank(await localBanks(), spec);
  return bank ? `${BANKS_API}/${encodeURIComponent(bank.name)}.json` : null;
}

// Wraps Strudel's samples(). An inline map has no spec to look up, and an
// explicit second argument is a base URL the caller means to keep — in both
// cases this must not interfere.
export function localFirstSamples(samples) {
  return async (spec, ...rest) => {
    if (typeof spec !== 'string' || rest.length > 0) return samples(spec, ...rest);
    return samples((await localManifestUrl(spec)) ?? spec);
  };
}

// --- the command ------------------------------------------------------------------

async function* ndjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export async function permaload(argString, onStatus) {
  const [spec, ...sounds] = String(argString ?? '').trim().split(/\s+/).filter(Boolean);
  if (!spec) {
    onStatus?.('usage: :permaload <spec> [sound …]', 'error');
    return;
  }

  let res;
  try {
    res = await fetch(PERMALOAD_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec, sounds }),
    });
  } catch (err) {
    onStatus?.('permaload: no dev server — ' + (err?.message ?? err), 'error');
    return;
  }
  if (!res.ok || !res.body) {
    onStatus?.(`permaload: ${res.status} ${res.statusText}`.trim(), 'error');
    return;
  }

  let total = 0;
  for await (const event of ndjson(res.body)) {
    if (event.type === 'start') {
      total = event.files;
      onStatus?.(`permaload: ${event.bank} — ${total} file${total === 1 ? '' : 's'}…`);
    } else if (event.type === 'progress') {
      onStatus?.(`permaload: ${event.done + event.skipped}/${total}…`);
    } else if (event.type === 'error') {
      onStatus?.('permaload: ' + event.error, 'error');
      return;
    } else if (event.type === 'done') {
      // The bank has to be visible to the next samples() call, not the next
      // reload — the whole point is to keep working without stopping.
      await localBanks({ refresh: true });
      const notes = [];
      if (event.skipped) notes.push(`${event.skipped} already had`);
      if (event.errors.length) notes.push(`${event.errors.length} failed`);
      if (event.errors.length) console.warn('permaload errors:', event.errors);
      onStatus?.(
        `permaload: ${event.bank} — ${event.downloaded} file${event.downloaded === 1 ? '' : 's'}, ` +
          mb(event.bytes) +
          (notes.length ? ` (${notes.join(', ')})` : ''),
        event.errors.length ? 'error' : '',
      );
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sounds/permaload.js test/permaload-client.test.js
git commit -m "feat: resolve samples() to a local bank when one exists"
```

---

### Task 7: Wire the command and the wrapper into the app

**Files:**
- Modify: `src/editor/editor.js` (near the `:peruse` and `:banks` definitions, ~line 221-227; and the `createEditor` parameter list at ~line 259), `src/main.js` (the `createEditor` call at ~line 200, the prebake at ~line 157, and the `.then((repl) => …)` at ~line 165)

**Interfaces:**
- Consumes: `localFirstSamples`, `permaload` (Task 6).
- Produces: the `:permaload` ex-command, and `globalThis.samples` wrapped for evaluated song code.

- [ ] **Step 1: Define the ex-command**

In `src/editor/editor.js`, below the `:peruse` definition:

```js
  // :permaload <spec> [sound …] — download a bank into ./samples, after which
  // the samples() call that names it loads from disk. Full name as the
  // ex-prefix, alongside :peruse: `:p` is stock vim's :print.
  Vim.defineEx('permaload', 'permaload', (cm, params) => handlers.onPermaload?.(params.argString));
```

Add `onPermaload` to the `createEditor({…})` parameter list and assign it with its neighbours:

```js
  handlers.onPermaload = onPermaload;
```

- [ ] **Step 2: Wire it in `src/main.js`**

Add the import:

```js
import { localFirstSamples, permaload } from './sounds/permaload.js';
```

Add to the `createEditor({…})` call:

```js
  onPermaload: (argString) => permaload(argString, setStatus),
```

- [ ] **Step 3: Install the wrapper**

Still in `src/main.js`, above `initStrudel`:

```js
// Every samples() call — the default banks below, and every one a song makes —
// goes through here, so a bank that has been permaloaded loads from ./samples
// without the song file changing a character.
const loadSamples = localFirstSamples(samples);
```

In `prebake`, replace the default-bank line:

```js
      ...DEFAULT_SAMPLE_BANKS.map((bank) => loadSamples(`${SAMPLE_BASE}/${bank}`)),
```

In the `.then((repl) => {…})` that follows `initStrudel`, before `setStatus('ready')`:

```js
    // @strudel/web installs its own samples() on globalThis for evaluated code;
    // replace it now that it exists, so song code gets the local-first one too.
    globalThis.samples = loadSamples;
```

- [ ] **Step 4: Check it loads**

Start the dev server with the preview tooling (`oatcycles-dev` in `.claude/launch.json`) and open `http://localhost:5173/?agent=1`. Read the console: no errors, status reaches `ready`.

Then, in the page:

```js
window.oat.agentMode;                       // true — the banner is up, output is muted
await fetch('/api/banks').then((r) => r.json());
```

- [ ] **Step 5: Commit**

```bash
git add src/editor/editor.js src/main.js
git commit -m "feat: add the :permaload command"
```

---

### Task 8: `:peruse` reads local banks

**Files:**
- Modify: `src/editor/peruse.js` (`loadBank`, ~line 148)

- [ ] **Step 1: Prefer the local manifest**

```js
import { localManifestUrl } from '../sounds/permaload.js';
```

```js
async function loadBank(call) {
  if (call.kind === 'inline') {
    return { label: 'inline map', sounds: call.sounds };
  }
  // A permaloaded bank is indexed from its local manifest — the same names in
  // the same order, and readable with no network at all.
  const url = (await localManifestUrl(call.spec)) ?? bankUrl(call.spec);
  try {
    return { label: call.spec, sounds: soundsFromJson(await fetchBank(url)) };
  } catch (err) {
    bankCache.delete(url);
    return { label: call.spec, sounds: [], error: err?.message ?? String(err) };
  }
}
```

The `label` stays the spec, so the generated variable name (`dirtSamples`) does not change when a bank becomes local.

- [ ] **Step 2: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/editor/peruse.js
git commit -m "feat: peruse a permaloaded bank from disk"
```

---

### Task 9: Verify against the running app

Every earlier task's tests stub the network. This is the one that proves a real bank plays.

Read `CLAUDE.md` before this task. Use `?agent=1`, drive with `window.oat`, never click Play.

- [ ] **Step 1: Rip a small bank**

`bd` alone is about two dozen files — enough to be real, small enough to throw away.

With the app open at `http://localhost:5173/?agent=1`, run in the page:

```js
await fetch('/api/permaload', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ spec: 'github:tidalcycles/dirt-samples', sounds: ['bd'] }),
}).then((r) => r.text());
```

Expected: NDJSON ending in a `done` line with `downloaded` > 0 and `errors: []`.

- [ ] **Step 2: Check what landed**

```bash
ls samples/dirt-samples/bd | head
cat samples/dirt-samples/.permaload.json | head -20
```

Expected: `.wav` files, and a sidecar naming every sound in the bank — not just `bd`.

- [ ] **Step 3: Confirm the manifest merges**

```js
const m = await fetch('/api/banks/dirt-samples.json').then((r) => r.json());
[m._base, Object.keys(m).length, m.bd.length, m.sd?.length];
```

Expected: `_base` is `/api/banks/dirt-samples/`, many sounds (not one), and `sd` present though it was never downloaded.

- [ ] **Step 4: Confirm a ripped sound is served from disk and an un-ripped one redirects**

```js
const local = await fetch(`/api/banks/dirt-samples/${m.bd[0]}`);
const remote = await fetch(`/api/banks/dirt-samples/${m.sd[0]}`);
[local.status, local.redirected, remote.status, remote.redirected, remote.url];
```

Expected: both `200`; the first not redirected, the second redirected to `raw.githubusercontent.com`.

- [ ] **Step 5: Confirm the spec resolves locally and plays**

```js
window.oat.silent;   // true — output is muted before anything is evaluated
await window.oat.silentPlay(`samples('github:tidalcycles/dirt-samples')\ns("bd*4")`);
```

Then check the network panel or:

```js
performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/banks/')).length;
```

Expected: non-zero — the audio came from `/api/banks/`, not from GitHub. No `eval error` in the status bar. Stop with `window.oat.stop()`.

- [ ] **Step 6: Confirm `:peruse` reads it locally**

In a scratch buffer containing only `samples('github:tidalcycles/dirt-samples')`, run `:peruse` and confirm the generated `const dirtSamples = […]` lists the whole bank.

Do this in a **new** song, not the user's current one — `:peruse` rewrites the buffer.

- [ ] **Step 7: Report and commit**

Run `git status` and say plainly what is now in `samples/` — the rip is real content in the user's repository, and roughly how large it is. Ask before committing the audio; the code is a separate matter:

```bash
git add docs/superpowers/specs/2026-07-26-permaload-design.md docs/superpowers/plans/2026-07-26-permaload.md
git commit -m "docs: permaload design and plan"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| Relationship to `:banks` (rip into its layout) | 5 |
| Command, arguments, resume | 4, 5, 7 |
| Storage layout and sidecar shape | 2 (read), 5 (write) |
| Merged manifest via the sidecar | 2 |
| Redirect for un-ripped paths | 3 |
| `/api/banks` gains `spec` and merged counts | 2 |
| Client resolution, `globalThis.samples` | 6, 7 |
| Shared spec resolver | 1 |
| Server, NDJSON progress, path safety | 4, 5 |
| `:peruse` reads local banks | 8 |
| Tests | in every task |

**Placeholders:** none — every step carries the code or the command it needs.

**Type consistency:** `manifest(bank, sounds, sidecar)` (Task 2) is called with three arguments by the manifest route (Task 2) and `listBanks` (Task 2). `readSidecar`, `flattenPaths`, `SIDECAR_NAME` and `resolveInside` are exported by `vite-banks-plugin.js` and imported by `vite-permaload-plugin.js` (Tasks 4, 5). `redirectTarget(sidecar, relPath)` (Task 3) is used only inside the banks plugin. `ripBank` returns `{bank, downloaded, skipped, bytes, errors}` (Task 5), which is exactly what the client's `done` branch reads (Task 6). `localFirstSamples(samples)` takes Strudel's `samples` and returns a replacement (Task 6), which is how `main.js` uses it (Task 7).

**One known coupling:** Tasks 2 and 3 edit `vite-banks-plugin.js` and `test/banks-plugin.test.js`, which a parallel session was writing. Re-read both files before starting either task.
