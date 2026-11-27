// Snow's saved state, one file per desk: $DESK_HOME/desks/<desk>/state.json.
//   product-feed: reads, saves, folders, notes, XP, the streak's days, badges and the articles already paid XP (GET/PUT /api/state)
//   news:         stories read, breaking stories dismissed, the shelf left open (GET/PUT /api/news/state)
// Every write goes to a temp file in the same folder, is fsynced, then renamed over state.json
// (atomic-file.js), so a crash leaves either the old file or the new one, never half of one.
// Writes run one at a time.
//
// Snow keeps The Desk open in more than one place (the Claude app's pane and a browser), and each
// page saves its whole state. So each queued write first reads the file as it is now and folds the
// incoming state into it (mergeIncoming): what can only grow is never lost to a tab that loaded
// earlier. awarded (both desks) and dismissed (News) are unions, capped at the newest 2000; badges a
// union keeping the earliest time; days a union, sorted, the last 120. xp is a counter: the page
// sends `_sync: { xp: <last synced>, tab: <id per page load>, sent: <its xp> }` (never saved), and
// the server adds `sent - max(xp, seen[tab])`, then remembers `seen[tab] = sent` (in `_seen`, kept
// in the file for the newest 50 tabs and stripped from every GET), so a PUT sent twice (a reply cut
// by a restart, then the retry) pays once. A page that sends no base gets the larger of the two.
// Reads (both desks), saved items, notes and folders are merged by item (since N4c): an item another
// tab added survives a save that doesn't mention it. A page lists what it removed and what it added
// or edited in this save (`_removed`, `_added`: { read: [...], notes: [...], folders: [...], saved:
// [[article, folder], ...] }, never saved): a removal deletes the item and leaves a tombstone in
// `_deleted` (30 days, stripped from every GET), so a stale tab can't bring it back; an addition or
// edit wins for that item and clears its tombstone; an item a save carries without listing it can't
// overwrite the saved copy or come back from a tombstone. A page with no lists (old code) gets unions
// with no deletes. The shelf stays last-save-wins.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.js';
import { statePath } from './config.js';
import { isCalendarDate, isDateTime, jsonErrorText, show } from './schema-common.js';

export const MAX_STATE_BYTES = 1024 * 1024;
/** Unions only grow, so each is capped to its newest entries (years of Snow's use) and can't fill the 1 MB cap. */
export const MAX_MAP_ENTRIES = 2000;
/** How many tabs' XP high-water marks are kept (`_seen`). */
export const MAX_SEEN_TABS = 50;
/** A temp file this old in a desk folder is left over from a crash, not a write in progress. */
export const STALE_TEMP_MS = 60_000;
/** Snow's notes and folders: far more than she will write, and the 1 MB cap comes first for long notes. */
export const MAX_NOTES = 2000;
export const MAX_FOLDERS = 200;
/** Tombstones (`_deleted`) are kept this long, so a tab left open for weeks still can't bring an item back. */
export const TOMBSTONE_MS = 30 * 864e5;
export const MAX_TOMBSTONES = 2000;
/** Entries one save may list as added or removed. */
export const MAX_CHANGES = 5000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A rule takes a key's value and its name, and says what's wrong ("xp must be a number") or null.
const ofType = (words, test) => (value, key) => (test(value) ? null : `${key} must be ${words}`);

// When something happened: an ISO time ("2026-12-07T13:05:00.000Z", what toISOString() gives) or
// a number (Date.now() milliseconds, as Product Feed stores them).
const isTime = (v) => (typeof v === 'number' && Number.isFinite(v)) || isDateTime(v);

// An ISO time written without a zone ("2026-11-27T10:00:00"), as an old badge may be: read as UTC.
const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
/** A time as it is saved: numbers and zoned ISO times as they are, a zoneless ISO time with "Z" added; null for anything else. */
export function asTime(v) {
  if (isTime(v)) return v;
  return typeof v === 'string' && ZONELESS.test(v) && isDateTime(`${v}Z`) ? `${v}Z` : null;
}

// News story ids repeat every morning (s1, s2...), so a read story is keyed by its edition too.
const STORY_KEY = /^(\d{4}-\d{2}-\d{2})\/[A-Za-z0-9_-]{1,40}$/;
const isStoryKey = (k) => STORY_KEY.test(k) && isCalendarDate(k.slice(0, 10));

