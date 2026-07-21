// Formatting configuration for the `:f` command.
//
// THIS IS THE FILE TO EDIT when you want to change how `:f` formats code.
// It has two layers:
//
//   1. `base`  — a generic JS style guide, applied first. These are passed
//                straight through to Prettier (the standalone browser build),
//                so anything at https://prettier.io/docs/en/options works here.
//
//   2. `functionOverrides` — per-function argument layout, applied AFTER the
//                base pass. This is where stepcat() can be made to lay out
//                differently from stack(). Prettier treats every call the same;
//                this layer is what makes function-specific formatting possible.
//
// Both layers are live: tweak, save, and the next `:f` uses the new rules.

export const formatConfig = {
  // ── Layer 1: baseline JS style (Prettier options) ───────────────────────
  base: {
    // Chains reflow to fit this width. Lower it to push method chains onto
    // their own lines sooner (the classic vertical Strudel look); raise it to
    // keep more on one line.
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    // Strudel patterns conventionally omit trailing semicolons.
    semi: false,
    // Mini-notation strings read best double-quoted: note("c3 eb3").
    singleQuote: false,
    // 'none' | 'es5' | 'all' — trailing comma in multiline lists.
    trailingComma: 'none',
    bracketSpacing: true,
    // 'always' | 'avoid' — parens around single arrow-fn params: (x) => vs x =>
    arrowParens: 'always',
  },

  // ── Layer 2: per-function argument layout ────────────────────────────────
  //
  // Key = the bare function or method name being called. Both plain calls and
  // method calls match by name, so `stack` matches `stack(...)` and `s` matches
  // `.s(...)`.
  //
  // Each value is one of:
  //   { layout: 'expand'   }  → force one argument per line (spread out)
  //   { layout: 'collapse' }  → force all arguments onto a single line
  //   { layout: 'auto'     }  → leave whatever the base pass produced (default)
  //   a function (ctx) => string  → full control; see format.js for `ctx`.
  //
  // Examples of the kind of divergence you asked for: stack always spreads,
  // stepcat is left alone. Change these freely.
  functionOverrides: {
    stack: { layout: 'expand' },
    stepcat: { layout: 'auto' },
  },
};
