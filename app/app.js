// The Desk in the browser. Ported from prototype/app.js.
// Snow's reads, saves, folders, notes, XP and badges live on the local server
// (GET and PUT /api/state); the edition comes from GET /api/feed.
import {
  PHASE_LABEL, WEEK_GOAL, BADGES, articlesFor, autoPhase, awardText, blank, cnt, createStateClient, dayKey, esc, fmtDate,
  freshBadges, level as levelFor, moon, moonPath, readsThisWeek as readsSince, safeUrl,
  streak as streakOf, themeScores as scoresFor, uid, wilaLine,
} from './lib.js';

/* ================= constants ================= */
const FEED_URL = '/api/feed';
// Object hotspots, in % of the painted room. Later desks show their place in the build order.
const OBJECTS = [
  { id: 'books', name: 'Bookstore', l: 90, t: 2, w: 10, h: 88, desk: 11, tagIn: true },
  { id: 'workout', name: 'Workout Coach', l: 84.5, t: 63, w: 10.5, h: 30, desk: 4 },
  { id: 'sched', name: 'Scheduler', l: 72, t: 12, w: 15, h: 31, desk: 5 },
  { id: 'news', name: 'News', l: 71.5, t: 46, w: 9.5, h: 13, desk: 2 },
  { id: 'lang', name: 'Language', l: 81, t: 48, w: 8.5, h: 13, desk: 4.5 },
  { id: 'games', name: 'Games', l: 69.5, t: 75, w: 14.5, h: 9, desk: 3 },
  { id: 'astro', name: 'Astrology · Cycle Sync', l: 52.5, t: 30.5, w: 5.5, h: 14, desk: 7 },
  { id: 'opps', name: 'Opportunities', l: 22, t: 15.5, w: 5.6, h: 14.5, lock: 6 },
  { id: 'typewriter', name: 'Typewriter', l: 17, t: 55, w: 13, h: 13, desk: 10 },
  { id: 'projects', name: 'Projects', l: 36.5, t: 40.5, w: 17, h: 11, lock: 9 },
  { id: 'feed', name: 'Product Feed', l: 39, t: 52, w: 12, h: 15, open: true }
];

/* ================= helpers ================= */
const $ = s => document.querySelector(s);

/* ================= state + saving ================= */
let S = blank();
let feed = { articles: [], themes: [] };
// Nothing that depends on Snow's state is drawn until the first GET /api/state has finished,
// and the store won't save unless that GET worked, so a blank state never overwrites hers.
let ready = false;
const store = createStateClient({
  getState: () => S,
  onSaveFail: () => toast("I couldn't save that just now. I'll keep it here and keep trying."),
});
const save = () => store.save();
// Leaving the page: send what the debounce was still holding.
window.addEventListener('pagehide', () => store.flushOnExit());

const level = () => levelFor(S.xp);
const streak = () => streakOf(S.days);
const readsThisWeek = () => readsSince(S.read);
const themeScores = () => scoresFor(feed, S);
const listFor = sh => articlesFor(feed, S, sh);

