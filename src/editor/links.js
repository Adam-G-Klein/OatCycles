// Cmd-clickable links in the editor.
//
// Live-coding buffers are full of addresses — `samples('github:user/repo')`,
// a raw.githubusercontent.com bank URL, a link dropped in a comment — and the
// thing you want when you see one is to go look at it. This underlines them
// and opens them on Cmd-click (Ctrl-click off macOS), the same gesture every
// editor and terminal already trains you to expect.
//
// Two halves, both cheap: a ViewPlugin that decorates matches in the visible
// range only, and a mousedown handler that resolves the match under the
// pointer and hands it to the browser.

import { EditorView, ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// http(s) URLs plus Strudel's `github:owner/repo` pseudo-URL. Quotes, brackets
// and whitespace terminate the match, so a URL inside a string literal stops at
// the closing quote rather than swallowing the rest of the line.
const LINK_RE = /(?:https?:\/\/|github:)[^\s'"`,()[\]{}<>]+/g;

// Trailing sentence punctuation is almost never part of the address — but a
// dot inside one is (`.json`, `.com`), so only strip at the very end.
function trimTrailing(text) {
  return text.replace(/[.,;:!?]+$/, '');
}

// Ctrl-click is a right-click on macOS, so the modifier differs by platform.
const IS_MAC = /Mac|iP(?:hone|ad|od)/.test(navigator.userAgent);
const holdsModifier = (event) => (IS_MAC ? event.metaKey : event.ctrlKey);

// Turn matched text into something the browser can open. `github:owner/repo`
// and `github:owner/repo/branch` are Strudel's shorthand for a sample bank;
// the useful destination is the repository page, not the raw JSON.
export function linkHref(text) {
  if (!text.startsWith('github:')) return text;
  const path = text.slice('github:'.length).replace(/\/+$/, '');
  const [owner, repo, branch] = path.split('/');
  if (!owner || !repo) return null;
  const base = `https://github.com/${owner}/${repo}`;
  return branch ? `${base}/tree/${branch}` : base;
}

// Every link on one line, as {from, to, text} in document coordinates.
function linksInLine(line) {
  const found = [];
  LINK_RE.lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(line.text)) !== null) {
    const text = trimTrailing(match[0]);
    if (!text) continue;
    found.push({ from: line.from + match.index, to: line.from + match.index + text.length, text });
  }
  return found;
}

function linkAt(state, pos) {
  return linksInLine(state.doc.lineAt(pos)).find((l) => pos >= l.from && pos <= l.to) ?? null;
}

const linkMark = Decoration.mark({ class: 'cm-oat-link' });

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const link of linksInLine(line)) builder.add(link.from, link.to, linkMark);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const linkDecorations = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// The "links are clickable right now" affordance. Held-modifier state isn't in
// the editor's own event stream (you can press Cmd without typing anything), so
// this watches the window and toggles a class on the editor root; the theme
// below does the rest. Listeners are torn down with the view.
const modifierWatcher = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.armed = false;
      this.sync = (event) => this.set(holdsModifier(event));
      this.clear = () => this.set(false);
      window.addEventListener('keydown', this.sync);
      window.addEventListener('keyup', this.sync);
      window.addEventListener('mousemove', this.sync);
      window.addEventListener('blur', this.clear);
    }
    // mousemove fires constantly; only touch the DOM on an actual transition.
    set(on) {
      if (on === this.armed) return;
      this.armed = on;
      this.view.dom.classList.toggle('oat-link-armed', on);
    }
    destroy() {
      window.removeEventListener('keydown', this.sync);
      window.removeEventListener('keyup', this.sync);
      window.removeEventListener('mousemove', this.sync);
      window.removeEventListener('blur', this.clear);
      this.set(false);
    }
  },
);

const clickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !holdsModifier(event)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const link = linkAt(view.state, pos);
    if (!link) return false;
    const href = linkHref(link.text);
    if (!href) return false;
    // Swallow the event so the click doesn't also move the cursor or start a
    // drag-selection under the link we just opened.
    event.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  },
});

const linkTheme = EditorView.theme({
  '.cm-oat-link': { textDecoration: 'underline dotted', textUnderlineOffset: '3px' },
  '&.oat-link-armed .cm-oat-link': {
    textDecoration: 'underline solid',
    cursor: 'pointer',
  },
});

export const linkExtension = [linkDecorations, modifierWatcher, clickHandler, linkTheme];
