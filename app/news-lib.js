// The News desk's pure logic: no DOM, no network. Imported by news.js in the browser and by the tests in Node.
//
// Everything in an edition or a breaking story is untrusted agent text. These functions only pass
// it through as plain strings (collapsed to one line, never markup); news.js escapes every one of
// them before it touches HTML, and links go through safeUrl.
import { DATE_TIME_PARTS, isCalendarDate, isDateTime, safeUrl } from './lib.js';

export const NEWS_TIME_ZONE = 'America/Toronto';
/** The contract's caps: 3 top stories, up to 7 on the shelf, up to 8 sources a story. */
export const MAX_STORIES = 3;
export const MAX_MORE = 7;
export const MAX_SOURCES = 8;
export const WORDS_PER_MINUTE = 200;
/** XP for reading a story, the same as an article on the Product Feed. */
export const READ_XP = 10;

export const REGION_LABEL = Object.freeze({ us: 'United States', china: 'China', eu: 'European Union', global: 'Global', other: 'Elsewhere' });
export const KIND_LABEL = Object.freeze({ launch: 'Launch', policy: 'Policy', research: 'Research', deal: 'Deal', event: 'Event' });
const REGION_ORDER = Object.keys(REGION_LABEL);
const KIND_ORDER = Object.keys(KIND_LABEL);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isPlainObject(o) && typeof k === 'string' && Object.hasOwn(o, k);
const list = (v) => (Array.isArray(v) ? v : []);

/** Agent text as one tidy line of plain text: strings and finite numbers only, whitespace collapsed. */
export function text(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/* ================= dates and keys (the same rules as server/state-store.js) ================= */

// isCalendarDate, isDateTime and DATE_TIME_PARTS live in lib.js (the state client needs them too).
export { DATE_TIME_PARTS, isCalendarDate, isDateTime };

const STORY_ID = /^[A-Za-z0-9_-]{1,40}$/;
const STORY_KEY = /^(\d{4}-\d{2}-\d{2})\/[A-Za-z0-9_-]{1,40}$/;

/**
 * The key a story is saved under: "<edition>/<story id>", like "2026-12-07/s1" (ids repeat every
 * morning). A story in The Desk's sample edition is "<edition>/sample-<id>", so reading the sample
 * never marks the agent's real stories of that day as read. null when the edition or id doesn't fit
 * the server's rule, so a key the server would refuse never reaches the saved state (one refused
 * key would stop every later save).
 */
export function storyKey(edition, id, { sample = false } = {}) {
  if (!isCalendarDate(edition) || typeof id !== 'string' || !STORY_ID.test(id)) return null;
  const key = `${edition}/${sample ? `sample-${id}` : id}`;
  return isStoryKey(key) ? key : null;
}
export function isStoryKey(k) {
  return typeof k === 'string' && STORY_KEY.test(k) && isCalendarDate(k.slice(0, 10));
}
const isTime = (v) => (typeof v === 'number' && Number.isFinite(v)) || isDateTime(v);

/* ================= Snow's News state ================= */

/** read and awarded: { "<edition>/<id>": time }; dismissed: { "<breaking at>": time }; shelfOpen: the shelf was left open. */
export const blankNewsState = () => ({ read: {}, dismissed: {}, shelfOpen: false, awarded: {} });

// Only entries the server accepts: one bad key would make every later PUT fail with a 400.
function timesWhere(value, isKey) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [k, time] of Object.entries(value)) if (isKey(k) && isTime(time)) out[k] = time;
  return out;
}

/**
 * Turns what GET /api/news/state answered into a usable state. Known keys are cleaned (entries the
 * server would refuse are dropped, a wrong type becomes blank); unknown keys are kept, so a newer
 * page's data isn't thrown away on save.
 */
export function normalizeNewsState(raw) {
  const N = blankNewsState();
  if (!isPlainObject(raw)) return N;
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'read' || k === 'awarded') N[k] = timesWhere(v, isStoryKey);
    else if (k === 'dismissed') N.dismissed = timesWhere(v, isDateTime);
    else if (k === 'shelfOpen') N.shelfOpen = v === true;
    else if (k !== '__proto__') N[k] = v;
  }
  return N;
}

