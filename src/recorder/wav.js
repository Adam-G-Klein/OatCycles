// WAV encoding for the master-output recorder — pure, no Web Audio, no DOM, so
// it can be tested under node.
//
// The recorder converts each block of float samples to 16-bit PCM as it
// arrives (see recorder.js) rather than holding floats until the end: that
// halves memory for a long take, and lets the final file be a Blob of the
// header plus the chunks as they are, with no big concatenating copy.
//
// 16-bit PCM because every player, DAW and sampler opens it. Strudel has no
// limiter on the master, so a loud pattern can exceed ±1.0; those samples are
// clamped, and the recorder reports the peak so a clipped take isn't a surprise.

export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

// Interleave two float channels into little-endian 16-bit PCM. Returns the
// bytes and the block's peak absolute sample (pre-clamp, so >1 means clipped).
export function encodePcm16(left, right) {
  const frames = left.length;
  const buffer = new ArrayBuffer(frames * 2 * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);
  let peak = 0;
  for (let i = 0, o = 0; i < frames; i++, o += 4) {
    const l = left[i];
    const r = right[i];
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    view.setInt16(o, toInt16(l), true);
    view.setInt16(o + 2, toInt16(r), true);
  }
  return { bytes: buffer, peak };
}

// Asymmetric scale so both -1.0 and +1.0 land exactly on the int16 extremes.
function toInt16(x) {
  // NaN would otherwise become 0 by accident of setInt16; make it explicit.
  if (!(x === x)) return 0;
  const c = x < -1 ? -1 : x > 1 ? 1 : x;
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
}

// The 44-byte canonical RIFF/WAVE header for `dataBytes` of PCM.
export function wavHeader({ sampleRate, channels = 2, dataBytes }) {
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buffer;
}

// Peak as dBFS for the status line, e.g. 0.5 → "-6.0 dBFS".
export function peakDb(peak) {
  if (peak <= 0) return '-∞ dBFS';
  return `${(20 * Math.log10(peak)).toFixed(1)} dBFS`;
}

// "airplaneDave-2026-10-19-143005.wav" — the song name made filesystem-safe,
// plus a local timestamp so successive takes never collide in Downloads.
export function recordingFilename(songName, date = new Date()) {
  const base = String(songName || 'untitled')
    .replace(/\.js$/, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'untitled';
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${base}-${stamp}.wav`;
}
