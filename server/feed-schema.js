// The feed contract: checks a Product Feed edition against data/schema/feed.schema.json,
// plus the rules the schema's patterns don't cover: dates are real calendar days (no 2026-02-30),
// article links are whole https:// links that open the site they show, with no user name or password,
// article and theme ids are unique, and every theme an article uses must be in the edition's themes list.
// A far too long articles, themes or article themes list is refused before ajv runs, so a runaway
// file is cheap to check.
// Used by `npm run validate-feed` (the agent runs it) and by the server before it serves an edition.
// The shared pieces (ajv setup, error wording, date and link checks) live in schema-common.js.
import fs from 'node:fs';
import { SCHEMA_PATH } from './config.js';
import {
  DATE_PARTS,
  MAX_FILE_BYTES,
  capErrors,
  createAjv,
  isCalendarDate,
  isHttpsLink,
  linkProblem,
  readJsonFile,
  schemaErrors,
  show,
  tooLongError,
} from './schema-common.js';

export { isCalendarDate, isHttpsLink };

export const MAX_FEED_BYTES = MAX_FILE_BYTES;

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const checkSchema = createAjv().compile(schema);
const ARTICLE_THEMES_MAX = schema.properties.articles.items.properties.themes.maxItems;

const WORDS = {
  root: 'feed',
  patterns: {
    '^https://': 'must start with https://',
    '^\\d{4}-\\d{2}-\\d{2}$': 'must be a date like YYYY-MM-DD',
    '^(\\d{4}-\\d{2}-\\d{2})?$': 'must be a date like YYYY-MM-DD, or empty',
    '^(?!(?:constructor|prototype)$)[a-z0-9-]{1,40}$': 'must be 1 to 40 lowercase letters, digits or dashes',
    '^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{1,64}$': 'must be 1 to 64 letters, digits, dashes or underscores',
  },
};

// Only values that already passed the schema's pattern are checked here, so a value is never
// reported twice (a "27 Nov" edition or an http:// link already has its line).
function calendarAndLinkErrors(feed) {
  const errors = [];
  if (typeof feed.edition === 'string' && DATE_PARTS.test(feed.edition) && !isCalendarDate(feed.edition)) {
    errors.push(`edition: must be a real calendar date like YYYY-MM-DD (got ${show(feed.edition)})`);
  }
  if (!Array.isArray(feed.articles)) return errors;
  feed.articles.forEach((article, i) => {
    if (!article || typeof article !== 'object') return;
    const { date, url } = article;
    if (typeof date === 'string' && DATE_PARTS.test(date) && !isCalendarDate(date)) {
      errors.push(`articles[${i}].date: must be a real calendar date like YYYY-MM-DD, or empty (got ${show(date)})`);
    }
    const problem = linkProblem(url);
    if (problem) errors.push(`articles[${i}].url: ${problem}`);
  });
  return errors;
}

// Names the second (and later) use of an id: "articles[3].id: duplicate id "a1" (also used by articles[0])".
function duplicateIds(list, listName) {
  if (!Array.isArray(list)) return [];
  const firstSeen = new Map();
  const errors = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') return;
    if (firstSeen.has(item.id)) {
      errors.push(`${listName}[${i}].id: duplicate id ${show(item.id)} (also used by ${listName}[${firstSeen.get(item.id)}])`);
    } else {
      firstSeen.set(item.id, i);
    }
  });
  return errors;
}

// An article may only use themes the edition lists, so The Desk can name and map them.
function unknownThemeErrors(feed) {
  if (!Array.isArray(feed.themes) || !Array.isArray(feed.articles)) return [];
  const known = new Set(feed.themes.filter((t) => t && typeof t.id === 'string').map((t) => t.id));
  const errors = [];
  feed.articles.forEach((article, i) => {
    if (!article || typeof article !== 'object' || !Array.isArray(article.themes)) return;
    article.themes.forEach((id, j) => {
      if (typeof id === 'string' && !known.has(id)) {
        errors.push(`articles[${i}].themes[${j}]: ${show(id)} is not in the themes list (add it to themes first, or use one that is)`);
      }
    });
  });
  return errors;
}

/**
 * Checks a parsed feed object. Never throws.
 * @returns {{ ok: boolean, errors: string[] }} errors are short, readable lines, at most MAX_ERRORS.
 */
export function validateFeed(feed) {
  if (feed === null || typeof feed !== 'object' || Array.isArray(feed)) {
    return { ok: false, errors: ['feed: must be a JSON object'] };
  }
  const guarded = [
    tooLongError(feed.articles, 'articles', schema.properties.articles.maxItems, 'articles'),
    tooLongError(feed.themes, 'themes', schema.properties.themes.maxItems, 'themes'),
  ].filter(Boolean);
  // Only once articles is short enough to walk: each article's own themes list (the theme map
  // draws a line for every pair, so a huge list would freeze the page).
  if (!guarded.length && Array.isArray(feed.articles)) {
    feed.articles.forEach((article, i) => {
      const line = article && typeof article === 'object' && tooLongError(article.themes, `articles[${i}].themes`, ARTICLE_THEMES_MAX, 'themes');
      if (line) guarded.push(line);
    });
  }
  if (guarded.length) return { ok: false, errors: guarded };
  const errors = capErrors([
    // A News edition checked here by mistake: say which command to run instead.
    ...(feed.desk === 'news' ? ['this looks like a News file: run npm run validate-news'] : []),
    ...schemaErrors(checkSchema, feed, WORDS),
    ...calendarAndLinkErrors(feed),
    ...duplicateIds(feed.themes, 'themes'),
    ...duplicateIds(feed.articles, 'articles'),
    ...unknownThemeErrors(feed),
  ]);
  return { ok: errors.length === 0, errors };
}

/**
 * Reads, parses and checks a feed file. Never throws.
 * @param {string} filePath
 * @param {{ maxBytes?: number, fsp?: typeof fs.promises }} [options] fsp lets tests count reads
 * @returns {Promise<{ ok: boolean, errors: string[], feed?: object, bytes?: Buffer }>} bytes is the
 *   file exactly as read (the server keeps a copy of a valid one).
 */
export async function checkFeedFile(filePath, { maxBytes = MAX_FEED_BYTES, fsp = fs.promises } = {}) {
  const read = await readJsonFile(filePath, { maxBytes, fsp });
  if (!read.ok) return read;
  const result = validateFeed(read.value);
  return result.ok ? { ...result, feed: read.value, bytes: read.bytes } : result;
}
