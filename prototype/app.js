{
/* ================= constants ================= */
const TORONTO = { lat: 43.6532, lng: -79.3832 };
const WEEK_GOAL = 5;
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
const BADGES = [
  { id: 'first-read', name: 'First page turned', how: 'Read one article', test: s => cnt(s.read) >= 1 },
  { id: 'five-reads', name: 'Steady reader', how: 'Read five articles', test: s => cnt(s.read) >= 5 },
  { id: 'first-note', name: 'Thinking out loud', how: 'Write your first note', test: s => s.notes.length >= 1 },
  { id: 'curator', name: 'Curator', how: 'Make a folder', test: s => s.folders.length >= 1 },
  { id: 'connector', name: 'Connector', how: 'Read across three themes', test: () => themeScores().filter(t => t.reads > 0).length >= 3 },
  { id: 'deep-diver', name: 'Deep diver', how: 'Three notes on one theme', test: () => themeScores().some(t => t.notes >= 3) }
];

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cnt = o => Object.keys(o || {}).length;
const uid = () => Math.random().toString(36).slice(2, 9);
const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA');
const safeUrl = u => (typeof u === 'string' && u.startsWith('https://')) ? u : null;
function fmtDate(iso) { if (!iso) return ''; const d = new Date(iso + 'T12:00:00'); return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); }

/* ================= state + saving ================= */
const blank = () => ({ read: {}, saved: {}, folders: [], notes: [], xp: 0, days: [], badges: {} });
let S = blank();
let feed = { articles: [], themes: [] };
let ref = null, writing = false, pending = false, saveTimer = null;
try { const raw = localStorage.getItem('the-desk'); if (raw) S = Object.assign(blank(), JSON.parse(raw)); } catch (e) { }

function save() {
  try { localStorage.setItem('the-desk', JSON.stringify(S)); } catch (e) { }
  if (!ref) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 600);
}
async function flush() {
  if (writing) { pending = true; return; }
  writing = true;
  try { await ref.set(JSON.parse(JSON.stringify(S))); } catch (e) { if (e && e.code === 'invalid_argument') ref = null; }
  writing = false;
  if (pending) { pending = false; flush(); }
}
async function connectStore() {
  if (!window.claude || !claude.use) return;
  try {
    const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
    if (!db || !user) return;
    const id = await user.id();
    if (!id) return;
    const r = db.doc('data/users/' + id + '/desk');
    const snap = await r.get();
    ref = r;
    if (snap.exists) { S = Object.assign(blank(), snap.data()); }
    else if (S.xp || S.notes.length || S.folders.length) { flush(); }
    renderAll();
  } catch (e) { /* keep local state */ }
}

