// The service's log (~/agent-house/logs/the-desk.log).
//
// Every line the server writes starts with the local time and its offset from UTC,
// "2026-11-28T09:14:03-05:00 The Desk is running at ...", so a reboot or a crash can be read back later.
//
// It also keeps the log from growing forever. launchd opens the log in append mode each time it starts the server, so the server can't
// simply rename it: it would keep writing into the renamed file. Instead, when the log is over
// the limit, its contents are copied to <log>.1 (replacing the older copy) and the log is emptied
// in place. Appends then carry on at the start of the emptied file. One old copy is kept.
import fs from 'node:fs';
import { format } from 'node:util';

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

const pad = (n) => String(n).padStart(2, '0');

/** The local time with its UTC offset, to the second: 2026-11-28T09:14:03-05:00. */
export function localTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * A console-like logger that starts every line with localTimestamp(), including each line of a
 * message that runs over several (a stack trace, a list of reasons).
 * @param {{ out?: (text: string) => void, err?: (text: string) => void, now?: () => Date }} [options]
 *   out gets info and log, err gets warn and error. Both default to the process's own streams.
 */
export function createLogger({ out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text), now = () => new Date() } = {}) {
  const emit = (write, args) => {
    const stamp = localTimestamp(now());
    const text = format(...args).replace(/\r?\n$/, '');
    write(`${text.split(/\r?\n/).map((line) => `${stamp} ${line}`).join('\n')}\n`);
  };
  return {
    info: (...args) => emit(out, args),
    log: (...args) => emit(out, args),
    warn: (...args) => emit(err, args),
    error: (...args) => emit(err, args),
  };
}
