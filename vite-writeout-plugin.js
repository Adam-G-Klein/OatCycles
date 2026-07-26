import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `:writeout [path]` — dump the current buffer to an arbitrary file on disk.
//
// The songs API (vite-songs-plugin.js) owns ./songs and reconciles the whole
// directory to the app's song list; it is a *store*, not a way to put a copy
// somewhere else. This is the "somewhere else": a one-shot write to a path the
// user names, for redundancy — a git repo, a Dropbox folder, a USB stick.
//
// API:
//   POST /api/writeout   { path, code, name } → { path: <absolute path written> }
//
// Path handling (all done here, where the filesystem actually is):
//   ~/…            expands to the home directory
//   relative       resolves against the Vite project root
//   a directory    (existing, or a trailing slash) → writes <name>.js inside it
//   no extension   → .js is appended
//   missing dirs   are created; an existing file is overwritten (repeat backups
//                  to the same path are the normal case)
//
// This deliberately writes anywhere the dev-server process can. That's the
// feature, and it's the same trust level as the terminal the server was started
// from — but it does mean this endpoint must stay on the dev/preview server
// (localhost by default) and never be exposed to a network.

const API_PATH = '/api/writeout';

// Turn a song name into a filename, matching the songs plugin's sanitiser so a
// writeout of "my song" lands next to what ./songs would have called it.
function safeFilename(name) {
  const base = String(name || '')
    .trim()
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'untitled'}.js`;
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveTarget(root, raw, name) {
  let p = String(raw || '').trim();
  if (!p) throw new Error('no path given');

  // ~ / ~/… → home. (A literal ~ elsewhere in the path is left alone.)
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));

  // A trailing slash means "into this directory" even if it doesn't exist yet.
  const explicitDir = /[\\/]$/.test(p);
  let target = path.resolve(root, p);

  if (explicitDir || (await isDirectory(target))) {
    target = path.join(target, safeFilename(name));
  } else if (!path.extname(target)) {
    target += '.js';
  }
  return target;
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
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function writeoutPlugin() {
  let root = process.cwd();

  const middleware = async (req, res, next) => {
    if (!req.url || !req.url.split('?')[0].startsWith(API_PATH)) return next();
    if (req.method !== 'POST' && req.method !== 'PUT') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (typeof body.code !== 'string') {
        return sendJson(res, 400, { error: 'expected { path, code }' });
      }
      const target = await resolveTarget(root, body.path, body.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body.code, 'utf8');
      sendJson(res, 200, { path: target });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  };

  return {
    name: 'oat-writeout-fs',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
