// Which edition GET /api/feed serves (server/feed.js). Every test uses a temp DESK_HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { SAMPLE_FEED_PATH, feedPath, lastGoodPath, productFeedDir } from '../server/config.js';
import { createFeedLoader } from '../server/feed.js';
import { MAX_FEED_BYTES } from '../server/feed-schema.js';

const SAMPLE = JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));
const edition = (date, extra = {}) => ({ ...structuredClone(SAMPLE), edition: date, note: `The ${date} edition`, ...extra });
const httpUrl = (date) => {
  const feed = edition(date);
  feed.articles[0].url = 'http://example.com/post';
  return feed;
};

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A temp DESK_HOME with helpers to write feed.json and editions/ the way the agent would. */
function deskHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-feed-'));
  tmpDirs.push(home);
  const editions = path.join(productFeedDir(home), 'editions');
  fs.mkdirSync(editions, { recursive: true });
  const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return {
    home,
    // A new file renamed into place (a new inode), as a careful agent writes it.
    writeFeed(value) {
      const tmp = `${feedPath(home)}.tmp`;
      fs.writeFileSync(tmp, text(value));
      fs.renameSync(tmp, feedPath(home));
    },
    // Rewritten where it is (the same inode).
    writeFeedInPlace(value) {
      fs.writeFileSync(feedPath(home), text(value));
    },
    removeFeed() {
      fs.rmSync(feedPath(home));
    },
    writeEdition(name, value) {
      fs.writeFileSync(path.join(editions, name), text(value));
    },
    writeLastGood(value) {
      fs.writeFileSync(lastGoodPath(home, 'product-feed'), text(value));
    },
    readLastGood() {
      return JSON.parse(fs.readFileSync(lastGoodPath(home, 'product-feed'), 'utf8'));
    },
  };
}

function recorder() {
  const errors = [];
  const infos = [];
  return { errors, infos, log: { error: (m) => errors.push(m), info: (m) => infos.push(m) } };
}

// fs.promises that counts reads per file name.
function countingFsp() {
  const reads = {};
  const fsp = {
    ...fs.promises,
    readFile: (file, ...rest) => {
      const name = path.basename(String(file));
      reads[name] = (reads[name] || 0) + 1;
      return fs.promises.readFile(file, ...rest);
    },
  };
  return { fsp, reads };
}

