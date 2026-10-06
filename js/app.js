import { ORCHESTRAS, ERAS, orchById } from './data.js';
import { describe, fileFromPath, filesFromHandle, filesFromInput, scan, norm } from './library.js';
import { idb, load, save } from './store.js';

/* ================= State ================= */

const settings = load('settings', {
  quizType: 'orchestra',   // 'orchestra' | 'full'
  difficulty: 'similar',   // 'similar' | 'random'
  clipLen: 30,
  choices: 4,
  focusWeak: true,
  excluded: [],
  noSingerInstrumental: false,
});
const stats = load('stats', { orch: {}, conf: {}, era: { n: 0, ok: 0 }, singer: { n: 0, ok: 0 }, best: 0 });
const mappings = load('mappings', {});

const state = {
  tab: 'quiz',
  raw: [],          // scanned entries {id, path, file, tags}
  tracks: [],       // described entries
  byOrch: new Map(),
  libraryName: '',
  savedHandle: null,
  busy: '',
  round: null,
  session: { n: 0, ok: 0, streak: 0 },
  recent: [],
  compare: { a: null, b: null, same: true, cur: { a: null, b: null }, blind: null, blindScore: { n: 0, ok: 0 } },
  refOpen: null,
  refQuery: '',
};

const $ = sel => document.querySelector(sel);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pct = (ok, n) => (n ? Math.round((100 * ok) / n) : 0);
const saveAll = () => { save('settings', settings); save('stats', stats); save('mappings', mappings); };

/* ================= Audio player ================= */

const audio = new Audio();
audio.preload = 'auto';
let clip = null;       // { track, start, end, onEnd }
let audioUrl = null;
let loadedTrack = null;

async function loadTrack(track) {
  if (loadedTrack === track && audio.readyState >= 1) return;
  // A library restored from the saved index has no File objects yet: fetch each on first play.
  if (!track.file) {
    try {
      track.file = state.raw[track.id].file = await fileFromPath(state.savedHandle, track.path);
    } catch {
      throw new Error(`Can't find “${track.path}”. Use Rescan in the Library tab if files have moved.`);
    }
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(track.file);
  loadedTrack = track;
  return new Promise((resolve, reject) => {
    audio.onloadedmetadata = () => resolve();
    audio.onerror = () => reject(new Error(`Can't play "${track.path}" in this browser.`));
    audio.src = audioUrl;
  });
}

async function playClip(track, { owner = 'any', frac = null, len = settings.clipLen, label = 'Mystery track', onEnd } = {}) {
  await loadTrack(track);
  const d = Number.isFinite(audio.duration) ? audio.duration : 180;
  const maxStart = Math.max(0, d - len - 4);
  const minStart = Math.min(maxStart, d * 0.06);
  const start = frac != null ? Math.min(maxStart, d * frac) : minStart + Math.random() * (maxStart - minStart);
  clip = { track, start, end: start + len, onEnd, owner };
  audio.currentTime = start;
  audio.volume = 1;
  setMediaSession(label);
  await audio.play();
  updatePlayUI();
}

function replay() {
  if (!clip) return;
  audio.currentTime = clip.start;
  audio.volume = 1;
  audio.play();
}

function stopAudio() { audio.pause(); }

function playFull() {
  if (!clip) return;
  clip.end = Infinity;
  audio.volume = 1;
  audio.play();
}

audio.addEventListener('timeupdate', () => {
  if (!clip) return;
  const t = audio.currentTime;
  if (clip.end !== Infinity) {
    const left = clip.end - t;
    if (left < 1.5) audio.volume = Math.max(0, Math.min(1, left / 1.5));
    if (t >= clip.end) { audio.pause(); clip.onEnd?.(); }
  }
  updatePlayUI();
});
audio.addEventListener('play', updatePlayUI);
audio.addEventListener('pause', updatePlayUI);

function updatePlayUI() {
  document.querySelectorAll('[data-clipbar]').forEach(el => {
    const owner = el.dataset.clipbar;
    const mine = clip && (owner === 'any' || owner === clip.owner);
    let f = 0;
    if (mine) f = clip.end === Infinity
      ? audio.currentTime / (audio.duration || 1)
      : (audio.currentTime - clip.start) / (clip.end - clip.start);
    el.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
  });
  document.querySelectorAll('[data-playing]').forEach(el => {
    el.classList.toggle('is-playing', !audio.paused && clip && (el.dataset.playing === 'any' || el.dataset.playing === clip.owner));
  });
}

function setMediaSession(title) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Tango Ear', artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }] });
  } catch {}
}

// Headphone / lock-screen buttons. Previous replays the clip; next moves on: the next round once
// this one is answered, the other side in Compare, otherwise another part of the same track.
function initMediaControls() {
  if (!('mediaSession' in navigator)) return;
  const on = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch {} };
  on('play', () => {
    if (!clip) return;
    if (audio.currentTime >= clip.end - 0.2) replay();
    else { audio.volume = 1; audio.play(); }
  });
  on('pause', stopAudio);
  on('previoustrack', replay);
  on('nexttrack', () => {
    if (!clip) return;
    if (clip.owner === 'quiz' && state.round?.done) newRound();
    else if (clip.owner === 'cmp-a' || clip.owner === 'cmp-b') comparePlay(clip.owner === 'cmp-a' ? 'b' : 'a');
    else actions['other-part']();
  });
}

/* ================= Library loading ================= */

