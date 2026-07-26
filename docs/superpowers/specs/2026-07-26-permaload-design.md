# `:permaload` — rip sample banks into the repository

Date: 2026-07-26

## Problem

Every sound in a song is fetched from someone else's server on every load.
`samples('github:tidalcycles/dirt-samples')` works until GitHub is slow, the
repo moves, or there is no network — and a song that cannot find its sounds is
not a song. The banks a musician actually keeps using should live in this
repository, next to the songs that use them.

`:permaload <spec>` downloads a bank to disk. The song file keeps declaring its
import exactly as it does today — `:peruse` still reads that line — but the
declaration then resolves to local files instead of remote ones.

## Relationship to `:banks`

`:banks` (`vite-banks-plugin.js`) already owns `./samples`. It defines the
on-disk layout, generates each bank's `strudel.json` by scanning it, and serves
both the manifest and the audio:

```
GET /api/banks              → [{ name, sounds, samples }]
GET /api/banks/<bank>.json  → the manifest
GET /api/banks/<bank>/<p>   → one sample
```

`:permaload` rips **into that layout**, so a ripped bank is an ordinary local
bank: it appears in the `:banks` panel, and it plays through the routes that
already exist. This spec adds no second notion of "a local bank" and no second
static route.

Upstream banks are already shaped the way `:banks` scans — `bd/BT0A0A7.wav` is
sound `bd`, variant 0 — so a rip needs no wrapper directory.

## Command

```
:permaload <spec> [sound …]
```

`<spec>` is any form `samples()` accepts: `github:user/repo[/branch]`,
`shabda:…`, or a URL to a `strudel.json`. Trailing arguments restrict the rip
to those sound names; a bare spec rips the whole bank.

