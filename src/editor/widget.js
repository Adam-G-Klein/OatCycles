import {
  Pattern,
  analysers,
  clamp,
  drawFrequencyScope,
  drawTimeScope,
  getAnalyzerData,
  getWidgetID,
  registerWidgetType,
} from '@strudel/web';
import { getPunchcardPainter, getTheme } from '@strudel/draw';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';

// Inline visualizers — `s("bd sd")._punchcard()`.
//
// Six of them: _punchcard, _pianoroll, _spiral, _pitchwheel, _scope, _spectrum.
// Each draws onto its own <canvas>, parked in the code right after the call
// that asked for it. The un-prefixed forms (.punchcard(), .scope(), …) draw
// onto the full-screen canvas behind the editor instead; they share all of the
// machinery below except the canvas they're handed.
//
// Like slider(), these are a transpiler feature. `registerWidgetType(type)`
// tells @strudel/transpiler that `._punchcard(...)` is a widget call, and from
// then on it rewrites each one to `._punchcard('<id>', ...)` and reports the
// call's end offset in meta.widgets. So there are two halves again:
//
//   1. Pattern.prototype._punchcard(id, options), which builds the canvas and
//      attaches a painter to the pattern.
//   2. a CodeMirror widget that drops that canvas into the document, fed by
//      the transpiler's widget locations after each eval.
//
// --- why the painters are reimplemented --------------------------------------
//
// @strudel/web's prebuilt bundle inlines its own copy of @strudel/draw, so
// Pattern.prototype.punchcard and friends already exist on the Pattern the
// repl actually evaluates. But that copy's cleanupDraw() isn't re-exported,
// and three of the six visualizers — pianoroll, scope and spectrum — drive
// themselves with a private requestAnimationFrame loop that only cleanupDraw()
// can cancel. Left alone they would keep animating after Cmd+. and keep
// drawing into canvases long since deleted from the code. (Same family of bug
// as the soundfonts one — see the header of main.js.)
//
// So those three are redefined below in terms of .onPaint(), which is how
// punchcard, spiral and pitchwheel already work: register a painter, and the
// Drawer in main.js calls it once per frame with the haps around the playhead.
// One loop drives every visualizer, stopping the transport stops all of them,
// and a deleted widget stops painting because the next eval simply doesn't
// re-register its painter.

// --- the drawing half ---------------------------------------------------------

// A visualizer's colour follows the events it's drawing. Prefer a hap belonging
// to this widget's own pattern (the wrappers below tag them with the widget id)
// and fall back to whatever is sounding, matching upstream's untagged forms.
const hapColor = (haps, id) =>
  haps.find((hap) => hap.hasTag(id))?.value?.color ?? haps[0]?.value?.color ?? getTheme().foreground;

// `smear` keeps the previous frame around at reduced opacity, so the trace
// fades out instead of vanishing. 0 (the default) is a plain wipe.
function clearCanvas(ctx, smear = 0) {
  const { width, height } = ctx.canvas;
  if (!smear) {
    ctx.clearRect(0, 0, width, height);
    return;
  }
  ctx.fillStyle = `rgba(0,0,0,${1 - smear})`;
  ctx.fillRect(0, 0, width, height);
}

// A pianoroll is a punchcard that doesn't fold its value axis — upstream says
// as much in a comment next to its own animation-frame version. Going through
// the punchcard painter means the roll's time window comes from the Drawer's
// drawTime rather than a `cycles` option of its own.
Pattern.prototype.pianoroll = function (options = {}) {
  return this.onPaint(getPunchcardPainter({ fold: 0, ...options }));
};

// The oscilloscope reads the audio graph, not the haps: .analyze(id) splices an
// AnalyserNode in under that id, and drawTimeScope renders its buffer. The haps
// are only consulted for the colour.
Pattern.prototype.tscope = function (config = {}) {
  const { id = 1, ctx, smear, ...options } = config;
  return this.analyze(id).onPaint((drawCtx, time, haps) => {
    const target = ctx ?? drawCtx;
    clearCanvas(target, smear);
    drawTimeScope(analysers[id], {
      color: hapColor(haps, id),
      ...options,
      ctx: target,
      id,
    });
  });
};
Pattern.prototype.scope = Pattern.prototype.tscope;

