// The feed contract: checks a Product Feed edition against data/schema/feed.schema.json,
// plus the rules JSON Schema can't express (unique article ids).
// Used by `npm run validate-feed` now and by the server from S3 on.
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
};

// Untrusted values are quoted with JSON.stringify (which escapes control characters,
// so nothing from the file can drive the terminal) and cut short.
function show(value, max = 60) {
  let s = JSON.stringify(value);
  if (s === undefined) s = String(value);
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
    default:
      return `${where}: ${String(error.message || 'is not allowed').replace(/must NOT/g, 'must not')}`;
  }
}

function duplicateIdErrors(feed) {
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.articles)) return [];
  const firstSeen = new Map();
  const errors = [];
  feed.articles.forEach((article, i) => {
    if (!article || typeof article !== 'object' || typeof article.id !== 'string') return;
    if (firstSeen.has(article.id)) {
      errors.push(`articles[${i}].id: duplicate id ${show(article.id)} (also used by articles[${firstSeen.get(article.id)}])`);
    } else {
      firstSeen.set(article.id, i);
    }
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
  errors.push(...duplicateIdErrors(feed));
  return { ok: errors.length === 0, errors };
}

/**
 * Reads, parses and checks a feed file. Never throws.
 * @returns {Promise<{ ok: boolean, errors: string[], feed?: object }>}
 */
export async function checkFeedFile(filePath, { maxBytes = MAX_FEED_BYTES } = {}) {
  let text;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, errors: [`${filePath}: not a file`] };
    if (stat.size > maxBytes) {
      return { ok: false, errors: [`${filePath}: too big (${stat.size} bytes, limit is ${maxBytes})`] };
    }
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'file not found' : `can't read it (${err.code || err.message})`;
    return { ok: false, errors: [`${filePath}: ${reason}`] };
  }
  let feed;
  try {
    feed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, errors: [`${filePath}: not valid JSON (${err.message})`] };
  }
  const result = validateFeed(feed);
  return result.ok ? { ...result, feed } : result;
}
