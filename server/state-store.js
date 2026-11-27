// Snow's reads, saves, folders, notes, XP and badges: $DESK_HOME/desks/product-feed/state.json.
// Every write goes to a temp file in the same folder, is fsynced, then renamed over state.json,
// so a crash leaves either the old file or the new one, never half of one. Writes run one at a time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { jsonErrorText } from './schema-common.js';

export const MAX_STATE_BYTES = 1024 * 1024;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The keys The Desk knows about and the type each must have. Other keys pass through untouched.
const STATE_KEYS = {
  read: ['an object', isPlainObject],
  saved: ['an object', isPlainObject],
  folders: ['a list', Array.isArray],
  notes: ['a list', Array.isArray],
  xp: ['a number', (v) => typeof v === 'number' && Number.isFinite(v)],
  days: ['a list', Array.isArray],
  badges: ['an object', isPlainObject],
};

/**
 * Checks a parsed state before it is saved. Never throws.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkState(value) {
  if (!isPlainObject(value)) return { ok: false, error: 'state must be a JSON object' };
  for (const [key, [words, test]] of Object.entries(STATE_KEYS)) {
    if (Object.hasOwn(value, key) && !test(value[key])) return { ok: false, error: `${key} must be ${words}` };
  }
  return { ok: true };
}

/** state.json exists but can't be used. The server answers 500 and leaves the file alone. */
export class CorruptStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/**
 * @param {string} filePath where state.json lives
 * @param {{ fsp?: typeof fs.promises }} [options] fsp lets tests make a step fail
 */
export function createStateStore(filePath, { fsp = fs.promises } = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let queue = Promise.resolve();

  /** The saved state, {} if there is none yet. Throws CorruptStateError if the file is unusable. */
  async function read() {
    let text;
    try {
      text = await fsp.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
    let value;
    try {
      value = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      // No quoted snippet of the file in the message (it goes to the-desk.log): see jsonErrorText.
      throw new CorruptStateError(`${filePath} is not valid JSON (${jsonErrorText(err)})`);
    }
    if (!isPlainObject(value)) throw new CorruptStateError(`${filePath} does not hold a JSON object`);
    return value;
  }

  async function writeNow(value) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${base}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fsp.open(tmp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(tmp, filePath);
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    // Make the rename itself durable. Best effort: not every file system lets you fsync a folder.
    try {
      const d = await fsp.open(dir, 'r');
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } catch {
      /* the file itself is already safe */
    }
  }

  /** Saves the state. Writes are queued, so two can never interleave. */
  function write(value) {
    const run = queue.then(() => writeNow(value));
    queue = run.catch(() => {});
    return run;
  }

  return { filePath, read, write };
}