// Same again for the frequency domain. No widget type registers it — there's no
// ._fscope() — but the bare form is reachable, and leaving it on the animation
// loop would put back exactly the leak the rest of this file avoids. Unlike the
// time scope it's skipped outright before the first sound: upstream's
// no-analyser branch draws a flat line through an undefined `canvas`, so
// reaching it throws.
Pattern.prototype.fscope = function (config = {}) {
  const { id = 1, ctx, smear, ...options } = config;
  return this.analyze(id).onPaint((drawCtx, time, haps) => {
    const target = ctx ?? drawCtx;
    clearCanvas(target, smear);
    if (analysers[id]) {
      drawFrequencyScope(analysers[id], { color: hapColor(haps, id), ...options, ctx: target, id });
    }
  });
};

// The spectrum scrolls: each frame shifts the canvas left and paints one column
// of the current FFT at the right edge. That makes it the one visualizer that
// needs its own state — the previous frame's pixels, kept per widget id.
const spectrumFrames = new Map();

function drawSpectrum(analyser, { speed = 1, min = -80, max = 0, ctx, id = 1, color } = {}) {
  if (!analyser) return;
  const { canvas } = ctx;
  ctx.fillStyle = color;

  const previous = spectrumFrames.get(id) ?? ctx.getImageData(0, 0, canvas.width, canvas.height);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.putImageData(previous, -speed, 0);

  const data = getAnalyzerData('frequency', id);
  const bins = analyser.frequencyBinCount;
  const x = canvas.width - speed;
  for (let i = 0; i < bins; i++) {
    // Log-spaced, so the low end gets the room it needs to be legible.
    const y = (Math.log(i + 1) / Math.log(bins)) * canvas.height;
    ctx.globalAlpha = clamp((data[i] - min) / (max - min), 0, 1);
    ctx.fillRect(x, canvas.height - y, speed, 2);
  }
  ctx.globalAlpha = 1;
  spectrumFrames.set(id, ctx.getImageData(0, 0, canvas.width, canvas.height));
}

Pattern.prototype.spectrum = function (config = {}) {
  const { id = 1, ctx, ...options } = config;
  return this.analyze(id).onPaint((drawCtx, time, haps) => {
    drawSpectrum(analysers[id], { color: hapColor(haps, id), ...options, ctx: ctx ?? drawCtx, id });
  });
};

// --- the canvases -------------------------------------------------------------

// One canvas per widget id, kept here between the eval that creates it and the
// CodeMirror widget that puts it in the document. The same element is reused
// across evals so re-running the buffer doesn't detach it and put it back,
// which the browser would show as a flicker.
const canvases = new Map();

function widgetCanvas(id, { width = 500, height = 60, pixelRatio = window.devicePixelRatio } = {}) {
  let canvas = canvases.get(id);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = id;
    canvas.className = 'oat-widget';
    canvases.set(id, canvas);
  }
  // Draw at device resolution, lay out at CSS resolution. Assigning either
  // dimension also wipes the bitmap, which is the reset we want on re-eval.
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  spectrumFrames.delete(id);
  // willReadFrequently: the spectrum reads the whole canvas back every frame.
  return canvas.getContext('2d', { willReadFrequently: true });
}

// Teach the transpiler about a widget method, and define what it does.
function registerWidget(type, create) {
  registerWidgetType(type);
  Pattern.prototype[type] = function (id, options = {}) {
    return create(id, options, this);
  };
}

