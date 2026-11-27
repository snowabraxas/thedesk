// Which edition a desk serves. Shared by GET /api/feed (feed.js) and GET /api/news (news.js).
// Only a valid edition is ever served.
//
// Order of preference:
//   1. live            the agent's file (feed.json, news.json), when it passes the desk's contract
//   2. last-good       the last valid live file this server served: kept in memory, and on disk as
//                      last-good.json next to the live file, so a restart doesn't lose it. Read from
//                      disk only after a restart, and checked against the contract again then.
//   3. edition:<file>  the newest valid editions/YYYY-MM-DD.json, by the date in its name (invalid
//                      files and other names are skipped; only the newest 60 dated names are
//                      looked at). It wins over last-good when its `edition` date is later, so an
//                      old last-good.json never hides a newer edition the agent archived.
//   4. sample          the desk's sample, marked "sample": true. Only The Desk may say that: the
//                      check functions drop "sample" from every agent file.
//
// Files are re-read and re-checked only when their stat changes (inode, size, mtime or ctime),
// so a request costs a stat, not a parse. Each change is logged once: a new valid edition gets
// a short line, an invalid one gets the reasons and what is shown instead.
//
// last-good.json is written (atomically: temp file, fsync, rename) whenever a valid live file is
// served and last-good.json doesn't already hold exactly the same bytes, including when someone
// deleted or damaged it while the live file stayed the same. It is a byte-for-byte copy of the
// live file as read and checked, so it is exactly as big as a file that passed the size limit.
// A failed write is logged once per change and the live edition is still served.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-file.js';
import { plain } from './schema-common.js';

export const EDITION_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

/** At most this many dated files in editions/ are looked at, newest first: two months of mornings. */
export const MAX_EDITION_FILES = 60;

