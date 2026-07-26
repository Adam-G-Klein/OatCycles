// Networked play — the topbar Multiplayer dropdown.
//
// Follows the existing panel convention: DOM elements and callbacks in, an
// imperative API out, exactly like setupMidiPanel and setupSongsPanel.
//
// Collapsed (idle):     👥 Multiplayer
// Collapsed (in room):  👥 warm-tidal-fox · 3, with a dot in your own colour
//
// Expanded it's a name/colour row, then either the Host and Join forms or —
// once connected — the peer list and a Leave button.
//
// Room names are memorable (`warm-tidal-fox`) and passphrases are random and
// separate: the name is a handle, the passphrase is the key. One copy button
// puts `room · passphrase` on the clipboard as a single string, and the Join
// form accepts exactly that pasted whole. That is the difference between
// "text your friend two fields" and "text your friend one thing."

import {
  loadIdentity,
  saveIdentity,
  randomRoomName,
  randomPassphrase,
  formatCredentials,
  parseCredentials,
} from './identity.js';
import { isLocalMode } from './transport.js';

export function setupNetPanel({
  root, // #net wrapper (for outside-click dismissal)
  toggleBtn, // #net-toggle — the collapsed control
  dropdown, // #net-dropdown
  nameInput, // #net-name
  colorInput, // #net-color
  idleSection, // #net-idle — host + join forms
  hostRoomEl, // #net-host-room
  hostPassInput, // #net-host-pass
  hostCopyBtn, // #net-host-copy
  rerollBtn, // #net-host-reroll
  hostBtn, // #net-host
  joinRoomInput, // #net-join-room
  joinPassInput, // #net-join-pass
  joinBtn, // #net-join
  connectedSection, // #net-connected
  roomEl, // #net-room
  copyBtn, // #net-copy
  peersEl, // #net-peers
  leaveBtn, // #net-leave
  onHost, // ({ roomId, passphrase }) => Promise
  onJoin, // ({ roomId, passphrase }) => Promise
  onLeave, // () => Promise
  onIdentity, // ({ name, color }) => void
  onStatus,
}) {
  let identity = loadIdentity();
  let snap = { status: 'idle', active: false, roomId: null, passphrase: null, peers: [] };
  let open = false;

  nameInput.value = identity.name;
  colorInput.value = identity.color;

  // Pre-generate credentials so "Host session" is a single click.
  let hostRoom = randomRoomName();
  let hostPass = randomPassphrase();

  function renderHostCredentials() {
    hostRoomEl.textContent = hostRoom;
    hostPassInput.value = hostPass;
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      onStatus?.(`${label} copied`);
    } catch {
      onStatus?.('clipboard blocked — select and copy manually', 'error');
    }
  }

  // --- rendering ------------------------------------------------------------

  function renderToggle() {
    const dot = '<span class="net-dot"></span>';
    if (!snap.active) {
      toggleBtn.innerHTML = '👥 Multiplayer';
      toggleBtn.classList.remove('on', 'connecting');
      toggleBtn.style.removeProperty('--net-self-color');
      return;
    }
    toggleBtn.style.setProperty('--net-self-color', identity.color);
    toggleBtn.classList.add('on');
    toggleBtn.classList.toggle('connecting', snap.status === 'connecting');
    const count = snap.peers.length || 1;
    const label = snap.status === 'connecting' ? 'connecting…' : `${snap.roomId} · ${count}`;
    toggleBtn.innerHTML = `${dot} ${escapeHtml(label)}`;
  }

  function renderPeers() {
    peersEl.innerHTML = '';
    for (const peer of snap.peers) {
      const li = document.createElement('li');
      li.className = 'net-peer';

      const dot = document.createElement('span');
      dot.className = 'net-dot';
      dot.style.setProperty('--net-self-color', peer.color);
      li.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'net-peer-name';
      name.textContent = peer.name + (peer.isSelf ? ' (you)' : '');
      li.appendChild(name);

      if (peer.isHost) {
        const tag = document.createElement('span');
        tag.className = 'net-peer-tag';
        tag.textContent = 'host';
        li.appendChild(tag);
      }
      peersEl.appendChild(li);
    }
    if (!snap.peers.length) {
      const li = document.createElement('li');
      li.className = 'net-peer net-peer-empty';
      li.textContent = 'waiting for peers…';
      peersEl.appendChild(li);
    }
  }

  function render() {
    renderToggle();
    idleSection.hidden = snap.active;
    connectedSection.hidden = !snap.active;
    if (snap.active) {
      roomEl.textContent = snap.roomId ?? '';
      renderPeers();
    } else {
      renderHostCredentials();
    }
  }

  // --- open / close ---------------------------------------------------------

  function setOpen(next) {
    open = next;
    dropdown.hidden = !open;
    toggleBtn.setAttribute('aria-expanded', String(open));
    if (open) render();
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });

  // Click anywhere else dismisses. Clicks inside the dropdown must not, so the
  // wrapper swallows them before they reach the document listener.
  root.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    if (open) setOpen(false);
  });
  dropdown.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
      e.stopPropagation();
    }
  });

  // --- identity -------------------------------------------------------------

  function commitIdentity() {
    const name = nameInput.value.trim() || identity.name;
    const color = colorInput.value;
    identity = { name, color };
    saveIdentity(identity);
    onIdentity?.(identity);
    renderToggle();
  }

  nameInput.addEventListener('change', commitIdentity);
  nameInput.addEventListener('blur', commitIdentity);
  colorInput.addEventListener('change', commitIdentity);
  // Enter in the name field shouldn't submit anything; just commit and close.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commitIdentity();
      nameInput.blur();
    }
  });

  // --- actions --------------------------------------------------------------

  rerollBtn.addEventListener('click', () => {
    hostRoom = randomRoomName();
    hostPass = randomPassphrase();
    renderHostCredentials();
  });

  hostCopyBtn.addEventListener('click', () =>
    copyText(formatCredentials(hostRoom, hostPass), 'room · passphrase'),
  );
  copyBtn.addEventListener('click', () =>
    copyText(formatCredentials(snap.roomId, snap.passphrase), 'room · passphrase'),
  );

  async function doHost() {
    commitIdentity();
    hostBtn.disabled = true;
    try {
      await onHost?.({ roomId: hostRoom, passphrase: hostPass });
      setOpen(false);
    } finally {
      hostBtn.disabled = false;
    }
  }

  async function doJoin() {
    commitIdentity();
    // Either field accepts the whole "room · passphrase" string pasted in.
    const fromRoom = parseCredentials(joinRoomInput.value);
    const fromPass = parseCredentials(joinPassInput.value);
    const roomId = fromRoom.roomId;
    const passphrase = fromRoom.passphrase || fromPass.passphrase || fromPass.roomId;
    if (!roomId || !passphrase) {
      onStatus?.('need both a room and a passphrase to join', 'error');
      return;
    }
    joinBtn.disabled = true;
    try {
      await onJoin?.({ roomId, passphrase });
      joinPassInput.value = '';
      setOpen(false);
    } finally {
      joinBtn.disabled = false;
    }
  }

  hostBtn.addEventListener('click', doHost);
  joinBtn.addEventListener('click', doJoin);
  joinPassInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  joinRoomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  leaveBtn.addEventListener('click', async () => {
    leaveBtn.disabled = true;
    try {
      await onLeave?.();
      setOpen(false);
    } finally {
      leaveBtn.disabled = false;
    }
  });

  // ?net=local swaps the WebRTC transport for a same-browser BroadcastChannel,
  // which is how two tabs on one machine can be tested without a relay. Say so,
  // loudly, so nobody wonders why a friend can't connect.
  if (isLocalMode()) {
    const note = document.createElement('div');
    note.className = 'net-local-note';
    note.textContent = '?net=local — same-browser tabs only, no network';
    dropdown.prepend(note);
  }

  render();

  return {
    // Called on every session state change.
    update(next) {
      snap = next;
      if (next.self?.name) identity = { name: next.self.name, color: next.self.color };
      if (open) render();
      else renderToggle();
    },
    identity: () => identity,
    // The credentials the Host button would use, so :host can share them.
    hostCredentials: () => ({ roomId: hostRoom, passphrase: hostPass }),
    rollCredentials() {
      hostRoom = randomRoomName();
      hostPass = randomPassphrase();
      renderHostCredentials();
      return { roomId: hostRoom, passphrase: hostPass };
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
