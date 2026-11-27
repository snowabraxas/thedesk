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

// Characters that can drive or disguise terminal and log output, by Unicode property: controls
// (C0, DEL, C1), format characters (bidi marks, embeddings, overrides and isolates, zero-width
// characters, soft hyphen, tag characters, BOM), lone surrogates, line and paragraph separators,
// and every default-ignorable code point (variation selectors, Hangul fillers and the like).
const UNSAFE_CLASS = String.raw`\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}`;
const UNSAFE_TEXT = new RegExp(`[${UNSAFE_CLASS}]`, 'gu');

/**
 * A schema pattern for "has at least one character you can see": not a space, not one of the
 * unsafe characters above, not a combining mark (\p{M}) or private-use character (\p{Co}), and not
 * one of the blank-looking symbols: U+2800 braille blank, U+3164, U+FFA0, U+115F and U+1160
 * Hangul fillers, U+1D159 null notehead. A text field with none of those counts as empty.
 */
export const VISIBLE_CHAR_PATTERN = String.raw`[^\s` + UNSAFE_CLASS + String.raw`\p{M}\p{Co}\u{2800}\u{3164}\u{ffa0}\u{115f}\u{1160}\u{1d159}]`;
const VISIBLE_CHAR = new RegExp(VISIBLE_CHAR_PATTERN, 'u');

/** True for text with nothing you can see in it: empty, spaces, invisible characters, marks or blank-looking symbols only. */
export const isBlank = (text) => !VISIBLE_CHAR.test(text);

