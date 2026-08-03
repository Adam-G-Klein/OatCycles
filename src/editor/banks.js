// `:banks` — the sample banks sitting on this machine, in the bottom dock.
//
// `:peruse` can only index the banks a file already names, which leaves a
// folder in ./samples invisible until you remember it's there. This panel
// lists what's on disk (see vite-banks-plugin.js for the scan), and clicking a
// bank hands it to main.js, which opens it in a new file already perusing it.
//
// Shares the dock with the reference keyboard and the mini-notation cheatsheet
// — one at a time, so showing this hides those (see main.js).

const BANKS_API = '/api/banks';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The line the picked bank becomes in the new file. `:peruse` reads this back
// off the buffer and appends its index block underneath, so the samples() call
// has to be the real one the engine loads — not a comment about it.
export function bankSnippet(bank) {
  return (
    `// ${bank.name} — ${plural(bank.sounds, 'sound')}, ${plural(bank.samples, 'sample')}` +
    ` from samples/${bank.name}\n` +
    `samples('${BANKS_API}/${encodeURIComponent(bank.name)}.json')\n`
  );
}

function header() {
  const el = document.createElement('div');
  el.className = 'banks-header';

  const title = document.createElement('span');
  title.textContent = 'Local banks';
  el.appendChild(title);

  const hint = document.createElement('span');
  hint.className = 'banks-hint';
  hint.textContent = 'click a bank to peruse it · :nbanks to hide';
  el.appendChild(hint);

  return el;
}

function note(text) {
  const el = document.createElement('p');
  el.className = 'banks-note';
  el.textContent = text;
  return el;
}

// One card per bank. A <button> rather than a <div>: it's a control, so it
// should be reachable by Tab and answer to Enter without us re-implementing
// either.
function card(bank, onPick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'bank-card';
  el.disabled = bank.sounds === 0;

  const name = document.createElement('span');
  name.className = 'bank-name';
  name.textContent = bank.name;
  el.appendChild(name);

  const counts = document.createElement('span');
  counts.className = 'bank-counts';
  counts.textContent = bank.sounds
    ? `${plural(bank.sounds, 'sound')} · ${plural(bank.samples, 'sample')}`
    : 'no audio found';
  el.appendChild(counts);

  el.title = bank.sounds
    ? `Peruse ${bank.name} in a new file`
    : `samples/${bank.name} holds no audio we read — wav, mp3, ogg, flac, m4a, aif or webm,` +
      ' at most one folder deep';

  el.addEventListener('click', () => onPick(bank));
  return el;
}

export function setupBanks(root, { onPick }) {
  let built = false;
  let body = null;
  // Shows can outrun fetches (:banks, :nbanks, :banks again). Only the newest
  // one is allowed to render, so a slow first response can't overwrite a fast
  // second one with a stale list.
  let token = 0;

  function build() {
    root.appendChild(header());
    body = document.createElement('div');
    body.className = 'banks-body';
    root.appendChild(body);
    built = true;
  }

  function render(children) {
    body.replaceChildren(...children);
  }

  async function load() {
    const mine = ++token;
    render([note('reading samples/…')]);

    let banks;
    try {
      const res = await fetch(BANKS_API, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      banks = await res.json();
    } catch (err) {
      if (mine !== token) return;
      // No dev server (a static build) or the route is down. Either way the
      // honest answer is that we can't see the disk from here.
      console.warn('banks: could not read samples/', err);
      render([note(`could not read samples/ — ${err?.message ?? err}`)]);
      return;
    }
    if (mine !== token) return;

    if (!banks.length) {
      render([
        note(
          'No banks yet. Put a folder of samples in samples/ — one folder per bank,' +
            ' either samples/<bank>/<sound>/01.wav or samples/<bank>/<sound>.wav.',
        ),
      ]);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'banks-grid';
    for (const bank of banks) grid.appendChild(card(bank, onPick));
    render([grid]);
  }

  return {
    show() {
      if (!built) build();
      root.hidden = false;
      // Re-read on every show: a folder dropped in a minute ago should appear
      // without reloading the app.
      load();
    },
    hide() {
      root.hidden = true;
    },
  };
}
