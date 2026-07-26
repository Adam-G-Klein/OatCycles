import { EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Prec, Compartment, EditorState } from '@codemirror/state';
import { toggleComment, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { vim, Vim } from '@replit/codemirror-vim';
import { basicSetupNoHistory } from './setup.js';
import { highlightExtension, updateMiniLocations, highlightMiniLocations } from './highlight.js';
import { sliderExtension, updateSliders } from './slider.js';
import { widgetExtension, updateWidgets } from './widget.js';
import { docHoverTooltip } from './docs.js';
import { linkExtension } from './links.js';
import { peruse } from './peruse.js';
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
  // Translucent rather than the flat #1e202e it resolves to over --bg, so the
  // cursor's line doesn't mask the visualizer canvas behind the editor.
  activeLine: 'rgba(192, 202, 245, 0.04)',
};

// The code area is deliberately transparent, so the full-screen visualizer
// canvas behind it (see main.js) can be seen through the code. The page's --bg
// is the same #1a1b26 this theme would otherwise paint, so with nothing drawing
// it looks exactly as it did — but anything opaque stacked in front of the
// canvas would punch a hole in the picture, hence the translucent active line
// and the transparent gutters.
const tokyoNightTheme = EditorView.theme(
  {
    '&': { color: tn.fg, backgroundColor: 'transparent' },
    '.cm-content': { caretColor: tn.fg },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: tn.fg },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: tn.selection },
    '.cm-activeLine': { backgroundColor: tn.activeLine },
    '.cm-gutters': { backgroundColor: 'transparent', color: tn.gutter, border: 'none' },
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
  onWriteOut: null,
  onShowKeyboard: null,
  onHideKeyboard: null,
  onShowMini: null,
  onHideMini: null,
  onFormat: null,
  onPeruse: null,
  onStatus: null,
  // Networked play: set while a multiplayer session is live, null when solo.
  // Undo has to delegate through these rather than use CodeMirror's stock
  // history, which under a CRDT would undo a collaborator's typing. See
  // src/editor/setup.js and NETWORKED-PLAY.md §5.2.
  sessionUndo: null,
  sessionRedo: null,
  onHostSession: null,
  onJoinSession: null,
  onLeaveSession: null,
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

  // :writeout [path] — write the current buffer to an arbitrary file on disk,
  // for redundancy (a git repo, a synced folder, a backup dir). argString
  // rather than args, so paths with spaces survive. With no path it reuses the
  // last one used for this song (see main.js).
  //
  // Full name as the ex-prefix, so `:w` (evaluate) and `:wq` keep their own
  // entries — vim's ex matcher takes the longest defined prefix of the input.
  Vim.defineEx('writeout', 'writeout', (cm, params) => handlers.onWriteOut?.(params.argString));

  // :kyb — show the reference keyboard docked at the bottom of the screen.
  // :nkyb — hide it again. Both use their full names as the ex-prefix so `:k`
  // (stock vim's mark command) is left untouched.
  Vim.defineEx('kyb', 'kyb', () => handlers.onShowKeyboard?.());
  Vim.defineEx('nkyb', 'nkyb', () => handlers.onHideKeyboard?.());

  // :mini — show the mini-notation cheatsheet in the same bottom dock as the
  // reference keyboard (the two are mutually exclusive; see main.js). :nmini
  // hides it. Full names as the ex-prefixes, so `:m` (stock vim's move) and
  // `:n` (next) are left alone.
  Vim.defineEx('mini', 'mini', () => handlers.onShowMini?.());
  Vim.defineEx('nmini', 'nmini', () => handlers.onHideMini?.());

  // :peruse — append (or refresh) a browsable index of every sound the file's
  // samples() calls import. See src/editor/peruse.js. Full name as the
  // ex-prefix: `:p` is stock vim's :print, and this is not that.
  Vim.defineEx('peruse', 'peruse', () => handlers.onPeruse?.());

  // --- networked play ------------------------------------------------------

  // u / Ctrl-r. Vim's own undo/redo actions live inside @replit/codemirror-vim,
  // not in our keymap, so they have to be re-bound here rather than filtered
  // out of a keymap array. In a session they route to Yjs's UndoManager (which
  // is scoped by transaction origin, so it only undoes *your* edits); solo they
  // fall through to CodeMirror's ordinary history. Vim's `_mapCommand` unshifts
  // onto the front of the default keymap, so these win over the stock bindings.
  //
  // Only the normal-mode `u` is remapped — in visual mode `u` is vim's
  // lowercase operator, which we leave alone.
  Vim.defineAction('oatUndo', (cm) => {
    if (handlers.sessionUndo) handlers.sessionUndo();
    else if (cm.cm6) undo(cm.cm6);
  });
  Vim.defineAction('oatRedo', (cm) => {
    if (handlers.sessionRedo) handlers.sessionRedo();
    else if (cm.cm6) redo(cm.cm6);
  });
  Vim.mapCommand('u', 'action', 'oatUndo', {}, { context: 'normal' });
  Vim.mapCommand('<C-r>', 'action', 'oatRedo', {}, { context: 'normal' });

  // :host / :join <room> [passphrase] / :leave — multiplayer, from the keyboard.
  // NB `:join` (and so `:j`) shadows stock vim's join-lines ex-command; normal
  // mode `J` still joins lines, which is how anyone actually does it.
  Vim.defineEx('host', 'host', () => handlers.onHostSession?.());
  Vim.defineEx('join', 'join', (cm, params) => handlers.onJoinSession?.(params.argString));
  Vim.defineEx('leave', 'leave', () => handlers.onLeaveSession?.());
}

