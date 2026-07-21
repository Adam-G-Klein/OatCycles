import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Prec, Compartment, EditorState } from '@codemirror/state';
import { toggleComment } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { vim, Vim } from '@replit/codemirror-vim';
import { highlightExtension, updateMiniLocations, highlightMiniLocations } from './highlight.js';
import { docHoverTooltip } from './docs.js';
import { formatCode } from './format/format.js';
import { formatConfig } from './format/config.js';

// Tokyo Night theme for the code area, so the in-browser editor matches the
// rest of the app chrome (see src/style.css for the shared palette). Kept here
// rather than pulling in a theme package to avoid another dependency.
const tn = {
  bg: '#1a1b26',
  fg: '#c0caf5',
  comment: '#565f89',
  cyan: '#7dcfff',
  blue: '#7aa2f7',
  purple: '#bb9af7',
  green: '#9ece6a',
  orange: '#ff9e64',
  red: '#f7768e',
  yellow: '#e0af68',
  teal: '#73daca',
  gutter: '#3b4261',
  selection: '#283457',
  activeLine: '#1e202e',
};

const tokyoNightTheme = EditorView.theme(
  {
    '&': { color: tn.fg, backgroundColor: tn.bg },
    '.cm-content': { caretColor: tn.fg },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: tn.fg },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: tn.selection },
    '.cm-activeLine': { backgroundColor: tn.activeLine },
    '.cm-gutters': { backgroundColor: tn.bg, color: tn.gutter, border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: tn.activeLine, color: tn.fg },
    '.cm-lineNumbers .cm-gutterElement': { color: tn.gutter },
    '.cm-selectionMatch': { backgroundColor: '#283457' },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: '#283457',
      outline: `1px solid ${tn.blue}`,
    },
    '.cm-tooltip': { border: 'none', backgroundColor: '#16161e', color: tn.fg },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: tn.selection,
      color: tn.fg,
    },
  },
  { dark: true },
);

const tokyoNightHighlight = HighlightStyle.define([
  // Dim + italicize anything commented out — single-line (//), multi-line
  // (/* ... */) and doc (/** ... */) comments alike. The grammar tags these
  // separately, so we list them explicitly rather than lean on tag inheritance.
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: tn.comment,
    fontStyle: 'italic',
  },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: tn.purple },
  { tag: [t.string, t.special(t.string)], color: tn.green },
  { tag: [t.number, t.bool, t.null], color: tn.orange },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: tn.blue },
  { tag: [t.definition(t.variableName)], color: tn.fg },
  { tag: [t.variableName, t.propertyName], color: tn.fg },
  { tag: [t.className, t.typeName, t.namespace], color: tn.teal },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#89ddff' },
  { tag: [t.propertyName], color: tn.fg },
  { tag: [t.self, t.atom, t.constant(t.name)], color: tn.orange },
  { tag: [t.definition(t.propertyName)], color: tn.fg },
  { tag: [t.regexp], color: tn.teal },
  { tag: [t.meta, t.documentMeta], color: tn.comment },
  { tag: t.invalid, color: tn.red },
]);

const tokyoNight = [tokyoNightTheme, syntaxHighlighting(tokyoNightHighlight)];

// A minimal CodeMirror 6 editor for OatCycles.
//
// M1 layers Strudel-style vim keybindings on top of the M0 editor. Rather than
// pull in the whole @strudel/codemirror package (which also bundles emacs,
// helix, vscode keymaps and routes actions through DOM custom-events), we
// depend directly on @replit/codemirror-vim — exactly what Strudel's
// `keybindings('vim')` returns internally — and wire the useful ex-commands
// (`:w`, `:q`, `gc`) straight to our own play/stop/comment callbacks.
//
// Vim is toggleable at runtime via a CodeMirror Compartment, so flipping the
// setting reconfigures the live editor instead of rebuilding it.

// The Vim object is a singleton shared across all editors, so its ex-commands
// and custom actions must be defined exactly once. We stash the active
// editor's callbacks in module scope and have the commands read from there.
let vimCommandsRegistered = false;
const handlers = {
  onEvaluate: null,
  onStop: null,
  onOpenSongs: null,
  onRenameSong: null,
  onNewSong: null,
  onCopySong: null,
  onShowKeyboard: null,
  onHideKeyboard: null,
  onFormat: null,
  onStatus: null,
};

