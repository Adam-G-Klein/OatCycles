// Route the engine's internet fetches through the dev server's disk cache.
//
// Sample manifests, sample audio, wavetables and GM soundfonts are all loaded
// with plain fetch() deep inside @strudel/web and @strudel/soundfonts, from a
// handful of hosts. Rather than patch each loader, this wraps fetch once:
// a request for one of those hosts goes to /api/cache/<host>/<path> instead,
// which answers from ./offline-cache (and fills it while online). See
// vite-offline-plugin.js.
//
// Loaded as its own <script> ahead of main.js (the plugin injects it), so the
// wrapper is in place before the engine's first request. Keep this list in
// step with CACHED_HOSTS in offline-cache.js.
const CACHED_HOSTS = [
  'raw.githubusercontent.com',
  'felixroos.github.io',
  'shabda.ndre.gr',
  'strudel.b-cdn.net',
];

const nativeFetch = window.fetch.bind(window);

export function toCacheUrl(url) {
  let u;
  try {
    u = new URL(url, location.href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !CACHED_HOSTS.includes(u.host)) return null;
  return `/api/cache/${u.host}${u.pathname}${u.search}`;
}

window.fetch = function fetchThroughCache(input, init) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  const cached = url && toCacheUrl(url);
  if (!cached) return nativeFetch(input, init);
  // A Request object carries its own method/headers; only GETs are cacheable,
  // and nothing in the engine sends anything else to these hosts.
  return nativeFetch(cached, input instanceof Request ? { method: input.method, signal: input.signal, ...init } : init);
};
