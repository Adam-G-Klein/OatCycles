import { defineConfig } from 'vite';

// The vendored strudel-upstream clone is only needed for later core patches
// (M4 superdough sustain). Keep Vite from crawling its example apps.
export default defineConfig({
  server: {
    port: 5173,
    watch: {
      ignored: ['**/strudel-upstream/**'],
    },
  },
  optimizeDeps: {
    // Only scan our own entry — don't discover deps from strudel-upstream/examples.
    entries: ['index.html'],
    // @strudel/web ships a prebuilt bundle with the audio worklet inlined.
    include: ['@strudel/web'],
  },
});