export function createEditor({
  parent,
  initialCode = '',
  onEvaluate,
  onStop,
  onShowKeyboard,
  onHideKeyboard,
  onShowMini,
  onHideMini,
  onStatus,
  vimMode = false,
}) {
  handlers.onEvaluate = onEvaluate;
  handlers.onStop = onStop;
  handlers.onShowKeyboard = onShowKeyboard;
  handlers.onHideKeyboard = onHideKeyboard;
  handlers.onShowMini = onShowMini;
  handlers.onHideMini = onHideMini;
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

  // Networked play needs three more compartments (NETWORKED-PLAY.md §5):
  //
  //   collab   — the yCollab extension for the live session: remote cursors,
  //              selections, and Yjs-scoped undo. Empty when solo.
  //   history  — CodeMirror's stock undo history. On when solo, OFF during a
  //              session, where a linear document-state log would happily undo
  //              a collaborator's typing. (This is why basicSetup is expanded
  //              into setup.js without it — see that file's header.)
  //   lock     — read-only, used for a guest's "connecting…" window before the
  //              first remote update lands.
  let collabActive = false;
  let readOnly = false;
  const collabCompartment = new Compartment();
  const historyCompartment = new Compartment();
  const lockCompartment = new Compartment();
  const historyExtension = () => [history(), keymap.of(historyKeymap)];
  const lockExtension = () => [EditorState.readOnly.of(true), EditorView.editable.of(false)];

  const view = new EditorView({
    doc: initialCode,
    parent,
    extensions: [
      vimCompartment.of(vimMode ? vimExtension() : []),
      strudelKeymap,
      collabCompartment.of([]),
      historyCompartment.of(historyExtension()),
      lockCompartment.of([]),
      basicSetupNoHistory,
      javascript(),
      tokyoNight,
      // Draws Strudel-style boxes around the tokens currently making sound.
      // Fed by updateMiniLocations() on eval and highlightHaps() every frame.
      highlightExtension,
      // Draggable range inputs in front of every slider(...) value, fed by
      // updateSliders() with the transpiler's widget locations on eval.
      sliderExtension,
      // Canvases for the inline visualizers (._punchcard(), ._scope(), …),
      // placed after the call that asked for them by updateWidgets().
      widgetExtension,
      // Mouse-hover documentation: pointing at a known function name pops its
      // docs + example usage, sourced from Strudel's JSDoc (strudel-docs.json).
      docHoverTooltip,
      // Cmd-click (Ctrl-click off macOS) opens URLs and `github:` sample specs.
      linkExtension,
    ],
  });

  function setVimMode(on) {
    view.dispatch({
      effects: vimCompartment.reconfigure(on ? vimExtension() : []),
    });
    view.focus();
  }

  // --- networked play -------------------------------------------------------

  // Turn a multiplayer session on or off in the live editor.
  //
  // Order matters. y-codemirror.next's sync plugin does *not* seed the editor
  // from the Y.Text when it mounts — it only observes changes from then on — so
  // the buffer has to be made to match the shared document *before* the
  // extension goes in. Doing it the other way round would push the difference
  // into the CRDT as a local edit, which for a joining guest means their buffer
  // is concatenated onto the host's.
  //
  // Two dispatches, deliberately: the first happens while collab is still off,
  // so the sync plugin never sees it.
  function setCollab(extension, text) {
    const on = !!extension && extension.length !== 0;
    collabActive = on;
    if (text != null && text !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
      });
    }
    view.dispatch({
      effects: [
        collabCompartment.reconfigure(on ? extension : []),
        // Stock history and the CRDT must never both be live.
        historyCompartment.reconfigure(on ? [] : historyExtension()),
      ],
    });
    if (!on) setReadOnly(false);
    view.focus();
  }

  // Idempotent on purpose. This is driven by session state changes, and those
  // include awareness ticks that y-codemirror.next fires from *inside* a view
  // update (it publishes the local cursor position there) — dispatching during
  // an update throws. Since the lock only ever changes on a status transition,
  // bailing when the value is unchanged removes the hazard entirely.
  function setReadOnly(on) {
    if (on === readOnly) return;
    readOnly = on;
    view.dispatch({ effects: lockCompartment.reconfigure(on ? lockExtension() : []) });
  }

  // A 2px accent in your own peer colour while a session is live, so there's
  // never a beat of "wait, am I typing into someone else's file?". Drawn as an
  // inset outline rather than a border so it costs no layout.
  function setAccent(color) {
    view.dom.classList.toggle('oat-session', !!color);
    if (color) view.dom.style.setProperty('--oat-peer-color', color);
    else view.dom.style.removeProperty('--oat-peer-color');
  }

  // Point vim's `u` / `Ctrl-r` at the session's Yjs UndoManager. Pass null to
  // hand them back to CodeMirror's history.
  function setSessionUndo(commands) {
    handlers.sessionUndo = commands?.undo ?? null;
    handlers.sessionRedo = commands?.redo ?? null;
  }

  function setSessionCommands({ onHostSession, onJoinSession, onLeaveSession }) {
    handlers.onHostSession = onHostSession;
    handlers.onJoinSession = onJoinSession;
    handlers.onLeaveSession = onLeaveSession;
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
  //
  // Refused during a multiplayer session: inside one this isn't "I opened a
  // song," it's "I replaced everyone's work." The songs panel disables the
  // commands that would call it (see songs.js), and this is the backstop.
  function setCode(code) {
    if (collabActive) {
      handlers.onStatus?.('in session — :leave to switch songs', 'error');
      return;
    }
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

  // `:peruse` — index every sound the buffer's samples() calls import.
  async function peruseBuffer() {
    try {
      await peruse(view, handlers.onStatus);
    } catch (err) {
      console.error(err);
      handlers.onStatus?.('peruse failed: ' + (err?.message ?? err), 'error');
      view.focus();
    }
  }
  handlers.onPeruse = peruseBuffer;

  // Fill in the songs-panel command callbacks after the panel is constructed
  // (main.js builds the editor first, then the panel, then wires these).
  function setSongCommands({ onOpenSongs, onRenameSong, onNewSong, onCopySong, onWriteOut }) {
    handlers.onOpenSongs = onOpenSongs;
    handlers.onRenameSong = onRenameSong;
    handlers.onNewSong = onNewSong;
    handlers.onCopySong = onCopySong;
    handlers.onWriteOut = onWriteOut;
  }

  return {
    view,
    getCode: () => view.state.doc.toString(),
    setCode,
    setVimMode,
    insertAtCursor,
    setSongCommands,
    setCollab,
    setReadOnly,
    setAccent,
    setSessionUndo,
    setSessionCommands,
    formatBuffer,
    peruseBuffer,
    focus: () => view.focus(),
    // Replace the mini-notation locations to highlight (from the transpiler's
    // meta.miniLocations after each eval).
    updateMiniLocations: (locations) => updateMiniLocations(view, locations),
    // Redraw the inline sliders (from the transpiler's meta.widgets).
    updateSliders: (widgets) => updateSliders(view, widgets),
    // Reposition the inline visualizer canvases (same meta.widgets list).
    updateWidgets: (widgets) => updateWidgets(view, widgets),
    // Report the haps sounding at `time` so their tokens get boxed this frame.
    highlightHaps: (time, haps) => highlightMiniLocations(view, time, haps),
  };
}