/**
 * Folds the server's copy into this tab's state before paying for a read: `awarded` and `dismissed`
 * become the union of both, so a story another tab already paid for counts here. `read` and
 * `shelfOpen` stay this tab's, so un-marking still works. (Saves are merged on the server too:
 * server/state-store.js.)
 * @returns the local state, changed in place
 */
export function mergeNewsState(local, server) {
  for (const key of ['awarded', 'dismissed']) {
    if (!isPlainObject(local[key])) local[key] = {};
    const theirs = isPlainObject(server) && isPlainObject(server[key]) ? server[key] : {};
    for (const [k, time] of Object.entries(theirs)) if (!Object.hasOwn(local[key], k)) local[key][k] = time;
  }
  return local;
}

/**
 * Marks a story read, or unread if it was read. Reading pays XP once per story key, ever: the key
 * goes into `awarded` the first time, so un-marking and re-marking never pays twice.
 * canAward false (Snow's saved state couldn't be opened) marks it read without paying or recording.
 * @returns {{ read: boolean, award: boolean }} award: pay READ_XP now.
 */
export function toggleRead(N, key, { now = Date.now(), canAward = true } = {}) {
  if (!isStoryKey(key)) return { read: false, award: false };
  if (has(N.read, key)) {
    delete N.read[key];
    return { read: false, award: false };
  }
  return markStoryRead(N, key, { now, canAward });
}

/** Marks a story read (it stays read if it already was) and pays if it hasn't been paid. Same rules as toggleRead. */
export function markStoryRead(N, key, { now = Date.now(), canAward = true } = {}) {
  if (!isStoryKey(key)) return { read: false, award: false };
  if (!has(N.read, key)) N.read[key] = now;
  if (!isPlainObject(N.awarded)) N.awarded = {};
  const award = canAward && !has(N.awarded, key);
  if (award) N.awarded[key] = now;
  return { read: true, award };
}

/**
 * Marks a story read or unread like toggleRead, but before paying it checks the server's copy, so a
 * story another tab already paid for doesn't pay again here. Read or unread is decided when Snow
 * clicks: a reload that lands during the check can't turn "Mark read" into an un-mark. getState
 * returns the current state (the page may swap it for a reloaded one while the check is on its way).
 * peek() reads the server's copy ({ ok, state }); also() runs alongside it (the page picks up the
 * latest XP). If the copy can't be read, the story is marked read without paying.
 * @returns {Promise<{ read: boolean, award: boolean }>}
 */
export async function readStory(getState, key, { canPay = true, peek, also = async () => {} }) {
  if (!isStoryKey(key)) return { read: false, award: false };
  const N = getState();
  if (has(N.read, key)) return toggleRead(N, key);
  let pay = canPay && !has(N.awarded, key);
  if (pay) {
    const [server] = await Promise.all([peek(), also()]);
    if (server && server.ok) mergeNewsState(getState(), server.state);
    else pay = false;
  }
  return markStoryRead(getState(), key, { canAward: pay });
}

/* ================= reading time ================= */

const wordsIn = (v) => (text(v).match(/\S+/g) || []).length;

