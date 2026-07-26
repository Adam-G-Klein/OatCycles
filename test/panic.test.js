// Tests for the second press of Stop: the panic that cuts voices still ringing
// after the transport is down. What matters here is the *order* — fade the
// master to zero, and only then tear the graph down. Reversing those two is
// inaudible in code review and very audible in the room.
//
// src/panic.js takes its engine handles as arguments precisely so this can run
// without a browser; the rest of the wiring (which press panics, re-applying
// the mute afterwards) lives in main.js and needs one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { panicAudio, fadeToSilence, FADE_SECONDS } from '../src/panic.js';

// A stub AudioParam that records what was done to it, in order.
function fakeGainParam(value = 1) {
  const calls = [];
  return {
    value,
    calls,
    cancelScheduledValues: (t) => calls.push(['cancel', t]),
    setValueAtTime: (v, t) => calls.push(['set', v, t]),
    linearRampToValueAtTime: (v, t) => calls.push(['ramp', v, t]),
  };
}

function fakeController(gainParam, currentTime = 10) {
  return {
    audioContext: { currentTime },
    output: { destinationGain: { gain: gainParam } },
  };
}

test('the fade anchors the current value before ramping to zero', () => {
  // Mid-duck the gain is somewhere between 0 and 1. Ramping without anchoring
  // would step to the last *scheduled* value first — a click.
  const gain = fakeGainParam(0.37);
  fadeToSilence(gain, 10);
  assert.deepEqual(gain.calls, [
    ['cancel', 10],
    ['set', 0.37, 10],
    ['ramp', 0, 10 + FADE_SECONDS],
  ]);
});

test('the fade is short enough to feel instant', () => {
  assert.ok(FADE_SECONDS > 0 && FADE_SECONDS <= 0.05);
});

test('the graph is torn down only after the fade has finished', async () => {
  const gain = fakeGainParam();
  let resetAt = null;
  const started = Date.now();

  await panicAudio({
    controller: fakeController(gain),
    reset: () => {
      resetAt = Date.now() - started;
      // The ramp must already be scheduled by the time we tear down.
      assert.deepEqual(gain.calls.at(-1), ['ramp', 0, 10 + FADE_SECONDS]);
    },
  });

  assert.notEqual(resetAt, null, 'reset was never called');
  // setTimeout can fire a hair early on some platforms; the point is that the
  // teardown waited for the fade rather than racing it.
  assert.ok(resetAt >= FADE_SECONDS * 1000 - 5, `tore down after ${resetAt}ms`);
});

test('a panic before the audio graph exists still resets, and does not throw', async () => {
  let resets = 0;
  const reset = () => resets++;

  await panicAudio({ controller: null, reset });
  await panicAudio({ controller: {}, reset });
  await panicAudio({ controller: { output: {} }, reset });

  assert.equal(resets, 3);
});