The command never edits the buffer. Progress and results go to the status bar.
It is registered next to `:peruse` and `:banks` in `src/editor/editor.js`, full
name as the ex-prefix (`:p` is stock vim's `:print`).

Re-running resumes: sample files already on disk are skipped, so an interrupted
rip continues where it stopped, and adding sounds to an existing bank is just
another `:permaload` with those names.

## Storage layout

```
samples/                     tracked in git
  dirt-samples/
    .permaload.json          sidecar: the upstream manifest and where it came from
    bd/BT0A0A7.wav           ripped audio, upstream relative paths verbatim
```

The bank directory name comes from the spec (`github:tidalcycles/dirt-samples`
→ `dirt-samples`), sanitized to a safe directory name and given a numeric
suffix if that name is already taken by a different spec.

The sidecar is dot-prefixed, so the existing scanner skips it — `isHidden()` in
`vite-banks-plugin.js` already excludes dotfiles from both `scanBank` and
`listBanks`. It holds the upstream manifest verbatim, plus the absolute base
its paths resolve against and the spec that produced it:

```json
{
  "spec": "github:tidalcycles/dirt-samples",
  "manifestUrl": "https://raw.githubusercontent.com/tidalcycles/dirt-samples/main/strudel.json",
  "base": "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/",
  "rippedAt": "2026-07-26T16:40:00.000Z",
  "sounds": { "bd": ["bd/BT0A0A7.wav", "bd/BT0AADA.wav"] }
}
```

Committed to git deliberately: the banks travel with the repo. A full
dirt-samples rip is roughly 200 MB and permanent in history — the named-sounds
form is the everyday one.

## Merged manifest, via the sidecar

A scanned manifest can only name what is on disk, which would make a partial
rip lose the sounds it did not take. The sidecar fixes that without a second
manifest file: `manifest()` merges the sidecar's sound list over the scan, so a
permaloaded bank always advertises the **whole** upstream bank.

Every entry keeps a path relative to the one `_base` the bank already has
(`/api/banks/<bank>/`). Ripped paths hit disk. Un-ripped paths miss, and the
audio route redirects them upstream:

- on `ENOENT`, look up the requested relative path in the sidecar
- if it is a path the sidecar names, `302` to `base + path`
- otherwise `404`, exactly as today

Only paths the sidecar names are redirected, so the route cannot be turned into
an open redirect by an invented URL.

This is why the merge is one file rather than two. Superdough builds every
sample URL as plain `baseUrl + path` (`processSampleMap`,
`packages/superdough/sampler.mjs`) with no escape hatch for an absolute entry,
so a manifest cannot mix a local base and a remote one. Keeping every path
relative and resolving the difference at the route sidesteps that entirely.

Consequences worth stating:

- upstream ordering is preserved, so `n()` indexes match upstream and match
  what `:peruse` prints
- pitched banks (object-valued entries, note → paths) need no special case, as
  the redirect is purely path-based
- upstream paths deeper than the scanner's two levels still play, because their
  paths come from the sidecar rather than from the scan
- a hand-dropped bank with no sidecar behaves exactly as it does today

`GET /api/banks` gains a `spec` field for banks that have a sidecar, and counts
sounds and samples from the merged list rather than the scan alone — otherwise
a bank whose files are three levels deep would report "0 sounds".

## Resolution

`src/sounds/permaload.js` exports `localFirstSamples(spec, …rest)`, wrapping
Strudel's `samples`:

- non-string first argument (an inline map) → passed straight through
- string spec → resolved to its manifest URL and compared against the resolved
  manifest URL of every bank in a once-fetched, cached `/api/banks` listing
- miss → passed straight through; today's remote behavior, unchanged
- hit → `samples('/api/banks/<bank>.json')`

Resolving both sides through the same function means `github:x/y` and
`github:x/y/main` are the same bank, and the full-URL specs in `main.js`'s
`DEFAULT_SAMPLE_BANKS` match directly.

The wrapper is installed in two places: used for the `DEFAULT_SAMPLE_BANKS`
prebake in `src/main.js`, and assigned onto `globalThis.samples` after
`initStrudel()` resolves, which is the scope evaluated song code runs in.
Permaloading the default banks therefore makes boot itself offline-capable.

## Shared spec resolver

`bankUrl()` moves out of `src/editor/peruse.js` into `src/sounds/bank-url.js`,
unchanged in behavior. Three callers need the same resolution: `:peruse`, the
client wrapper, and the rip endpoint. `:peruse` additionally consults the
cached `/api/banks` listing, so perusing a permaloaded bank reads the local
manifest and works offline.

## Server

`vite-permaload-plugin.js`, alongside the existing plugins and registered in
`vite.config.js` for both `configureServer` and `configurePreviewServer`. It
owns ripping — network and writes — while `vite-banks-plugin.js` keeps owning
reading and serving. It imports the sidecar name and reader from the banks
plugin, which is the format's owner.

`POST /api/permaload` with `{ spec, sounds? }`:

1. resolve the manifest URL and fetch it
2. pick the bank directory name; select the requested sounds, or all of them
3. download with fixed concurrency 8 into `samples/<bank>/<upstream path>`,
   skipping files already present and non-empty
4. write `.permaload.json`, merging with any sidecar already there so an
   earlier rip's sounds are not dropped

The response is a stream of NDJSON lines — a 200 MB rip needs a live count in
the status bar, not a silent wait:

```
{"type":"start","bank":"dirt-samples","files":1053}
{"type":"progress","done":64,"skipped":12}
{"type":"done","bank":"dirt-samples","downloaded":1041,"skipped":12,"bytes":214000000,"errors":[…]}
```

Individual download failures are collected into `errors` and reported; they do
not abort the rip.

Path safety: every destination is checked with the banks plugin's
`resolveInside`, so a manifest entry cannot write outside its bank directory.
The plugin writes only under `samples/` and never touches `SavedSongs/`.

## Tests

Node's built-in runner, `npm test`, following `test/banks-plugin.test.js`.

New `test/bank-url.test.js`:

- `github:x/y` and `github:x/y/main` resolve to the same manifest URL
- `shabda:` and plain URLs resolve as before (moved from peruse unchanged)

New `test/permaload.test.js`:

- bank directory naming, including the suffix when a name is taken
- the named-sounds filter selects only those entries
- resume — a second rip skips files already present
- the sidecar merges with an existing one rather than replacing it
- a manifest entry containing `../` is rejected, nothing written outside

Additions to `test/banks-plugin.test.js`:

- `manifest()` merges sidecar sounds over the scan, preserving upstream order
- a sidecar path missing from disk redirects to `base + path`
- a path the sidecar does not name still 404s
- `listBanks` reports merged counts and the spec

## Not doing

- auto-ripping sounds on play
- caching the redirected sounds on the way through
- an uninstall or garbage-collect command
- a bare `:permaload` that rips every bank the buffer declares
