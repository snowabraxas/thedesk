// Shared by the desk contracts (feed-schema.js for Product Feed, news-schema.js for News):
// one ajv setup, reading an agent's JSON file without trusting it, turning ajv's errors into
// plain lines that point at the place ("stories[1].sources: needs at least 2 sources (has 1)"),
// and the checks a schema pattern can't make: real calendar dates, and https:// links that open
// the site they show, with no user name or password.
//
// Everything quoted from a file is escaped (controls, invisible and direction-changing characters)
// and cut short, and links are quoted with any user name and password hidden, so nothing in a file
// can drive the terminal, disguise a log line or leak a password into the-desk.log.
import fs from 'node:fs';
import { isIP } from 'node:net';
import Ajv2020Module from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

/** The ajv every contract uses: JSON Schema 2020-12, every error at once, strict about the schema itself. */
export function createAjv() {
  return new Ajv2020({ allErrors: true, strict: true });
}

export const MAX_FILE_BYTES = 1024 * 1024;

/** At most this many problems are listed for one file: plenty to fix, and a broken file can't flood the log. */
export const MAX_ERRORS = 100;

/**
 * A list longer than this is refused before ajv sees it. ajv runs with allErrors, so a runaway
 * list of 100,000 empty objects would otherwise be described item by item and block the server.
 * Every list it guards allows far fewer (News: 3, 7 and 8; Product Feed: 12 articles, 50 themes).
 */
export const GUARD_ITEMS = 50;

