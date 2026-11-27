// The Desk's pure logic: no DOM, no network. Imported by app.js in the browser and by the tests in Node.

export const TORONTO = { lat: 43.6532, lng: -79.3832, tz: 'America/Toronto' };
export const WEEK_GOAL = 5;
export const PHASE_LABEL = { morning: 'Daylight', golden: 'Golden hour', night: 'Night' };

/* ================= text and links ================= */

/** Escapes anything for use as HTML text or inside a quoted attribute. */
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The same link rules as the server's contract (isHttpsLink in server/schema-common.js), kept
// here too so a link that somehow got past the server still never becomes a link on the page.
// No spaces, backslashes (a browser reads \ as /) or hidden characters: controls, format and
// invisible characters, by Unicode property.
const LINK_UNSAFE = /[\s\\\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
// The site as written: plain ASCII letters, digits, dots, dashes and underscores (xn-- punycode
// covers other alphabets), with an optional port, which may be empty ("example.com:/x").
const PLAIN_SITE = /^([A-Za-z0-9._-]+)(?::\d{0,5})?$/;
// The URL parser writes every IPv4 form (0x7f.1, 2130706433, 127.1) as four decimal numbers.
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Returns the link only if The Desk may show it as a link, otherwise null:
 * - it starts with https:// and parses;
 * - no user name or password before the site (https://user:pw@host), even an empty one;
 * - the site is written in plain ASCII and is exactly the site the browser opens
 *   (so no lookalike characters, percent-encoding or numeric forms);
 * - not an IP address, localhost or a one-word site with no dot;
 * - no spaces, backslashes or hidden characters anywhere.
 */
export function safeUrl(u) {
  if (typeof u !== 'string' || !u.startsWith('https://') || LINK_UNSAFE.test(u)) return null;
  const rest = u.slice('https://'.length);
  // User info as the browser finds it: past any extra slashes, before the site part ends at / ? or #.
  const site = rest.replace(/^\/+/, '');
  const siteEnd = site.search(/[/?#]/);
  if ((siteEnd === -1 ? site : site.slice(0, siteEnd)).includes('@')) return null;
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const end = rest.search(/[/?#]/);
  const written = PLAIN_SITE.exec(end === -1 ? rest : rest.slice(0, end));
  if (!written || written[1].toLowerCase() !== url.hostname) return null;
  const host = url.hostname.replace(/\.$/, '');
  if (IPV4_HOST.test(url.hostname) || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) return null;
  return u;
}

export const cnt = (o) => Object.keys(o || {}).length;
export const uid = () => Math.random().toString(36).slice(2, 9);
/** The local calendar day as YYYY-MM-DD. */
export const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA');

/** "2026-11-26" -> "Nov 26, 2026" (noon, so no time zone can move it to another day). */
export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "2026-11-26" -> "Nov 26": the short form, for the edition line. */
export function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

/* ================= state ================= */

export const blank = () => ({ read: {}, saved: {}, folders: [], notes: [], xp: 0, days: [], badges: {} });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const STATE_TYPES = {
  read: isPlainObject,
  saved: isPlainObject,
  folders: Array.isArray,
  notes: Array.isArray,
  xp: (v) => typeof v === 'number' && Number.isFinite(v),
  days: Array.isArray,
  badges: isPlainObject,
};

/**
 * Turns whatever the server sent into a usable state: known keys of the wrong type fall back
 * to blank values, unknown keys are kept so a newer version's data isn't thrown away on save.
 */
export function normalizeState(raw) {
  const S = blank();
  if (!isPlainObject(raw)) return S;
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in STATE_TYPES) || STATE_TYPES[k](v)) S[k] = v;
  }
  return S;
}

/**
 * Loads and saves one desk's state through the server: GET and PUT on `url` (Product Feed's
 * /api/state by default, News's /api/news/state). `normalize` turns what the GET answered into a
 * usable state and `empty` makes the blank one; both default to Product Feed's.
 * - Nothing is saved until load() has succeeded, so a blank state can never overwrite the saved one.
 * - save() is debounced; only one PUT is in flight at a time, and changes made meanwhile follow it.
 * - A failed PUT keeps the state in memory, calls onSaveFail once (until a save works again),
 *   and is retried every retryDelay ms (sooner if something else changes) until a save works,
 *   so a change isn't stuck in memory when the tab sits idle after the server comes back.
 * - flushOnExit() sends whatever is still waiting, with keepalive so it outlives the page.
 */
export function createStateClient({
  getState,
  url = '/api/state',
  normalize = normalizeState,
  empty = blank,
  fetchFn = (...args) => globalThis.fetch(...args),
  onSaveFail = () => {},
  delay = 600,
  retryDelay = 15000,
  keepaliveMax = 64000, // browsers refuse keepalive bodies over 64 KB
}) {
  const headers = { 'Content-Type': 'application/json' };
  let canSave = false;
  let dirty = false;
  let writing = false;
  let pending = false;
  let timer = null;
  let failNoted = false;

  // Read the small reply even when only the status matters, so the browser can finish the request.
  const finish = async (r) => {
    try {
      await r.text?.();
    } catch {
      /* nothing to read */
    }
  };

  async function load() {
    try {
      const r = await fetchFn(url, { cache: 'no-store' });
      if (!r.ok) {
        await finish(r);
        throw new Error(`GET ${url} answered ${r.status}`);
      }
      const state = normalize(await r.json());
      canSave = true;
      return { ok: true, state };
    } catch (error) {
      canSave = false;
      return { ok: false, state: empty(), error };
    }
  }

  function save() {
    if (!canSave) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  // After a failure: try again later, unless a save is already on its way.
  function retryLater() {
    if (canSave && dirty && !timer) timer = setTimeout(flush, retryDelay);
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!canSave || !dirty) return;
    if (writing) {
      pending = true;
      return;
    }
    writing = true;
    dirty = false;
    let ok = false;
    try {
      const r = await fetchFn(url, { method: 'PUT', headers, body: JSON.stringify(getState()) });
      ok = r.ok;
      await finish(r);
    } catch {
      /* offline or the server is down */
    }
    writing = false;
    if (ok) failNoted = false;
    else {
      dirty = true; // the retry (or the next change) sends everything again
      if (!failNoted) {
        failNoted = true;
        onSaveFail();
      }
    }
    if (pending) {
      pending = false;
      await flush();
      return;
    }
    if (!ok) retryLater();
  }

  /** For pagehide. Returns true if it sent something. */
  function flushOnExit() {
    if (!canSave || !dirty) return false;
    clearTimeout(timer);
    timer = null;
    pending = false;
    dirty = false;
    const body = JSON.stringify(getState());
    const keepalive = new TextEncoder().encode(body).length <= keepaliveMax;
    Promise.resolve()
      .then(() => fetchFn(url, { method: 'PUT', headers, body, keepalive }))
      .then((r) => {
        if (!r.ok) throw new Error(`PUT ${url} answered ${r.status}`);
      })
      .catch(() => {
        // Still here (the page was kept, or came back from the back/forward cache): try again later.
        dirty = true;
        retryLater();
      });
    return true;
  }

  return {
    load,
    save,
    flush,
    flushOnExit,
    get canSave() {
      return canSave;
    },
    get dirty() {
      return dirty;
    },
  };
}

/* ================= progress ================= */

export const level = (xp) => 1 + Math.floor((xp || 0) / 100);

/**
 * The toast after earning XP: "+10 XP · article read", "New badge: Curator · +5 XP",
 * "Level 2! +10 XP · article read". While saving is paused it adds " · not saved".
 * @param {{ xp: number, msg: string, badges?: string[], newLevel?: number, saved?: boolean }} award
 */
export function awardText({ xp, msg, badges = [], newLevel = 0, saved = true }) {
  let text = badges.length ? `New badge: ${badges.join(', ')} · +${xp} XP` : `+${xp} XP · ${msg}`;
  if (newLevel) text = `Level ${newLevel}! ${text}`;
  return saved ? text : `${text} · not saved`;
}

/** Days in a row with activity, counting today if it already has some, else ending yesterday. */
export function streak(days, now = new Date()) {
  const set = new Set(days);
  let n = 0;
  const d = new Date(now);
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (set.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** Reads since Monday 00:00 local time. */
export function readsThisWeek(read, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return Object.values(read || {}).filter((ts) => ts >= start.getTime()).length;
}

export function themeScores(feed, S) {
  const articles = feed.articles || [];
  return (feed.themes || []).map((t) => {
    const arts = articles.filter((a) => (a.themes || []).includes(t.id));
    const reads = arts.filter((a) => S.read[a.id]).length;
    const notes = S.notes.filter((n) => arts.some((a) => a.id === n.a)).length;
    const saves = arts.filter((a) => (S.saved[a.id] || []).length).length;
    return { ...t, total: arts.length, reads, notes, saves, score: reads + notes * 2 + saves * 0.5 };
  });
}

export const BADGES = [
  { id: 'first-read', name: 'First page turned', how: 'Read one article', test: (S) => cnt(S.read) >= 1 },
  { id: 'five-reads', name: 'Steady reader', how: 'Read five articles', test: (S) => cnt(S.read) >= 5 },
  { id: 'first-note', name: 'Thinking out loud', how: 'Write your first note', test: (S) => S.notes.length >= 1 },
  { id: 'curator', name: 'Curator', how: 'Make a folder', test: (S) => S.folders.length >= 1 },
  { id: 'connector', name: 'Connector', how: 'Read across three themes', test: (S, feed) => themeScores(feed, S).filter((t) => t.reads > 0).length >= 3 },
  { id: 'deep-diver', name: 'Deep diver', how: 'Three notes on one theme', test: (S, feed) => themeScores(feed, S).some((t) => t.notes >= 3) },
];

/** Badges the state has earned but not yet been given. */
export const freshBadges = (S, feed) => BADGES.filter((b) => !S.badges[b.id] && b.test(S, feed));

/** Articles on a shelf: all, unread, saved, or one folder ("f:<id>"). */
export function articlesFor(feed, S, shelf) {
  const A = feed.articles || [];
  if (shelf === 'unread') return A.filter((a) => !S.read[a.id]);
  if (shelf === 'saved') return A.filter((a) => (S.saved[a.id] || []).length);
  if (shelf.startsWith('f:')) {
    const f = shelf.slice(2);
    return A.filter((a) => (S.saved[a.id] || []).includes(f));
  }
  return A;
}

/* ================= time of day ================= */

const dateParts = new Map();
/** The calendar date (year, month 0-11, day) at this instant in the given time zone. */
function calendarDate(date, timeZone) {
  let fmt = dateParts.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    dateParts.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map(({ type, value }) => [type, value]));
  return { y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day) };
}

/**
 * Sunrise and sunset for the place's calendar day containing `date` (the classic almanac
 * algorithm, good to a few minutes). Both are real instants on that day, so they compare
 * directly with Date.now().
 */
export function sunTimes(date = new Date(), place = TORONTO) {
  const rad = Math.PI / 180;
  const zen = 90.833 * rad;
  const { y, m, d } = calendarDate(date, place.tz);
  const dayStartUtc = Date.UTC(y, m, d);
  const N = Math.round((dayStartUtc - Date.UTC(y, 0, 0)) / 864e5);
  const lngHour = place.lng / 15;
  const calc = (rising) => {
    const t = N + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    const L = (M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634 + 360) % 360;
    let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 360) % 360;
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zen) - sinDec * Math.sin(place.lat * rad)) / (cosDec * Math.cos(place.lat * rad));
    let H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;
    if (rising) H = 360 - H;
    H /= 15;
    // Local mean solar time of the event (0-24h). Converting it to UTC on this calendar day,
    // without wrapping at UTC midnight, keeps a summer sunset (after 20:00 EDT, so after
    // midnight UTC) on the right day. The prototype wrapped it, which put it on the day before.
    const localMean = (((H + RA - 0.06571 * t - 6.622) % 24) + 24) % 24;
    return new Date(dayStartUtc + Math.round((localMean - lngHour) * 60) * 60e3);
  };
  return { rise: calc(true), set: calc(false) };
}

