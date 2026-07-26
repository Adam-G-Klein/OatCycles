# Autosaves vs. saved songs

Date: 2026-07-26

## Problem

Playing a pattern writes the editor buffer over the current song file. That is
the only way a song ever reaches disk, so autosave and "save" are the same
action — and a stray play destroys work that was never meant to change.

Split them. Autosaves become timestamped snapshots in their own directory that
can never overwrite anything; an explicit `:save` is the only thing that writes
a song file.

## Storage layout

```
SavedSongs/           tracked in git
  index.json          [{ id, name, file, savedAt }]
  dave1.js            written ONLY by :save, rename, delete
AutoSaves/            gitignored
  dave1_auto_2026-07-26_094133.js
```

`AutoSaves/` is flat and append-only with no manifest: the song name and the
timestamp are both recoverable from the filename, so snapshots can be deleted
by hand without corrupting any state. The old `songs/` directory is copied into
`SavedSongs/` and left on disk as a backup.

Consequence to keep in mind: pressing Play writes an autosave and nothing else.
`SavedSongs/dave1.js` changes when `:save` runs, at no other time.

## Song records

Each song in memory carries both the live buffer and the last known disk
content:

```
{ id, name, code, diskCode, saved, savedAt }
```

- `code` — the editor buffer as of the last autosave. Mirrored to localStorage.
- `diskCode` — exactly what is in `SavedSongs/<file>.js`. Populated at load,
  replaced only by `:save`.
- `saved` — whether a file backs this song at all.

The disk PUT sends `diskCode` for every saved song and the buffer only for the
song being explicitly saved. Without that split, autosaving song A's buffer and
then saving song B would flush A's unsaved edits to A's file — the exact
overwrite this design exists to prevent.

## API

| Route | Purpose |
|---|---|
| `GET/PUT /api/songs` | Unchanged shape, now backed by `SavedSongs/`. PUT carries saved songs only. |
| `POST /api/autosave` | Body `{name, code}`. Server stamps the time, skips the write when the code is byte-identical to the newest snapshot for that name, then prunes that name to its newest 30. |
| `GET /api/autosaves` | `[{file, name, savedAt}]`, newest first. Names only. |
| `GET /api/autosaves/<file>` | One snapshot's code. |

Dedup and pruning live server-side, the side that can list the directory.

## `:save [name]`

- No arg — write the buffer to the current song's file, creating it if the song
  was never saved.
- Name equal to the current name — identical to no-arg.
- A different name — create a new song holding the buffer, make it current,
  write it. The previous song's file is untouched.
- A different name already belonging to another saved song — refused.

## Open menu

Top level lists saved songs plus unsaved buffers (marked `[+]`), then an
`AutoSaves/` folder row. `Enter` on it switches to a flat, newest-first list of
snapshots.

`:` opens a command line at the base of the panel. `:q` pops back to the song
list, or closes the panel at the top level; `Escape` closes it outright from
anywhere. `j/k/gg/G` work in both views. `dd` deletes songs at the top level
and is disabled over snapshots, where pruning is automatic.

`Enter` on a snapshot loads it into the editor. If a song of that name exists it
becomes current, so a following `:save` restores the snapshot into its own file;
otherwise the snapshot arrives as a new unsaved song. `SavedSongs/` is untouched
until that `:save`.

## Out of scope

Deleting individual snapshots from the panel, grouping snapshots into per-song
subfolders, and diffing a snapshot against its saved file. Pruning covers the
first; the second only matters once the flat list gets crowded.
