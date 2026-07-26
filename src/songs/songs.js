// OatCycles — in-browser song file system (M-songs).
//
// A collapsible right-side panel that lists saved songs, backed by real text
// files on disk (via the /api/songs dev-server endpoint) with a localStorage
// mirror for instant boot and offline fallback. The panel is a plain DOM
// element (not CodeMirror), so its vim-style navigation (j/k/gg/G/Enter/dd) is
// handled by a local keydown listener that is only active while the panel has
// focus.
//
// Data model:
//   disk   → ./songs/<name>.js text files + ./songs/index.json manifest
//   mirror → localStorage oat.songs (JSON array) + oat.currentSongId
//
// The editor buffer is auto-saved into the current song on every play (see
// main.js), and again just before switching/creating songs so nothing typed
// since the last play is ever lost. Each save writes localStorage immediately
// and flushes to disk (debounced). See storage.js.

import { loadSongs, createSaver, getCurrentId, setCurrentId } from './storage.js';

function uid() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Pick an unused "untitled" / "untitled N" name so blank :new / + always works.
function uniqueUntitled(songs) {
  const base = 'untitled';
  const taken = new Set(songs.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

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

  // One saver per session: writes localStorage synchronously and flushes to
  // disk (debounced). `persistSongs` is the single funnel for every mutation.
  const saver = createSaver({ onDisk });
  const persistSongs = (list) => saver.save(list);

  // --- bootstrap: guarantee there is always a valid current song ----------
  if (songs.length === 0) {
    // First run ever: seed one song from whatever the editor already holds
    // (the default pattern) so the current buffer becomes a real file.
    const song = { id: uid(), name: 'untitled', code: getCode(), updatedAt: Date.now() };
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
    filenameEl.textContent = c ? c.name : 'untitled';
  }

  function setNameOverride(name) {
    nameOverride = name;
    renderFilename();
  }

  function renderList() {
    // While a session owns the buffer, the list is a read-only view: opening or
    // creating a song here would replace everyone's work.
    const locked = !!sessionLock();
    listEl.classList.toggle('locked', locked);
    if (newBtn) newBtn.disabled = locked;
    listEl.innerHTML = '';
    songs.forEach((song, i) => {
      const li = document.createElement('li');
      li.className = 'song-row';
      if (song.id === currentId) li.classList.add('current');
      if (i === selected) li.classList.add('selected');
      li.dataset.id = song.id;

      const name = document.createElement('span');
      name.className = 'song-name';
      name.textContent = song.name;
      li.appendChild(name);

      if (song.id === currentId) {
        const dot = document.createElement('span');
        dot.className = 'song-current-dot';
        dot.textContent = '●';
        dot.title = 'current file';
        li.appendChild(dot);
      }

      li.addEventListener('click', () => openSong(song.id));
      listEl.appendChild(li);
    });
    // Keep the highlighted row in view during keyboard navigation.
    const sel = listEl.querySelector('.song-row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  // --- persistence actions -------------------------------------------------

  // Flush the editor buffer into the current song. Called on every play and
  // before any switch/create so unsaved edits survive.
  function autoSaveCurrent() {
    // A guest in a session writes nothing to disk: the buffer on screen is the
    // host's song, and two machines each saving their own copy of a file they
    // both think they own is how work gets lost.
    if (suppressSave()) return;
    const c = current();
    if (!c) return;
    c.code = getCode();
    c.updatedAt = Date.now();
    persistSongs(songs);
  }

  function openSong(id) {
    if (id === currentId) {
      close();
      return;
    }
    if (blocked()) return;
    autoSaveCurrent(); // "auto-save current, then switch"
    const song = songs.find((s) => s.id === id);
    if (!song) return;
    currentId = id;
    setCurrentId(currentId);
    setCode(song.code);
    renderFilename();
    onStatus?.(`opened “${song.name}”`);
    close();
  }

  function newSong(rawName) {
    if (blocked()) return;
    autoSaveCurrent();
    const name = (rawName || '').trim() || uniqueUntitled(songs);
    const song = { id: uid(), name, code: '', updatedAt: Date.now() };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    setCode('');
    selected = songs.length - 1;
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`new song “${name}”`);
    focusEditor();
  }

  // :copy — duplicate the current song into a new numbered file. Saves the
  // current buffer first (so the copy captures everything typed since the last
  // play), then creates a sibling with an incremented name and switches to it.
  function copyCurrent() {
    if (blocked()) return;
    autoSaveCurrent();
    const c = current();
    if (!c) return;
    const code = getCode();
    const name = nextCopyName(c.name, songs);
    const song = { id: uid(), name, code, updatedAt: Date.now() };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    setCode(code);
    selected = songs.length - 1;
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`copied to “${name}”`);
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
    c.updatedAt = Date.now();
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
    c.updatedAt = Date.now();
    persistSongs(songs);
    renderFilename();
    if (isOpen) renderList();
  }

  // Save a buffer as a brand-new local song and switch to it. Used when a guest
  // leaves a session, so the shared work they were part of isn't just lost.
  function importSong(rawName, code) {
    const base = (rawName || '').trim() || uniqueUntitled(songs);
    const taken = new Set(songs.map((s) => s.name));
    const name = taken.has(base) ? nextCopyName(base, songs) : base;
    const song = { id: uid(), name, code, updatedAt: Date.now() };
    songs.push(song);
    currentId = song.id;
    persistSongs(songs);
    setCurrentId(currentId);
    selected = songs.length - 1;
    setNameOverride(null);
    renderFilename();
    if (isOpen) renderList();
    onStatus?.(`saved as “${name}”`);
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
    if (!window.confirm(`Delete “${song.name}”? This cannot be undone.`)) return;

    songs.splice(idx, 1);
    if (songs.length === 0) {
      // Never leave the app without a current song; recreate a blank one.
      const fresh = { id: uid(), name: 'untitled', code: '', updatedAt: Date.now() };
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
    selected = Math.min(selected, songs.length - 1);
    renderFilename();
    renderList();
    onStatus?.(`deleted “${song.name}”`);
  }

  // --- panel open/close ----------------------------------------------------

  function open() {
    isOpen = true;
    panel.classList.add('open');
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
    panel.classList.remove('open');
    focusEditor();
  }

  function toggle() {
    isOpen ? close() : open();
  }

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
    if (songs.length === 0) return;
    selected = Math.max(0, Math.min(songs.length - 1, selected + delta));
    renderList();
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
        const song = songs[selected];
        if (song) deleteSong(song.id);
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
        selected = songs.length - 1;
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
      case 'Enter': {
        const song = songs[selected];
        if (song) openSong(song.id);
        e.preventDefault();
        break;
      }
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