/** An object of times, each under a key of a given shape: { "2026-12-07/s1": "2026-12-07T13:05:00.000Z" }. */
function timesKeyedBy(keyWords, isKey) {
  return (value, key) => {
    if (!isPlainObject(value)) return `${key} must be an object`;
    for (const [k, time] of Object.entries(value)) {
      if (!isKey(k)) return `${key} keys must be ${keyWords} (got ${show(k)})`;
      if (!isTime(time)) return `${key}[${show(k)}] must be an ISO time or a number`;
    }
    return null;
  };
}

// A count of XP: a whole-or-fractional number from 0 to Number.MAX_SAFE_INTEGER.
const isXp = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A page's tab id: a key in `_seen`, so never "__proto__".
const isTabId = (t) => typeof t === 'string' && TAB_ID.test(t) && t !== '__proto__';

/** A list of days for the streak: real calendar days, none more than a day ahead of now. */
function streakDays(now) {
  return (value, key) => {
    if (!Array.isArray(value)) return `${key} must be a list`;
    const latest = new Date(now() + 864e5).toISOString().slice(0, 10);
    for (const day of value) {
      if (!isCalendarDate(day)) return `${key} must hold days like "2026-11-27" (got ${show(day)})`;
      if (day > latest) return `${key} can't hold a day in the future (got ${show(day)})`;
    }
    return null;
  };
}

const isName = (k) => typeof k === 'string' && k.length > 0 && k.length <= 200 && k !== '__proto__';

/** An object of times under names (an article, a badge): 1 to 200 characters. A zoneless ISO time is accepted (read as UTC). */
function timesByName(value, key) {
  if (!isPlainObject(value)) return `${key} must be an object`;
  for (const [k, time] of Object.entries(value)) {
    if (!isName(k)) return `${key} keys must be names up to 200 characters (got ${show(k)})`;
    if (asTime(time) === null) return `${key}[${show(k)}] must be an ISO time or a number`;
  }
  return null;
}

/** A list of items with ids (notes, folders): objects, each with an id of 1 to 200 characters, each id once, at most `max`. */
function itemsById(max, noun) {
  return (value, key) => {
    if (!Array.isArray(value)) return `${key} must be a list`;
    if (value.length > max) return `${key} can hold at most ${max} ${noun} (has ${value.length})`;
    const ids = new Set();
    for (const item of value) {
      if (!isPlainObject(item) || !isName(item.id)) return `${key} must hold ${noun} with an id (got ${show(item)})`;
      if (ids.has(item.id)) return `${key} lists the id ${show(item.id)} twice`;
      ids.add(item.id);
    }
    return null;
  };
}

/** Product Feed's saved items: { "<article id>": ["<folder id>", ...] }. */
function savedRule(value, key) {
  if (!isPlainObject(value)) return `${key} must be an object`;
  for (const [a, folders] of Object.entries(value)) {
    if (!isName(a)) return `${key} keys must be article ids up to 200 characters (got ${show(a)})`;
    if (!Array.isArray(folders) || !folders.every(isName)) return `${key}[${show(a)}] must be a list of folder ids`;
  }
  return null;
}

/** What one save added or removed, by kind: `{ read: [id, ...], saved: [[article, folder], ...] }`. Never saved. */
function changeRule(kinds, isId) {
  return (value, key) => {
    if (!isPlainObject(value)) return `${key} must be an object like { "read": ["a1"] }`;
    let count = 0;
    for (const [kind, list] of Object.entries(value)) {
      if (!kinds.includes(kind)) return `${key} can only list ${kinds.join(', ')} (got ${show(kind)})`;
      if (!Array.isArray(list)) return `${key}.${kind} must be a list`;
      for (const id of list) {
        const ok = kind === 'saved' ? Array.isArray(id) && id.length === 2 && id.every(isName) : isId(kind, id);
        if (!ok) return `${key}.${kind} holds something that isn't an id (got ${show(id)})`;
      }
      count += list.length;
    }
    return count > MAX_CHANGES ? `${key} can list at most ${MAX_CHANGES} changes in one save` : null;
  };
}
const FEED_KINDS = ['read', 'notes', 'folders', 'saved'];
const NEWS_KINDS = ['read'];
const feedChange = changeRule(FEED_KINDS, (kind, id) => isName(id));
const newsChange = changeRule(NEWS_KINDS, (kind, id) => typeof id === 'string' && isStoryKey(id));

