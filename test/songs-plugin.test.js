// Tests for the disk side of the save/autosave split: snapshot naming, the
// dedup that keeps a held-down play from filling the directory, and the pruning
// that bounds it. Run with `npm test` (node's built-in runner, no deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  safeBase,
  stamp,
  autosaveFilename,
  parseAutosaveFilename,
  selectPrunable,
  __internals,
} from '../vite-songs-plugin.js';

const { writeAutosave, readAutosaves, writeSongs, readSongs } = __internals;

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'oat-test-'));
}

test('safeBase keeps readable names and rejects path characters', () => {
  assert.equal(safeBase('dave1'), 'dave1');
  assert.equal(safeBase('untitled 2'), 'untitled 2');
  assert.equal(safeBase('  spaced   out  '), 'spaced out');
  assert.equal(safeBase('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeBase(''), 'untitled');
  assert.equal(safeBase(null), 'untitled');
});

test('autosave filenames carry the name and a local timestamp', () => {
  const when = new Date(2026, 6, 26, 9, 41, 33);
  assert.equal(autosaveFilename('dave1', when), 'dave1_auto_2026-07-26_094133.js');
  assert.equal(stamp(when), '2026-07-26_094133');
});

test('parsing a snapshot filename recovers name and time', () => {
  const when = new Date(2026, 6, 26, 9, 41, 33);
  const parsed = parseAutosaveFilename('dave1_auto_2026-07-26_094133.js');
  assert.equal(parsed.name, 'dave1');
  assert.equal(parsed.savedAt, when.getTime());

  // A song whose own name contains the marker still parses to that name.
  assert.equal(
    parseAutosaveFilename('foo_auto_bar_auto_2026-07-26_094133.js').name,
    'foo_auto_bar',
  );
  // The same-second collision suffix stays part of a valid name.
  assert.equal(parseAutosaveFilename('dave1_auto_2026-07-26_094133-2.js').name, 'dave1');
});

test('files that are not snapshots are ignored, not surfaced', () => {
  assert.equal(parseAutosaveFilename('index.json'), null);
  assert.equal(parseAutosaveFilename('dave1.js'), null);
  assert.equal(parseAutosaveFilename('_auto_2026-07-26_094133.js'), null); // no name
  assert.equal(parseAutosaveFilename('dave1_auto_not-a-date.js'), null);
});

test('pruning keeps the newest N and drops the rest', () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({ file: `s${n}.js`, savedAt: n }));
  const pruned = selectPrunable(entries, 2).map((e) => e.savedAt);
  assert.deepEqual(pruned.sort(), [1, 2, 3]);
  assert.deepEqual(selectPrunable(entries, 99), []);
  assert.deepEqual(selectPrunable([], 30), []);
});

test('an autosave writes a snapshot and lists it back', async () => {
  const dir = await tmpdir();
  const res = await writeAutosave(dir, { name: 'dave1', code: 's("bd*4")', keep: 30 });
  assert.equal(res.skipped, false);

  const listed = await readAutosaves(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'dave1');
  assert.equal(await fs.readFile(path.join(dir, res.file), 'utf8'), 's("bd*4")');
});

test('an unchanged buffer is not snapshotted again', async () => {
  const dir = await tmpdir();
  const first = await writeAutosave(
    dir,
    { name: 'dave1', code: 'same', keep: 30 },
    new Date(2026, 6, 26, 9, 41, 33),
  );
  const second = await writeAutosave(
    dir,
    { name: 'dave1', code: 'same', keep: 30 },
    new Date(2026, 6, 26, 9, 42, 0),
  );

  assert.equal(second.skipped, true);
  assert.equal(second.file, first.file);
  assert.equal((await readAutosaves(dir)).length, 1);
});

test('two buffers in the same second both survive', async () => {
  const dir = await tmpdir();
  const when = new Date(2026, 6, 26, 9, 41, 33);
  const a = await writeAutosave(dir, { name: 'dave1', code: 'one', keep: 30 }, when);
  const b = await writeAutosave(dir, { name: 'dave1', code: 'two', keep: 30 }, when);

  assert.notEqual(a.file, b.file);
  assert.equal(await fs.readFile(path.join(dir, a.file), 'utf8'), 'one');
  assert.equal(await fs.readFile(path.join(dir, b.file), 'utf8'), 'two');
});

test('each song is pruned to its newest snapshots, independently', async () => {
  const dir = await tmpdir();
  for (let i = 0; i < 5; i++) {
    await writeAutosave(
      dir,
      { name: 'dave1', code: `take ${i}`, keep: 3 },
      new Date(2026, 6, 26, 9, 41, i),
    );
  }
  await writeAutosave(
    dir,
    { name: 'other', code: 'untouched', keep: 3 },
    new Date(2026, 6, 26, 9, 41, 0),
  );

  const listed = await readAutosaves(dir);
  const mine = listed.filter((e) => e.name === 'dave1');
  assert.equal(mine.length, 3);
  // The three that survive are the newest three.
  const codes = await Promise.all(
    mine.map((e) => fs.readFile(path.join(dir, e.file), 'utf8')),
  );
  assert.deepEqual(codes.sort(), ['take 2', 'take 3', 'take 4']);
  // Pruning one song never reaches into another's snapshots.
  assert.equal(listed.filter((e) => e.name === 'other').length, 1);
});

test('autosaves never touch the saved songs directory', async () => {
  const songsDir = await tmpdir();
  const autoDir = await tmpdir();
  await writeSongs(songsDir, [{ id: 'a', name: 'dave1', code: 'the saved version' }]);

  await writeAutosave(autoDir, { name: 'dave1', code: 'a wild edit', keep: 30 });

  const [song] = await readSongs(songsDir);
  assert.equal(song.code, 'the saved version');
  assert.deepEqual((await fs.readdir(songsDir)).sort(), ['dave1.js', 'index.json']);
});

test('saving reconciles the songs dir: renames move files, deletes remove them', async () => {
  const dir = await tmpdir();
  await writeSongs(dir, [
    { id: 'a', name: 'dave1', code: 'aaa' },
    { id: 'b', name: 'gone', code: 'bbb' },
  ]);
  await writeSongs(dir, [{ id: 'a', name: 'dave2', code: 'aaa' }]);

  assert.deepEqual((await fs.readdir(dir)).sort(), ['dave2.js', 'index.json']);
  const songs = await readSongs(dir);
  assert.equal(songs.length, 1);
  assert.equal(songs[0].name, 'dave2');
  assert.equal(songs[0].code, 'aaa');
});

test('the pre-split manifest field still loads', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'old.js'), 'legacy', 'utf8');
  await fs.writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify([{ id: 'x', name: 'old', file: 'old.js', updatedAt: 1234 }]),
    'utf8',
  );
  const [song] = await readSongs(dir);
  assert.equal(song.savedAt, 1234);
  assert.equal(song.code, 'legacy');
});