function registerVimCommands() {
  if (vimCommandsRegistered) return;
  vimCommandsRegistered = true;

  // :w — evaluate the current buffer (mirrors Ctrl-Enter).
  Vim.defineEx('write', 'w', () => handlers.onEvaluate?.());

  // :q — stop playback (mirrors Ctrl-.).
  Vim.defineEx('quit', 'q', () => handlers.onStop?.());

  // :f — format the current buffer (see src/editor/format/). Full name `format`
  // as the ex-prefix so `:f` maps here rather than to stock vim's :file.
  Vim.defineEx('format', 'f', () => handlers.onFormat?.());

  // gc — toggle line comment in normal and visual mode. We drive CodeMirror's
  // own toggleComment against the underlying EditorView (cm.cm6).
  Vim.defineAction('oatToggleComment', (cm) => {
    const view = cm.cm6;
    if (view) toggleComment(view);
  });
  Vim.mapCommand('gc', 'action', 'oatToggleComment', {}, { context: 'normal' });
  Vim.mapCommand('gc', 'action', 'oatToggleComment', {}, { context: 'visual' });

  // kj (typed in sequence) leaves insert mode — same as Esc / Ctrl-[. Swap to
  // 'jk' here if that ordering feels more natural.
  Vim.map('kj', '<Esc>', 'insert');

  // :o — open the songs side panel (short for :open; `o` is unclaimed by stock
  // vim, whose only o-prefixed ex-commands are omap/onoremap/omapclear).
  Vim.defineEx('open', 'o', () => handlers.onOpenSongs?.());

  // :name <filename> — rename the current song. argString is everything after
  // the command, so multi-word names survive.
  Vim.defineEx('name', 'name', (cm, params) => handlers.onRenameSong?.(params.argString));

  // :new [name] — start a fresh song (blank buffer). Auto-names if omitted.
  Vim.defineEx('new', 'new', (cm, params) => handlers.onNewSong?.(params.argString));

  // :copy — duplicate the current song into a new numbered file (song → song1,
  // song1 → song2). Full name as the ex-prefix so stock vim's :copy/:co (copy
  // lines) intent maps here rather than to a partial abbreviation.
  Vim.defineEx('copy', 'copy', () => handlers.onCopySong?.());

  // :kyb — show the reference keyboard docked at the bottom of the screen.
  // :nkyb — hide it again. Both use their full names as the ex-prefix so `:k`
  // (stock vim's mark command) is left untouched.
  Vim.defineEx('kyb', 'kyb', () => handlers.onShowKeyboard?.());
  Vim.defineEx('nkyb', 'nkyb', () => handlers.onHideKeyboard?.());
}

export function createEditor({
  parent,
  initialCode = '',
  onEvaluate,
  onStop,
  onShowKeyboard,
  onHideKeyboard,
  onStatus,
  vimMode = false,
}) {
  handlers.onEvaluate = onEvaluate;
  handlers.onStop = onStop;
  handlers.onShowKeyboard = onShowKeyboard;
  handlers.onHideKeyboard = onHideKeyboard;
  handlers.onStatus = onStatus;
  registerVimCommands();

  // High precedence so Ctrl-Enter / Ctrl-. win over default and vim bindings.
  const strudelKeymap = Prec.highest(
    keymap.of([
      {
        key: 'Mod-Enter',
        preventDefault: true,
        run: (view) => {
          onEvaluate?.(view.state.doc.toString());
          return true;
        },
      },
      {
        key: 'Mod-.',
        preventDefault: true,
        run: () => {
          onStop?.();
          return true;
        },
      },
    ]),
  );

  // Vim lives in its own compartment so it can be toggled at runtime. When on,
  // it must sit at the front of the extension list and allow multiple
  // selections (visual-block etc.) — the same shape as Strudel's keybindings().
  const vimCompartment = new Compartment();
  const vimExtension = () => [vim(), EditorState.allowMultipleSelections.of(true)];

  const view = new EditorView({
    doc: initialCode,
    parent,
    extensions: [
      vimCompartment.of(vimMode ? vimExtension() : []),
      strudelKeymap,
      basicSetup,
      javascript(),
      tokyoNight,
      // Draws Strudel-style boxes around the tokens currently making sound.
      // Fed by updateMiniLocations() on eval and highlightHaps() every frame.
      highlightExtension,
      // Mouse-hover documentation: pointing at a known function name pops its
      // docs + example usage, sourced from Strudel's JSDoc (strudel-docs.json).
      docHoverTooltip,
    ],
  });

  function setVimMode(on) {
    view.dispatch({
      effects: vimCompartment.reconfigure(on ? vimExtension() : []),
    });
    view.focus();
  }

  // Replace the current selection (or insert at the cursor) with `text`, then
  // place the cursor after it and refocus. Used by the MIDI panel to drop a
  // midikeys() snippet into the buffer.
  function insertAtCursor(text) {
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  }

  // Replace the whole buffer (used when opening / creating a song). Moves the
  // cursor to the top and refocuses.
  function setCode(code) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: code },
      selection: { anchor: 0 },
    });
    view.focus();
  }

  // Format the whole buffer via the `:f` command. Prettier + our per-function
  // overrides (see format/). On a syntax error we leave the buffer untouched
  // and report it, rather than risk clobbering in-progress code.
  async function formatBuffer() {
    const code = view.state.doc.toString();
    let formatted;
    try {
      formatted = await formatCode(code, formatConfig);
    } catch (err) {
      handlers.onStatus?.('format error: ' + (err?.message ?? err), 'error');
      view.focus();
      return;
    }
    if (formatted === code) {
      view.focus();
      return;
    }
    // Keep the cursor roughly where it was — clamped into the reflowed text.
    const anchor = Math.min(view.state.selection.main.anchor, formatted.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
      selection: { anchor },
    });
    view.focus();
    handlers.onStatus?.('formatted');
  }
  handlers.onFormat = formatBuffer;

  // Fill in the songs-panel command callbacks after the panel is constructed
  // (main.js builds the editor first, then the panel, then wires these).
  function setSongCommands({ onOpenSongs, onRenameSong, onNewSong, onCopySong }) {
    handlers.onOpenSongs = onOpenSongs;
    handlers.onRenameSong = onRenameSong;
    handlers.onNewSong = onNewSong;
    handlers.onCopySong = onCopySong;
  }

  return {
    view,
    getCode: () => view.state.doc.toString(),
    setCode,
    setVimMode,
    insertAtCursor,
    setSongCommands,
    formatBuffer,
    focus: () => view.focus(),
    // Replace the mini-notation locations to highlight (from the transpiler's
    // meta.miniLocations after each eval).
    updateMiniLocations: (locations) => updateMiniLocations(view, locations),
    // Report the haps sounding at `time` so their tokens get boxed this frame.
    highlightHaps: (time, haps) => highlightMiniLocations(view, time, haps),
  };
}
