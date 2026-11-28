// The Desk in the browser. Ported from prototype/app.js, dressed in Lotus (docs/design/lotus).
// Snow's reads, saves, folders, notes, XP and badges live on the local server
// (GET and PUT /api/state); the edition comes from GET /api/feed.
import {
  GET_TIMEOUT, PHASE_LABEL, WEEK_GOAL, BADGES, articlesFor, autoPhase, awardText, blank, cnt, createStateClient, dayKey, esc, fmtDate, fmtDay,
  freshBadges, level as levelFor, mentorLine, moon, moonPath, readsThisWeek as readsSince, safeUrl,
  MAX_FOLDERS, MAX_NOTES, feedOps, own, readArticle, streak as streakOf, themeScores as scoresFor, timeoutSignal, uid, wilaLine,
} from './lib.js';
import { createNewsPage } from './news.js';
import { createRefresher, readSignals, tvLook } from './tv-lib.js';

/* ================= constants ================= */
const FEED_URL = '/api/feed';
// Object hotspots, in % of the painted room. `go` opens a desk's page; later desks show their place in the build order.
const OBJECTS = [
  { id: 'books', name: 'Bookstore', l: 90, t: 2, w: 10, h: 88, desk: 11, tagIn: true },
  { id: 'workout', name: 'Workout Coach', l: 84.5, t: 63, w: 10.5, h: 30, desk: 4 },
  { id: 'sched', name: 'Scheduler', l: 72, t: 12, w: 15, h: 31, desk: 5 },
  { id: 'news', name: 'News', l: 71.5, t: 46, w: 9.5, h: 13, go: 'news' },
  { id: 'lang', name: 'Language', l: 81, t: 48, w: 8.5, h: 13, desk: 4.5 },
  { id: 'games', name: 'Games', l: 69.5, t: 75, w: 14.5, h: 9, desk: 3 },
  { id: 'astro', name: 'Astrology · Cycle Sync', l: 52.5, t: 30.5, w: 5.5, h: 14, desk: 7 },
  { id: 'opps', name: 'Opportunities', l: 22, t: 15.5, w: 5.6, h: 14.5, lock: 6 },
  { id: 'typewriter', name: 'Typewriter', l: 17, t: 55, w: 13, h: 13, desk: 10 },
  { id: 'projects', name: 'Projects', l: 36.5, t: 40.5, w: 17, h: 11, lock: 9 },
  { id: 'feed', name: 'Product Feed', l: 39, t: 52, w: 12, h: 15, go: 'feed' }
];

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
// Inline stroke icons (Lotus: 1.8 stroke, round caps, on 22px). Static markup, never agent text.
const icon = paths => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
const ICON = {
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  chevron: icon('<path d="M7 10l5 5 5-5"/>'),
  note: icon('<path d="M5 4h10l4 4v12H5z"/><path d="M8 12h8M8 16h5"/>'),
  pencil: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  trash: icon('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/>'),
  star: icon('<path d="M12 3l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.6 6.7 19.5l1.1-6L3.4 9.3l6-.8z"/>'),
  // On air: the TV's breaking mark.
  onAir: icon('<circle cx="12" cy="12" r="1.6"/><path d="M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.8 5.8a8.8 8.8 0 0 0 0 12.4M18.2 5.8a8.8 8.8 0 0 1 0 12.4"/>'),
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Re-rendering a list replaces its buttons; put the keyboard focus back where it was.
function refocus(selector, fallback) {
  const el = (selector && document.querySelector(selector)) || (fallback && document.querySelector(fallback));
  if (el) el.focus({ preventScroll: true });
}
const attrSel = (name, value) => `[${name}="${CSS.escape(String(value))}"]`;

/* ================= state + saving ================= */
let S = blank();
let feed = { articles: [], themes: [] };
// Nothing that depends on Snow's state is drawn until the first GET /api/state has finished,
// and the store won't save unless that GET worked, so a blank state never overwrites hers.
let ready = false;
// Snow keeps The Desk open in more than one place. The server merges every save into the file as it
// is now (awarded, badges and days as unions; server/state-store.js), and XP is sent as a counter:
// each save carries the XP last synced, so the server adds only this tab's own XP to the latest total.
const store = createStateClient({
  getState: () => S,
  counters: ['xp'],
  onSaveFail: () => toast("I couldn't save that just now. I'll keep it here and keep trying."),
  // A 413 isn't retried: the same state would be refused again. The next change tries once more.
  onTooLarge: () => toast("Your saved reads and notes have reached The Desk's 1 MB limit, so this change isn't saved. Deleting a few long notes makes room."),
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
// Another tab may have changed things since this one loaded: pick up the saved state when nothing
// here is waiting to be saved. reload hands it over only in that case, checked in the same instant,
// so a change made while the GET was out is never thrown away. If the first load failed (the server
// was down as the page opened), catchUp loads it now instead, so the page stops working from a blank
// state. Returns whether anything changed.
// Called when the feed or News opens, when the tab comes back into view or focus, and before paying.
async function reloadState() {
  if (!ready) return false;
  const before = JSON.stringify(S);
  await store.catchUp((fresh) => { S = fresh; });
  return JSON.stringify(S) !== before;
}
// Redraw the feed without losing the keyboard's place (the buttons are drawn again).
function keepFocus(draw) {
  const a = document.activeElement;
  const key = a && a.dataset && ['read', 'notes', 'shelf', 'edit', 'del'].find(k => a.dataset[k] !== undefined);
  draw();
  if (key && !document.contains(a)) refocus(attrSel('data-' + key, a.dataset[key]));
}
// A tab can't be clicked before it is shown or focused: catch it up first, so a tab that sat in the
// background acts on the latest reads, folders, notes and XP, and the TV shows the latest edition and
// breaking story. One round: Product Feed's state (not while a folder is being renamed or the notes
// drawer is open: nothing there should move under Snow's hands), News's state, and, unless the Product
// Feed is showing, the edition and breaking story (the room's TV and the News page show them); then
// one redraw of what's showing (news.refresh redraws the News page itself). One round at a time
// (createRefresher): a tab return fires visibilitychange and focus, and the second shares the first;
// opening the room starts a fresh round (force) and the older round's answer is dropped. news.js and
// the state client also use only the newest answer when fetches overlap, so a slow old answer can't
// bring back a mark Snow just cleared. A state whose first load failed is loaded again (catchUp), and
// an empty Product Feed edition fetched again, so a page opened while the server was down recovers.
const busy = () => editing !== null || !$('#drawer').hidden;
async function catchUpRound() {
  const [feedChanged, , gotFeed] = await Promise.all([
    busy() ? false : reloadState(),
    $('#feed').hidden ? news.refresh({ xp: false }) : news.sync(),
    feed.articles.length ? false : loadFeed(),
  ]);
  if (store.missed || news.missed()) retryWhenIdle();
  return feedChanged || gotFeed;
}
// Checked again at drawing time: a rename or the notes drawer may have started while the round was
// out. Skipping is enough, as finishing the rename and closing the drawer both redraw the feed.
function drawCaughtUp(feedChanged) {
  if (!$('#feed').hidden) { if (feedChanged && !busy()) keepFocus(renderFeed); }
  else if (!$('#room').hidden) renderRoom();
}
// A reload skipped or dropped because Snow changed something meanwhile (the state client's `missed`):
// one more round once both states have nothing waiting to be saved. A fresh one (force): the round
// that queued this may still be finishing, and asking without force would only get that round back.
let retryQueued = false;
function retryWhenIdle() {
  if (retryQueued) return;
  retryQueued = true;
  Promise.all([store.whenIdle(), news.whenIdle()]).then(() => { retryQueued = false; if (ready) catchUp({ force: true }); });
}
const catchUp = createRefresher(catchUpRound, drawCaughtUp);
function syncTab() { if (ready) catchUp(); }
// The Product Feed's edition. Returns whether it has articles (a catch-up round fetches it again while it has none).
async function loadFeed() {
  try {
    const r = await fetch(FEED_URL, { cache: 'no-store', signal: timeoutSignal(GET_TIMEOUT) });
    if (!r.ok) throw new Error('feed ' + r.status);
    const d = await r.json();
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('feed is not an object');
    feed = { ...d, articles: Array.isArray(d.articles) ? d.articles : [], themes: Array.isArray(d.themes) ? d.themes : [] };
  } catch (e) { feed = { articles: [], themes: [] }; }
  return feed.articles.length > 0;
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
// The TV (News) also has a screen that can glow and a breaking mark (N5). Its tag has a full label and a
// short one for touch screens, where every tag shows at once (style.css picks). The mark comes after the
// tag, so the tag's soft shadow falls behind the mark instead of dimming its icon.
const TV_SCREEN = '<span class="screen" aria-hidden="true"></span>';
const TV_TAG = '<span class="tfull"></span><span class="tshort"></span>';
const TV_MARK = `<span class="bmark" aria-hidden="true">${ICON.onAir}</span>`;
function buildHotspots() {
  $('#hotspots').innerHTML = OBJECTS.map(o =>
    `<button class="hs${o.id === 'news' ? ' tv' : ''}" data-id="${o.id}" style="left:${o.l}%;top:${o.t}%;width:${o.w}%;height:${o.h}%" aria-label="${esc(o.name)}">
      <span class="glow"></span>${o.id === 'news' ? TV_SCREEN : ''}<span class="tag" ${o.tagIn ? 'style="bottom:auto;top:6%"' : ''}>${o.id === 'news' ? TV_TAG : ''}</span>${o.id === 'news' ? TV_MARK : ''}</button>`).join('');
  $('#hotspots').addEventListener('click', e => {
    const b = e.target.closest('.hs'); if (!b) return;
    const o = OBJECTS.find(x => x.id === b.dataset.id);
    if (o.go) return openDesk(o.go);
    if (!ready) return;
    if (o.lock && level() < o.lock) return toast(`${o.name} unlocks at level ${o.lock}. You're level ${level()}, so keep going.`);
    toast(`${o.name} is desk ${o.desk} in the build order. It opens once it's built.`);
  });
}
// The light, the date and the moon don't depend on Snow's state, so they show straight away.
// The blurred study behind every page follows the same light.
function renderScene() {
  const p = phase();
  document.querySelectorAll('.plate, .bd').forEach(el => el.classList.toggle('on', el.dataset.phase === p));
  $('#backdrop').dataset.phase = p;
  const now = new Date();
  $('#when').textContent = now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + PHASE_LABEL[p] + (preview ? ' (preview)' : ' in Toronto');
  const m = moon(now);
  $('#moonChip').innerHTML = `<svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true"><circle class="moon-lit" cx="50" cy="50" r="40"/><path class="moon-dark" d="${moonPath(m.age)}"/></svg>${esc(m.name)}`;
  $('#phaseName').textContent = preview ? PHASE_LABEL[preview] : 'auto';
  return p;
}
function renderRoom() {
  const p = renderScene();
  if (!ready) return;
  const unread = feed.articles.filter(a => !own(S.read, a.id)).length;
  // The TV: its screen glows while today's top stories are unread; a rosy mark while a breaking story waits.
  const tv = tvLook(readSignals(news.signals));
  OBJECTS.forEach(o => {
    const b = document.querySelector(`.hs[data-id="${o.id}"]`); if (!b) return;
    const tag = b.querySelector('.tag');
    const locked = o.lock && level() < o.lock;
    const isFeed = o.go === 'feed';
    const isTv = o.id === 'news';
    b.classList.toggle('locked', !!locked);
    b.classList.toggle('new', isFeed && unread > 0);
    b.classList.toggle('tv-on', isTv && tv.on);
    b.classList.toggle('tv-breaking', isTv && tv.breaking);
    // The tag is also the button's name, so what it says (3 new, breaking story) reaches screen readers.
    const label = isFeed ? (unread ? `${o.name} · ${unread} new` : o.name) : isTv ? tv.tag : locked ? `${o.name} · level ${o.lock}` : o.name;
    if (isTv) { tag.querySelector('.tfull').textContent = tv.tag; tag.querySelector('.tshort').textContent = tv.short; }
    else tag.textContent = label;
    b.setAttribute('aria-label', label);
    let badge = b.querySelector('.badge');
    if (isFeed && unread) { if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; b.appendChild(badge); } badge.textContent = unread; }
    else if (badge) badge.remove();
  });
  const st = streak();
  $('#streakChip').textContent = st ? `Streak · ${st} day${st > 1 ? 's' : ''}` : 'Start a streak today';
  $('#lvlText').textContent = 'Level ' + level();
  $('#lvlFill').style.width = (S.xp % 100) + '%';
  $('#wilaLine').textContent = wilaLine(p, unread, feed.articles.length > 0);
}

/* ================= navigation ================= */
// The room zooms into the desk's object (the laptop, the TV), then the page opens.
function openDesk(desk) { $('#frame').dataset.zoom = desk; $('#frame').classList.add('zoom'); setTimeout(() => { location.hash = desk; }, 750); }
const openFeed = () => openDesk('feed');
const DESK_VIEWS = { '#feed': 'feed', '#news': 'news' };
function route() {
  const view = DESK_VIEWS[location.hash] || 'room';
  $('#feed').hidden = view !== 'feed'; $('#news').hidden = view !== 'news'; $('#room').hidden = view !== 'room';
  $('#backdrop').dataset.view = view;
  // The drawer lives outside the feed (so it stays pinned to the screen): close it when leaving.
  if (view !== 'feed') { $('#drawer').hidden = true; $('#scrim').hidden = true; setBehindDrawer(false); }
  if (view === 'feed') {
    renderScene(); window.scrollTo(0, 0);
    if (ready) { renderFeed(); reloadState().then(changed => { if (changed && !$('#feed').hidden) keepFocus(renderFeed); }); }
  }
  else if (view === 'news') { renderScene(); news.render(); news.refresh(); window.scrollTo(0, 0); }
  // Back in the room: what was read or dismissed shows at once, then a fresh catch-up round fetches the
  // edition and breaking story again (a new morning edition, a new breaking story) and the TV redraws.
  // A failed fetch keeps what was there; the room redraws either way.
  else { requestAnimationFrame(() => requestAnimationFrame(() => $('#frame').classList.remove('zoom'))); renderRoom(); if (ready) catchUp({ force: true }); }
}

/* ================= the feed ================= */
let shelf = 'all', editing = null, confirming = null, openArticle = null;
const noteTime = ts => new Date(ts).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function renderShelves() {
  const base = [['all', 'Everything', feed.articles.length], ['unread', 'Unread', listFor('unread').length], ['saved', 'Saved', listFor('saved').length], ['notes', 'My notes', S.notes.length]];
  let h = base.map(([k, n, c]) => `<li class="shelf base ${shelf === k ? 'on' : ''}"><button class="s" data-shelf="${k}" ${shelf === k ? 'aria-current="true"' : ''}><span class="nm">${n}</span><span class="n">${c}</span></button></li>`).join('');
  h += `<li class="shelfsep">Folders</li>`;
  if (!S.folders.length) h += `<li class="shelfnone">No folders yet</li>`;
  h += S.folders.map(f => {
    const k = 'f:' + f.id;
    if (editing === f.id) return `<li class="shelf folder"><input data-rename="${esc(f.id)}" value="${esc(f.name)}" maxlength="40" aria-label="Folder name"></li>`;
    if (confirming === f.id) return `<li class="shelf folder confirm"><span class="q">Delete “${esc(f.name)}”?</span><button class="yes" data-del-yes="${esc(f.id)}" aria-label="Yes, delete ${esc(f.name)}">Delete</button><button class="no" data-del-no aria-label="Keep ${esc(f.name)}">Keep</button></li>`;
    return `<li class="shelf folder ${shelf === k ? 'on' : ''}"><button class="s" data-shelf="${esc(k)}" title="${esc(f.name)}" ${shelf === k ? 'aria-current="true"' : ''}><span class="nm">${esc(f.name)}</span><span class="n">${listFor(k).length}</span></button><button class="mini" data-edit="${esc(f.id)}" aria-label="Rename ${esc(f.name)}" title="Rename">${ICON.pencil}</button><button class="mini" data-del="${esc(f.id)}" aria-label="Delete ${esc(f.name)}" title="Delete">${ICON.trash}</button></li>`;
  }).join('');
  $('#shelfList').innerHTML = h;
  const inp = document.querySelector('[data-rename]'); if (inp) { inp.focus(); inp.select(); }
}
function shelfTitle() {
  if (shelf.startsWith('f:')) { const f = S.folders.find(x => 'f:' + x.id === shelf); return f ? f.name : 'Folder'; }
  return { all: "Today's edition", unread: 'Unread', saved: 'Saved', notes: 'My notes' }[shelf];
}
// The empty messages, with their first sentence as a soft heading.
const emptyCard = text => { const i = text.indexOf('. '); return `<div class="empty-state frost"><p>${i > 0 ? `<strong>${esc(text.slice(0, i + 1))}</strong> ${esc(text.slice(i + 2))}` : esc(text)}</p></div>`; };
function renderList() {
  const sample = feed.sample === true ? '<span>Sample picks from real articles</span>' : '';
  const head = `<div class="listhead glass"><h2 id="listTitle" tabindex="-1">${esc(shelfTitle())}</h2>${sample}</div>`;
  if (shelf === 'notes') {
    const notes = [...S.notes].sort((a, b) => b.ts - a.ts);
    $('#list').innerHTML = head + (notes.length ? notes.map(n => {
      const a = feed.articles.find(x => x.id === n.a);
      return `<article class="notecard frost"><div class="on"><span>${esc(noteTime(n.ts))} · on</span><button data-notes="${esc(n.a)}">${esc(a ? a.title : 'an article')}</button></div><p>${esc(n.text)}</p></article>`;
    }).join('') : emptyCard("No notes yet. Open any article's Notes to jot down what stuck with you."));
    return;
  }
  const list = listFor(shelf);
  if (!list.length) { $('#list').innerHTML = head + emptyCard(shelf === 'unread' ? 'All read. Your feed agent brings new picks every morning.' : 'Nothing here yet. Use Save on any article to file it.'); return; }
  $('#list').innerHTML = head + list.map(a => {
    const read = !!own(S.read, a.id); const inF = own(S.saved, a.id) || []; const nn = S.notes.filter(n => n.a === a.id).length;
    const url = safeUrl(a.url);
    const meta = [a.source, a.author, a.date ? fmtDate(a.date) : ''].filter(Boolean).map(esc).join(' · ');
    const tags = (a.themes || []).map(t => { const th = feed.themes.find(x => x.id === t); return `<span class="tagchip">${esc(th ? th.name : t)}</span>`; }).join('');
    const menu = S.folders.length ? S.folders.map(f => `<label><input type="checkbox" data-save="${esc(a.id)}" value="${esc(f.id)}" ${inF.includes(f.id) ? 'checked' : ''}>${esc(f.name)}</label>`).join('') : `<div class="empty">Make a folder in Shelves first.</div>`;
    return `<article class="art frost ${read ? 'read' : ''}" data-id="${esc(a.id)}">
      <p class="meta">${meta}</p>
      <h3>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(a.title)}<span class="sr"> (opens in a new tab)</span></a>` : esc(a.title)}</h3>
      <p class="sum">${esc(a.summary)}</p>
      ${tags ? `<div class="tags">${tags}</div>` : ''}
      <div class="why"><p class="lbl">Why for you</p><p class="wt">${esc(a.why)}</p></div>
      <div class="arow">
        <button class="ab readbtn ${read ? 'on' : ''}" data-read="${esc(a.id)}" aria-pressed="${read}">${read ? ICON.check + 'Read' : 'Mark as read'}</button>
        <details class="savebox"><summary class="ab ${inF.length ? 'on' : ''}" role="button"><span class="slbl">${inF.length ? 'Saved' : 'Save'}</span>${ICON.chevron}</summary><div class="menu">${menu}</div></details>
        <button class="ab" data-notes="${esc(a.id)}">${ICON.note}Notes${nn ? ' (' + nn + ')' : ''}</button>
        ${a.minutes ? `<span class="mins">${esc(a.minutes)} min</span>` : ''}
      </div></article>`;
  }).join('');
}
const RING = 2 * Math.PI * 18;
function renderStats() {
  const w = readsThisWeek(); const shown = Math.min(w, WEEK_GOAL);
  const fill = $('#ringFill');
  fill.setAttribute('stroke-dasharray', `${(RING * shown / WEEK_GOAL).toFixed(1)} ${RING.toFixed(1)}`);
  fill.classList.toggle('none', !shown);
  $('#ringText').textContent = `${w}/${WEEK_GOAL}`;
  $('#weekRing').setAttribute('aria-label', `${w} of ${WEEK_GOAL} reads this week`);
  $('#xpText').textContent = S.xp + ' XP';
  $('#lvlText2').textContent = 'Level ' + level() + ' · ' + (100 - S.xp % 100) + ' XP to next';
  const ed = fmtDay(feed.edition);
  $('#fsub').textContent = 'Product, AI and PM · picked for your goals' + (ed ? ' · Edition of ' + ed : '');
  $('#mentorLine').textContent = mentorLine(feed, S);
}
function renderBadges() {
  $('#badges').innerHTML = BADGES.map(b => { const got = !!S.badges[b.id]; return `<li class="${got ? 'got' : ''}"><span class="bic">${ICON.star}</span><span class="bt"><b>${esc(b.name)}</b><span class="how">${esc(b.how)}</span><span class="sr">${got ? 'Earned' : 'Not earned yet'}</span></span></li>`; }).join('');
  $('#badgeCount').textContent = `${cnt(S.badges)} of ${BADGES.length}`;
}
// The rail fills the section you're on: Today's edition (Everything) or My notes.
function renderRail() {
  document.querySelectorAll('#rail [data-go]').forEach(b => {
    if (b.dataset.go === shelf) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
}
// The theme map: you in the middle, the edition's themes around you. A theme starts as a dashed
// outline, fills with moss as you read its picks, and grows with reads, notes and saves.
const mapSvg = $('#mapSvg');
function drawMap() {
  if (!ready) return;
  const W = mapSvg.clientWidth, H = mapSvg.clientHeight; if (!W || !H) return;
  const T = themeScores(); const cx = W / 2, cy = H / 2, rx = Math.max(40, W / 2 - 54), ry = Math.max(40, H / 2 - 46);
  const pos = {}; T.forEach((t, i) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / T.length; pos[t.id] = [cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]; });
  const links = {};
  feed.articles.filter(a => own(S.read, a.id) && Array.isArray(a.themes) && a.themes.length > 1).forEach(a => {
    for (let i = 0; i < a.themes.length; i++) for (let j = i + 1; j < a.themes.length; j++) { const k = [a.themes[i], a.themes[j]].sort().join('|'); links[k] = (links[k] || 0) + 1; }
  });
  const f1 = v => v.toFixed(1);
  let g = '';
  T.forEach(t => { const [x, y] = pos[t.id]; g += `<line class="spoke ${t.score > 0 ? 'lit' : ''}" x1="${f1(cx)}" y1="${f1(cy)}" x2="${f1(x)}" y2="${f1(y)}"/>`; });
  Object.entries(links).forEach(([k, n]) => { const [a, b] = k.split('|'); if (pos[a] && pos[b]) g += `<line class="link" x1="${f1(pos[a][0])}" y1="${f1(pos[a][1])}" x2="${f1(pos[b][0])}" y2="${f1(pos[b][1])}" stroke-width="${1 + n}"/>`; });
  g += `<circle class="you-ring" cx="${f1(cx)}" cy="${f1(cy)}" r="24"/><circle class="you" cx="${f1(cx)}" cy="${f1(cy)}" r="16"/><text class="you-label" x="${f1(cx)}" y="${f1(cy + 40)}" text-anchor="middle">you</text>`;
  T.forEach((t, i) => {
    const [x, y] = pos[t.id]; const r = 9 + Math.min(16, t.score * 4); const full = t.total ? t.reads / t.total : 0;
    const name = String(t.name ?? ''); const label = W < 300 ? name.replace(/^The /, '') : name;
    const ly = y > cy + 1 ? y + r + 14 : y - r - 7;
    const fill = full > 0 ? `<rect class="node-fill" clip-path="url(#tm${i})" x="${f1(x - r)}" y="${f1(y + r - 2 * r * full)}" width="${f1(2 * r)}" height="${f1(2 * r * full)}"/>` : '';
    g += `<g class="node ${t.score > 0 ? 'touched' : ''}"><clipPath id="tm${i}"><circle cx="${f1(x)}" cy="${f1(y)}" r="${r}"/></clipPath>
      <circle class="node-bg" cx="${f1(x)}" cy="${f1(y)}" r="${r}"/>${fill}<circle class="node-ring" cx="${f1(x)}" cy="${f1(y)}" r="${r}"/>
      <text x="${f1(x)}" y="${f1(ly)}" text-anchor="middle">${esc(label)}${t.reads ? `<tspan class="cnt"> ${t.reads}/${t.total}</tspan>` : ''}</text></g>`;
  });
  mapSvg.innerHTML = g;
  mapSvg.setAttribute('aria-label', T.length ? 'Theme map. ' + T.map(t => `${String(t.name ?? '')}: ${t.reads} of ${t.total} read`).join('. ') + '.' : 'Theme map: no themes yet.');
}
const mapRO = new ResizeObserver(drawMap); mapRO.observe(mapSvg);
function renderFeed() { renderShelves(); renderList(); renderStats(); renderBadges(); renderRail(); drawMap(); }
function renderAll() { renderRoom(); if (!$('#feed').hidden) renderFeed(); if (!$('#news').hidden) news.render(); }

/* ================= feed actions ================= */
function pickShelf(k) { shelf = k; editing = confirming = null; renderShelves(); renderList(); renderRail(); }
$('#shelfList').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.shelf) { pickShelf(t.dataset.shelf); refocus(attrSel('data-shelf', shelf)); }
  else if (t.dataset.edit) { editing = t.dataset.edit; confirming = null; renderShelves(); }
  else if (t.dataset.del) { confirming = t.dataset.del; editing = null; renderShelves(); refocus('[data-del-no]'); }
  else if (t.dataset.delYes) {
    // Every change to notes, folders, saved items and reads goes through feedOps, which tells the
    // state client what changed: the server merges by item, so a delete must be said out loud.
    const undo = feedOps.deleteFolder(S, store, t.dataset.delYes); if (!undo) return;
    const f = undo.folder;
    if (shelf === 'f:' + f.id) shelf = 'all';
    confirming = null; save(); renderFeed(); refocus('#folderName');
    toast(`Deleted “${f.name}”.`, 'Undo', () => { feedOps.restoreFolder(S, store, undo); save(); renderFeed(); });
  } else if ('delNo' in t.dataset) { const id = confirming; confirming = null; renderShelves(); refocus(attrSel('data-del', id)); }
});
function finishRename(inp, keep) {
  const id = inp.dataset.rename;
  const f = S.folders.find(x => x.id === id); const v = inp.value.trim();
  if (keep && f && v && feedOps.renameFolder(S, store, id, v)) save();
  editing = null; renderFeed(); refocus(attrSel('data-edit', id));
}
// Enter or Escape ends a rename. finishRename moves focus to the pencil button during this key press,
// so the key's default action is cancelled: otherwise the same Enter presses the pencil and reopens the box.
$('#shelfList').addEventListener('keydown', e => {
  const inp = e.target.closest('[data-rename]'); if (!inp) return;
  if (e.key === 'Enter') { e.preventDefault(); finishRename(inp, true); }
  else if (e.key === 'Escape') { e.preventDefault(); finishRename(inp, false); }
});
$('#shelfList').addEventListener('focusout', e => { const inp = e.target.closest('[data-rename]'); if (inp && editing) finishRename(inp, true); });
$('#folderForm').addEventListener('submit', e => {
  e.preventDefault(); if (!ready) return;
  const v = $('#folderName').value.trim(); if (!v) return;
  const first = !S.folders.length;
  if (!feedOps.addFolder(S, store, { id: uid(), name: v })) return toast(`You've reached ${MAX_FOLDERS} folders. Delete one to make room.`);
  $('#folderName').value = '';
  first ? award(5, 'folder made') : save();
  renderFeed();
});
// Pays once per article, ever: un-marking and re-marking doesn't pay again. Before paying it checks
// the server's copy (another tab may have paid already) and reloads the state if nothing is waiting
// to be saved, so the XP goes onto the latest total. Clicks made while a check is out are queued.
let reads = Promise.resolve();
async function readOne(id) {
  const wasRead = !!own(S.read, id);
  const r = await readArticle(() => S, id, { canPay: store.canSave, peek: () => store.peek(), also: reloadState });
  feedOps.read(store, id, r.read, wasRead);
  if (r.award) award(10, 'article read'); else save();
  renderFeed(); refocus(attrSel('data-read', id), '#listTitle');
}
$('#list').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.read) { const id = t.dataset.read; reads = reads.then(() => readOne(id)).catch(() => {}); }
  else if (t.dataset.notes) openDrawer(t.dataset.notes);
});
$('#list').addEventListener('change', async e => {
  const c = e.target.closest('[data-save]'); if (!c) return;
  const a = c.dataset.save; const f = c.value; const on = c.checked;
  // An article's first folder pays 5 XP: catch up first, so a tab that hasn't seen a folder deleted
  // elsewhere doesn't pay for saving into it.
  if (on && !(own(S.saved, a) || []).length) await reloadState();
  if (on && !S.folders.some(x => x.id === f)) { renderFeed(); return toast('That folder was deleted in another tab.'); }
  const wasSaved = (own(S.saved, a) || []).length > 0;
  const size = feedOps.setSaved(S, store, a, f, on);
  (!wasSaved && size) ? award(5, 'saved to a folder') : save();
  const open = c.closest('details'); renderShelves(); renderStats(); renderBadges(); drawMap();
  const sum = open && open.querySelector('summary');
  if (sum) { sum.querySelector('.slbl').textContent = size ? 'Saved' : 'Save'; sum.classList.toggle('on', size > 0); }
});
document.addEventListener('click', e => { document.querySelectorAll('details.savebox[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }); });
// Escape closes an open Save menu and returns to its button.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const d = e.target.closest && e.target.closest('details.savebox[open]');
  if (d) { d.open = false; d.querySelector('summary').focus(); }
});

/* ================= the rail ================= */
function jumpTo(target, heading) {
  target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  heading.focus({ preventScroll: true });
}
$('#rail').addEventListener('click', e => {
  const b = e.target.closest('[data-go]'); if (!b || !ready) return;
  const go = b.dataset.go;
  if (go === 'all' || go === 'notes') {
    pickShelf(go);
    const top = $('#list').getBoundingClientRect().top;
    if (top < 0 || top > innerHeight * 0.6) jumpTo($('#list'), $('#listTitle')); else $('#listTitle').focus({ preventScroll: true });
  } else if (go === 'map') jumpTo($('#mapCard'), $('#mapTitle'));
  else if (go === 'badges') jumpTo($('#badgeCard'), $('#badgeTitle'));
});

/* ================= drawer: notes ================= */
// The chat with Wila (the drawer's second tab) comes back with S6.
function openDrawer(id) {
  const a = feed.articles.find(x => x.id === id); if (!a) return;
  openArticle = id;
  $('#dSrc').textContent = a.source + (a.date ? ' · ' + fmtDate(a.date) : '');
  $('#dTitle').textContent = a.title;
  $('#drawer').hidden = false; $('#scrim').hidden = false;
  setBehindDrawer(true);
  renderNotes();
  $('#noteText').focus({ preventScroll: true });
}
function closeDrawer() {
  $('#drawer').hidden = true; $('#scrim').hidden = true; setBehindDrawer(false); renderFeed();
  refocus(attrSel('data-notes', openArticle));
}
// While the drawer is open, the page behind the scrim can't be reached by mouse, keyboard or screen reader.
function setBehindDrawer(off) { $('#feed').inert = off; $('#room').inert = off; }
// Tab and Shift+Tab cycle through the drawer (and a toast's Undo, which lives outside it).
function drawerStops() {
  const inside = [...$('#drawer').querySelectorAll('button, textarea, input, a[href]')].filter(el => !el.disabled && el.getClientRects().length);
  const t = $('#toast');
  return t.classList.contains('on') ? [...inside, ...t.querySelectorAll('button')] : inside;
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || $('#drawer').hidden) return;
  const stops = drawerStops(); if (!stops.length) return;
  const i = stops.indexOf(document.activeElement);
  const wrap = e.shiftKey ? i <= 0 : (i < 0 || i === stops.length - 1);
  if (wrap) { e.preventDefault(); stops[e.shiftKey ? stops.length - 1 : 0].focus(); }
});
function renderNotes() {
  const list = S.notes.filter(n => n.a === openArticle).sort((a, b) => b.ts - a.ts);
  $('#noteList').innerHTML = list.length ? list.map(n => `<li><p>${esc(n.text)}</p><div class="nrow"><span>${esc(noteTime(n.ts))}</span><button data-dn="${esc(n.id)}">Delete</button></div></li>`).join('') : `<li class="none tiny">No notes on this one yet.</li>`;
}
$('#noteSave').addEventListener('click', () => {
  const v = $('#noteText').value.trim(); if (!v || !ready) return;
  if (!feedOps.addNote(S, store, { id: uid(), a: openArticle, text: v.slice(0, 4000), ts: Date.now() })) return toast(`You've reached ${MAX_NOTES} notes. Delete one to make room.`);
  $('#noteText').value = ''; award(15, 'note saved'); renderNotes();
});
$('#noteList').addEventListener('click', e => {
  const b = e.target.closest('[data-dn]'); if (!b) return;
  const gone = feedOps.deleteNote(S, store, b.dataset.dn); if (!gone) return;
  save(); renderNotes(); $('#noteText').focus({ preventScroll: true });
  toast('Note deleted.', 'Undo', () => undoNoteDelete(gone));
});
// Where the keyboard was before it went to the toast: an Undo returns there, not to the fading button.
let focusBeforeToast = null;
document.addEventListener('focusin', e => { if (!(e.target.closest && e.target.closest('#toast'))) focusBeforeToast = e.target; });
// Undo of a note delete. With the drawer open: its list again, and the note box. With it closed (Snow
// closed it before pressing Undo): the feed again, so "Notes (n)" and the My notes count include the
// note, and the keyboard goes back to where it was.
function undoNoteDelete(gone) {
  feedOps.restoreNote(S, store, gone); save();
  if (!$('#drawer').hidden) { renderNotes(); $('#noteText').focus({ preventScroll: true }); return; }
  const back = focusBeforeToast;
  const key = back && back.dataset && ['read', 'notes', 'shelf', 'edit', 'del'].find(k => back.dataset[k] !== undefined);
  renderFeed();
  if (key) refocus(attrSel('data-' + key, back.dataset[key]), '#listTitle');
  else if (back && document.contains(back) && back !== document.body) back.focus({ preventScroll: true });
  else refocus('#listTitle');
}
$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

/* ================= toasts ================= */
let toastTimer;
function toast(msg, actLabel, act) {
  const el = $('#toast');
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
// Leaving the tab (hidden, or the window losing focus): send what is waiting now rather than after
// the 600 ms delay, so the tab Snow switches to reads it when it catches up.
function sendNow() { if (!ready) return; store.flush(); news.flush(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncTab(); else sendNow(); });
window.addEventListener('focus', syncTab);
window.addEventListener('blur', sendNow);
setInterval(() => { if (!preview) renderRoom(); }, 60e3);

/* ================= the News desk ================= */
// Its page lives in news.js. Reading a story pays XP through the same award() as the feed, so XP,
// level and the streak stay in Product Feed's state.
const news = createNewsPage({ award, toast, isReady: () => ready, canAward: () => store.canSave, reloadXpState: reloadState });

/* ================= start ================= */
buildHotspots();
route();
// The backdrop changes light with a soft fade, but not on the first paint: opening the page shows the
// study straight away, so the caret stays the desk's one opening motion.
requestAnimationFrame(() => requestAnimationFrame(() => $('#backdrop').classList.add('settled')));
Promise.all([loadState(), loadFeed(), news.load()]).then(() => { ready = true; renderAll(); });