function rebuild() {
  state.tracks = state.raw.map(e => {
    const t = describe(e, mappings);
    if (settings.noSingerInstrumental && t.orchestra && !t.singer) t.singer = 'Instrumental';
    return t;
  });
  state.byOrch = new Map();
  for (const t of state.tracks) {
    if (!t.orchestra) continue;
    if (!state.byOrch.has(t.orchestra)) state.byOrch.set(t.orchestra, []);
    state.byOrch.get(t.orchestra).push(t);
  }
}

async function loadItems(items, name, remember = false) {
  if (!items.length) {
    state.busy = '';
    render();
    toast(name ? `No audio files found in “${name}”.` : 'No audio files found in what you selected.');
    return;
  }
  state.busy = `Reading ${items.length} files…`;
  render();
  try {
    state.raw = await scan(items, msg => { state.busy = msg; renderBusy(); });
    state.libraryName = name;
    rebuild();
    state.round = null;
    if (remember) await idb.set('kv', 'index', { name, entries: state.raw.map(e => ({ path: e.path, tags: e.tags })) });
    const recognised = state.byOrch.size;
    state.tab = recognised >= 2 ? 'quiz' : 'library';
    toast(`Loaded ${state.tracks.length} tracks · ${recognised} orchestras recognised`);
  } catch (e) {
    console.error(e);
    toast('Something went wrong reading the files: ' + e.message);
  } finally {
    state.busy = '';
    render();
  }
}

async function openFolderPicker() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'tango-music', mode: 'read' });
    await idb.del('kv', 'index');
    await idb.set('kv', 'dir', handle);
    state.savedHandle = handle;
    await scanSaved();
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message);
    state.busy = ''; render();
  }
}

async function scanSaved() {
  const h = state.savedHandle;
  state.busy = 'Scanning folder…'; render();
  const items = await filesFromHandle(h, msg => { state.busy = msg; renderBusy(); });
  await loadItems(items, h.name, true);
}

// Bring back the library remembered from the last scan without touching the files.
async function restoreIndex() {
  const saved = await idb.get('kv', 'index');
  if (!saved?.entries?.length) return false;
  state.raw = saved.entries.map((e, i) => ({ id: i, path: e.path, tags: e.tags }));
  state.libraryName = saved.name;
  rebuild();
  state.round = null;
  return true;
}

// `rescan` walks the folder again (picking up added or moved files) instead of using the saved index.
async function reopenSaved(rescan = false) {
  const h = state.savedHandle;
  if (!h) return;
  try {
    if ((await h.queryPermission({ mode: 'read' })) !== 'granted' && (await h.requestPermission({ mode: 'read' })) !== 'granted') {
      toast('Permission was not granted.');
      return;
    }
    if (!rescan && await restoreIndex()) {
      state.tab = state.byOrch.size >= 2 ? 'quiz' : 'library';
      render();
      return;
    }
    await scanSaved();
  } catch (e) {
    toast(e.message); state.busy = ''; render();
  }
}

function pickFiles(folder) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (folder) input.webkitdirectory = true;
  else input.accept = 'audio/*,.flac,.m4a,.opus,.ogg';
  input.onchange = () => {
    const items = filesFromInput(input.files);
    const name = !items.length ? null : folder ? items[0].path.split('/')[0] : `${items.length} selected files`;
    loadItems(items, name);
  };
  input.click();
}

/* ================= Quiz ================= */

const eligibleOrchs = () => [...state.byOrch.keys()].filter(id => !settings.excluded.includes(id));

function orchWeight(id) {
  if (!settings.focusWeak) return 1;
  const s = stats.orch[id] || { n: 0, ok: 0 };
  return 0.25 + (s.n - s.ok + 1) / (s.n + 2);
}

function pickTrack(pool) {
  const ids = pool || eligibleOrchs();
  const weights = ids.map(orchWeight);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let id = ids[ids.length - 1];
  for (let i = 0; i < ids.length; i++) { r -= weights[i]; if (r <= 0) { id = ids[i]; break; } }
  const tracks = state.byOrch.get(id);
  const fresh = tracks.filter(t => !state.recent.includes(t.id));
  const track = pick(fresh.length ? fresh : tracks);
  state.recent = [track.id, ...state.recent].slice(0, Math.min(40, Math.floor(state.tracks.length / 2)));
  return track;
}

function confusionScore(a, b) {
  return (stats.conf[a]?.[b] || 0) + (stats.conf[b]?.[a] || 0);
}

function orchestraChoices(correct) {
  const o = orchById[correct];
  const pool = eligibleOrchs().filter(id => id !== correct);
  const scored = pool.map(id => {
    let s = Math.random();
    if (settings.difficulty === 'similar') {
      if (o.confusable.includes(id) || orchById[id].confusable.includes(correct)) s += 1.5;
      s += Math.min(2, confusionScore(correct, id) * 0.5);
    }
    return [id, s];
  }).sort((x, y) => y[1] - x[1]);
  const n = settings.choices === 0 ? pool.length : settings.choices - 1;
  return shuffle([correct, ...scored.slice(0, n).map(x => x[0])]);
}

function eraChoices(track) {
  const [from, to] = orchById[track.orchestra].active;
  let eras = ERAS.filter(e => e.to >= from && e.from <= to);
  if (!eras.some(e => e.id === track.era)) eras.push(ERAS.find(e => e.id === track.era));
  if (eras.length < 3) eras = ERAS;
  return ERAS.filter(e => eras.includes(e)).map(e => e.id);
}

