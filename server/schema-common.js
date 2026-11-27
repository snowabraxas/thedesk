// Shared by the desk contracts (feed-schema.js for Product Feed, news-schema.js for News):
// one ajv setup, reading an agent's JSON file without trusting it, turning ajv's errors into
// plain lines that point at the place ("stories[1].sources: needs at least 2 sources (has 1)"),
// and the checks a schema pattern can't make: real calendar dates, and whole https:// links
// with a site name, no spaces and no user name or password.
import fs from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

/** The ajv every contract uses: JSON Schema 2020-12, every error at once, strict about the schema itself. */
export function createAjv() {
  return new Ajv2020({ allErrors: true, strict: true });
}

export const MAX_FILE_BYTES = 1024 * 1024;

const TYPE_WORDS = {
  string: 'text',
  integer: 'a whole number',
  number: 'a number',
  array: 'a list',
  object: 'an object',
  boolean: 'true or false',
};

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Untrusted values are quoted with JSON.stringify (which escapes control characters,
// so nothing from the file can drive the terminal) and cut short.
export function show(value, max = 60) {
  let s = JSON.stringify(value);
  if (s === undefined) s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// For text that may quote the file (a JSON.parse message does): control characters become
// \u escapes, so nothing from the file can drive the terminal, and it's cut short.
export function plain(text, max = 160) {
  const s = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const unescapePointer = (part) => part.replace(/~1/g, '/').replace(/~0/g, '~');

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
  switch (error.keyword) {
    case 'required':
      return `${where}: missing required field "${p.missingProperty}"`;
    case 'type':
      return `${where}: must be ${TYPE_WORDS[p.type] || p.type}`;
    case 'const':
      return `${where}: must be ${show(p.allowedValue)}`;
    case 'enum':
      return `${where}: must be one of ${p.allowedValues.map((v) => show(v)).join(', ')} (got ${show(valueAt(data, error.instancePath))})`;
    case 'pattern': {
      const words = patterns[p.pattern] || `must match the pattern ${p.pattern}`;
      return `${where}: ${words} (got ${show(valueAt(data, error.instancePath))})`;
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
      const noun = nouns[unescapePointer(error.instancePath.split('/').at(-1))];
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

/** Runs a compiled schema and returns its errors as plain lines, each line once. */
export function schemaErrors(check, data, words) {
  if (check(data)) return [];
  const lines = [];
  for (const e of check.errors) {
    const line = describeError(e, data, words);
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

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

/** True for a whole https:// link: it parses, names a site, and has no spaces or control characters. */
export function isWholeHttpsLink(text) {
  if (typeof text !== 'string' || !text.startsWith('https://') || /[\s\u0000-\u001f\u007f]/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

// The part between "https://" and the path, query or fragment. A browser treats "\" like "/" here.
const authorityOf = (text) => text.slice('https://'.length).split(/[/?#\\]/, 1)[0];

/**
 * True when a link carries a user name or password before the site name: "https://user@host/",
 * "https://:secret@host/", even an empty "https://@host/". Links like these can make a page look
 * like it's on one site while it opens another. An "@" later in the link ("/@snow") is fine.
 */
export function hasUserInfo(text) {
  if (typeof text !== 'string' || !text.startsWith('https://')) return false;
  if (authorityOf(text).includes('@')) return true;
  try {
    const url = new URL(text);
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
}

/** True for a link The Desk will show: a whole https:// link with no user name or password in it. */
export function isHttpsLink(text) {
  return isWholeHttpsLink(text) && !hasUserInfo(text);
}

// Hides whatever came before the "@", so a password never reaches the terminal or the log.
const hideUserInfo = (text) => `https://***@${text.slice('https://'.length + authorityOf(text).lastIndexOf('@') + 1)}`;

/**
 * What's wrong with a link that already starts with https:// (the schema's pattern reports the
 * rest, so a value never gets two lines), or null when it's fine.
 */
export function linkProblem(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  if (!isWholeHttpsLink(url)) return `must be a whole link that starts with https://, with a site name and no spaces (got ${show(url)})`;
  if (hasUserInfo(url)) return `must not have a user name or password before the site name (got ${show(hideUserInfo(url))})`;
  return null;
}

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
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { ok: false, errors: [`${filePath}: not valid JSON (${plain(err.message)})`] };
  }
}
