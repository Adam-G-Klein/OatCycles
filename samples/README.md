# samples/

Sample banks living on this machine. `:banks` lists whatever is in here, and
clicking a bank opens a new song that already `samples()` it and has a
`:peruse` index of every sound in it.

Drop a folder in and it shows up the next time you type `:banks` — no reload.

## Layout

One folder per bank. Inside a bank, either layout works, and a bank can use
both at once:

```
samples/
  casio/
    bd/
      01.wav        → s("bd").n(0)
      02.wav        → s("bd").n(1)
    hh.wav          → s("hh")
  vinyl/
    crackle.wav     → s("crackle")
```

- A **folder** inside a bank is one sound, and the audio in it are its variants,
  ordered by filename — that's the number `.n()` picks.
- A **file** directly inside a bank is one sound named after the file.
- Two levels deep is the limit. `casio/perc/shakers/01.wav` is not read: a
  flattened name would have no relationship to the path you'd type.
- Readable extensions: `.wav .mp3 .ogg .flac .m4a .aif .aiff .webm`. Anything
  else, and anything starting with a dot, is skipped.
- A bank showing "no audio found" means the folder is empty of those, or its
  audio is a level too deep.

## What's tracked

Nothing but this file — see `.gitignore`. The audio in here is your library,
not the repo's.
