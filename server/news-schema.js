// The News contract: checks the News agent's files against data/schema/news.schema.json
// (the morning edition: news.json, and its copies in editions/YYYY-MM-DD.json) and
// data/schema/breaking.schema.json (breaking.json: one story in the same shape, plus `at`),
// plus the rules a schema can't say:
//   - fewer than 3 stories needs a note saying why;
//   - story ids are unique across stories and more, and ranks are unique across the edition;
//   - dates are real calendar days, and `at` is a real moment;
//   - every source link is a whole https:// link with a site name, no spaces and no user name or password.
// Like Product Feed, only The Desk may mark something as a sample: a valid file comes back with
// any "sample" key removed (the schema allows extra keys, so it never fails because of one).
// Used by `npm run validate-news` (the agent runs it) and, from N3, by the server.
import fs from 'node:fs';
import path from 'node:path';
import { BREAKING_SCHEMA_PATH, NEWS_SCHEMA_PATH } from './config.js';
import {
  DATE_PARTS,
  DATE_TIME_PARTS,
  MAX_FILE_BYTES,
  createAjv,
  isCalendarDate,
  isDateTime,
  linkProblem,
  readJsonFile,
  schemaErrors,
  show,
  withoutSample,
} from './schema-common.js';

export const MAX_NEWS_BYTES = MAX_FILE_BYTES;

/** How many stories a full edition has in `stories`. Fewer needs a note. */
export const TOP_STORIES = 3;

const readSchema = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// breaking.schema.json borrows the story from news.schema.json ("news.schema.json#/$defs/story"),
// so the news schema is registered first.
const ajv = createAjv();
const newsSchema = readSchema(NEWS_SCHEMA_PATH);
ajv.addSchema(newsSchema);
const checkNewsSchema = ajv.getSchema(newsSchema.$id);
const checkBreakingSchema = ajv.compile(readSchema(BREAKING_SCHEMA_PATH));

const PATTERNS = {
  '^https://': 'must start with https://',
  '^\\d{4}-\\d{2}-\\d{2}$': 'must be a date like YYYY-MM-DD',
  '^(\\d{4}-\\d{2}-\\d{2})?$': 'must be a date like YYYY-MM-DD, or empty',
  '^[A-Za-z0-9_-]{1,40}$': 'must be 1 to 40 letters, digits, dashes or underscores',
  '\\S': 'must not be empty or only spaces',
  [DATE_TIME_PARTS.source]: 'must be a date and time with a timezone, like 2026-12-07T12:04:00-05:00 or 2026-12-07T17:04:00Z',
};

const NOUNS = {
  stories: { one: 'story', many: 'stories', overflow: 'the top 3 go in stories, up to 7 more in more' },
  more: { one: 'story', many: 'stories', overflow: 'leave the weakest out' },
  sources: { one: 'source', many: 'sources' },
};

const NEWS_WORDS = { root: 'news', patterns: PATTERNS, nouns: NOUNS };
const BREAKING_WORDS = { root: 'breaking', patterns: PATTERNS, nouns: NOUNS };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Only values that already passed the schema's pattern are checked here, so a value is never
// reported twice (a "7 Dec" date or an http:// link already has its line).

// Dates and links inside one story. `where` is "stories[0]", or "" in breaking.json, where the story is the file.
function storyErrors(story, where) {
  if (!isObject(story)) return [];
  const at = (field) => (where ? `${where}.${field}` : field);
  const errors = [];
  if (typeof story.date === 'string' && DATE_PARTS.test(story.date) && !isCalendarDate(story.date)) {
    errors.push(`${at('date')}: must be a real calendar date like YYYY-MM-DD, or empty (got ${show(story.date)})`);
  }
  if (Array.isArray(story.sources)) {
    story.sources.forEach((source, i) => {
      const problem = isObject(source) ? linkProblem(source.url) : null;
      if (problem) errors.push(`${at(`sources[${i}].url`)}: ${problem}`);
    });
  }
  return errors;
}

// Every story in the edition with its place: stories first, then more.
function placedStories(news) {
  const placed = [];
  for (const list of ['stories', 'more']) {
    if (Array.isArray(news[list])) news[list].forEach((story, i) => placed.push({ story, where: `${list}[${i}]` }));
  }
  return placed;
}

// Names the second (and later) use: "more[0].id: duplicate id "s1" (also used by stories[0])".
function duplicates(placed, field, isKey) {
  const firstSeen = new Map();
  const errors = [];
  for (const { story, where } of placed) {
    if (!isObject(story) || !isKey(story[field])) continue;
    const value = story[field];
    if (firstSeen.has(value)) errors.push(`${where}.${field}: duplicate ${field} ${show(value)} (also used by ${firstSeen.get(value)})`);
    else firstSeen.set(value, where);
  }
  return errors;
}

