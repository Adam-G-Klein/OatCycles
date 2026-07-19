import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Prec, Compartment, EditorState } from '@codemirror/state';
import { toggleComment } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { vim, Vim } from '@replit/codemirror-vim';

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
const handlers = { onEvaluate: null, onStop: null };

function registerVimCommands() {
  if (vimCommandsRegistered) return;
  vimCommandsRegistered = true;

  // :w — evaluate the current buffer (mirrors Ctrl-Enter).
  Vim.defineEx('write', 'w', () => handlers.onEvaluate?.());

  // :q — stop playback (mirrors Ctrl-.).
  Vim.defineEx('quit', 'q', () => handlers.onStop?.());

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
}

export function createEditor({ parent, initialCode = '', onEvaluate, onStop, vimMode = false }) {
  handlers.onEvaluate = onEvaluate;
  handlers.onStop = onStop;
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
    ],
  });

  function setVimMode(on) {
    view.dispatch({
      effects: vimCompartment.reconfigure(on ? vimExtension() : []),
    });
    view.focus();
  }

  return {
    view,
    getCode: () => view.state.doc.toString(),
    setVimMode,
  };
}
