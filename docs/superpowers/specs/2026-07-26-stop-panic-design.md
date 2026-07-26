# Stop, pressed twice, cuts everything

## The problem

`hush()` stops the scheduler. That stops *new* events from being triggered, and
for most patterns it is indistinguishable from silence. But a voice that is
already sounding when the transport goes down keeps sounding: a long release, a
slow pad, a reverb tail, a sample that is minutes long. Stop looks like it did
nothing.

There is no gesture in the app for "I need silence now".

## The design

### Stop becomes two-stage

`stop()` branches on whether the transport is running:

- **running** (`scheduler.started`) → `hush()`, status `stopped`. Unchanged.
- **already stopped** → **panic**: cut every sound still ringing.

Every route into stop shares this: the ■ Stop button, `Cmd+.`, vim `:q`, and
`window.oat.stop()`. `window.oat.panic()` is also exposed, so the panic can be
driven and verified directly without depending on transport state.

A first press when nothing has ever played is a harmless no-op panic.

Two-stage rather than always-panic: the ordinary Stop is the common case, and
tearing the audio graph down on every stop would be both wasteful and a
behaviour change to something that already works.

### Audio panic — `src/panic.js`

Alongside `src/silent.js`, which owns the same part of the graph (the master
output).

1. Ramp `destinationGain` to 0 over 30ms. `cancelScheduledValues()` plus
   `setValueAtTime(currentValue)` first, so the fade starts from wherever the
   gain actually is — it may be mid-ramp from a `duck()` or from silent mode.
2. Await the fade.
3. Call `resetGlobalEffects()` from `@strudel/web`.

`resetGlobalEffects()` disconnects every orbit and every bus, rebuilds the
master chain, and clears the analysers that `.scope()`/`.spectrum()` read. A
voice that was mid-flight is left connected to nothing: it plays out its
scheduled life inaudibly and is collected.

**Why teardown rather than stopping each voice.** superdough tracks live voices
in a private `activeSoundSources` map and exports no stop-all.
`resetGlobalEffects()` is superdough's own supported teardown, and it is
`controller?.reset()` — a no-op when audio was never initialised.

**Why the fade.** Severing a loud sustained voice mid-waveform is a step
discontinuity, which is an audible click. 30ms is below the threshold where the
cut stops feeling immediate.

**Silent mode.** The teardown replaces `destinationGain` with a brand-new node
at gain 1, so `main.js` re-applies the mute to the new node immediately after.
Without this a panic would un-mute an `?agent=1` session. `silent.js` already
re-reads that node on every call for exactly this reason.

**Engine guard.** The audio panic is skipped when the engine has not booted
(`scheduler === null`). Nothing can be sounding, and asking for the superdough
controller would build one — and an `AudioContext` — just to tear it down.

### MIDI panic — `panicMidi()` in `src/midi/midi.js`

Hardware MIDI is outside the audio graph, so the audio panic cannot reach it.

- Returns immediately if `@strudel/midi` was never loaded or `WebMidi.enabled`
  is false. **Stop must never trigger a Web MIDI permission prompt** — it is a
  keypress whose whole purpose is to make things quieter.
- Otherwise, every `WebMidi.output` gets `sendAllSoundOff()` (CC 120) then
  `sendAllNotesOff()` (CC 123), on all 16 channels (webmidi v3's default).
  All-sound-off first because all-notes-off only lifts held keys — a voice in
  its release stage ignores it.

Fire-and-forget, and wrapped, so a MIDI failure cannot block or sink the audio
panic.

### Feedback

Status reads `stopped` on the first press and `all sound cut` on the panic.

The panic branch deliberately does **not** call `hush()`: `hush()` fires
`onToggle(false)`, whose handler would overwrite the status back to `stopped`.

## Verification

Driven through `window.oat` under `?agent=1` — muted throughout, and nothing
written to `songs/`:

1. Play a pattern with a long release.
2. `stop()` — transport down, voice still connected to the graph.
3. `panic()` — assert the superdough controller's `nodes` map is empty, that
   `destinationGain` is a different node object than before, and that the
   muted state survived the teardown.
