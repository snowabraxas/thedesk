// The feed contract: checks a Product Feed edition against data/schema/feed.schema.json,
// plus the rules JSON Schema can't express: unique article ids, unique theme ids, and every
// theme an article uses must be in the edition's themes list.
// Used by `npm run validate-feed` (the agent runs it) and by the server before it serves an edition.
import fs from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import { SCHEMA_PATH } from './config.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;

export const MAX_FEED_BYTES = 1024 * 1024;

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const checkSchema = ajv.compile(schema);

const TYPE_WORDS = {
  string: 'text',
  integer: 'a whole number',
  number: 'a number',
  array: 'a list',
  object: 'an object',
  boolean: 'true or false',
};

const PATTERN_WORDS = {
  '^https://': 'must start with https://',
  '^\\d{4}-\\d{2}-\\d{2}$': 'must be a date like YYYY-MM-DD',
  '^(\\d{4}-\\d{2}-\\d{2})?$': 'must be a date like YYYY-MM-DD, or empty',
  '^[a-z0-9-]{1,40}$': 'must be 1 to 40 lowercase letters, digits or dashes',
  '^[A-Za-z0-9_-]{1,64}$': 'must be 1 to 64 letters, digits, dashes or underscores',
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Untrusted values are quoted with JSON.stringify (which escapes control characters,
// so nothing from the file can drive the terminal) and cut short.
function show(value, max = 60) {
  let s = JSON.stringify(value);
  if (s === undefined) s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// For text that may quote the file (a JSON.parse message does): control characters become
// \u escapes, so nothing from the file can drive the terminal, and it's cut short.
function plain(text, max = 160) {
  const s = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// "/articles/2/url" -> "articles[2].url"
function readablePath(instancePath) {
  if (!instancePath) return 'feed';
  return instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((out, part) => (/^\d+$/.test(part) ? `${out}[${part}]` : out ? `${out}.${part}` : part), '');
}

function valueAt(root, instancePath) {
  if (!instancePath) return root;
  let node = root;
  for (const raw of instancePath.split('/').slice(1)) {
    if (node == null) return undefined;
    node = node[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

function describe(error, feed) {
  const where = readablePath(error.instancePath);
  const p = error.params || {};
  switch (error.keyword) {
    case 'required':
      return `${where}: missing required field "${p.missingProperty}"`;
    case 'type':
      return `${where}: must be ${TYPE_WORDS[p.type] || p.type}`;
    case 'const':
      return `${where}: must be ${show(p.allowedValue)}`;
    case 'pattern': {
      const words = PATTERN_WORDS[p.pattern] || `must match the pattern ${p.pattern}`;
      return `${where}: ${words} (got ${show(valueAt(feed, error.instancePath))})`;
    }
    // Say how long it is now, so the fix is obvious.
    case 'minLength':
    case 'maxLength': {
      const value = valueAt(feed, error.instancePath);
      const has = typeof value === 'string' ? ` (it has ${[...value].length})` : '';
      if (error.keyword === 'minLength' && p.limit === 1) return `${where}: must not be empty`;
      return `${where}: must be at ${error.keyword === 'minLength' ? 'least' : 'most'} ${plural(p.limit, 'character')}${has}`;
    }
    case 'minItems':
    case 'maxItems': {
      const value = valueAt(feed, error.instancePath);
      const has = Array.isArray(value) ? ` (it has ${value.length})` : '';
      if (error.keyword === 'minItems' && p.limit === 1) return `${where}: must not be empty`;
      return `${where}: must have at ${error.keyword === 'minItems' ? 'least' : 'most'} ${plural(p.limit, 'item')}${has}`;
    }
    default:
      return `${where}: ${String(error.message || 'is not allowed').replace(/must NOT/g, 'must not')}`;
  }
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
 * @returns {{ ok: boolean, errors: string[] }} errors are short, readable lines.
 */
export function validateFeed(feed) {
  if (feed === null || typeof feed !== 'object' || Array.isArray(feed)) {
    return { ok: false, errors: ['feed: must be a JSON object'] };
  }
  const errors = [];
  if (!checkSchema(feed)) {
    for (const e of checkSchema.errors) {
      const line = describe(e, feed);
      if (!errors.includes(line)) errors.push(line);
    }
  }
  errors.push(...duplicateIds(feed.themes, 'themes'), ...duplicateIds(feed.articles, 'articles'), ...unknownThemeErrors(feed));
  return { ok: errors.length === 0, errors };
}

/**
 * Reads, parses and checks a feed file. Never throws.
 * @param {string} filePath
 * @param {{ maxBytes?: number, fsp?: typeof fs.promises }} [options] fsp lets tests count reads
 * @returns {Promise<{ ok: boolean, errors: string[], feed?: object }>}
 */
export async function checkFeedFile(filePath, { maxBytes = MAX_FEED_BYTES, fsp = fs.promises } = {}) {
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
  let feed;
  try {
    feed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, errors: [`${filePath}: not valid JSON (${plain(err.message)})`] };
  }
  const result = validateFeed(feed);
  return result.ok ? { ...result, feed } : result;
}
