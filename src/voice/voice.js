import { trackPitch } from './yin.js';
import { transcribe } from './transcribe.js';

// M3 — voice→code panel (the one true from-scratch feature, DESIGN §5.3).
//
// Flow: click Sing → record from the mic → click again to stop → ≤1s later an
// editable Strudel snippet appears at the cursor. This is offline/batch, not a
// live pattern: we capture the whole take, then run the pipeline once.
//   getUserMedia → MediaRecorder → decodeAudioData → trackPitch (YIN)
//     → transcribe (segment/quantize/emit) → insert at cursor.
// Nothing touches the microphone until the user clicks Sing.

const MIN_BPM = 40;
const MAX_BPM = 300;

export function setupVoicePanel({ recordBtn, bpmInput, onInsert, onStatus }) {
  let recording = false;
  let recorder = null;
  let stream = null;
  let chunks = [];

  function setRecordingUI(on) {
    recording = on;
    recordBtn.textContent = on ? '● Stop' : '● Sing';
    recordBtn.classList.toggle('on', on);
  }

  function clampBpm() {
    const bpm = Math.round(Number(bpmInput.value));
    return Number.isFinite(bpm) ? Math.max(MIN_BPM, Math.min(MAX_BPM, bpm)) : 120;
  }

  async function start() {
    recordBtn.disabled = true;
    onStatus?.('requesting mic…');
    try {
      // Disable the browser's voice-cleanup DSP — it colours pitch and hurts
      // transcription. We want the rawest signal the mic will give.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      console.error(err);
      onStatus?.('mic error: ' + err.message, 'error');
      recordBtn.disabled = false;
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) chunks.push(e.data);
    });
    recorder.addEventListener('stop', transcribeTake);
    recorder.start();
    setRecordingUI(true);
    recordBtn.disabled = false;
    onStatus?.('recording… sing a melody, then click Stop', 'playing');
  }

  function stop() {
    if (recorder && recording) recorder.stop();
    setRecordingUI(false);
  }

  async function transcribeTake() {
    // Release the mic as soon as recording ends (drops the browser tab's
    // recording indicator).
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recordBtn.disabled = true;
    onStatus?.('transcribing…');

    let audioCtx = null;
    try {
      const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      const buffer = await blob.arrayBuffer();
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await audioCtx.decodeAudioData(buffer);
      const samples = audio.getChannelData(0); // mono: first channel is enough

      const { freqs, hop } = trackPitch(samples, audio.sampleRate);
      const code = transcribe(freqs, { hop, sampleRate: audio.sampleRate, bpm: clampBpm() });
      if (!code) {
        onStatus?.('no pitch detected — try singing louder/steadier', 'error');
        return;
      }
      onInsert?.(code);
      onStatus?.('transcribed ✓ — Ctrl+Enter to play');
    } catch (err) {
      console.error(err);
      onStatus?.('transcribe error: ' + err.message, 'error');
    } finally {
      audioCtx?.close();
      recordBtn.disabled = false;
    }
  }

  recordBtn.addEventListener('click', () => (recording ? stop() : start()));
}