// An edition has 3 stories unless the note says why not. A note that isn't text already has its line.
function noteErrors(news) {
  if (!Array.isArray(news.stories) || news.stories.length >= TOP_STORIES) return [];
  if (news.note !== undefined && typeof news.note !== 'string') return [];
  if ((news.note ?? '').trim() !== '') return [];
  return [`note: must say why there are fewer than ${TOP_STORIES} stories (stories has ${news.stories.length})`];
}

function editionDateErrors(edition) {
  if (typeof edition === 'string' && DATE_PARTS.test(edition) && !isCalendarDate(edition)) {
    return [`edition: must be a real calendar date like YYYY-MM-DD (got ${show(edition)})`];
  }
  return [];
}

function foundAtErrors(at) {
  if (typeof at === 'string' && DATE_TIME_PARTS.test(at) && !isDateTime(at)) {
    return [`at: must be a real date and time, like 2026-12-07T12:04:00-05:00 (got ${show(at)})`];
  }
  return [];
}

/**
 * Checks a parsed morning edition (news.json). Never throws.
 * @returns {{ ok: boolean, errors: string[] }} errors are short, readable lines.
 */
export function validateNews(news) {
  if (!isObject(news)) return { ok: false, errors: ['news: must be a JSON object'] };
  const placed = placedStories(news);
  const errors = [
    ...schemaErrors(checkNewsSchema, news, NEWS_WORDS),
    ...editionDateErrors(news.edition),
    ...noteErrors(news),
    ...placed.flatMap(({ story, where }) => storyErrors(story, where)),
    ...duplicates(placed, 'id', (v) => typeof v === 'string'),
    ...duplicates(placed, 'rank', Number.isInteger),
  ];
  return { ok: errors.length === 0, errors };
}

/**
 * Checks a parsed breaking story (breaking.json). Never throws.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBreaking(story) {
  if (!isObject(story)) return { ok: false, errors: ['breaking: must be a JSON object'] };
  const errors = [...schemaErrors(checkBreakingSchema, story, BREAKING_WORDS), ...foundAtErrors(story.at), ...storyErrors(story, '')];
  return { ok: errors.length === 0, errors };
}

/** True when a file is a breaking story rather than an edition: it's named breaking.json, or it has `at`. */
export function isBreakingFile(filePath, value) {
  if (path.basename(String(filePath)).toLowerCase() === 'breaking.json') return true;
  return isObject(value) && Object.hasOwn(value, 'at');
}

// A valid file comes back under its kind ("news" or "breaking"), without any "sample" key.
function checkValue(value, kind) {
  const result = kind === 'breaking' ? validateBreaking(value) : validateNews(value);
  return result.ok ? { ...result, [kind]: withoutSample(value) } : result;
}

const readNewsFile = (filePath, options) => readJsonFile(filePath, { maxBytes: MAX_NEWS_BYTES, ...options });

async function checkFile(filePath, kind, options) {
  const read = await readNewsFile(filePath, options);
  return read.ok ? checkValue(read.value, kind) : read;
}

/**
 * Reads, parses and checks a morning edition file. Never throws.
 * @param {string} filePath
 * @param {{ maxBytes?: number, fsp?: typeof fs.promises }} [options]
 * @returns {Promise<{ ok: boolean, errors: string[], news?: object }>} news has any "sample" key removed.
 */
export function checkNewsFile(filePath, options = {}) {
  return checkFile(filePath, 'news', options);
}

/**
 * Reads, parses and checks a breaking story file. Never throws.
 * @returns {Promise<{ ok: boolean, errors: string[], breaking?: object }>} breaking has any "sample" key removed.
 */
export function checkBreakingFile(filePath, options = {}) {
  return checkFile(filePath, 'breaking', options);
}

/**
 * For the CLI: checks a News desk file as a breaking story or as an edition, whichever it is
 * (see isBreakingFile). A file that can't be read or parsed counts as breaking only by its name.
 * @returns {Promise<{ ok: boolean, errors: string[], kind: 'news' | 'breaking', news?: object, breaking?: object }>}
 */
export async function checkNewsDeskFile(filePath, options = {}) {
  const read = await readNewsFile(filePath, options);
  const kind = isBreakingFile(filePath, read.ok ? read.value : undefined) ? 'breaking' : 'news';
  return { ...(read.ok ? checkValue(read.value, kind) : read), kind };
}
