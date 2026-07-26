// Tests for the client-side half of the save/autosave split: which songs reach
// disk and with what text, and how a localStorage mirror is reconciled against
// the files at boot. These are the pure functions from src/songs/storage.js —
// the rest of that module needs a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diskPayload, mergeSongs } from '../src/songs/storage.js';

test('a song that was never saved never reaches disk', () => {
  const payload = diskPayload([
    { id: 'a', name: 'dave1', code: 'buffer', diskCode: 'file', saved: true, savedAt: 1 },
    { id: 'b', name: 'sketch', code: 'unsaved work', saved: false, savedAt: 0 },
  ]);
  assert.deepEqual(payload, [{ id: 'a', name: 'dave1', code: 'file', savedAt: 1 }]);
});

test('a saved song is written with its file text, not the live buffer', () => {
  // This is the whole point of the split: autosaving song A's buffer and then
  // saving song B must not flush A's unsaved edits into A's file.
  const [a] = diskPayload([
    { id: 'a', name: 'dave1', code: 'edits since the last save', diskCode: 'file', saved: true },
  ]);
  assert.equal(a.code, 'file');
});

test('the buffer only reaches disk once a save promotes it', () => {
  const song = { id: 'a', name: 'dave1', code: 'new take', diskCode: 'file', saved: true };
  song.diskCode = song.code; // what saveCurrent does
  assert.equal(diskPayload([song])[0].code, 'new take');
});

test('merging keeps buffer edits while taking names from disk', () => {
  const merged = mergeSongs(
    [{ id: 'a', name: 'stale name', code: 'edits', saved: true, savedAt: 1 }],
    [{ id: 'a', name: 'dave1', code: 'file', savedAt: 2 }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'dave1'); // disk is the truth for metadata
  assert.equal(merged[0].code, 'edits'); // the buffer survives a reload
  assert.equal(merged[0].diskCode, 'file');
  assert.equal(merged[0].saved, true);
});

test('unsaved songs survive a reload; deleted files do not come back', () => {
  const merged = mergeSongs(
    [
      { id: 'b', name: 'sketch', code: 'unsaved work', saved: false, savedAt: 0 },
      { id: 'c', name: 'deleted elsewhere', code: 'x', saved: true, savedAt: 1 },
    ],
    [],
  );
  assert.deepEqual(
    merged.map((s) => s.name),
    ['sketch'],
  );
  assert.equal(merged[0].saved, false);
});

test('a song the mirror has never seen arrives from disk intact', () => {
  const [song] = mergeSongs([], [{ id: 'a', name: 'dave1', code: 'file', savedAt: 3 }]);
  assert.equal(song.code, 'file');
  assert.equal(song.diskCode, 'file');
  assert.equal(song.saved, true);
  assert.equal(song.savedAt, 3);
});

test('records written before the split count as saved', () => {
  // Pre-split mirrors have no `saved` flag, but every one of them was a real
  // file under songs/, which the migration copied into SavedSongs/.
  const [song] = mergeSongs(
    [{ id: 'a', name: 'dave1', code: 'edits', updatedAt: 7 }],
    [{ id: 'a', name: 'dave1', code: 'file', savedAt: 7 }],
  );
  assert.equal(song.saved, true);
  assert.equal(song.code, 'edits');
});
