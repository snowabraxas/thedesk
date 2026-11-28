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

/* ================= dates (the same rules as server/schema-common.js) ================= */

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Same as DATE_TIME_PARTS in server/schema-common.js (a test keeps them identical). */
export const DATE_TIME_PARTS = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** A YYYY-MM-DD that is a real day on the calendar. */
export function isCalendarDate(v) {
  const m = typeof v === 'string' && DATE_PARTS.exec(v);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** An ISO date-time with a timezone that is a real moment, as the server checks times. */
export function isDateTime(v) {
  const m = typeof v === 'string' && DATE_TIME_PARTS.exec(v);
  if (!m || !isCalendarDate(m[1])) return false;
  const [hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = m.slice(2);
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 14 && Number(offsetMinute) <= 59;
}

export const cnt = (o) => Object.keys(o || {}).length;

/**
 * The value under an own key of one of Snow's maps (reads, saved items), never something inherited:
 * article ids come from an agent, and "constructor" or "toString" would otherwise find Object's own.
 */
export const own = (map, key) => (map !== null && typeof map === 'object' && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined);
/** An id the server accepts for an item (a read, a note, a folder, an article in a folder): 1 to 200 characters, never __proto__. */
export const isItemId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && id !== '__proto__';
/** Snow's caps (the server's too): the page refuses to add past them, with a friendly toast. */
export const MAX_NOTES = 2000;
export const MAX_FOLDERS = 200;

/**
 * A deterministic id for a note or folder found without one, the same as the server's (stableId in
 * server/state-store.js; a test keeps them equal), so every tab and the server agree.
 */
export function stableId(prefix, text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}${h.toString(16).padStart(8, '0')}`;
}
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

/** awarded: articles already paid XP for reading ({ id: time }), so un-marking and re-marking never pays twice. */
export const blank = () => ({ read: {}, saved: {}, folders: [], notes: [], xp: 0, days: [], badges: {}, awarded: {} });

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const STATE_TYPES = {
  read: isPlainObject,
  saved: isPlainObject,
  folders: Array.isArray,
  notes: Array.isArray,
  xp: (v) => typeof v === 'number' && Number.isFinite(v),
  days: Array.isArray,
  badges: isPlainObject,
  awarded: isPlainObject,
};

const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

// The server checks the keys it merges as unions closely (one refused value would stop every save):
// awarded and badges hold times under names up to 200 characters; days are real days, not in the
// future. A value that wouldn't pass (an old or hand-edited state) is mended here: numbers and ISO
// times with a zone stay, a zoneless ISO time is read as UTC, anything else becomes now (the entry
// still counts); a bad name or day is dropped.
function mendTimes(map, now) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === '__proto__' || k.length === 0 || k.length > 200) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || isDateTime(v)) out[k] = v;
    else out[k] = typeof v === 'string' && ZONELESS.test(v) && isDateTime(`${v}Z`) ? `${v}Z` : now;
  }
  return out;
}

// Notes and folders are merged by id on the server: each needs an id (1 to 200 characters), once.
// An old one without an id gets a stable one here (a hash of what it holds, the server's way), so two
// tabs give it the same id rather than two copies.
function mendItems(list, kind) {
  const used = new Set();
  return list.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)).map((x) => {
    let item = x;
    if (!isItemId(item.id) || used.has(item.id)) {
      const base = kind === 'notes' ? stableId('n', `${item.a}|${item.ts}|${item.text}`) : stableId('f', `${item.name}`);
      let id = base;
      for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
      item = { ...item, id };
    }
    used.add(item.id);
    return item;
  });
}
// A map keyed by agent ids, without a "__proto__" key (setting one would change the object's prototype).
const withoutProto = (map) => Object.fromEntries(Object.entries(map).filter(([k]) => k !== '__proto__'));

/**
 * Turns whatever the server sent into a usable state: known keys of the wrong type fall back
 * to blank values, unknown keys are kept so a newer version's data isn't thrown away on save.
 * A state saved before `awarded` existed counts every article already read as paid, so re-marking
 * one of them doesn't pay a second time.
 */
export function normalizeState(raw, now = Date.now()) {
  const S = blank();
  if (!isPlainObject(raw)) return S;
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__proto__') continue;
    if (!(k in STATE_TYPES) || STATE_TYPES[k](v)) S[k] = v;
  }
  S.read = withoutProto(S.read);
  S.saved = Object.fromEntries(Object.entries(S.saved).filter(([k, v]) => k !== '__proto__' && Array.isArray(v)).map(([k, v]) => [k, v.filter(isItemId)]));
  if (!isPlainObject(raw.awarded)) S.awarded = { ...S.read };
  S.awarded = mendTimes(S.awarded, now);
  S.badges = mendTimes(S.badges, now);
  const latest = new Date(now + 864e5).toISOString().slice(0, 10);
  S.days = S.days.filter((d) => isCalendarDate(d) && d <= latest);
  S.notes = mendItems(S.notes, 'notes');
  S.folders = mendItems(S.folders, 'folders');
  if (!(Number.isFinite(S.xp) && S.xp >= 0 && S.xp <= Number.MAX_SAFE_INTEGER)) S.xp = Math.min(Math.max(0, Number.isFinite(S.xp) ? S.xp : 0), Number.MAX_SAFE_INTEGER);
  return S;
}

const isArticleId = isItemId;

/**
 * Marks a Product Feed article read, or unread if it was read. Reading pays XP once per article,
 * ever: the id goes into `awarded` the first time, so un-marking and re-marking never pays twice.
 * @returns {{ read: boolean, award: boolean }} award: pay the XP now.
 */
export function toggleArticleRead(S, id, now = Date.now()) {
  if (!isArticleId(id)) return { read: false, award: false };
  if (Object.hasOwn(S.read, id)) {
    delete S.read[id];
    return { read: false, award: false };
  }
  return markArticleRead(S, id, { now });
}

/** Marks an article read (it stays read if it already was) and pays if it hasn't been paid. canAward false: never pays or records. */
export function markArticleRead(S, id, { now = Date.now(), canAward = true } = {}) {
  if (!isArticleId(id)) return { read: false, award: false };
  if (!Object.hasOwn(S.read, id)) S.read[id] = now;
  if (!isPlainObject(S.awarded)) S.awarded = {};
  const award = canAward && !Object.hasOwn(S.awarded, id);
  if (award) S.awarded[id] = now;
  return { read: true, award };
}

/**
 * Before paying for a read: folds the server's `awarded` into this tab's (a union), so an article
 * another tab already paid for counts here. Everything else stays this tab's. (Saves are merged on
 * the server: server/state-store.js.)
 * @returns the local state, changed in place
 */
export function mergeFeedState(local, server) {
  if (!isPlainObject(local.awarded)) local.awarded = {};
  const theirs = isPlainObject(server) && isPlainObject(server.awarded) ? server.awarded : {};
  for (const [id, time] of Object.entries(theirs)) if (id !== '__proto__' && !Object.hasOwn(local.awarded, id)) local.awarded[id] = time;
  return local;
}

/**
 * Marks an article read or unread like toggleArticleRead, but before paying it checks the server's
 * copy (peek), so an article another tab already paid for doesn't pay again here; also() runs
 * alongside it (the page reloads its state when nothing is waiting to be saved, so the XP is added
 * to the latest total). Read or unread is decided when Snow clicks, and getState returns the state
 * the page holds after the check. If the copy can't be read, the article is marked read without paying.
 * @returns {Promise<{ read: boolean, award: boolean }>}
 */
export async function readArticle(getState, id, { canPay = true, peek, also = async () => {} }) {
  if (!isArticleId(id)) return { read: false, award: false };
  const S = getState();
  if (Object.hasOwn(S.read, id)) return toggleArticleRead(S, id);
  let pay = canPay && !(isPlainObject(S.awarded) && Object.hasOwn(S.awarded, id));
  if (pay) {
    const [server] = await Promise.all([peek(), also()]);
    if (server && server.ok) mergeFeedState(getState(), server.state);
    else pay = false;
  }
  return markArticleRead(getState(), id, { canAward: pay });
}

/* ================= Product Feed changes, item by item ================= */

/**
 * Each change to Snow's notes, folders, saved items and reads, done the one way: it changes the
 * state and tells the state client which item changed (store.added / store.removed), so the server
 * merges it by item and a delete reaches every tab. app.js's handlers use these; so do the tests.
 */
export const feedOps = {
  /**
   * After readArticle: a read is an addition, an un-mark a removal. Listed only when something
   * changed (wasRead is what the page showed before the click), and never for an id the server
   * would refuse: one refused change would stop every later save from this page.
   */
  read(store, id, read, wasRead = !read) {
    if (!isItemId(id) || read === wasRead) return;
    store[read ? 'added' : 'removed']('read', id);
  },
  /** Returns the note, or null at the cap (MAX_NOTES) or with an id the server would refuse. */
  addNote(S, store, note) {
    if (S.notes.length >= MAX_NOTES || !isItemId(note.id)) return null;
    S.notes.push(note);
    store.added('notes', note.id);
    return note;
  },
  /** Returns the note, for Undo. */
  deleteNote(S, store, id) {
    const gone = S.notes.find((n) => n.id === id);
    if (!gone) return null;
    S.notes = S.notes.filter((n) => n.id !== id);
    store.removed('notes', id);
    return gone;
  },
  /** Undo: brings the note back, everywhere (an Undo is the only way a deleted note returns). */
  restoreNote(S, store, note) {
    if (S.notes.some((n) => n.id === note.id)) return;
    S.notes.push(note);
    store.restored('notes', note.id);
  },
  /** Returns the folder, or null at the cap (MAX_FOLDERS) or with an id the server would refuse. */
  addFolder(S, store, folder) {
    if (S.folders.length >= MAX_FOLDERS || !isItemId(folder.id)) return null;
    S.folders.push(folder);
    store.added('folders', folder.id);
    return folder;
  },
  renameFolder(S, store, id, name) {
    const f = S.folders.find((x) => x.id === id);
    if (!f || !name || f.name === name) return false;
    f.name = name;
    store.added('folders', id);
    return true;
  },
  /** Deletes a folder and takes its articles out of it. Returns what Undo needs. */
  deleteFolder(S, store, id) {
    const folder = S.folders.find((x) => x.id === id);
    if (!folder) return null;
    const pairs = [];
    S.folders = S.folders.filter((x) => x.id !== id);
    for (const [a, folders] of Object.entries(S.saved)) {
      if (a === '__proto__' || !Array.isArray(folders) || !folders.includes(id)) continue;
      pairs.push([a, id]);
      S.saved[a] = folders.filter((x) => x !== id);
      if (!S.saved[a].length) delete S.saved[a];
    }
    store.removed('folders', id);
    for (const pair of pairs) store.removed('saved', pair);
    return { folder, pairs };
  },
  /** Undo of a folder delete: the folder (as an Undo) and the articles that were in it. */
  restoreFolder(S, store, { folder, pairs }) {
    if (!S.folders.some((f) => f.id === folder.id)) {
      S.folders.push(folder);
      store.restored('folders', folder.id);
    }
    for (const [a, f] of pairs) {
      if (!isItemId(a)) continue;
      const now = own(S.saved, a) || [];
      if (now.includes(f)) continue;
      S.saved[a] = [...now, f];
      store.added('saved', [a, f]);
    }
  },
  /**
   * Puts an article in a folder or takes it out. Returns how many folders it is in now. Lists the
   * change only when there was one, and does nothing for an id the server would refuse.
   */
  setSaved(S, store, articleId, folderId, on) {
    if (!isItemId(articleId) || !isItemId(folderId)) return (own(S.saved, articleId) || []).length;
    const before = own(S.saved, articleId) || [];
    if (before.includes(folderId) === on) return before.length;
    const now = new Set(before);
    if (on) now.add(folderId);
    else now.delete(folderId);
    if (now.size) S.saved[articleId] = [...now];
    else delete S.saved[articleId];
    store[on ? 'added' : 'removed']('saved', [articleId, folderId]);
    return now.size;
  },
};

/** How long a GET may take before it counts as failed (a stuck one would keep a catch-up round running). */
export const GET_TIMEOUT = 10000;
/** An AbortSignal that fires after ms (undefined where the browser has no AbortSignal.timeout). */
export function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Keeps overlapping fetches of the same thing in order. start() is called as a fetch goes out and
 * returns take(), to call when its answer arrives: true if the answer may be used, that is if no fetch
 * that started later has had its answer used yet. So an older answer that arrives last never replaces
 * a newer one, and an older one that arrives first is still used (it is newer than what was there).
 */
export function newestAnswer() {
  let started = 0;
  let used = 0;
  return {
    start() {
      const mine = ++started;
      return () => {
        if (mine < used) return false;
        used = mine;
        return true;
      };
    },
  };
}

/** An id for this page load (letters, digits and dashes), so the server can tell its saves apart. */
function randomTabId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Loads and saves one desk's state through the server: GET and PUT on `url` (Product Feed's
 * /api/state by default, News's /api/news/state). `normalize` turns what the GET answered into a
 * usable state and `empty` makes the blank one; both default to Product Feed's.
 * - Nothing is saved until load() has succeeded, so a blank state can never overwrite the saved one.
 * - save() is debounced; only one PUT is in flight at a time, and changes made meanwhile follow it.
 *   Nothing is awaited between taking the state and sending it, so there is no moment when a change
 *   is neither waiting nor on its way.
 * - A failed PUT keeps the state in memory, calls onSaveFail once (until a save works again),
 *   and is retried every retryDelay ms (sooner if something else changes) until a save works,
 *   so a change isn't stuck in memory when the tab sits idle after the server comes back.
 * - The server merges every save into the file as it is now (server/state-store.js). `counters:
 *   ["xp"]` (Product Feed) makes XP a counter the server adds up: each PUT carries
 *   `_sync: { xp: <the value last synced>, tab: <this page load's id>, sent: <the xp in it> }`, so
 *   the server adds only this page's own change, and only once even if the same PUT arrives twice
 *   (a reply cut by a restart, then the retry): it remembers the most each tab has sent.
 * - flushOnExit() sends whatever is still waiting, with keepalive so it outlives the page, counting
 *   from the last confirmed value (the server's high-water mark covers a PUT still on its way); but
 *   not when the last read from the server failed (it stays waiting, for a retry if the page stays).
 * - added(kind, id) / removed(kind, id): the server merges reads, notes, folders and saved items by
 *   item, so each save lists the items this page added or edited (`_added`) and removed (`_removed`)
 *   since the last save that landed; an item another tab added survives, a removal reaches every tab.
 * - peek() reads the server's copy without changing anything. reload(apply) reads it and hands it
 *   to apply(state) only when nothing is waiting to be saved and no PUT is on its way, checked
 *   in the same instant it applies, so a change made while the GET was out is never thrown away.
 */
export function createStateClient({
  getState,
  url = '/api/state',
  normalize = normalizeState,
  empty = blank,
  counters = [],
  tabId = randomTabId(),
  fetchFn = (...args) => globalThis.fetch(...args),
  onSaveFail = () => {},
  onTooLarge = () => {}, // the server answered 413: the state is past its 1 MB cap
  delay = 600,
  retryDelay = 15000,
  keepaliveMax = 64000, // browsers refuse keepalive bodies over 64 KB
  timeout = GET_TIMEOUT, // a GET that hasn't answered by then counts as failed
}) {
  const headers = { 'Content-Type': 'application/json' };
  let canSave = false;
  let dirty = false;
  let writing = false;
  let pending = false;
  let timer = null;
  let failNoted = false;
  let lastReadOk = false;
  let base = {}; // counters as last synced with the server
  let running = null; // the flush on its way, if any
  // Items added (or edited) and removed since the last save that landed, by kind: key -> { id, op, v }.
  // The server merges by item, so a delete must be said out loud; the latest change to an item wins.
  const changes = new Map();
  let changeCount = 0;
  const changeKey = (id) => (typeof id === 'string' ? id : JSON.stringify(id));
  function track(kind, id, op) {
    if (!changes.has(kind)) changes.set(kind, new Map());
    changes.get(kind).set(changeKey(id), { id, op, v: ++changeCount });
  }
  // The lists for a PUT, and what they hold (to clear once that PUT lands, unless changed again meanwhile).
  // An Undo ("restore") is an addition the server also lets bring a deleted note or folder back.
  function changeLists() {
    const lists = { _added: {}, _removed: {}, _restored: {} };
    const sent = [];
    for (const [kind, items] of changes) {
      for (const [key, { id, op, v }] of items) {
        if (op === 'remove') (lists._removed[kind] ||= []).push(id);
        else (lists._added[kind] ||= []).push(id);
        if (op === 'restore') (lists._restored[kind] ||= []).push(id);
        sent.push([kind, key, v]);
      }
    }
    const out = {};
    for (const name of ['_added', '_removed', '_restored']) if (Object.keys(lists[name]).length) out[name] = lists[name];
    return { lists: out, sent };
  }
  let tooLarge = false; // the last PUT got 413: no retries until Snow changes something
  function changesLanded(sent) {
    for (const [kind, key, v] of sent) {
      const items = changes.get(kind);
      if (items && items.get(key)?.v === v) items.delete(key);
    }
  }

  let edits = 0; // save() calls so far: a reload that went out before one never applies its answer
  const reloads = newestAnswer(); // overlapping reloads: an older answer never replaces a newer one
  let missed = false; // the last reload was skipped or dropped because of a change here (retry when idle)
  let disposed = false;
  let idleWaiters = [];

  // Read the small reply even when only the status matters, so the browser can finish the request.
  const finish = async (r) => {
    try {
      await r.text?.();
    } catch {
      /* nothing to read */
    }
  };

  // Counters only grow, and two PUTs' replies can come back in either order: never move the base back.
  const advance = (sent) => {
    for (const [k, v] of Object.entries(sent)) base[k] = Math.max(base[k] ?? 0, v);
  };
  const countersOf = (state) => Object.fromEntries(counters.map((k) => [k, typeof state?.[k] === 'number' && Number.isFinite(state[k]) ? state[k] : 0]));
  // The body of a PUT: the state, the items added and removed since the last save that landed, and
  // (with counters) the XP it was last synced at, this tab's id and the XP it sends.
  function bodyOf(state, syncedAt) {
    const { lists, sent: changed } = changeLists();
    if (!counters.length) return { body: JSON.stringify({ ...state, ...lists }), sent: null, changed };
    const sent = countersOf(state);
    return { body: JSON.stringify({ ...state, ...lists, _sync: { ...syncedAt, tab: tabId, sent: sent[counters[0]] } }), sent, changed };
  }

  // GET the server's copy, normalized. Throws when it can't be read.
  async function readServer() {
    try {
      const r = await fetchFn(url, { cache: 'no-store', signal: timeoutSignal(timeout) });
      if (!r.ok) {
        await finish(r);
        throw new Error(`GET ${url} answered ${r.status}`);
      }
      const state = normalize(await r.json());
      lastReadOk = true;
      return state;
    } catch (error) {
      lastReadOk = false;
      throw error;
    }
  }

  async function load() {
    if (disposed) return { ok: false, state: empty() };
    try {
      const state = await readServer();
      canSave = true;
      base = countersOf(state);
      return { ok: true, state };
    } catch (error) {
      canSave = false;
      return { ok: false, state: empty(), error };
    }
  }

  /** The server's copy as it is now. Only after a good load(); never changes what this client will save. */
  async function peek() {
    if (!canSave) return { ok: false };
    try {
      return { ok: true, state: await readServer() };
    } catch (error) {
      return { ok: false, error };
    }
  }

  const idle = () => !dirty && !writing;
  // Wake everyone waiting for the client to be idle (after a PUT lands with nothing else waiting).
  function wakeIdle() {
    if (!idle() || !idleWaiters.length) return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
  }
  /** Resolves once nothing is waiting to be saved and no PUT is on its way (now, if so already). */
  function whenIdle() {
    return idle() ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
  }
  /**
   * The server's copy, handed to apply(state) to replace this tab's, but only when nothing is
   * waiting to be saved, before the GET and in the instant it is applied; only when nothing changed
   * here while the GET was out (not even a change already saved: the answer wouldn't have it); and
   * only when no reload that went out later has applied its answer. Skipped or dropped because of a
   * change here, it sets `missed`, so the page can reload once more when the client is idle.
   */
  async function reload(apply = () => {}) {
    if (!canSave) return { ok: false };
    if (!idle()) {
      missed = true;
      return { ok: false };
    }
    const take = reloads.start();
    const editsBefore = edits;
    const r = await peek();
    if (!r.ok) return { ok: false };
    if (!idle() || edits !== editsBefore) {
      missed = true;
      return { ok: false };
    }
    if (!take()) return { ok: false };
    missed = false;
    base = countersOf(r.state);
    apply(r.state);
    return r;
  }

  /**
   * Catching up: reload(apply) once the first load has worked; until then (the server was down as
   * the page opened, or the read failed), load() again and hand its state to apply, so the page
   * stops working from a blank state and starts saving. { ok, loaded } (loaded: this was the first
   * good read).
   */
  async function catchUp(apply = () => {}) {
    if (canSave) return reload(apply);
    const r = await load();
    if (!r.ok) return { ok: false };
    missed = false;
    // Edits made on the blank state (nothing could be saved) go with it: their lists must not go to
    // the server, where a removal would delete an item another tab has.
    changes.clear();
    apply(r.state);
    return { ok: true, loaded: true, state: r.state };
  }

  function save() {
    if (!canSave) return;
    edits++;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  // After a failure: try again later, unless a save is already on its way. Not after a 413: the same
  // state would be refused again every 15 s; the next change (a delete may make room) tries again.
  function retryLater() {
    if (canSave && dirty && !timer && !tooLarge) timer = setTimeout(flush, retryDelay);
  }

  /**
   * Sends what is waiting. Resolves once everything changed up to now is saved (or has failed and
   * waits for a retry): a call made while a PUT is on its way waits for it and for the one after it.
   */
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (writing) {
      // Only a change made since that PUT went out needs another one (a window switch with nothing
      // new waiting must not send a failed PUT twice).
      if (dirty) pending = true;
      return running;
    }
    if (!canSave || !dirty) return Promise.resolve();
    writing = true;
    running = (async () => {
      try {
        let again = true;
        while (again) {
          pending = false;
          if (!canSave || !dirty) break;
          // Take the state and send it in the same instant: nothing is awaited in between.
          const { body, sent, changed } = bodyOf(getState(), base);
          dirty = false;
          let ok = false;
          let status = 0;
          try {
            const r = await fetchFn(url, { method: 'PUT', headers, body });
            ok = r.ok;
            status = r.status;
            await finish(r);
          } catch {
            /* offline or the server is down */
          }
          if (ok) {
            failNoted = false;
            tooLarge = false;
            if (sent) advance(sent); // the server has added everything up to what was sent
            changesLanded(changed);
          } else if (status === 413) {
            dirty = true; // kept here; the next change sends everything again
            if (!tooLarge) onTooLarge();
            tooLarge = true;
          } else {
            dirty = true; // the retry (or the next change) sends everything again
            if (!failNoted) {
              failNoted = true;
              onSaveFail();
            }
          }
          again = pending; // a change came in meanwhile: send again now
          if (!ok && !again) retryLater();
        }
      } finally {
        writing = false;
        running = null;
        wakeIdle();
      }
    })();
    return running;
  }

  /** Stops for good: no more saves or retries (a test's tab, or a page being torn down). */
  function dispose() {
    disposed = true;
    canSave = false;
    clearTimeout(timer);
    timer = null;
  }

  /** For pagehide. Returns true if it sent something. */
  function flushOnExit() {
    if (!canSave || !dirty || !lastReadOk) return false;
    clearTimeout(timer);
    timer = null;
    pending = false;
    dirty = false;
    wakeIdle();
    // Count from the last confirmed value: if a PUT still on its way lands too, the server's
    // high-water mark for this tab stops its XP being added twice.
    const { body, sent, changed } = bodyOf(getState(), base);
    const keepalive = new TextEncoder().encode(body).length <= keepaliveMax;
    Promise.resolve()
      .then(() => fetchFn(url, { method: 'PUT', headers, body, keepalive }))
      .then((r) => {
        if (!r.ok) throw new Error(`PUT ${url} answered ${r.status}`);
        if (sent) advance(sent);
        changesLanded(changed);
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
    peek,
    reload,
    catchUp,
    whenIdle,
    dispose,
    /** Says an item was added or edited in this save (kind: "read", "notes", "folders", "saved"; saved ids are [article, folder]). */
    added: (kind, id) => track(kind, id, 'add'),
    /** Says an item was removed in this save, so the server deletes it in every tab. */
    removed: (kind, id) => track(kind, id, 'remove'),
    /** Says a deleted note or folder came back by Undo (the only way a deleted one returns). */
    restored: (kind, id) => track(kind, id, 'restore'),
    /** The last save was refused as too large (413); it isn't retried until something changes. */
    get tooLarge() {
      return tooLarge;
    },
    /** How many item changes are waiting to land. */
    get changesWaiting() {
      let n = 0;
      for (const items of changes.values()) n += items.size;
      return n;
    },
    get canSave() {
      return canSave;
    },
    /** The last reload was skipped or dropped because of a change here; reload once more when idle. */
    get missed() {
      return missed;
    },
    get dirty() {
      return dirty;
    },
    /** Nothing waiting to be saved and no PUT on its way. */
    get idle() {
      return idle();
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
    const reads = arts.filter((a) => own(S.read, a.id)).length;
    const notes = S.notes.filter((n) => arts.some((a) => a.id === n.a)).length;
    const saves = arts.filter((a) => (own(S.saved, a.id) || []).length).length;
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
  if (shelf === 'unread') return A.filter((a) => !own(S.read, a.id));
  if (shelf === 'saved') return A.filter((a) => (own(S.saved, a.id) || []).length);
  if (shelf.startsWith('f:')) {
    const f = shelf.slice(2);
    return A.filter((a) => (own(S.saved, a.id) || []).includes(f));
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
  const unread = articles.filter((a) => !own(read, a.id));
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
