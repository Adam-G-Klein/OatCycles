import { promises as fs } from 'node:fs';
import path from 'node:path';

// A disk copy of everything the app pulls off the internet, so it plays on a
// plane.
//
// The engine fetches four kinds of thing from other hosts: sample manifests
// and the audio they list (raw.githubusercontent.com — the default banks, and
// any `github:` bank typed into a song), General MIDI soundfonts
// (felixroos.github.io), Shabda's on-demand banks, and Strudel's own CDN.
// Every one of those fetches is rerouted through the dev server (see
// src/offline/fetch-cache.js), which answers from ./offline-cache when it has
// the file and otherwise fetches it upstream and keeps a copy. So anything you
// have heard once while online plays again offline, and
// `npm run offline` fills the cache ahead of time with the rest.
//
// Layout mirrors the URL, so the cache is browsable and greppable:
//
//   https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/a.wav
//   → offline-cache/raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/a.wav
//
// A query string (Shabda uses them) becomes part of the filename, after an `@`.

// Hosts the cache will fetch from. Anything else is not proxied: the dev
// server must not turn into an open relay to arbitrary URLs.
export const CACHED_HOSTS = [
  'raw.githubusercontent.com',
  'felixroos.github.io',
  'shabda.ndre.gr',
  'strudel.b-cdn.net',
];

export const CACHE_API = '/api/cache';

// Upstream gets this long before a miss is reported as offline. Generous,
// because a cold soundfont is a few MB over hotel wifi.
const UPSTREAM_TIMEOUT_MS = 30_000;

export const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.webm': 'audio/webm',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.txt': 'text/plain',
};

// `https://host/a/b%20c.wav?x=1` → { host, pathname: '/a/b%20c.wav', search: '?x=1' },
// or null for a URL the cache doesn't serve.
export function parseCacheable(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !CACHED_HOSTS.includes(u.host)) return null;
  return { host: u.host, pathname: u.pathname, search: u.search };
}

// Where a URL lives on disk, or null if the path would climb out of the
// host's directory. Each segment is decoded, so `take%20%232.wav` is stored
// as `take #2.wav` — the name you'd see in the repo.
export function cacheFile(cacheDir, host, pathname, search = '') {
  if (!CACHED_HOSTS.includes(host)) return null;
  let segments;
  try {
    segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // malformed percent-escape
  }
  if (!segments.length) return null;
  if (segments.some((s) => s === '.' || s === '..' || s.includes('\0') || s.includes('\\'))) {
    return null;
  }
  if (search) segments[segments.length - 1] += '@' + encodeURIComponent(search.slice(1));
  const base = path.resolve(cacheDir, host);
  const full = path.resolve(base, ...segments);
  return full.startsWith(base + path.sep) ? full : null;
}

// The type to serve a cached file as. The query suffix is ignored, so a
// Shabda `foo.json@strudel%3D1` still goes out as JSON.
export function mimeFor(file) {
  const name = path.basename(file).split('@')[0];
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// Concurrent requests for the same missing file share one upstream fetch —
// a pattern triggers the same sample on every beat of its first cycle.
const inFlight = new Map();

// Ensure `url` is on disk. Resolves to { file, fromCache }, or rejects with an
// error carrying `.status` (the upstream status, or 504 when unreachable).
export function ensureCached(cacheDir, url) {
  const parsed = parseCacheable(url);
  if (!parsed) return Promise.reject(Object.assign(new Error(`not cacheable: ${url}`), { status: 400 }));
  const file = cacheFile(cacheDir, parsed.host, parsed.pathname, parsed.search);
  if (!file) return Promise.reject(Object.assign(new Error(`bad path: ${url}`), { status: 400 }));

  if (inFlight.has(file)) return inFlight.get(file);
  const job = (async () => {
    try {
      await fs.access(file);
      return { file, fromCache: true };
    } catch {
      // not cached yet — fall through to the network
    }

    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      throw Object.assign(new Error(`offline and not cached: ${url} (${err?.cause?.code ?? err.message})`), {
        status: 504,
      });
    }
    if (!res.ok) throw Object.assign(new Error(`upstream ${res.status}: ${url}`), { status: res.status });

    const body = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename, so a download cut off mid-flight (plane door closing)
    // never leaves a truncated sample that reads as cached.
    const tmp = `${file}.part-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
    return { file, fromCache: false, bytes: body.length };
  })().finally(() => inFlight.delete(file));

  inFlight.set(file, job);
  return job;
}
