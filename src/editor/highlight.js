import { RangeSetBuilder, StateEffect, StateField, Prec } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

// Active-event highlighting, the Strudel way.
//
// Strudel draws a little box around every character responsible for a sound
// that is playing *right now*, shifting the boxes as the output changes. Two
// pieces of information make that possible:
//
//   1. mini-notation *locations* — the transpiler tags every leaf token in a
//      mini string with its [from, to] character offsets (meta.miniLocations).
//   2. per-frame *haps* — each scheduled event carries the source locations
//      that produced it on `hap.context.locations` as { start, end } offsets.
//
// We turn (1) into a set of invisible CodeMirror marks keyed by "from:to", then
// every animation frame (2) tells us which of those ids are currently sounding,
// and we outline exactly those marks. CodeMirror remaps the ranges for us as
// the document is edited, so the marks stay attached to the right characters.
//
// This mirrors @strudel/codemirror's highlight.mjs, trimmed to the full-buffer
// evaluation OatCycles uses (no block-based range updates).

// Carries the complete set of mini locations from a successful eval.
const setMiniLocations = StateEffect.define();
// Carries the haps that are audible this frame.
const showMiniLocations = StateEffect.define();

// Replace all known mini-notation locations. Call once per successful eval with
// the transpiler's meta.miniLocations (an array of [from, to] pairs).
export const updateMiniLocations = (view, locations) => {
  view.dispatch({ effects: setMiniLocations.of(locations || []) });
};

// Report which haps are sounding at `atTime`. Call every animation frame.
export const highlightMiniLocations = (view, atTime, haps) => {
  view.dispatch({ effects: showMiniLocations.of({ atTime, haps }) });
};

// Every mini location as an invisible mark, keyed by `${from}:${to}` so a hap
// can look up the mark for the source range that produced it.
const miniLocations = StateField.define({
  create() {
    return Decoration.none;
  },
  update(locations, tr) {
    // Keep marks pinned to their characters as the user edits.
    if (tr.docChanged) {
      locations = locations.map(tr.changes);
    }
    for (const e of tr.effects) {
      if (e.is(setMiniLocations)) {
        const marks = e.value
          .filter(([from]) => from < tr.newDoc.length)
          .map(([from, to]) => [from, Math.min(to, tr.newDoc.length)])
          .map(([from, to]) => Decoration.mark({ id: `${from}:${to}` }).range(from, to));
        locations = Decoration.set(marks, true);
      }
    }
    return locations;
  },
});

// The source ranges active this frame, indexed by their "start:end" id.
const visibleMiniLocations = StateField.define({
  create() {
    return new Map();
  },
  update(visible, tr) {
    for (const e of tr.effects) {
      if (e.is(showMiniLocations)) {
        const haps = new Map();
        for (const hap of e.value.haps) {
          if (!hap.context?.locations || !hap.whole) continue;
          for (const { start, end } of hap.context.locations) {
            const id = `${start}:${end}`;
            // When several haps share a range, keep the latest-onset one so the
            // box tracks the most recent trigger.
            if (!haps.has(id) || haps.get(id).whole.begin.lt(hap.whole.begin)) {
              haps.set(id, hap);
            }
          }
        }
        visible = haps;
      }
    }
    return visible;
  },
});

// Outline every mark whose id is active this frame. Marks with no active hap
// contribute nothing, so the boxes appear and vanish as playback moves.
const activeHighlights = EditorView.decorations.compute(
  [miniLocations, visibleMiniLocations],
  (state) => {
    const iterator = state.field(miniLocations).iter();
    const haps = state.field(visibleMiniLocations);
    const builder = new RangeSetBuilder();
    while (iterator.value) {
      const {
        from,
        to,
        value: {
          spec: { id },
        },
      } = iterator;
      const hap = haps.get(id);
      if (hap) {
        // Respect an explicit event color / .markcss when present, otherwise
        // fall back to the white box Strudel uses by default.
        const color = hap.value?.color ?? '#ffffff';
        const style = hap.value?.markcss || `outline: 1.5px solid ${color}; border-radius: 2px;`;
        builder.add(from, to, Decoration.mark({ attributes: { style } }));
      }
      iterator.next();
    }
    return builder.finish();
  },
);

// High precedence so the active outline wins over the base syntax marks.
export const highlightExtension = Prec.highest([miniLocations, visibleMiniLocations, activeHighlights]);
