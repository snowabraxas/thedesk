// GET /api/feed: which Product Feed edition The Desk shows. Only a valid edition is ever served.
//
// Order of preference (edition-loader.js, shared with News):
//   1. live       $DESK_HOME/desks/product-feed/feed.json, when it passes the feed contract
//   2. last-good  the last valid feed.json this server served, kept in memory and on disk as
//                 desks/product-feed/last-good.json, so a restart doesn't lose it
//   3. edition:<file>  the newest valid editions/YYYY-MM-DD.json (invalid ones are skipped);
//                 it wins over last-good when its edition date is later
//   4. sample     prototype/feed.json, marked "sample": true
//
// Files are re-read and re-checked only when their stat changes, and each change is logged once.
import fs from 'node:fs';
import { SAMPLE_FEED_PATH, editionsDir, feedPath, lastGoodPath } from './config.js';
import { createEditionLoader } from './edition-loader.js';
import { checkFeedFile } from './feed-schema.js';
import { withoutSample } from './schema-common.js';

/** Reads and checks a Product Feed edition. Never throws; a valid one comes back without "sample", with its bytes. */
async function checkFeed(file, fsp) {
  const r = await checkFeedFile(file, { fsp });
  return r.ok ? { ok: true, errors: [], value: withoutSample(r.feed), bytes: r.bytes } : r;
}

/**
 * @param {string} deskHome
 * @param {{ log?: { error: Function, info?: Function }, samplePath?: string, fsp?: typeof fs.promises }} [options]
 * @returns {{ load: () => Promise<{ feed: object, source: string }> }}
 *   source is "live", "last-good", "edition:<YYYY-MM-DD.json>" or "sample".
 */
export function createFeedLoader(deskHome, { log = console, samplePath = SAMPLE_FEED_PATH, fsp = fs.promises } = {}) {
  const editions = createEditionLoader({
    liveFile: feedPath(deskHome),
    lastGoodFile: lastGoodPath(deskHome, 'product-feed'),
    editionsDir: editionsDir(deskHome, 'product-feed'),
    samplePath,
    check: checkFeed,
    log,
    fsp,
  });
  return {
    async load() {
      const { value, source } = await editions.load();
      return { feed: value, source };
    },
  };
}