/** Minutes to read a story on the page (headline, summary, why, skeptic) at about 200 words a minute; at least 1. */
export function readingMinutes(story) {
  const s = isPlainObject(story) ? story : {};
  const words = wordsIn(s.headline) + wordsIn(s.summary) + wordsIn(s.why) + wordsIn(s.skeptic);
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/* ================= the edition as the page shows it ================= */

export const regionOf = (v) => (has(REGION_LABEL, v) ? v : 'other');
/** The kind as a label: the five kinds by name, anything else capitalised, nothing for none. */
export function kindLabel(v) {
  if (has(KIND_LABEL, v)) return KIND_LABEL[v];
  const t = text(v).slice(0, 30);
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** A story's sources: each with a name to show (never the link itself) and its link, or null when the link isn't safe. */
export function sourcesOf(sources) {
  return list(sources)
    .filter(isPlainObject)
    .slice(0, MAX_SOURCES)
    .map((src, i) => ({ name: text(src.name) || `Source ${i + 1}`, url: safeUrl(src.url) }));
}

const rankOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);

function storyView(raw, edition, read, sample) {
  const s = isPlainObject(raw) ? raw : {};
  const key = storyKey(edition, s.id, { sample });
  const region = regionOf(s.region);
  return {
    id: text(s.id),
    key,
    rank: rankOf(s.rank),
    headline: text(s.headline),
    summary: text(s.summary),
    why: text(s.why),
    skeptic: text(s.skeptic),
    region,
    regionLabel: REGION_LABEL[region],
    kind: has(KIND_LABEL, s.kind) ? s.kind : '',
    kindLabel: kindLabel(s.kind),
    minutes: readingMinutes(s),
    sources: sourcesOf(s.sources),
    read: key !== null && has(read, key),
  };
}

// Rank order; a story without a usable rank goes after the ranked ones, in the order it came.
function inRankOrder(stories, max) {
  const big = Number.MAX_SAFE_INTEGER;
  return stories
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.rank ?? big) - (b.s.rank ?? big) || a.i - b.i)
    .slice(0, max)
    .map(({ s }, i) => ({ ...s, position: i + 1 }));
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Everything the News page draws from an edition and Snow's News state.
 * - sample: The Desk's own sample edition (story keys are "<edition>/sample-<id>", and reading pays no XP)
 * - top: the top stories in rank order (at most 3), each with `position` (1, 2, 3: the number on its card)
 * - more: the shelf, in rank order (at most 7)
 * - readCount / total: top stories read, for "N of 3 read"; minutes / minutesLeft: reading time of the top stories
 * - glance: stories (top and shelf), sources (different source names), regions and kinds with counts
 * Every text field is plain text to escape; every source url is safe or null.
 */
export function buildNewsView(news, state) {
  const n = isPlainObject(news) ? news : {};
  const read = isPlainObject(state) && isPlainObject(state.read) ? state.read : {};
  const edition = isCalendarDate(n.edition) ? n.edition : '';
  const sample = n.sample === true;
  const top = inRankOrder(list(n.stories).map((s) => storyView(s, edition, read, sample)), MAX_STORIES);
  const more = inRankOrder(list(n.more).map((s) => storyView(s, edition, read, sample)), MAX_MORE);
  const all = [...top, ...more];

  const regions = REGION_ORDER.map((region) => ({ region, label: REGION_LABEL[region], count: all.filter((s) => s.region === region).length })).filter((r) => r.count);
  const most = Math.max(1, ...regions.map((r) => r.count));
  const kinds = new Map();
  for (const s of all) if (s.kindLabel) kinds.set(s.kindLabel, { kind: s.kind, label: s.kindLabel, count: (kinds.get(s.kindLabel)?.count || 0) + 1 });
  const kindRank = (k) => (KIND_ORDER.includes(k.kind) ? KIND_ORDER.indexOf(k.kind) : KIND_ORDER.length);

  return {
    edition,
    sample,
    note: text(n.note),
    top,
    more,
    total: top.length,
    readCount: top.filter((s) => s.read).length,
    minutes: sum(top.map((s) => s.minutes)),
    minutesLeft: sum(top.filter((s) => !s.read).map((s) => s.minutes)),
    glance: {
      stories: all.length,
      sources: new Set(all.flatMap((s) => s.sources.map((src) => src.name.toLowerCase()))).size,
      regions: regions.map((r) => ({ ...r, share: r.count / most })),
      kinds: [...kinds.values()].sort((a, b) => b.count - a.count || kindRank(a) - kindRank(b)),
    },
  };
}

/* ================= the words at the top ================= */

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const numberWord = (n) => NUMBER_WORDS[n] ?? String(n);
const minutesText = (m) => `about ${m} minute${m === 1 ? '' : 's'}`;

