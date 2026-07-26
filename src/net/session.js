// Networked play — the shared document.
//
// What syncs: the buffer and presence (cursors, selections, names). *Not* the
// clock, and not playback. Every peer evaluates and hears their own engine;
// nobody can start, stop, or re-evaluate anyone else's audio. That is a
// deliberate scope decision (NETWORKED-PLAY.md §1), not an omission.
//
//   CodeMirror EditorView
//         │  yCollab extension (in a Compartment, like vim)
//         ▼
//   Y.Doc ── ytext 'code'  ── the buffer
//         ├─ ymap  'meta'  ── song name, host client id, created-at
//         └─ awareness     ── peer name, colour, cursor/selection
//         │  binary updates (Uint8Array)
//         ▼
//   transport.js ── WebRTC data channels (or a BroadcastChannel in ?net=local)
//
// Yjs is a CRDT: concurrent edits converge to the same result regardless of
// arrival order, with no server arbitrating. Updates are idempotent and
// commutative, so we can skip the standard y-protocols/sync handshake — a code
// buffer is a few kilobytes and redundant full-state sends are harmless.
//
//   on peer join  → send that peer Y.encodeStateAsUpdate(ydoc)
//   on local edit → broadcast the incremental update
//   on receive    → Y.applyUpdate(ydoc, update, REMOTE)
//
// The REMOTE origin tag is load-bearing twice over: it keeps remote edits out
// of your undo stack, and it stops the update handler from echoing received
// changes straight back out.

import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { keymap } from '@codemirror/view';
import { createTransport } from './transport.js';
import { colorLight } from './identity.js';

// Transaction origin for everything that arrived over the wire.
const REMOTE = Symbol('oat.remote');
// Transaction origin for the host's one-time seed of the buffer, so the seed
// never lands on anyone's undo stack.
const SEED = Symbol('oat.seed');

// A guest that has been connecting this long has almost certainly joined a room
// with no host in it (wrong room name, or the host already left). We keep the
// session alive — their doc is still empty, nothing is at risk — but say so.
const SYNC_WARN_MS = 30000;

