// GET /api/feed: which edition The Desk shows.
// S2: the agent's feed.json if it exists and parses, otherwise prototype/feed.json marked "sample": true.
// S3 extends loadFeed with the schema check and the last-good fallback.
import fs from 'node:fs';
import { SAMPLE_FEED_PATH, feedPath } from './config.js';
import { MAX_FEED_BYTES } from './feed-schema.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function readJsonObject(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_FEED_BYTES) throw new Error(`too big (${stat.size} bytes, limit is ${MAX_FEED_BYTES})`);
  const value = JSON.parse((await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, ''));
  if (!isPlainObject(value)) throw new Error('not a JSON object');
  return value;
}

/**
 * @param {string} deskHome
 * @param {{ log?: Pick<Console, 'error'>, samplePath?: string }} [options]
 * @returns {Promise<object>} the edition; the sample carries "sample": true
 */
export async function loadFeed(deskHome, { log = console, samplePath = SAMPLE_FEED_PATH } = {}) {
  const file = feedPath(deskHome);
  try {
    return await readJsonObject(file);
  } catch (err) {
    if (err.code !== 'ENOENT') log.error(`The Desk: can't use ${file} (${err.message}). Showing the sample edition.`);
  }
  const sample = await readJsonObject(samplePath);
  return { ...sample, sample: true };
}