/* ================= progress ================= */
function touchDay() { const k = dayKey(); if (!S.days.includes(k)) S.days.push(k); S.days = S.days.slice(-120); }
function streak() {
  const set = new Set(S.days); let n = 0; const d = new Date();
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (set.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
const level = () => 1 + Math.floor(S.xp / 100);
function readsThisWeek() {
  const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return Object.values(S.read).filter(ts => ts >= start.getTime()).length;
}
function award(xp, msg) {
  const before = level();
  S.xp += xp; touchDay();
  const fresh = BADGES.filter(b => !S.badges[b.id] && b.test(S));
  fresh.forEach(b => S.badges[b.id] = Date.now());
  save();
  let text = '+' + xp + ' XP · ' + msg;
  if (fresh.length) text = 'New badge: ' + fresh.map(b => b.name).join(', ') + ' · +' + xp + ' XP';
  if (level() > before) text = 'Level ' + level() + '! ' + text;
  toast(text);
}

/* ================= time of day ================= */
function sunTimes(date) {
  const rad = Math.PI / 180, zen = 90.833 * rad;
  const start = new Date(date.getFullYear(), 0, 0);
  const N = Math.floor((date - start) / 864e5);
  const lngHour = TORONTO.lng / 15;
  const calc = rising => {
    const t = N + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634 + 360) % 360;
    let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 360) % 360;
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90; RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zen) - sinDec * Math.sin(TORONTO.lat * rad)) / (cosDec * Math.cos(TORONTO.lat * rad));
    let H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad; if (rising) H = 360 - H; H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    const UT = ((T - lngHour) % 24 + 24) % 24;
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())); d.setUTCMinutes(UT * 60);
    return d;
  };
  return { rise: calc(true), set: calc(false) };
}
function autoPhase(now = new Date()) {
  const st = sunTimes(now), rise = st.rise.getTime(), set = st.set.getTime(), t = now.getTime(), m = 60e3;
  if (t < rise - 30 * m || t > set + 30 * m) return 'night';
  if (t > set - 120 * m) return 'golden';
  return 'morning';
}
const PHASE_LABEL = { morning: 'Daylight', golden: 'Golden hour', night: 'Night' };
let preview = null;
const phase = () => preview || autoPhase();
function moon(now = new Date()) {
  const age = (((now - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % 29.530588 + 29.530588) % 29.530588;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return { age, name: names[Math.floor((age / 29.530588) * 8 + 0.5) % 8] };
}

/* ================= the room ================= */
function buildHotspots() {
  $('#hotspots').innerHTML = OBJECTS.map(o =>
    `<button class="hs" data-id="${o.id}" style="left:${o.l}%;top:${o.t}%;width:${o.w}%;height:${o.h}%" aria-label="${esc(o.name)}">
      <span class="glow"></span><span class="tag" ${o.tagIn ? 'style="bottom:auto;top:6%"' : ''}></span></button>`).join('');
  $('#hotspots').addEventListener('click', e => {
    const b = e.target.closest('.hs'); if (!b) return;
    const o = OBJECTS.find(x => x.id === b.dataset.id);
    if (o.open) return openFeed();
    if (o.lock && level() < o.lock) return toast(`${o.name} unlocks at level ${o.lock}. You're level ${level()}, so keep going.`);
    toast(`${o.name} is desk ${o.desk} in the build order. It opens once it's built.`);
  });
}
function renderRoom() {
  const p = phase();
  document.querySelectorAll('.plate').forEach(img => img.classList.toggle('on', img.dataset.phase === p));
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
  const now = new Date();
  $('#when').textContent = now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + PHASE_LABEL[p] + (preview ? ' (preview)' : ' in Toronto');
  $('#moonChip').innerHTML = `<svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="40" fill="#f6ebd3"/><path d="${moonPath(moon().age)}" fill="#152e2c" opacity=".88"/></svg>${esc(moon().name)}`;
  const st = streak();
  $('#streakChip').textContent = st ? `Streak · ${st} day${st > 1 ? 's' : ''}` : 'Start a streak today';
  $('#lvlText').textContent = 'Level ' + level();
  $('#lvlFill').style.width = (S.xp % 100) + '%';
  $('#phaseName').textContent = preview ? PHASE_LABEL[preview] : 'auto';
  $('#wilaLine').textContent = wilaLine(p, unread);
}
function moonPath(age) {
  const f = age / 29.530588; const k = Math.cos(f * 2 * Math.PI); const rx = Math.abs(40 * k);
  // shadow side: waxing => shadow on left, waning => shadow on right
  if (f < 0.5) return `M50 10 A40 40 0 0 0 50 90 A${rx} 40 0 0 ${k > 0 ? 0 : 1} 50 10Z`;
  return `M50 10 A40 40 0 0 1 50 90 A${rx} 40 0 0 ${k > 0 ? 1 : 0} 50 10Z`;
}
function wilaLine(p, n) {
  if (!feed.articles.length) return 'Your Product Feed is still being set up.';
  if (!n) return p === 'night' ? "You've read every pick in your feed. That's a good day. Rest well." : "You're all caught up on the feed. Want to add a note while it's fresh?";
  const picks = n === 1 ? '1 pick is' : `${n} picks are`;
  if (p === 'morning') return `Good morning, Snow. ${picks} waiting in your Product Feed. Start with one over coffee?`;
  if (p === 'golden') return `Golden hour, Snow. ${picks} still on the laptop. One short read before the day winds down?`;
  return `Evening, Snow. ${picks} still on the laptop. No rush, they'll keep until morning.`;
}

/* ================= navigation ================= */
function openFeed() { $('#frame').classList.add('zoom'); setTimeout(() => { location.hash = 'feed'; }, 750); }
function route() {
  const inFeed = location.hash === '#feed';
  $('#feed').hidden = !inFeed; $('#room').hidden = inFeed;
  if (inFeed) { renderFeed(); window.scrollTo(0, 0); }
  else { requestAnimationFrame(() => requestAnimationFrame(() => $('#frame').classList.remove('zoom'))); renderRoom(); }
}

/* ================= the feed ================= */
let shelf = 'all', editing = null, confirming = null, openArticle = null, chat = [];
function articlesFor(sh) {
  const A = feed.articles;
  if (sh === 'unread') return A.filter(a => !S.read[a.id]);
  if (sh === 'saved') return A.filter(a => (S.saved[a.id] || []).length);
  if (sh.startsWith('f:')) { const f = sh.slice(2); return A.filter(a => (S.saved[a.id] || []).includes(f)); }
  return A;
}
function renderShelves() {
  const base = [['all', 'Everything', feed.articles.length], ['unread', 'Unread', articlesFor('unread').length], ['saved', 'Saved', articlesFor('saved').length], ['notes', 'My notes', S.notes.length]];
  let h = base.map(([k, n, c]) => `<li class="shelf ${shelf === k ? 'on' : ''}"><button class="s" data-shelf="${k}"><span>${n}</span><span class="n">${c}</span></button></li>`).join('');
  h += `<li class="shelfsep">Folders</li>`;
  if (!S.folders.length) h += `<li class="shelfsep" style="margin:0;opacity:.8">No folders yet</li>`;
  h += S.folders.map(f => {
    const k = 'f:' + f.id;
    if (editing === f.id) return `<li class="shelf"><input data-rename="${f.id}" value="${esc(f.name)}" maxlength="40" aria-label="Folder name"></li>`;
    if (confirming === f.id) return `<li class="shelf"><span style="flex:1;padding:0 8px;font-size:14px">Delete “${esc(f.name)}”?</span><button class="mini" data-del-yes="${f.id}" aria-label="Yes, delete">Yes</button><button class="mini" data-del-no aria-label="Keep folder">No</button></li>`;
    return `<li class="shelf ${shelf === k ? 'on' : ''}"><button class="s" data-shelf="${k}"><span>${esc(f.name)}</span><span class="n">${articlesFor(k).length}</span></button><button class="mini" data-edit="${f.id}" aria-label="Rename ${esc(f.name)}">✎</button><button class="mini" data-del="${f.id}" aria-label="Delete ${esc(f.name)}">×</button></li>`;
  }).join('');
  $('#shelfList').innerHTML = h;
  const inp = document.querySelector('[data-rename]'); if (inp) { inp.focus(); inp.select(); }
}
function shelfTitle() {
  if (shelf.startsWith('f:')) { const f = S.folders.find(x => 'f:' + x.id === shelf); return f ? f.name : 'Folder'; }
  return { all: "Today's edition", unread: 'Unread', saved: 'Saved', notes: 'My notes' }[shelf];
}
function renderList() {
  const head = `<div class="listhead"><h2>${esc(shelfTitle())}</h2><span>${feed.edition ? 'Edition of ' + esc(fmtDate(feed.edition)) + ' · sample picks from real articles' : ''}</span></div>`;
  if (shelf === 'notes') {
    const notes = [...S.notes].sort((a, b) => b.ts - a.ts);
    $('#list').innerHTML = head + (notes.length ? notes.map(n => {
      const a = feed.articles.find(x => x.id === n.a);
      return `<article class="notecard"><div class="on">${esc(new Date(n.ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · on <button class="ab" style="min-height:30px;border:0;padding:0;text-decoration:underline" data-notes="${esc(n.a)}">${esc(a ? a.title : 'an article')}</button></div><p>${esc(n.text)}</p></article>`;
    }).join('') : `<div class="empty-state">No notes yet. Open any article's Notes to jot down what stuck with you.</div>`);
    return;
  }
  const list = articlesFor(shelf);
  if (!list.length) { $('#list').innerHTML = head + `<div class="empty-state">${shelf === 'unread' ? "All read. Your feed agent brings new picks every morning." : 'Nothing here yet. Use Save on any article to file it.'}</div>`; return; }
  $('#list').innerHTML = head + list.map(a => {
    const read = !!S.read[a.id]; const inF = S.saved[a.id] || []; const nn = S.notes.filter(n => n.a === a.id).length;
    const url = safeUrl(a.url);
    const tags = (a.themes || []).map(t => { const th = feed.themes.find(x => x.id === t); return `<span class="tagchip">${esc(th ? th.name : t)}</span>`; }).join('');
    const menu = S.folders.length ? S.folders.map(f => `<label><input type="checkbox" data-save="${esc(a.id)}" value="${f.id}" ${inF.includes(f.id) ? 'checked' : ''}>${esc(f.name)}</label>`).join('') : `<div class="empty">Make a folder on the left first.</div>`;
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
        <button class="ab" data-chat="${esc(a.id)}">Talk with Wila</button>
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
function themeScores() {
  return (feed.themes || []).map(t => {
    const arts = feed.articles.filter(a => (a.themes || []).includes(t.id));
    const reads = arts.filter(a => S.read[a.id]).length;
    const notes = S.notes.filter(n => arts.some(a => a.id === n.a)).length;
    const saves = arts.filter(a => (S.saved[a.id] || []).length).length;
    return { ...t, total: arts.length, reads, notes, saves, score: reads + notes * 2 + saves * 0.5 };
  });
}
const mapSvg = $('#mapSvg');
function drawMap() {
  const W = mapSvg.clientWidth, H = mapSvg.clientHeight; if (!W || !H) return;
  const T = themeScores(); const cx = W / 2, cy = H / 2 - 6, rx = W / 2 - 58, ry = H / 2 - 44;
  const pos = {}; T.forEach((t, i) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / T.length; pos[t.id] = [cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]; });
  const links = {};
  feed.articles.filter(a => S.read[a.id] && (a.themes || []).length > 1).forEach(a => {
    for (let i = 0; i < a.themes.length; i++) for (let j = i + 1; j < a.themes.length; j++) { const k = [a.themes[i], a.themes[j]].sort().join('|'); links[k] = (links[k] || 0) + 1; }
  });
  let g = '';
  T.forEach(t => { if (t.score > 0) g += `<line x1="${cx}" y1="${cy}" x2="${pos[t.id][0]}" y2="${pos[t.id][1]}" stroke="#ffd98a" stroke-opacity="${Math.min(.7, .2 + t.score * .08)}" stroke-width="1.5"/>`; });
  Object.entries(links).forEach(([k, n]) => { const [a, b] = k.split('|'); if (pos[a] && pos[b]) g += `<line x1="${pos[a][0]}" y1="${pos[a][1]}" x2="${pos[b][0]}" y2="${pos[b][1]}" stroke="#b6d77a" stroke-opacity=".75" stroke-width="${1 + n}"/>`; });
  g += `<circle cx="${cx}" cy="${cy}" r="16" fill="#ffd98a"/><text x="${cx}" y="${cy + 34}" text-anchor="middle" font-size="12" fill="#fbf4e4" font-family="Fredoka">you</text>`;
  T.forEach(t => {
    const [x, y] = pos[t.id]; const r = 10 + Math.min(24, t.score * 4); const lit = t.score > 0;
    g += `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${lit ? '#f2b84b' : 'none'}" fill-opacity="${lit ? .85 : 0}" stroke="${lit ? '#ffd98a' : '#9fb0a7'}" stroke-width="1.5" ${lit ? '' : 'stroke-dasharray="3 3"'}/>
      <text x="${x}" y="${y + r + 15}" text-anchor="middle" font-size="12.5" fill="${lit ? '#fbf4e4' : '#bccbc2'}" font-family="Inter">${esc(W < 300 ? t.name.replace('The ', '') : t.name)}</text>
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
    const f = S.folders.find(x => x.id === t.dataset.delYes); const snapshot = JSON.parse(JSON.stringify(S.saved));
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
  e.preventDefault(); const v = $('#folderName').value.trim(); if (!v) return;
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
  } else if (t.dataset.notes) openDrawer(t.dataset.notes, 'notes');
  else if (t.dataset.chat) openDrawer(t.dataset.chat, 'chat');
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

/* ================= drawer: notes + chat ================= */
function openDrawer(id, tab) {
  const a = feed.articles.find(x => x.id === id); if (!a) return;
  if (openArticle !== id) chat = [];
  openArticle = id;
  $('#dSrc').textContent = a.source + (a.date ? ' · ' + fmtDate(a.date) : '');
  $('#dTitle').textContent = a.title;
  $('#drawer').hidden = false; $('#scrim').hidden = false;
  setTab(tab); renderNotes(); renderChat();
  (tab === 'notes' ? $('#noteText') : $('#chatIn')).focus();
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; renderFeed(); }
function setTab(t) { $('#tabNotes').setAttribute('aria-selected', t === 'notes'); $('#tabChat').setAttribute('aria-selected', t === 'chat'); $('#paneNotes').hidden = t !== 'notes'; $('#paneChat').hidden = t !== 'chat'; }
function renderNotes() {
  const list = S.notes.filter(n => n.a === openArticle).sort((a, b) => b.ts - a.ts);
  $('#noteList').innerHTML = list.length ? list.map(n => `<li><p>${esc(n.text)}</p><div class="nrow"><span>${esc(new Date(n.ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span><button data-dn="${n.id}">Delete</button></div></li>`).join('') : `<li style="background:none;border:0;padding:0" class="tiny">No notes on this one yet.</li>`;
}
$('#noteSave').addEventListener('click', () => {
  const v = $('#noteText').value.trim(); if (!v) return;
  S.notes.push({ id: uid(), a: openArticle, text: v.slice(0, 4000), ts: Date.now() });
  $('#noteText').value = ''; award(15, 'note saved'); renderNotes();
});
$('#noteList').addEventListener('click', e => {
  const b = e.target.closest('[data-dn]'); if (!b) return;
  const gone = S.notes.find(n => n.id === b.dataset.dn);
  S.notes = S.notes.filter(n => n.id !== b.dataset.dn); save(); renderNotes();
  toast('Note deleted.', 'Undo', () => { S.notes.push(gone); save(); renderNotes(); });
});
$('#tabNotes').addEventListener('click', () => setTab('notes'));
$('#tabChat').addEventListener('click', () => { setTab('chat'); $('#chatIn').focus(); });
$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

function renderChat() {
  $('#chatLog').innerHTML = chat.length ? chat.map(m => `<div class="msg ${m.role === 'user' ? 'me' : 'w'}">${esc(m.content)}</div>`).join('') : `<div class="msg w">Hi Snow. I've got the summary of this one and your notes on it. What would you like to dig into?</div>`;
  $('#chatLog').scrollTop = 1e9;
}
async function getSample() { try { return (window.claude && claude.use) ? await claude.use('sample') : null; } catch (e) { return null; } }
function articleContext(a) {
  const notes = S.notes.filter(n => n.a === a.id).map(n => '- ' + n.text).join('\n') || '(none yet)';
  return `Article: "${a.title}" (${a.source}${a.date ? ', ' + a.date : ''}).\nSummary you have: ${a.summary}\nWhy it was picked for Snow: ${a.why}\nSnow's notes on it:\n${notes}`;
}
const WILA = `You are Wila, the warm, plain-spoken companion who runs Snow's Agent House. Snow is an AI-focused product manager in Toronto building toward a solo product at $10K MRR. Talk like a smart friend: short sentences, no jargon unless Snow uses it, under 120 words, no lists unless asked. You only have the summary below, not the full article: say so plainly if asked for detail beyond it, and suggest she open the link. Be honest when you disagree.`;
let chatBusy = false;
$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault(); if (chatBusy) return;
  const q = $('#chatIn').value.trim(); if (!q) return;
  const a = feed.articles.find(x => x.id === openArticle);
  const sample = await getSample();
  if (!sample) { $('#chatNote').textContent = "Wila can't reach this page yet. Chat works once the page is allowed to ask Claude."; return; }
  chat.push({ role: 'user', content: q }); $('#chatIn').value = ''; chat.push({ role: 'assistant', content: '…' }); renderChat();
  chatBusy = true;
  const msgs = chat.slice(0, -1).map((m, i) => ({ role: m.role, content: i === 0 ? WILA + '\n\n' + articleContext(a) + '\n\nSnow says: ' + m.content : m.content }));
  try {
    const res = await sample(msgs, { cache: false, modelTier: 'default', onText: ({ text }) => { chat[chat.length - 1].content = text; renderChat(); } });
    chat[chat.length - 1].content = res.text || chat[chat.length - 1].content;
    if (!S.days.includes(dayKey())) { touchDay(); save(); }
  } catch (err) {
    chat[chat.length - 1].content = err && err.code === 'rate_limited' ? "I need a short breather. Try again in a minute." : "I couldn't answer just now.";
    if (err && err.code === 'not_granted') $('#chatNote').textContent = 'Chat needs permission to ask Claude on this page.';
  }
  chatBusy = false; renderChat();
});
$('#mapAsk').addEventListener('click', async () => {
  const sample = await getSample();
  if (!sample) { $('#mapRead').textContent = "Wila can't reach this page yet."; return; }
  const T = themeScores(); const read = feed.articles.filter(a => S.read[a.id]);
  if (!read.length && !S.notes.length) { $('#mapRead').textContent = 'Read or note something first, then I can tell you what connects it.'; return; }
  const unread = feed.articles.filter(a => !S.read[a.id]).map(a => a.title);
  $('#mapAsk').disabled = true; $('#mapRead').textContent = 'Thinking…';
  const prompt = `${WILA}\n\nIn three short sentences, tell Snow what connects the themes she has been reading and noting, then suggest exactly one next read from her unread list by its title.\n\nThemes (reads/notes): ${T.map(t => `${t.name} ${t.reads}/${t.notes}`).join('; ')}\nRead: ${read.map(a => a.title).join(' | ') || 'none'}\nNotes: ${S.notes.map(n => n.text).join(' | ') || 'none'}\nUnread: ${unread.join(' | ') || 'none'}`;
  try { const r = await sample(prompt, { modelTier: 'quick', onText: ({ text }) => { $('#mapRead').textContent = text; } }); $('#mapRead').textContent = r.text; }
  catch (err) { $('#mapRead').textContent = err && err.code === 'rate_limited' ? 'Give me a minute and ask again.' : "I couldn't read the map just now."; }
  $('#mapAsk').disabled = false;
});

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
renderRoom();
route();
fetch('feed.json').then(r => r.json()).then(d => { feed = d; feed.themes = d.themes || []; renderAll(); }).catch(() => { renderAll(); });
connectStore();
}
