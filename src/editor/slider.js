import { evalScope, pure, ref } from '@strudel/web';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';

// Inline value sliders — `.pdec(slider(0.2, 0.05, 0.5))`.
//
// `slider` is a transpiler feature, not a pattern function. Before the code is
// evaluated, @strudel/transpiler rewrites every `slider(v, min, max, step)`
// call into `sliderWithID('slider_<offset>', v, min, max, step)` and reports
// the argument's source range in meta.widgets. Nothing in @strudel/web defines
// `sliderWithID` — in the official REPL it lives in @strudel/codemirror, which
// we don't depend on (see the editor.js header) — so without this module the
// rewritten call reaches eval as an unknown identifier.
//
// Two halves, matching that split:
//
//   1. sliderWithID() in the eval scope. It records the literal from the code
//      and returns a ref() pattern that re-reads the value on every query, so
//      moving a slider changes the sound *without* re-evaluating.
//   2. a CodeMirror widget drawn just before each slider's number, fed by the
//      transpiler's widget locations after each eval. Dragging it writes the
//      new value back into the buffer, so the code always says what you hear.

// The live value per slider, written by drags and read at query time.
const sliderValues = new Map();

// The id the transpiler mints for a slider: its first argument's offset.
// Mirrors sliderWithLocation() in @strudel/transpiler.
const sliderID = (from) => `slider_${from}`;

// What `slider(...)` becomes after transpilation. The value in the code is the
// starting point (code -> state); everything after that comes from the widget.
function sliderWithID(id, value) {
  sliderValues.set(id, Number(value));
  return ref(() => sliderValues.get(id));
}

// Only reached if the transpiler is bypassed (evaluate() without it), in which
// case there is no widget and no source location — the value stands as written.
function slider(value) {
  return pure(value);
}

// Put both in the eval scope. Must finish before the first evaluate().
export const registerSliders = () => evalScope({ slider, sliderWithID });

// --- the widget --------------------------------------------------------------

// A number literal in the buffer, matched at the widget's position so a drag
// rewrites exactly the digits it owns however the surrounding code has moved.
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i;

// Carries the slider locations from a successful eval (meta.widgets).
const setSliders = StateEffect.define();

class SliderWidget extends WidgetType {
  // `from` is where the widget is drawn, in the document. `srcFrom` is the
  // offset the transpiler saw, which is what it minted the id from — the two
  // differ once ${…} interpolation has rewritten the code (lang/interpolate.js),
  // and it's the id that has to match for a drag to reach the pattern.
  constructor({ from, srcFrom, value, min, max, step }) {
    super();
    this.id = sliderID(srcFrom ?? from);
    this.value = value; // the literal as written, so the thumb starts where the code says
    this.min = min ?? 0;
    this.max = max ?? 1;
    // Strudel's default: a thousand steps across the range.
    this.step = step ?? (this.max - this.min) / 1000;
  }

  toDOM(view) {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'oat-slider';
    input.min = this.min;
    input.max = this.max;
    input.step = this.step;
    input.value = this.value;
    input.tabIndex = -1; // Tab belongs to the code, not to the sliders
    input.title = `${this.min} – ${this.max}`;
    input.addEventListener('input', () => {
      // The browser has already snapped the value to the step, so its own
      // string is the cleanest thing to write back into the code.
      this.value = input.value;
      sliderValues.set(this.id, Number(input.value));
      writeValue(view, this, input.value);
    });
    return input;
  }

  ignoreEvent() {
    return true;
  }
}

// Where this widget sits *now*. CodeMirror remaps the decoration as the buffer
// is edited, so the range set is the only trustworthy source of the position —
// anything cached at construction time goes stale on the first keystroke.
function widgetPos(view, widget) {
  const iterator = view.state.field(sliderField, false)?.iter();
  while (iterator?.value) {
    if (iterator.value.spec.widget === widget) return iterator.from;
    iterator.next();
  }
  return null;
}

// Replace the number the slider was built from with its new value. Silently
// does nothing if the text is no longer a number (the user edited over it) —
// the sound still follows the slider, the code just stops being rewritten.
function writeValue(view, widget, text) {
  if (view.state.readOnly) return;
  const from = widgetPos(view, widget);
  if (from == null) return;
  const match = NUMBER.exec(view.state.sliceDoc(from, Math.min(from + 32, view.state.doc.length)));
  if (!match) return;
  const to = from + match[0].length;
  if (view.state.sliceDoc(from, to) === text) return;
  view.dispatch({ changes: { from, to, insert: text } });
}

const sliderField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(sliders, tr) {
    // Keep each slider pinned to its number as the buffer is edited. Only a new
    // eval rebuilds the set, so widget instances survive a drag intact (a fresh
    // instance would mean a fresh DOM node, and a dropped one mid-gesture).
    if (tr.docChanged) sliders = sliders.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSliders)) {
        const widgets = e.value
          .filter(({ from }) => from < tr.newDoc.length)
          .map((config) =>
            Decoration.widget({ widget: new SliderWidget(config), side: -1 }).range(config.from),
          );
        sliders = Decoration.set(widgets, true);
      }
    }
    return sliders;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const sliderExtension = [sliderField];

// Redraw the sliders from the transpiler's meta.widgets. Call once per
// successful eval, alongside updateMiniLocations().
export const updateSliders = (view, widgets) => {
  const configs = (widgets || []).filter((w) => w.type === 'slider');
  // Every live slider was just re-registered by the eval that produced these
  // locations, so anything else in the map belongs to code that's gone.
  const live = new Set(configs.map(({ from }) => sliderID(from)));
  for (const id of sliderValues.keys()) {
    if (!live.has(id)) sliderValues.delete(id);
  }
  view.dispatch({ effects: setSliders.of(configs) });
};