describe('createFeedLoader', () => {
  test('serves a valid feed.json as "live" and logs a short line when it picks it up', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    const { feed, source } = await feeds.load();
    assert.equal(source, 'live');
    assert.deepEqual(feed, edition('2026-11-27'));
    assert.equal(r.errors.length, 0);
    assert.equal(r.infos.length, 1);
    assert.match(r.infos[0], /showing the 2026-11-27 edition from .*feed\.json/);
  });

  test('strips a "sample" key from the agent\'s feed.json and from editions/', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27', { sample: true }));
    const feeds = createFeedLoader(h.home, recorder());
    const live = await feeds.load();
    assert.equal(live.source, 'live');
    assert.equal('sample' in live.feed, false);

    const h2 = deskHome();
    h2.writeEdition('2026-11-26.json', edition('2026-11-26', { sample: 'yes' }));
    const fromEditions = await createFeedLoader(h2.home, recorder()).load();
    assert.equal(fromEditions.source, 'edition:2026-11-26.json');
    assert.equal('sample' in fromEditions.feed, false);
  });

  test('an invalid feed.json leaves the last good edition (from memory) showing, and logs why', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    assert.equal((await feeds.load()).source, 'live');

    h.writeFeed(httpUrl('2026-11-28'));
    const { feed, source } = await feeds.load();
    assert.equal(source, 'last-good');
    assert.equal(feed.edition, '2026-11-27');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /feed\.json isn't a valid edition, so it keeps showing the last good edition \(2026-11-27\):/);
    assert.match(r.errors[0], /\n {2}- articles\[0\]\.url: must start with https:\/\/ \(got "http:\/\/example\.com\/post"\)/);
  });

  test('an impossible edition date or a link with no site is not served; the last good edition stays', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    assert.equal((await feeds.load()).source, 'live');

    h.writeFeed(edition('2026-02-30'));
    let shown = await feeds.load();
    assert.equal(shown.source, 'last-good');
    assert.equal(shown.feed.edition, '2026-11-27');
    assert.match(r.errors[0], /edition: must be a real calendar date like YYYY-MM-DD \(got "2026-02-30"\)/);

    const noSite = edition('2026-11-28');
    noSite.articles[0].url = 'https://';
    h.writeFeed(noSite);
    shown = await feeds.load();
    assert.equal(shown.source, 'last-good');
    assert.match(r.errors[1], /articles\[0\]\.url: must be a whole link that starts with https:\/\//);
  });

  test('broken JSON, a file over 1 MB and a folder in its place are refused the same way', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    await feeds.load();

    h.writeFeed('{"desk": "product-feed",');
    assert.equal((await feeds.load()).source, 'last-good');
    assert.match(r.errors.at(-1), /not valid JSON/);

    h.writeFeed(JSON.stringify({ ...edition('2026-11-28'), pad: 'x'.repeat(MAX_FEED_BYTES) }));
    assert.equal((await feeds.load()).source, 'last-good');
    assert.match(r.errors.at(-1), /too big \(\d+ bytes, limit is 1048576\)/);

    h.removeFeed();
    fs.mkdirSync(feedPath(h.home));
    assert.equal((await feeds.load()).source, 'last-good');
    assert.match(r.errors.at(-1), /not a file/);
    assert.equal(r.errors.length, 3);
  });

  test('a change made in place (same inode) is noticed too', async () => {
    const h = deskHome();
    h.writeFeedInPlace(edition('2026-11-27'));
    const feeds = createFeedLoader(h.home, recorder());
    assert.equal((await feeds.load()).source, 'live');
    h.writeFeedInPlace(httpUrl('2026-11-27'));
    assert.equal((await feeds.load()).source, 'last-good');
    h.writeFeedInPlace(edition('2026-11-28'));
    const { feed, source } = await feeds.load();
    assert.equal(source, 'live');
    assert.equal(feed.edition, '2026-11-28');
  });

  test('invalid at startup: serves the newest valid file in editions/, skipping an invalid newer one', async () => {
    const h = deskHome();
    h.writeFeed(httpUrl('2026-11-27'));
    h.writeEdition('2026-11-25.json', edition('2026-11-25'));
    h.writeEdition('2026-11-26.json', edition('2026-11-26'));
    h.writeEdition('2026-11-27.json', httpUrl('2026-11-27'));
    h.writeEdition('2026-11-28.json.bak', edition('2026-11-28')); // not an edition name
    h.writeEdition('latest.json', edition('2026-11-29')); // not an edition name
    const r = recorder();
    const { feed, source } = await createFeedLoader(h.home, r).load();
    assert.equal(source, 'edition:2026-11-26.json');
    assert.equal(feed.edition, '2026-11-26');
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], /skipping .*editions\/2026-11-27\.json, it isn't a valid edition:\n {2}- articles\[0\]\.url/);
    assert.match(r.errors[1], /feed\.json isn't a valid edition, so it keeps showing 2026-11-26\.json from editions\//);
  });

  test('with no feed.json yet, the newest valid edition is shown (and noted once)', async () => {
    const h = deskHome();
    h.writeEdition('2026-11-26.json', edition('2026-11-26'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    assert.equal((await feeds.load()).source, 'edition:2026-11-26.json');
    assert.equal((await feeds.load()).source, 'edition:2026-11-26.json');
    assert.equal(r.errors.length, 0);
    assert.equal(r.infos.length, 1);
    assert.match(r.infos[0], /no .*feed\.json, so it shows 2026-11-26\.json from editions\//);
  });

  test('with nothing valid anywhere, serves the sample marked "sample": true', async () => {
    const h = deskHome();
    h.writeFeed(httpUrl('2026-11-27'));
    h.writeEdition('2026-11-27.json', httpUrl('2026-11-27'));
    const r = recorder();
    const { feed, source } = await createFeedLoader(h.home, r).load();
    assert.equal(source, 'sample');
    assert.equal(feed.sample, true);
    assert.deepEqual(feed.articles, SAMPLE.articles);
    assert.match(r.errors.at(-1), /keeps showing the sample edition:/);
  });

  test('with no DESK_HOME folders at all, serves the sample', async () => {
    const home = path.join(os.tmpdir(), `the-desk-nothing-${process.pid}-${Date.now()}`);
    const { feed, source } = await createFeedLoader(home, recorder()).load();
    assert.equal(source, 'sample');
    assert.equal(feed.sample, true);
  });

  test('a valid feed.json that disappears leaves the last good edition showing', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const feeds = createFeedLoader(h.home, recorder());
    await feeds.load();
    h.removeFeed();
    const { feed, source } = await feeds.load();
    assert.equal(source, 'last-good');
    assert.equal(feed.edition, '2026-11-27');
  });

  test('picks up a fixed or newer feed.json straight away', async () => {
    const h = deskHome();
    h.writeFeed(httpUrl('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    assert.equal((await feeds.load()).source, 'sample');

    h.writeFeed(edition('2026-11-27'));
    assert.equal((await feeds.load()).source, 'live');
    h.writeFeed(edition('2026-11-28'));
    const { feed, source } = await feeds.load();
    assert.equal(source, 'live');
    assert.equal(feed.edition, '2026-11-28');
    assert.deepEqual(r.infos.map((m) => m.match(/the (\S+) edition/)[1]), ['2026-11-27', '2026-11-28']);
  });

  test('logs an invalid file once per change, not on every request', async () => {
    const h = deskHome();
    h.writeFeed(httpUrl('2026-11-27'));
    h.writeEdition('2026-11-27.json', httpUrl('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    for (let i = 0; i < 5; i++) await feeds.load();
    assert.equal(r.errors.length, 2, 'feed.json once, the skipped edition once');

    const other = httpUrl('2026-11-27');
    other.articles[1].themes = ['pricing'];
    h.writeFeed(other);
    for (let i = 0; i < 5; i++) await feeds.load();
    assert.equal(r.errors.length, 3, 'once more for the new invalid version');
    assert.match(r.errors[2], /articles\[1\]\.themes\[0\]: "pricing" is not in the themes list/);
  });

  test('overlapping requests after a change still log it once', async () => {
    const h = deskHome();
    h.writeFeed(httpUrl('2026-11-27'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    const results = await Promise.all(Array.from({ length: 10 }, () => feeds.load()));
    assert.ok(results.every((x) => x.source === 'sample'));
    assert.equal(r.errors.length, 1);
  });

  test('reads and checks a file again only when it changes', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const { fsp, reads } = countingFsp();
    const feeds = createFeedLoader(h.home, { ...recorder(), fsp });
    for (let i = 0; i < 5; i++) await feeds.load();
    assert.equal(reads['feed.json'], 1);
    h.writeFeed(httpUrl('2026-11-28'));
    for (let i = 0; i < 5; i++) await feeds.load();
    assert.equal(reads['feed.json'], 2);

    const h2 = deskHome();
    h2.writeEdition('2026-11-26.json', edition('2026-11-26'));
    const counted = countingFsp();
    const fromEditions = createFeedLoader(h2.home, { ...recorder(), fsp: counted.fsp });
    for (let i = 0; i < 5; i++) assert.equal((await fromEditions.load()).source, 'edition:2026-11-26.json');
    assert.equal(counted.reads['2026-11-26.json'], 1);
  });

  test('works with a log that has no info()', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    const errors = [];
    const { source } = await createFeedLoader(h.home, { log: { error: (m) => errors.push(m) } }).load();
    assert.equal(source, 'live');
    assert.deepEqual(errors, []);
  });

  test('a valid feed.json is kept on disk as last-good.json byte for byte; a "sample" key is still never served', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27', { sample: true }));
    assert.equal((await createFeedLoader(h.home, recorder()).load()).source, 'live');
    assert.ok(fs.readFileSync(lastGoodPath(h.home, 'product-feed')).equals(fs.readFileSync(feedPath(h.home))));
    assert.deepEqual(fs.readdirSync(productFeedDir(h.home)).sort(), ['editions', 'feed.json', 'last-good.json'], 'no temp file left');

    h.writeFeed(httpUrl('2026-11-28'));
    const { feed, source } = await createFeedLoader(h.home, recorder()).load(); // a fresh server
    assert.equal(source, 'last-good');
    assert.deepEqual(feed, edition('2026-11-27'));
    assert.equal('sample' in feed, false);
  });

  // The Sprint 1 follow-up: a restart with a bad feed.json and no editions/ used to show the sample.
  test('after a restart with a bad feed.json and no editions/, the last good edition still shows', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    assert.equal((await createFeedLoader(h.home, recorder()).load()).source, 'live');

    h.writeFeed(httpUrl('2026-11-28'));
    const r = recorder();
    const { feed, source } = await createFeedLoader(h.home, r).load(); // a fresh server
    assert.equal(source, 'last-good');
    assert.deepEqual(feed, edition('2026-11-27'));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /feed\.json isn't a valid edition, so it keeps showing the last good edition \(2026-11-27\):/);
  });

  test('after a restart, a newer valid edition in editions/ wins over an older last-good.json; the same date does not', async () => {
    const h = deskHome();
    h.writeFeed(edition('2026-11-27'));
    assert.equal((await createFeedLoader(h.home, recorder()).load()).source, 'live');
    h.writeFeed(httpUrl('2026-11-29'));
    h.writeEdition('2026-11-27.json', edition('2026-11-27'));
    assert.equal((await createFeedLoader(h.home, recorder()).load()).source, 'last-good', 'the same date');
    h.writeEdition('2026-11-28.json', edition('2026-11-28'));
    const r = recorder();
    const { feed, source } = await createFeedLoader(h.home, r).load();
    assert.equal(source, 'edition:2026-11-28.json');
    assert.equal(feed.edition, '2026-11-28');
    assert.match(r.errors[0], /keeps showing 2026-11-28\.json from editions\//);
  });

  test('a damaged last-good.json is skipped, logged once, and editions/ comes next', async () => {
    const h = deskHome();
    h.writeFeed(httpUrl('2026-11-28'));
    h.writeLastGood(httpUrl('2026-11-27'));
    h.writeEdition('2026-11-26.json', edition('2026-11-26'));
    const r = recorder();
    const feeds = createFeedLoader(h.home, r);
    for (let i = 0; i < 3; i++) assert.equal((await feeds.load()).source, 'edition:2026-11-26.json');
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], /skipping .*product-feed\/last-good\.json, it isn't a valid edition:\n {2}- articles\[0\]\.url/);
  });

  test('throws when even the sample is missing (the server answers 500)', async () => {
    const h = deskHome();
    const feeds = createFeedLoader(h.home, { ...recorder(), samplePath: path.join(h.home, 'missing.json') });
    await assert.rejects(feeds.load(), { code: 'ENOENT' });
  });
});
