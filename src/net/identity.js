// Networked play — local identity and room credentials.
//
// Three small jobs, kept out of session.js so the network layer stays about the
// network:
//
//   1. Who you are in a session: display name + cursor colour, persisted in
//      localStorage the same way the vim setting is (see main.js).
//   2. Room names: memorable word triples (`warm-tidal-fox`). The room name is
//      only a *handle* — Trystero's `password` is what actually gates entry, so
//      a guessable name is fine (and much easier to read out loud).
//   3. Passphrases: random, high-entropy, meant to be copy-pasted rather than
//      typed. The "copy" button in the panel puts `room · passphrase` on the
//      clipboard as one string, and the join form accepts that whole string
//      pasted into either field.

const NAME_KEY = 'oat.peerName';
const COLOR_KEY = 'oat.peerColor';

// Word lists for room names. Deliberately short and pronounceable — this is a
// handle you read out over a call, not a secret.
const ADJECTIVES = [
  'warm', 'cold', 'soft', 'loud', 'slow', 'fast', 'deep', 'high', 'dim', 'bright',
  'wild', 'calm', 'odd', 'even', 'blue', 'green', 'amber', 'violet', 'rusty', 'silver',
  'quiet', 'brisk', 'lazy', 'eager', 'tiny', 'vast', 'lone', 'twin', 'first', 'last',
];

const TEXTURES = [
  'tidal', 'granite', 'velvet', 'copper', 'paper', 'glass', 'linen', 'cedar', 'coral', 'ember',
  'frost', 'gravel', 'honey', 'ivory', 'marble', 'neon', 'ocean', 'plasma', 'quartz', 'resin',
  'sable', 'thunder', 'umber', 'vapor', 'willow', 'zinc', 'basalt', 'cinder', 'drift', 'echo',
];

const ANIMALS = [
  'fox', 'heron', 'otter', 'lynx', 'raven', 'moth', 'shrew', 'ibex', 'crane', 'newt',
  'stoat', 'finch', 'gecko', 'hare', 'kite', 'mole', 'owl', 'pike', 'quail', 'rook',
  'seal', 'tern', 'vole', 'wren', 'yak', 'zebu', 'adder', 'bison', 'civet', 'dhole',
];

// Cursor colours. Picked to be legible on the Tokyo Night editor background and
// distinguishable from each other at caret width.
export const PEER_COLORS = [
  '#7aa2f7', // blue
  '#9ece6a', // green
  '#f7768e', // red
  '#e0af68', // yellow
  '#bb9af7', // purple
  '#7dcfff', // cyan
  '#ff9e64', // orange
  '#73daca', // teal
];

function randomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Rejection-free enough for our purposes: max is always tiny relative to 2^32.
  return buf[0] % max;
}

function pick(list) {
  return list[randomInt(list.length)];
}

export function randomRoomName() {
  return `${pick(ADJECTIVES)}-${pick(TEXTURES)}-${pick(ANIMALS)}`;
}

// A random passphrase, rendered in Crockford-ish base32 (no vowels, no
// look-alike characters) so the rare hand-typed case is survivable. 20 chars ≈
// 100 bits.
const PASS_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export function randomPassphrase(length = 20) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += PASS_ALPHABET[b % PASS_ALPHABET.length];
  return out;
}

// One string to text a collaborator: "warm-tidal-fox · s7fk2m…". The separator
// is a middle dot so it can't be confused with a hyphen inside the room name.
export const CREDENTIAL_SEPARATOR = ' · ';

export function formatCredentials(roomId, passphrase) {
  return `${roomId}${CREDENTIAL_SEPARATOR}${passphrase}`;
}

// Accept the combined string pasted into either join field, as well as the
// plain single value. Returns { roomId, passphrase } with nulls for anything
// the input didn't supply, so the caller can merge it with the other field.
export function parseCredentials(raw) {
  const text = (raw || '').trim();
  if (!text) return { roomId: null, passphrase: null };
  // Split on the middle dot, a bare '/', or run-of-whitespace — whichever the
  // paste survived. A lone token is just a room name (or just a passphrase).
  const parts = text.split(/\s*[·/|]\s*|\s+/).filter(Boolean);
  if (parts.length === 1) return { roomId: parts[0], passphrase: null };
  return { roomId: parts[0], passphrase: parts.slice(1).join('') };
}

// --- persisted local identity ---------------------------------------------

function randomName() {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

export function loadIdentity() {
  let name = localStorage.getItem(NAME_KEY);
  let color = localStorage.getItem(COLOR_KEY);
  if (!name) {
    name = randomName();
    localStorage.setItem(NAME_KEY, name);
  }
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) {
    color = pick(PEER_COLORS);
    localStorage.setItem(COLOR_KEY, color);
  }
  return { name, color };
}

export function saveIdentity({ name, color }) {
  if (name != null) localStorage.setItem(NAME_KEY, name);
  if (color != null) localStorage.setItem(COLOR_KEY, color);
}

// The translucent variant y-codemirror.next uses to tint a remote peer's
// selection range (it defaults to `color + '33'`; we pass it explicitly so the
// value is obvious at the call site).
export function colorLight(color) {
  return color + '33';
}