function singerChoices(track) {
  const o = orchById[track.orchestra];
  const seen = new Set((state.byOrch.get(track.orchestra) || []).map(t => t.singer).filter(Boolean));
  o.singers.forEach(s => seen.add(s));
  seen.delete(track.singer);
  const others = shuffle([...seen]).slice(0, Math.max(1, (settings.choices || 4) - 1));
  return shuffle([track.singer, ...others]);
}

async function newRound(attempt = 0) {
  if (eligibleOrchs().length < 2) { toast('You need at least two orchestras in the quiz pool.'); return; }
  const track = pickTrack();
  const steps = [{ type: 'orchestra', q: 'Which orchestra?', choices: orchestraChoices(track.orchestra), answer: track.orchestra }];
  if (settings.quizType === 'full') {
    if (track.era) steps.push({ type: 'era', q: 'When was it recorded?', choices: eraChoices(track), answer: track.era });
    if (track.singer) {
      const choices = singerChoices(track);
      if (choices.length > 1) steps.push({ type: 'singer', q: 'Who is singing?', choices, answer: track.singer });
    }
  }
  state.round = { track, steps, step: 0, done: false };
  render();
  try {
    await playClip(track, { owner: 'quiz' });
  } catch (e) {
    console.warn(e);
    if (attempt < 3) return newRound(attempt + 1);
    toast(e.message);
  }
}

function answer(choice) {
  const r = state.round;
  if (!r || r.done) return;
  const s = r.steps[r.step];
  if (s.picked != null) return;
  s.picked = choice;
  const ok = choice === s.answer;
  if (s.type === 'orchestra') {
    const o = (stats.orch[s.answer] ||= { n: 0, ok: 0 });
    o.n++; if (ok) o.ok++;
    if (!ok) { stats.conf[s.answer] ||= {}; stats.conf[s.answer][choice] = (stats.conf[s.answer][choice] || 0) + 1; }
    state.session.n++;
    if (ok) { state.session.ok++; state.session.streak++; stats.best = Math.max(stats.best, state.session.streak); }
    else state.session.streak = 0;
  } else {
    const bucket = stats[s.type];
    bucket.n++; if (ok) bucket.ok++;
  }
  saveAll();
  if (r.step < r.steps.length - 1) r.step++;
  else r.done = true;
  render();
}

const choiceLabel = (type, id) =>
  type === 'orchestra' ? orchById[id].name : type === 'era' ? ERAS.find(e => e.id === id).label : id;

function renderQuiz() {
  if (!state.tracks.length) return renderNoLibrary('quiz');
  const r = state.round;
  if (!r) return renderQuizSetup();
  const t = r.track, o = orchById[t.orchestra];
  const s = state.session;
  let html = `
    <div class="scorebar">
      <span><b>${s.ok}</b>/${s.n} correct</span>
      <span>Streak <b>${s.streak}</b> · best ${stats.best}</span>
      <button class="link" data-act="quit">Settings</button>
    </div>
    ${playerCard('quiz', r.done ? `${esc(t.title)}` : 'Mystery track', r.done)}`;

  r.steps.forEach((step, i) => {
    if (i > r.step) return;
    html += `<section class="card step"><h3>${step.q}</h3><div class="choices">` +
      step.choices.map((c, k) => {
        let cls = '';
        if (step.picked != null) {
          if (c === step.answer) cls = 'correct';
          else if (c === step.picked) cls = 'wrong';
          else cls = 'dim';
        }
        const sw = step.type === 'orchestra' ? `<i class="sw" style="background:${orchById[c].color}"></i>` : '';
        return `<button class="choice ${cls}" data-act="answer" data-v="${esc(c)}" ${step.picked != null ? 'disabled' : ''}>
          <kbd>${k + 1}</kbd>${sw}<span>${esc(choiceLabel(step.type, c))}</span></button>`;
      }).join('') + `</div></section>`;
  });

  if (r.done) {
    const first = r.steps[0];
    const wrongId = first.picked !== first.answer ? first.picked : null;
    const tip = wrongId && (o.vs[wrongId] || orchById[wrongId].vs[o.id]);
    html += `
      <section class="card reveal" style="--accent:${o.color}">
        <div class="reveal-head">
          <div>
            <div class="eyebrow">${first.picked === first.answer ? 'Correct ✓' : 'It was…'}</div>
            <h2>${esc(o.name)}</h2>
            <div class="meta">${esc(t.title)}${t.singer ? ` · ${esc(t.singer)}` : ''}${t.year ? ` · ${t.year}` : ''}</div>
          </div>
        </div>
        ${tip ? `<p class="tip"><b>${esc(o.name)} vs ${esc(orchById[wrongId].name)}:</b> ${esc(tip)}</p>` : ''}
        <ul class="listen">${o.listenFor.slice(0, 3).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
        <div class="row">
          <button class="btn ghost" data-act="full">Play full track</button>
          ${wrongId ? `<button class="btn ghost" data-act="compare-pair" data-a="${o.id}" data-b="${wrongId}">Compare these two</button>` : ''}
          <button class="btn primary" data-act="next">Next ▶</button>
        </div>
        <div class="path">${esc(t.path)}</div>
      </section>`;
  }
  view.innerHTML = html;
}

