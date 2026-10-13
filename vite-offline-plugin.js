import { promises as fs, createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CACHE_API, CACHED_HOSTS, cacheFile, ensureCached, mimeFor } from './offline-cache.js';

// Offline mode: everything the app would fetch from the internet, served from
// disk. See offline-cache.js for the cache itself and OFFLINE.md for the
// pre-flight routine.
//
// Three pieces:
//
//   GET /api/cache/<host>/<path>  → that URL, from ./offline-cache, fetched
//                                   and kept on a miss. 504 when it isn't
//                                   cached and the network is gone.
//   GET /api/offline              → { docsUrl } for :learn, plus cache counts.
//   http://localhost:5180/        → the mirrored strudel.cc docs
//                                   (./offline-docs/strudel.cc), on a port of
//                                   their own because every link on that site
//                                   is root-absolute (/learn/…, /_astro/…).
//
// The browser half is src/offline/fetch-cache.js, injected ahead of main.js so
// it wraps fetch() before the engine's first manifest request.

const DOCS_PORT = Number(process.env.OAT_DOCS_PORT) || 5180;

const DOCS_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

async function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return { files, bytes };
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes('.part-')) continue;
    files += 1;
    bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

// A plain static server over the docs mirror. /learn/samples/ → learn/samples/index.html.
function startDocsServer(docsRoot, log) {
  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.statusCode = 400;
      return res.end('bad request');
    }
    const base = path.resolve(docsRoot);
    let file = path.resolve(base, '.' + pathname);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    try {
      if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
      await fs.access(file);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        `<p>Not in the offline docs mirror: <code>${pathname.replace(/[<&]/g, '')}</code></p>` +
          '<p><a href="/offline-index.html">Search the offline docs</a></p>',
      );
    }
    res.setHeader('Content-Type', DOCS_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  server.on('error', (err) => {
    // Another dev server (a second `oat`, the preview harness) already has
    // the port — that one is serving the same mirror, so this is fine.
    if (err.code === 'EADDRINUSE') log(`docs port ${DOCS_PORT} already in use — assuming another instance serves it`);
    else log(`docs server failed: ${err.message}`);
  });
  server.listen(DOCS_PORT, '127.0.0.1');
  return server;
}

export function offlinePlugin({ cacheDir = 'offline-cache', docsDir = 'offline-docs/strudel.cc' } = {}) {
  let cacheRoot = cacheDir;
  let docsRoot = docsDir;
  let docsServer = null;

  const middleware = async (req, res, next) => {
    const [pathname, query = ''] = (req.url || '').split(/\?(.*)/s);

    if (pathname === '/api/offline') {
      let docs = false;
      try {
        await fs.access(path.join(docsRoot, 'offline-index.html'));
        docs = true;
      } catch {
        // no mirror yet — :learn says to run `npm run offline:docs`
      }
      return sendJson(res, 200, {
        docsUrl: docs ? `http://localhost:${DOCS_PORT}` : null,
        cache: await countFiles(cacheRoot),
        hosts: CACHED_HOSTS,
      });
    }

    if (!pathname.startsWith(`${CACHE_API}/`)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }

    const rest = pathname.slice(CACHE_API.length + 1);
    const slash = rest.indexOf('/');
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const upstreamPath = slash === -1 ? '/' : rest.slice(slash);
    const search = query ? `?${query}` : '';
    if (!cacheFile(cacheRoot, host, upstreamPath, search)) {
      return sendJson(res, 404, { error: 'not a cacheable URL' });
    }

    try {
      const { file } = await ensureCached(cacheRoot, `https://${host}${upstreamPath}${search}`);
      const { size } = await fs.stat(file);
      res.statusCode = 200;
      res.setHeader('Content-Type', mimeFor(file));
      res.setHeader('Content-Length', size);
      // Let the browser keep it too: a cached URL's content never changes
      // under us, and the engine refetches manifests on every reload.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (err) {
      sendJson(res, err.status ?? 500, { error: String(err?.message ?? err) });
    }
  };

  return {
    name: 'oat-offline',
    configResolved(config) {
      cacheRoot = path.isAbsolute(cacheDir) ? cacheDir : path.join(config.root, cacheDir);
      docsRoot = path.isAbsolute(docsDir) ? docsDir : path.join(config.root, docsDir);
    },
    // Ahead of main.js, so fetch is wrapped before the engine boots. Module
    // scripts run in document order, and this one is prepended to <head>.
    transformIndexHtml: () => [
      { tag: 'script', attrs: { type: 'module', src: '/src/offline/fetch-cache.js' }, injectTo: 'head-prepend' },
    ],
    configureServer(server) {
      server.middlewares.use(middleware);
      docsServer = startDocsServer(docsRoot, (msg) => server.config.logger.warn(`[offline] ${msg}`));
      server.httpServer?.on('close', () => docsServer?.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      docsServer = startDocsServer(docsRoot, (msg) => server.config.logger.warn(`[offline] ${msg}`));
      server.httpServer?.on('close', () => docsServer?.close());
    },
  };
}
