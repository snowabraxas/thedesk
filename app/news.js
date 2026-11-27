// The News desk page (#news): today's edition from GET /api/news, a breaking banner from
// GET /api/breaking, and Snow's reads, dismissals and shelf in GET/PUT /api/news/state.
// The logic is in news-lib.js and the markup in news-html.js (both pure, both tested); this file
// fetches, keeps the state and wires the buttons. Agent text is set with textContent or through
// news-html.js, which escapes it.
// XP and the streak stay in Product Feed's state: reading a story calls app.js's award().
//
// Snow keeps The Desk open in more than one place (the Claude app's pane and a browser), and each
// save sends the whole state. So: the server merges every save into the file as it is now (the
// union of `awarded` and `dismissed`: server/state-store.js); opening #news, and the tab coming
// back into view or focus (sync, from app.js), reload both states when nothing is waiting to be
// saved; and before paying for a read, the server's `awarded` is checked, so another tab's payment
// for the same story counts. Mark read clicks made while a check is out wait their turn.
import { createStateClient } from './lib.js';
import {
  READ_XP, blankNewsState, breakingView, buildNewsView, dismissBreaking, editionLine, greeting, isBreakingVisible, newsLine,
  normalizeNewsState, readStory, tvSignals,
} from './news-lib.js';
import { breakingHtml, glanceHtml, noStoriesHtml, shelfItemHtml, storyCardHtml } from './news-html.js';

const NEWS_URL = '/api/news';
const BREAKING_URL = '/api/breaking';
const STATE_URL = '/api/news/state';

const $ = (s) => document.querySelector(s);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`GET ${url} answered ${r.status}`);
  return r.json();
}

/**
 * @param {{
 *   award: (xp: number, msg: string) => void,  app.js's award(): XP, the streak's day, badges, the toast
 *   toast: (msg: string, actLabel?: string, act?: () => void) => void,
 *   isReady: () => boolean,     everything (both desks' state, both editions) has loaded
 *   canAward: () => boolean,    Product Feed's state, where XP lives, can be saved
 *   reloadXpState: () => Promise<void>,  reload Product Feed's state (XP) if nothing is waiting to be saved
 * }} options
 */
