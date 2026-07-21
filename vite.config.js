import { defineConfig } from 'vite';
import { songsPlugin } from './vite-songs-plugin.js';

// The vendored strudel-upstream clone is only needed for later core patches
// (M4 superdough sustain). Keep Vite from crawling its example apps.
export default defineConfig({
  // Persist songs as real text files under ./songs (dev + preview). Without
  // this the song panel is localStorage-only and vanishes when the browser is
  // cleared. See vite-songs-plugin.js.
  plugins: [songsPlugin({ dir: 'songs' })],
  server: {
    // Honor an injected PORT (e.g. preview harness) but default to 5173 for
    // the normal `oat` dev workflow.
    port: Number(process.env.PORT) || 5173,
    watch: {
      ignored: ['**/strudel-upstream/**'],
    },
  },
  optimizeDeps: {
    // Only scan our own entry — don't discover deps from strudel-upstream/examples.
    entries: ['index.html'],
    // @strudel/web ships a prebuilt bundle with the audio worklet inlined.
    // @strudel/midi pulls in webmidi (CJS) — pre-bundle it so the lazy import
    // doesn't trigger a mid-session dep re-optimize + reload.
    // @strudel/soundfonts (GM instruments) pulls in soundfont2 (CJS) — same reason.
    include: ['@strudel/web', '@strudel/midi', '@strudel/soundfonts'],
  },
});
