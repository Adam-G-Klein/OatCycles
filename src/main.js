import './style.css';
import { initStrudel, evaluate, hush } from '@strudel/web';
import { createEditor } from './editor/editor.js';

// A default pattern that proves the plugin seam end-to-end: mini-notation,
// a synth sound (offline — no sample downloads), and some pattern transforms.
const DEFAULT_CODE = `// OatCycles — press Ctrl+Enter to play, Ctrl+. to stop
note("c3 eb3 g3 bb3")
  .s("sawtooth")
  .cutoff(sine.range(400, 2000).slow(4))
  .lpq(8)
  .gain(0.7)
  .slow(2)`;

const statusEl = document.getElementById('status');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// Boot the Strudel engine (audio + REPL). This is the @strudel/web seam:
// initStrudel() → evaluate(code) → hush().
const strudelReady = initStrudel({
  // Report transport state so the status line reflects real playback.
  onToggle: (started) => setStatus(started ? '● playing' : 'stopped', started ? 'playing' : ''),
})
  .then(() => setStatus('ready'))
  .catch((err) => {
    console.error(err);
    setStatus('engine failed to init', 'error');
  });

const editor = createEditor({
  parent: document.getElementById('editor'),
  initialCode: DEFAULT_CODE,
  onEvaluate: play,
  onStop: stop,
});

async function play(code = editor.getCode()) {
  try {
    await strudelReady;
    await evaluate(code);
  } catch (err) {
    console.error(err);
    setStatus('eval error: ' + err.message, 'error');
  }
}

function stop() {
  hush();
  setStatus('stopped');
}

document.getElementById('play').addEventListener('click', () => play());
document.getElementById('stop').addEventListener('click', stop);
