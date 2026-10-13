#!/usr/bin/env node
// Mirror the strudel.cc docs into ./offline-docs/strudel.cc, served by the dev
// server on http://localhost:5180 and opened with `:learn`. See OFFLINE.md.
//
//   npm run offline:docs
//
// Crawls every same-site page under the doc sections, plus the scripts,
// styles, images and fonts they pull in, keeping strudel.cc's own paths so
// its root-absolute links work unchanged. Rerunning refetches pages (they
// change) but keeps assets (their names are content-hashed).
//
// strudel.cc's search is a hosted service, so it can't work offline. Instead
// this writes offline-index.html: every mirrored page with a full-text filter.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'offline-docs', 'strudel.cc');
const ORIGIN = 'https://strudel.cc';
const SECTIONS = ['/learn/', '/workshop/', '/understand/', '/recipes/', '/technical-manual/', '/functions/', '/intro/', '/de/workshop/'];
const SEEDS = ['/learn/getting-started/', '/workshop/getting-started/', '/functions/intro/', '/recipes/recipes/', '/understand/cycles/'];

const isPage = (p) => SECTIONS.some((s) => p.startsWith(s)) && !path.extname(p.replace(/\/$/, ''));

function localFile(p) {
  const clean = decodeURIComponent(p.split(/[?#]/)[0]);
  const file = path.resolve(OUT, '.' + (clean.endsWith('/') ? clean + 'index.html' : clean));
  return file.startsWith(OUT + path.sep) ? file : null;
}

// Same-site references in HTML, CSS and JS: href/src attributes, srcset,
// url(...) in CSS, and root-absolute or relative chunk imports in JS.
function references(text, fromPath, kind) {
  const out = new Set();
  const add = (ref) => {
    if (!ref || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('mailto:')) return;
    let u;
    try {
      u = new URL(ref, ORIGIN + fromPath);
    } catch {
      return;
    }
    if (u.origin !== ORIGIN) return;
    out.add(u.pathname);
  };
  if (kind === 'html') {
    for (const [, ref] of text.matchAll(/(?:href|src|content)="([^"]+)"/g)) add(ref);
    for (const [, set] of text.matchAll(/srcset="([^"]+)"/g)) set.split(',').forEach((s) => add(s.trim().split(/\s+/)[0]));
  }
  if (kind === 'html' || kind === 'css') {
    for (const [, ref] of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(ref);
  }
  if (kind === 'js' || kind === 'html') {
    for (const [, ref] of text.matchAll(/["'`]((?:\/|\.\.?\/)[^"'`\s]+\.(?:m?js|css|json|wasm|svg|png|woff2?))["'`]/g)) add(ref);
  }
  return out;
}

const queue = [...SEEDS];
const seen = new Set(queue);
const pages = [];
let failed = 0;

async function fetchOne(p) {
  const file = localFile(p);
  if (!file) return;
  const asset = !isPage(p);
  if (asset) {
    try {
      await fs.access(file);
      if (!/\.(css|m?js)$/.test(file)) return; // cached binary: nothing to crawl
      const text = await fs.readFile(file, 'utf8');
      for (const ref of references(text, p, file.endsWith('.css') ? 'css' : 'js')) enqueue(ref);
      return;
    } catch {
      // not cached yet
    }
  }
  let res;
  try {
    res = await fetch(ORIGIN + p, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    failed += 1;
    console.log(`fail  ${p} (${err?.cause?.code ?? err.message})`);
    return;
  }
  if (!res.ok) {
    if (res.status !== 404) failed += 1;
    return;
  }
  const body = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  const type = res.headers.get('content-type') ?? '';
  const kind = type.includes('html') ? 'html' : type.includes('css') ? 'css' : type.includes('javascript') ? 'js' : null;
  if (!kind) return;
  const text = body.toString('utf8');
  if (kind === 'html') {
    const title = (text.match(/<title>([^<]*)<\/title>/) ?? [])[1]?.replace(/\s*🌀?\s*Strudel\s*$/, '').trim() || p;
    const main = (text.match(/<main[\s\S]*?<\/main>/) ?? [text])[0];
    const words = main
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({ path: p, title, text: words.slice(0, 20000) });
  }
  for (const ref of references(text, p, kind)) enqueue(ref);
}

function enqueue(p) {
  if (!p.startsWith('/') || seen.has(p)) return;
  if (isPage(p) || p.startsWith('/_astro/') || /\.(css|m?js|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|webmanifest|json|wasm)$/.test(p)) {
    seen.add(p);
    queue.push(p);
  }
}

const started = Date.now();
while (queue.length) {
  const batch = queue.splice(0, 12);
  await Promise.all(batch.map(fetchOne));
  if (process.stdout.isTTY) process.stdout.write(`\r  ${seen.size - queue.length}/${seen.size} fetched, ${pages.length} pages   `);
}
if (process.stdout.isTTY) process.stdout.write('\n');

// Merge with the previous index, so a crawl cut short by a dropped
// connection doesn't forget pages an earlier run mirrored.
const indexFile = path.join(OUT, 'offline-index.json');
let previous = [];
try {
  previous = JSON.parse(await fs.readFile(indexFile, 'utf8'));
} catch {
  // first run
}
const byPath = new Map([...previous, ...pages].map((pg) => [pg.path, pg]));
const all = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(indexFile, JSON.stringify(all));
await fs.copyFile(path.join(ROOT, 'scripts', 'offline-index.html'), path.join(OUT, 'offline-index.html'));

console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s — ${all.length} pages mirrored, ${failed} failed`);
if (failed) process.exitCode = 1;
