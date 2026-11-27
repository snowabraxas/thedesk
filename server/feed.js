// GET /api/feed: which edition The Desk shows. Only a valid edition is ever served.
//
// Order of preference:
//   1. live       $DESK_HOME/desks/product-feed/feed.json, when it passes the feed contract
//   2. last-good  the last valid feed.json this server saw (kept in memory)
//   3. edition:<file>  the newest valid editions/YYYY-MM-DD.json (invalid ones are skipped)
//   4. sample     prototype/feed.json, marked "sample": true
//
// Files are re-read and re-checked only when their stat changes (inode, size, mtime or ctime),
// so a request costs a stat, not a parse. Each change is logged once: a new valid edition gets
// a short line, an invalid one gets the reasons and what is shown instead.
import fs from 'node:fs';
import path from 'node:path';
import { SAMPLE_FEED_PATH, feedPath, productFeedDir } from './config.js';
import { checkFeedFile } from './feed-schema.js';

const EDITION_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const MISSING = 'missing';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Only The Desk's own fallback may say "sample": an agent's file never can. */
function withoutSample(feed) {
  const { sample, ...rest } = feed;
  return rest;
}

/** A short fingerprint of the file, or "missing". Any change to the file changes it. */
async function statKey(file, fsp) {
  try {
    const s = await fsp.stat(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.isFile() ? 'f' : 'x'}`;
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? MISSING : `error:${err.code || err.message}`;
  }
}

/**
 * Checks a file against the feed contract, again only when it has changed.
 * check() resolves to { result, changed, missing }; a valid result's feed has any "sample" key
 * removed. `changed` is true for exactly one caller per change, even when requests overlap,
 * so whoever gets it does the logging.
 */
function watchedFile(file, fsp) {
  let key = null;
  let pending = null;
  return async function check() {
    const k = await statKey(file, fsp);
    if (k === key) return { result: await pending, changed: false, missing: k === MISSING };
    key = k;
    pending =
      k === MISSING
        ? Promise.resolve({ ok: false, errors: ['file not found'] })
        : checkFeedFile(file, { fsp }).then((r) => (r.ok ? { ...r, feed: withoutSample(r.feed) } : r));
    return { result: await pending, changed: true, missing: k === MISSING };
  };
}

// Errors from checkFeedFile that are about the file itself start with its path; the log names it already.
const reasons = (file, errors) => errors.map((e) => `  - ${e.startsWith(`${file}: `) ? e.slice(file.length + 2) : e}`).join('\n');

/**
 * @param {string} deskHome
 * @param {{ log?: { error: Function, info?: Function }, samplePath?: string, fsp?: typeof fs.promises }} [options]
 * @returns {{ load: () => Promise<{ feed: object, source: string }> }}
 *   source is "live", "last-good", "edition:<YYYY-MM-DD.json>" or "sample".
 */
export function createFeedLoader(deskHome, { log = console, samplePath = SAMPLE_FEED_PATH, fsp = fs.promises } = {}) {
  const liveFile = feedPath(deskHome);
  const editionsDir = path.join(productFeedDir(deskHome), 'editions');
  const info = typeof log.info === 'function' ? (msg) => log.info(msg) : () => {};
  const checkLive = watchedFile(liveFile, fsp);
  const editionChecks = new Map(); // file name -> check()
  let lastGood = null;
  let sample = null;

  /** The newest valid editions/YYYY-MM-DD.json, or null. Invalid ones are logged once per change and skipped. */
  async function newestEdition() {
    let names;
    try {
      names = await fsp.readdir(editionsDir);
    } catch {
      return null; // no editions folder yet
    }
    names = names.filter((n) => EDITION_FILE.test(n)).sort().reverse();
    for (const name of editionChecks.keys()) if (!names.includes(name)) editionChecks.delete(name);
    for (const name of names) {
      if (!editionChecks.has(name)) editionChecks.set(name, watchedFile(path.join(editionsDir, name), fsp));
      const { result, changed, missing } = await editionChecks.get(name)();
      if (result.ok) return { feed: result.feed, source: `edition:${name}` };
      if (changed && !missing) {
        const file = path.join(editionsDir, name);
        log.error(`The Desk: skipping ${file}, it isn't a valid edition:\n${reasons(file, result.errors)}`);
      }
    }
    return null;
  }

  async function sampleEdition() {
    if (!sample) {
      const value = JSON.parse((await fsp.readFile(samplePath, 'utf8')).replace(/^\uFEFF/, ''));
      if (!isPlainObject(value)) throw new Error(`${samplePath} is not a JSON object`);
      sample = { ...value, sample: true };
    }
    return { feed: sample, source: 'sample' };
  }

  async function fallback() {
    if (lastGood) return { feed: lastGood, source: 'last-good' };
    return (await newestEdition()) || sampleEdition();
  }

  const describe = (shown) => {
    if (!shown) return 'nothing (the sample edition is missing too)';
    if (shown.source === 'last-good') return `the last good edition (${shown.feed.edition})`;
    if (shown.source === 'sample') return 'the sample edition';
    return `${shown.source.slice('edition:'.length)} from editions/`;
  };

  async function load() {
    const { result, changed, missing } = await checkLive();
    if (result.ok) {
      lastGood = result.feed;
      if (changed) info(`The Desk: showing the ${lastGood.edition} edition from ${liveFile}.`);
      return { feed: lastGood, source: 'live' };
    }
    let shown;
    try {
      shown = await fallback();
      return shown;
    } finally {
      if (changed && missing) info(`The Desk: no ${liveFile}, so it shows ${describe(shown)}.`);
      else if (changed) log.error(`The Desk: ${liveFile} isn't a valid edition, so it keeps showing ${describe(shown)}:\n${reasons(liveFile, result.errors)}`);
    }
  }

  return { load };
}
