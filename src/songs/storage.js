// Song persistence: disk-first, with localStorage as a fast cache + offline
// fallback.
//
// There are two durable stores behind the dev/preview server (see
// vite-songs-plugin.js):
//
//   SavedSongs/  one text file per song. Written only when the user explicitly
//                saves, renames or deletes — never as a side effect of playing.
//   AutoSaves/   timestamped snapshots, appended on every play. Cannot
//                overwrite a saved song or another snapshot.
//
// localStorage still holds a mirror of the song list so the app boots instantly
// and keeps working when no server is present (a plain production `vite build`).
//
// Each song record carries two versions of its text:
//
//   code      the editor buffer as of the last autosave
//   diskCode  exactly what is in SavedSongs/<file>.js
//
// Only `:save` moves `code` into `diskCode`. Every PUT sends `diskCode` for the
// songs it isn't saving, which is what stops an unsaved buffer from riding
// along to disk when some *other* song gets saved.
//
// Load order on a fresh browser session:
//   1. Ask the server for the on-disk saved songs (the source of truth).
//   2. If the server is unreachable (prod build), use the localStorage mirror.
//   3. Merge: disk wins for saved songs; songs the user never saved exist only
//      in the mirror, so they're carried over as-is.

const SONGS_KEY = 'oat.songs';
const CURRENT_KEY = 'oat.currentSongId';
const API = '/api/songs';
const AUTOSAVE_API = '/api/autosave';
const AUTOSAVES_API = '/api/autosaves';

// localStorage holds the buffer and the metadata, but not `diskCode` — that is
// re-read from the files themselves on the next load, and duplicating every
// song's text would double the mirror for nothing.
function toMirror(song) {
  return {
    id: song.id,
    name: song.name,
    code: song.code ?? '',
    saved: !!song.saved,
    savedAt: song.savedAt || 0,
  };
}

// Records written before the save/autosave split have no `saved` flag, but they
// were all real files under songs/ — which the migration copied into
// SavedSongs/ — so they count as saved.
function normalize(song) {
  return {
    id: song.id,
    name: song.name,
    code: song.code ?? '',
    diskCode: song.diskCode,
    saved: song.saved ?? true,
    savedAt: song.savedAt || song.updatedAt || 0,
  };
}

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(SONGS_KEY));
    return Array.isArray(raw) ? raw.map(normalize) : [];
  } catch {
    return [];
  }
}

function saveLocal(songs) {
  localStorage.setItem(SONGS_KEY, JSON.stringify(songs.map(toMirror)));
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

// The subset that goes to disk, and the exact text each song keeps there. A
// song is sent with its `diskCode` — the buffer only reaches disk through the
// explicit save that promotes it.
export function diskPayload(songs) {
  return songs
    .filter((s) => s.saved)
    .map((s) => ({
      id: s.id,
      name: s.name,
      code: s.diskCode ?? s.code ?? '',
      savedAt: s.savedAt || 0,
    }));
}

// Take one snapshot. Resolves to { file, savedAt, skipped } — `skipped` when
// the server found the newest snapshot for this song already identical.
export async function postAutosave({ name, code }) {
  const res = await fetch(AUTOSAVE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, code }),
  });
  if (!res.ok) throw new Error(`autosave failed: HTTP ${res.status}`);
  return res.json();
}

// [{ file, name, savedAt }], newest first. Metadata only; a snapshot's text is
// fetched on demand, so opening the folder costs one small request however many
// snapshots have piled up.
export async function fetchAutosaves() {
  const res = await fetch(AUTOSAVES_API, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`could not list autosaves: HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchAutosave(file) {
  const res = await fetch(`${AUTOSAVES_API}/${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`could not read snapshot: HTTP ${res.status}`);
  return res.text();
}

export function getCurrentId() {
  return localStorage.getItem(CURRENT_KEY);
}

export function setCurrentId(id) {
  if (id == null) localStorage.removeItem(CURRENT_KEY);
  else localStorage.setItem(CURRENT_KEY, id);
}

// Reconcile the mirror against what the files actually say. Disk is the truth
// for saved songs — including that a song is *gone*, so a mirrored record
// claiming to be saved with no file behind it is dropped. Songs the user never
// saved have no file to compare against and are kept as they are.
export function mergeSongs(rawLocal, disk) {
  // Normalize here rather than trusting the caller: a mirror written before the
  // save/autosave split has no `saved` flag, and reading one as unsaved would
  // quietly detach it from the file it actually has.
  const local = rawLocal.map(normalize);
  const onDisk = new Set(disk.map((d) => d.id));
  const merged = disk.map((d) => {
    const mirror = local.find((l) => l.id === d.id);
    return normalize({
      id: d.id,
      name: d.name,
      // The buffer may hold edits made since the last explicit save; keep them.
      code: mirror && mirror.saved ? (mirror.code ?? d.code) : d.code,
      diskCode: d.code,
      saved: true,
      savedAt: d.savedAt,
    });
  });
  for (const l of local) {
    if (!onDisk.has(l.id) && !l.saved) merged.push(normalize({ ...l, saved: false }));
  }
  return merged;
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
  return { songs: mergeSongs(local, disk), onDisk: true };
}

// Build a saver bound to this session. localStorage is written synchronously on
// every call (never lose the in-memory state); the disk write is debounced so a
// burst of edits collapses into a single request.
export function createSaver({ onDisk, delay = 400 } = {}) {
  let timer = null;
  let latest = null;
  let lastSent = null; // JSON of the last payload the files agree with

  async function flushDisk() {
    if (!onDisk || latest === null) return;
    const payload = latest;
    latest = null;
    const encoded = JSON.stringify(payload);
    // Autosaving calls through here on every play to refresh the mirror, but
    // the saved songs are usually untouched. Re-writing identical files would
    // churn mtimes (and git status) for nothing.
    if (encoded === lastSent) return;
    try {
      await putDisk(payload);
      lastSent = encoded;
    } catch (err) {
      // Re-arm so the next save (or unload beacon) retries this data.
      latest = payload;
      console.warn('song disk save failed, will retry:', err);
    }
  }

  // `skipDisk` is for the peers that must not write files at all — a guest in a
  // session, and any agent-driven page. They still get the localStorage mirror,
  // so their own list stays coherent; nothing of theirs reaches SavedSongs/.
  function save(songs, { skipDisk = false } = {}) {
    saveLocal(songs);
    if (!onDisk || skipDisk) return;
    // diskPayload builds fresh objects, so later in-memory mutations can't
    // reach into the queued write.
    latest = diskPayload(songs);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushDisk, delay);
  }

  // Best-effort synchronous flush for page unload: sendBeacon survives the tab
  // closing where a normal fetch would be cancelled mid-flight.
  function flushOnUnload() {
    if (!onDisk || latest === null) return;
    const encoded = JSON.stringify(latest);
    if (encoded === lastSent) {
      latest = null;
      return;
    }
    try {
      const blob = new Blob([encoded], { type: 'application/json' });
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