/** `_sync`: what this page last synced, its tab id and the XP it is sending. Never saved. */
function syncRule(value, key) {
  if (!isPlainObject(value)) return `${key} must be an object like { "xp": 40, "tab": "k3x9", "sent": 50 }`;
  for (const field of ['xp', 'sent']) {
    if (value[field] !== undefined && !isXp(value[field])) return `${key}.${field} must be a number from 0 to ${Number.MAX_SAFE_INTEGER}`;
  }
  if (value.tab !== undefined && !isTabId(value.tab)) return `${key}.tab must be up to 64 letters, digits, dashes or underscores`;
  return null;
}

/**
 * The keys each desk's state knows about and the rule each must follow. Other keys pass through
 * untouched, so a newer page can add one without the server refusing it. Keys that are merged as
 * unions (awarded, badges, days, dismissed) are permanent, so their values are checked closely.
 * XP and the streak live in Product Feed's state only; the News page adds to them there.
 * @param {() => number} [now] the clock, for "a day in the future"
 */
export function stateRules(now = Date.now) {
  return {
    'product-feed': {
      read: ofType('an object', isPlainObject),
      saved: savedRule,
      folders: itemsById(MAX_FOLDERS, 'folders'),
      notes: itemsById(MAX_NOTES, 'notes'),
      xp: ofType(`a number from 0 to ${Number.MAX_SAFE_INTEGER}`, isXp),
      days: streakDays(now),
      badges: timesByName,
      // Articles already paid XP for reading: { "<article id>": time }.
      awarded: timesByName,
      // Not saved: what the page last synced, so a save adds only its own XP (and only once).
      _sync: syncRule,
      // Not saved: what this save removed, and what it added or edited, item by item.
      _removed: feedChange,
      _added: feedChange,
    },
    news: {
      read: timesKeyedBy('"<edition>/<story id>", like "2026-12-07/s1"', isStoryKey),
      dismissed: timesKeyedBy(`the breaking story's "at", like "2026-12-07T12:04:00-05:00"`, isDateTime),
      shelfOpen: ofType('true or false', (v) => typeof v === 'boolean'),
      awarded: timesKeyedBy('"<edition>/<story id>", like "2026-12-07/s1"', isStoryKey),
      _removed: newsChange,
      _added: newsChange,
    },
  };
}
export const STATE_RULES = stateRules();

// ---- Merging a save into the file as it is now ----------------------------------------------

const timeValue = (t) => (typeof t === 'number' ? t : Date.parse(t));

/** The newest `max` entries of a { key: time } map, by time (all of them when there are no more). */
export function newest(map, max = MAX_MAP_ENTRIES) {
  if (!isPlainObject(map)) return map;
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  const t = (v) => (Number.isFinite(timeValue(v)) ? timeValue(v) : -Infinity);
  return Object.fromEntries(entries.sort((a, b) => t(b[1]) - t(a[1])).slice(0, max));
}

/**
 * { key: time } maps as a union; a key in both keeps the earlier time (the file's, when the two can't
 * be compared). Only one side an object: that one. Neither: the incoming value as it is. An entry in
 * the file whose value isn't a time (a hand edit) is dropped.
 */
function unionTimes(current, incoming) {
  const times = (map) => Object.fromEntries(Object.entries(map).filter(([k, t]) => k !== '__proto__' && asTime(t) !== null).map(([k, t]) => [k, asTime(t)]));
  if (!isPlainObject(current)) return isPlainObject(incoming) ? times(incoming) : incoming;
  if (!isPlainObject(incoming)) return times(current);
  const out = times(incoming);
  for (const [k, raw] of Object.entries(current)) {
    const time = asTime(raw);
    if (k === '__proto__' || time === null) continue;
    if (!Object.hasOwn(out, k)) {
      out[k] = time;
      continue;
    }
    const mine = timeValue(time);
    const theirs = timeValue(out[k]);
    if (!(Number.isFinite(mine) && Number.isFinite(theirs)) || mine < theirs) out[k] = time;
  }
  return out;
}

/** The streak's days as a union of both lists: real calendar days only (anything else in the file is dropped), each once, sorted, the last 120. */
function unionDays(current, incoming) {
  if (!Array.isArray(current) && !Array.isArray(incoming)) return incoming;
  const days = new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])].filter(isCalendarDate));
  return [...days].sort().slice(-120);
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * XP after a save. With a base (the XP the page last synced), the page's own change is added to what
 * is saved now, and XP never goes down through a save. `highWater`, the most this tab has already
 * sent, raises the base, so the same XP sent twice is added once. Without a base (a page from before
 * this rule), the larger of the two. Nothing saved yet: the page's XP. Never a sum that isn't a safe
 * whole number range (it keeps what is saved instead).
 */
