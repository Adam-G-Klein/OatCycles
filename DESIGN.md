# OatCycles — Design Doc

A code-driven music composition environment built on Strudel, adding first-class
**Vim**, **voice→code transcription**, and **frictionless MIDI keyboard** support.

Status: initial design. Grounded in a verified read of upstream Strudel
(`codeberg.org/uzu/strudel`, cloned to `./strudel-upstream`, v0.5.0 monorepo).

---

## 1. Executive summary

Strudel is open source (AGPL-3.0), modular, and explicitly designed to be built on
without forking. We will build **OatCycles** as a plugin-style app that composes
Strudel's published `@strudel/*` packages plus our own feature code, developed
locally in the browser and later wrapped in Electron for distribution.

Firsthand code inspection changed our feature list materially:

| Feature | Original assumption | Verified reality | Real work for us |
|---|---|---|---|
| **Vim** | Missing | ✅ **Already fully implemented** in `@strudel/codemirror` | Expose it well; build advanced UX (`.vimrc`, custom keybinds, macros) later |
| **MIDI keyboard** | Missing | ✅ Input works in Chrome via Web MIDI (`midikeys`); ❌ no note **sustain/duration**; ❌ desktop (Tauri) is output-only | Fix sustain in `superdough` (**core patch**); use Chromium for desktop |
| **Voice → code** | Missing | ❌ Genuinely absent | The one true from-scratch feature. Offline transcription; YIN first |

So the project's center of gravity is **(a) voice transcription** and **(b) a core
patch for MIDI sustain**, not Vim (free) or MIDI wiring (already there).

---

## 2. Verified findings (with sources)

All paths below are in the upstream clone at `./strudel-upstream`.

### 2.1 The plugin seam is real
`packages/web/web.mjs` is an editor-less engine bundle exposing:
- `initStrudel(options)` — boots audio + REPL, returns when initialized
- `Pattern.prototype.play` / `hush()` / `evaluate(code, autoplay)`
- Re-exports `@strudel/core`, `@strudel/webaudio`, `@strudel/mini`, `@strudel/tonal`,
  `@strudel/edo`, `@strudel/transpiler`

It does **not** bundle the editor or MIDI — those are separate packages
(`@strudel/codemirror`, `@strudel/midi`) we add ourselves. This is our foundation:
we own the UI shell and glue, Strudel owns the pattern engine + audio.

### 2.2 Vim is already done
`packages/codemirror/keybindings.mjs`:
- Depends on `@replit/codemirror-vim` `^6.3.0` (also emacs, helix, vscode keymaps).
- `keybindings('vim')` returns the full vim extension.
- Strudel-specific ex-commands already defined: `:w` → evaluate pattern, `:q` → stop,
  `gc` → toggle comment (normal + visual).
- Exports the `Vim` object (`Vim.map`, `Vim.defineEx`, macros via native `q`
  recording) — everything needed for `.vimrc`-style customization is reachable.

Conclusion: Vim is a **selectable keybinding mode**, not a missing feature. Our value-add
is discoverability and advanced config, not the editor integration itself.

### 2.3 MIDI keyboard input works — but notes don't sustain
`packages/midi/midi.mjs` + `packages/midi/input.mjs`:
- Uses the `webmidi` library → `navigator.requestMIDIAccess` (Web MIDI API).
- `midikeys(deviceName)` returns a pattern fed by live note-on/off events.
- **Documented limitation (in-code TODO, midi.mjs ~line 630):** note durations are
  unknown at note-on time, and `superdough` (the audio engine) can't schedule a note
  of unknown length, so held keys don't sustain naturally. Fixing this requires
  `superdough` to support open-ended notes with a `release` triggered on note-off,
  keyed by `midikey`. **This is a core-engine change, not plugin-level.**

### 2.4 Desktop: Tauri build is MIDI-output-only
`src-tauri/` + `packages/desktopbridge/`:
- Native MIDI via Rust `midir` (`Cargo.toml`), bridged through `@tauri-apps/api`.
- `src-tauri/src/midibridge.rs` constructs `midir::MidiOutput` **only** — there is no
  `MidiInput`. Combined with WKWebView lacking Web MIDI, **the Tauri desktop build
  cannot do MIDI keyboard input today.**
- Implication: for our MIDI-keyboard-*input* goal on desktop, we need a Chromium
  runtime (Electron), OR we would have to write a new Rust `MidiInput` bridge.
  → **We choose Electron.** (See §4.)

---

## 3. Licensing (AGPL-3.0) — decisions

- **Your music/content is yours.** AGPL covers the software, not its output. Songs,
  audio, and patterns you produce carry no AGPL obligation. Monetize freely.
- **Obligation trigger:** distributing the app **or** serving it to others over a
  network requires offering *our modified source* under AGPL-3.0. Running locally for
  yourself triggers nothing.
- **Practical stance:** OatCycles is an open project. All our Strudel-linked code is
  AGPL-3.0-or-later. Keep a clean `LICENSE` + per-file headers matching upstream.
- **Watch item:** anything we load into Strudel's process (plugins) is effectively part
  of the AGPL work. A genuinely separate process talking over a socket *could* be
  separately licensed, but we are not relying on that.