/** night until 30 min before sunrise, daylight until 2 h before sunset, golden until 30 min after it. */
export function autoPhase(now = new Date(), place = TORONTO) {
  const st = sunTimes(now, place);
  const rise = st.rise.getTime();
  const set = st.set.getTime();
  const t = now.getTime();
  const m = 60e3;
  if (t < rise - 30 * m || t > set + 30 * m) return 'night';
  if (t > set - 120 * m) return 'golden';
  return 'morning';
}

const SYNODIC = 29.530588;
export function moon(now = new Date()) {
  const age = ((((now - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) % SYNODIC) + SYNODIC) % SYNODIC;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return { age, name: names[Math.floor((age / SYNODIC) * 8 + 0.5) % 8] };
}

/** SVG path for the moon's shadow. Waxing: shadow on the left; waning: on the right. */
export function moonPath(age) {
  const f = age / SYNODIC;
  const k = Math.cos(f * 2 * Math.PI);
  const rx = Math.abs(40 * k);
  if (f < 0.5) return `M50 10 A40 40 0 0 0 50 90 A${rx} 40 0 0 ${k > 0 ? 0 : 1} 50 10Z`;
  return `M50 10 A40 40 0 0 1 50 90 A${rx} 40 0 0 ${k > 0 ? 1 : 0} 50 10Z`;
}

/** What Wila says in the room, given the phase, unread count and whether a feed has arrived. */
export function wilaLine(p, n, hasArticles) {
  if (!hasArticles) return 'Your Product Feed is still being set up.';
  if (!n) return p === 'night' ? "You've read every pick in your feed. That's a good day. Rest well." : "You're all caught up on the feed. Want to add a note while it's fresh?";
  const picks = n === 1 ? '1 pick is' : `${n} picks are`;
  if (p === 'morning') return `Good morning, Snow. ${picks} waiting in your Product Feed. Start with one over coffee?`;
  if (p === 'golden') return `Golden hour, Snow. ${picks} still on the laptop. One short read before the day winds down?`;
  return `Evening, Snow. ${picks} still on the laptop. No rush, they'll keep until morning.`;
}

/** Agent text as one tidy line: whitespace and line breaks collapse to single spaces. */
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Wila's one-line note at the top of the Product Feed, built only from the edition and Snow's reads:
 * how many picks are unread, the theme with the most unread picks (ties go to the theme listed first),
 * and the source of the first unread pick. All caught up gives a short warm line instead.
 * Returns plain text that can hold agent words (a theme name, a source): set it with textContent.
 * @param {{ articles?: object[], themes?: object[] }} feed
 * @param {{ read?: Record<string, number> }} S
 */
export function mentorLine(feed, S) {
  const articles = (Array.isArray(feed?.articles) ? feed.articles : []).filter((a) => a && typeof a === 'object');
  if (!articles.length) return 'Your Product Feed is still being set up.';
  const read = S && typeof S.read === 'object' && S.read ? S.read : {};
  const unread = articles.filter((a) => !read[a.id]);
  if (!unread.length) return 'All caught up. Nicely done, Snow. What stuck with you?';

  const n = unread.length;
  let top = null;
  for (const t of Array.isArray(feed.themes) ? feed.themes : []) {
    const name = oneLine(t?.name);
    if (!name) continue;
    const k = unread.filter((a) => Array.isArray(a.themes) && a.themes.includes(t.id)).length;
    if (k > (top ? top.k : 0)) top = { name, k };
  }

  let line = n === 1 ? 'One pick to read' : `${n} picks to read`;
  if (top) {
    if (n === 1) line += `, on ${top.name}`;
    else if (top.k === n) line += `, all on ${top.name}`;
    else if (top.k > 1) line += `, ${top.k} on ${top.name}`;
  }
  line += '.';
  const source = oneLine(unread[0].source);
  if (source) line += n === 1 ? ` It's from ${source}.` : ` Start with ${source}.`;
  return line;
}
