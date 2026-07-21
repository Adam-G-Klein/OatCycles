// General MIDI soundfont registration (gm_acoustic_bass, gm_acoustic_grand_piano, …).
//
// Why this file exists instead of just calling `registerSoundfonts` from
// `@strudel/soundfonts`:
//
// `@strudel/web` is a PREBUILT bundle with its own copy of `@strudel/webaudio`
// compiled in. The sound registry (`soundMap`) that `evaluate()` / `superdough()`
// read from lives inside that bundled copy. `samples()` is imported from
// `@strudel/web`, so sample banks (piano, jazz, drum machines…) register into the
// right map — those work.
//
// `@strudel/soundfonts`, however, is resolved separately from node_modules and
// pulls in a SECOND copy of `@strudel/webaudio`. Its `registerSoundfonts()`
// registers every gm_* instrument into that second copy's registry — a different
// `soundMap` the REPL never consults. The trigger silently never fires
// ("sound gm_acoustic_bass not found!", swallowed inside the async scheduler),
// so gm_* sounds are dead while piano/jazz play fine.
//
// Fix: register the GM instruments through `@strudel/web`'s OWN `registerSound`
// (and its ADSR/envelope/context helpers, all re-exported), so they land in the
// registry the engine actually uses. The trigger body is a straight port of
// `registerSoundfonts` from @strudel/soundfonts/fontloader.mjs. We reuse the pure
// font-loading/buffer helper `getFontBufferSource` (it takes the AudioContext as
// an argument, so passing @strudel/web's context keeps every buffer on the same
// graph) and the GM name→font map.

import {
  registerSound,
  getAudioContext,
  getADSRValues,
  getParamADSR,
  getPitchEnvelope,
  getVibratoOscillator,
  onceEnded,
  releaseAudioNode,
  getSoundIndex,
} from '@strudel/web';
import { getFontBufferSource } from '@strudel/soundfonts';
import gm from '@strudel/soundfonts/gm.mjs';

export function registerSoundfonts() {
  Object.entries(gm).forEach(([name, fonts]) => {
    registerSound(
      name,
      async (time, value, onended) => {
        const [attack, decay, sustain, release] = getADSRValues([
          value.attack,
          value.decay,
          value.sustain,
          value.release,
        ]);

        const { duration } = value;
        // For soundfonts, `n` selects WHICH font variant to use (not pitch);
        // pitch comes from `note`, which defaults to c3 inside getFontBufferSource.
        const n = getSoundIndex(value.n, fonts.length);
        const font = fonts[n];
        const ctx = getAudioContext();
        const bufferSource = await getFontBufferSource(font, value, ctx);
        bufferSource.start(time);
        const envGain = ctx.createGain();
        const node = bufferSource.connect(envGain);
        const holdEnd = time + duration;
        getParamADSR(node.gain, attack, decay, sustain, release, 0, 0.3, time, holdEnd, 'linear');
        const envEnd = holdEnd + release + 0.01;

        // vibrato + pitch envelope
        const vibratoHandle = getVibratoOscillator(bufferSource.detune, value, time);
        getPitchEnvelope(bufferSource.detune, value, time, holdEnd);

        bufferSource.stop(envEnd);
        onceEnded(bufferSource, () => {
          releaseAudioNode(bufferSource);
          vibratoHandle?.stop();
          onended();
        });
        return { node, stop: () => {}, nodes: { source: [bufferSource], ...vibratoHandle?.nodes } };
      },
      { type: 'soundfont', prebake: true, fonts },
    );
  });
}
