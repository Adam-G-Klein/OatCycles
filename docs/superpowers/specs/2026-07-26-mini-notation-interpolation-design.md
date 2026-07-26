# `${…}` holes in mini-notation strings

## The problem

A song like `songs/dave1.js` keeps its material in arrays of mini strings and
splices them with `pick`:

```js
const bassNotes = ["[0, 8]", "[f1, f2]", "[bb1, bb2]"];
bassline: note(pick(bassNotes, "0!16 1!16 2!16"))
```

`pick` works at the pattern level, so it can only substitute a *whole* pattern.
It cannot reach inside a string: there is no way to write "this figure, repeated
however many times `bars` currently says", or to build one line out of a
constant head and a computed tail.

JavaScript already has the notation for that — `` `[bb1, bb2]!${bars}` `` — but
it does not survive the trip. Strudel's transpiler treats every backtick string
as mini-notation and reads only `quasis[0].value.raw` (`transpiler.mjs:75`), so
today everything from the first `${` onward is **silently dropped**:
`` `[bb1, bb2]!${bars}` `` plays as `[bb1, bb2]!`. Double-quoted strings are not
interpolated by JavaScript at all.

And even if the text arrived intact, it would be assembled once, at eval time.
The point of a hole is that its value moves while the music runs.

## The design

Any mini string — `"…"` or `` `…` `` — may contain `${…}` holes. Each hole's
code is re-run **once at the start of every cycle** and its result is spliced
into the string as text, exactly as if it had been typed there. The string is
then parsed as mini-notation as usual.

```js
const bars = 16;
const arr = ["[f1, f2]", "[g1, g2]"];
let i = 0;

note(`[bb1, bb2]!${bars} [f1. f2]!${arr[i]}`)
```

Holes are text substitution, not pattern substitution: `!${bars}` is a
replication count, `${arr[i]}` is a whole sub-figure, `${dir}${n}` concatenates.
Anything the mini parser accepts can be built this way.

Both quote styles interpolate. Double-quoted strings are the ones the songs are
already written in, and re-quoting them to gain a hole would be friction at
exactly the wrong moment. The cost is that `"…"` no longer means "literal" —
`\${` escapes a `$` that is meant literally, and a `// mini-off` / `// mini-on`
region opts out entirely (both quote styles, same comments the transpiler
already honours for mini-notation itself).

### Hole values: string or number

A hole must evaluate to a string or a finite number. Numbers are stringified —
`!${bars}` with `bars = 16` gives `!16` — because counts, factors and note
numbers are the obvious things to compute, and demanding `String(bars)` at every
one of them would be ceremony.

Everything else throws, naming the hole and what it got:

```
hole 2 in mini string: expected a string or number, got Pattern
```

`Pattern` is the mistake worth predicting: `${pick(arr, i)}` returns a pattern,
not text. The message names the type so the fix is obvious.

### Where the work happens

Three things must be true at once: the hole's code has to see the variables
around it (`bars`, `arr`, `i` are ordinary locals in the buffer), it must not run
until the cycle asks for it, and everything else in the buffer must keep getting
Strudel's normal treatment.

`initStrudel()` hardcodes Strudel's transpiler (`web.mjs:35`), so we do not
replace it. Instead a **pre-pass** rewrites the buffer before `evaluate()` sees
it, into code that Strudel's transpiler then walks as usual. The rewrite emits
**single-quoted** strings, which that transpiler ignores entirely
(`isStringWithDoubleQuotes` tests `raw[0] === '"'`), so the generated text passes
through untouched while sliders, widgets and plain mini strings elsewhere behave
exactly as they do now.

```js
note(`[bb1, bb2]!${bars} [f1. f2]!${arr[i]}`)
```

becomes

```js
note(oatMini({ c: ['[bb1, bb2]!', ' [f1. f2]!', ''], h: [[17, 24], [34, 43]], o: 6 },
             () => [bars, arr[i]]))
```

- `c` — the literal chunks, one more than there are holes.
- `h` — each hole's `${…}` range **in the user's document**, for highlighting.
- `o` — where the string's text starts in the document.
- the thunk — the hole expressions, copied verbatim from the source, so they
  close over the surrounding scope and nothing is evaluated at rewrite time.

Copying the expressions verbatim also means Strudel's transpiler still sees
what is inside a hole: a `slider(…)` or a `"0 1"` in there is transpiled
normally.

### `src/lang/interpolate.js` — the rewrite

Pure, no imports from the engine. `expandInterpolations(code)` returns
`{ code, map }`.

Parses with acorn using the same options as the transpiler (`ecmaVersion: 2022`,
`allowAwaitOutsideFunction`, `locations`, `onComment`) so that anything Strudel
accepts, we accept — including top-level `await` and the `bassline:` label form.
A parse error is rethrown as-is; it is the same error the next stage would have
raised.

It walks the AST for string literals containing `${` and template literals with
expressions, skipping tagged templates (`mondo`…``, which belong to Strudel's
language registry) and anything inside a `mini-off` region. Output is built by a
single left-to-right emitter that either copies a span verbatim or writes
generated text. Nested sites — a hole containing another interpolated string —
are rendered by the same routine recursively, so the inner one is rewritten
before it is spliced into the outer.