/**
 * Wila's one line, from the top stories and what Snow has read:
 * "Three stories today, about 4 minutes." / "Two left, about 3 minutes." / "All three read. You're up to date."
 */
export function newsLine(view) {
  const { total = 0, readCount = 0, minutes = 0, minutesLeft = 0 } = isPlainObject(view) ? view : {};
  if (!total) return 'No top stories in this edition.';
  if (!readCount) return `${numberWord(total)} ${total === 1 ? 'story' : 'stories'} today, ${minutesText(minutes)}.`;
  if (readCount < total) return `${numberWord(total - readCount)} left, ${minutesText(minutesLeft)}.`;
  return total === 1 ? "Today's story is read. You're up to date." : `All ${numberWord(total).toLowerCase()} read. You're up to date.`;
}

const hourFormat = new Intl.DateTimeFormat('en-CA', { timeZone: NEWS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function torontoClock(ms) {
  const p = Object.fromEntries(hourFormat.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return { hour: Number(p.hour) % 24, hh: String(Number(p.hour) % 24).padStart(2, '0'), mm: p.minute };
}

/** "Good morning, Snow" (5:00 to 11:59 in Toronto), "Good afternoon" (to 16:59), "Good evening" (to 23:59), "Hello" overnight. */
export function greeting(now = new Date()) {
  const { hour } = torontoClock(now.valueOf());
  if (hour >= 5 && hour < 12) return 'Good morning, Snow';
  if (hour >= 12 && hour < 17) return 'Good afternoon, Snow';
  if (hour >= 17) return 'Good evening, Snow';
  return 'Hello, Snow';
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
/** "Monday 7 December · Morning edition"; just "Morning edition" without a usable date. */
export function editionLine(edition) {
  if (!isCalendarDate(edition)) return 'Morning edition';
  const [y, m, d] = edition.split('-').map(Number);
  const p = Object.fromEntries(dayFormat.formatToParts(new Date(Date.UTC(y, m - 1, d, 12))).map(({ type, value }) => [type, value]));
  return `${p.weekday} ${p.day} ${p.month} · Morning edition`;
}

/* ================= breaking ================= */

/** True when there is a breaking story to show: it has a real `at` and a headline, and Snow hasn't dismissed that `at`. */
export function isBreakingVisible(breaking, state) {
  if (!isPlainObject(breaking) || !isDateTime(breaking.at) || !text(breaking.headline)) return false;
  return !has(isPlainObject(state) ? state.dismissed : null, breaking.at);
}

/** "12:04": the breaking story's time on a Toronto clock (24-hour). '' when `at` isn't a real moment. */
export function breakingTime(at) {
  if (!isDateTime(at)) return '';
  const { hh, mm } = torontoClock(Date.parse(at));
  return `${hh}:${mm}`;
}

/** The breaking story as the banner shows it: time, headline, and its first source with a safe link (or null). */
export function breakingView(breaking) {
  const b = isPlainObject(breaking) ? breaking : {};
  const [first = null] = sourcesOf(b.sources);
  return { at: typeof b.at === 'string' ? b.at : '', time: breakingTime(b.at), headline: text(b.headline), source: first };
}

/** Dismisses a breaking story for good: dismissed[at] = now. Returns false when there was nothing to dismiss. */
export function dismissBreaking(N, at, now = Date.now()) {
  if (!isDateTime(at) || has(N.dismissed, at)) return false;
  N.dismissed[at] = now;
  return true;
}

/* ================= for the TV in the room (N5) ================= */

/**
 * What the TV shows in the room: unread top stories in the edition, and whether a breaking story
 * is waiting that Snow hasn't dismissed. sample: the edition is The Desk's sample, not the agent's.
 * @returns {{ unread: number, total: number, breaking: boolean, sample: boolean }}
 */
export function tvSignals(news, breaking, state) {
  const v = buildNewsView(news, state);
  return { unread: v.total - v.readCount, total: v.total, breaking: isBreakingVisible(breaking, state), sample: v.sample };
}