const TYPE_WORDS = {
  string: 'text',
  integer: 'a whole number',
  number: 'a number',
  array: 'a list',
  object: 'an object',
  boolean: 'true or false',
};

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Characters that can drive or disguise terminal and log output: C0 and C1 controls, DEL, and the
// invisible or direction-changing ones (Arabic letter mark, zero-width characters and bidi marks,
// line and paragraph separators, bidi embeddings, overrides and isolates, word joiners, BOM).
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const escapeUnsafe = (s) => s.replace(UNSAFE_TEXT, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Untrusted values are quoted with JSON.stringify, every unsafe character becomes a \u escape,
// and the result is cut short.
export function show(value, max = 60) {
  const s = JSON.stringify(value);
  return cut(escapeUnsafe(s === undefined ? String(value) : s), max);
}

// For text that may quote the file (a JSON.parse message does): unsafe characters become
// \u escapes, and it's cut short.
export function plain(text, max = 160) {
  return cut(escapeUnsafe(String(text)), max);
}

const unescapePointer = (part) => part.replace(/~1/g, '/').replace(/~0/g, '~');
const lastSegment = (instancePath) => unescapePointer(instancePath.split('/').at(-1));

// "/articles/2/url" -> "articles[2].url"; "" -> the root's name ("feed", "news", "breaking").
export function readablePath(instancePath, root) {
  if (!instancePath) return root;
  return instancePath
    .split('/')
    .slice(1)
    .map(unescapePointer)
    .reduce((out, part) => (/^\d+$/.test(part) ? `${out}[${part}]` : out ? `${out}.${part}` : part), '');
}

export function valueAt(root, instancePath) {
  if (!instancePath) return root;
  let node = root;
  for (const raw of instancePath.split('/').slice(1)) {
    if (node == null) return undefined;
    node = node[unescapePointer(raw)];
  }
  return node;
}

// ---- Links -------------------------------------------------------------------------------

const TAB_OR_NEWLINE = /[\t\n\r]/g;
const SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:/y;
const SLASHES = /[/\\]*/y;
const SITE_ENDS = new Set(['/', '\\', '?', '#']);

// Finds a link's user info the way a browser's URL parser does: tabs and newlines are dropped,
// then past leading spaces and the scheme it skips any run of / and \ (so "https:///u:p@x" and
// "https:\\u:p@x" count), the site part runs to the next / \ ? or #, and everything before the
// last @ in it is a user name and password, even when empty. Works for any scheme, or none, so a
// refused http:// or HTTPS:// link can still be quoted safely. Linear time, no regex backtracking.
// Returns the cleaned text, where the user info starts and where its @ is; or null.
function findUserInfo(raw) {
  const text = raw.replace(TAB_OR_NEWLINE, '');
  let start = 0;
  while (start < text.length && text.charCodeAt(start) <= 0x20) start++;
  SCHEME.lastIndex = start;
  if (SCHEME.test(text)) start = SCHEME.lastIndex;
  SLASHES.lastIndex = start;
  SLASHES.test(text);
  start = SLASHES.lastIndex;
  let end = start;
  while (end < text.length && !SITE_ENDS.has(text[end])) end++;
  const at = text.lastIndexOf('@', end - 1);
  return at >= start ? { text, start, at } : null;
}

/** A link with whatever comes before the site's "@" replaced by ***, so a password is never printed. Anything else comes back as it was. */
export function hideUserInfo(value) {
  if (typeof value !== 'string') return value;
  const found = findUserInfo(value);
  return found ? `${found.text.slice(0, found.start)}***${found.text.slice(found.at)}` : value;
}

/**
 * True when a link carries a user name or password before the site name: "https://user@host/",
 * "https://:secret@host/", even an empty "https://@host/" or "https:///@host/". Links like these
 * can make a page look like it's on one site while it opens another. An "@" later in the link
 * ("/@snow", "?by=a@b") is fine.
 */
export function hasUserInfo(value) {
  if (typeof value !== 'string') return false;
  if (findUserInfo(value)) return true;
  try {
    const url = new URL(value);
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
}

/** Quotes a link for a message: user info hidden, unsafe characters escaped, cut short. */
export const showLink = (value) => show(hideUserInfo(value));

// Never allowed in a link: spaces, controls, a backslash (a browser reads it as /, so the link
// opens somewhere other than it reads), and invisible or direction-changing characters.
const LINK_UNSAFE = /[\s\\\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

// The site as written: plain ASCII letters, digits, dots and dashes (xn-- punycode covers other
// alphabets), with an optional port.
const PLAIN_SITE = /^([A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/**
 * What's wrong with a link, as a word: "scheme" (doesn't start with https://, which the schema's
 * pattern reports), "userinfo", "whole" (doesn't parse, no site, spaces or hidden characters) or
 * "site" (the site the browser would open isn't the site as written: lookalike characters that
 * IDNA maps, like U+2215 for "/", a non-ASCII or percent-encoded name, or a numeric form like
 * 0x7f.1 or 2130706433; or it's an IP address). null when it's fine.
 */
function linkIssue(text) {
  if (typeof text !== 'string' || !text.startsWith('https://')) return 'scheme';
  if (hasUserInfo(text)) return 'userinfo';
  if (LINK_UNSAFE.test(text)) return 'whole';
  let url;
  try {
    url = new URL(text);
  } catch {
    return 'whole';
  }
  const rest = text.slice('https://'.length);
  const siteEnd = rest.search(/[/?#]/);
  const written = siteEnd === -1 ? rest : rest.slice(0, siteEnd);
  if (url.protocol !== 'https:' || url.hostname === '' || written === '') return 'whole';
  const site = PLAIN_SITE.exec(written);
  if (!site || site[1].toLowerCase() !== url.hostname || isIP(url.hostname) !== 0) return 'site';
  return null;
}

const LINK_WORDS = {
  userinfo: 'must not have a user name or password before the site name',
  whole: 'must be a whole link that starts with https://, with a site name and no spaces',
  site: 'must name its site in plain letters, digits, dots and dashes (xn-- for other alphabets), not as an IP address',
};

/** True for a link The Desk will show: https://, whole, no user info, and it opens the site it shows. */
export function isHttpsLink(text) {
  return linkIssue(text) === null;
}

/**
 * What's wrong with a link that starts with https://, as words with the link quoted safely, or
 * null when it's fine. A link that doesn't start with https:// is left to the schema's pattern,
 * so a value never gets two lines. User info is checked first, so a link with a password that is
 * also broken in another way still never prints the password.
 */
export function linkProblem(url) {
  const issue = linkIssue(url);
  if (issue === null || issue === 'scheme') return null;
  return `${LINK_WORDS[issue]} (got ${showLink(url)})`;
}

/** The page a link opens, for spotting the same source twice: the parsed link without its #fragment. Only for links isHttpsLink accepts. */
export function linkKey(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

// ---- Errors ------------------------------------------------------------------------------

// Fields that hold links: their values are quoted with any user name and password hidden.
const LINK_FIELDS = new Set(['url']);

/**
 * One ajv error as a plain line.
 * @param {object} error an ajv error
 * @param {unknown} data the value that was checked
 * @param {{ root: string, patterns?: Record<string, string>, nouns?: Record<string, { one: string, many: string, overflow?: string }> }} words
 *   root names the whole file; patterns turns a schema pattern into words; nouns names what a list
 *   holds (keyed by the list's field name), so "sources" says "needs at least 2 sources (has 1)"
 *   instead of "must have at least 2 items (it has 1)". overflow is a hint added when a list is too long.
 */
export function describeError(error, data, { root, patterns = {}, nouns = {} }) {
  const where = readablePath(error.instancePath, root);
  const p = error.params || {};
  const got = () => {
    const value = valueAt(data, error.instancePath);
    return LINK_FIELDS.has(lastSegment(error.instancePath)) ? showLink(value) : show(value);
  };
  switch (error.keyword) {
    case 'required':
      return `${where}: missing required field "${p.missingProperty}"`;
    case 'type':
      return `${where}: must be ${TYPE_WORDS[p.type] || p.type}`;
    case 'const':
      return `${where}: must be ${show(p.allowedValue)}`;
    case 'enum':
      return `${where}: must be one of ${p.allowedValues.map((v) => show(v)).join(', ')} (got ${got()})`;
    case 'pattern': {
      const words = patterns[p.pattern] || `must match the pattern ${p.pattern}`;
      return `${where}: ${words} (got ${got()})`;
    }
    // Say how long it is now, so the fix is obvious.
    case 'minLength':
    case 'maxLength': {
      const value = valueAt(data, error.instancePath);
      const has = typeof value === 'string' ? ` (it has ${[...value].length})` : '';
      if (error.keyword === 'minLength' && p.limit === 1) return `${where}: must not be empty`;
      return `${where}: must be at ${error.keyword === 'minLength' ? 'least' : 'most'} ${plural(p.limit, 'character')}${has}`;
    }
    case 'minItems':
    case 'maxItems': {
      const value = valueAt(data, error.instancePath);
      const noun = nouns[lastSegment(error.instancePath)];
      if (noun) {
        const count = (n) => `${n} ${n === 1 ? noun.one : noun.many}`;
        const has = Array.isArray(value) ? ` (has ${value.length})` : '';
        if (error.keyword === 'minItems') return `${where}: needs at least ${count(p.limit)}${has}`;
        return `${where}: can have at most ${count(p.limit)}${has}${noun.overflow ? `; ${noun.overflow}` : ''}`;
      }
      const has = Array.isArray(value) ? ` (it has ${value.length})` : '';
      if (error.keyword === 'minItems' && p.limit === 1) return `${where}: must not be empty`;
      return `${where}: must have at ${error.keyword === 'minItems' ? 'least' : 'most'} ${plural(p.limit, 'item')}${has}`;
    }
    default:
      return `${where}: ${String(error.message || 'is not allowed').replace(/must NOT/g, 'must not')}`;
  }
}

/** Runs a compiled schema and returns its errors as plain lines, each line once, at most MAX_ERRORS of them. */
export function schemaErrors(check, data, words) {
  if (check(data)) return [];
  const lines = new Set();
  for (const e of check.errors) {
    lines.add(describeError(e, data, words));
    if (lines.size >= MAX_ERRORS) break;
  }
  return [...lines];
}

/**
 * One line when a list is far too long to be worth checking item by item (over GUARD_ITEMS), else
 * null. The validators run this before ajv and stop there, so such a file costs almost nothing.
 */
export function tooLongError(list, where, max, noun) {
  if (!Array.isArray(list) || list.length <= GUARD_ITEMS) return null;
  return `${where}: far too long (${list.length} ${noun}); at most ${max} allowed, so nothing else was checked`;
}

/** The final list of problems for a file: at most MAX_ERRORS lines. */
export const capErrors = (lines) => lines.slice(0, MAX_ERRORS);

// ---- Dates -------------------------------------------------------------------------------

export const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a YYYY-MM-DD that is a day on the calendar: "2028-02-29" yes, "2026-02-30" and "2026-13-45" no. */
export function isCalendarDate(text) {
  const m = typeof text === 'string' && DATE_PARTS.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// The shape of an ISO 8601 date and time with a timezone: 2026-12-07T12:03:00-05:00 or 2026-12-07T17:03Z.
// Seconds and fractions of a second are optional. The schema uses the same pattern.
export const DATE_TIME_PARTS = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** True for a date-time in that shape that is a real moment: a calendar day, hours 0-23, minutes and seconds 0-59, offset at most 14:59. */
export function isDateTime(text) {
  const m = typeof text === 'string' && DATE_TIME_PARTS.exec(text);
  if (!m || !isCalendarDate(m[1])) return false;
  const [hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = m.slice(2);
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 && Number(offsetHour) <= 14 && Number(offsetMinute) <= 59;
}

// ---- Files -------------------------------------------------------------------------------

/** Only The Desk's own fallback may say "sample": an agent's file never can, so the key is dropped. */
export function withoutSample(value) {
  const { sample, ...rest } = value;
  return rest;
}

/**
 * Reads and parses a JSON file. Never throws.
 * @param {string} filePath
 * @param {{ maxBytes?: number, fsp?: typeof fs.promises }} [options] fsp lets tests count reads
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, errors: string[] }>}
 *   errors start with the file's path.
 */
export async function readJsonFile(filePath, { maxBytes = MAX_FILE_BYTES, fsp = fs.promises } = {}) {
  let text;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { ok: false, errors: [`${filePath}: not a file`] };
    if (stat.size > maxBytes) {
      return { ok: false, errors: [`${filePath}: too big (${stat.size} bytes, limit is ${maxBytes})`] };
    }
    text = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'file not found' : `can't read it (${err.code || err.message})`;
    return { ok: false, errors: [`${filePath}: ${reason}`] };
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\ufeff/, '')) };
  } catch (err) {
    return { ok: false, errors: [`${filePath}: not valid JSON (${plain(err.message)})`] };
  }
}
