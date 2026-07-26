// `basicSetup`, expanded — minus the undo history.
//
// This is the `codemirror` package's own basicSetup definition copied verbatim
// (that package's docs explicitly invite this: "you take this package's source
// ... copy it into your own code, and adjust it as desired"), with exactly two
// entries removed: `history()` and `...historyKeymap`.
//
// Why: under a CRDT, CodeMirror's stock history is *wrong*. It's a linear log
// of document states, so pressing `u` during a collaborative session would
// happily undo a collaborator's typing. During a session, undo comes from Yjs's
// UndoManager instead, which is scoped by transaction origin and therefore
// undoes only your own edits (see src/net/session.js).
//
// Solo mode still wants ordinary undo, so `history()` + `historyKeymap` live in
// their own compartment in editor.js — on when solo, off during a session.
// Keeping them out of *this* array is what makes that toggle possible.

import {
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldKeymap,
} from '@codemirror/language';
import { defaultKeymap } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  closeBrackets,
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';

export const basicSetupNoHistory = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  // history(),  ← removed; see the header comment.
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    // ...historyKeymap,  ← removed; see the header comment.
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];
