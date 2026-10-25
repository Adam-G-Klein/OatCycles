// Drum-kit cheatsheet, docked in the same bottom preview area as the reference
// keyboard and the mini-notation sheet (:drums shows, :ndrums hides — see
// editor.js / main.js).
//
// The sample banks (tidal-drum-machines.json, loaded in main.js's prebake) name
// every sound <machine>_<part>: RolandTR909_bd, LinnDrum_sd, and so on. The
// *part* is a two-or-three letter abbreviation shared across all 71 machines —
// bd, sd, hh… — and that shared vocabulary is what this panel documents: what
// each one is, where it earns its place in a pattern, and a click-to-play
// example on the machine most famous for that sound.
//
// Every example is `.bank(<machine>)` over the bare part name, which is exactly
// how you'd reach these sounds in your own code. Each example machine below is
// confirmed to actually carry that part (e.g. the TR-808 has no ride, so the
// ride example rides a 909 instead).

const SECTIONS = [
  {
    title: 'Kick & backbeat',
    parts: [
      {
        abbr: 'bd',
        name: 'Bass Drum (kick)',
        note: 'The floor everything sits on — downbeats, or four-on-the-floor under house and techno.',
        examples: ['s("bd*4").bank("RolandTR909")'],
      },
      {
        abbr: 'sd',
        name: 'Snare Drum',
        note: 'The backbeat on 2 and 4, answering the kick — the pulse a listener nods along to.',
        examples: ['s("bd ~ sd ~").bank("LinnDrum")'],
      },
      {
        abbr: 'rim',
        name: 'Rimshot / cross-stick',
        note: 'A quieter stand-in for the snare — tight, dry timekeeping for verses and bossa grooves.',
        examples: ['s("bd rim bd rim").bank("LinnDrum")'],
      },
      {
        abbr: 'cp',
        name: 'Hand Clap',
        note: 'Layered over or swapped for the snare on the backbeat — the classic house clap.',
        examples: ['s("~ cp ~ cp").bank("RolandTR909")'],
      },
    ],
  },
  {
    title: 'Hats & cymbals',
    parts: [
      {
        abbr: 'hh',
        name: 'Closed Hi-Hat',
        note: 'Keeps the subdivision ticking — eighths or sixteenths that drive the groove forward.',
        examples: ['s("hh*8").bank("RolandTR808")'],
      },
      {
        abbr: 'oh',
        name: 'Open Hi-Hat',
        note: 'The offbeat "tss" between the kicks — the lift of disco and house.',
        examples: ['s("hh oh hh oh").bank("RolandTR909")'],
      },
      {
        abbr: 'cr',
        name: 'Crash Cymbal',
        note: 'Marks the top of a phrase — an accent on the one, landing out of a fill.',
        examples: ['s("cr ~ ~ ~, bd*4").bank("RolandTR909")'],
      },
      {
        abbr: 'rd',
        name: 'Ride Cymbal',
        note: 'Sustained timekeeping instead of hats — the shimmer under jazz and driving techno.',
        examples: ['s("rd*4").bank("RolandTR909")'],
      },
    ],
  },
  {
    title: 'Toms',
    parts: [
      {
        abbr: 'ht / mt / lt',
        name: 'High / Mid / Low Tom',
        note: 'Pitched drums for fills and descending runs that push into a new section. Each pitch on its own, then the three chained as a fill.',
        examples: [
          's("ht").bank("RolandTR808")',
          's("mt").bank("RolandTR808")',
          's("lt").bank("RolandTR808")',
          's("ht mt lt ~").bank("RolandTR808")',
        ],
      },
    ],
  },
  {
    title: 'Percussion',
    parts: [
      {
        abbr: 'cb',
        name: 'Cowbell',
        note: 'A syncopated offbeat accent that cuts through — Latin, disco, and every "more cowbell" joke.',
        examples: ['s("~ cb ~ cb cb ~ cb ~").bank("RolandTR808")'],
      },
      {
        abbr: 'sh',
        name: 'Shaker',
        note: 'A continuous stream of sixteenths — high-end texture that hands the groove its swing.',
        examples: ['s("sh*16").bank("LinnDrum")'],
      },
      {
        abbr: 'tb',
        name: 'Tambourine',
        note: 'Reinforces the backbeat or rides steady eighths up top — the pop and gospel lift.',
        examples: ['s("tb*8").bank("LinnDrum")'],
      },
    ],
  },
];

// One <button> per example: it's a control (it plays sound on click), so it
// should be Tab-reachable and answer Enter without us re-implementing either —
// the same reasoning as the bank cards in banks.js.
function exampleButton(code, onPlay) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'drumkit-example';
  btn.textContent = code;
  btn.title = 'Click to play';
  btn.addEventListener('click', () => onPlay(code));
  return btn;
}

function partBlock(part, onPlay) {
  const block = document.createElement('div');
  block.className = 'drumkit-part';

  const term = document.createElement('div');
  term.className = 'drumkit-term';

  const abbr = document.createElement('span');
  abbr.className = 'drumkit-abbr';
  abbr.textContent = part.abbr;
  term.appendChild(abbr);

  const name = document.createElement('span');
  name.className = 'drumkit-name';
  name.textContent = part.name;
  term.appendChild(name);

  block.appendChild(term);

  const note = document.createElement('p');
  note.className = 'drumkit-note';
  note.textContent = part.note;
  block.appendChild(note);

  const examples = document.createElement('div');
  examples.className = 'drumkit-examples';
  for (const code of part.examples) examples.appendChild(exampleButton(code, onPlay));
  block.appendChild(examples);

  return block;
}

// Build once, on first show. The panel is static apart from the play handler,
// which is closed over here, so later shows just un-hide the root.
function build(root, onPlay) {
  const header = document.createElement('div');
  header.className = 'drumkit-header';

  const title = document.createElement('span');
  title.textContent = 'Drum kit';
  header.appendChild(title);

  const hint = document.createElement('span');
  hint.className = 'drumkit-hint';
  hint.textContent = 'click an example to hear it · :ndrums to hide';
  header.appendChild(hint);

  root.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'drumkit-grid';

  for (const section of SECTIONS) {
    const card = document.createElement('section');
    card.className = 'drumkit-card';

    const heading = document.createElement('h3');
    heading.textContent = section.title;
    card.appendChild(heading);

    for (const part of section.parts) card.appendChild(partBlock(part, onPlay));
    grid.appendChild(card);
  }

  root.appendChild(grid);
}

export function setupDrumkit(root, { onPlay }) {
  let built = false;
  return {
    show() {
      if (!built) {
        build(root, onPlay);
        built = true;
      }
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}
