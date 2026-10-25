// Hold full-page reloads during a live-coding session.
//
// The problem: Vite's HMR broadcasts a *full-reload* to every connected tab
// whenever a changed JS module has no HMR boundary (which our editor.js /
// main.js don't). While a human is composing — or an agent is editing source
// in another tab — that reload cuts the audio and restarts the app under them.
//
// The fix has to be server-side. Vite 8's client wraps custom listeners in
// Promise.allSettled, so the old "throw inside vite:beforeFullReload" trick is
// swallowed and location.reload() fires regardless. `handleHotUpdate` returning
// an empty array, by contrast, tells Vite there is nothing to update for that
// change — no HMR patch and no full reload. The new code lands on the next
// *manual* refresh, which is the intended way to pull changes in.
//
// CSS is deliberately left to Vite: a stylesheet hot-swap is not a page reload
// and doesn't interrupt playback, so there's no reason to hold it.
//
// Escape hatch: run `OAT_HMR=1 npm run dev` to restore normal HMR.
export function holdReloadPlugin() {
  const holding = process.env.OAT_HMR !== '1';
  return {
    name: 'oat-hold-reload',
    apply: 'serve',
    enforce: 'post',
    handleHotUpdate(ctx) {
      if (!holding) return; // OAT_HMR=1 — behave like stock Vite
      if (ctx.file.endsWith('.css')) return; // keep non-disruptive CSS hot-swap
      return []; // swallow JS/HTML updates: no patch, no full reload
    },
  };
}