const MISSING = 'missing';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A short fingerprint of the file, or "missing". Any change to the file changes it. */
export async function statKey(file, fsp = fs.promises) {
  try {
    const s = await fsp.stat(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.isFile() ? 'f' : 'x'}`;
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR' ? MISSING : `error:${err.code || err.message}`;
  }
}

/**
 * Checks a file, again only when it has changed.
 * @param {string} file
 * @param {(file: string) => Promise<{ ok: true, value: object, bytes?: Buffer } | { ok: false, errors: string[] }>} check
 *   never throws; a valid value has no "sample" key.
 * @returns {() => Promise<{ result: object, changed: boolean, missing: boolean }>}
 *   `changed` is true for exactly one caller per change, even when requests overlap, so whoever
 *   gets it does the logging.
 */
export function watchedFile(file, check, fsp = fs.promises) {
  let key = null;
  let pending = null;
  return async function checkIfChanged() {
    const k = await statKey(file, fsp);
    if (k === key) return { result: await pending, changed: false, missing: k === MISSING };
    key = k;
    pending = k === MISSING ? Promise.resolve({ ok: false, errors: ['file not found'] }) : check(file);
    return { result: await pending, changed: true, missing: k === MISSING };
  };
}

/** A check's errors as indented lines. Errors about the file itself start with its path; the log names it already. */
export const reasons = (file, errors) => errors.map((e) => `  - ${e.startsWith(`${file}: `) ? e.slice(file.length + 2) : e}`).join('\n');

/**
 * @param {object} options
 * @param {string} options.liveFile      the agent's file, e.g. desks/news/news.json
 * @param {string} options.lastGoodFile  where the last valid live edition is kept, e.g. desks/news/last-good.json
 * @param {string} options.editionsDir   the folder of dated copies, e.g. desks/news/editions
 * @param {string} options.samplePath    the desk's sample edition in this repo
 * @param {(file: string, fsp: typeof fs.promises) => Promise<{ ok: true, value: object, bytes: Buffer } | { ok: false, errors: string[] }>} options.check
 *   reads and checks one file against the desk's contract, never throws, and returns a valid value
 *   without "sample", plus the file's bytes exactly as read.
 * @param {{ error: Function, info?: Function }} [options.log]
 * @param {typeof fs.promises} [options.fsp]
 * @returns {{ load: () => Promise<{ value: object, source: string }> }}
 *   source is "live", "last-good", "edition:<YYYY-MM-DD.json>" or "sample".
 */
export function createEditionLoader({ liveFile, lastGoodFile, editionsDir, samplePath, check, log = console, fsp = fs.promises }) {
  const info = typeof log.info === 'function' ? (msg) => log.info(msg) : () => {};
  const checkFile = (file) => check(file, fsp);
  const checkLive = watchedFile(liveFile, checkFile, fsp);
  const checkKept = watchedFile(lastGoodFile, checkFile, fsp);
  const editionChecks = new Map(); // file name -> checkIfChanged()
  let lastGood = null; // the last valid live edition, in memory: { value, bytes }
  let sample = null;
  let ignoringOlder = false; // editions/ has more than MAX_EDITION_FILES dated files (noted once)

  // ---- last-good.json ----------------------------------------------------------------------

  // What last-good.json was last made to match: the live edition (the same object until the live
  // file changes) and the file's fingerprint afterwards. A failed write is remembered the same way,
  // so it's retried (and logged) once per change, not on every request.
  let kept = { edition: null, key: null };
  let failed = { edition: null, key: null };
  let keeping = Promise.resolve();

  async function sameOnDisk(bytes) {
    try {
      const s = await fsp.stat(lastGoodFile);
      if (!s.isFile() || s.size !== bytes.length) return false;
      return (await fsp.readFile(lastGoodFile)).equals(bytes);
    } catch {
      return false;
    }
  }

  async function keepNow(edition) {
    const key = await statKey(lastGoodFile, fsp);
    if ((kept.edition === edition && kept.key === key) || (failed.edition === edition && failed.key === key)) return;
    try {
      if (!(await sameOnDisk(edition.bytes))) await writeFileAtomic(lastGoodFile, edition.bytes, { fsp });
      kept = { edition, key: await statKey(lastGoodFile, fsp) };
    } catch (err) {
      failed = { edition, key };
      log.error(
        `The Desk: couldn't keep a copy of the ${plain(edition.value.edition)} edition in ${lastGoodFile} (${plain(err.code || err.message)}). ` +
          'It still shows it, but after a restart a broken live file would fall back further.',
      );
    }
  }

  /** Makes last-good.json hold exactly the live file's bytes. Never throws; runs one at a time. */
  function keep(edition) {
    keeping = keeping.then(() => keepNow(edition)).catch(() => {});
    return keeping;
  }

  // ---- fallbacks ---------------------------------------------------------------------------

  /** last-good.json, when it is a valid edition. A damaged one is logged once per change and skipped. */
  async function keptEdition() {
    const { result, changed, missing } = await checkKept();
    if (result.ok) return { value: result.value, source: 'last-good' };
    if (changed && !missing) log.error(`The Desk: skipping ${lastGoodFile}, it isn't a valid edition:\n${reasons(lastGoodFile, result.errors)}`);
    return null;
  }

  /**
   * The newest valid editions/YYYY-MM-DD.json, or null. Only the newest MAX_EDITION_FILES dated
   * names are looked at (noted once while there are more). Invalid ones are logged once per change
   * and skipped.
   */
  async function newestEdition() {
    let names;
    try {
      names = await fsp.readdir(editionsDir);
    } catch {
      return null; // no editions folder yet
    }
    names = names.filter((n) => EDITION_FILE.test(n)).sort().reverse();
    if (names.length > MAX_EDITION_FILES) {
      if (!ignoringOlder) {
        info(
          `The Desk: ${editionsDir} has ${names.length} dated files; it only looks at the newest ${MAX_EDITION_FILES} ` +
            `(${names[MAX_EDITION_FILES - 1]} onward) when it needs an older edition.`,
        );
      }
      ignoringOlder = true;
      names = names.slice(0, MAX_EDITION_FILES);
    } else {
      ignoringOlder = false;
    }
    const current = new Set(names);
    for (const name of editionChecks.keys()) if (!current.has(name)) editionChecks.delete(name);
    for (const name of names) {
      if (!editionChecks.has(name)) editionChecks.set(name, watchedFile(path.join(editionsDir, name), checkFile, fsp));
      const { result, changed, missing } = await editionChecks.get(name)();
      if (result.ok) return { value: result.value, source: `edition:${name}` };
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
    return { value: sample, source: 'sample' };
  }

  // `edition` is a checked YYYY-MM-DD, so comparing the text compares the dates.
  const isLater = (a, b) => typeof a === 'string' && typeof b === 'string' && a > b;

  /** last-good, unless editions/ holds a valid edition with a later date; then that; else the sample. */
  async function fallback() {
    const kept = lastGood ? { value: lastGood.value, source: 'last-good' } : await keptEdition();
    const newest = await newestEdition();
    if (kept && !(newest && isLater(newest.value.edition, kept.value.edition))) return kept;
    return newest || sampleEdition();
  }

  const describe = (shown) => {
    if (!shown) return 'nothing (the sample edition is missing too)';
    if (shown.source === 'last-good') return `the last good edition (${plain(shown.value.edition)})`;
    if (shown.source === 'sample') return 'the sample edition';
    return `${shown.source.slice('edition:'.length)} from editions/`;
  };

  async function load() {
    const { result, changed, missing } = await checkLive();
    if (result.ok) {
      lastGood = result; // the same object until the file changes: { value, bytes }
      if (changed) info(`The Desk: showing the ${plain(result.value.edition)} edition from ${liveFile}.`);
      await keep(lastGood);
      return { value: result.value, source: 'live' };
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