// `onReady` fires once the Y.Doc exists and before the transport is touched, so
// the editor is bound to the shared document before anything can arrive over
// the wire — and, for the host, before there's any window in which typing would
// land in the editor but not in the CRDT.
export function createSession({ onStatus, onChange, onSongName, onReady } = {}) {
  // 'idle' → 'connecting' (guests only, until first sync) → 'connected'
  let status = 'idle';
  let role = null; // 'host' | 'guest' | null
  let roomId = null;
  let passphrase = null;
  let identity = { name: 'anon', color: '#7aa2f7' };

  let ydoc = null;
  let ytext = null;
  let ymeta = null;
  let awareness = null;
  let undoManager = null;
  let transport = null;
  let syncTimer = null;

  // Guests must not write to their Y.Doc before the first remote update lands.
  // If they do, both inserts are legitimate CRDT operations and the merge is
  // *both documents concatenated* — the classic Yjs footgun, and it looks
  // exactly like data corruption. Sync completion is the first `ydoc` message
  // received, not the first peer joining.
  let synced = false;

  function snapshot() {
    return {
      status,
      role,
      active: status !== 'idle',
      roomId,
      passphrase,
      synced,
      self: { ...identity, clientId: ydoc?.clientID ?? null },
      peers: peerList(),
      songName: ymeta?.get('song') ?? null,
    };
  }

  function emit() {
    onChange?.(snapshot());
  }

  // The peer list comes from awareness rather than from the transport's peer
  // ids, because awareness is what carries names and colours. The host is
  // whoever's client id was stamped into `meta` when the room was created.
  function peerList() {
    if (!awareness) return [];
    const hostClient = ymeta?.get('hostClient') ?? null;
    const out = [];
    awareness.getStates().forEach((state, clientId) => {
      const user = state?.user;
      if (!user) return;
      out.push({
        clientId,
        name: user.name || 'anon',
        color: user.color || '#7aa2f7',
        isSelf: clientId === ydoc?.clientID,
        isHost: clientId === hostClient,
      });
    });
    // Stable order: yourself first, then by name.
    out.sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.name.localeCompare(b.name)));
    return out;
  }

  // --- doc plumbing ---------------------------------------------------------

  function publishIdentity() {
    if (!awareness) return;
    awareness.setLocalStateField('user', {
      name: identity.name,
      color: identity.color,
      colorLight: colorLight(identity.color),
    });
  }

  function createDoc() {
    ydoc = new Y.Doc();
    ytext = ydoc.getText('code');
    ymeta = ydoc.getMap('meta');
    // Track nothing by default; y-codemirror.next's undo plugin adds its own
    // sync-config origin as a tracked origin when it mounts, which is precisely
    // "edits this editor made locally" and nothing else.
    undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set() });
    awareness = new Awareness(ydoc);
    publishIdentity();

    // A rename by any peer syncs through `meta`; tell the app about remote ones.
    ymeta.observe((event, tr) => {
      if (event.keysChanged.has('song') && tr.origin === REMOTE) {
        onSongName?.(ymeta.get('song'));
      }
      emit();
    });

    awareness.on('change', emit);
  }

  function wireDoc() {
    ydoc.on('update', (update, origin) => {
      if (origin === REMOTE) return; // don't echo what we just received
      transport?.sendDoc(update);
    });

    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === REMOTE) return;
      const changed = added.concat(updated, removed);
      if (!changed.length) return;
      transport?.sendAwr(encodeAwarenessUpdate(awareness, changed));
    });
  }

  function handleDoc(bytes) {
    Y.applyUpdate(ydoc, bytes, REMOTE);
    if (!synced) {
      synced = true;
      clearTimeout(syncTimer);
      syncTimer = null;
      status = 'connected';
      onStatus?.(`joined “${roomId}”`);
      // The host's song name arrives with the first update.
      const name = ymeta.get('song');
      if (name) onSongName?.(name);
      emit();
    }
  }

  function handleAwr(bytes) {
    applyAwarenessUpdate(awareness, bytes, REMOTE);
  }

  function handlePeerJoin() {
    // Send the newcomer everything we have. Redundant when several peers do it
    // at once, and that's fine — Yjs updates are idempotent. A guest that hasn't
    // synced yet has an empty doc and nothing worth sending, and staying quiet
    // keeps the seeding rule (above) unambiguous.
    if (synced) transport?.sendDoc(Y.encodeStateAsUpdate(ydoc));
    transport?.sendAwr(encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()]));
    emit();
  }

  async function connect() {
    transport = await createTransport({
      roomId,
      password: passphrase,
      onDoc: handleDoc,
      onAwr: handleAwr,
      onPeerJoin: handlePeerJoin,
      onPeerLeave: emit,
      onError: (err) => onStatus?.('multiplayer: ' + (err?.message ?? err), 'error'),
    });
    wireDoc();
  }

  // --- public API -----------------------------------------------------------

  // Host: seed the buffer from the current editor contents, once, *before* the
  // room is advertised, then connect.
  async function host({ roomId: id, passphrase: pass, code = '', songName = null }) {
    if (status !== 'idle') throw new Error('already in a session');
    roomId = id;
    passphrase = pass;
    createDoc();
    ydoc.transact(() => {
      if (code) ytext.insert(0, code);
      ymeta.set('song', songName);
      ymeta.set('hostClient', ydoc.clientID);
      ymeta.set('createdAt', Date.now());
    }, SEED);
    synced = true;
    role = 'host';
    status = 'connected';
    emit();
    onReady?.();
    onStatus?.(`hosting “${roomId}”`);
    await connect();
    emit();
  }

  // Guest: start from an empty Y.Doc and write nothing until the first remote
  // update arrives. The editor is read-only until then — that's both the
  // correctness fix for the seeding race and the right thing to show a user.
  async function join({ roomId: id, passphrase: pass }) {
    if (status !== 'idle') throw new Error('already in a session');
    roomId = id;
    passphrase = pass;
    createDoc();
    synced = false;
    role = 'guest';
    status = 'connecting';
    emit();
    onReady?.();
    onStatus?.(`connecting to “${roomId}”…`);
    await connect();
    syncTimer = setTimeout(() => {
      if (synced) return;
      onStatus?.(`no host responded in “${roomId}” — :leave to go back to solo`, 'error');
    }, SYNC_WARN_MS);
    emit();
  }

  async function leave() {
    if (status === 'idle') return;
    clearTimeout(syncTimer);
    syncTimer = null;
    // Tell peers our cursor is gone before the channel closes, so they don't
    // have to wait out the 30s awareness timeout to lose the ghost.
    try {
      removeAwarenessStates(awareness, [ydoc.clientID], 'leave');
    } catch {
      /* awareness may already be torn down */
    }
    const t = transport;
    transport = null;
    try {
      await t?.leave();
    } catch (err) {
      console.warn('multiplayer leave failed:', err);
    }
    awareness?.destroy();
    undoManager?.destroy();
    ydoc?.destroy();
    ydoc = ytext = ymeta = awareness = undoManager = null;
    status = 'idle';
    role = null;
    roomId = null;
    passphrase = null;
    synced = false;
    emit();
  }

  return {
    // --- state
    get active() {
      return status !== 'idle';
    },
    get status() {
      return status;
    },
    get role() {
      return role;
    },
    get roomId() {
      return roomId;
    },
    get passphrase() {
      return passphrase;
    },
    get synced() {
      return synced;
    },
    snapshot,

    // --- lifecycle
    host,
    join,
    leave,

    // --- editor integration
    // The CodeMirror extension that makes this session live in the editor.
    // Goes into its own Compartment (see editor.js) so joining and leaving
    // reconfigure the running editor instead of rebuilding it.
    collabExtension() {
      if (!ytext) return [];
      return [yCollab(ytext, awareness, { undoManager }), keymap.of(yUndoManagerKeymap)];
    },
    // The text the editor should hold at the moment collab is switched on: the
    // host's own buffer, or nothing at all for a guest awaiting first sync.
    initialText() {
      return ytext ? ytext.toString() : '';
    },
    // Undo/redo scoped to *your* edits, for the vim `u` / `Ctrl-r` delegation.
    undo: () => undoManager?.undo(),
    redo: () => undoManager?.redo(),

    // --- identity + metadata
    setIdentity(next) {
      identity = { ...identity, ...next };
      publishIdentity();
      emit();
    },
    // A rename during a session syncs to everyone through `meta`.
    setSongName(name) {
      if (!ymeta) return;
      ymeta.set('song', name);
    },
    getSongName() {
      return ymeta?.get('song') ?? null;
    },
  };
}
