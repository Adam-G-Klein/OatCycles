#!/usr/bin/env node
// Build samples/edm — an EDM drum kit plus square/pulse wavetables, as a
// local bank (so `:banks` lists it and it plays with no connection).
//
//   npm run offline:edm
//
// Drums are copied out of the offline cache (fetching anything missing):
// the TR-909 and TR-808 from ritchse/tidal-drum-machines and the modern
// switchangel/mot4i kit from tidalcycles/uzu-drumkit. Named `edm_<part>`, so
//
//   samples('/api/banks/edm.json')
//   s("bd*4, [~ cp]*2, hh*8").bank("edm")
//
// The wavetables are generated here, not downloaded. Strudel treats any sound
// named `wt_…` as a wavetable: a looped, pitched oscillator whose single-cycle
// frames (2048 samples each) `.wt(0..1)` scans through.
//
//   note("c2 [~ c3] eb2 g2").s("wt_pwm").wt(sine.slow(4))   // PWM bass
//
// Rerunning rebuilds the folder (old files in it are replaced).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCached } from '../offline-cache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'offline-cache');
const BANK_DIR = path.join(ROOT, 'samples', 'edm');

const TDM_MANIFEST = 'https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json';
const UZU_MANIFEST = 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json';

// part → [source, sound key, how many variants to take]. 909 first: it is the
// house/techno kit, so n(0) of every part is a 909 where there is one.
const KIT = {
  bd: [['tdm', 'RolandTR909_bd', 4], ['uzu', 'bd', 8], ['tdm', 'RolandTR808_bd', 6]],
  sd: [['tdm', 'RolandTR909_sd', 6], ['uzu', 'sd', 6], ['tdm', 'RolandTR808_sd', 4]],
  cp: [['tdm', 'RolandTR909_cp', 5], ['uzu', 'cp', 2], ['tdm', 'RolandTR808_cp', 3]],
  hh: [['tdm', 'RolandTR909_hh', 4], ['uzu', 'hh', 5], ['tdm', 'RolandTR808_hh', 1]],
  oh: [['tdm', 'RolandTR909_oh', 5], ['uzu', 'oh', 4], ['tdm', 'RolandTR808_oh', 3]],
  rim: [['tdm', 'RolandTR909_rim', 3], ['uzu', 'rim', 4], ['tdm', 'RolandTR808_rim', 1]],
  cr: [['tdm', 'RolandTR909_cr', 5], ['uzu', 'cr', 2]],
  rd: [['tdm', 'RolandTR909_rd', 5], ['uzu', 'rd', 2]],
  lt: [['tdm', 'RolandTR909_lt', 4], ['tdm', 'RolandTR808_lt', 3]],
  mt: [['tdm', 'RolandTR909_mt', 4], ['tdm', 'RolandTR808_mt', 3]],
  ht: [['tdm', 'RolandTR909_ht', 4], ['tdm', 'RolandTR808_ht', 3]],
  cb: [['tdm', 'RolandTR808_cb', 2], ['uzu', 'cb', 2]],
  perc: [['tdm', 'RolandTR808_perc', 8], ['uzu', 'misc', 6]],
};

async function manifest(url) {
  const { file } = await ensureCached(CACHE_DIR, url);
  const json = JSON.parse(await fs.readFile(file, 'utf8'));
  return { json, base: json._base };
}

// --- wavetables -------------------------------------------------------------------

const FRAME = 2048;
const RATE = 44100;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const normalize = (frame) => {
  const peak = Math.max(...frame.map(Math.abs)) || 1;
  return frame.map((s) => (s / peak) * 0.9);
};

// One band-limited cycle from its Fourier series, with Lanczos sigma factors
// to tame the ringing at the edges. 64 harmonics: clean through the bass and
// lead range, mellowing slightly up top.
function additive(coef, harmonics = 64) {
  const frame = new Array(FRAME).fill(0);
  for (let k = 1; k <= harmonics; k++) {
    const [a, b] = coef(k); // a·sin + b·cos
    if (!a && !b) continue;
    const x = (Math.PI * k) / (harmonics + 1);
    const sigma = Math.sin(x) / x;
    for (let i = 0; i < FRAME; i++) {
      const ph = (2 * Math.PI * k * i) / FRAME;
      frame[i] += sigma * (a * Math.sin(ph) + b * Math.cos(ph));
    }
  }
  return normalize(frame);
}