Chunk text is taken **raw** from the source, matching how the transpiler already
treats backtick strings. The one escape processed is `\${` → `${`. Chunks are
re-quoted for emission with `'` and `\` escaped.

**The offset map.** The rewrite lengthens the code, so every offset after the
first hole moves. `map` records, for each verbatim span, `(origStart, outStart,
length)`; `mapOffset(out)` binary-searches it back to a document offset. Every
location Strudel's transpiler emits afterwards points either into a verbatim
span (user-written code) or into our single-quoted chunks, which it never looks
at — so the map is total over what actually needs remapping.

### `src/lang/mini-template.js` — the runtime

`oatMini(meta, holes)` returns a pattern, and is put in the eval scope with
`evalScope({ oatMini })` alongside `registerSliders()` in `prebake` — the same
deadline, for the same reason: the rewritten call reaches eval as a bare
identifier.

The pattern is built the way `slider.js` builds its live value, one layer down:

```js
pure(1)
  .withHaps((haps) => haps.map((hap) => hap.withValue(() => reify(build(hap.whole.begin.sam())))))
  .innerJoin();
```

`pure(1)` has exactly one hap per cycle, and `innerJoin` takes its structure
from the inner pattern, so the string in force is the one `build` returned for
the cycle being queried.

`build(cycle)` is memoised on the cycle number. This is what makes "at the start
of each cycle" true rather than approximate: the scheduler queries the same
cycle on every tick (~20 times a second), and a visualizer's draw window queries
two cycles either side, so without the memo the holes would run constantly and a
mutating counter would slew mid-cycle. The memo keeps the last 8 cycles, which
covers the draw window without unbounded growth.

Underneath it is a second, one-slot memo on the assembled *string* → pattern: in
the ordinary case the string is unchanged from last cycle and the mini parse is
skipped entirely. Only a genuinely new string is parsed.

On a miss, `build` calls the thunk, checks each value, joins chunks and values,
and parses with `m(assembled, 0)`. Then it remaps locations (below) and caches.

**Errors.** A hole that throws, a hole with a bad type, or an assembled string
the mini parser rejects all propagate out of the query, as chosen. In practice
`Cyclist` catches per tick (`cyclist.mjs:78`): it logs and keeps ticking, so
that pattern emits nothing while broken and picks up again when the code is
fixed — the scheduler does not go down. To make that visible rather than
console-only, `main.js` subscribes to the `strudel.log` document event
(`logger.mjs:26`) and shows `[cyclist] error: …` in the topbar in red.

`build` also runs once eagerly at eval time, so a hole that is broken outright
fails on Cmd+Enter through the existing `onEvalError` path instead of a cycle
later. The result is cached, so cycle 0 does not pay for it twice.

### Highlighting

Leaf locations come out of the mini parser as offsets into the *assembled*
string, which does not exist in the document. Each is mapped back:

- a leaf lying inside a chunk → its true document range, so literal text boxes
  exactly as it does today;
- a leaf overlapping a hole → that hole's whole `${…}` range, so the expression
  lights up when what it produced is sounding;
- a leaf spanning both → the union.

(`m` builds its AST from `'"' + str + '"'`, so leaf offsets are one greater than
the index into the assembled string. The mapper subtracts the quote.) The mapped
ranges are attached with `withContext`, replacing `locations`.

The editor only draws a box where a mark exists, and its marks are set once per
eval from `meta.miniLocations`. So each site reports its current document ranges
whenever its assembled string changes — deferred to a microtask, never inside
the query — through a registry in `mini-template.js`. `main.js` holds the static
locations from the last eval and re-dispatches their union with the dynamic ones
on every change. The registry is cleared on each eval; sites re-register the
first time they are queried.

In the common case the string never changes, so this costs one dispatch per site
per eval.

### Two seams that shift underneath

**Widget positions.** `meta.widgets` offsets are positions in the rewritten
code, so `main.js` remaps them before handing them to the editor. But a slider's
*identity* is derived from its offset — the transpiler mints
`sliderWithID('slider_<start>', …)` and `slider.js:29` recomputes that id from
the widget's `from`. Remapping `from` would break the link, so remapped widgets
carry `srcFrom` (the pre-remap offset) and `sliderID` uses it when present.

**`meta.miniLocations`** are remapped the same way, in `afterEval`.

Both use the `map` from the most recent `expandInterpolations`, stashed by
`play()` — the code being transpiled is always the code we just rewrote.

## Testing

`node --test` with the rest of `test/` — no new dependency. Everything under
test is pure — no audio context, no editor.

`test/interpolate.test.js`
- holes found in `"…"` and `` `…` ``; `\${` escaped; `${` with no closer is
  literal text
- tagged templates and `mini-off` regions left alone; strings with no hole left
  byte-for-byte alone
- chunk/hole/offset tables against the document, including a string with holes
  at both ends and adjacent holes (`${a}${b}`, empty chunk between)
- nested sites: a hole containing an interpolated string
- `mapOffset` round-trips every user-code offset across several sites
- generated chunks are single-quoted and escape `'` and `\`
- a syntax error propagates unchanged

`test/mini-template.test.js` (the pure half: assembly, checking, the cycle memo
and the location mapper are exported and take their engine handles as
arguments, the way `src/panic.js` does)
- assembly from chunks and values; numbers stringified; a float, a negative
- a non-string, non-number hole throws naming the hole index and the type;
  `NaN`/`Infinity` rejected
- `build` is called once per cycle no matter how often that cycle is queried,
  and again on the next cycle
- an unchanged string is not re-parsed; a changed one is
- leaf→document mapping: chunk leaf exact, hole leaf boxes the `${…}`, spanning
  leaf takes the union

## Verification in the app

Under `?agent=1`, driven with `window.oat.silentPlay(code)` so nothing sounds
and nothing is written to `songs/`:

1. `note(\`[bb1, bb2]!${n}\`)` with a mutating `n` — assert the queried haps
   change at the cycle boundary and not within a cycle.
2. A slider placed after an interpolated string — assert its widget lands on the
   right characters and still drags.
3. A hole that throws — assert the topbar reports it and the transport survives.