export function createNewsPage({ award, toast, isReady, canAward, reloadXpState = async () => {} }) {
  let news = null; // the edition, or null when it couldn't be loaded
  let breaking = null; // today's breaking story, or null
  let N = blankNewsState();
  let view = buildNewsView(null, N);
  const openItems = new Set(); // shelf items opened in this visit ("m0"); not saved
  let reads = Promise.resolve(); // Mark read clicks, one after another (each may wait on a server check)

  // Nothing that depends on the News state is drawn until isReady() (its first GET has finished),
  // and the store never saves if that GET failed.
  const store = createStateClient({
    url: STATE_URL,
    normalize: normalizeNewsState,
    empty: blankNewsState,
    getState: () => N,
    onSaveFail: () => toast("I couldn't save that just now. I'll keep it here and keep trying."),
  });
  window.addEventListener('pagehide', () => store.flushOnExit());

  async function loadState() {
    const r = await store.load();
    N = r.state;
    if (!r.ok) toast("I couldn't open your saved News reads, so changes won't be saved for now. Try reloading in a bit.", 'Reload', () => location.reload());
  }
  // A failed fetch keeps what was already there (nothing, on the first load).
  async function loadEdition() {
    try {
      const d = await getJson(NEWS_URL);
      news = d && typeof d === 'object' && !Array.isArray(d) ? d : null;
    } catch {
      /* keep the edition we had */
    }
  }
  async function loadBreaking() {
    try {
      const d = await getJson(BREAKING_URL);
      breaking = d && typeof d === 'object' && d.breaking && typeof d.breaking === 'object' ? d.breaking : null;
    } catch {
      /* keep the breaking story we had */
    }
  }
  /** The first load: Snow's News state, the edition and the breaking story. */
  const load = () => Promise.all([loadState(), loadEdition(), loadBreaking()]);
  /**
   * Opening the page again (later in the day, or after using another tab): fetch the edition and
   * breaking story again, and both states when nothing is waiting to be saved, then redraw.
   */
  async function refresh() {
    if (!isReady()) return;
    const before = news?.edition;
    // reload hands over the fresh state only if nothing changed here while it was out (applyState).
    await Promise.all([store.reload(applyState), reloadXpState(), loadEdition(), loadBreaking()]);
    if (news?.edition !== before) openItems.clear(); // opened items are by position: a new edition starts closed
    if (!$('#news').hidden) render();
  }
  function applyState(fresh) {
    N = fresh;
  }
  /**
   * The tab came back into view or focus: reload the News state when nothing is waiting to be saved,
   * and redraw if it changed. Returns whether it changed.
   */
  async function sync() {
    if (!isReady()) return false;
    const before = JSON.stringify(N);
    await store.reload(applyState);
    const changed = JSON.stringify(N) !== before;
    if (changed && !$('#news').hidden) render();
    return changed;
  }

  /* ---------- drawing ---------- */

  // The story a button points at: "t0" is the first top story, "m3" the fourth on the shelf.
  function storyAt(ref) {
    const m = /^([tm])(\d)$/.exec(ref || '');
    return m ? (m[1] === 't' ? view.top : view.more)[Number(m[2])] || null : null;
  }

  function renderCapsule() {
    $('#newsDate').textContent = editionLine(view.edition);
    $('#newsSample').hidden = !view.sample;
    $('#newsLine').textContent = news ? newsLine(view) : 'Today’s edition hasn’t landed yet. I’ll tell you when it does.';
    $('#newsNote').hidden = !view.note;
    $('#newsNote').textContent = view.note ? `From the News desk: ${view.note}` : '';
    $('#newsProgress').hidden = !view.total;
    $('#newsProgressText').textContent = `${view.readCount} of ${view.total} read`;
    $('#newsProgressFill').style.width = view.total ? `${Math.round((view.readCount / view.total) * 100)}%` : '0';
  }

  function renderBreaking() {
    const box = $('#newsBreaking');
    const show = isBreakingVisible(breaking, N);
    box.innerHTML = show ? breakingHtml(breakingView(breaking)) : '';
    box.hidden = !show;
  }

  function renderStories() {
    const n = view.total;
    $('#newsTopTitle').textContent = n === 1 ? 'Today’s top story' : n ? `Today’s top ${n}` : 'Today’s top stories';
    $('#newsStories').innerHTML = n ? view.top.map(storyCardHtml).join('') : noStoriesHtml(!!news);
  }

  function renderShelf() {
    const more = view.more;
    $('#newsShelf').hidden = !more.length;
    $('#newsMoreCount').textContent = `· ${more.length} more today`;
    $('#newsMoreBtn').setAttribute('aria-expanded', String(N.shelfOpen));
    $('#newsMoreLabel').textContent = N.shelfOpen ? 'Close' : 'Open';
    $('#newsMoreList').hidden = !N.shelfOpen;
    $('#newsMoreList').innerHTML = more.map((s, i) => shelfItemHtml(s, i, openItems.has(`m${i}`))).join('');
  }

  function renderGlance() {
    const g = glanceHtml(view.glance);
    $('#newsGlance').innerHTML = g.numbers;
    $('#newsRegions').innerHTML = g.regions;
    $('#newsKinds').innerHTML = g.kinds;
    $('#newsRegionsHint').hidden = !view.glance.regions.length;
  }

  // The greeting doesn't depend on Snow's state, so it shows straight away; the rest waits for isReady().
  // Redrawing replaces the buttons: the keyboard focus goes back to the same one.
  function render() {
    $('#newsGreeting').textContent = greeting(new Date());
    if (!isReady()) return;
    const active = document.activeElement;
    const ref = active && $('#news').contains(active) ? active.dataset.read || active.dataset.item : '';
    const again = ref && /^[tm]\d$/.test(ref) ? `[data-${active.dataset.read ? 'read' : 'item'}="${ref}"]` : '';
    view = buildNewsView(news, N);
    renderCapsule();
    renderBreaking();
    renderStories();
    renderShelf();
    renderGlance();
    if (again && !$('#news').contains(document.activeElement)) ($(again) || $('#newsTopTitle')).focus({ preventScroll: true });
  }

  /* ---------- actions ---------- */

  // Clicks made while a pay check is out are queued, not dropped: each runs after the one before.
  function queueRead(ref) {
    reads = reads.then(() => markRead(ref)).catch(() => {});
    return reads;
  }

  async function markRead(ref) {
    const s = storyAt(ref);
    if (!s || !s.key) return;
    const { key } = s;
    const sample = view.sample;
    // Pay only for a real edition, and only when both states can be saved, so a story is never
    // paid twice after a reload. Before paying, readStory checks the server's copy (another tab may
    // have paid for it already) while the latest XP is picked up.
    const canPay = !sample && store.canSave && canAward();
    const r = await readStory(() => N, key, { canPay, peek: () => store.peek(), also: reloadXpState });
    // The server merges reads by item: a read is an addition, an un-mark a removal it passes on to every tab.
    store[r.read ? 'added' : 'removed']('read', key);
    store.save();
    if (r.award) award(READ_XP, 'story read');
    else if (r.read && sample) toast('Sample story: marked read, no XP.');
    render();
  }

  function toggleShelf() {
    N.shelfOpen = !N.shelfOpen;
    store.save();
    render();
  }

  function toggleItem(ref) {
    if (!storyAt(ref)) return;
    if (openItems.has(ref)) openItems.delete(ref);
    else openItems.add(ref);
    render();
  }

  function dismiss() {
    if (breaking && dismissBreaking(N, breaking.at)) store.save();
    render();
    $('#newsTopTitle').focus({ preventScroll: true });
  }

  $('#news').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isReady()) return;
    if (b.dataset.read) queueRead(b.dataset.read);
    else if (b.dataset.item) toggleItem(b.dataset.item);
    else if (b.id === 'newsMoreBtn') toggleShelf();
    else if (b.id === 'newsDismiss') dismiss();
    else if (b.dataset.newsGo === 'top') {
      $('#newsTopTitle').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      $('#newsTopTitle').focus({ preventScroll: true });
    }
  });

  return {
    load,
    refresh,
    sync,
    /** Sends what is waiting now (the tab is being left). */
    flush: () => store.flush(),
    render,
    /** For the TV in the room (N5): { unread, total, breaking, sample } from the edition, breaking story and News state. */
    signals: () => tvSignals(news, breaking, N),
  };
}