export function mergeXp(current, incoming, base, highWater) {
  if (!isNumber(incoming)) return current;
  if (!isNumber(current)) return Math.min(Math.max(0, incoming), Number.MAX_SAFE_INTEGER);
  let next;
  if (isNumber(base)) next = current + Math.max(0, incoming - Math.max(base, isNumber(highWater) ? highWater : -Infinity));
  else next = Math.max(current, incoming);
  return Number.isFinite(next) && next <= Number.MAX_SAFE_INTEGER ? next : current;
}

/**
 * The newest MAX_SEEN_TABS tabs' high-water marks, with this tab's set to what it sent. Each mark
 * carries `n`, a counter that only goes up (one more than the highest so far), so the order doesn't
 * depend on the clock; marks from before the counter count as 0, the newer time first among them.
 */
function updateSeen(seen, tab, sent, now) {
  const out = Object.fromEntries(Object.entries(isPlainObject(seen) ? seen : {}).filter(([k, v]) => isTabId(k) && isPlainObject(v) && isNumber(v.xp)));
  const n = (v) => (isNumber(v.n) ? v.n : 0);
  const top = Math.max(0, ...Object.values(out).map(n));
  const prior = out[tab] ? out[tab].xp : -Infinity;
  out[tab] = { xp: Math.max(prior, sent), n: top + 1, at: now };
  const at = (v) => (isNumber(v.at) ? v.at : 0);
  return Object.fromEntries(Object.entries(out).sort((a, b) => n(b[1]) - n(a[1]) || at(b[1]) - at(a[1])).slice(0, MAX_SEEN_TABS));
}

// ---- Merging by item: reads, saved items, notes and folders ----

/** The tombstones as a small helper: has, set (a removal now), clear (an addition), and the pruned map to save. */
function tombstones(saved, now) {
  const map = new Map();
  if (isPlainObject(saved)) for (const [k, t] of Object.entries(saved)) if (k !== '__proto__' && isNumber(t) && now - t <= TOMBSTONE_MS) map.set(k, t);
  return {
    has: (kind, key) => map.has(`${kind}:${key}`),
    set: (kind, key) => map.set(`${kind}:${key}`, now),
    clear: (kind, key) => map.delete(`${kind}:${key}`),
    toJSON: () => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOMBSTONES)),
    get size() {
      return map.size;
    },
  };
}

const pairKey = (pair) => JSON.stringify(pair);

/** What a save listed, as sets of keys by kind (saved pairs as JSON). Empty sets for a page with no lists. */
function changesOf(list, kinds) {
  const out = {};
  for (const kind of kinds) {
    const items = isPlainObject(list) && Array.isArray(list[kind]) ? list[kind] : [];
    out[kind] = new Set(items.map((id) => (kind === 'saved' ? pairKey(id) : id)));
  }
  return out;
}

/**
 * Merges one kind of item. `entries` lists [key, value] from the file (current) and the save
 * (incoming). The file's items stay unless removed; the save's items are added when the file
 * doesn't have them; an item the save listed as added or edited replaces the file's copy and clears
 * its tombstone; an unlisted item can't come back from a tombstone; a removal deletes and tombstones.
 * Returns a Map in the file's order, then new items in the save's order.
 */
function mergeItems(kind, current, incoming, added, removed, tomb) {
  const out = new Map(current);
  for (const [key, value] of incoming) {
    const listed = added.has(key);
    if (!listed && tomb.has(kind, key)) continue;
    if (listed || !out.has(key)) out.set(key, value);
    if (listed) tomb.clear(kind, key);
  }
  for (const key of removed) {
    out.delete(key);
    tomb.set(kind, key);
  }
  return out;
}

const timeEntries = (map) => (isPlainObject(map) ? Object.entries(map).filter(([k, t]) => k !== '__proto__' && asTime(t) !== null) : []);
// Product Feed's reads were never checked as times: keep every value as it is.
const anyEntries = (map) => (isPlainObject(map) ? Object.entries(map).filter(([k]) => k !== '__proto__') : []);
const itemEntries = (list) => (Array.isArray(list) ? list.filter((x) => isPlainObject(x) && isName(x.id)).map((x) => [x.id, x]) : []);
const pairEntries = (saved) => {
  const out = [];
  if (isPlainObject(saved)) {
    for (const [a, folders] of Object.entries(saved)) if (isName(a) && Array.isArray(folders)) for (const f of folders) if (isName(f)) out.push([pairKey([a, f]), [a, f]]);
  }
  return out;
};
/** The newest `max` notes by `ts` (all when there are no more), in their order. */
function newestItems(list, max) {
  if (list.length <= max) return list;
  const keep = new Set([...list].sort((a, b) => (isNumber(b.ts) ? b.ts : 0) - (isNumber(a.ts) ? a.ts : 0)).slice(0, max));
  return list.filter((x) => keep.has(x));
}

