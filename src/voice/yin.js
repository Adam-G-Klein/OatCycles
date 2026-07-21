// M3 — YIN pitch detection (clean-room).
//
// The first stage of voice→code: turn a buffer of mono PCM into a per-frame
// fundamental-frequency (f0) curve. We implement YIN ourselves — per DESIGN
// §5.3 the pipeline is built ground-up so every stage is understood and owned.
//
// YIN (de Cheveigné & Kawahara, 2002) is autocorrelation with a few fixes that
// make it robust for a monophonic voice and cheap enough to run offline over
// ~15s of audio well inside the 1s budget. The four steps below map 1:1 onto
// the paper: difference function → cumulative-mean normalization → absolute
// threshold → parabolic interpolation.

// Vocal-range guard. Frequencies outside this are almost certainly octave
// errors or noise for a sung melody, so we treat them as unvoiced.
const MIN_FREQ = 70; // ~C#2
const MAX_FREQ = 1100; // ~C#6

// Step 1 — difference function d(tau): for each lag tau, the summed squared
// difference between the frame and a copy of itself shifted by tau. Periodic
// signals dip toward zero at tau = period.
function difference(frame, maxTau) {
  const d = new Float32Array(maxTau);
  const w = frame.length - maxTau; // samples compared at each lag
  for (let tau = 1; tau < maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const delta = frame[i] - frame[i + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  return d;
}

// Step 2 — cumulative mean normalized difference d'(tau). Dividing each d(tau)
// by the running mean of all lags up to it removes the "d always dips at tau=0"
// bias and lets a single absolute threshold work across signals. d'(0) := 1.
function cumulativeMeanNormalized(d) {
  const dp = new Float32Array(d.length);
  dp[0] = 1;
  let running = 0;
  for (let tau = 1; tau < d.length; tau++) {
    running += d[tau];
    dp[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }
  return dp;
}

// Steps 3 & 4 — pick the period. Take the first lag whose normalized
// difference falls below `threshold`, walk to the bottom of that dip, then
// refine sub-sample with parabolic interpolation. Returns f0 in Hz, or 0 when
// no lag is periodic enough (unvoiced / silence).
function pitchFromFrame(frame, sampleRate, threshold) {
  const maxTau = frame.length >> 1;
  const d = difference(frame, maxTau);
  const dp = cumulativeMeanNormalized(d);

  let tau = -1;
  for (let t = 2; t < maxTau; t++) {
    if (dp[t] < threshold) {
      // Descend to the local minimum of this dip for a cleaner estimate.
      while (t + 1 < maxTau && dp[t + 1] < dp[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return 0; // nothing below threshold → unvoiced

  // Parabolic interpolation around tau using its neighbours for a fractional
  // period, sharpening the frequency estimate between integer sample lags.
  const x0 = tau > 0 ? tau - 1 : tau;
  const x2 = tau + 1 < maxTau ? tau + 1 : tau;
  let betterTau = tau;
  if (x0 !== tau && x2 !== tau) {
    const s0 = dp[x0];
    const s1 = dp[tau];
    const s2 = dp[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
  }

  const freq = sampleRate / betterTau;
  return freq >= MIN_FREQ && freq <= MAX_FREQ ? freq : 0;
}

// Track pitch across the whole buffer: slide a window of `frameSize` samples by
// `hop` and estimate f0 for each. Returns the f0 curve plus the hop used, so
// downstream stages can map frame index → time. Defaults (2048/256 samples ≈
// 43ms window, ~5ms frames at 48kHz) trade a little latency for stable pitch on
// a sung note.
export function trackPitch(samples, sampleRate, { frameSize = 2048, hop = 256, threshold = 0.15 } = {}) {
  const freqs = [];
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    const frame = samples.subarray(start, start + frameSize);
    freqs.push(pitchFromFrame(frame, sampleRate, threshold));
  }
  return { freqs, hop, sampleRate };
}
