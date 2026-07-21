import { promises as fs } from 'node:fs';
import path from 'node:path';

// Disk-backed song storage for the dev/preview server.
//
// The song panel used to live only in localStorage, so clearing the browser
// (or a cache eviction) silently wiped every saved song. This plugin gives the
// app a tiny REST API that mirrors songs to real text files on disk, so they
// survive across browser sessions and can be edited/backed-up outside the app.
//
// On-disk layout (default: ./songs):
//   songs/<name>.js     → one text file per song, holding exactly the code
//   songs/index.json    → manifest: [{ id, name, file, updatedAt }]
//
// The code lives in plain .js files (human-readable, git-friendly); the
// manifest holds the metadata the panel needs (stable id, display name, the
// file it maps to, and the last-modified timestamp).
//
// API:
//   GET /api/songs        → [{ id, name, code, updatedAt }]
//   PUT /api/songs        → body is the full [{ id, name, code, updatedAt }]
//                           array; the whole songs dir is reconciled to match.

const API_PATH = '/api/songs';
const INDEX_FILE = 'index.json';

function safeFilename(name, used) {
  // Keep letters, numbers, dot, dash, underscore and spaces; everything else
  // collapses to an underscore so arbitrary song names map to valid filenames.
  let base = String(name || '')
    .trim()
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'untitled';
  let candidate = `${base}.js`;
  // Disambiguate collisions within a single sync batch (e.g. two songs named
  // "untitled") by appending -2, -3, … so every song keeps its own file.
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${n}.js`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
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
      updatedAt: entry.updatedAt || 0,
    });
  }
  return songs;
}

// PUT → reconcile the whole songs dir to the posted array: write a text file
// per song, refresh the manifest, and delete files for songs that are gone.
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
      updatedAt: song.updatedAt || Date.now(),
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

// Vite plugin: mounts the /api/songs middleware on both the dev server and the
// `vite preview` server so persistence works in either mode. Production static
// builds have no server here — the app falls back to localStorage there.
export function songsPlugin({ dir = 'songs' } = {}) {
  let songsDir = dir;

  const middleware = async (req, res, next) => {
    if (!req.url || !req.url.split('?')[0].startsWith(API_PATH)) return next();
    try {
      if (req.method === 'GET') {
        return sendJson(res, 200, await readSongs(songsDir));
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return sendJson(res, 400, { error: 'expected an array' });
        return sendJson(res, 200, await writeSongs(songsDir, parsed));
      }
      res.statusCode = 405;
      res.end('Method Not Allowed');
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  };

  return {
    name: 'oat-songs-fs',
    configResolved(config) {
      // Resolve the songs dir relative to the project root once known.
      songsDir = path.isAbsolute(dir) ? dir : path.join(config.root, dir);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