/**
 * The state to save: the incoming one, merged with the file as it is now. What only grows (awarded,
 * dismissed, badges, days, xp) is folded in; reads, saved items, notes and folders are merged by item
 * (see the top of this file). Keys neither side has stay absent. `_sync`, `_added` and `_removed` are
 * never saved; `_seen` and `_deleted` are the server's own (a page's copies are ignored).
 * @param {string} desk "product-feed" or "news"
 * @param {{ now?: number }} [options] the time recorded for tombstones and a tab's high-water mark
 */
export function mergeIncoming(desk, current, incoming, { now = Date.now() } = {}) {
  const cur = isPlainObject(current) ? current : {};
  const { _sync: sync, _seen: ignoredSeen, _deleted: ignoredDeleted, _added: addedList, _removed: removedList, ...next } = incoming;
  const fold = (key, how) => {
    if (Object.hasOwn(cur, key) || Object.hasOwn(next, key)) {
      const value = how(cur[key], next[key]);
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
  };
  const kinds = desk === 'news' ? NEWS_KINDS : FEED_KINDS;
  const added = changesOf(addedList, kinds);
  const removed = changesOf(removedList, kinds);
  const tomb = tombstones(cur._deleted, now);
  const byItem = (kind, entries, build) => fold(kind, (a, b) => {
    if (a === undefined && b === undefined) return undefined;
    return build(mergeItems(kind, entries(a), entries(b), added[kind], removed[kind], tomb));
  });

  if (desk === 'news') byItem('read', timeEntries, (items) => newest(Object.fromEntries([...items].map(([k, t]) => [k, asTime(t)]))));
  else byItem('read', anyEntries, (items) => newest(Object.fromEntries(items)));
  fold('awarded', (a, b) => newest(unionTimes(a, b)));
  if (desk === 'news') {
    fold('dismissed', (a, b) => newest(unionTimes(a, b)));
  }
  if (desk === 'product-feed') {
    byItem('notes', itemEntries, (items) => newestItems([...items.values()], MAX_NOTES));
    byItem('folders', itemEntries, (items) => [...items.values()].slice(0, MAX_FOLDERS));
    byItem('saved', pairEntries, (items) => {
      // A pair whose folder is gone (deleted in any tab) goes with it.
      const folders = Array.isArray(next.folders) ? new Set(next.folders.map((f) => f.id)) : null;
      const saved = {};
      for (const [a, f] of items.values()) {
        if (folders && !folders.has(f)) continue;
        (saved[a] ||= []).push(f);
      }
      return saved;
    });
    fold('badges', unionTimes);
    fold('days', unionDays);
    const s = isPlainObject(sync) ? sync : {};
    const tab = isTabId(s.tab) ? s.tab : null;
    const sent = isNumber(s.sent) ? s.sent : next.xp;
    const seen = isPlainObject(cur._seen) ? cur._seen : {};
    const highWater = tab && isPlainObject(seen[tab]) ? seen[tab].xp : undefined;
    fold('xp', (a) => mergeXp(a, sent, s.xp, highWater));
    if (tab && isNumber(sent) && isNumber(s.xp)) next._seen = updateSeen(seen, tab, sent, now);
    else if (Object.hasOwn(cur, '_seen')) next._seen = cur._seen;
  }
  if (tomb.size) next._deleted = tomb.toJSON();
  return next;
}

/** What a page gets back from GET: the state without the server's own bookkeeping (`_seen`, `_deleted`). */
export function forPage(state) {
  if (!isPlainObject(state)) return state;
  const { _seen: ignoredSeen, _deleted: ignoredDeleted, ...rest } = state;
  return rest;
}

/** The merged state would pass the 1 MB cap. The server answers 413 and leaves the file alone. */
export class StateTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateTooLargeError';
  }
}