async function loadState() {
  const r = await store.load();
  S = r.state;
  if (!r.ok) toast("I couldn't open your saved reads and notes, so changes won't be saved for now. Try reloading in a bit.", 'Reload', () => location.reload());
}
async function loadFeed() {
  try {
    const r = await fetch(FEED_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('feed ' + r.status);
    const d = await r.json();
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('feed is not an object');
    feed = { ...d, articles: Array.isArray(d.articles) ? d.articles : [], themes: Array.isArray(d.themes) ? d.themes : [] };
  } catch (e) { feed = { articles: [], themes: [] }; }
}

/* ================= progress ================= */
function touchDay() { const k = dayKey(); if (!S.days.includes(k)) S.days.push(k); S.days = S.days.slice(-120); }
function award(xp, msg) {
  const before = level();
  S.xp += xp; touchDay();
  const fresh = freshBadges(S, feed);
  fresh.forEach(b => S.badges[b.id] = Date.now());
  save();
  // While saving is paused (her saved state couldn't be read), say so gently.
  toast(awardText({ xp, msg, badges: fresh.map(b => b.name), newLevel: level() > before ? level() : 0, saved: store.canSave }));
}

/* ================= time of day ================= */
let preview = null;
const phase = () => preview || autoPhase();

/* ================= the room ================= */
function buildHotspots() {
  $('#hotspots').innerHTML = OBJECTS.map(o =>
    `<button class="hs" data-id="${o.id}" style="left:${o.l}%;top:${o.t}%;width:${o.w}%;height:${o.h}%" aria-label="${esc(o.name)}">
      <span class="glow"></span><span class="tag" ${o.tagIn ? 'style="bottom:auto;top:6%"' : ''}></span></button>`).join('');
  $('#hotspots').addEventListener('click', e => {
    const b = e.target.closest('.hs'); if (!b) return;
    const o = OBJECTS.find(x => x.id === b.dataset.id);
    if (o.open) return openFeed();
    if (!ready) return;
    if (o.lock && level() < o.lock) return toast(`${o.name} unlocks at level ${o.lock}. You're level ${level()}, so keep going.`);
    toast(`${o.name} is desk ${o.desk} in the build order. It opens once it's built.`);
  });
}
// The light, the date and the moon don't depend on Snow's state, so they show straight away.
function renderScene() {
  const p = phase();
  document.querySelectorAll('.plate').forEach(img => img.classList.toggle('on', img.dataset.phase === p));
  const now = new Date();
  $('#when').textContent = now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + PHASE_LABEL[p] + (preview ? ' (preview)' : ' in Toronto');
  const m = moon(now);
  $('#moonChip').innerHTML = `<svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="40" fill="#f6ebd3"/><path d="${moonPath(m.age)}" fill="#152e2c" opacity=".88"/></svg>${esc(m.name)}`;
  $('#phaseName').textContent = preview ? PHASE_LABEL[preview] : 'auto';
  return p;
}
function renderRoom() {
  const p = renderScene();
  if (!ready) return;
  const unread = feed.articles.filter(a => !S.read[a.id]).length;
  OBJECTS.forEach(o => {
    const b = document.querySelector(`.hs[data-id="${o.id}"]`); if (!b) return;
    const tag = b.querySelector('.tag');
    const locked = o.lock && level() < o.lock;
    b.classList.toggle('locked', !!locked);
    b.classList.toggle('new', !!o.open && unread > 0);
    tag.textContent = o.open ? (unread ? `${o.name} · ${unread} new` : o.name) : locked ? `${o.name} · level ${o.lock}` : o.name;
    let badge = b.querySelector('.badge');
    if (o.open && unread) { if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; b.appendChild(badge); } badge.textContent = unread; }
    else if (badge) badge.remove();
  });
  const st = streak();
  $('#streakChip').textContent = st ? `Streak · ${st} day${st > 1 ? 's' : ''}` : 'Start a streak today';
  $('#lvlText').textContent = 'Level ' + level();
  $('#lvlFill').style.width = (S.xp % 100) + '%';
  $('#wilaLine').textContent = wilaLine(p, unread, feed.articles.length > 0);
}

/* ================= navigation ================= */
function openFeed() { $('#frame').classList.add('zoom'); setTimeout(() => { location.hash = 'feed'; }, 750); }
function route() {
  const inFeed = location.hash === '#feed';
  $('#feed').hidden = !inFeed; $('#room').hidden = inFeed;
  if (inFeed) { if (ready) renderFeed(); window.scrollTo(0, 0); }
  else { requestAnimationFrame(() => requestAnimationFrame(() => $('#frame').classList.remove('zoom'))); renderRoom(); }
}