// Each unsafe character becomes an escape by code point: \u00ad, or \u{e0041} beyond the BMP.
const escapeUnsafe = (s) =>
  s.replace(UNSAFE_TEXT, (c) => {
    const point = c.codePointAt(0);
    return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`;
  });

// Cuts to at most `max` code points (never half of a surrogate pair), ending with "…" when cut.
function cut(s, max) {
  if (s.length <= max) return s;
  const points = Array.from(s.length > 2 * max ? s.slice(0, 2 * max) : s);
  if (s.length <= 2 * max && points.length <= max) return s;
  return `${points.slice(0, max - 1).join('')}…`;
}

// Untrusted values are quoted with JSON.stringify, with the user info of anything link-like
// hidden (see hideUserInfo), every unsafe character escaped, and the result cut short.
export function show(value, max = 60) {
  const s = typeof value === 'string' ? JSON.stringify(hideUserInfo(value)) : hideUserInfo(JSON.stringify(value));
  return cut(escapeUnsafe(s === undefined ? String(value) : s), max);
}

// For text that isn't a quoted value (a path, a JSON.parse message): unsafe characters escaped,
// cut short. Pass max = Infinity to keep it whole.
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

// For deciding whether a link has user info (hideUserInfo is the broader one for quoting).
// Finds a link's user info the way a browser's URL parser does: tabs and newlines are dropped,
// then past leading spaces and the scheme it skips any run of / and \ (so "https:///u:p@x" and
// "https:\\u:p@x" count), the site part runs to the next / \ ? or #, and everything before the
// last @ in it is a user name and password, even when empty. Linear time, no regex backtracking.
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

/**
 * Hides user info anywhere in a value, for quoting it in a message: everything from just after
 * the first "//" (or from the start, when no "//" comes before it) up to the last "@" becomes ***.
 * So a password with a raw / ? or # in it (https://id:a/b/c@host), one after invisible
 * characters, in mid-text ("Source: https://u:p@x.com") or in a second link is never printed,
 * whatever the scheme, and a backslash never stops it. It over-hides on purpose (a path or query
 * with an "@", or a first link before a second one, is hidden too), which is fine in an error
 * message. Linear time.
 */
export function hideUserInfo(value) {
  if (typeof value !== 'string') return value;
  const at = value.lastIndexOf('@');
  if (at === -1) return value;
  const slashes = value.indexOf('//');
  const start = slashes !== -1 && slashes < at ? slashes + 2 : 0;
  return start === at ? value : `${value.slice(0, start)}***${value.slice(at)}`;
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

// In a link, a backslash (a browser reads it as /, so the link opens somewhere other than it reads)
// or any of the unsafe characters above.
const LINK_HIDDEN = new RegExp(`[\\\\${UNSAFE_CLASS}]`, 'u');

// The site as written: plain ASCII letters, digits, dots, dashes and underscores (xn-- punycode
// covers other alphabets), with an optional port, which may be empty ("example.com:/x").
const PLAIN_SITE = /^([A-Za-z0-9._-]+)(?::\d{0,5})?$/;

/**
 * What's wrong with a link, as a word: "scheme" (doesn't start with https://, which the schema's
 * pattern reports), "userinfo", "whole" (spaces, doesn't parse, no site), "hidden" (a backslash or
 * an invisible or control character) or "site": the site the browser would open isn't the site as
 * written (lookalike characters that IDNA maps, like U+2215 for "/", a non-ASCII or percent-encoded
 * name, or a numeric form like 0x7f.1 or 2130706433), or it's an IP address, localhost or a
 * one-word name with no dot. null when it's fine.
 */
function linkIssue(text) {
  if (typeof text !== 'string' || !text.startsWith('https://')) return 'scheme';
  if (hasUserInfo(text)) return 'userinfo';
  if (/\s/.test(text)) return 'whole';
  if (LINK_HIDDEN.test(text)) return 'hidden';
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
  const host = url.hostname.replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost')) return 'site';
  return null;
}

const LINK_WORDS = {
  userinfo: 'must not have a user name or password before the site name',
  whole: 'must be a whole link that starts with https://, with a site name and no spaces',
  hidden: 'must not contain a backslash or hidden characters (percent-encode them, e.g. %E2%80%8C)',
  site: 'must name a public site like example.com in plain letters, digits, dots, dashes or underscores (xn-- for other alphabets), not localhost or an IP address',
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
  return `${LINK_WORDS[issue]} (got ${show(url)})`;
}

/**
 * The page a link opens, for spotting the same source twice. Only for links isHttpsLink accepts.
 * Drops what doesn't change the page: a #fragment (unless it's a route, #/... or #!..., which
 * hash-routed sites use for different pages), utm_* tracking parameters, an empty "?", and a
 * trailing dot on the site name. Other parameters are kept as they are, in their order.
 */
export function linkKey(url) {
  const parsed = new URL(url);
  if (!/^#[/!]/.test(parsed.hash)) parsed.hash = '';
  parsed.search = parsed.search
    .slice(1)
    .split('&')
    .filter((pair) => !/^utm_/i.test(pair))
    .join('&');
  parsed.hostname = parsed.hostname.replace(/\.$/, '');
  return parsed.href;
}

// ---- Errors ------------------------------------------------------------------------------

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
  const got = () => show(valueAt(data, error.instancePath));
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
    case 'uniqueItems': {
      const value = valueAt(data, error.instancePath);
      const [first, second] = [Math.min(p.i, p.j), Math.max(p.i, p.j)];
      return `${where}: lists ${Array.isArray(value) ? `${show(value[second])} ` : ''}twice (items ${first} and ${second})`;
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
 * hint, when given, says what to do ("keep the 8 strongest").
 */
export function tooLongError(list, where, max, noun, hint) {
  if (!Array.isArray(list) || list.length <= GUARD_ITEMS) return null;
  return `${where}: far too long (${list.length} ${noun}); at most ${max} allowed${hint ? ` (${hint})` : ''}, so nothing else was checked`;
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

// V8 quotes a few characters of the file around some JSON syntax errors
// (Unexpected token 'h', "{"url": https://ad"... is not valid JSON). A link with a password can
// sit right there, so the quoted part is dropped; hideUserInfo covers anything else.
const JSON_SNIPPET = /,?\s*(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)?\s*is not valid JSON$/;

/** A JSON.parse error as safe text: no quoted snippet of the file, user info hidden, unsafe characters escaped. */
export const jsonErrorText = (err) => plain(hideUserInfo(String(err?.message ?? err).replace(JSON_SNIPPET, '')));

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
    return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (err) {
    return { ok: false, errors: [`${filePath}: not valid JSON (${jsonErrorText(err)})`] };
  }
}