// Pulse of duty d: (2/kπ)·sin(kπd)·cos(2πk(t − d/2)).
const pulse = (d) =>
  additive((k) => {
    const amp = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * d);
    return [amp * Math.sin(k * Math.PI * d), amp * Math.cos(k * Math.PI * d)];
  });
const saw = () => additive((k) => [((k % 2 ? 1 : -1) * 2) / (k * Math.PI), 0]);
const tri = () => additive((k) => (k % 2 ? [((((k - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * k * k), 0] : [0, 0]));

// Naive (aliasing) pulse: hard edges, the NES/Game Boy sound.
const rawPulse = (d) => Array.from({ length: FRAME }, (_, i) => (i / FRAME < d ? 0.8 : -0.8));

const WAVETABLES = {
  wt_square: [pulse(0.5)],
  // 50% → 6%: scan it with .wt() for pulse-width modulation.
  wt_pwm: Array.from({ length: 16 }, (_, i) => pulse(0.5 - (i / 15) * 0.44)),
  // The three classic chip duties, hard-edged: n(0) 50%, n(1) 25%, n(2) 12.5%
  wt_chip: [[rawPulse(0.5)], [rawPulse(0.25)], [rawPulse(0.125)]],
  wt_saw: [saw()],
  wt_tri: [tri()],
  // square → saw morph, for .wt() sweeps that brighten.
  wt_sqsaw: Array.from({ length: 8 }, (_, i) => {
    const sq = pulse(0.5);
    const sw = saw();
    return normalize(sq.map((s, j) => s * (1 - i / 7) + sw[j] * (i / 7)));
  }),
};

// --- main -------------------------------------------------------------------------

const sources = { tdm: await manifest(TDM_MANIFEST), uzu: await manifest(UZU_MANIFEST) };

// Clear the previous build file by file (the bank is only ever two levels
// deep), so a part that shrank doesn't keep stale variants.
for (const entry of await fs.readdir(BANK_DIR, { withFileTypes: true }).catch(() => [])) {
  const full = path.join(BANK_DIR, entry.name);
  if (!entry.isDirectory()) {
    await fs.unlink(full);
    continue;
  }
  for (const file of await fs.readdir(full)) await fs.unlink(path.join(full, file));
  await fs.rmdir(full);
}
const index = ['# edm', '', 'Built by `scripts/offline-edm-bank.mjs`. `n()` → source file.', ''];
let copied = 0;

for (const [part, picks] of Object.entries(KIT)) {
  const dir = path.join(BANK_DIR, `edm_${part}`);
  await fs.mkdir(dir, { recursive: true });
  index.push(`## edm_${part}`, '');
  let n = 0;
  for (const [src, key, take] of picks) {
    const { json, base } = sources[src];
    for (const file of (json[key] ?? []).slice(0, take)) {
      const url = base + file.split('/').map(encodeURIComponent).join('/');
      const { file: cached } = await ensureCached(CACHE_DIR, url);
      const name = `${String(n).padStart(2, '0')}_${src === 'tdm' ? key.split('_')[0].replace('Roland', '') : 'uzu'}.wav`;
      await fs.copyFile(cached, path.join(dir, name));
      index.push(`- ${n}: ${src === 'tdm' ? 'tidal-drum-machines' : 'uzu-drumkit'} \`${file}\``);
      n += 1;
      copied += 1;
    }
  }
  index.push('');
}

index.push('## wavetables (generated)', '');
for (const [name, frames] of Object.entries(WAVETABLES)) {
  const dir = path.join(BANK_DIR, name);
  await fs.mkdir(dir, { recursive: true });
  // wt_chip's variants are separate files (pick with n); the rest are one
  // file of consecutive frames (scan with .wt).
  const files = Array.isArray(frames[0][0]) ? frames : [frames];
  for (const [i, f] of files.entries()) await fs.writeFile(path.join(dir, `${String(i).padStart(2, '0')}.wav`), wav(f.flat()));
  index.push(`- \`${name}\`: ${files.length > 1 ? `${files.length} variants (n)` : `${frames.length} frame${frames.length > 1 ? 's (.wt scans them)' : ''}`}`);
}

await fs.writeFile(path.join(BANK_DIR, 'INDEX.md'), index.join('\n') + '\n');
console.log(`samples/edm: ${copied} drum samples in ${Object.keys(KIT).length} parts, ${Object.keys(WAVETABLES).length} wavetables`);
