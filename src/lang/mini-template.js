// `${…}` holes in mini-notation strings — the runtime.
//
// The pre-pass in lang/interpolate.js rewrites every interpolated mini string
// into a call to oatMini(), which reaches eval as a bare identifier. So, just
// like sliderWithID() in editor/slider.js, this module has to put it in the
// eval scope before the first evaluate().
//
// What oatMini() returns is a pattern that rebuilds itself:
//
//   pure(1)              one hap per cycle
//     .withHaps(…)         whose value is computed when that cycle is queried
//     .innerJoin()         taking its structure from the string's own pattern
//
// The thunk holding the hole expressions is called from inside that query, so
// it sees the variables' values *now* rather than at eval time. `createCache`
// keeps it to one call per cycle; underneath, a string that has not changed
// since last cycle skips the mini parse entirely, which is the normal case.
//
// This module is not unit-tested: everything here needs @strudel/web, which
// assigns to `window` at module scope and cannot be imported under node.
// Anything that can be tested lives in lang/assemble.js instead.

import { evalScope, pure, reify, m, getLeafLocations } from '@strudel/web';
import { assemble, mapLeaf, createCache } from './assemble.js';

// The sites of the current evaluation, keyed by where their string starts in
// the document, holding the ranges that string occupies right now. Highlighting
// needs them: the editor only draws a box where it has a mark, and the marks it
// gets from the transpiler cover the static strings only.
const sites = new Map();
let sink = null;
let pending = false;

export const setLocationSink = (fn) => {
  sink = fn;
};

// Call before each evaluation. Sites re-register the first time they are
// queried, so anything left here belongs to code that is gone.
export const resetSites = () => {
  sites.clear();
  report();
};

// Never dispatch into CodeMirror from inside a query — the scheduler is
// mid-tick and a re-entrant editor update there is a mess. Coalesce to a
// microtask instead.
function report() {
  if (!sink || pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    sink?.([...sites.values()].flat());
  });
}

// The document ranges this string's leaves occupy, so the editor has something
// to draw on. Same mapping the haps get below.
function leafRanges(string, segments) {
  return getLeafLocations(`"${string}"`, 0).map(([from, to]) => {
    // m() parses `"` + string + `"`, so leaf offsets are one greater than the
    // index into the string itself.
    const { start, end } = mapLeaf(segments, from - 1, to - 1);
    return [start, end];
  });
}

function createSite(meta, holes) {
  let lastString = null;
  let lastPattern = null;

  return createCache(() => {
    const { string, segments } = assemble(meta, holes());
    // The usual case: the values came out the same, so there is nothing to
    // re-parse and nothing to tell the editor.
    if (string === lastString) return lastPattern;
    lastString = string;
    lastPattern = m(string, 0).withContext((context) => ({
      ...context,
      locations: (context.locations || []).map(({ start, end }) =>
        mapLeaf(segments, start - 1, end - 1),
      ),
    }));
    sites.set(meta.o, leafRanges(string, segments));
    report();
    return lastPattern;
  });
}

export function oatMini(meta, holes) {
  const cache = createSite(meta, holes);
  // Build once now, so a hole that is broken outright fails on Cmd+Enter
  // instead of a cycle later, through the same path as any other eval error.
  // The result is kept on the string, so the first cycle does not pay twice.
  cache.prime();
  return pure(1)
    .withHaps((haps) =>
      haps.map((hap) =>
        hap.withValue(() => reify(cache.at(hap.wholeOrPart().begin.sam().valueOf()))),
      ),
    )
    .innerJoin();
}

// Must finish before the first evaluate(), alongside registerSliders().
export const registerMiniTemplates = () => evalScope({ oatMini });
