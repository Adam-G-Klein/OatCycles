# OatCycles — Networked Play (Design Doc)

Simultaneous multi-peer editing of a single OatCycles buffer, peer-to-peer, with no
server we host and no accounts. Companion to `DESIGN.md`; assumes its architecture
(plugin-on-`@strudel/web`, CodeMirror 6 editor, panel-per-feature).

Status: design. Grounded in a read of the current `src/` and of upstream Strudel
(`./strudel-upstream`).

---

## 1. Executive summary

**What syncs:** the document and presence (cursors, selections, names). **Not the
clock.**

**Who makes sound:** every peer, locally and independently. Each person's Cmd+Enter
evaluates on their own engine only. Nobody can start, stop, or re-evaluate anyone
else's audio — remotely triggering playback is explicitly out of scope, which removes
an entire class of protocol and an entire class of live-set disaster.

**Transport:** [Trystero](https://github.com/dmotz/trystero) over Nostr relays. WebRTC
data channels between peers; the signaling that bootstraps them rides on public
infrastructure nobody in this project operates.

**Consequence to be clear-eyed about:** with no clock sync, two peers running the same
code hear it at different cycle phase. This design targets **co-writing** — two or more
people building a pattern together, each auditioning it on their own machine — not
same-room synchronized jamming. Anyone wearing headphones in different cities is served
well; two laptops on one table will sound like a canon. §9 documents the forward hook
that upgrades this later without redesign.

**Effort:** the shared-document core is small (Yjs is a drop-in for CodeMirror). The
work is in the seams — undo, song switching, disk persistence, and the seeding race.

---

## 2. Decisions (locked)

| Question | Decision |
|---|---|
| What syncs | Document + presence. Not the clock, not playback state. |
| Audio model | Model B — every peer evaluates and plays locally, independently. |
| Remote triggering | None. No peer can cause audio on another machine. |
| Transport | Trystero (WebRTC), Nostr strategy, passphrase-encrypted. |
| Entry point | Expandable **Multiplayer** dropdown in the topbar. |
| Session scope | One session = one room = one shared song document. |
| Disk persistence | Host only. Guests are memory-only until they leave. |

---

## 3. Architecture

Three layers, cleanly separable:

```
  CodeMirror EditorView
        │  yCollab extension (in a Compartment, like vim)
        ▼
  Y.Doc ── ytext 'code'   ── the buffer
        ├─ ymap  'meta'   ── song name, host id, created-at
        └─ awareness      ── peer name, color, cursor/selection
        │  binary updates (Uint8Array)
        ▼
  Trystero room ── WebRTC data channels ── peers
        │  signaling only
        ▼
  Public Nostr relays (no OatCycles infrastructure)
```

**Yjs** is a CRDT: concurrent edits converge to the same result regardless of arrival
order, with no server arbitrating. **Trystero** is a thin room abstraction over WebRTC
that borrows public infrastructure for peer discovery. Neither requires anything hosted.

### 3.1 New dependencies

```
yjs                 CRDT core
y-codemirror.next   CodeMirror 6 binding + remote cursors + undo manager
y-protocols         awareness encoding
trystero            WebRTC rooms over public signaling
```

### 3.2 New files

```
src/net/session.js   Y.Doc + Trystero wiring; the whole network layer
src/net/panel.js     the topbar Multiplayer dropdown
src/net/identity.js  peer name, color, room-name generation
src/editor/setup.js  basicSetup minus history() (see §5.2)
```

`session.js` exports a `setupSession()` that follows the existing panel convention —
DOM elements and callbacks in, an imperative API out, exactly like
`setupMidiPanel` ([midi.js:47](src/midi/midi.js:47)) and `setupSongsPanel`
([songs.js:53](src/songs/songs.js:53)).

---

## 4. The network layer

### 4.1 Trystero wiring

```js
import { joinRoom } from 'trystero/nostr';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';

const room = joinRoom({ appId: 'oatcycles', password: passphrase }, roomId);
const [sendDoc, onDoc] = room.makeAction('ydoc');
const [sendAwr, onAwr] = room.makeAction('yawr');
```

The strategy is a single import line — `trystero/nostr`, `trystero/mqtt`,
`trystero/torrent`. Keep it behind one constant so falling back to another strategy is a
one-character change if relays get flaky. Nostr is the primary; MQTT is the fallback.
(Public BitTorrent trackers have been shedding WSS support, so the torrent strategy is
last resort.)

`password` gives end-to-end encryption of room traffic, which means the room *name* can
be memorable and guessable — the passphrase is what actually gates entry.

### 4.2 Sync protocol

Deliberately simpler than the standard `y-protocols/sync` handshake, because a code
buffer is a few kilobytes and the round-trip savings aren't worth the state machine:

- **On peer join** → send that peer the full document: `Y.encodeStateAsUpdate(ydoc)`.
- **On local update** → broadcast the incremental update to all peers.
- **On receive** → `Y.applyUpdate(ydoc, update, REMOTE_ORIGIN)`.

Yjs updates are idempotent and commutative, so redundant full-state sends are harmless
and ordering doesn't matter. The `REMOTE_ORIGIN` tag is load-bearing: it's what keeps
remote edits out of your undo stack (§5.2) and stops the update handler from echoing
received changes back out.

Awareness rides a second action, re-broadcast on every local awareness change and on
peer join, with the standard 30s timeout pruning ghosts.

**Gotcha to verify at wiring time:** Trystero caps action names at a small byte length
(12, last time it mattered). Keep them to four characters as above.

### 4.3 The seeding race — the one that will actually bite

If the host seeds the Y.Doc with the current song *and* a guest seeds theirs with
anything at all, both inserts are legitimate CRDT operations and the merge result is
**both documents concatenated**. This is the classic Yjs footgun and it looks like data
corruption when it happens.

The rule:

- The **host** seeds `ytext` from the current editor buffer, once, before the room is
  advertised.
- A **guest** starts from an empty `Y.Doc` and must never write to it before the first
  remote update arrives. The editor is **read-only with a "connecting…" state** until
  then, which is both the correctness fix and the right UX.

Guest sync completion = first `ydoc` action received, not `onPeerJoin`.

---

## 5. Editor changes

### 5.1 The collab compartment

`yCollab(ytext, awareness, { undoManager })` goes into its own `Compartment`, mirroring
the vim compartment at [editor.js:207](src/editor/editor.js:207), so joining and leaving
a session reconfigures the live editor instead of rebuilding it. Same `setVimMode`
pattern, new `setCollab(session | null)`.

### 5.2 Undo — must be fixed, not worked around

[editor.js:216](src/editor/editor.js:216) uses `basicSetup`, which bundles CodeMirror's
stock `history()`. Under a CRDT that history is *wrong*: it's a linear log of document
states, so pressing `u` will happily undo your collaborator's typing.

Two changes:

1. **Expand `basicSetup` into `src/editor/setup.js`** — copy the definition from the
   `codemirror` package verbatim and delete exactly two entries: `history()` and
   `...historyKeymap`. Use this everywhere instead of `basicSetup`. Undo now comes from
   Yjs's `UndoManager`, which is scoped by transaction origin and therefore undoes only
   *your* edits.
2. **Rebind vim's `u` / `Ctrl-r`.** These live inside `@replit/codemirror-vim`, not in
   our keymap, so they need `Vim.defineAction` + `Vim.mapCommand` alongside the existing
   `gc` binding at [editor.js:131](src/editor/editor.js:131).

Solo mode still needs normal undo, so the actions delegate on a module-scoped flag —
the same shape as the existing `handlers` object at
[editor.js:102](src/editor/editor.js:102):

```js
Vim.defineAction('oatUndo', (cm) => (session.active ? yUndo(cm.cm6) : undo(cm.cm6)));
```

For the non-vim path, `y-codemirror.next` exports `yUndoManagerKeymap` — add it inside
the collab compartment so it's only live during a session.

### 5.3 `setCode()` must not fire during a session

[editor.js:249](src/editor/editor.js:249) replaces the whole buffer, and the songs panel
calls it on every open. Inside a session that isn't "I opened a song," it's "I replaced
everyone's work." While a session is active:

- Song open / new / copy are **disabled** in the panel and their vim commands report
  `in session — :leave to switch songs`.
- Rename stays allowed and syncs through `ymap('meta')`.
- Delete is disabled for the session song specifically.

### 5.4 What is already safe (verified)

- **Snippet insertion.** `insertAtCursor` ([editor.js:238](src/editor/editor.js:238))
  goes through `view.dispatch`, so MIDI note-entry and voice-transcribed snippets sync
  for free with no changes.
- **Playback highlighting.** [highlight.js:48](src/editor/highlight.js:48) remaps its
  marks through `tr.changes` on every doc change, and remote edits arrive as ordinary
  transactions — so boxes stay pinned to the right characters while a collaborator types
  above your cursor. The `${from}:${to}` mark ids are assigned at eval time and matched
  against `hap.context.locations` from the same eval, so remapping doesn't break lookup.
  No work needed.
- **Formatting.** `:f` is a whole-buffer replace, which Yjs diffs into a minimal
  changeset. It's disruptive-but-correct if two people format at once. Leave it enabled.

---

## 6. Persistence

The current model auto-saves the buffer into the current song on every play
([main.js:206](src/main.js:206)), and `storage.js` PUTs the entire song list to
`/api/songs`. With multiple peers each running their own dev server, that's two machines
writing divergent copies of a file they both think they own.

| Role | During session | On leave |
|---|---|---|
| Host | Autosave-on-play continues, writing the session song to `./songs` as usual. | Nothing special; the song is already theirs. |
| Guest | **No disk writes at all.** Autosave is suppressed while `session.role === 'guest'`. | Buffer is saved as a **new local song**, named `<room> (from <host>)`, so nothing is lost. |

Before hosting or joining, the local buffer is auto-saved first — same guarantee the
songs panel already makes before any switch/create/rename/delete.

---

## 7. UI: the Multiplayer dropdown

A new topbar control, sitting between `#voice` and `#songs-toggle` in
[index.html:40](index.html:40), following the existing `<div id="...">`-of-controls
convention.

**Collapsed (idle):** `👥 Multiplayer`
**Collapsed (connected):** `👥 warm-tidal-fox · 3` with a status dot in the peer's own
color.

**Expanded** — a dropdown panel anchored under the button:

```
┌─ Multiplayer ───────────────────────────┐
│ Your name  [ adam            ]  ● color │
│                                         │
│ ── Host ───────────────────────────────  │
│ Room       warm-tidal-fox      [copy]   │
│ Passphrase ••••••••••••        [copy]   │
│              [ Host session ]           │
│                                         │
│ ── Join ───────────────────────────────  │
│ Room       [                 ]          │
│ Passphrase [                 ]          │
│              [ Join session ]           │
└─────────────────────────────────────────┘
```

Once connected the two forms collapse to a peer list (name + color dot + a marker on the
host) and a **Leave session** button.

- Room names are generated as memorable word triples (`warm-tidal-fox`) from a small
  wordlist in `identity.js`. Passphrases are random and separate — the room name is a
  handle, the passphrase is the key.
- One **copy button** puts `room · passphrase` on the clipboard as a single string that
  the Join form also accepts pasted whole. This is the difference between "text your
  friend two fields" and "text your friend one thing."
- Display name and color persist in `localStorage` (`oat.peerName`, `oat.peerColor`),
  matching how the vim setting is handled at [main.js:111](src/main.js:111).
- Vim equivalents, registered with the others in `registerVimCommands`:
  `:host`, `:join <room> <pass>`, `:leave`.
- Status messages route through the existing `setStatus` topbar element.

### 7.1 "An editor that behaves optimally for multiplayer"

Entering a session flips six things at once:

1. `yCollab` on — remote cursors and selections, labelled with peer names.
2. Undo switches to the Yjs `UndoManager` (§5.2).
3. Song open/new/delete disabled in the panel (§5.3).
4. Disk autosave suppressed for guests (§6).
5. **A visible accent** — a 2px border on the editor in your own peer color, plus the
   room name in the topbar. Cheap, and it eliminates the "wait, am I typing into someone
   else's file?" hesitation that otherwise costs a beat every time you look up.
6. Guests: read-only until first sync lands, with a `connecting…` status (§4.3).

Leaving reverses all six.

---

## 8. Trust, privacy, and what a peer can do to you

**Joining a session is a code-execution trust decision.** A peer can type anything into
the shared buffer, and when you press Cmd+Enter, Strudel's transpiler evaluates it as
JavaScript in your browser session. There is no sandbox between "a collaborator's text"
and "code running on your machine with your app's privileges" — including Web MIDI and
microphone access if you've granted them.

This is inherent to a shared-code-buffer design and is not fixable with a technical
control worth building at this scale. The mitigations are honest ones:

- Share the passphrase only with people you'd hand your laptop to.
- Read the buffer before evaluating when someone unexpected is in the room.
- The peer list is always visible in the topbar so an unexpected joiner is noticeable.

Two smaller notes:

- **IP exposure is inherent to WebRTC.** Peers learn each other's addresses when the
  data channel is established. Unavoidable without a relay we'd have to host.
- **Signaling metadata is public.** The room identifier is visible on public relays even
  though the traffic is encrypted, so don't post room names anywhere public.

---

## 9. Non-goals, and the forward hook

**Not in scope:** clock sync, remote playback triggering, shared audio output, voice
chat, persistence of session history, more than ~8 peers.

The consequence of no clock sync, stated once more plainly: peers hear the same pattern
at different phase, and drift. Fine for co-writing on headphones; wrong for a shared
acoustic space.

If that changes, the upgrade path is already open and does **not** need a core patch —
which was the pleasant surprise from reading upstream:

- `initStrudel(options)` spreads its options straight through to the repl
  ([web.mjs:36](strudel-upstream/packages/web/web.mjs:36)).
- `repl({ sync: true })` swaps the default `Cyclist` for `NeoCyclist`
  ([repl.mjs:74](strudel-upstream/packages/core/repl.mjs:74)).
- `NeoCyclist` exposes **`setCycle(cycle)`**
  ([neocyclist.mjs:77](strudel-upstream/packages/core/neocyclist.mjs:77)), which the base
  `Cyclist` does not — it keeps cycle position in private fields with no setter.
- Verified present in the installed `@strudel/web@1.3.0` bundle, not just upstream.

So a future clock milestone is: NTP-style offset estimation over the existing Trystero
data channel, host broadcasts "cycle N at host-time T," each peer converts to local time
and calls `setCycle`. Two caveats for that day: `NeoCyclist` coordinates via a
`SharedWorker` (per-origin, so it syncs tabs on one machine, not across machines — we'd
use it purely for the `setCycle` handle), and it's unsupported on mobile Chrome, where
the repl silently falls back to `Cyclist`.

**Do not set `sync: true` now.** It changes the scheduler for no present benefit.

---

## 10. Phasing

- **N0 — Undo groundwork.** `src/editor/setup.js` (basicSetup minus history), vim
  `u`/`Ctrl-r` delegating through a flag. Ships solo-mode-identical; nothing user-visible.
- **N1 — Local two-tab collab.** Yjs + `yCollab` in a compartment, wired over a
  throwaway `BroadcastChannel` instead of the network. Proves the editor integration —
  seeding, undo, cursors — with zero transport risk. Two tabs, same machine.
- **N2 — Trystero transport.** Swap `BroadcastChannel` for the real room. Host/join over
  the internet. This is the milestone where it's genuinely useful.
- **N3 — The panel.** Topbar dropdown, peer list, names and colors, vim commands, the
  session-mode editor accent.
- **N4 — Session hygiene.** Guest disk-write suppression, leave-and-save-as-new-song,
  song-panel locking, reconnect handling.

N0–N2 is the bulk of the value and is a couple of days of real work. N3 is UI. N4 is the
unglamorous correctness pass that determines whether anyone loses work.

---

## 11. Open questions

1. **Reconnect semantics.** A guest whose WebRTC connection drops mid-session still holds
   a complete Y.Doc. Auto-rejoin the same room and let CRDT convergence do the repair, or
   drop to solo mode with a snapshot? Leaning auto-rejoin with a bounded retry, since
   convergence is exactly what CRDTs are for.
2. **Host departure.** The host holds no privileged document state — the doc is fully
   replicated — but they are the only disk writer. If the host leaves, does the session
   end, or does a guest get promoted to writer? Simplest v1: session continues, everyone
   is a guest, everyone saves locally on leave.
3. **Nostr relay reliability.** Public relays come and go. Do we pin a relay list, or
   accept the defaults and expose the strategy as a setting when it first bites?
4. **Awareness under vim.** Remote cursor widgets alongside vim's block cursor and visual
   selections — needs a visual pass; likely just CSS, but worth checking in N1.

---

## 12. Licensing

`DESIGN.md` §3 already flags that serving the app to others over a network triggers the
AGPL-3.0 source-offer obligation, and notes it as a watch item. Networked play is what
converts that from hypothetical to live: a remote peer interacting with our modified
Strudel over a network is squarely within AGPL §13.

Given the project's stated stance — open, AGPL-3.0-or-later throughout — this costs
nothing. The practical requirement is that a session offers peers a way to obtain the
source. A repository link in the Multiplayer dropdown covers it.
