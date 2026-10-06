import { readTags } from './tags.js';
import { ORCHESTRAS, SEPARATE_ENSEMBLES, SINGER_SURNAMES, eraOf } from './data.js';
import { idb } from './store.js';

export const AUDIO_RE = /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav|webm)$/i;

export const norm = s => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[’'`´]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Index of the first whole-word occurrence of any alias in a normalised string, or -1.
function findAlias(hay, aliases) {
  const h = ` ${hay} `;
  let best = -1;
  for (const a of aliases) {
    const i = h.indexOf(` ${a} `);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/* ---------------- Orchestra name matching ---------------- */

// Per orchestra: the normalised full name, "Surname First" / "F Surname" forms, and the compact
// surname used for typo-tolerant matching. Group names (OTV, Francini–Pontier) have no such forms.
const NAMES = ORCHESTRAS.map(o => {
  const full = norm(o.name);
  const [first, ...rest] = full.split(' ');
  const person = !['otv', 'francini'].includes(o.id) && rest.length > 0;
  const surname = rest.join(' ');
  const forms = person ? [full, `${surname} ${first}`, `${first[0]} ${surname}`] : [];
  return {
    id: o.id,
    full,
    // Anywhere in tags and folder names.
    general: [...new Set([...o.aliases, ...forms])],
    // Artist/conductor tags only.
    artist: [...new Set([...o.aliases, ...forms, ...o.artistAliases, ...o.nicknames])],
    tag: [...new Set([...o.aliases, ...forms, ...o.nicknames])],
    fuzzy: person && surname.replace(/ /g, '').length >= 5 ? surname.replace(/ /g, '') : null,
  };
});
const SEPARATE = SEPARATE_ENSEMBLES.map(norm);
const EXCLUDED = { excluded: true };

// The orchestra whose alias appears earliest in the string (so "D'Arienzo (piano Biagi)" → D'Arienzo).
// `ctx` is 'artist' (artist/conductor tags), 'tag' (grouping/album) or 'folder' (directory names).
function matchOrchestra(text, ctx) {
  const n = norm(text);
  if (!n) return null;
  if (findAlias(n, SEPARATE) >= 0) return EXCLUDED;
  let best = null, bestI = Infinity;
  for (const x of NAMES) {
    const i = findAlias(n, ctx === 'artist' ? x.artist : ctx === 'tag' ? x.tag : x.general);
    if (i >= 0 && i < bestI) { best = x.id; bestI = i; }
  }
  return best && { id: best, how: 'exact' };
}

// File names are mostly titles, so only trust a " - " part that is nothing but an orchestra name
// ("Canaro - Poema" yes, "Canaro en París" no), or the leader's full name anywhere.
const ENSEMBLE_WORDS = /^(?:orquesta tipica|orquesta|sexteto|cuarteto|quinteto) | y su (?:orquesta|sexteto|cuarteto|quinteto)(?: tipica)?$/g;
function orchestraPart(part) {
  const n = norm(part.replace(/\s*[([][^)\]]*[)\]]\s*$/, '')).replace(ENSEMBLE_WORDS, '').trim();
  return NAMES.find(x => x.general.includes(n))?.id || null;
}
function matchFileName(fileName) {
  const n = norm(fileName);
  if (findAlias(n, SEPARATE) >= 0) return EXCLUDED;
  for (const part of fileName.split(/\s+[-–]\s+/)) {
    const id = orchestraPart(part);
    if (id) return { id, how: 'exact' };
  }
  const x = NAMES.find(x => findAlias(n, [x.full]) >= 0);
  return x ? { id: x.id, how: 'exact' } : null;
}

// Optimal string alignment distance (Levenshtein + adjacent transpositions), capped for speed.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Last resort for artist tags (or folder names when there are none): a word (or two adjacent words, for "Di Sarly") within 1 edit of a
// leader's surname (2 for surnames of 8+ letters). Only accepted if exactly one orchestra is that close.
function fuzzyOrchestra(text) {
  const words = norm(text).split(' ').filter(Boolean);
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)].filter(w => w.length >= 4);
  const hits = new Set();
  for (const x of NAMES) {
    if (!x.fuzzy) continue;
    const max = x.fuzzy.length >= 8 ? 2 : 1;
    if (candidates.some(w => editDistance(w, x.fuzzy, max) <= max)) hits.add(x.id);
  }
  return hits.size === 1 ? { id: [...hits][0], how: 'fuzzy' } : null;
}

// Singer lookup: full names from the knowledge base, plus distinctive surnames.
const SINGERS = (() => {
  const names = new Set(ORCHESTRAS.flatMap(o => o.singers));
  return [...names].map(name => ({ name, aliases: [norm(name), ...(SINGER_SURNAMES[name] || [])] }));
})();

function findSingers(text) {
  const n = norm(text);
  const found = SINGERS.filter(s => findAlias(n, s.aliases) >= 0).map(s => s.name);
  return [...new Set(found)].sort();
}

function findYear(...texts) {
  for (const t of texts) {
    const m = (t || '').match(/\b(19[0-8]\d)\b/);
    if (m) return +m[1];
  }
  return null;
}

const stripExt = s => s.replace(/\.[^.]+$/, '');

