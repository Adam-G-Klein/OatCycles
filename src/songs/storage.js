// Song persistence: disk-first, with localStorage as a fast cache + offline
// fallback.
//
// The durable store is the dev/preview server's /api/songs endpoint, which
// writes one text file per song under ./songs (see vite-songs-plugin.js).
// localStorage still holds a mirror so the app boots instantly and keeps
// working when no server is present (a plain production `vite build`).
//
// Load order on a fresh browser session:
//   1. Ask the server for the on-disk songs (the source of truth).
//   2. If the server is unreachable (prod build), use the localStorage mirror.
//   3. If the server is reachable but empty AND localStorage has songs, push
//      those up — a one-time migration for anyone with pre-existing local songs.

const SONGS_KEY = 'oat.songs';
const CURRENT_KEY = 'oat.currentSongId';
const API = '/api/songs';

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(SONGS_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveLocal(songs) {
  localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
}

async function fetchDisk() {
  try {
    const res = await fetch(API, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null; // no API mounted (e.g. static prod build)
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return null; // got index.html, not our API
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function putDisk(songs) {
  const res = await fetch(API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(songs),
  });
  if (!res.ok) throw new Error(`save failed: HTTP ${res.status}`);
}

export function getCurrentId() {
  return localStorage.getItem(CURRENT_KEY);
}

export function setCurrentId(id) {
  if (id == null) localStorage.removeItem(CURRENT_KEY);
  else localStorage.setItem(CURRENT_KEY, id);
}

// Resolve the initial song set for this session. Returns { songs, onDisk }
// where onDisk indicates the durable disk store is available (so future saves
// should be written through to it).
export async function loadSongs() {
  const local = loadLocal();
  const disk = await fetchDisk();

  if (disk === null) {
    // No server — localStorage is all we have this session.
    return { songs: local, onDisk: false };
  }
  if (disk.length > 0) {
    saveLocal(disk); // refresh the mirror from the source of truth
    return { songs: disk, onDisk: true };
  }
  // Server reachable but empty: migrate any existing local songs to disk once.
  if (local.length > 0) {
    try {
      await putDisk(local);
    } catch {
      /* keep going with local; a later save will retry */
    }
    return { songs: local, onDisk: true };
  }
  return { songs: [], onDisk: true };
}

// Build a saver bound to this session. localStorage is written synchronously on
// every call (never lose the in-memory state); the disk write is debounced so a
// burst of edits collapses into a single request.
export function createSaver({ onDisk, delay = 400 } = {}) {
  let timer = null;
  let latest = null;

  async function flushDisk() {
    if (!onDisk || latest === null) return;
    const payload = latest;
    latest = null;
    try {
      await putDisk(payload);
    } catch (err) {
      // Re-arm so the next save (or unload beacon) retries this data.
      latest = payload;
      console.warn('song disk save failed, will retry:', err);
    }
  }

  function save(songs) {
    // Snapshot so later in-memory mutations don't mutate the queued payload.
    const snapshot = songs.map((s) => ({ ...s }));
    saveLocal(snapshot);
    if (!onDisk) return;
    latest = snapshot;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushDisk, delay);
  }

  // Best-effort synchronous flush for page unload: sendBeacon survives the tab
  // closing where a normal fetch would be cancelled mid-flight.
  function flushOnUnload() {
    if (!onDisk || latest === null) return;
    try {
      const blob = new Blob([JSON.stringify(latest)], { type: 'application/json' });
      navigator.sendBeacon(API, blob); // beacon is POST; the API accepts POST too
      latest = null;
    } catch {
      /* nothing more we can do as the page goes away */
    }
  }

  if (onDisk) {
    // pagehide covers tab close / navigation / bfcache on more browsers than
    // beforeunload alone; guard against double-send by clearing `latest`.
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('beforeunload', flushOnUnload);
  }

  return { save, flushDisk, flushOnUnload };
}