---

## 4. Architecture & runtime

```
┌──────────────────────────────────────────────────────────┐
│ OatCycles app (our code, AGPL-3.0)                         │
│                                                            │
│  UI shell ── CodeMirror editor ── Voice panel ── MIDI panel│
│     │            │ (vim mode)        │             │       │
│     │            │                   │             │       │
│  @strudel/web  @strudel/codemirror  our pitch→   @strudel/ │
│  (engine)      (editor + vim)       code module   midi     │
└──────────────────────────────────────────────────────────┘
         runs in Chromium (Chrome in dev, Electron for ship)
```

**Runtime decision: browser in dev, Electron for distribution.**
- Dev: `vite dev` on localhost, opened in Chrome. Zero feature loss (full Chromium =
  Web MIDI + Web Audio + WebGL visualizers all work). Tightest loop.
- Ship: Electron (bundled Chromium) via `electron-vite`. Same Vite output loaded by a
  thin `main.js`; gives us a real app window, native file dialogs (for `.vimrc` and
  sample folders), and distributable binaries.
- **Tauri rejected:** WKWebView has no Web MIDI, and Strudel's own Tauri bridge is
  output-only — MIDI keyboard input would not work without new Rust code.

**Electron gotchas to budget for:** `midi`/`sysex` and microphone are gated behind
`session.setPermissionRequestHandler` in the main process (automatic prompts in a plain
browser). Small, one-time.

---

## 5. Feature designs

### 5.1 Vim (mostly free)
**Phase 1 (near-zero effort):** wire `keybindings('vim')` into our editor config; add a
settings toggle. Inherit `:w`/`:q`/`gc` for free.
**Phase 2 (real UX work):** a `.vimrc`-style config surface. On desktop (Electron) read
an actual file from disk; in browser, a settings text area persisted to
localStorage. Parse a subset of vimrc into `Vim.map` / `Vim.mapCommand` calls. Macros
(`q`) already work via the underlying extension — expose/document them.
**Risk:** low. The hard part (modal editing engine) is a maintained dependency.

**OatCycles vim overrides (living reference).** Everything OatCycles layers on top of
stock `@replit/codemirror-vim`. Keep this table current whenever a binding is added —
before adding a new ex-command, confirm it doesn't collide with a stock one (stock
o-prefixed commands are only `omap`/`onoremap`/`omapclear`; there is no stock `open`,
`name`, or `edit`).

| Binding | Mode | Action | Defined in |
|---|---|---|---|
| `:w` | ex | Play / evaluate the buffer (mirrors Cmd+Enter) | `editor/editor.js` |
| `:q` | ex | Stop playback (mirrors Cmd+.) | `editor/editor.js` |
| `:o` | ex | Open the songs side panel | `editor/editor.js` → `songs/songs.js` |
| `:name <filename>` | ex | Rename the current song | `editor/editor.js` → `songs/songs.js` |
| `:new [name]` | ex | Start a fresh (blank) song; auto-names if omitted | `editor/editor.js` → `songs/songs.js` |
| `gc` | normal + visual | Toggle line comment | `editor/editor.js` |
| `kj` | insert | Escape to normal mode | `editor/editor.js` |

Inside the songs panel (a plain DOM element, not CodeMirror — its keys are handled by a
local keydown listener, not the vim extension): `j`/`k` move, `gg`/`G` jump to ends,
`Enter` opens the highlighted song, `dd` deletes it (with confirm), `Esc` closes.

### 5.1b Song file system (disk-backed persistence)
Answers open question §8.2. A collapsible right-side panel lists saved songs, persisted
as **real text files on disk** with `localStorage` as a fast boot cache / offline
fallback.
- **On-disk layout (`./songs`):** one `<name>.js` text file per song holding exactly the
  code (human-readable, git-friendly), plus `index.json` — a manifest of
  `[{id, name, file, updatedAt}]`. Served by a small Vite dev/preview middleware
  (`vite-songs-plugin.js`) at `GET/PUT /api/songs`. See `src/songs/storage.js`.
- **Auto-save on play / move:** every evaluate flushes the buffer into the current song;
  also flushed just before switching/creating/renaming/deleting so nothing typed since
  the last play is lost. Each save writes `localStorage` synchronously and the disk files
  (debounced), with a `sendBeacon` flush on page unload so the last edit survives a close.
- **Load on session start:** the app reads the on-disk songs first (source of truth) and
  refreshes the `localStorage` mirror. If the server is unreachable (a plain static
  `vite build`) it falls back to the mirror; if the disk is empty but the mirror has
  songs, they're migrated to disk once.
- **Current file** shown in the topbar; double-click (or `:name`) to rename (renames the
  file on disk too).
- **Open** replaces the buffer with the selected song's code (saving the current first).
**Why disk:** `localStorage` alone is evicted when the browser is cleared — songs were
lost that way. Files on disk survive browser resets and can be edited/backed-up outside
the app. Electron (M4) can reuse the same `/api/songs` shape against the native FS.
**Risk:** low. Dev-server middleware + a thin fetch layer; no engine coupling.

