import { promises as fs } from 'node:fs';
import path from 'node:path';

// The sample banks sitting on this machine, for `:banks`.
//
// `:peruse` can only index the banks a file already names. A folder of samples
// in ./samples is invisible until you remember it exists and type the
// samples() call by hand. This plugin makes the directory browsable: it scans
// ./samples, and serves each bank as the manifest Strudel's own samples()
// reads — so a bank the panel lists is a bank that actually plays, not a
// listing that lies about what will load.
//
// A bank is an immediate subdirectory of ./samples. Two layouts, and one bank
// may use both at once:
//
//   samples/casio/bd/01.wav   → sound "bd", variant 0    → s("bd").n(0)
//   samples/casio/hh.wav      → sound "hh", one variant  → s("hh")
//
// Two levels only. Anything deeper is ignored rather than flattened, because a
// flattened name has no relationship to the path you'd type.
//
// API:
//   GET /api/banks              → [{ name, sounds, samples }], alphabetical
//   GET /api/banks/<bank>.json  → { _base, <sound>: [path, …] } — strudel.json
//   GET /api/banks/<bank>/<p>   → that audio file
//
// The `.json` suffix on the manifest route is load-bearing. :peruse names its
// generated const after the last path segment (bankIdentifier() in
// src/editor/peruse.js), so /api/banks/casio.json gives `const casio = […]`
// where /api/banks/casio/strudel.json would give `const strudel = […]` for
// every bank in the folder.

const BANKS_API = '/api/banks';

const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.ogg',
  '.flac',
  '.m4a',
  '.aif',
  '.aiff',
  '.webm',
]);

// Content types for the audio route. Vite's static middleware never sees these
// files — they're served from ./samples, which is not part of the module graph.
const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.webm': 'audio/webm',
};

const isAudio = (name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());

// Anything starting with a dot is the filesystem's business, not a sound:
// .DS_Store next to the wavs would otherwise show up as a sample.
const isHidden = (name) => name.startsWith('.');

async function readEntries(dir) {
  return fs.readdir(dir, { withFileTypes: true });
}

// --- scanning -----------------------------------------------------------------

// One bank → its sounds, each with the sample paths that belong to it, both
// relative to the bank directory. Sounds and their variants are sorted by name,
// so `01.wav 02.wav` index in the order they read on disk.
async function scanBank(bankDir) {
  const entries = await readEntries(bankDir);
  const sounds = new Map();

  const add = (name, file) => {
    if (!sounds.has(name)) sounds.set(name, []);
    sounds.get(name).push(file);
  };

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isHidden(entry.name)) continue;

    if (entry.isDirectory()) {
      const files = (await readEntries(path.join(bankDir, entry.name)))
        .filter((f) => f.isFile() && !isHidden(f.name) && isAudio(f.name))
        .map((f) => f.name)
        .sort((a, b) => a.localeCompare(b));
      for (const file of files) add(entry.name, `${entry.name}/${file}`);
    } else if (entry.isFile() && isAudio(entry.name)) {
      add(entry.name.slice(0, -path.extname(entry.name).length), entry.name);
    }
  }

  return [...sounds.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Every bank in ./samples, with the counts the panel shows. A bank with no
// audio in it still lists — seeing "0 sounds" is how you find out the folder
// you just dropped in holds aiffs we don't read, or is one level too deep.
async function listBanks(root) {
  let entries;
  try {
    entries = await readEntries(root);
  } catch {
    return []; // no samples/ yet — an empty shelf, not an error
  }

  const banks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isHidden(entry.name)) continue;
    const sounds = await scanBank(path.join(root, entry.name));
    banks.push({
      name: entry.name,
      sounds: sounds.length,
      samples: sounds.reduce((sum, sound) => sum + sound.files.length, 0),
    });
  }
  return banks.sort((a, b) => a.name.localeCompare(b.name));
}

// --- serving -------------------------------------------------------------------

// The strudel.json shape: a flat map of sound name → sample paths, with `_base`
// prefixed to every one of them at load time. Each path segment is encoded
// separately, so a bank called "my kit" or a file called "take #2.wav" survives
// the fetch with its slashes intact.
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function manifest(bank, sounds) {
  const json = { _base: `${BANKS_API}/${encodeURIComponent(bank)}/` };
  for (const sound of sounds) json[sound.name] = sound.files.map(encodePath);
  return json;
}

// Resolve a requested path against a bank directory, refusing anything that
// climbs out of it. Same containment the songs plugin applies to snapshot
// filenames — a request must not be able to walk the disk.
export function resolveInside(baseDir, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null; // malformed percent-escape
  }
  if (!decoded || decoded.includes('\0')) return null;
  const base = path.resolve(baseDir);
  const full = path.resolve(base, decoded);
  return full.startsWith(base + path.sep) ? full : null;
}

// A bank name comes off the URL and becomes a directory name, so it may not
// carry separators or climb. Names that fail this can't exist on disk either,
// so rejecting them costs nothing real.
function safeBankName(raw) {
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!name || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  if (isHidden(name)) return null;
  return name;
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

// Vite plugin: mounts on the dev server and on `vite preview`, like the songs
// plugin. A static production build has no server here, so the panel reports
// that local banks are unavailable rather than showing an empty shelf.
export function banksPlugin({ dir = 'samples' } = {}) {
  let samplesDir = dir;

  const middleware = async (req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== BANKS_API && !pathname.startsWith(`${BANKS_API}/`)) return next();

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }

    try {
      if (pathname === BANKS_API) {
        return sendJson(res, 200, await listBanks(samplesDir));
      }

      const rest = pathname.slice(BANKS_API.length + 1);
      const slash = rest.indexOf('/');

      // /api/banks/<bank>.json — the manifest.
      if (slash === -1) {
        if (!rest.endsWith('.json')) return sendJson(res, 404, { error: 'no such bank' });
        const bank = safeBankName(rest.slice(0, -'.json'.length));
        if (!bank) return sendJson(res, 404, { error: 'no such bank' });
        let sounds;
        try {
          sounds = await scanBank(path.join(samplesDir, bank));
        } catch {
          return sendJson(res, 404, { error: 'no such bank' });
        }
        return sendJson(res, 200, manifest(bank, sounds));
      }

      // /api/banks/<bank>/<path> — one sample.
      const bank = safeBankName(rest.slice(0, slash));
      const file = bank && resolveInside(path.join(samplesDir, bank), rest.slice(slash + 1));
      if (!file) return sendJson(res, 404, { error: 'no such sample' });
      if (!isAudio(file)) return sendJson(res, 404, { error: 'no such sample' });

      let body;
      try {
        body = await fs.readFile(file);
      } catch {
        return sendJson(res, 404, { error: 'no such sample' });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'audio/wav');
      res.setHeader('Content-Length', body.length);
      // Samples are fetched once per sound and never change under us mid-play.
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  };

  return {
    name: 'oat-banks-fs',
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

// Exported for tests.
export const __internals = { scanBank, listBanks };
