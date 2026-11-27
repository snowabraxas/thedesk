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
// Folders, saved items, notes, reads and the shelf stay last-save-wins (News reads capped at 2000).
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

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A rule takes a key's value and its name, and says what's wrong ("xp must be a number") or null.
const ofType = (words, test) => (value, key) => (test(value) ? null : `${key} must be ${words}`);

// When something happened: an ISO time ("2026-12-07T13:05:00.000Z", what toISOString() gives) or
// a number (Date.now() milliseconds, as Product Feed stores them).
const isTime = (v) => (typeof v === 'number' && Number.isFinite(v)) || isDateTime(v);

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

/** An object of times under keys that name something (an article, a badge): non-empty, up to 200 characters. */
const timesByName = timesKeyedBy('names up to 200 characters', (k) => k.length > 0 && k.length <= 200);

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
      saved: ofType('an object', isPlainObject),
      folders: ofType('a list', Array.isArray),
      notes: ofType('a list', Array.isArray),
      xp: ofType(`a number from 0 to ${Number.MAX_SAFE_INTEGER}`, isXp),
      days: streakDays(now),
      badges: timesByName,
      // Articles already paid XP for reading: { "<article id>": time }.
      awarded: timesByName,
      // Not saved: what the page last synced, so a save adds only its own XP (and only once).
      _sync: syncRule,
    },
    news: {
      read: timesKeyedBy('"<edition>/<story id>", like "2026-12-07/s1"', isStoryKey),
      dismissed: timesKeyedBy(`the breaking story's "at", like "2026-12-07T12:04:00-05:00"`, isDateTime),
      shelfOpen: ofType('true or false', (v) => typeof v === 'boolean'),
      awarded: timesKeyedBy('"<edition>/<story id>", like "2026-12-07/s1"', isStoryKey),
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
  if (!isPlainObject(current)) return incoming;
  if (!isPlainObject(incoming)) return Object.fromEntries(Object.entries(current).filter(([k, t]) => k !== '__proto__' && isTime(t)));
  const out = { ...incoming };
  for (const [k, time] of Object.entries(current)) {
    if (k === '__proto__' || !isTime(time)) continue;
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

/** The newest MAX_SEEN_TABS tabs' high-water marks, with this tab's set to what it sent. */
function updateSeen(seen, tab, sent, now) {
  const out = Object.fromEntries(Object.entries(isPlainObject(seen) ? seen : {}).filter(([k]) => isTabId(k)));
  const prior = isPlainObject(out[tab]) && isNumber(out[tab].xp) ? out[tab].xp : -Infinity;
  out[tab] = { xp: Math.max(prior, sent), at: now };
  const entries = Object.entries(out).filter(([, v]) => isPlainObject(v) && isNumber(v.xp) && isNumber(v.at));
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SEEN_TABS));
}

/**
 * The state to save: the incoming one, with what can only grow folded in from the file as it is now.
 * Keys neither side has stay absent. `_sync` is never saved; `_seen` is the server's own (a page's
 * copy is ignored).
 * @param {string} desk "product-feed" or "news"
 * @param {{ now?: number }} [options] the time recorded for a tab's high-water mark
 */
export function mergeIncoming(desk, current, incoming, { now = Date.now() } = {}) {
  const cur = isPlainObject(current) ? current : {};
  const { _sync: sync, _seen: ignored, ...next } = incoming;
  const fold = (key, how) => {
    if (Object.hasOwn(cur, key) || Object.hasOwn(next, key)) {
      const value = how(cur[key], next[key]);
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
  };
  fold('awarded', (a, b) => newest(unionTimes(a, b)));
  if (desk === 'news') {
    fold('dismissed', (a, b) => newest(unionTimes(a, b)));
    if (isPlainObject(next.read)) next.read = newest(next.read);
  }
  if (desk === 'product-feed') {
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
  return next;
}

/** What a page gets back from GET: the state without the server's own bookkeeping (`_seen`). */
export function forPage(state) {
  if (!isPlainObject(state)) return state;
  const { _seen: ignored, ...rest } = state;
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
 * @param {{ fsp?: typeof fs.promises, now?: () => number }} [options] fsp lets tests make a step fail; now is the clock
 * @returns {{ desk: string, filePath: string, read: () => Promise<object>, readForPage: () => Promise<object>, write: (value: object) => Promise<void>, settled: () => Promise<void>, swept: Promise<number>, check: (value: unknown) => { ok: boolean, error?: string } }}
 */
export function createStateStore(deskHome, desk, { fsp = fs.promises, now = Date.now } = {}) {
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

  return { desk, filePath, read, readForPage, write, settled, swept, check: (value) => checkState(value, desk, { now }) };
}