function playerCard(owner, label, revealed) {
  return `
    <section class="card player">
      <button class="play-big" data-act="replay" data-playing="${owner}" aria-label="Replay clip">
        <svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg class="i-wave" viewBox="0 0 24 24"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>
      </button>
      <div class="player-body">
        <div class="player-label">${revealed ? '' : '<span class="pulse"></span>'}${label}</div>
        <div class="bar"><div class="bar-fill" data-clipbar="${owner}"></div></div>
        <div class="row small">
          <button class="btn ghost sm" data-act="replay">↺ Replay</button>
          <button class="btn ghost sm" data-act="other-part">⇄ Other part</button>
          <button class="btn ghost sm" data-act="stop">■ Stop</button>
        </div>
      </div>
    </section>`;
}

function renderQuizSetup() {
  const orchs = [...state.byOrch.keys()].sort((a, b) => orchById[a].name.localeCompare(orchById[b].name));
  const pool = eligibleOrchs();
  const opt = (key, val, label) => `<button class="seg ${settings[key] === val ? 'on' : ''}" data-act="set" data-k="${key}" data-v="${val}">${label}</button>`;
  view.innerHTML = `
    <section class="card hero">
      <h2>Blind listening quiz</h2>
      <p class="muted">A random clip from your library plays and you name the orchestra. In <b>Full</b> mode you also guess the era and the singer.</p>
      <button class="btn primary big" data-act="start" ${pool.length < 2 ? 'disabled' : ''}>Start ▶</button>
      ${pool.length < 2 ? '<p class="warn">Need at least two orchestras in the pool.</p>' : ''}
    </section>
    <section class="card settings">
      <div class="field"><label>Mode</label><div class="segs">${opt('quizType', 'orchestra', 'Orchestra')}${opt('quizType', 'full', 'Full: + era + singer')}</div></div>
      <div class="field"><label>Wrong answers</label><div class="segs">${opt('difficulty', 'similar', 'Similar orchestras')}${opt('difficulty', 'random', 'Random')}</div></div>
      <div class="field"><label>Clip length</label><div class="segs">${[15, 30, 45, 60].map(v => opt('clipLen', v, v + 's')).join('')}</div></div>
      <div class="field"><label>Choices</label><div class="segs">${[3, 4, 6].map(v => opt('choices', v, v)).join('')}${opt('choices', 0, 'All')}</div></div>
      <label class="check"><input type="checkbox" data-set="focusWeak" ${settings.focusWeak ? 'checked' : ''}> Play more of the orchestras I get wrong</label>
      <details>
        <summary>Orchestras in the pool (${pool.length}/${orchs.length})</summary>
        <div class="pool">${orchs.map(id => `
          <label class="check"><input type="checkbox" data-pool="${id}" ${settings.excluded.includes(id) ? '' : 'checked'}>
          <i class="sw" style="background:${orchById[id].color}"></i>${esc(orchById[id].name)} <span class="muted">${state.byOrch.get(id).length}</span></label>`).join('')}
        </div>
        <div class="row small"><button class="btn ghost sm" data-act="pool-all">All</button><button class="btn ghost sm" data-act="pool-none">None</button></div>
      </details>
    </section>`;
}

/* ================= Compare ================= */

function compareDefaults() {
  const c = state.compare;
  const ids = [...state.byOrch.keys()];
  if (!c.a || !state.byOrch.has(c.a)) {
    // Default to the pair you confuse most, else the first two similar orchestras available.
    let best = null, bestN = 0;
    for (const a of ids) for (const b of ids) if (a < b) { const n = confusionScore(a, b); if (n > bestN) { best = [a, b]; bestN = n; } }
    if (!best) for (const a of ids) { const b = orchById[a].confusable.find(x => state.byOrch.has(x)); if (b) { best = [a, b]; break; } }
    best ||= ids.slice(0, 2);
    [c.a, c.b] = best;
  }
  if (!c.b || !state.byOrch.has(c.b) || c.b === c.a) c.b = ids.find(x => x !== c.a);
}

function comparePair() {
  const c = state.compare;
  const A = state.byOrch.get(c.a), B = state.byOrch.get(c.b);
  if (c.same) {
    const titlesB = new Map(B.map(t => [norm(t.title), t]));
    const common = A.filter(t => titlesB.has(norm(t.title)));
    if (common.length) { const ta = pick(common); return { a: ta, b: titlesB.get(norm(ta.title)), same: true }; }
  }
  return { a: pick(A), b: pick(B), same: false };
}

