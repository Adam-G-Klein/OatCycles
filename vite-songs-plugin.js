import { promises as fs } from 'node:fs';
import path from 'node:path';

// Disk-backed song storage for the dev/preview server.
//
// The song panel used to live only in localStorage, so clearing the browser
// (or a cache eviction) silently wiped every saved song. This plugin gives the
// app a tiny REST API that mirrors songs to real text files on disk, so they
// survive across browser sessions and can be edited/backed-up outside the app.
//
// There are two stores, and the whole point of the split is that one can never
// damage the other:
//
//   SavedSongs/<name>.js   → one text file per song, holding exactly the code.
//   SavedSongs/index.json  → manifest: [{ id, name, file, savedAt }]
//                            Written only when the user explicitly saves,
//                            renames or deletes a song.
//   AutoSaves/<name>_auto_<date>_<time>.js
//                          → append-only snapshots taken on every play. Never
//                            overwrite a saved song; never overwrite each
//                            other. No manifest: the song name and timestamp
//                            both live in the filename, so snapshots can be
//                            deleted by hand without corrupting any state.
//
// API:
//   GET  /api/songs           → [{ id, name, code, savedAt }]
//   PUT  /api/songs           → body is the full [{ id, name, code, savedAt }]
//                               array; the SavedSongs dir is reconciled to it.
//   POST /api/autosave        → body { name, code }; writes one snapshot,
//                               skipping it when the newest snapshot for that
//                               name is byte-identical, then prunes to `keep`.
//   GET  /api/autosaves       → [{ file, name, savedAt }], newest first
//   GET  /api/autosaves/<file> → that snapshot's code (text/plain)

const SONGS_API = '/api/songs';
const AUTOSAVE_API = '/api/autosave';
const AUTOSAVES_API = '/api/autosaves';
const INDEX_FILE = 'index.json';
const AUTO_MARK = '_auto_';

// Keep letters, numbers, dot, dash, underscore and spaces; everything else
// collapses to an underscore so arbitrary song names map to valid filenames.
export function safeBase(name) {
  const base = String(name || '')
    .trim()
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return base || 'untitled';
}