/**
 * Checks a parsed state before it is saved. Never throws.
 * @param {unknown} value
 * @param {string} [desk] "product-feed" (the default) or "news"
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkState(value, desk = 'product-feed', { now = Date.now } = {}) {
  if (!isPlainObject(value)) return { ok: false, error: 'state must be a JSON object' };
  const rules = now === Date.now ? STATE_RULES : stateRules(now);
  for (const [key, rule] of Object.entries(rules[desk])) {
    if (!Object.hasOwn(value, key)) continue;
    const error = rule(value[key], key);
    if (error) return { ok: false, error };
  }
  return { ok: true };
}

/** state.json exists but can't be used. The server answers 500 and leaves the file alone. */
export class CorruptStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/**
 * One desk's saved state.
 * @param {string} deskHome
 * @param {string} desk a desk in STATE_RULES: "product-feed" or "news"
 * On creation it sweeps temp files a crash left behind in the desk's folder (`.state.json.*.tmp`
 * older than a minute, so a second server writing to the same folder right now isn't disturbed).
 * @param {{ fsp?: typeof fs.promises, now?: () => number, sweepAgainAfter?: number }} [options] fsp lets tests make a step fail; now is the clock; sweepAgainAfter: when the second sweep runs (ms)
 * @returns {{ desk: string, filePath: string, read: () => Promise<object>, readForPage: () => Promise<object>, write: (value: object) => Promise<void>, settled: () => Promise<void>, swept: Promise<number>, check: (value: unknown) => { ok: boolean, error?: string } }}
 */
export function createStateStore(deskHome, desk, { fsp = fs.promises, now = Date.now, sweepAgainAfter = STALE_TEMP_MS + 5000 } = {}) {
  if (!Object.hasOwn(STATE_RULES, desk)) throw new Error(`The Desk keeps no state for a desk called ${show(desk)}`);
  const filePath = statePath(deskHome, desk);
  let queue = Promise.resolve();

  /** Removes `.state.json.<random>.tmp` files older than STALE_TEMP_MS. Resolves to how many went. Never throws. */
  async function sweep() {
    const dir = path.dirname(filePath);
    const prefix = `.${path.basename(filePath)}.`;
    let removed = 0;
    try {
      for (const name of await fsp.readdir(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
        const file = path.join(dir, name);
        try {
          const st = await fsp.lstat(file);
          if (st.isFile() && now() - st.mtimeMs > STALE_TEMP_MS) {
            await fsp.rm(file, { force: true });
            removed++;
          }
        } catch {
          /* gone already */
        }
      }
    } catch {
      /* no folder yet */
    }
    return removed;
  }
  const swept = sweep();
  // Once more a minute later: a temp file from a crash just before this start is too new the first time.
  const sweptAgain = new Promise((resolve) => {
    const t = setTimeout(() => sweep().then(resolve), sweepAgainAfter);
    t.unref?.();
  });

  /** The saved state, {} if there is none yet. Throws CorruptStateError if the file is unusable. */
  async function read() {
    let text;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
    let value;
    try {
      value = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      // No quoted snippet of the file in the message (it goes to the-desk.log): see jsonErrorText.
      throw new CorruptStateError(`${filePath} is not valid JSON (${jsonErrorText(err)})`);
    }
    if (!isPlainObject(value)) throw new CorruptStateError(`${filePath} does not hold a JSON object`);
    return value;
  }

  /**
   * Saves the state, merged into the file as it is now (mergeIncoming). Writes are queued, so two can
   * never interleave, and the read and the write happen inside the same turn of the queue, so no other
   * save can land in between. A file that can't be read (CorruptStateError) is left alone.
   */
  function write(value) {
    const run = queue.then(async () => {
      const merged = mergeIncoming(desk, await read(), value, { now: now() });
      // The cap is on the state itself (as the page sends it), not on the file's indentation.
      if (Buffer.byteLength(JSON.stringify(merged)) > MAX_STATE_BYTES) throw new StateTooLargeError(`${filePath} would pass ${MAX_STATE_BYTES} bytes`);
      await writeFileAtomic(filePath, `${JSON.stringify(merged, null, 2)}\n`, { fsp });
    });
    queue = run.catch(() => {});
    return run;
  }

  /** For GET: waits for the saves already queued (a tab switching in reads the save that just went out), without `_seen`. */
  async function readForPage() {
    await queue;
    return forPage(await read());
  }

  /** Resolves once every save queued so far has finished (for a clean stop). */
  const settled = () => queue;

  return { desk, filePath, read, readForPage, write, settled, swept, sweptAgain, check: (value) => checkState(value, desk, { now }) };
}
