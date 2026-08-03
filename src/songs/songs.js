// OatCycles — in-browser song file system (M-songs).
//
// A collapsible right-side panel that lists saved songs, backed by real text
// files on disk (via the /api/songs dev-server endpoint) with a localStorage
// mirror for instant boot and offline fallback. The panel is a plain DOM
// element (not CodeMirror), so its vim-style navigation (j/k/gg/G/Enter/dd/:q)
// is handled by a local keydown listener that is only active while the panel
// has focus.
//
// Saving is split in two, and the split is the point:
//
//   :save            writes SavedSongs/<name>.js. The only thing that does.
//   every play       appends AutoSaves/<name>_auto_<date>_<time>.js, which can
//                    never overwrite a saved song or an earlier snapshot.
//
// So playing a pattern can no longer damage a file the user meant to keep. The
// snapshots are reachable from the panel: the AutoSaves/ row at the foot of the
// list descends into them (⏎), and :q comes back up.
//
// Data model:
//   disk   → ./SavedSongs/<name>.js + index.json, ./AutoSaves/<name>_auto_*.js
//   mirror → localStorage oat.songs (JSON array) + oat.currentSongId
//
// Each song record holds `code` (the live buffer, mirrored to localStorage) and
// `diskCode` (what its file actually contains). See storage.js.

import {
  loadSongs,
  createSaver,
  getCurrentId,
  setCurrentId,
  postAutosave,
  fetchAutosaves,
  fetchAutosave,
} from './storage.js';

const AUTOSAVES_ROW = 'AutoSaves/';