function safeFilename(name, used) {
  const base = safeBase(name);
  // Disambiguate collisions within a single sync batch (e.g. two songs named
  // "untitled") by appending -2, -3, … so every song keeps its own file.
  let candidate = `${base}.js`;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${n}.js`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// Local time, not UTC: the timestamp is there for a human scanning the list for
// "the one from just before lunch", and that reading is in their own clock.
export function stamp(when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}` +
    `_${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  );
}

export function autosaveFilename(name, when = new Date()) {
  return `${safeBase(name)}${AUTO_MARK}${stamp(when)}.js`;
}

// Recover { name, savedAt } from a snapshot filename. Returns null for anything
// that isn't one of ours, so a stray file in the directory is ignored rather
// than surfaced as a broken row. Split on the *last* marker so a song actually
// named "foo_auto_bar" still parses to that name.
export function parseAutosaveFilename(file) {
  if (!file.endsWith('.js')) return null;
  const body = file.slice(0, -3);
  const at = body.lastIndexOf(AUTO_MARK);
  if (at <= 0) return null;
  const name = body.slice(0, at);
  const rest = body.slice(at + AUTO_MARK.length);
  const m = rest.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:-\d+)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const when = new Date(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(when.getTime())) return null;
  return { file, name, savedAt: when.getTime() };
}

// Which snapshots of one song to delete so only the newest `keep` survive.
// Ties on the timestamp fall back to the filename so the choice is stable.
export function selectPrunable(entries, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const sorted = [...entries].sort(
    (a, b) => b.savedAt - a.savedAt || b.file.localeCompare(a.file),
  );
  return sorted.slice(keep);
}

async function readIndex(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, INDEX_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// GET → assemble the full song records by pairing the manifest with the code
// held in each song's text file.
async function readSongs(dir) {
  const index = await readIndex(dir);
  const songs = [];
  for (const entry of index) {
    if (!entry || !entry.file) continue;
    let code = '';
    try {
      code = await fs.readFile(path.join(dir, entry.file), 'utf8');
    } catch {
      // File went missing out from under us; surface the song with empty code
      // rather than dropping it, so its manifest entry can be re-saved.
      code = '';
    }
    songs.push({
      id: entry.id,
      name: entry.name,
      code,
      savedAt: entry.savedAt || entry.updatedAt || 0,
    });
  }
  return songs;
}

// PUT → reconcile the whole SavedSongs dir to the posted array: write a text
// file per song, refresh the manifest, and delete files for songs that are
// gone. The client posts only songs the user has explicitly saved, so a song
// that has never been saved never reaches this function.
async function writeSongs(dir, songs) {
  await fs.mkdir(dir, { recursive: true });
  const oldIndex = await readIndex(dir);

  const used = new Set();
  const index = songs.map((song) => {
    const file = safeFilename(song.name, used);
    return {
      id: song.id,
      name: song.name,
      file,
      savedAt: song.savedAt || Date.now(),
      code: song.code ?? '',
    };
  });

  // Remove files backing songs that no longer exist (deletes + renames leave
  // the old file behind otherwise). Only touch files we previously managed.
  const keep = new Set(index.map((e) => e.file));
  await Promise.all(
    oldIndex
      .filter((e) => e && e.file && !keep.has(e.file))
      .map((e) => fs.rm(path.join(dir, e.file), { force: true })),
  );

  await Promise.all(index.map((e) => fs.writeFile(path.join(dir, e.file), e.code, 'utf8')));

  const manifest = index.map(({ code, ...meta }) => meta);
  await fs.writeFile(
    path.join(dir, INDEX_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );

  return manifest;
}

// Every snapshot on disk, newest first.
async function readAutosaves(dir) {
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return []; // nothing autosaved yet
  }
  return files
    .map(parseAutosaveFilename)
    .filter(Boolean)
    .sort((a, b) => b.savedAt - a.savedAt || b.file.localeCompare(a.file));
}

// POST → take one snapshot of `name`'s buffer.
//
// Two guards keep the directory from filling with noise: a snapshot identical
// to the newest one for that song is skipped outright (holding play down on an
// unchanged buffer costs nothing), and each song is pruned back to its newest
// `keep` snapshots afterwards.
async function writeAutosave(dir, { name, code, keep }, when = new Date()) {
  const entries = await readAutosaves(dir);
  const base = safeBase(name);
  const mine = entries.filter((e) => e.name === base);

  if (mine.length > 0) {
    try {
      const newest = await fs.readFile(path.join(dir, mine[0].file), 'utf8');
      if (newest === code) return { file: mine[0].file, savedAt: mine[0].savedAt, skipped: true };
    } catch {
      // Snapshot vanished from under us — fall through and write a fresh one.
    }
  }

  await fs.mkdir(dir, { recursive: true });

  // Two different buffers inside the same second would land on one filename.
  // Rare, but it would silently lose the earlier one, so step aside instead.
  let file = autosaveFilename(base, when);
  for (let n = 2; ; n += 1) {
    try {
      await fs.writeFile(path.join(dir, file), code, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      file = `${safeBase(base)}${AUTO_MARK}${stamp(when)}-${n}.js`;
    }
  }

  const written = parseAutosaveFilename(file);
  await Promise.all(
    selectPrunable([...mine, written], keep).map((e) =>
      fs.rm(path.join(dir, e.file), { force: true }),
    ),
  );

  return { file, savedAt: written.savedAt, skipped: false };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

// Vite plugin: mounts the middleware on both the dev server and the `vite
// preview` server so persistence works in either mode. Production static builds
// have no server here — the app falls back to localStorage there.
export function songsPlugin({ dir = 'SavedSongs', autoDir = 'AutoSaves', keep = 30 } = {}) {
  let songsDir = dir;
  let autosaveDir = autoDir;

  const middleware = async (req, res, next) => {
    const url = req.url || '';
    const pathname = url.split('?')[0];
    if (!pathname.startsWith('/api/')) return next();

    try {
      if (pathname === SONGS_API) {
        if (req.method === 'GET') return sendJson(res, 200, await readSongs(songsDir));
        if (req.method === 'PUT' || req.method === 'POST') {
          const raw = await readBody(req);
          const parsed = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(parsed)) return sendJson(res, 400, { error: 'expected an array' });
          return sendJson(res, 200, await writeSongs(songsDir, parsed));
        }
        res.statusCode = 405;
        return res.end('Method Not Allowed');
      }

      if (pathname === AUTOSAVE_API) {
        if (req.method !== 'POST' && req.method !== 'PUT') {
          res.statusCode = 405;
          return res.end('Method Not Allowed');
        }
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : null;
        if (!body || typeof body.code !== 'string') {
          return sendJson(res, 400, { error: 'expected { name, code }' });
        }
        return sendJson(
          res,
          200,
          await writeAutosave(autosaveDir, { name: body.name, code: body.code, keep }),
        );
      }

      if (pathname === AUTOSAVES_API) {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end('Method Not Allowed');
        }
        return sendJson(res, 200, await readAutosaves(autosaveDir));
      }

      if (pathname.startsWith(`${AUTOSAVES_API}/`)) {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end('Method Not Allowed');
        }
        // Take only the basename and re-validate it as one of our filenames, so
        // the request can't walk out of the snapshot directory.
        const file = path.basename(decodeURIComponent(pathname.slice(AUTOSAVES_API.length + 1)));
        if (!parseAutosaveFilename(file)) return sendJson(res, 404, { error: 'no such snapshot' });
        try {
          const code = await fs.readFile(path.join(autosaveDir, file), 'utf8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(code);
        } catch {
          return sendJson(res, 404, { error: 'no such snapshot' });
        }
      }

      return next();
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  };

  return {
    name: 'oat-songs-fs',
    configResolved(config) {
      // Resolve both dirs relative to the project root once it's known.
      songsDir = path.isAbsolute(dir) ? dir : path.join(config.root, dir);
      autosaveDir = path.isAbsolute(autoDir) ? autoDir : path.join(config.root, autoDir);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// Exported for tests.
export const __internals = { readSongs, writeSongs, readAutosaves, writeAutosave };
