// Master-output recorder — capture what the engine is playing to a .wav.
//
// Where it taps: superdough's `channelMerger`, the node every orbit sums into,
// one step *before* the master `destinationGain` —
//
//   every sound → channelMerger ─┬→ destinationGain → speakers
//                                └→ recorder worklet → PCM chunks → .wav
//
// Tapping before the master gain is deliberate: silent mode (🔇 Play, ?agent=1)
// zeroes destinationGain, and a recording taken there would be pure silence.
// From here a muted play can be bounced to a file without being heard. With
// the master at its normal gain of 1 it is exactly what reaches the speakers.
//
// The worklet has no outputs, so it adds nothing to what you hear; it only
// copies its input out to the main thread in batches.
//
// Re-tapping: superdough's reset() (Stop pressed twice → panic, or a channel
// count change) disconnects the merger and builds a new one, which would
// silently cut the recording off. So while recording, the tap is re-checked a
// few times a second and re-attached to whatever merger is current. The bit
// between the teardown and the re-attach records as silence, not as a gap.

import { encodePcm16, wavHeader } from './wav.js';

// Frames per message from the audio thread: ~186ms at 44.1kHz. Smaller means
// more messages; larger means more lost if the page dies mid-take.
const BATCH_FRAMES = 8192;
const RETAP_MS = 250;

const WORKLET_SOURCE = `
class OatRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(${BATCH_FRAMES});
    this.right = new Float32Array(${BATCH_FRAMES});
    this.fill = 0;
    this.done = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.done = true;
        this.port.postMessage({ type: 'done' });
      }
    };
  }
  flush() {
    if (!this.fill) return;
    const left = this.left.slice(0, this.fill);
    const right = this.right.slice(0, this.fill);
    this.port.postMessage({ type: 'chunk', left, right }, [left.buffer, right.buffer]);
    this.fill = 0;
  }
  process(inputs) {
    if (this.done) return false;
    const input = inputs[0];
    // An input with nothing actively feeding it arrives with zero channels.
    // Write silence anyway, so quiet passages keep their length in the file.
    const l = input[0];
    const r = input[1] || l;
    const frames = l ? l.length : 128;
    for (let i = 0; i < frames; i++) {
      this.left[this.fill] = l ? l[i] : 0;
      this.right[this.fill] = r ? r[i] : 0;
      if (++this.fill === ${BATCH_FRAMES}) this.flush();
    }
    return true;
  }
}
registerProcessor('oat-recorder', OatRecorder);
`;

// One addModule per AudioContext — calling it again for the same name throws.
const loaded = new WeakSet();

async function ensureWorklet(ctx) {
  if (loaded.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  loaded.add(ctx);
}

// `getController` returns superdough's audio controller; passed in so this
// module doesn't import @strudel/web (which touches `window` at load).
export function createRecorder({ getController }) {
  let take = null; // the in-progress recording, or null

  // Point the worklet at the current merger if it has changed since last time.
  function retap() {
    if (!take) return;
    const merger = getController()?.output?.channelMerger;
    if (!merger || merger === take.merger) return;
    try {
      take.merger?.disconnect(take.node);
    } catch {
      // Already disconnected by superdough's reset() — the usual case here.
    }
    merger.connect(take.node);
    take.merger = merger;
  }

  async function start() {
    if (take) return false;
    const controller = getController();
    const ctx = controller.audioContext;
    // Pressing Rec before anything has played: the context may still be
    // suspended waiting for a user gesture, and this click is one.
    if (ctx.state === 'suspended') await ctx.resume();
    await ensureWorklet(ctx);

    const node = new AudioWorkletNode(ctx, 'oat-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      // The merger has one channel per output channel of the audio device;
      // Strudel puts its stereo mix on 0 and 1. Explicit + discrete keeps
      // exactly those two and drops the rest, rather than downmixing them in.
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    take = {
      node,
      merger: null,
      sampleRate: ctx.sampleRate,
      startedAt: performance.now(),
      chunks: [],
      frames: 0,
      peak: 0,
      timer: null,
      finished: null,
    };
    const current = take;
    current.finished = new Promise((resolve) => {
      node.port.onmessage = ({ data }) => {
        if (data.type === 'chunk') {
          // Encode as it arrives: 16-bit holds half what the floats would.
          const { bytes, peak } = encodePcm16(data.left, data.right);
          current.chunks.push(bytes);
          current.frames += data.left.length;
          if (peak > current.peak) current.peak = peak;
        } else if (data.type === 'done') {
          resolve();
        }
      };
    });
    retap();
    take.timer = setInterval(retap, RETAP_MS);
    return true;
  }

  // Stop and return { blob, seconds, peak, bytes }, or null if not recording.
  async function stop() {
    if (!take) return null;
    const current = take;
    take = null;
    clearInterval(current.timer);
    current.node.port.postMessage('stop');
    await current.finished;
    try {
      current.merger?.disconnect(current.node);
    } catch {
      // The merger was torn down already; nothing left to disconnect.
    }
    const dataBytes = current.frames * 2 * 2;
    const header = wavHeader({ sampleRate: current.sampleRate, channels: 2, dataBytes });
    const blob = new Blob([header, ...current.chunks], { type: 'audio/wav' });
    return {
      blob,
      seconds: current.frames / current.sampleRate,
      peak: current.peak,
      bytes: blob.size,
    };
  }

  return {
    start,
    stop,
    retap,
    get recording() {
      return take !== null;
    },
    // Wall-clock seconds since start, for the button's running timer.
    get elapsed() {
      return take ? (performance.now() - take.startedAt) / 1000 : 0;
    },
  };
}
