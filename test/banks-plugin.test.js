// Tests for the disk side of `:banks`: how a folder of audio becomes a bank,
// the manifest the engine and :peruse both read, and the containment guard on
// the route that serves the audio. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { manifest, resolveInside, __internals } from '../vite-banks-plugin.js';

const { scanBank, listBanks } = __internals;

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oat-banks-'));
}

// Build a tree from a { 'casio/bd/01.wav': '' } style map — the paths are what
// the test is about, the contents never are.
async function tree(root, files) {
  for (const rel of files) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '');
  }
  return root;
}

test('a folder per sound becomes a sound with indexable variants', async () => {
  const root = await tmpdir();
  await tree(root, ['casio/bd/02.wav', 'casio/bd/01.wav', 'casio/hh/only.wav']);

  const sounds = await scanBank(path.join(root, 'casio'));
  assert.deepEqual(sounds, [
    { name: 'bd', files: ['bd/01.wav', 'bd/02.wav'] },
    { name: 'hh', files: ['hh/only.wav'] },
  ]);
});

test('a flat folder of audio becomes one sound per file', async () => {
  const root = await tmpdir();
  await tree(root, ['casio/hh.wav', 'casio/bd.mp3']);

  assert.deepEqual(await scanBank(path.join(root, 'casio')), [
    { name: 'bd', files: ['bd.mp3'] },
    { name: 'hh', files: ['hh.wav'] },
  ]);
});

test('both layouts can share a bank, and a name in both merges', async () => {
  const root = await tmpdir();
  await tree(root, ['casio/bd/01.wav', 'casio/bd.wav', 'casio/hh.wav']);

  assert.deepEqual(await scanBank(path.join(root, 'casio')), [
    { name: 'bd', files: ['bd/01.wav', 'bd.wav'] },
    { name: 'hh', files: ['hh.wav'] },
  ]);
});

test('non-audio, dotfiles and deeper nesting are skipped', async () => {
  const root = await tmpdir();
  await tree(root, [
    'casio/bd/01.wav',
    'casio/bd/notes.txt',
    'casio/bd/.DS_Store',
    'casio/README.md',
    'casio/.hidden/x.wav',
    'casio/deep/deeper/x.wav', // two levels only
  ]);

  assert.deepEqual(await scanBank(path.join(root, 'casio')), [
    { name: 'bd', files: ['bd/01.wav'] },
  ]);
});

test('a bank with no audio in it is empty rather than an error', async () => {
  const root = await tmpdir();
  await tree(root, ['casio/README.md']);
  assert.deepEqual(await scanBank(path.join(root, 'casio')), []);
});

test('listBanks counts sounds and samples, alphabetically', async () => {
  const root = await tmpdir();
  await tree(root, [
    'vinyl/hh.wav',
    'casio/bd/01.wav',
    'casio/bd/02.wav',
    'casio/hh.wav',
    'loose.wav', // audio at the top level is not a bank
    'empty/README.md',
  ]);

  assert.deepEqual(await listBanks(root), [
    { name: 'casio', sounds: 2, samples: 3 },
    { name: 'empty', sounds: 0, samples: 0 },
    { name: 'vinyl', sounds: 1, samples: 1 },
  ]);
});

test('a missing samples dir lists nothing rather than throwing', async () => {
  const root = await tmpdir();
  assert.deepEqual(await listBanks(path.join(root, 'nope')), []);
});

test('the manifest is the shape strudel samples() reads', () => {
  const json = manifest('casio', [
    { name: 'bd', files: ['bd/01.wav', 'bd/02.wav'] },
    { name: 'hh', files: ['hh.wav'] },
  ]);

  assert.deepEqual(json, {
    _base: '/api/banks/casio/',
    bd: ['bd/01.wav', 'bd/02.wav'],
    hh: ['hh.wav'],
  });
});

test('manifest paths are URL-encoded so spaces and # survive the fetch', () => {
  const json = manifest('my kit', [{ name: 'bd', files: ['bd #1/take 2.wav'] }]);
  assert.equal(json._base, '/api/banks/my%20kit/');
  assert.deepEqual(json.bd, ['bd%20%231/take%202.wav']);
});

test('resolveInside keeps the audio route inside its bank', () => {
  const base = path.resolve('/tmp/samples/casio');

  assert.equal(resolveInside(base, 'bd/01.wav'), path.join(base, 'bd/01.wav'));
  assert.equal(resolveInside(base, 'bd%2F01.wav'), path.join(base, 'bd/01.wav'));

  assert.equal(resolveInside(base, '../vinyl/hh.wav'), null);
  assert.equal(resolveInside(base, '..%2F..%2Fetc%2Fpasswd'), null);
  assert.equal(resolveInside(base, '/etc/passwd'), null);
  assert.equal(resolveInside(base, ''), null);
  assert.equal(resolveInside(base, 'bd/\0.wav'), null);
  assert.equal(resolveInside(base, '%E0%A4%A'), null); // malformed escape
});
