// The News desk's two feeds from the agent:
//
// GET /api/news: which morning edition The Desk shows. Only a valid edition is ever served.
// Order of preference (edition-loader.js, the same as Product Feed):
//   1. live            $DESK_HOME/desks/news/news.json, when it passes the News contract
//   2. last-good       the last valid news.json this server served, kept in memory and on disk as
//                      desks/news/last-good.json (checked again when read back after a restart)
//   3. edition:<file>  the newest valid desks/news/editions/YYYY-MM-DD.json
//   4. sample          data/samples/news.sample.json, marked "sample": true by the server
//
// GET /api/breaking: desks/news/breaking.json when it is valid and its `at` falls on today in
// Toronto (America/Toronto, whatever the machine's timezone), else nothing. An invalid file is
// logged once per change; a missing, old or future one is simply not shown.
import fs from 'node:fs';
import { SAMPLE_NEWS_PATH, breakingPath, editionsDir, lastGoodPath, newsPath } from './config.js';
import { createEditionLoader, reasons, watchedFile } from './edition-loader.js';
import { checkBreakingFile, checkNewsFile } from './news-schema.js';

export const NEWS_TIME_ZONE = 'America/Toronto';

/** Reads and checks a News edition. Never throws; a valid one comes back without "sample". */
async function checkNews(file, fsp) {
  const r = await checkNewsFile(file, { fsp });
  return r.ok ? { ok: true, errors: [], value: r.news } : r;
}

/**
 * @param {string} deskHome
 * @param {{ log?: { error: Function, info?: Function }, samplePath?: string, fsp?: typeof fs.promises }} [options]
 * @returns {{ load: () => Promise<{ news: object, source: string }> }}
 *   source is "live", "last-good", "edition:<YYYY-MM-DD.json>" or "sample".
 */
export function createNewsLoader(deskHome, { log = console, samplePath = SAMPLE_NEWS_PATH, fsp = fs.promises } = {}) {
  const editions = createEditionLoader({
    liveFile: newsPath(deskHome),
    lastGoodFile: lastGoodPath(deskHome, 'news'),
    editionsDir: editionsDir(deskHome, 'news'),
    samplePath,
    check: checkNews,
    log,
    fsp,
  });
  return {
    async load() {
      const { value, source } = await editions.load();
      return { news: value, source };
    },
  };
}

const TORONTO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: NEWS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The calendar day in Toronto at a moment (milliseconds since 1970), as YYYY-MM-DD. */
export function torontoDate(ms) {
  const parts = Object.fromEntries(TORONTO_DAY.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** True when the moment `at` (an ISO date-time with a timezone) falls on the same Toronto day as `now`. */
export function isTodayInToronto(at, now) {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && torontoDate(ms) === torontoDate(now);
}

/**
 * @param {string} deskHome
 * @param {{ log?: { error: Function }, fsp?: typeof fs.promises, now?: () => number }} [options]
 *   now lets tests pick the moment that counts as "today".
 * @returns {{ load: () => Promise<object | null> }} today's valid breaking story (with `at`), or null.
 */
export function createBreakingReader(deskHome, { log = console, fsp = fs.promises, now = Date.now } = {}) {
  const file = breakingPath(deskHome);
  const checkFile = watchedFile(
    file,
    async (f) => {
      const r = await checkBreakingFile(f, { fsp });
      return r.ok ? { ok: true, errors: [], value: r.breaking } : r;
    },
    fsp,
  );

  async function load() {
    const { result, changed, missing } = await checkFile();
    if (!result.ok) {
      if (changed && !missing) log.error(`The Desk: ${file} isn't a valid breaking story, so no banner shows:\n${reasons(file, result.errors)}`);
      return null;
    }
    return isTodayInToronto(result.value.at, now()) ? result.value : null;
  }

  return { load };
}