function renderCompare() {
  if (!state.tracks.length) return renderNoLibrary('compare');
  if (state.byOrch.size < 2) { view.innerHTML = `<section class="card"><p>Need at least two recognised orchestras. Check the Library tab.</p></section>`; return; }
  compareDefaults();
  const c = state.compare;
  const ids = [...state.byOrch.keys()].sort((a, b) => orchById[a].name.localeCompare(orchById[b].name));
  const sel = (key) => `<select data-cmp="${key}">${ids.map(id => `<option value="${id}" ${c[key] === id ? 'selected' : ''}>${esc(orchById[id].name)} (${state.byOrch.get(id).length})</option>`).join('')}</select>`;
  const side = (key) => {
    const o = orchById[c[key]], t = c.cur[key];
    return `
      <div class="side" style="--accent:${o.color}">
        <button class="play-big sm" data-act="cmp-play" data-k="${key}" data-playing="cmp-${key}" aria-label="Play ${esc(o.name)}">
          <svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg class="i-wave" viewBox="0 0 24 24"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>
        </button>
        <div class="side-body">
          <div class="side-name">${key.toUpperCase()} · ${esc(o.name)}</div>
          <div class="meta">${t ? `${esc(t.title)}${t.singer ? ' · ' + esc(t.singer) : ''}${t.year ? ' · ' + t.year : ''}` : '—'}</div>
          <div class="bar"><div class="bar-fill" data-clipbar="cmp-${key}"></div></div>
        </div>
      </div>`;
  };
  const oa = orchById[c.a], ob = orchById[c.b];
  const tip = oa.vs[c.b] || ob.vs[c.a];
  const bs = c.blindScore;
  view.innerHTML = `
    <section class="card">
      <h2>Side-by-side</h2>
      <div class="pair-pick">${sel('a')}<span class="vs">vs</span>${sel('b')}</div>
      <label class="check"><input type="checkbox" data-cmpsame ${c.same ? 'checked' : ''}> Same piece when both orchestras recorded it</label>
      ${c.cur.a && c.cur.sameNote ? `<p class="muted small">${esc(c.cur.sameNote)}</p>` : ''}
      ${side('a')}${side('b')}
      <div class="row">
        <button class="btn ghost" data-act="cmp-new">New pair of tracks</button>
        <button class="btn ghost" data-act="stop">■ Stop</button>
      </div>
      ${tip ? `<p class="tip">${esc(tip)}</p>` : ''}
    </section>
    <section class="card">
      <h3>Blind A/B</h3>
      <p class="muted small">A clip from one of the two orchestras plays. Which is it?</p>
      <div class="row">
        <button class="btn primary" data-act="blind-play" data-playing="blind">${c.blind ? '↺ Replay' : '▶ Play mystery clip'}</button>
        <span class="muted">${bs.ok}/${bs.n}</span>
      </div>
      <div class="bar"><div class="bar-fill" data-clipbar="blind"></div></div>
      <div class="choices two">
        <button class="choice ${c.blind?.picked ? (c.blind.answer === 'a' ? 'correct' : c.blind.picked === 'a' ? 'wrong' : 'dim') : ''}" data-act="blind-answer" data-v="a" ${!c.blind || c.blind.picked ? 'disabled' : ''}><kbd>1</kbd><i class="sw" style="background:${oa.color}"></i>${esc(oa.name)}</button>
        <button class="choice ${c.blind?.picked ? (c.blind.answer === 'b' ? 'correct' : c.blind.picked === 'b' ? 'wrong' : 'dim') : ''}" data-act="blind-answer" data-v="b" ${!c.blind || c.blind.picked ? 'disabled' : ''}><kbd>2</kbd><i class="sw" style="background:${ob.color}"></i>${esc(ob.name)}</button>
      </div>
      ${c.blind?.picked ? `<p class="meta">${esc(c.blind.track.title)}${c.blind.track.singer ? ' · ' + esc(c.blind.track.singer) : ''}${c.blind.track.year ? ' · ' + c.blind.track.year : ''} <button class="link" data-act="blind-next">Next ▶</button></p>` : ''}
    </section>`;
}

function newComparePair() {
  const c = state.compare;
  const p = comparePair();
  c.cur = { a: p.a, b: p.b, frac: 0.15 + Math.random() * 0.45, sameNote: p.same ? `Same piece: “${p.a.title}”` : (c.same ? 'No piece in common found, so playing random tracks.' : '') };
}

async function comparePlay(key) {
  const c = state.compare;
  if (!c.cur.a) newComparePair();
  try {
    await playClip(c.cur[key], { owner: `cmp-${key}`, frac: c.cur.frac, label: `${key.toUpperCase()}: ${orchById[c[key]].name}` });
  } catch (e) { toast(e.message); }
}

async function blindPlay() {
  const c = state.compare;
  if (!c.blind) {
    const key = Math.random() < 0.5 ? 'a' : 'b';
    c.blind = { answer: key, track: pick(state.byOrch.get(c[key])) };
    render();
  }
  try {
    if (clip?.owner === 'blind' && loadedTrack === c.blind.track) replay();
    else await playClip(c.blind.track, { owner: 'blind', label: 'Mystery: A or B?' });
  } catch (e) { toast(e.message); c.blind = null; }
}

/* ================= Reference ================= */