/* ================= the feed ================= */
let shelf = 'all', editing = null, confirming = null, openArticle = null;
const noteTime = ts => new Date(ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function renderShelves() {
  const base = [['all', 'Everything', feed.articles.length], ['unread', 'Unread', listFor('unread').length], ['saved', 'Saved', listFor('saved').length], ['notes', 'My notes', S.notes.length]];
  let h = base.map(([k, n, c]) => `<li class="shelf ${shelf === k ? 'on' : ''}"><button class="s" data-shelf="${k}"><span>${n}</span><span class="n">${c}</span></button></li>`).join('');
  h += `<li class="shelfsep">Folders</li>`;
  if (!S.folders.length) h += `<li class="shelfsep" style="margin:0;opacity:.8">No folders yet</li>`;
  h += S.folders.map(f => {
    const k = 'f:' + f.id;
    if (editing === f.id) return `<li class="shelf"><input data-rename="${esc(f.id)}" value="${esc(f.name)}" maxlength="40" aria-label="Folder name"></li>`;
    if (confirming === f.id) return `<li class="shelf"><span style="flex:1;padding:0 8px;font-size:14px">Delete “${esc(f.name)}”?</span><button class="mini" data-del-yes="${esc(f.id)}" aria-label="Yes, delete">Yes</button><button class="mini" data-del-no aria-label="Keep folder">No</button></li>`;
    return `<li class="shelf ${shelf === k ? 'on' : ''}"><button class="s" data-shelf="${esc(k)}"><span>${esc(f.name)}</span><span class="n">${listFor(k).length}</span></button><button class="mini" data-edit="${esc(f.id)}" aria-label="Rename ${esc(f.name)}">✎</button><button class="mini" data-del="${esc(f.id)}" aria-label="Delete ${esc(f.name)}">×</button></li>`;
  }).join('');
  $('#shelfList').innerHTML = h;
  const inp = document.querySelector('[data-rename]'); if (inp) { inp.focus(); inp.select(); }
}
function shelfTitle() {
  if (shelf.startsWith('f:')) { const f = S.folders.find(x => 'f:' + x.id === shelf); return f ? f.name : 'Folder'; }
  return { all: "Today's edition", unread: 'Unread', saved: 'Saved', notes: 'My notes' }[shelf];
}
function renderList() {
  const edition = feed.edition ? 'Edition of ' + esc(fmtDate(feed.edition)) + (feed.sample === true ? ' · sample picks from real articles' : '') : '';
  const head = `<div class="listhead"><h2>${esc(shelfTitle())}</h2><span>${edition}</span></div>`;
  if (shelf === 'notes') {
    const notes = [...S.notes].sort((a, b) => b.ts - a.ts);
    $('#list').innerHTML = head + (notes.length ? notes.map(n => {
      const a = feed.articles.find(x => x.id === n.a);
      return `<article class="notecard"><div class="on">${esc(noteTime(n.ts))} · on <button class="ab" style="min-height:30px;border:0;padding:0;text-decoration:underline" data-notes="${esc(n.a)}">${esc(a ? a.title : 'an article')}</button></div><p>${esc(n.text)}</p></article>`;
    }).join('') : `<div class="empty-state">No notes yet. Open any article's Notes to jot down what stuck with you.</div>`);
    return;
  }
  const list = listFor(shelf);
  if (!list.length) { $('#list').innerHTML = head + `<div class="empty-state">${shelf === 'unread' ? "All read. Your feed agent brings new picks every morning." : 'Nothing here yet. Use Save on any article to file it.'}</div>`; return; }
  $('#list').innerHTML = head + list.map(a => {
    const read = !!S.read[a.id]; const inF = S.saved[a.id] || []; const nn = S.notes.filter(n => n.a === a.id).length;
    const url = safeUrl(a.url);
    const tags = (a.themes || []).map(t => { const th = feed.themes.find(x => x.id === t); return `<span class="tagchip">${esc(th ? th.name : t)}</span>`; }).join('');
    const menu = S.folders.length ? S.folders.map(f => `<label><input type="checkbox" data-save="${esc(a.id)}" value="${esc(f.id)}" ${inF.includes(f.id) ? 'checked' : ''}>${esc(f.name)}</label>`).join('') : `<div class="empty">Make a folder on the left first.</div>`;
    return `<article class="art ${read ? 'read' : ''}" data-id="${esc(a.id)}">
      <div class="meta"><span>${esc(a.source)}</span>${a.author ? `<span>· ${esc(a.author)}</span>` : ''}${a.date ? `<span>· ${esc(fmtDate(a.date))}</span>` : ''}<span>· ${esc(a.minutes)} min</span></div>
      <h3>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title)}</h3>
      <p>${esc(a.summary)}</p>
      <div class="tags">${tags}</div>
      <p class="why">${esc(a.why)}</p>
      <div class="arow">
        <button class="ab ${read ? 'on' : ''}" data-read="${esc(a.id)}">${read ? 'Read ✓' : 'Mark as read'}</button>
        <details class="savebox"><summary class="ab ${inF.length ? 'on' : ''}" role="button">${inF.length ? 'Saved' : 'Save'} ▾</summary><div class="menu">${menu}</div></details>
        <button class="ab" data-notes="${esc(a.id)}">Notes${nn ? ' (' + nn + ')' : ''}</button>
      </div></article>`;
  }).join('');
}
function renderStats() {
  const w = readsThisWeek(); const pct = Math.min(100, (w / WEEK_GOAL) * 100);
  $('#weekRing').style.background = `radial-gradient(closest-side,var(--teal) 76%,transparent 77%),conic-gradient(var(--amber) ${pct}%,rgba(255,255,255,.15) 0)`;
  $('#weekRing').innerHTML = `${w}/${WEEK_GOAL}<br><span style="font:500 10px Inter">this week</span>`;
  $('#xpText').textContent = S.xp + ' XP';
  $('#lvlText2').textContent = 'Level ' + level() + ' · ' + (100 - S.xp % 100) + ' XP to next';
  $('#fsub').textContent = 'Product, AI and PM · picked for your goals';
}
function renderBadges() {
  $('#badges').innerHTML = BADGES.map(b => `<li class="${S.badges[b.id] ? 'got' : ''}"><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/></svg></span><div><b>${esc(b.name)}</b><span>${esc(b.how)}</span></div></li>`).join('');
  $('#badgeCount').textContent = `${cnt(S.badges)} of ${BADGES.length} badges`;
}
const mapSvg = $('#mapSvg');
function drawMap() {
  if (!ready) return;
  const W = mapSvg.clientWidth, H = mapSvg.clientHeight; if (!W || !H) return;
  const T = themeScores(); const cx = W / 2, cy = H / 2 - 6, rx = W / 2 - 58, ry = H / 2 - 44;
  const pos = {}; T.forEach((t, i) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / T.length; pos[t.id] = [cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]; });
  const links = {};
  feed.articles.filter(a => S.read[a.id] && Array.isArray(a.themes) && a.themes.length > 1).forEach(a => {
    for (let i = 0; i < a.themes.length; i++) for (let j = i + 1; j < a.themes.length; j++) { const k = [a.themes[i], a.themes[j]].sort().join('|'); links[k] = (links[k] || 0) + 1; }
  });
  let g = '';
  T.forEach(t => { if (t.score > 0) g += `<line x1="${cx}" y1="${cy}" x2="${pos[t.id][0]}" y2="${pos[t.id][1]}" stroke="#ffd98a" stroke-opacity="${Math.min(.7, .2 + t.score * .08)}" stroke-width="1.5"/>`; });
  Object.entries(links).forEach(([k, n]) => { const [a, b] = k.split('|'); if (pos[a] && pos[b]) g += `<line x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}" stroke="#b6d77a" stroke-opacity=".75" stroke-width="${1 + n}"/>`; });
  g += `<circle cx="${cx}" cy="${cy}" r="16" fill="#ffd98a"/><text x="${cx}" y="${cy + 34}" text-anchor="middle" font-size="12" fill="#fbf4e4" font-family="Fredoka">you</text>`;
  T.forEach(t => {
    const [x, y] = pos[t.id]; const r = 10 + Math.min(24, t.score * 4); const lit = t.score > 0;
    const name = String(t.name ?? '');
    g += `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${lit ? '#f2b84b' : 'none'}" fill-opacity="${lit ? .85 : 0}" stroke="${lit ? '#ffd98a' : '#9fb0a7'}" stroke-width="1.5" ${lit ? '' : 'stroke-dasharray="3 3"'}/>
      <text x="${x}" y="${y + r + 15}" text-anchor="middle" font-size="12.5" fill="${lit ? '#fbf4e4' : '#bccbc2'}" font-family="Inter">${esc(W < 300 ? name.replace('The ', '') : name)}</text>
      <text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" fill="#152e2c" font-weight="600" font-family="Inter">${t.reads ? t.reads + '/' + t.total : ''}</text></g>`;
  });
  mapSvg.innerHTML = g;
}
const mapRO = new ResizeObserver(drawMap); mapRO.observe(mapSvg);
function renderFeed() { renderShelves(); renderList(); renderStats(); renderBadges(); drawMap(); }
function renderAll() { renderRoom(); if (!$('#feed').hidden) renderFeed(); }

