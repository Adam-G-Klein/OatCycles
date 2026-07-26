// Mini-notation cheatsheet, docked in the same bottom preview area as the
// reference keyboard (:mini shows, :nmini hides — see editor.js / main.js).
//
// Everything here is the mini-notation *inside the quotes* of a pattern
// function — the little rhythm language Strudel parses with the krill grammar
// (node_modules/@strudel/mini/krill.pegjs). Each example below is a string that
// grammar accepts; the operator set is taken straight from it, so this stays
// honest about what the engine actually supports rather than what the docs
// happen to mention.

const SECTIONS = [
  {
    title: 'Steps',
    rows: [
      ['s("bd sd hh")', 'a sequence — the cycle splits evenly between steps'],
      ['bd ~ sd ~', '~ is a rest'],
      ['bd:3', 'sample 3 of the bd bank'],
      ['0 .. 3', 'range — expands to 0 1 2 3'],
    ],
  },
  {
    title: 'Grouping',
    rows: [
      ['bd [sd sd]', 'a subsequence packed into one step'],
      ['bd . sd sd . hh', 'same thing without brackets — each . is one step'],
      ['<bd sd cp>', 'alternate — one per cycle'],
      ['bd sd, hh hh hh', 'stack — comma-separated layers play at once'],
      ['[bd | sd | cp]', 'pick one at random each cycle'],
    ],
  },
  {
    title: 'Timing',
    rows: [
      ['bd*2', 'faster — repeat inside its own step'],
      ['bd/2', 'slower — one step stretched over 2 cycles'],
      ['bd@3 sd', 'elongate — bd takes 3 units of time, sd takes 1'],
      ['bd _ _ sd', 'same as bd@3 sd'],
      ['bd!3 sd', 'replicate — three separate bd steps'],
      ['bd ! ! sd', 'bare ! repeats the step before it'],
    ],
  },
  {
    title: 'Chance',
    rows: [
      ['hh? hh? hh?', 'drop each one half the time'],
      ['hh?0.3', 'drop it 30% of the time'],
    ],
  },
  {
    title: 'Euclid & polymeter',
    rows: [
      ['bd(3,8)', '3 hits spread as evenly as possible over 8 steps'],
      ['bd(3,8,2)', 'the same rhythm, rotated 2 steps'],
      ['{bd sd, hh hh hh}', 'polymeter — shared step length, so the layers phase'],
      ['{bd sd cp}%4', 'polymeter forced to 4 steps per cycle'],
    ],
  },
  {
    title: 'Nesting',
    rows: [
      ['<[bd bd] sd>*2', 'operators apply to whole groups, not just steps'],
      ['bd(<3 5>,8)', 'arguments are patterns too'],
      ['note("c3 [e3 g3]")', 'any pattern function takes mini-notation'],
    ],
  },
];

// Build once, on first show. The panel is static, so there's nothing to
// re-render — the root just gets un-hidden on later shows.
function build(root) {
  const header = document.createElement('div');
  header.className = 'mini-ref-header';

  const title = document.createElement('span');
  title.textContent = 'Mini-notation';
  header.appendChild(title);

  const hint = document.createElement('span');
  hint.className = 'mini-ref-hint';
  hint.textContent = ':nmini to hide';
  header.appendChild(hint);

  root.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'mini-ref-grid';

  for (const section of SECTIONS) {
    const card = document.createElement('section');
    card.className = 'mini-ref-card';

    const heading = document.createElement('h3');
    heading.textContent = section.title;
    card.appendChild(heading);

    const list = document.createElement('dl');
    for (const [code, description] of section.rows) {
      const dt = document.createElement('dt');
      dt.textContent = code;
      const dd = document.createElement('dd');
      dd.textContent = description;
      list.append(dt, dd);
    }
    card.appendChild(list);
    grid.appendChild(card);
  }

  root.appendChild(grid);
}

export function setupCheatsheet(root) {
  let built = false;
  return {
    show() {
      if (!built) {
        build(root);
        built = true;
      }
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}
