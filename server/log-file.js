// Keeps the service's log (~/agent-house/logs/the-desk.log) from growing forever.
// launchd opens the log in append mode each time it starts the server, so the server can't
// simply rename it: it would keep writing into the renamed file. Instead, when the log is over
// the limit, its contents are copied to <log>.1 (replacing the older copy) and the log is emptied
// in place. Appends then carry on at the start of the emptied file. One old copy is kept.
import fs from 'node:fs';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * @param {string} file the log file
 * @param {{ maxBytes?: number, fsImpl?: typeof fs }} [options]
 * @returns {string|null} the path of the old copy when it rotated, otherwise null. Never throws.
 */
export function rotateLog(file, { maxBytes = MAX_LOG_BYTES, fsImpl = fs } = {}) {
  if (!file) return null;
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || stat.size <= maxBytes) return null;
    const old = `${file}.1`;
    fsImpl.copyFileSync(file, old);
    fsImpl.truncateSync(file, 0);
    return old;
  } catch {
    return null; // no log yet, or it can't be touched: never stop the server over its log
  }
}
