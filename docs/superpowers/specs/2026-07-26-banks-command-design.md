# `:banks` — browse the sample banks on this machine

## The problem

`:peruse` indexes the banks a *file already names*. There is no way to see what
you have on disk. A folder of samples sitting in the repo is invisible until you
remember its name and type a `samples()` call for it by hand.

`:banks` lists what is on disk, and one click turns a bank into a scratch file
that is already perusing it.

## Scope

- A `samples/` directory at the repo root, scanned by the dev server.
- `:banks` / `:nbanks` — a third panel in the bottom dock, beside `:kyb` and `:mini`.
- Clicking a bank: confirm → autosave the current song → new song seeded with a
  `samples()` call for that bank → `:peruse` run on it immediately.

Out of scope: playing a sound from the panel, editing banks, uploading, and
keyboard navigation inside the panel (`:banks` is mouse-driven; `:peruse` is
where the keyboard work happens).

## 1. `samples/` on disk

A bank is an immediate subdirectory of `samples/`. Two layouts, supported at
once inside the same bank:

```
samples/casio/bd/01.wav    → sound "bd", variant 0   → s("bd").n(0)
samples/casio/hh.wav       → sound "hh", one variant → s("hh")
```

Two levels only — anything deeper is ignored rather than flattened, because a
flattened name has no relationship to the path you would type. Audio is
`.wav .mp3 .ogg .flac .m4a .aif .aiff .webm`; dotfiles and everything else are
skipped. Variants sort by filename, so `01.wav 02.wav` index in the order they
read on disk.

`samples/README.md` documents the layout in the directory itself. `.gitignore`
excludes the audio: a sample library is the user's, not the repo's.

## 2. `vite-banks-plugin.js`

A sibling of `vite-songs-plugin.js`, mounted on both the dev and preview
servers. Three routes:

| Route | Returns |
| --- | --- |
| `GET /api/banks` | `[{ name, sounds, samples }]`, alphabetical |
| `GET /api/banks/<bank>.json` | `{"_base":"/api/banks/casio/","bd":["bd/01.wav",…]}` |
| `GET /api/banks/<bank>/<path>` | that audio file |

The manifest is the shape Strudel's own `samples()` reads, so the generated file
plays for real — the panel is not a listing that lies about what will load.

The `.json` suffix on the manifest route is load-bearing. `:peruse` names its
generated `const` after the last path segment (`bankIdentifier()` in
`src/editor/peruse.js`), so `/api/banks/casio.json` yields `const casio = […]`
where `/api/banks/casio/strudel.json` would yield `const strudel = […]` for
every bank.

The audio route resolves the requested path against the bank directory and
serves it only if it stays inside — the same containment guard the songs plugin
applies to snapshot filenames.

Pure functions (`scanBank`, `manifest`, `resolveInside`) are exported as
`__internals` and unit-tested under `test/`, matching
`test/songs-plugin.test.js`.

## 3. `src/editor/banks.js` — the panel

The third occupant of the bottom dock, mutually exclusive with `#keyboard-ref`
and `#mini-ref`; showing one hides the others. `:banks` shows, `:nbanks` hides,
both registered with their full names as the ex-prefix so `:b` (stock vim's
`:buffer`) is left alone.

`/api/banks` is re-fetched on every show, so a folder dropped in a minute ago
appears without a reload. Each bank renders as a clickable card: name, then
`12 sounds · 47 samples`. With no dev server (a static production build) the
fetch fails and the panel says so rather than showing an empty grid.

## 4. The click

`window.confirm` — the precedent `deleteSong()` already sets for "this is about
to touch your files":

> Autosave “dave1” and peruse “casio” in a new file?

On OK, in order:

1. Session lock check — refuse before anything is created.
2. Autosave the current song.
3. New song named `peruse casio`, deduped to `peruse casio 2` if taken.
4. Buffer seeded with the `samples()` call for that bank.
5. `:peruse` runs, leaving the cursor on the first index const.

Cancel does nothing at all. Step 3 needs `newSong()` in `src/songs/songs.js` to
accept seed code and to dedupe its name — which also fixes `:new foo` twice
silently producing two songs called `foo`.

## 5. Safety

Nothing here makes sound: `:peruse` only writes text, and the seeded file is
never evaluated automatically. Under `?agent=1` the existing `suppressSave()`
blocks the disk write, and in a networked session `sessionLock()` refuses the
new song before it exists.

## Testing

- `node --test` over the plugin's pure functions: both bank layouts, the mixed
  case, extension filtering, empty and missing `samples/`, and a traversal
  attempt on the audio route.
- In-app, under `?agent=1`: `:banks` lists a fixture bank, clicking it seeds a
  new song with the `samples()` line and a `:peruse` block naming the fixture's
  sounds, and `:nbanks` hides the panel.