function renderReference() {
  const q = norm(state.refQuery);
  const list = ORCHESTRAS.filter(o => !q || norm(`${o.name} ${o.nickname} ${o.singers.join(' ')}`).includes(q));
  view.innerHTML = `
    <div class="search"><input type="search" placeholder="Search orchestras or singers…" value="${esc(state.refQuery)}" data-refq></div>
    ${list.map(o => {
      const open = state.refOpen === o.id;
      const n = state.byOrch.get(o.id)?.length || 0;
      return `
      <section class="card ref ${open ? 'open' : ''}" style="--accent:${o.color}">
        <button class="ref-head" data-act="ref-toggle" data-id="${o.id}">
          <i class="sw lg" style="background:${o.color}"></i>
          <div><div class="ref-name">${esc(o.name)}</div>
          <div class="muted small">${o.nickname ? esc(o.nickname) + ' · ' : ''}${o.active[0]}–${o.active[1]}${n ? ` · <b>${n}</b> in your library` : ''}</div></div>
          <span class="chev">${open ? '−' : '+'}</span>
        </button>
        ${open ? `
          <div class="ref-body">
            <p>${esc(o.summary)}</p>
            <h4>Listen for</h4><ul class="listen">${o.listenFor.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
            <h4>Eras</h4><dl class="eras">${o.eras.map(e => `<dt>${esc(e.years)}</dt><dd>${esc(e.note)}</dd>`).join('')}</dl>
            ${o.singers.length ? `<h4>Singers</h4><p class="chips">${o.singers.map(s => `<span class="chip">${esc(s)}</span>`).join('')}</p>` : ''}
            ${o.confusable.length ? `<h4>Often confused with</h4>${o.confusable.map(id => {
              const other = orchById[id]; const tip = o.vs[id] || other.vs[o.id];
              return `<div class="vsrow"><button class="link" data-act="ref-open" data-id="${id}"><i class="sw" style="background:${other.color}"></i>${esc(other.name)}</button>${tip ? `<span>${esc(tip)}</span>` : ''}
                ${n && state.byOrch.has(id) ? `<button class="btn ghost sm" data-act="compare-pair" data-a="${o.id}" data-b="${id}">Compare</button>` : ''}</div>`;
            }).join('')}` : ''}
            ${o.tracks.length ? `<h4>Good tracks to start with</h4><p class="chips">${o.tracks.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</p>` : ''}
            ${n ? `<div class="row"><button class="btn primary" data-act="ref-sample" data-id="${o.id}" data-playing="ref-${o.id}">▶ Play a sample from your library</button></div>
                   <div class="bar"><div class="bar-fill" data-clipbar="ref-${o.id}"></div></div>
                   <div class="meta" id="ref-now"></div>` : ''}
          </div>` : ''}
      </section>`;
    }).join('')}`;
}

/* ================= Stats ================= */

function renderStats() {
  const rows = Object.entries(stats.orch).filter(([id]) => orchById[id]).sort((a, b) => pct(a[1].ok, a[1].n) - pct(b[1].ok, b[1].n));
  const total = rows.reduce((acc, [, s]) => ({ n: acc.n + s.n, ok: acc.ok + s.ok }), { n: 0, ok: 0 });
  const confs = [];
  for (const [a, m] of Object.entries(stats.conf)) for (const [b, n] of Object.entries(m)) if (orchById[a] && orchById[b]) confs.push([a, b, n]);
  confs.sort((x, y) => y[2] - x[2]);
  view.innerHTML = `
    <section class="card">
      <h2>Your progress</h2>
      <div class="tiles">
        <div class="tile"><div class="tile-v">${pct(total.ok, total.n)}%</div><div class="tile-l">orchestra accuracy<br>${total.ok}/${total.n}</div></div>
        <div class="tile"><div class="tile-v">${pct(stats.era.ok, stats.era.n)}%</div><div class="tile-l">era accuracy<br>${stats.era.ok}/${stats.era.n}</div></div>
        <div class="tile"><div class="tile-v">${pct(stats.singer.ok, stats.singer.n)}%</div><div class="tile-l">singer accuracy<br>${stats.singer.ok}/${stats.singer.n}</div></div>
        <div class="tile"><div class="tile-v">${stats.best}</div><div class="tile-l">best streak</div></div>
      </div>
    </section>
    <section class="card">
      <h3>By orchestra <span class="muted small">(weakest first)</span></h3>
      ${rows.length ? rows.map(([id, s]) => `
        <div class="statrow">
          <span class="statname"><i class="sw" style="background:${orchById[id].color}"></i>${esc(orchById[id].name)}</span>
          <span class="statbar"><span style="width:${pct(s.ok, s.n)}%;background:${orchById[id].color}"></span></span>
          <span class="statnum">${pct(s.ok, s.n)}% <span class="muted">(${s.ok}/${s.n})</span></span>
        </div>`).join('') : '<p class="muted">Play a few quiz rounds to see stats here.</p>'}
    </section>
    <section class="card">
      <h3>What you mix up</h3>
      ${confs.length ? confs.slice(0, 10).map(([a, b, n]) => `
        <div class="confrow">
          <span><b>${esc(orchById[a].name)}</b> heard as <b>${esc(orchById[b].name)}</b> <span class="muted">×${n}</span></span>
          ${state.byOrch.has(a) && state.byOrch.has(b) ? `<button class="btn ghost sm" data-act="compare-pair" data-a="${a}" data-b="${b}">Compare</button>` : ''}
        </div>`).join('') : '<p class="muted">No confusions yet.</p>'}
    </section>
    <div class="row center"><button class="btn ghost sm danger" data-act="reset-stats">Reset statistics</button></div>`;
}

/* ================= Library ================= */

function renderNoLibrary(where) {
  const fsa = 'showDirectoryPicker' in window;
  view.innerHTML = `
    <section class="card hero">
      <h2>Load your tango music</h2>
      <p class="muted">Tango Ear plays clips from music files you already have. Nothing is uploaded: files are read directly in your browser.</p>
      <div class="stack">
        ${state.savedHandle ? `<button class="btn primary big" data-act="reopen">Reopen “${esc(state.savedHandle.name)}”</button>` : ''}
        ${fsa ? `<button class="btn ${state.savedHandle ? 'ghost' : 'primary'} big" data-act="open-folder">Choose music folder</button>`
              : `<button class="btn primary big" data-act="pick-folder">Choose music folder</button>`}
        <button class="btn ghost" data-act="pick-files">Choose individual files</button>
      </div>
      <p class="muted small">Works best when the orchestra is in the <i>Artist</i> tag or the folder names (e.g. <code>Di Sarli/1941 - Corazón.mp3</code>). Singers and recording years are picked up from tags or file names when present.
      ${where === 'quiz' ? '' : ''}</p>
    </section>
    <section class="card">
      <h3>While you're here</h3>
      <p class="muted">The <b>Reference</b> tab works without any music. Browse the orchestras and what to listen for.</p>
    </section>`;
}

function renderLibrary() {
  if (!state.tracks.length) return renderNoLibrary('library');
  const total = state.tracks.length;
  const recog = state.tracks.filter(t => t.orchestra);
  const withYear = recog.filter(t => t.year).length, withSinger = recog.filter(t => t.singer).length;
  const unknown = new Map();
  for (const t of state.tracks) if (!t.orchestra && !t.ignored) {
    const u = unknown.get(t.artistKey) || { label: t.artistLabel, n: 0, sample: t.path, separate: t.separate };
    u.n++; unknown.set(t.artistKey, u);
  }
  const fuzzy = new Map();
  for (const t of state.tracks) if (t.matchedBy === 'fuzzy') {
    const u = fuzzy.get(t.artistKey) || { label: t.artistLabel, n: 0, orchestra: t.orchestra };
    u.n++; fuzzy.set(t.artistKey, u);
  }
  const unknownRows = [...unknown.entries()].sort((a, b) => b[1].n - a[1].n);
  const mapped = Object.entries(mappings);
  const options = sel => `<option value="">— choose —</option><option value="ignore" ${sel === 'ignore' ? 'selected' : ''}>Ignore (not tango / skip)</option>` +
    ORCHESTRAS.slice().sort((a, b) => a.name.localeCompare(b.name)).map(o => `<option value="${o.id}" ${sel === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  view.innerHTML = `
    <section class="card">
      <h2>${esc(state.libraryName || 'Library')}</h2>
      <div class="tiles">
        <div class="tile"><div class="tile-v">${total}</div><div class="tile-l">tracks</div></div>
        <div class="tile"><div class="tile-v">${recog.length}</div><div class="tile-l">recognised</div></div>
        <div class="tile"><div class="tile-v">${pct(withYear, recog.length)}%</div><div class="tile-l">with year</div></div>
        <div class="tile"><div class="tile-v">${pct(withSinger, recog.length)}%</div><div class="tile-l">with singer</div></div>
      </div>
      <div class="row">
        ${'showDirectoryPicker' in window ? '<button class="btn ghost sm" data-act="open-folder">Change folder</button>' : '<button class="btn ghost sm" data-act="pick-folder">Change folder</button>'}
        ${state.savedHandle ? '<button class="btn ghost sm" data-act="rescan">Rescan</button>' : ''}
        <button class="btn ghost sm" data-act="pick-files">Choose files</button>
      </div>
      <label class="check"><input type="checkbox" data-set="noSingerInstrumental" ${settings.noSingerInstrumental ? 'checked' : ''}> <span>Treat tracks with no singer found as <i>Instrumental</i>. Turn this on if your tags always name the singer when there is one.</span></label>
    </section>
    <section class="card">
      <h3>Orchestras found</h3>
      <div class="orchgrid">${[...state.byOrch.entries()].sort((a, b) => b[1].length - a[1].length).map(([id, ts]) =>
        `<div class="orchcell"><i class="sw" style="background:${orchById[id].color}"></i>${esc(orchById[id].name)}<span class="muted">${ts.length}</span></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
    </section>
    ${fuzzy.size ? `
    <section class="card">
      <h3>Matched by similar spelling (${fuzzy.size})</h3>
      <p class="muted small">These artist names were close to an orchestra name but not exact. Confirm or change each one.</p>
      ${[...fuzzy.entries()].map(([key, u]) => `
        <div class="maprow">
          <div>${esc(u.label)} <span class="muted">×${u.n}</span></div>
          <select data-map="${esc(key)}">${options(u.orchestra)}</select>
          <button class="btn ghost sm" data-act="confirm-map" data-k="${esc(key)}" data-v="${u.orchestra}">✓ Confirm</button>
        </div>`).join('')}
    </section>` : ''}
    ${unknownRows.length ? `
    <section class="card">
      <h3>Not recognised (${total - recog.length - state.tracks.filter(t => t.ignored).length})</h3>
      <p class="muted small">Assign an orchestra to an artist name and every track with that name follows.</p>
      ${unknownRows.slice(0, 200).map(([key, u]) => `
        <div class="maprow">
          <div><div>${esc(u.label)} <span class="muted">×${u.n}</span>${u.separate ? ' <span class="chip">separate ensemble</span>' : ''}</div><div class="path">${esc(u.sample)}</div></div>
          <select data-map="${esc(key)}">${options('')}</select>
        </div>`).join('')}
    </section>` : ''}
    ${mapped.length ? `
    <section class="card">
      <h3>Your manual assignments</h3>
      ${mapped.map(([key, id]) => `
        <div class="maprow"><div>${esc(key)}</div><select data-map="${esc(key)}">${options(id)}</select>
        <button class="btn ghost sm" data-act="unmap" data-k="${esc(key)}">✕</button></div>`).join('')}
    </section>` : ''}`;
}

/* ================= Rendering & events ================= */

const TABS = { quiz: renderQuiz, compare: renderCompare, reference: renderReference, stats: renderStats, library: renderLibrary };

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  $('#libname').textContent = state.tracks.length ? `${state.libraryName} · ${state.tracks.length} tracks` : 'No music loaded';
  if (state.busy) return renderBusy();
  TABS[state.tab]();
  updatePlayUI();
}

function renderBusy() {
  view.innerHTML = `<section class="card hero"><div class="spinner"></div><p>${esc(state.busy)}</p></section>`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

const actions = {
  'open-folder': openFolderPicker,
  'pick-folder': () => pickFiles(true),
  'pick-files': () => pickFiles(false),
  reopen: () => reopenSaved(),
  rescan: () => reopenSaved(true),
  start: () => { state.session = { n: 0, ok: 0, streak: 0 }; newRound(); },
  next: () => newRound(),
  quit: () => { stopAudio(); state.round = null; render(); },
  answer: el => answer(el.dataset.v),
  replay: () => { if (clip) replay(); else if (state.round) newRound(); },
  stop: stopAudio,
  full: playFull,
  'other-part': async () => {
    if (!clip) return;
    const owner = clip.owner;
    try { await playClip(clip.track, { owner, label: state.round?.done ? state.round.track.title : 'Mystery track' }); } catch (e) { toast(e.message); }
  },
  set: el => {
    const k = el.dataset.k, v = el.dataset.v;
    settings[k] = typeof settings[k] === 'number' ? +v : v;
    saveAll(); render();
  },
  'pool-all': () => { settings.excluded = []; saveAll(); render(); },
  'pool-none': () => { settings.excluded = [...state.byOrch.keys()]; saveAll(); render(); },
  'compare-pair': el => {
    stopAudio();
    Object.assign(state.compare, { a: el.dataset.a, b: el.dataset.b, cur: { a: null, b: null }, blind: null });
    state.tab = 'compare';
    newComparePair();
    render();
  },
  'cmp-play': el => comparePlay(el.dataset.k),
  'cmp-new': () => { newComparePair(); render(); comparePlay('a'); },
  'blind-play': blindPlay,
  'blind-answer': el => {
    const b = state.compare.blind;
    if (!b || b.picked) return;
    b.picked = el.dataset.v;
    state.compare.blindScore.n++;
    if (b.picked === b.answer) state.compare.blindScore.ok++;
    render();
  },
  'blind-next': () => { state.compare.blind = null; blindPlay(); },
  'ref-toggle': el => { state.refOpen = state.refOpen === el.dataset.id ? null : el.dataset.id; render(); },
  'ref-open': el => { state.refOpen = el.dataset.id; render(); document.querySelector('.ref.open')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  'ref-sample': async el => {
    const id = el.dataset.id;
    const t = pick(state.byOrch.get(id));
    try {
      await playClip(t, { owner: `ref-${id}`, label: `${orchById[id].name}: ${t.title}` });
      const now = $('#ref-now');
      if (now) now.textContent = `${t.title}${t.singer ? ' · ' + t.singer : ''}${t.year ? ' · ' + t.year : ''}`;
    } catch (e) { toast(e.message); }
  },
  'confirm-map': el => { mappings[el.dataset.k] = el.dataset.v; saveAll(); rebuild(); render(); },
  unmap: el => { delete mappings[el.dataset.k]; saveAll(); rebuild(); render(); },
  'reset-stats': () => {
    if (!confirm('Reset all quiz statistics?')) return;
    Object.assign(stats, { orch: {}, conf: {}, era: { n: 0, ok: 0 }, singer: { n: 0, ok: 0 }, best: 0 });
    saveAll(); render();
  },
};

view.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act]?.(el);
});

view.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.set) { settings[el.dataset.set] = el.checked; saveAll(); if (el.dataset.set === 'noSingerInstrumental') rebuild(); render(); }
  else if (el.dataset.pool) {
    const id = el.dataset.pool;
    settings.excluded = el.checked ? settings.excluded.filter(x => x !== id) : [...settings.excluded, id];
    saveAll(); render();
  } else if (el.dataset.cmp) {
    stopAudio();
    state.compare[el.dataset.cmp] = el.value;
    state.compare.blind = null;
    newComparePair(); render();
  } else if ('cmpsame' in el.dataset) {
    state.compare.same = el.checked; newComparePair(); render();
  } else if (el.dataset.map != null) {
    if (el.value) mappings[el.dataset.map] = el.value; else delete mappings[el.dataset.map];
    saveAll(); rebuild(); render();
  }
});

