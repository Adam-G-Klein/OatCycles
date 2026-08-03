// Silent mode — run the engine at full fidelity with the master output at zero.
//
// The point is to let an automated caller (an agent driving the app in a
// headless-ish browser) evaluate and *actually play* a pattern without any
// sound reaching the machine's speakers. Everything else still happens:
// the scheduler runs, samples download and decode, unknown-sound errors are
// raised, highlighting animates. The only thing silent mode can't verify is
// audibility itself.
//
// Where the mute happens: superdough builds exactly one master gain node,
// `destinationGain`, as the last stage before ctx.destination —
//
//   every sound → connectToDestination() → channelMerger → destinationGain → destination
//
// so zeroing it silences every path at once (samples, synths, soundfonts,
// orbits, reverb, delay). See superdough/superdoughoutput.mjs.
//
// Why not `setGainCurve(() => 0)`, the more obvious knob: `setGainCurve` is
// part of the eval scope, so a user's own pattern can call it. Silent mode and
// a pattern's own gain curve would then silently fight over the same global.
// `destinationGain` is a private node nothing in the eval scope can reach.
//
// LIMITATION: `.midi()` sends to external devices outside the audio graph, so
// silent mode does not silence a pattern routed to hardware MIDI. MIDI output
// is opt-in and off by default.

import { getSuperdoughAudioController } from '@strudel/web';

export function createSilentMode() {
  let silent = false;

  // Re-read the node every time rather than caching it: superdough's reset()
  // tears down and rebuilds `destinationGain` (channel-count changes, context
  // swaps), and a stale reference would leave the *new* master unmuted — i.e.
  // sound. Re-applying on every call makes that unobservable.
  function apply() {
    const gain = getSuperdoughAudioController()?.output?.destinationGain;
    if (!gain) return false;
    gain.gain.value = silent ? 0 : 1;
    return true;
  }

  return {
    get silent() {
      return silent;
    },
    // Returns false if the audio graph isn't up yet, so callers can refuse to
    // play rather than play loudly. Call after the engine is ready.
    set(on) {
      silent = on;
      return apply();
    },
  };
}