### 5.2 MIDI keyboard (integration exists; sustain is the work)
**Phase 1:** surface `midikeys()` in the UI — device picker, "insert midikeys snippet",
live activity indicator. Works today in Chrome.
**Phase 2 (core patch, the real work):** implement open-ended note sustain in
`superdough`. **v1 scope (decided): simple — a long/indefinite note started on note-on
and `release`d on note-off.** No full ADSR-release or effect-persistence machinery yet.
Mechanically: on note-on, start a voice flagged indefinite-duration and store a
reference keyed by `midikey`; on note-off, look it up and trigger release. This removes
the fixed-`noteLength` workaround and gives true keyboard feel for held keys. **This
forces a core fork/patch** — keep the `strudel-upstream` clone as a patchable
vendored dep, not just an npm version.
**Risk:** medium. Touches voice lifecycle; needs care around timing and voice stealing,
but the v1 scope keeps it contained.

### 5.3 Voice → code transcription (the from-scratch feature)
**Use case:** sing a ~15s melody → stop → ≤1s later, editable Strudel code appears.
This is **offline/batch**, not live pattern — architecturally forgiving.

**Quality bar (decided): proof-of-concept.** v1 does not need to be robust or musically
polished — a recognizable, editable transcription is enough. Optimize for
understandability over accuracy.

**Build approach (decided): clean-room, ground-up.** We implement each stage ourselves so
every piece of the pipeline is understood and owned. Voice Composer is a *conceptual*
reference only — do not copy its code. (This also sidesteps the license question.)

Pipeline:
1. **Capture** — `getUserMedia` → record to buffer (MediaRecorder / AudioWorklet).
2. **Pitch tracking** — **YIN (autocorrelation)** as default: fast, monophonic-voice
   friendly, comfortably inside the 1s budget for 15s of audio. Optional **CREPE
   (TF.js)** toggle for accuracy at higher latency (note: browser CREPE is a reduced
   model, lower accuracy than the paper).
3. **Segmentation + quantization** — *this is the actual engineering.* Convert the
   continuous f0 curve into discrete notes: onset/offset detection, pitch→note-name,
   snap to a chosen tempo/grid, collapse to rests where silent.
4. **Code emission** — render to a Strudel mini-notation string (e.g.
   `note("c4 e4 g4 ...")`) inserted at the cursor for immediate editing.

**Reference/reuse:** *Voice Composer* (Show HN 46581431) already does browser pitch
detection (CREPE/YIN/FFT/AMDF) with Strudel/Tidal output, fully client-side. Evaluate
its license before reusing; otherwise use as an architecture reference.
**Risk:** medium-high, concentrated in step 3 (musical quality of the transcription),
not the pitch math.

---

## 6. Project scaffold & dev environment

```
oatcycles/
  package.json            # deps: @strudel/web, @strudel/codemirror, @strudel/midi, codemirror/*
  vite.config.js
  index.html
  src/
    main.js               # initStrudel(), mount editor, wire panels
    editor/               # CodeMirror setup + vim config
    voice/                # capture, YIN, segmentation, code emit
    midi/                 # device picker + midikeys UX
  electron/               # (phase 2) main.js, preload.js, permission handlers
  strudel-upstream/       # vendored clone for core patches (superdough sustain)
```

Dev loop: `pnpm dev` → Chrome at localhost. Ship loop (later): `electron-vite` build.

---

## 7. Phased roadmap

- **M0 — Scaffold:** Vite app on `@strudel/web`, editor mounted, a pattern plays. Prove
  the plugin seam end-to-end in the browser.
- **M1 — Vim:** wire `keybindings('vim')` + settings toggle. (Cheap win, validates loop.)
  transcription quality.
- **M2 — MIDI UX:** device picker + `midikeys` snippet surface (Chrome).
- **M3 — Voice v1:** capture → YIN → naive segmentation → code insert. Iterate on
- **M4 — Electron wrap:** distributable desktop app, permission handlers, `.vimrc` file.
- **M5 — MIDI sustain (core patch):** `superdough` open-ended notes. Vendored fork.
- **M6 — Vim advanced:** `.vimrc` parsing, custom keybinds, macro UX.

---

## 8. Decisions & open questions

**Resolved:**
- ✅ **Superdough sustain scope:** simple — long note started on note-on, released on
  note-off. No full ADSR-release/effect-persistence in v1. (§5.2)
- ✅ **Voice pipeline sourcing:** clean-room, ground-up; Voice Composer is reference
  only. (§5.3)
- ✅ **Transcription quality bar:** proof-of-concept; understandability over accuracy. (§5.3)

- ✅ **Persistence/format:** songs saved as text files on disk (`./songs/<name>.js` +
  `index.json` manifest) via a Vite dev/preview API, with `localStorage` as a boot cache
  / offline fallback. Auto-saved on play and before any switch/create/rename/delete.
  In-browser song panel with vim navigation. (§5.1b) Electron (M4) can reuse the same
  `/api/songs` shape against the native FS.

**Still open:**
1. **Core-patch maintenance:** M4 patches `superdough`. How do we track upstream? (Vendor
   + patch set, or maintain a real fork branch.) — defer until M4.