// The six. Each wrapper sizes a canvas and hands its context to the un-prefixed
// visualizer, which is what makes the two forms behave identically apart from
// where they land. `.tag(id)` marks this pattern's haps so the painter can pick
// its own out of the Drawer's stream — without it, two punchcards on one line
// would each draw everything.
export function registerWidgets() {
  registerWidget('_punchcard', (id, options, pat) =>
    pat.tag(id).punchcard({ fold: 1, ...options, ctx: widgetCanvas(id, options), id }),
  );

  registerWidget('_pianoroll', (id, options, pat) =>
    pat.tag(id).pianoroll({ fold: 1, ...options, ctx: widgetCanvas(id, options), id }),
  );

  registerWidget('_spiral', (id, options, pat) => {
    // `size` is the diameter of the drawing; the spiral's own `size` is the gap
    // between its turns, a fifth of that.
    const size = options.size || 275;
    options = { width: size, height: size, ...options, size: size / 5 };
    return pat.tag(id).spiral({ ...options, ctx: widgetCanvas(id, options), id });
  });

  registerWidget('_pitchwheel', (id, options, pat) => {
    const size = options.size || 200;
    options = { width: size, height: size, ...options, size: size / 5 };
    // pitchwheel tags its own pattern.
    return pat.pitchwheel({ ...options, ctx: widgetCanvas(id, options), id });
  });

  registerWidget('_scope', (id, options, pat) => {
    // Centred and full-height, rather than the bottom quarter the full-screen
    // scope uses — an inline scope has the whole canvas to itself.
    options = { width: 500, height: 60, pos: 0.5, scale: 1, ...options };
    return pat.tag(id).scope({ ...options, ctx: widgetCanvas(id, options), id });
  });

  registerWidget('_spectrum', (id, options, pat) => {
    const size = options.size || 200;
    options = { width: size, height: size, ...options, size: size / 5 };
    return pat.spectrum({ ...options, ctx: widgetCanvas(id, options), id });
  });
}

// Wipe every inline canvas. Called when the transport stops, so a visualizer
// doesn't leave its last frame frozen on screen.
export function clearWidgetCanvases() {
  for (const canvas of canvases.values()) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }
  spectrumFrames.clear();
}

// --- the CodeMirror half -------------------------------------------------------

// Carries the widget locations from a successful eval (meta.widgets).
const setWidgets = StateEffect.define();

class CanvasWidget extends WidgetType {
  constructor(config) {
    super();
    this.id = getWidgetID(config);
  }

  // The id encodes type and ordinal, so equal ids mean the same widget and
  // CodeMirror can keep the DOM — and with it the canvas — exactly as it is.
  eq(other) {
    return other instanceof CanvasWidget && other.id === this.id;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'oat-widget-container';
    // It's a picture of the sound; there's nothing here for a screen reader.
    wrap.setAttribute('aria-hidden', 'true');
    const canvas = canvases.get(this.id);
    // Missing only if the call threw before reaching the widget method, in
    // which case an empty container is the honest thing to show.
    if (canvas) wrap.appendChild(canvas);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const widgetField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(widgets, tr) {
    // Keep each canvas pinned to the end of its call as the buffer is edited;
    // only a new eval rebuilds the set.
    if (tr.docChanged) widgets = widgets.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setWidgets)) {
        const decorations = e.value.map((config) =>
          Decoration.widget({ widget: new CanvasWidget(config), side: 1 }).range(
            Math.min(config.to, tr.newDoc.length),
          ),
        );
        widgets = Decoration.set(decorations, true);
      }
    }
    return widgets;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const widgetExtension = [widgetField];

// Redraw the inline visualizers from the transpiler's meta.widgets. Call once
// per successful eval, alongside updateMiniLocations() and updateSliders().
export const updateWidgets = (view, widgets) => {
  const configs = (widgets || []).filter((w) => w?.type && w.type !== 'slider');
  // Every live widget was just rebuilt by the eval that produced these
  // locations, so any other canvas belongs to code that's gone.
  const live = new Set(configs.map(getWidgetID));
  for (const id of canvases.keys()) {
    if (!live.has(id)) {
      canvases.delete(id);
      spectrumFrames.delete(id);
    }
  }
  view.dispatch({ effects: setWidgets.of(configs) });
};
