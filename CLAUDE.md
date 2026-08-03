# OatCycles — agent instructions

A live-coding music app. A human composes in it, often while you are working.
Two things you do here are destructive in ways that are not obvious:

- **Playing a pattern makes real sound out of the machine's speakers**, which
  interrupts whatever the user is composing or listening to.
- **Playing snapshots the editor buffer into `AutoSaves/`.** Typing a test
  snippet and pressing Play leaves your code sitting in the user's snapshot
  history, and pushes theirs closer to being pruned.

Playing no longer writes the user's song file — only `:save` writes
`SavedSongs/`, and an autosave can never overwrite anything. That is a recent
change; before it, a stray Play silently destroyed a real composition. Do not
treat the store as safe to poke at because of it.

## Rule: never make sound, never write to `SavedSongs/` or `AutoSaves/`

**Always open the app with `?agent=1`:**

```bash
open "http://localhost:5173/?agent=1"
```

That is a whole-session mode. Every play is muted at the master output and
every write to disk is suppressed — snapshots, `:save`, renames, deletes — no
matter which control gets pressed, including a mis-aimed click on the normal
Play button. A yellow banner shows while it is on. It is URL-only and never
persisted, so it cannot leak into the user's own session.

**Drive it by script, not by clicking:**

```js
window.oat.silentPlay('s("bd*4")'); // evaluate this code, muted
window.oat.silentPlay();            // evaluate the editor buffer, muted
window.oat.stop();                  // transport down; again = cut what's ringing
window.oat.panic();                 // cut it now, whatever the transport is doing
window.oat.getCode();
window.oat.silent;                  // is the master output muted right now
window.oat.agentMode;               // did this page load with ?agent=1
```

Passing a code string is the safest path: it evaluates that code **without
touching the editor buffer at all**, so there is nothing to overwrite or
restore. Prefer it over editing the document.

Clicking coordinates is the fragile path — that is how the Play button got hit
by accident. Use `window.oat` instead.

## What silent mode does and does not cover

It zeroes superdough's master `destinationGain`, the last node before the
speakers, so the pattern genuinely runs — scheduler, sample downloads and
decoding, unknown-sound errors, highlighting — with nothing audible. The only
thing it cannot verify is audibility itself.

**It does not silence `.midi()`**, which reaches external hardware outside the
audio graph. If a pattern routes to MIDI, do not play it at all.

## Before you finish

If you did modify a song, check `git status`, `SavedSongs/` and `AutoSaves/`,
and say so plainly. `SavedSongs/` holds the user's real work; treat it as their
documents, not fixtures. `AutoSaves/` is gitignored, so `git status` will not
show a stray snapshot of yours — list the directory to check.

## Running the app

Use the preview tooling (`.claude/launch.json` defines `oatcycles-dev`), not a
bare `npm run dev`. Remember to add `?agent=1` to the URL it gives you.
