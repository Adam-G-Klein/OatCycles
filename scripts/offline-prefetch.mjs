#!/usr/bin/env node
// Fill ./offline-cache with every sound the app can reach over the internet,
// so it plays with no connection. Run it while online; rerunning only fetches
// what's missing. See OFFLINE.md.
//
//   npm run offline:sounds                     default banks + uzu + your songs' banks + GM soundfonts (variant 0)
//   npm run offline:sounds -- --all-soundfonts every variant of every gm_* instrument (much bigger)
//   npm run offline:sounds -- --skip=vcsl      leave a bank out (matched against its URL)
//   npm run offline:sounds -- --bank=github:user/repo   add any other samples() spec
//
// The cache is the same one the dev server reads and fills (offline-cache.js),
// so anything this misses still gets cached the first time you play it online.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCached, parseCacheable } from '../offline-cache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'offline-cache');

// Keep in step with SAMPLE_BASE / DEFAULT_SAMPLE_BANKS in src/main.js — these
// are registered at boot, so every song can reach them without a samples() call.
const SAMPLE_BASE = 'https://raw.githubusercontent.com/felixroos/dough-samples/main';
const DEFAULT_SAMPLE_BANKS = [
  'tidal-drum-machines.json',
  'piano.json',
  'Dirt-Samples.json',
  'EmuSP12.json',
  'vcsl.json',
  'mridangam.json',
].map((bank) => `${SAMPLE_BASE}/${bank}`);

// Not registered at boot, but they're what strudel.cc preloads and what
// people reach for: a modern electronic kit and the wt_ wavetables.
const EXTRA_BANKS = ['github:tidalcycles/uzu-drumkit', 'github:tidalcycles/uzu-wavetables'];

const SOUNDFONT_BASE = 'https://felixroos.github.io/webaudiofontdata/sound';

// --- args ------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const values = (name) =>
  args.filter((a) => a.startsWith(`--${name}=`)).flatMap((a) => a.slice(name.length + 3).split(','));
const allSoundfonts = flag('all-soundfonts');
const skip = values('skip').map((s) => s.toLowerCase());
const concurrency = Number(values('concurrency')[0]) || 12;

// --- resolving samples() specs ------------------------------------------------------

// Strudel's own resolution (samples() in @strudel/web): `github:owner/repo`
// defaults the repo to `samples` and the branch to `main`.
function githubToRaw(spec, file = '') {
  const parts = spec.slice('github:'.length).replace(/\/+$/, '').split('/');
  const [owner, repo = 'samples', branch = 'main', ...rest] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${[...rest, file].join('/')}`;
}

function specToManifestUrl(spec) {
  if (spec.startsWith('bubo:')) spec = `github:Bubobubobubobubo/dough-${spec.split(':')[1]}`;
  if (spec.startsWith('github:')) return githubToRaw(spec, 'strudel.json');
  if (spec.startsWith('shabda:')) return `https://shabda.ndre.gr/${spec.slice('shabda:'.length)}.json?strudel=1`;
  return spec;
}

// The `samples('…')` specs your songs name, so their banks come along too.
async function songBanks() {
  const specs = new Set();
  for (const dir of ['SavedSongs']) {
    let files = [];
    try {
      files = (await fs.readdir(path.join(ROOT, dir))).filter((f) => f.endsWith('.js'));
    } catch {
      continue;
    }
    for (const file of files) {
      const src = await fs.readFile(path.join(ROOT, dir, file), 'utf8');
      for (const [, spec] of src.matchAll(/samples\(\s*['"`]([^'"`$]+)['"`]/g)) specs.add(spec);
    }
  }
  return [...specs];
}

// A manifest's sample URLs, resolved against its _base the way samples() does.
function sampleUrls(manifest, manifestUrl) {
  let base = manifest._base ?? manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  if (base.startsWith('github:')) base = githubToRaw(base);
  const urls = [];
  const add = (file) => typeof file === 'string' && urls.push(new URL(base + file, manifestUrl).href);
  for (const [key, value] of Object.entries(manifest)) {
    if (key === '_base') continue;
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === 'object') {
      // pitched map: { c3: 'a.wav', d3: ['b.wav'] }
      for (const v of Object.values(value)) (Array.isArray(v) ? v : [v]).forEach(add);
    }
  }
  return urls;
}

// --- downloading --------------------------------------------------------------------

const stats = { cached: 0, fetched: 0, bytes: 0, failed: [] };

async function pool(urls, label) {
  let i = 0;
  let done = 0;
  const tick = () => {
    if (process.stdout.isTTY) process.stdout.write(`\r  ${label}: ${done}/${urls.length}   `);
  };
  const worker = async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const r = await ensureCached(CACHE_DIR, url);
        if (r.fromCache) stats.cached += 1;
        else {
          stats.fetched += 1;
          stats.bytes += r.bytes;
        }
      } catch (err) {
        stats.failed.push(`${url} — ${err.message}`);
      }
      done += 1;
      tick();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (process.stdout.isTTY) process.stdout.write('\n');
  else console.log(`  ${label}: ${done}/${urls.length}`);
}

async function prefetchBank(spec) {
  const manifestUrl = specToManifestUrl(spec);
  if (skip.some((s) => manifestUrl.toLowerCase().includes(s))) {
    console.log(`skip  ${spec}`);
    return;
  }
  if (!parseCacheable(manifestUrl)) {
    console.log(`skip  ${spec} (not an internet bank)`);
    return;
  }
  let manifest;
  try {
    const { file } = await ensureCached(CACHE_DIR, manifestUrl);
    manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    stats.failed.push(`${manifestUrl} — ${err.message}`);
    console.log(`fail  ${spec}: ${err.message}`);
    return;
  }
  const urls = sampleUrls(manifest, manifestUrl).filter((u) => parseCacheable(u));
  await pool(urls, spec);
}

async function prefetchSoundfonts() {
  const { default: gm } = await import('@strudel/soundfonts/gm.mjs');
  const fonts = Object.values(gm).flatMap((variants) => (allSoundfonts ? variants : variants.slice(0, 1)));
  const urls = [...new Set(fonts)].map((name) => `${SOUNDFONT_BASE}/${name}.js`);
  await pool(urls, `GM soundfonts (${allSoundfonts ? 'all variants' : 'variant 0 of each'})`);
}

// --- main ---------------------------------------------------------------------------

const started = Date.now();
const specs = [...new Set([...DEFAULT_SAMPLE_BANKS, ...EXTRA_BANKS, ...(await songBanks()), ...values('bank')])];
for (const spec of specs) await prefetchBank(spec);
if (!skip.includes('soundfonts')) await prefetchSoundfonts();

const mb = (stats.bytes / 1024 / 1024).toFixed(1);
console.log(
  `\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s — ${stats.fetched} downloaded (${mb} MB), ` +
    `${stats.cached} already cached, ${stats.failed.length} failed`,
);
if (stats.failed.length) {
  console.log('\nfailed:');
  for (const f of stats.failed.slice(0, 40)) console.log(`  ${f}`);
  if (stats.failed.length > 40) console.log(`  … and ${stats.failed.length - 40} more`);
  process.exitCode = 1;
}