view.addEventListener('input', e => {
  if ('refq' in e.target.dataset) {
    state.refQuery = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = view.querySelector('[data-refq]');
    input.focus(); input.setSelectionRange(pos, pos);
  }
});

document.querySelector('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.tab === 'quiz' && state.round) {
    const r = state.round;
    if (/^[1-9]$/.test(e.key) && !r.done) {
      const c = r.steps[r.step].choices[+e.key - 1];
      if (c) answer(c);
    } else if (e.key === ' ') { e.preventDefault(); audio.paused ? replay() : stopAudio(); }
    else if ((e.key === 'Enter' || e.key === 'n') && r.done) newRound();
  } else if (state.tab === 'compare') {
    const b = state.compare.blind;
    if ((e.key === '1' || e.key === '2') && b && !b.picked) actions['blind-answer']({ dataset: { v: e.key === '1' ? 'a' : 'b' } });
    else if (e.key === ' ') { e.preventDefault(); stopAudio(); }
  }
});

/* ================= Boot ================= */

(async function init() {
  try { state.savedHandle = (await idb.get('kv', 'dir')) || null; } catch {}
  // If the browser still remembers the folder permission, the library is ready without a tap.
  try {
    if (state.savedHandle && (await state.savedHandle.queryPermission({ mode: 'read' })) === 'granted') await restoreIndex();
  } catch {}
  initMediaControls();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