function uid() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Snapshot filenames carry a sanitized song name (the server has no manifest to
// look the original up in), so matching a snapshot back to its song means
// sanitizing the same way. Mirrors safeBase() in vite-songs-plugin.js.
function sanitize(name) {
  const base = String(name || '')
    .trim()
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return base || 'untitled';
}

// Compact enough for a 15rem panel: "Jul 26 09:41".
function shortWhen(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const mon = d.toLocaleString(undefined, { month: 'short' });
  return `${mon} ${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Pick an unused "<base>" / "<base> N" name. Distinct from nextCopyName below:
// this is a fresh file that happens to want a name already on the shelf, not a
// numbered lineage, so "peruse casio" becomes "peruse casio 2" rather than
// "peruse casio1".
function uniqueName(base, songs) {
  const taken = new Set(songs.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Pick an unused "untitled" / "untitled N" name so blank :new / + always works.
const uniqueUntitled = (songs) => uniqueName('untitled', songs);

// Derive the next filename for :copy — increment a trailing number, or append
// "1" when the name has none (song → song1, verse2 → verse3). Keeps bumping the
// number until the result is unused so repeated copies never collide.
function nextCopyName(base, songs) {
  const taken = new Set(songs.map((s) => s.name));
  const m = base.match(/^(.*?)(\d+)$/);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 1;
  let candidate = `${stem}${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem}${n}`;
  }
  return candidate;
}

export async function setupSongsPanel({
  panel, // <aside> container
  listEl, // <ul> the rows render into
  newBtn, // "+" button in the panel header
  titleEl, // panel header label — tracks which view you're in
  cmdEl, // the panel's own ":" command line (wrapper holding an <input>)
  hintEl, // footer key hints — differ per view
  filenameEl, // topbar element showing the current song name (dbl-click to rename)
  getCode, // () => current editor buffer text
  setCode, // (text) => replace editor buffer
  focusEditor, // () => return focus to the editor
  onStatus, // (text, kind) => surface a status message (optional)
  // Networked play. `sessionLock()` returns a reason string while a multiplayer
  // session is live (and null otherwise); `suppressSave()` is true when this
  // peer must not write to disk at all — a guest, whose buffer belongs to the
  // host's song, not to any file of theirs. See NETWORKED-PLAY.md §5.3 and §6.
  sessionLock = () => null,
  suppressSave = () => false,
  onRename, // (name) => void — a local rename, to be shared with peers
}) {
  // Read the durable store (disk if available, else the localStorage mirror).
  const { songs: loaded, onDisk } = await loadSongs();
  let songs = loaded;
  let currentId = getCurrentId();
  let selected = 0; // highlighted row index while navigating the panel
  let isOpen = false;
  let pending = null; // first key of a two-key sequence (gg / dd)
  let pendingTimer = null;
  let view = 'songs'; // 'songs' (top level) | 'autosaves' (inside the folder)
  let songsSelected = 0; // where to land back on when :q leaves the folder
  let autosaves = []; // [{ file, name, savedAt }], newest first

  const cmdInput = cmdEl?.querySelector('input') ?? null;

  // One saver per session: writes localStorage synchronously and flushes to
  // disk (debounced). `persistSongs` is the single funnel for every mutation.
  // Only songs the user has saved reach the files — see storage.js diskPayload.
  const saver = createSaver({ onDisk });
  // A guest, or an agent-driven page, keeps its localStorage mirror but writes
  // no files: the buffer on screen isn't theirs to commit to anyone's disk.
  const persistSongs = (list) => saver.save(list, { skipDisk: suppressSave() });

  // --- bootstrap: guarantee there is always a valid current song ----------
  if (songs.length === 0) {
    // First run ever: seed one song from whatever the editor already holds
    // (the default pattern). It is not written to SavedSongs/ — nothing is,
    // until the user asks for it — but it is autosaved like any other song.
    const song = { id: uid(), name: 'untitled', code: getCode(), saved: false, savedAt: 0 };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
  } else {
    const current = songs.find((s) => s.id === currentId);
    if (current) {
      // Returning session: restore the last-open song into the editor.
      setCode(current.code);
    } else {
      currentId = songs[0].id;
      setCurrentId(currentId);
      setCode(songs[0].code);
    }
  }

  function current() {
    return songs.find((s) => s.id === currentId) || null;
  }

  // Refuse a switch/create/delete while a multiplayer session owns the buffer,
  // and say why. Returns true when the action was blocked.
  function blocked() {
    const reason = sessionLock();
    if (!reason) return false;
    onStatus?.(reason, 'error');
    return true;
  }

  // During a session the topbar shows the *shared* song name, which for a guest
  // isn't a file they have. `nameOverride` carries it; null means "show the
  // current local song" as usual.
  let nameOverride = null;

  function renderFilename() {
    if (nameOverride != null) {
      filenameEl.textContent = nameOverride;
      return;
    }
    const c = current();
    filenameEl.textContent = c ? (c.saved ? c.name : `${c.name} [+]`) : 'untitled';
  }

  function setNameOverride(name) {
    nameOverride = name;
    renderFilename();
  }

  // --- rendering -----------------------------------------------------------

  function row(className) {
    const li = document.createElement('li');
    li.className = `song-row ${className}`.trim();
    return li;
  }

  function label(li, text, className = 'song-name') {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    li.appendChild(span);
    return span;
  }

  function renderSongRows() {
    // While a session owns the buffer, the list is a read-only view: opening or
    // creating a song here would replace everyone's work.
    const locked = !!sessionLock();
    listEl.classList.toggle('locked', locked);
    if (newBtn) newBtn.disabled = locked;

    songs.forEach((song, i) => {
      const li = row(song.id === currentId ? 'current' : '');
      if (i === selected) li.classList.add('selected');
      li.dataset.id = song.id;
      label(li, song.name);

      // A song with no file yet: it exists in localStorage and in its
      // autosaves, and :save is what turns it into SavedSongs/<name>.js.
      if (!song.saved) label(li, '[+]', 'song-unsaved');
      if (song.id === currentId) {
        const dot = label(li, '●', 'song-current-dot');
        dot.title = 'current file';
      }

      li.addEventListener('click', () => openSong(song.id));
      listEl.appendChild(li);
    });

    const folder = row('folder');
    if (selected === songs.length) folder.classList.add('selected');
    label(folder, AUTOSAVES_ROW);
    folder.addEventListener('click', () => enterAutosaves());
    listEl.appendChild(folder);
  }

  function renderAutosaveRows() {
    listEl.classList.remove('locked');
    if (newBtn) newBtn.disabled = true;

    if (autosaves.length === 0) {
      const li = row('folder');
      label(li, 'no snapshots yet');
      listEl.appendChild(li);
      return;
    }
    autosaves.forEach((entry, i) => {
      const li = row('');
      if (i === selected) li.classList.add('selected');
      label(li, entry.name);
      label(li, shortWhen(entry.savedAt), 'song-when');
      li.addEventListener('click', () => openAutosave(entry));
      listEl.appendChild(li);
    });
  }

  function renderList() {
    listEl.innerHTML = '';
    if (view === 'autosaves') renderAutosaveRows();
    else renderSongRows();

    if (titleEl) titleEl.textContent = view === 'autosaves' ? 'AutoSaves' : 'Songs';
    if (hintEl) {
      hintEl.textContent =
        view === 'autosaves'
          ? 'j/k move · gg/G ends · ⏎ restore · :q back'
          : 'j/k move · gg/G ends · ⏎ open · dd delete · :q close';
    }
    // Keep the highlighted row in view during keyboard navigation.
    const sel = listEl.querySelector('.song-row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  // How many rows the current view can land on (the songs view has the
  // AutoSaves/ folder row after the last song).
  function rowCount() {
    return view === 'autosaves' ? autosaves.length : songs.length + 1;
  }

  // --- persistence actions -------------------------------------------------

  // Snapshot the editor buffer. Called on every play and before any
  // switch/create so unsaved edits survive — but it writes to AutoSaves/ only.
  // The song's own file is never touched here; that is what :save is for.
  function autoSaveCurrent() {
    // A guest in a session writes nothing to disk: the buffer on screen is the
    // host's song, and two machines each saving their own copy of a file they
    // both think they own is how work gets lost.
    if (suppressSave()) return;
    const c = current();
    if (!c) return;
    const code = getCode();
    c.code = code;
    persistSongs(songs); // refresh the mirror; saved files stay as they are
    if (!onDisk) return;
    // Fire and forget: a snapshot is a background courtesy, and the play it
    // rides along with shouldn't wait on the network for it.
    postAutosave({ name: c.name, code }).catch((err) => {
      console.warn('autosave failed:', err);
    });
  }

  // :save [name] — the only path that writes SavedSongs/.
  //
  //   :save            write the buffer to the current song's file, creating it
  //                    if this song has never been saved
  //   :save <current>  same thing
  //   :save <other>    copy the buffer to a new file under that name and make
  //                    it current; the song being left keeps its own file
  //                    exactly as it was
  //
  // A name already belonging to another saved song is refused rather than
  // overwritten — clobbering a file is what this whole split exists to prevent.
  function saveCurrent(rawName) {
    if (suppressSave()) {
      onStatus?.('not saving in this session', 'error');
      return;
    }
    const c = current();
    if (!c) return;
    const code = getCode();
    const name = (rawName || '').trim();

    if (!name || name === c.name) {
      c.code = code;
      c.diskCode = code;
      c.saved = true;
      c.savedAt = Date.now();
      persistSongs(songs);
      renderFilename();
      if (isOpen) renderList();
      onStatus?.(`saved “${c.name}”`);
      return;
    }

    if (songs.some((s) => s.id !== c.id && s.name === name)) {
      onStatus?.(`“${name}” already exists — pick another name`, 'error');
      return;
    }

    // A song with no file behind it isn't being copied anywhere: naming it is
    // just naming it. Only a song that already has a file forks into a second.
    if (!c.saved) {
      c.name = name;
      c.code = code;
      c.diskCode = code;
      c.saved = true;
      c.savedAt = Date.now();
      persistSongs(songs);
      renderFilename();
      if (isOpen) renderList();
      onStatus?.(`saved “${name}”`);
      return;
    }

    // The edits move to the new file, so the song we're leaving goes back to
    // matching its own — it keeps whatever it last saved, untouched. Nothing is
    // lost either way: the buffer as it stood is in AutoSaves/ under both names.
    c.code = c.diskCode ?? c.code;
    const song = { id: uid(), name, code, diskCode: code, saved: true, savedAt: Date.now() };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    selected = songs.length - 1;
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`saved “${name}”`);
  }

  function openSong(id) {
    if (id === currentId) {
      close();
      return;
    }
    if (blocked()) return;
    autoSaveCurrent(); // "snapshot the current buffer, then switch"
    const song = songs.find((s) => s.id === id);
    if (!song) return;
    currentId = id;
    setCurrentId(currentId);
    setCode(song.code);
    renderFilename();
    onStatus?.(`opened “${song.name}”`);
    close();
  }

  // :new [name] — a fresh song, blank unless the caller seeds it (`:banks`
  // opens one already holding the samples() call for the bank you picked).
  //
  // Returns the song, or null when a session refused the switch, so a caller
  // that wants to do something to the new buffer knows there is one.
  function newSong(rawName, { code = '' } = {}) {
    if (blocked()) return null;
    autoSaveCurrent();
    const asked = (rawName || '').trim();
    // A duplicate name would make two rows that read identically and two files
    // that differ only by the disambiguating suffix the songs plugin adds.
    const name = asked ? uniqueName(asked, songs) : uniqueUntitled(songs);
    const song = { id: uid(), name, code, saved: false, savedAt: 0 };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    setCode(code);
    selected = songs.length - 1;
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`new song “${name}”`);
    focusEditor();
    return song;
  }

  // :copy — duplicate the current song into a new numbered song. Snapshots the
  // current buffer first (so the copy captures everything typed since the last
  // play), then creates a sibling with an incremented name and switches to it.
  // The copy has no file of its own until it is saved.
  function copyCurrent() {
    if (blocked()) return;
    autoSaveCurrent();
    const c = current();
    if (!c) return;
    const code = getCode();
    const name = nextCopyName(c.name, songs);
    const song = { id: uid(), name, code, saved: false, savedAt: 0 };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    setCode(code);
    selected = songs.length - 1;
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`copied to “${name}” — :save to write it`);
    focusEditor();
  }

  // Rename is the one song action that stays live during a session — it's the
  // shared document's name, so it goes out to peers as well (through `onRename`,
  // which main.js routes into the session's `meta` map).
  function renameCurrent(rawName) {
    const name = (rawName || '').trim();
    if (!name) {
      onStatus?.('usage: :name <filename>', 'error');
      return;
    }
    onRename?.(name);
    if (suppressSave()) {
      // A guest has no local file backing the session buffer — only the label.
      setNameOverride(name);
      onStatus?.(`renamed to “${name}”`);
      return;
    }
    const c = current();
    if (!c) return;
    c.name = name;
    if (c.saved) c.savedAt = Date.now(); // the file itself is being renamed
    persistSongs(songs);
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`renamed to “${name}”`);
  }

  // A rename that arrived from a peer. Same effect, but it must not echo back
  // out through `onRename`.
  function applyRemoteName(name) {
    if (!name) return;
    if (suppressSave()) {
      setNameOverride(name);
      return;
    }
    const c = current();
    if (!c) return;
    c.name = name;
    if (c.saved) c.savedAt = Date.now();
    persistSongs(songs);
    renderFilename();
    if (isOpen) renderList();
  }

  // Keep a buffer as a brand-new local song and switch to it. Used when a guest
  // leaves a session, so the shared work they were part of isn't just lost. It
  // arrives unsaved, like any new song, but is snapshotted immediately.
  function importSong(rawName, code) {
    const base = (rawName || '').trim() || uniqueUntitled(songs);
    const taken = new Set(songs.map((s) => s.name));
    const name = taken.has(base) ? nextCopyName(base, songs) : base;
    const song = { id: uid(), name, code, saved: false, savedAt: 0 };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    selected = songs.length - 1;
    setNameOverride(null);
    renderFilename();
    if (isOpen) renderList();
    if (onDisk && !suppressSave()) {
      postAutosave({ name, code }).catch((err) => console.warn('autosave failed:', err));
    }
    onStatus?.(`kept as “${name}” — :save to write it`);
    return song;
  }

  function deleteSong(id) {
    // The song a session is running out of can't be deleted from under it; for
    // a guest, deleting the song they happen to have "current" would try to
    // swap the shared buffer out too.
    if (id === currentId && blocked()) return;
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const song = songs[idx];
    const warning = song.saved
      ? `Delete “${song.name}”? Its file goes too. Snapshots in AutoSaves/ are kept.`
      : `Delete “${song.name}”? It was never saved; only its snapshots in AutoSaves/ remain.`;
    if (!window.confirm(warning)) return;

    songs.splice(idx, 1);
    if (songs.length === 0) {
      // Never leave the app without a current song; recreate a blank one.
      const fresh = { id: uid(), name: 'untitled', code: '', saved: false, savedAt: 0 };
      songs.push(fresh);
      currentId = fresh.id;
      setCode('');
    } else if (id === currentId) {
      // Deleted the open song: fall back to the neighbouring row and load it.
      const next = songs[Math.min(idx, songs.length - 1)];
      currentId = next.id;
      setCode(next.code);
    }
    persistSongs(songs);
    setCurrentId(currentId);
    selected = Math.min(selected, songs.length);
    renderFilename();
    renderList();
    onStatus?.(`deleted “${song.name}”`);
  }

  // --- the AutoSaves/ folder -----------------------------------------------

  async function enterAutosaves() {
    if (!onDisk) {
      onStatus?.('no autosaves without the dev server', 'error');
      return;
    }
    try {
      autosaves = await fetchAutosaves();
    } catch (err) {
      console.error(err);
      onStatus?.('could not read AutoSaves/', 'error');
      return;
    }
    songsSelected = selected;
    view = 'autosaves';
    selected = 0;
    renderList();
  }

  function leaveAutosaves() {
    view = 'songs';
    selected = Math.min(songsSelected, songs.length);
    renderList();
  }

  // Restore a snapshot into the editor. It lands as an ordinary unsaved buffer:
  // if the song it came from still exists, that song becomes current so a
  // following bare :save puts the snapshot back into its own file. Nothing
  // under SavedSongs/ changes until then.
  async function openAutosave(entry) {
    if (blocked()) return;
    autoSaveCurrent(); // the buffer being replaced gets its own snapshot first
    let code;
    try {
      code = await fetchAutosave(entry.file);
    } catch (err) {
      console.error(err);
      onStatus?.('could not read that snapshot', 'error');
      return;
    }
    const home = songs.find((s) => sanitize(s.name) === entry.name);
    if (home) {
      currentId = home.id;
      home.code = code;
    } else {
      const song = { id: uid(), name: entry.name, code, saved: false, savedAt: 0 };
      songs.push(song);
      currentId = song.id;
    }
    persistSongs(songs);
    setCurrentId(currentId);
    setCode(code);
    view = 'songs';
    selected = Math.max(0, songs.findIndex((s) => s.id === currentId));
    renderFilename();
    onStatus?.(`restored ${entry.name} from ${shortWhen(entry.savedAt)} — :save to keep it`);
    close();
  }

  // --- panel open/close ----------------------------------------------------

  function open() {
    isOpen = true;
    panel.classList.add('open');
    // Always open at the top level; the folder is somewhere you go, not a place
    // to be dropped back into later.
    view = 'songs';
    // Start navigation on the current song.
    selected = Math.max(0, songs.findIndex((s) => s.id === currentId));
    renderList();
    // Defer the focus: when opened via the :o ex-command, vim refocuses the
    // editor synchronously right after this handler returns, which would undo a
    // synchronous panel.focus(). A macrotask wins the race (and is harmless when
    // opened via the toolbar button). setTimeout over rAF so it still fires if
    // the tab is backgrounded.
    setTimeout(() => panel.focus(), 0);
  }

  function close() {
    isOpen = false;
    hideCmdline();
    panel.classList.remove('open');
    focusEditor();
  }

  function toggle() {
    isOpen ? close() : open();
  }

  // --- the panel's own command line ----------------------------------------
  //
  // ":" opens it. The only command is :q, which pops out of the AutoSaves/
  // folder, or closes the panel when there's nowhere further up to go — the
  // same thing :q means everywhere else in the app.

  function hideCmdline() {
    if (!cmdEl) return;
    cmdEl.hidden = true;
    if (cmdInput) cmdInput.value = '';
  }

  function showCmdline() {
    if (!cmdEl || !cmdInput) return;
    cmdEl.hidden = false;
    cmdInput.value = '';
    cmdInput.focus();
  }

  function runCommand(raw) {
    const cmd = raw.trim();
    hideCmdline();
    if (cmd === 'q' || cmd === 'quit') {
      if (view === 'autosaves') {
        leaveAutosaves();
        panel.focus();
      } else {
        close();
      }
      return;
    }
    if (cmd) onStatus?.(`not a panel command: :${cmd}`, 'error');
    panel.focus();
  }

  cmdInput?.addEventListener('keydown', (e) => {
    // The panel's own keydown handler is an ancestor listener; without this it
    // would read every keystroke here as navigation.
    e.stopPropagation();
    if (e.key === 'Enter') {
      runCommand(cmdInput.value);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      hideCmdline();
      panel.focus();
      e.preventDefault();
    }
  });
  cmdInput?.addEventListener('blur', hideCmdline);

  // --- panel keyboard navigation (vim-style) -------------------------------

  function clearPending() {
    pending = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  function setPending(key) {
    pending = key;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(clearPending, 600);
  }

  function move(delta) {
    const count = rowCount();
    if (count === 0) return;
    selected = Math.max(0, Math.min(count - 1, selected + delta));
    renderList();
  }

  function activate() {
    if (view === 'autosaves') {
      const entry = autosaves[selected];
      if (entry) openAutosave(entry);
      return;
    }
    if (selected === songs.length) {
      enterAutosaves();
      return;
    }
    const song = songs[selected];
    if (song) openSong(song.id);
  }

  panel.addEventListener('keydown', (e) => {
    if (!isOpen) return;

    // Two-key sequences: gg (top), dd (delete).
    if (pending === 'g') {
      clearPending();
      if (e.key === 'g') {
        selected = 0;
        renderList();
        e.preventDefault();
        return;
      }
    } else if (pending === 'd') {
      clearPending();
      if (e.key === 'd') {
        // Snapshots aren't deleted by hand — AutoSaves/ prunes itself.
        if (view === 'songs' && selected < songs.length) {
          const song = songs[selected];
          if (song) deleteSong(song.id);
        }
        e.preventDefault();
        return;
      }
    }

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        move(1);
        e.preventDefault();
        break;
      case 'k':
      case 'ArrowUp':
        move(-1);
        e.preventDefault();
        break;
      case 'G':
        selected = Math.max(0, rowCount() - 1);
        renderList();
        e.preventDefault();
        break;
      case 'g':
        setPending('g');
        e.preventDefault();
        break;
      case 'd':
        setPending('d');
        e.preventDefault();
        break;
      case ':':
        showCmdline();
        e.preventDefault();
        break;
      case 'Enter':
        activate();
        e.preventDefault();
        break;
      case 'Escape':
        close();
        e.preventDefault();
        break;
    }
  });

  // --- inline filename editing (double-click the topbar name) --------------

  function beginRename() {
    const c = current();
    if (!c) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'song-name-input';
    input.value = c.name;
    filenameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) renameCurrent(input.value);
      input.replaceWith(filenameEl);
      renderFilename();
      focusEditor();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }

  filenameEl.addEventListener('dblclick', beginRename);
  newBtn?.addEventListener('click', () => newSong());

  renderFilename();

  return {
    autoSaveCurrent,
    saveCurrent,
    open,
    close,
    toggle,
    newSong,
    copyCurrent,
    renameCurrent,
    // --- networked play
    applyRemoteName,
    importSong,
    setNameOverride,
    // Re-load the current song into the editor. Used when a guest leaves a
    // session that never synced: their buffer was blanked on join and there is
    // nothing shared worth keeping, so give them their own song back.
    reopenCurrent: () => {
      const c = current();
      if (c) setCode(c.code);
      setNameOverride(null);
    },
    currentName: () => current()?.name ?? null,
    // Re-draw after a session starts or ends, so the lock state shows.
    refresh: () => {
      renderFilename();
      if (isOpen) renderList();
      else if (newBtn) newBtn.disabled = !!sessionLock();
    },
  };
}
