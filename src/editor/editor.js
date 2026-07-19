import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';

// A minimal CodeMirror 6 editor for OatCycles.
//
// M0 keeps this deliberately small: syntax-highlit JS + evaluate/stop
// keybindings. M1 will layer Strudel's vim keybindings on top (this is the
// seam where `keybindings('vim')` from @strudel/codemirror gets inserted).
export function createEditor({ parent, initialCode = '', onEvaluate, onStop }) {
  // High precedence so Ctrl-Enter / Ctrl-. win over default bindings.
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

  const view = new EditorView({
    doc: initialCode,
    parent,
    extensions: [strudelKeymap, basicSetup, javascript()],
  });

  return {
    view,
    getCode: () => view.state.doc.toString(),
  };
}
