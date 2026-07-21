# OatCycles

A code-driven music composition environment built on [Strudel](https://strudel.cc),
adding first-class **Vim**, **voice→code transcription**, and **frictionless MIDI
keyboard** support. See [DESIGN.md](DESIGN.md) for the full plan.

## Run it

From the project directory:

```sh
npm install   # first time only
npm run dev    # opens http://localhost:5173 in your browser
```

Then in the app:

- **Ctrl+Enter** (or the ▶ Play button) — evaluate & play the current code
- **Ctrl+.** (or ■ Stop) — stop playback

Audio starts on first interaction (browser autoplay policy). The default pattern
uses the built-in synth, so it plays offline with no sample downloads.

## Layout

```
index.html            # app shell
vite.config.js         # dev server; ignores the vendored upstream clone
src/
  main.js              # boots @strudel/web, wires editor ↔ engine
  editor/editor.js     # CodeMirror 6 setup (vim slots in here at M1)
  style.css
strudel-upstream/      # vendored Strudel clone — reference now, patch target at M4
```

## Requirements

Node.js (installed via Homebrew) and npm. No global tooling beyond that.

## License

AGPL-3.0-or-later (all Strudel-linked code), matching upstream Strudel.
