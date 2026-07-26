// Client half of `:writeout` — POST the buffer to the dev server, which does
// the actual path resolution and file write (see vite-writeout-plugin.js).
//
// Separate from storage.js on purpose: that module owns the song *store* (the
// full-list reconcile against ./songs). This is a one-shot copy to a path the
// user named, and it never touches the song list or the localStorage mirror.

const API = '/api/writeout';

// Write `code` to `path`, returning the absolute path the server wrote to.
// `name` is the current song name, used when `path` names a directory.
export async function writeOut({ path, code, name }) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, code, name }),
    });
  } catch {
    throw new Error('no server — :writeout needs the dev/preview server');
  }
  // A static prod build has no API mounted, so this request falls through to
  // index.html: a 200 that isn't JSON. Treat it as "no server", not success.
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('no server — :writeout needs the dev/preview server');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.path;
}
