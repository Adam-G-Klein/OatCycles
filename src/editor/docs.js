import { hoverTooltip } from '@codemirror/view';
import docs from './strudel-docs.json';

// Function documentation on mouse hover.
//
// Strudel documents every pattern function with JSDoc; we pre-generated that
// into strudel-docs.json (see the generation notes in DESIGN.md / the repo).
// Here we surface it: hovering a function name with the *mouse* pops a tooltip
// with its description, parameters, and — when the docs include one — an
// example usage. This is deliberately mouse-driven (CodeMirror's hoverTooltip
// tracks the pointer), so it never fires for the vim cursor's position.

// Index every documented name plus its synonyms so `fast`/`density` etc. all
// resolve to the same entry. First writer wins so canonical names aren't
// clobbered by another function that merely lists them as a synonym.
const byName = new Map();
for (const entry of docs) {
  for (const key of [entry.name, entry.longname, ...(entry.synonyms || [])]) {
    if (key && !byName.has(key)) byName.set(key, entry);
  }
}

const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
};

// A doc entry can be reached through a synonym; when it is, present that
// synonym as the title and list the remaining names (including the canonical
// one) as synonyms — mirroring how Strudel's own reference behaves.
function viewForWord(entry, word) {
  const canonical = entry.name || entry.longname;
  if (word === canonical) {
    return { title: canonical, synonyms: entry.synonyms || [] };
  }
  const synonyms = [canonical, ...(entry.synonyms || [])].filter((n) => n && n !== word);
  return { title: word, synonyms };
}

function buildTooltip(entry, word) {
  const { title, synonyms } = viewForWord(entry, word);

  const dom = document.createElement('div');
  dom.className = 'oat-doc-tooltip';

  const name = document.createElement('h3');
  name.className = 'oat-doc-name';
  name.textContent = title;
  dom.appendChild(name);

  if (synonyms.length) {
    const syn = document.createElement('div');
    syn.className = 'oat-doc-synonyms';
    syn.textContent = `Synonyms: ${synonyms.join(', ')}`;
    dom.appendChild(syn);
  }

  if (entry.description) {
    const desc = document.createElement('div');
    desc.className = 'oat-doc-description';
    // Trusted: generated at build time from Strudel's own JSDoc.
    desc.innerHTML = entry.description;
    dom.appendChild(desc);
  }

  if (entry.params?.length) {
    const section = document.createElement('div');
    section.className = 'oat-doc-section';
    const heading = document.createElement('h4');
    heading.className = 'oat-doc-section-title';
    heading.textContent = 'Parameters';
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'oat-doc-params';
    for (const param of entry.params) {
      const item = document.createElement('li');
      item.className = 'oat-doc-param';
      const pName = document.createElement('span');
      pName.className = 'oat-doc-param-name';
      pName.textContent = param.name ?? '';
      item.appendChild(pName);
      if (param.type?.length) {
        const pType = document.createElement('span');
        pType.className = 'oat-doc-param-type';
        pType.textContent = param.type.join(' | ');
        item.appendChild(pType);
      }
      if (param.description) {
        const pDesc = document.createElement('div');
        pDesc.className = 'oat-doc-param-desc';
        pDesc.innerHTML = param.description;
        item.appendChild(pDesc);
      }
      list.appendChild(item);
    }
    section.appendChild(list);
    dom.appendChild(section);
  }

  // Example usage — only when the docs actually ship one.
  if (entry.examples?.length) {
    const section = document.createElement('div');
    section.className = 'oat-doc-section';
    const heading = document.createElement('h4');
    heading.className = 'oat-doc-section-title';
    heading.textContent = entry.examples.length > 1 ? 'Examples' : 'Example';
    section.appendChild(heading);
    for (const example of entry.examples) {
      const pre = document.createElement('pre');
      pre.className = 'oat-doc-example';
      pre.innerHTML = escapeHtml(example);
      section.appendChild(pre);
    }
    dom.appendChild(section);
  }

  return dom;
}

// Plain mouse-hover tooltip: no modifier key required. hoverTime keeps it from
// flashing on every quick pass of the pointer.
export const docHoverTooltip = hoverTooltip(
  (view, pos, side) => {
    const { from, to, text } = view.state.doc.lineAt(pos);
    let start = pos;
    let end = pos;
    while (start > from && /\w/.test(text[start - from - 1])) start--;
    while (end < to && /\w/.test(text[end - from])) end++;
    if ((start === pos && side < 0) || (end === pos && side > 0)) return null;

    const word = text.slice(start - from, end - from);
    const entry = byName.get(word);
    if (!entry) return null;

    return {
      pos: start,
      end,
      above: true,
      arrow: true,
      create() {
        return { dom: buildTooltip(entry, word) };
      },
    };
  },
  { hoverTime: 300 },
);
