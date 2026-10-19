// Tests for the recorder's WAV encoding. The capture itself needs a real
// AudioContext; the bytes it produces don't, and a wrong header is the kind of
// bug that only shows up as "my DAW won't open this file".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodePcm16, wavHeader, peakDb, recordingFilename } from '../src/recorder/wav.js';

test('encodePcm16 interleaves L/R as little-endian int16', () => {
  const { bytes, peak } = encodePcm16(new Float32Array([0, 1, -1]), new Float32Array([0.5, -0.5, 0]));
  const v = new DataView(bytes);
  assert.equal(bytes.byteLength, 12);
  const samples = [0, 2, 4, 6, 8, 10].map((o) => v.getInt16(o, true));
  assert.deepEqual(samples, [0, Math.round(0.5 * 0x7fff), 0x7fff, -0x4000, -0x8000, 0]);
  assert.equal(peak, 1);
});

test('encodePcm16 clamps overs but reports the real peak', () => {
  const { bytes, peak } = encodePcm16(new Float32Array([2]), new Float32Array([-3]));
  const v = new DataView(bytes);
  assert.equal(v.getInt16(0, true), 0x7fff);
  assert.equal(v.getInt16(2, true), -0x8000);
  assert.equal(peak, 3);
});

test('encodePcm16 writes NaN as silence', () => {
  const { bytes } = encodePcm16(new Float32Array([NaN]), new Float32Array([NaN]));
  assert.deepEqual(new Int16Array(bytes), new Int16Array([0, 0]));
});

test('wavHeader is a canonical 44-byte PCM header', () => {
  const v = new DataView(wavHeader({ sampleRate: 48000, channels: 2, dataBytes: 400 }));
  const ascii = (o) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(o + i)));
  assert.equal(v.byteLength, 44);
  assert.equal(ascii(0), 'RIFF');
  assert.equal(v.getUint32(4, true), 436);
  assert.equal(ascii(8), 'WAVE');
  assert.equal(ascii(12), 'fmt ');
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 4);
  assert.equal(v.getUint16(32, true), 4);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(ascii(36), 'data');
  assert.equal(v.getUint32(40, true), 400);
});

test('peakDb', () => {
  assert.equal(peakDb(1), '0.0 dBFS');
  assert.equal(peakDb(0.5), '-6.0 dBFS');
  assert.equal(peakDb(0), '-∞ dBFS');
});

test('recordingFilename is filesystem-safe and timestamped', () => {
  const d = new Date(2026, 9, 19, 14, 30, 5);
  assert.equal(recordingFilename('airplaneDave', d), 'airplaneDave-2026-10-19-143005.wav');
  assert.equal(recordingFilename('untitled 4.js', d), 'untitled_4-2026-10-19-143005.wav');
  assert.equal(recordingFilename(null, d), 'untitled-2026-10-19-143005.wav');
  assert.equal(recordingFilename('../../etc', d), 'etc-2026-10-19-143005.wav');
});