/* ================= feed actions ================= */
$('#shelfList').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.shelf) { shelf = t.dataset.shelf; editing = confirming = null; renderShelves(); renderList(); }
  else if (t.dataset.edit) { editing = t.dataset.edit; confirming = null; renderShelves(); }
  else if (t.dataset.del) { confirming = t.dataset.del; editing = null; renderShelves(); }
  else if (t.dataset.delYes) {
    const f = S.folders.find(x => x.id === t.dataset.delYes); if (!f) return;
    const snapshot = JSON.parse(JSON.stringify(S.saved));
    S.folders = S.folders.filter(x => x.id !== f.id);
    Object.keys(S.saved).forEach(k => { S.saved[k] = S.saved[k].filter(id => id !== f.id); if (!S.saved[k].length) delete S.saved[k]; });
    if (shelf === 'f:' + f.id) shelf = 'all';
    confirming = null; save(); renderFeed();
    toast(`Deleted “${f.name}”.`, 'Undo', () => { S.folders.push(f); S.saved = snapshot; save(); renderFeed(); });
  } else if ('delNo' in t.dataset) { confirming = null; renderShelves(); }
});
function finishRename(inp, keep) {
  const f = S.folders.find(x => x.id === inp.dataset.rename); const v = inp.value.trim();
  if (keep && f && v) { f.name = v; save(); }
  editing = null; renderFeed();
}
$('#shelfList').addEventListener('keydown', e => { const inp = e.target.closest('[data-rename]'); if (!inp) return; if (e.key === 'Enter') finishRename(inp, true); if (e.key === 'Escape') finishRename(inp, false); });
$('#shelfList').addEventListener('focusout', e => { const inp = e.target.closest('[data-rename]'); if (inp && editing) finishRename(inp, true); });
$('#folderForm').addEventListener('submit', e => {
  e.preventDefault(); if (!ready) return;
  const v = $('#folderName').value.trim(); if (!v) return;
  const first = !S.folders.length;
  S.folders.push({ id: uid(), name: v }); $('#folderName').value = '';
  first ? award(5, 'folder made') : save();
  renderFeed();
});
$('#list').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.read) {
    const id = t.dataset.read;
    if (S.read[id]) { delete S.read[id]; save(); }
    else { S.read[id] = Date.now(); award(10, 'article read'); }
    renderFeed();
  } else if (t.dataset.notes) openDrawer(t.dataset.notes);
});
$('#list').addEventListener('change', e => {
  const c = e.target.closest('[data-save]'); if (!c) return;
  const a = c.dataset.save; const cur = new Set(S.saved[a] || []); const wasSaved = cur.size > 0;
  c.checked ? cur.add(c.value) : cur.delete(c.value);
  if (cur.size) S.saved[a] = [...cur]; else delete S.saved[a];
  (!wasSaved && cur.size) ? award(5, 'saved to a folder') : save();
  const open = c.closest('details'); renderShelves(); renderStats(); renderBadges(); drawMap();
  const sum = open && open.querySelector('summary'); if (sum) { sum.textContent = (cur.size ? 'Saved' : 'Save') + ' ▾'; sum.classList.toggle('on', cur.size > 0); }
});
document.addEventListener('click', e => { document.querySelectorAll('details.savebox[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }); });
$('#backBtn').addEventListener('click', () => { location.hash = ''; });

/* ================= drawer: notes ================= */
// The chat with Wila (the drawer's second tab) comes back with S6.
function openDrawer(id) {
  const a = feed.articles.find(x => x.id === id); if (!a) return;
  openArticle = id;
  $('#dSrc').textContent = a.source + (a.date ? ' · ' + fmtDate(a.date) : '');
  $('#dTitle').textContent = a.title;
  $('#drawer').hidden = false; $('#scrim').hidden = false;
  renderNotes();
  $('#noteText').focus();
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; renderFeed(); }
function renderNotes() {
  const list = S.notes.filter(n => n.a === openArticle).sort((a, b) => b.ts - a.ts);
  $('#noteList').innerHTML = list.length ? list.map(n => `<li><p>${esc(n.text)}</p><div class="nrow"><span>${esc(noteTime(n.ts))}</span><button data-dn="${esc(n.id)}">Delete</button></div></li>`).join('') : `<li style="background:none;border:0;padding:0" class="tiny">No notes on this one yet.</li>`;
}
$('#noteSave').addEventListener('click', () => {
  const v = $('#noteText').value.trim(); if (!v || !ready) return;
  S.notes.push({ id: uid(), a: openArticle, text: v.slice(0, 4000), ts: Date.now() });
  $('#noteText').value = ''; award(15, 'note saved'); renderNotes();
});
$('#noteList').addEventListener('click', e => {
  const b = e.target.closest('[data-dn]'); if (!b) return;
  const gone = S.notes.find(n => n.id === b.dataset.dn); if (!gone) return;
  S.notes = S.notes.filter(n => n.id !== b.dataset.dn); save(); renderNotes();
  toast('Note deleted.', 'Undo', () => { S.notes.push(gone); save(); renderNotes(); });
});
$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

/* ================= toasts ================= */
let toastTimer;
function toast(msg, actLabel, act) {
  const el = location.hash === '#feed' ? $('#toast2') : $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (actLabel ? `<button>${esc(actLabel)}</button>` : '');
  if (act) el.querySelector('button').onclick = () => { act(); el.classList.remove('on'); };
  el.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), actLabel ? 6000 : 3600);
}

/* ================= room controls ================= */
$('#openFeedBtn').addEventListener('click', openFeed);
$('#hideDialogue').addEventListener('click', () => { $('#dialogue').hidden = true; });
$('#wilaOrb').addEventListener('click', () => { $('#dialogue').hidden = !$('#dialogue').hidden; renderRoom(); });
$('#phaseBtn').addEventListener('click', () => { const order = [null, 'morning', 'golden', 'night']; preview = order[(order.indexOf(preview) + 1) % order.length]; renderRoom(); });
window.addEventListener('hashchange', route);
setInterval(() => { if (!preview) renderRoom(); }, 60e3);

/* ================= start ================= */
buildHotspots();
route();
Promise.all([loadState(), loadFeed()]).then(() => { ready = true; renderAll(); });
