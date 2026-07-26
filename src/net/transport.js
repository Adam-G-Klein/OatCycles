// Networked play — the wire.
//
// Two interchangeable transports behind one tiny interface, so session.js only
// ever deals in "send these bytes to everyone / to that peer".
//
//   trystero  — the real thing. WebRTC data channels between peers, with the
//               signalling that bootstraps them riding on public Nostr relays.
//               Nothing here is infrastructure we operate.
//   local     — a BroadcastChannel between tabs of the same browser. No network
//               at all. Enabled with ?net=local, which makes two-tab testing of
//               the editor integration (seeding, undo, cursors, presence)
//               possible without depending on a relay.
//
// Transport interface (see createTrysteroTransport for the canonical shape):
//   selfId                      string, stable for this tab
//   sendDoc(bytes, target?)     Uint8Array; target omitted = broadcast
//   sendAwr(bytes, target?)     same, for awareness
//   peers()                     array of connected peer ids
//   leave()                     tear down
// Inbound traffic arrives through the onDoc/onAwr/onPeerJoin/onPeerLeave
// callbacks passed to the factory.

// Strategy selection, behind one constant so swapping relays when Nostr gets
// flaky is a one-line change.
//
// Nostr is primary; MQTT is the documented fallback. (Public BitTorrent
// trackers have been shedding WSS support, so the torrent strategy isn't worth
// carrying.) As of trystero 0.25 each strategy is its own npm package rather
// than a subpath — `trystero/mqtt` and friends now throw a deprecation error —
// so switching is:
//
//     npm i @trystero-p2p/mqtt
//     STRATEGIES.mqtt = () => import('@trystero-p2p/mqtt');
//     const STRATEGY = 'mqtt';
//
// It stays uninstalled by default because the MQTT client is ~350 kB and
// changing the constant means rebuilding anyway.
//
// The import is dynamic so no WebRTC or relay code is in the main bundle until
// someone actually starts a session.
const STRATEGY = 'nostr';

const STRATEGIES = {
  nostr: () => import('@trystero-p2p/nostr'),
};

// Namespaces every OatCycles room, so we never collide with another Trystero
// app that happens to pick the same room name.
const APP_ID = 'oatcycles';

// Trystero action names are length-capped (32 bytes in 0.25.x, and it has been
// as low as 12 historically). Four characters each, with room to spare.
const DOC_ACTION = 'ydoc';
const AWR_ACTION = 'yawr';

// Trystero hands binary payloads back as Uint8Array already, but a transport
// that round-trips through structured clone can produce an ArrayBuffer. Yjs
// wants a Uint8Array either way.
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

export async function createTrysteroTransport({
  roomId,
  password,
  onDoc,
  onAwr,
  onPeerJoin,
  onPeerLeave,
  onError,
}) {
  const { joinRoom, selfId } = await STRATEGIES[STRATEGY]();

  // `password` gives end-to-end encryption of everything on the wire, which is
  // what lets the room *name* be memorable and guessable.
  const room = joinRoom({ appId: APP_ID, password }, roomId, {
    onJoinError: (details) => onError?.(new Error(details?.error || 'failed to join room')),
  });

  const docAction = room.makeAction(DOC_ACTION);
  const awrAction = room.makeAction(AWR_ACTION);

  docAction.onMessage = (data, ctx) => onDoc?.(toBytes(data), ctx.peerId);
  awrAction.onMessage = (data, ctx) => onAwr?.(toBytes(data), ctx.peerId);

  room.onPeerJoin = (peerId) => onPeerJoin?.(peerId);
  room.onPeerLeave = (peerId) => onPeerLeave?.(peerId);

  // A send to a peer that vanished mid-flight rejects; that's ordinary churn,
  // not something to surface. CRDT convergence repairs it on the next update.
  const send = (action) => (bytes, target) =>
    action.send(bytes, target ? { target } : undefined).catch((err) => {
      console.warn('multiplayer send failed:', err);
    });

  return {
    selfId,
    sendDoc: send(docAction),
    sendAwr: send(awrAction),
    peers: () => Object.keys(room.getPeers()),
    leave: () => room.leave(),
  };
}

// --- BroadcastChannel transport (?net=local) --------------------------------
//
// Same interface, same-machine only. Presence is a three-message handshake:
// a joiner announces itself, everyone already present replies with a "here",
// and leavers announce a "bye" (with a pagehide fallback for a closed tab).

export async function createLocalTransport({ roomId, onDoc, onAwr, onPeerJoin, onPeerLeave }) {
  const selfId = 'local-' + Math.random().toString(36).slice(2, 10);
  const channel = new BroadcastChannel(`oat.net.${roomId}`);
  const known = new Set();

  const post = (msg) => channel.postMessage(msg);

  channel.onmessage = ({ data: msg }) => {
    if (!msg || msg.from === selfId) return;
    // Targeted messages are filtered by the receiver — BroadcastChannel has no
    // per-recipient addressing.
    if (msg.to && msg.to !== selfId) return;

    switch (msg.t) {
      case 'join':
        post({ t: 'here', from: selfId, to: msg.from });
      // fall through — a joiner is also a new peer to us
      case 'here':
        if (!known.has(msg.from)) {
          known.add(msg.from);
          onPeerJoin?.(msg.from);
        }
        break;
      case 'bye':
        if (known.delete(msg.from)) onPeerLeave?.(msg.from);
        break;
      case 'doc':
        onDoc?.(toBytes(msg.bytes), msg.from);
        break;
      case 'awr':
        onAwr?.(toBytes(msg.bytes), msg.from);
        break;
    }
  };

  const bye = () => post({ t: 'bye', from: selfId });
  window.addEventListener('pagehide', bye);

  post({ t: 'join', from: selfId });

  return {
    selfId,
    sendDoc: (bytes, target) => post({ t: 'doc', from: selfId, to: target, bytes }),
    sendAwr: (bytes, target) => post({ t: 'awr', from: selfId, to: target, bytes }),
    peers: () => [...known],
    leave: () => {
      bye();
      window.removeEventListener('pagehide', bye);
      channel.close();
    },
  };
}

// Which transport this page uses. ?net=local swaps in the BroadcastChannel one
// for two-tab testing; everything else gets the real network.
export function isLocalMode() {
  try {
    return new URLSearchParams(window.location.search).get('net') === 'local';
  } catch {
    return false;
  }
}

export function createTransport(opts) {
  return isLocalMode() ? createLocalTransport(opts) : createTrysteroTransport(opts);
}
