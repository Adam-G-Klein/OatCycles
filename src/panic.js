// Panic — cut every sound that is still ringing after the transport stops.
//
// hush() stops the scheduler, so nothing new gets triggered, but a voice that
// is already sounding keeps sounding: a long release, a slow pad, a reverb
// tail, a minutes-long sample. This is the second press of Stop — the "I need
// silence now" gesture.
//
// Why tear the graph down instead of stopping each voice: superdough tracks
// live voices in a private `activeSoundSources` map and exports no stop-all.
// resetGlobalEffects() is its own supported teardown — it disconnects every
// orbit and bus, rebuilds the master chain, and clears the analysers that
// .scope()/.spectrum() read. A voice that was mid-flight is left connected to
// nothing: it plays out its scheduled life in silence and is collected.
//
// The fade before the teardown is what keeps it from clicking. Severing a loud
// sustained voice mid-waveform is a step discontinuity, i.e. a pop. 30ms is
// short enough that the cut still feels instant.
//
// NB: the teardown replaces `destinationGain`, so silent mode has to be
// re-applied to the *new* node afterwards — see panic() in main.js. silent.js
// never caches that node for the same reason.
//
// The engine handles are passed in rather than imported: @strudel/web touches
// `window` at module scope, and keeping this file free of it is what lets the
// fade-then-teardown order be tested outside a browser.

export const FADE_SECONDS = 0.03;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ramp the master gain to zero, starting from wherever it actually is: it may
// be mid-ramp from a duck(), and a bare rampTo would step to the last set value
// first — the click we're here to avoid. cancelScheduledValues +
// setValueAtTime(current) is the portable spelling of cancelAndHoldAtTime.
export function fadeToSilence(gainParam, now) {
  gainParam.cancelScheduledValues(now);
  gainParam.setValueAtTime(gainParam.value, now);
  gainParam.linearRampToValueAtTime(0, now + FADE_SECONDS);
}

// `controller` is superdough's audio controller and `reset` its
// resetGlobalEffects. Both come from main.js, which only asks the engine for
// them once it's up — getSuperdoughAudioController() *builds* a controller (and
// an AudioContext) if there isn't one, and constructing an audio graph purely
// to tear it down would be an odd thing for Stop to do.
export async function panicAudio({ controller, reset }) {
  const gainParam = controller?.output?.destinationGain?.gain;
  if (gainParam) {
    fadeToSilence(gainParam, controller.audioContext.currentTime);
    // Let the ramp finish before the nodes go away — a teardown mid-fade is the
    // same discontinuity as no fade at all. (A hidden tab throttles timers, so
    // this can stretch to ~1s there. Stop is pressed in a visible tab, where
    // it's the 30ms it says.)
    await sleep(FADE_SECONDS * 1000);
  }
  reset();
}
