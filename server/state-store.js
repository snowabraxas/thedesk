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
// earlier. awarded (both desks) and dismissed (News) are unions; badges a union keeping the earliest
// time; days a union, sorted, the last 120; xp is added as a change from the value the page last
// synced (`_sync.xp`, stripped before saving), or the larger of the two for a page that sends none.
// Folders, saved items, notes, reads and the shelf stay last-save-wins.
import fs from 'node:fs';
import { writeFileAtomic } from './atomic-file.js';
import { statePath } from './config.js';
import { isCalendarDate, isDateTime, jsonErrorText, show } from './schema-common.js';

export const MAX_STATE_BYTES = 1024 * 1024;

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

/**
 * The keys each desk's state knows about and the rule each must follow. Other keys pass through
 * untouched, so a newer page can add one without the server refusing it.
 * XP and the streak live in Product Feed's state only; the News page adds to them there.
 */
export const STATE_RULES = {
  'product-feed': {
    read: ofType('an object', isPlainObject),
    saved: ofType('an object', isPlainObject),
    folders: ofType('a list', Array.isArray),
    notes: ofType('a list', Array.isArray),
    xp: ofType('a number', (v) => typeof v === 'number' && Number.isFinite(v)),
    days: ofType('a list', Array.isArray),
    badges: ofType('an object', isPlainObject),
    // Articles already paid XP for reading: { "<article id>": time }.
    awarded: ofType('an object', isPlainObject),
    // Not saved: the XP this page last synced with the server, so a save adds its own XP to the latest total.
    _sync: ofType('an object like { "xp": 40 }', (v) => isPlainObject(v) && (v.xp === undefined || (typeof v.xp === 'number' && Number.isFinite(v.xp)))),
  },
  news: {
    read: timesKeyedBy('"<edition>/<story id>", like "2026-12-07/s1"', isStoryKey),
    dismissed: timesKeyedBy(`the breaking story's "at", like "2026-12-07T12:04:00-05:00"`, isDateTime),
    shelfOpen: ofType('true or false', (v) => typeof v === 'boolean'),
    awarded: timesKeyedBy('"<edition>/<story id>", like "2026-12-07/s1"', isStoryKey),
  },
};

// ---- Merging a save into the file as it is now ----------------------------------------------

const timeValue = (t) => (typeof t === 'number' ? t : Date.parse(t));

/**
 * { key: time } maps as a union; a key in both keeps the earlier time (the file's, when the two can't
 * be compared). Only one side an object: that one. Neither: the incoming value as it is.
 */
function unionTimes(current, incoming) {
  if (!isPlainObject(current)) return incoming;
  if (!isPlainObject(incoming)) return { ...current };
  const out = { ...incoming };
  for (const [k, time] of Object.entries(current)) {
    if (k === '__proto__') continue;
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

/** The streak's days as a union of both lists: day strings only, each once, sorted, the last 120. */
function unionDays(current, incoming) {
  if (!Array.isArray(current) && !Array.isArray(incoming)) return incoming;
  const days = new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])].filter((d) => typeof d === 'string'));
  return [...days].sort().slice(-120);
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * XP after a save. With a base (the XP the page last synced), the page's own change is added to
 * what is saved now, and XP never goes down through a save. Without one (a page from before this
 * rule), the larger of the two. Nothing saved yet: the page's XP.
 */
export function mergeXp(current, incoming, base) {
  if (!isNumber(incoming)) return current;
  if (!isNumber(current)) return Math.max(0, incoming);
  if (isNumber(base)) return current + Math.max(0, incoming - base);
  return Math.max(current, incoming);
}

/**
 * The state to save: the incoming one, with what can only grow folded in from the file as it is now.
 * Keys neither side has stay absent. `_sync` is never saved.
 * @param {string} desk "product-feed" or "news"
 */
export function mergeIncoming(desk, current, incoming) {
  const cur = isPlainObject(current) ? current : {};
  const { _sync: sync, ...next } = incoming;
  const fold = (key, how) => {
    if (Object.hasOwn(cur, key) || Object.hasOwn(next, key)) {
      const value = how(cur[key], next[key]);
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
  };
  fold('awarded', unionTimes);
  if (desk === 'news') fold('dismissed', unionTimes);
  if (desk === 'product-feed') {
    fold('badges', unionTimes);
    fold('days', unionDays);
    fold('xp', (a, b) => mergeXp(a, b, isPlainObject(sync) ? sync.xp : undefined));
  }
  return next;
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
export function checkState(value, desk = 'product-feed') {
  if (!isPlainObject(value)) return { ok: false, error: 'state must be a JSON object' };
  for (const [key, rule] of Object.entries(STATE_RULES[desk])) {
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
 * @param {{ fsp?: typeof fs.promises }} [options] fsp lets tests make a step fail
 * @returns {{ desk: string, filePath: string, read: () => Promise<object>, write: (value: object) => Promise<void>, check: (value: unknown) => { ok: boolean, error?: string } }}
 */
export function createStateStore(deskHome, desk, { fsp = fs.promises } = {}) {
  if (!Object.hasOwn(STATE_RULES, desk)) throw new Error(`The Desk keeps no state for a desk called ${show(desk)}`);
  const filePath = statePath(deskHome, desk);
  let queue = Promise.resolve();

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
      const merged = mergeIncoming(desk, await read(), value);
      // The cap is on the state itself (as the page sends it), not on the file's indentation.
      if (Buffer.byteLength(JSON.stringify(merged)) > MAX_STATE_BYTES) throw new StateTooLargeError(`${filePath} would pass ${MAX_STATE_BYTES} bytes`);
      await writeFileAtomic(filePath, `${JSON.stringify(merged, null, 2)}\n`, { fsp });
    });
    queue = run.catch(() => {});
    return run;
  }

  return { desk, filePath, read, write, check: (value) => checkState(value, desk) };
}