// "03 - Carlos Di Sarli - 1941 - Corazón (Roberto Rufino)" → "Corazón"
function titleFromFileName(name) {
  const stripCredit = s => s.replace(/\s*[([][^)\]]*[)\]]\s*$/, m => (findSingers(m).length || /\d{4}/.test(m) ? '' : m)).trim();
  const isSinger = p => SINGERS.some(s => s.aliases.includes(norm(p)));
  const parts = name.split(/\s+[-–]\s+/).map(stripCredit).filter(p => p && !/^\d{1,4}$/.test(p) && !isSinger(p));
  // Drop parts naming an orchestra, unless that leaves nothing (e.g. the tango "Canaro en París").
  const titles = parts.filter(p => !orchestraPart(p));
  return ((titles.length ? titles : parts).pop() || name).replace(/^\s*\d{1,3}[\s.\-_]+/, '');
}

// Turn raw tags + path into what the quiz needs. `mappings` maps a normalised artist string
// to an orchestra id (or 'ignore') as set manually in the Library view.
export function describe(entry, mappings) {
  const t = entry.tags || {};
  const path = entry.path;
  const fileName = stripExt(path.split('/').pop());
  const artistKey = norm(t.artist || t.albumartist || '') || `(no artist) ${norm(path.split('/').slice(-2, -1)[0] || '')}`;

  const mapped = mappings[artistKey] || null;
  if (mapped === 'ignore') return { ...entry, artistKey, orchestra: null, ignored: true };

  let match = mapped ? { id: mapped, how: 'manual' } : null;
  if (!match) {
    const folders = path.split('/').slice(0, -1).join(' | ');
    const tries = [
      () => matchOrchestra(t.conductor, 'artist'),
      () => matchOrchestra(t.artist, 'artist'),
      () => matchOrchestra(t.albumartist, 'artist'),
      () => matchOrchestra(t.grouping, 'tag'),
      () => matchOrchestra(t.album, 'tag'),
      () => matchOrchestra(folders, 'folder'),
      () => matchFileName(fileName),
      () => fuzzyOrchestra([t.conductor, t.artist, t.albumartist].filter(Boolean).join(' | ')),
      () => (t.artist || t.albumartist ? null : fuzzyOrchestra(folders)),
    ];
    for (const attempt of tries) if ((match = attempt())) break;
  }
  const separate = match === EXCLUDED;
  const orchestra = separate ? null : match?.id || null;

  const title = (t.title || titleFromFileName(fileName)).trim();
  const singerText = [t.artist, t.albumartist, t.title, t.comment, t.grouping, t.extra, fileName].join(' | ');
  const singers = findSingers(singerText);
  const instrumental = /\binstrumental\b/i.test(singerText);

  // Tag dates are often the CD release year; only trust plausible recording years.
  const year = findYear(t.date, t.extra, t.comment, t.title, t.grouping, t.album, fileName);

  return {
    ...entry,
    artistKey,
    artistLabel: t.artist || t.albumartist || `Folder “${path.split('/').slice(-2, -1)[0] || '?'}” (no artist tag)`,
    orchestra,
    matchedBy: orchestra ? match.how : null,
    separate,
    title,
    singers,
    singer: singers.length ? singers.join(' & ') : instrumental ? 'Instrumental' : null,
    year,
    era: eraOf(year)?.id || null,
  };
}

/* ---------------- Collecting files ---------------- */

export async function filesFromHandle(dirHandle, onProgress) {
  const out = [];
  async function walk(handle, prefix) {
    for await (const entry of handle.values()) {
      if (entry.kind === 'directory') await walk(entry, `${prefix}${entry.name}/`);
      else if (AUDIO_RE.test(entry.name)) {
        out.push({ handle: entry, path: prefix + entry.name });
        if (out.length % 100 === 0) onProgress?.(`Found ${out.length} audio files…`);
      }
    }
  }
  await walk(dirHandle, `${dirHandle.name}/`);
  return out;
}

// Look a file up again from a path produced by filesFromHandle ("Root/sub/name.mp3").
export async function fileFromPath(dirHandle, path) {
  const parts = path.split('/').slice(1);
  const name = parts.pop();
  let dir = dirHandle;
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(name)).getFile();
}

export function filesFromInput(fileList) {
  return [...fileList]
    .filter(f => AUDIO_RE.test(f.name))
    .map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
}

// Read tags for all items (with an IndexedDB cache keyed by path+size+mtime).
export async function scan(items, onProgress) {
  let done = 0;
  const withFiles = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < items.length) {
      const i = next++, it = items[i];
      const file = it.file || await it.handle.getFile();
      withFiles[i] = { ...it, file, key: `${it.path}|${file.size}|${file.lastModified}` };
    }
  }));
  const cached = await idb.getMany('tags', withFiles.map(i => i.key));
  const fresh = [];
  const queue = withFiles.slice();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      if (!cached.has(it.key)) {
        const tags = await readTags(it.file);
        cached.set(it.key, tags);
        fresh.push([it.key, tags]);
      }
      if (++done % 25 === 0) onProgress?.(`Reading tags ${done} / ${withFiles.length}…`);
    }
  });
  await Promise.all(workers);
  if (fresh.length) await idb.setMany('tags', fresh);
  return withFiles.map((it, i) => ({ id: i, path: it.path, file: it.file, tags: cached.get(it.key) || {} }));
}
