// The News desk on the server (server/news.js): which edition GET /api/news serves, what
// GET /api/breaking shows, the rules for Snow's News state, and the sample edition.
// Every test uses a temp DESK_HOME and a fixed "now".
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  NEWS_SCHEMA_PATH,
  REPO_ROOT,
  SAMPLE_BREAKING_PATH,
  SAMPLE_NEWS_PATH,
  breakingPath,
  editionsDir,
  lastGoodPath,
  newsDir,
  newsPath,
  statePath,
} from '../server/config.js';
import { MAX_NEWS_BYTES, validateBreaking, validateNews } from '../server/news-schema.js';
import { createBreakingReader, createNewsLoader, isTodayInToronto, torontoDate } from '../server/news.js';
import { MAX_STATE_BYTES, STATE_RULES, checkState, createStateStore } from '../server/state-store.js';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const FIXTURE = readJson(path.join(REPO_ROOT, 'test', 'fixtures', 'news', 'news.json'));
const BREAKING = readJson(path.join(REPO_ROOT, 'test', 'fixtures', 'news', 'breaking.json'));
const SAMPLE = readJson(SAMPLE_NEWS_PATH);
const SAMPLE_BREAKING = readJson(SAMPLE_BREAKING_PATH);
const STORY_SCHEMA = readJson(NEWS_SCHEMA_PATH).$defs.story.properties;

/** A valid edition for a day. */
const edition = (date, extra = {}) => ({ ...structuredClone(FIXTURE), edition: date, ...extra });
/** An edition that fails the contract (an http:// link). */
const broken = (date) => {
  const news = edition(date);
  news.stories[0].sources[0].url = 'http://example.com/news/test-story-one';
  return news;
};

// "Now" for the breaking tests: Monday 7 December 2026, 3 pm in Toronto (20:00 UTC).
const NOW = Date.parse('2026-12-07T15:00:00-05:00');

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A temp DESK_HOME with helpers to write the News agent's files. */
function deskHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-news-'));
  tmpDirs.push(home);
  const editions = editionsDir(home, 'news');
  fs.mkdirSync(editions, { recursive: true });
  const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  // A new file renamed into place (a new inode), as a careful agent writes it.
  const replace = (file, value) => {
    fs.writeFileSync(`${file}.tmp`, text(value));
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    home,
    writeNews: (value) => replace(newsPath(home), value),
    writeNewsInPlace: (value) => fs.writeFileSync(newsPath(home), text(value)),
    removeNews: () => fs.rmSync(newsPath(home)),
    writeEdition: (name, value) => fs.writeFileSync(path.join(editions, name), text(value)),
    writeLastGood: (value) => replace(lastGoodPath(home, 'news'), value),
    readLastGood: () => readJson(lastGoodPath(home, 'news')),
    hasLastGood: () => fs.existsSync(lastGoodPath(home, 'news')),
    writeBreaking: (value) => replace(breakingPath(home), value),
    files: () => fs.readdirSync(newsDir(home)).sort(),
  };
}

function recorder() {
  const errors = [];
  const infos = [];
  return { errors, infos, log: { error: (m) => errors.push(m), info: (m) => infos.push(m) } };
}

// fs.promises that counts reads per file name and renames onto last-good.json (one per write).
function countingFsp() {
  const reads = {};
  const counts = { lastGoodWrites: 0 };
  const fsp = {
    ...fs.promises,
    readFile: (file, ...rest) => {
      const name = path.basename(String(file));
      reads[name] = (reads[name] || 0) + 1;
      return fs.promises.readFile(file, ...rest);
    },
    rename: async (from, to) => {
      if (path.basename(String(to)) === 'last-good.json') counts.lastGoodWrites++;
      return fs.promises.rename(from, to);
    },
  };
  return { fsp, reads, counts };
}

describe('createNewsLoader: which edition GET /api/news serves', () => {
  test('a valid news.json is served as "live" and copied to last-good.json', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const r = recorder();
    const { news, source } = await createNewsLoader(h.home, r).load();
    assert.equal(source, 'live');
    assert.deepEqual(news, edition('2026-12-07'));
    assert.ok(fs.readFileSync(lastGoodPath(h.home, 'news')).equals(fs.readFileSync(newsPath(h.home))), 'a byte-for-byte copy');
    assert.deepEqual(h.files(), ['editions', 'last-good.json', 'news.json'], 'no temp file left behind');
    assert.equal(r.errors.length, 0);
    assert.equal(r.infos.length, 1);
    assert.match(r.infos[0], /showing the 2026-12-07 edition from .*news\.json/);
  });

  test('an agent file never says "sample": not live, not last-good.json, not editions/', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07', { sample: true }));
    const live = await createNewsLoader(h.home, recorder()).load();
    assert.equal(live.source, 'live');
    assert.equal('sample' in live.news, false);
    h.writeNews(broken('2026-12-08'));
    const restarted = await createNewsLoader(h.home, recorder()).load(); // the byte copy still has the key...
    assert.equal(restarted.source, 'last-good');
    assert.equal('sample' in restarted.news, false, '...but it is dropped when read back');

    const h2 = deskHome();
    h2.writeNews(broken('2026-12-08'));
    h2.writeLastGood(edition('2026-12-07', { sample: true }));
    const kept = await createNewsLoader(h2.home, recorder()).load();
    assert.equal(kept.source, 'last-good');
    assert.equal('sample' in kept.news, false);

    const h3 = deskHome();
    h3.writeEdition('2026-12-06.json', edition('2026-12-06', { sample: 'yes' }));
    const fromEditions = await createNewsLoader(h3.home, recorder()).load();
    assert.equal(fromEditions.source, 'edition:2026-12-06.json');
    assert.equal('sample' in fromEditions.news, false);
  });

  test('a bad news.json after a good one keeps the last good edition showing, and logs why once', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const r = recorder();
    const loader = createNewsLoader(h.home, r);
    assert.equal((await loader.load()).source, 'live');

    h.writeNews(broken('2026-12-08'));
    for (let i = 0; i < 3; i++) {
      const { news, source } = await loader.load();
      assert.equal(source, 'last-good');
      assert.equal(news.edition, '2026-12-07');
    }
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /news\.json isn't a valid edition, so it keeps showing the last good edition \(2026-12-07\):/);
    assert.match(r.errors[0], /\n {2}- stories\[0\]\.sources\[0\]\.url: must start with https:\/\//);
    assert.deepEqual(h.readLastGood(), edition('2026-12-07'), 'the bad file never reaches last-good.json');
  });

  test('after a restart, a bad news.json falls back to last-good.json on disk, ahead of editions/', async () => {
    const h = deskHome();
    h.writeEdition('2026-12-06.json', edition('2026-12-06'));
    h.writeNews(edition('2026-12-07'));
    assert.equal((await createNewsLoader(h.home, recorder()).load()).source, 'live');

    h.writeNews(broken('2026-12-08'));
    const r = recorder();
    const restarted = createNewsLoader(h.home, r); // a fresh server: nothing in memory
    const { news, source } = await restarted.load();
    assert.equal(source, 'last-good');
    assert.deepEqual(news, edition('2026-12-07'));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /keeps showing the last good edition \(2026-12-07\)/);
  });

  test('a damaged last-good.json is skipped (logged once per change) and editions/ comes next', async () => {
    const h = deskHome();
    h.writeNews(broken('2026-12-08'));
    h.writeLastGood('{"desk": "news",');
    h.writeEdition('2026-12-06.json', edition('2026-12-06'));
    const r = recorder();
    const loader = createNewsLoader(h.home, r);
    for (let i = 0; i < 3; i++) assert.equal((await loader.load()).source, 'edition:2026-12-06.json');
    assert.equal(r.errors.length, 2, 'last-good.json once, news.json once');
    assert.match(r.errors[0], /skipping .*last-good\.json, it isn't a valid edition:\n {2}- not valid JSON/);
    assert.match(r.errors[1], /news\.json isn't a valid edition, so it keeps showing 2026-12-06\.json from editions\//);

    // A last-good.json that parses but breaks the contract is skipped the same way.
    h.writeLastGood(broken('2026-12-07'));
    assert.equal((await loader.load()).source, 'edition:2026-12-06.json');
    assert.equal(r.errors.length, 3);
    assert.match(r.errors[2], /skipping .*last-good\.json, it isn't a valid edition:\n {2}- stories\[0\]\.sources\[0\]\.url/);

    // The next valid news.json replaces it.
    h.writeNews(edition('2026-12-08'));
    assert.equal((await loader.load()).source, 'live');
    assert.deepEqual(h.readLastGood(), edition('2026-12-08'));
  });

  test('last-good.json is written only when it differs from the live edition', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const c = countingFsp();
    const loader = createNewsLoader(h.home, { ...recorder(), fsp: c.fsp });
    for (let i = 0; i < 5; i++) await loader.load();
    assert.equal(c.counts.lastGoodWrites, 1, 'once for the new edition, not per request');

    const c2 = countingFsp();
    const restarted = createNewsLoader(h.home, { ...recorder(), fsp: c2.fsp });
    for (let i = 0; i < 3; i++) await restarted.load();
    assert.equal(c2.counts.lastGoodWrites, 0, 'a restart with the same news.json writes nothing');

    fs.rmSync(lastGoodPath(h.home, 'news'));
    await restarted.load();
    assert.equal(c2.counts.lastGoodWrites, 1, 'deleted while news.json stayed the same: written again');
    assert.deepEqual(h.readLastGood(), edition('2026-12-07'));

    fs.writeFileSync(lastGoodPath(h.home, 'news'), '{"damaged": tru');
    await restarted.load();
    assert.equal(c2.counts.lastGoodWrites, 2, 'damaged in place: written again');
    assert.deepEqual(h.readLastGood(), edition('2026-12-07'));

    const now = new Date();
    fs.utimesSync(lastGoodPath(h.home, 'news'), now, now);
    await restarted.load();
    assert.equal(c2.counts.lastGoodWrites, 2, 'touched but the same: nothing to write');

    h.writeNews(edition('2026-12-08'));
    await restarted.load();
    assert.equal(c2.counts.lastGoodWrites, 3, 'a new edition: written');
    assert.equal(h.readLastGood().edition, '2026-12-08');
  });

  test("a last-good.json that can't be written is logged once; the live edition still shows", async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const fsp = {
      ...fs.promises,
      rename: async (from, to) => {
        if (path.basename(String(to)) === 'last-good.json') throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        return fs.promises.rename(from, to);
      },
    };
    const r = recorder();
    const loader = createNewsLoader(h.home, { ...r, fsp });
    for (let i = 0; i < 3; i++) assert.equal((await loader.load()).source, 'live');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /couldn't keep a copy of the 2026-12-07 edition in .*last-good\.json \(ENOSPC\)/);
    assert.deepEqual(h.files(), ['editions', 'news.json'], 'no last-good.json and no temp file');

    h.writeNews(edition('2026-12-08'));
    await loader.load();
    assert.equal(r.errors.length, 2, 'tried again (and logged again) for the next edition');
  });

  test('editions/ is picked by the date in the file name; invalid and oddly named files are skipped', async () => {
    const h = deskHome();
    h.writeNews(broken('2026-12-08'));
    h.writeEdition('2026-12-05.json', edition('2026-12-30')); // the name decides, not the edition inside
    h.writeEdition('2026-12-06.json', edition('2026-12-01'));
    h.writeEdition('2026-12-07.json', broken('2026-12-07'));
    h.writeEdition('2026-12-08.json.bak', edition('2026-12-08'));
    h.writeEdition('2026-12-9.json', edition('2026-12-09'));
    h.writeEdition('latest.json', edition('2026-12-10'));
    h.writeEdition('.2026-12-11.json', edition('2026-12-11'));
    fs.mkdirSync(path.join(editionsDir(h.home, 'news'), '2026-12-12.json')); // a folder with an edition's name
    const r = recorder();
    const { news, source } = await createNewsLoader(h.home, r).load();
    assert.equal(source, 'edition:2026-12-06.json');
    assert.equal(news.edition, '2026-12-01');
    assert.equal(r.errors.length, 3);
    assert.match(r.errors[0], /skipping .*editions\/2026-12-12\.json, it isn't a valid edition:\n {2}- not a file/);
    assert.match(r.errors[1], /skipping .*editions\/2026-12-07\.json, it isn't a valid edition:\n {2}- stories\[0\]/);
    assert.match(r.errors[2], /keeps showing 2026-12-06\.json from editions\//);
  });

  test('with nothing valid anywhere, serves the sample, marked "sample": true by the server', async () => {
    const h = deskHome();
    h.writeNews(broken('2026-12-08'));
    h.writeEdition('2026-12-07.json', broken('2026-12-07'));
    const r = recorder();
    const { news, source } = await createNewsLoader(h.home, r).load();
    assert.equal(source, 'sample');
    assert.equal(news.sample, true);
    assert.deepEqual({ ...news, sample: undefined }, { ...SAMPLE, sample: undefined });
    assert.equal('sample' in SAMPLE, false, 'the sample file itself never says it; the server adds it');
    assert.match(r.errors.at(-1), /keeps showing the sample edition:/);
    assert.equal(h.hasLastGood(), false, 'the sample is never kept as last-good');
  });

  test('with no news folder at all, serves the sample and writes nothing', async () => {
    const home = path.join(os.tmpdir(), `the-desk-no-news-${process.pid}-${Date.now()}`);
    const r = recorder();
    const { news, source } = await createNewsLoader(home, r).load();
    assert.equal(source, 'sample');
    assert.equal(news.sample, true);
    assert.equal(fs.existsSync(home), false);
    assert.equal(r.errors.length, 0);
    assert.match(r.infos[0], /no .*news\.json, so it shows the sample edition/);
  });

  test('logs an invalid file once per change, not on every request', async () => {
    const h = deskHome();
    h.writeNews(broken('2026-12-08'));
    h.writeEdition('2026-12-07.json', broken('2026-12-07'));
    const r = recorder();
    const loader = createNewsLoader(h.home, r);
    for (let i = 0; i < 5; i++) await loader.load();
    assert.equal(r.errors.length, 2, 'news.json once, the skipped edition once');

    const other = broken('2026-12-08');
    other.more[0].region = 'mars';
    h.writeNewsInPlace(other); // changed where it is (same inode)
    for (let i = 0; i < 5; i++) await loader.load();
    assert.equal(r.errors.length, 3, 'once more for the new invalid version');
    assert.match(r.errors[2], /more\[0\]\.region: must be one of/);
  });

  test('overlapping requests after a change log once and write last-good.json once', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const c = countingFsp();
    const r = recorder();
    const loader = createNewsLoader(h.home, { ...r, fsp: c.fsp });
    const results = await Promise.all(Array.from({ length: 10 }, () => loader.load()));
    assert.ok(results.every((x) => x.source === 'live'));
    assert.equal(r.infos.length, 1);
    assert.equal(c.counts.lastGoodWrites, 1);

    h.writeNews(broken('2026-12-08'));
    await Promise.all(Array.from({ length: 10 }, () => loader.load()));
    assert.equal(r.errors.length, 1);
  });

  test('reads and checks news.json again only when it changes', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const c = countingFsp();
    const loader = createNewsLoader(h.home, { ...recorder(), fsp: c.fsp });
    for (let i = 0; i < 5; i++) await loader.load();
    assert.equal(c.reads['news.json'], 1);
    h.writeNews(edition('2026-12-08'));
    for (let i = 0; i < 5; i++) await loader.load();
    assert.equal(c.reads['news.json'], 2);
  });

  // N3 review: last-good.json follows what Snow was shown, so after a restart it must not hide a
  // newer edition the agent archived.
  test('after a restart, a newer valid edition in editions/ wins over an older last-good.json', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    assert.equal((await createNewsLoader(h.home, recorder()).load()).source, 'live');
    h.writeNews(broken('2026-12-09'));
    h.writeEdition('2026-12-08.json', edition('2026-12-08'));
    const r = recorder();
    const { news, source } = await createNewsLoader(h.home, r).load();
    assert.equal(source, 'edition:2026-12-08.json');
    assert.deepEqual(news, edition('2026-12-08'));
    assert.match(r.errors[0], /news\.json isn't a valid edition, so it keeps showing 2026-12-08\.json from editions\//);
  });

  test('last-good stays when editions/ has only the same date, an older one, or an invalid newer file', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    assert.equal((await createNewsLoader(h.home, recorder()).load()).source, 'live');
    h.writeNews(broken('2026-12-09'));
    const restart = () => createNewsLoader(h.home, recorder()).load();

    h.writeEdition('2026-12-06.json', edition('2026-12-06'));
    assert.equal((await restart()).source, 'last-good', 'older');
    h.writeEdition('2026-12-07.json', edition('2026-12-07'));
    assert.equal((await restart()).source, 'last-good', 'the same date: what Snow was shown wins');
    h.writeEdition('2026-12-08.json', broken('2026-12-08'));
    assert.equal((await restart()).source, 'last-good', 'a newer file that is invalid');
    h.writeEdition('2026-12-09.json', edition('2026-12-05'));
    const shown = await restart();
    assert.equal(shown.source, 'last-good', 'the newest file name, but an older edition inside: the edition date decides');
    assert.equal(shown.news.edition, '2026-12-07');
  });

  test('without a restart too: a newer edition archived while news.json is broken is shown, and last-good returns when it goes', async () => {
    const h = deskHome();
    h.writeNews(edition('2026-12-07'));
    const loader = createNewsLoader(h.home, recorder());
    assert.equal((await loader.load()).source, 'live');
    h.writeNews(broken('2026-12-09'));
    assert.equal((await loader.load()).source, 'last-good');
    h.writeEdition('2026-12-08.json', edition('2026-12-08'));
    assert.equal((await loader.load()).source, 'edition:2026-12-08.json');
    fs.rmSync(path.join(editionsDir(h.home, 'news'), '2026-12-08.json'));
    const back = await loader.load();
    assert.equal(back.source, 'last-good');
    assert.equal(back.news.edition, '2026-12-07');
  });

  test('last-good.json is the live file byte for byte, so a file near the size limit still fits after a restart', async () => {
    const h = deskHome();
    // Lots of tiny values: compact, the file is just under 1 MB; pretty-printed it would be over 3 MB.
    const big = { ...edition('2026-12-07'), pad: [] };
    big.pad = new Array(Math.floor((MAX_NEWS_BYTES - Buffer.byteLength(JSON.stringify(big)) - 64) / 2)).fill(0);
    const compact = JSON.stringify(big);
    assert.ok(Buffer.byteLength(compact) <= MAX_NEWS_BYTES && Buffer.byteLength(compact) > MAX_NEWS_BYTES - 100);
    assert.ok(Buffer.byteLength(JSON.stringify(big, null, 2)) > MAX_NEWS_BYTES, 'pretty-printed it would not fit');
    h.writeNews(compact);
    const r = recorder();
    assert.equal((await createNewsLoader(h.home, r).load()).source, 'live');
    assert.deepEqual(r.errors, [], 'kept without trouble');
    assert.ok(fs.readFileSync(lastGoodPath(h.home, 'news')).equals(fs.readFileSync(newsPath(h.home))));

    h.writeNews(broken('2026-12-08'));
    const r2 = recorder();
    const { news, source } = await createNewsLoader(h.home, r2).load();
    assert.equal(source, 'last-good');
    assert.equal(news.pad.length, big.pad.length);
    assert.ok(!r2.errors.some((m) => /too big|skipping/.test(m)), r2.errors.join('\n'));
  });

  test('last-good.json keeps the file exactly as written: byte-order mark, tabs, CRLF, number spelling', async () => {
    const h = deskHome();
    const text = `\uFEFF${JSON.stringify(edition('2026-12-07'), null, '\t').replace(/\n/g, '\r\n').replace('"rank": 1,', '"rank": 1e0,')}`;
    h.writeNews(text);
    const live = await createNewsLoader(h.home, recorder()).load();
    assert.equal(live.source, 'live');
    assert.equal(live.news.stories[0].rank, 1);
    assert.equal(fs.readFileSync(lastGoodPath(h.home, 'news'), 'utf8'), text);
    h.writeNews(broken('2026-12-08'));
    const restarted = await createNewsLoader(h.home, recorder()).load();
    assert.equal(restarted.source, 'last-good');
    assert.deepEqual(restarted.news, edition('2026-12-07'));
  });

  test('only the newest 60 dated files in editions/ are looked at (noted once); a request stats at most 60 of them', async () => {
    const h = deskHome();
    h.writeNews(broken('2026-12-31'));
    const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    // 70 dated files: the oldest is valid, the 69 newer ones are broken.
    h.writeEdition(`${day(0)}.json`, edition(day(0)));
    for (let i = 1; i < 70; i++) h.writeEdition(`${day(i)}.json`, '{"broken":');
    const editionsFolder = editionsDir(h.home, 'news');
    let stats = 0;
    const fsp = {
      ...fs.promises,
      stat: (file, ...rest) => {
        if (path.dirname(String(file)) === editionsFolder) stats++;
        return fs.promises.stat(file, ...rest);
      },
    };
    const r = recorder();
    const loader = createNewsLoader(h.home, { ...r, fsp });
    assert.equal((await loader.load()).source, 'sample', 'the valid file is the 70th newest, so it is not looked at');
    for (let i = 0; i < 3; i++) {
      stats = 0;
      assert.equal((await loader.load()).source, 'sample');
      assert.equal(stats, 60, 'one stat per looked-at file, none for the 10 older ones');
    }
    const notes = r.infos.filter((m) => /dated files/.test(m));
    assert.equal(notes.length, 1, 'noted once');
    assert.match(notes[0], /editions has 70 dated files; it only looks at the newest 60 \(2026-01-11\.json onward\)/);
    assert.equal(r.errors.filter((m) => /skipping .*editions\//.test(m)).length, 60, 'each looked-at broken file logged once');

    for (let i = 60; i < 70; i++) fs.rmSync(path.join(editionsFolder, `${day(i)}.json`));
    assert.equal((await loader.load()).source, `edition:${day(0)}.json`, 'back to 60 files: the valid one is in range');
  });

  test('throws when even the sample is missing (the server answers 500)', async () => {
    const h = deskHome();
    const loader = createNewsLoader(h.home, { ...recorder(), samplePath: path.join(h.home, 'missing.json') });
    await assert.rejects(loader.load(), { code: 'ENOENT' });
  });
});

describe('today in Toronto', () => {
  test('torontoDate follows Toronto across midnight, in winter and in summer time', () => {
    assert.equal(torontoDate(Date.parse('2026-12-07T04:59:59Z')), '2026-12-06');
    assert.equal(torontoDate(Date.parse('2026-12-07T05:00:00Z')), '2026-12-07');
    assert.equal(torontoDate(Date.parse('2026-07-01T03:59:59Z')), '2026-06-30');
    assert.equal(torontoDate(Date.parse('2026-07-01T04:00:00Z')), '2026-07-01');
  });

  const CASES = [
    ['2026-12-07T12:04:00-05:00', true, 'earlier today'],
    ['2026-12-07T00:00:00-05:00', true, 'just after midnight'],
    ['2026-12-07T23:59:59-05:00', true, 'later today'],
    ['2026-12-07T12:04-05:00', true, 'no seconds'],
    ['2026-12-07T17:04:00.123456789Z', true, 'fractions of a second'],
    ['2026-12-08T01:30:00+09:00', true, 'Tokyo time, tomorrow there but today in Toronto'],
    ['2026-12-07T02:00:00Z', false, 'today in UTC but yesterday evening in Toronto'],
    ['2026-12-06T12:04:00-05:00', false, 'yesterday'],
    ['2026-12-08T00:00:00-05:00', false, 'tomorrow'],
    ['2027-12-07T12:04:00-05:00', false, 'a year from now'],
    ['not a time', false, 'not a time'],
  ];

  test('isTodayInToronto decides by the Toronto calendar day of the moment', () => {
    for (const [at, expected, why] of CASES) assert.equal(isTodayInToronto(at, NOW), expected, `${at}: ${why}`);
    // 10 pm in Toronto is already tomorrow in UTC: a story from 8 pm Toronto is still today.
    const lateEvening = Date.parse('2026-12-07T22:00:00-05:00');
    assert.equal(isTodayInToronto('2026-12-08T01:00:00Z', lateEvening), true);
    assert.equal(isTodayInToronto('2026-12-08T05:00:00Z', lateEvening), false);
  });

  test("the machine's own timezone doesn't change the answer", () => {
    const newsModule = pathToFileURL(path.join(REPO_ROOT, 'server', 'news.js')).href;
    const script = [
      `import { isTodayInToronto, torontoDate } from ${JSON.stringify(newsModule)};`,
      `const cases = ${JSON.stringify(CASES.map(([at]) => at))};`,
      `console.log(JSON.stringify([torontoDate(${NOW}), ...cases.map((at) => isTodayInToronto(at, ${NOW}))]));`,
    ].join('\n');
    const expected = ['2026-12-07', ...CASES.map(([, today]) => today)];
    for (const tz of ['UTC', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), expected, tz);
    }
  });
});

describe('createBreakingReader: what GET /api/breaking shows', () => {
  const at = (when) => ({ ...structuredClone(BREAKING), at: when });

  test("today's valid breaking.json is shown, with its at", async () => {
    const h = deskHome();
    h.writeBreaking(BREAKING);
    const r = recorder();
    const story = await createBreakingReader(h.home, { ...r, now: () => NOW }).load();
    assert.deepEqual(story, BREAKING);
    assert.equal(story.at, '2026-12-07T12:04:00-05:00');
    assert.equal(r.errors.length, 0);
  });

  test('an at written in another timezone counts when it is today in Toronto', async () => {
    const h = deskHome();
    const reader = createBreakingReader(h.home, { ...recorder(), now: () => NOW });
    h.writeBreaking(at('2026-12-08T01:30:00+09:00'));
    assert.equal((await reader.load())?.at, '2026-12-08T01:30:00+09:00');
    h.writeBreaking(at('2026-12-07T02:00:00Z')); // yesterday evening in Toronto, today in UTC
    assert.equal(await reader.load(), null);
  });

  test('yesterday, tomorrow and a missing file give nothing, and log nothing', async () => {
    const h = deskHome();
    const r = recorder();
    const reader = createBreakingReader(h.home, { ...r, now: () => NOW });
    assert.equal(await reader.load(), null, 'missing');
    h.writeBreaking(at('2026-12-06T21:00:00-05:00'));
    assert.equal(await reader.load(), null, 'yesterday');
    h.writeBreaking(at('2026-12-08T09:00:00-05:00'));
    assert.equal(await reader.load(), null, 'tomorrow');
    assert.deepEqual(r.errors, []);
  });

  test('yesterday\'s story goes away at midnight in Toronto, without the file changing', async () => {
    const h = deskHome();
    h.writeBreaking(at('2026-12-07T21:00:00-05:00'));
    let now = Date.parse('2026-12-07T23:59:00-05:00');
    const reader = createBreakingReader(h.home, { ...recorder(), now: () => now });
    assert.notEqual(await reader.load(), null);
    now = Date.parse('2026-12-08T00:01:00-05:00');
    assert.equal(await reader.load(), null);
  });

  test('an invalid breaking.json gives nothing and is logged once per change', async () => {
    const h = deskHome();
    const r = recorder();
    const reader = createBreakingReader(h.home, { ...r, now: () => NOW });
    h.writeBreaking('{"id": "b1",');
    for (let i = 0; i < 3; i++) assert.equal(await reader.load(), null);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /breaking\.json isn't a valid breaking story, so no banner shows:\n {2}- not valid JSON/);

    const { at: _gone, ...noAt } = BREAKING;
    h.writeBreaking(noAt);
    for (let i = 0; i < 3; i++) assert.equal(await reader.load(), null);
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[1], /breaking: missing required field "at"/);

    h.writeBreaking(BREAKING);
    assert.deepEqual(await reader.load(), BREAKING, 'a fixed file shows straight away');
  });

  test('a breaking story can never mark itself as a sample', async () => {
    const h = deskHome();
    h.writeBreaking({ ...BREAKING, sample: true });
    const story = await createBreakingReader(h.home, { ...recorder(), now: () => NOW }).load();
    assert.equal('sample' in story, false);
  });

  test('a log line quotes nothing from the file raw: no control bytes, no password', async () => {
    const h = deskHome();
    const r = recorder();
    const bad = at('2026-12-07T12:04:00-05:00');
    bad.sources[0].url = `https://admin:SECRET@example.com/${String.fromCodePoint(0x1b)}[31m`;
    h.writeBreaking(bad);
    assert.equal(await createBreakingReader(h.home, { ...r, now: () => NOW }).load(), null);
    assert.equal(r.errors.length, 1);
    assert.ok(!r.errors[0].includes('SECRET') && !r.errors[0].includes(String.fromCodePoint(0x1b)), r.errors[0]);
  });
});

describe("Snow's News state rules", () => {
  const GOOD = {
    read: { '2026-12-07/s1': '2026-12-07T13:05:00.000Z', '2026-12-07/m2': 1765112700000 },
    dismissed: { '2026-12-07T12:04:00-05:00': '2026-12-07T17:10:00.000Z' },
    shelfOpen: true,
  };

  test('accepts read, dismissed and shelfOpen in their shapes, and keeps unknown keys', () => {
    assert.deepEqual(checkState({}, 'news'), { ok: true });
    assert.deepEqual(checkState(GOOD, 'news'), { ok: true });
    assert.deepEqual(checkState({ ...GOOD, later: { anything: true } }, 'news'), { ok: true });
    assert.deepEqual(checkState({ read: {}, dismissed: {}, shelfOpen: false }, 'news'), { ok: true });
  });

  test('names what is wrong', () => {
    const cases = [
      [[], 'state must be a JSON object'],
      [{ read: [] }, 'read must be an object'],
      [{ read: { s1: 1 } }, 'read keys must be "<edition>/<story id>", like "2026-12-07/s1" (got "s1")'],
      [{ read: { '2026-13-01/s1': 1 } }, 'read keys must be "<edition>/<story id>", like "2026-12-07/s1" (got "2026-13-01/s1")'],
      [{ read: { '2026-12-07/s 1': 1 } }, 'read keys must be "<edition>/<story id>", like "2026-12-07/s1" (got "2026-12-07/s 1")'],
      [{ read: { '2026-12-07/s1': 'yesterday' } }, 'read["2026-12-07/s1"] must be an ISO time or a number'],
      [{ read: { '2026-12-07/s1': true } }, 'read["2026-12-07/s1"] must be an ISO time or a number'],
      [{ read: { '2026-12-07/s1': null } }, 'read["2026-12-07/s1"] must be an ISO time or a number'],
      [{ dismissed: 'b1' }, 'dismissed must be an object'],
      [{ dismissed: { b1: 1 } }, `dismissed keys must be the breaking story's "at", like "2026-12-07T12:04:00-05:00" (got "b1")`],
      [{ dismissed: { '2026-12-07T12:04:00-05:00': '7 Dec' } }, 'dismissed["2026-12-07T12:04:00-05:00"] must be an ISO time or a number'],
      [{ shelfOpen: 'yes' }, 'shelfOpen must be true or false'],
      [{ shelfOpen: 1 }, 'shelfOpen must be true or false'],
    ];
    for (const [value, error] of cases) assert.deepEqual(checkState(value, 'news'), { ok: false, error }, JSON.stringify(value));
  });

  test('a long or odd key is quoted short and escaped in the answer', () => {
    const { error } = checkState({ read: { [`${'x'.repeat(200)}${String.fromCodePoint(0x1b)}`]: 1 } }, 'news');
    assert.ok(error.length < 140, error);
    assert.ok(!error.includes(String.fromCodePoint(0x1b)));
  });

  test("each desk's rules are its own; Product Feed's are unchanged", () => {
    assert.deepEqual(Object.keys(STATE_RULES['product-feed']), ['read', 'saved', 'folders', 'notes', 'xp', 'days', 'badges']);
    assert.deepEqual(Object.keys(STATE_RULES.news), ['read', 'dismissed', 'shelfOpen']);
    assert.deepEqual(checkState({ shelfOpen: 'yes', read: { a1: 1764250000000 } }), { ok: true }, 'Product Feed is the default and ignores News keys');
    assert.deepEqual(checkState({ xp: 'lots' }, 'news'), { ok: true }, 'XP is not a News key (it stays in Product Feed)');
    assert.deepEqual(checkState({ xp: 'lots' }, 'product-feed'), { ok: false, error: 'xp must be a number' });
  });

  test('the store takes the desk name and saves to desks/<desk>/state.json', async () => {
    const h = deskHome();
    const store = createStateStore(h.home, 'news');
    assert.equal(store.desk, 'news');
    assert.equal(store.filePath, statePath(h.home, 'news'));
    assert.equal(store.filePath, path.join(h.home, 'desks', 'news', 'state.json'));
    assert.deepEqual(await store.read(), {});
    await store.write(GOOD);
    assert.deepEqual(await store.read(), GOOD);
    assert.deepEqual(store.check({ shelfOpen: 'yes' }), { ok: false, error: 'shelfOpen must be true or false' });
    assert.equal(createStateStore(h.home, 'product-feed').filePath, path.join(h.home, 'desks', 'product-feed', 'state.json'));
    assert.throws(() => createStateStore(h.home, 'games'), /keeps no state for a desk called "games"/);
    assert.equal(MAX_STATE_BYTES, 1024 * 1024);
  });
});

describe('the sample edition (data/samples/news.sample.json)', () => {
  const allStories = [...SAMPLE.stories, ...SAMPLE.more];
  const sourceUrls = new Set([...fs.readFileSync(path.join(REPO_ROOT, 'agents', 'news', 'sources.yaml'), 'utf8').matchAll(/url: (https:\/\/[^\s}]+)/g)].map((m) => m[1]));
  const sentences = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean).length;

  test('passes the News contract, as npm run validate-news would check it', () => {
    assert.deepEqual(validateNews(SAMPLE), { ok: true, errors: [] });
    assert.equal(SAMPLE.desk, 'news');
  });

  test('has exactly 3 stories and 6 or 7 on the shelf, ranked 1 to 10 in order', () => {
    assert.equal(SAMPLE.stories.length, 3);
    assert.ok(SAMPLE.more.length === 6 || SAMPLE.more.length === 7, `more has ${SAMPLE.more.length}`);
    assert.deepEqual(allStories.map((s) => s.rank), allStories.map((_, i) => i + 1));
    assert.ok(allStories.length <= 10);
  });

  test('every region and every kind appears', () => {
    assert.deepEqual([...new Set(allStories.map((s) => s.region))].sort(), [...STORY_SCHEMA.region.enum].sort());
    assert.deepEqual([...new Set(allStories.map((s) => s.kind))].sort(), [...STORY_SCHEMA.kind.enum].sort());
  });

  test('every headline says [Sample]; summaries are 2 or 3 sentences; why and skeptic are filled in', () => {
    for (const s of allStories) {
      assert.match(s.headline, /^\[Sample\] \S/, s.id);
      const n = sentences(s.summary);
      assert.ok(n >= 2 && n <= 3, `${s.id}: summary has ${n} sentences`);
      assert.ok(s.why.length > 20 && s.skeptic.length > 20, s.id);
    }
  });

  test('sources are only section or home pages from agents/news/sources.yaml, at least 2 different per story', () => {
    assert.ok(sourceUrls.size > 10, 'read the sources list');
    for (const s of allStories) {
      assert.ok(s.sources.length >= 2, s.id);
      assert.equal(new Set(s.sources.map((src) => src.url)).size, s.sources.length, `${s.id}: repeats a source`);
      for (const src of s.sources) assert.ok(sourceUrls.has(src.url), `${s.id}: ${src.url} is not in sources.yaml`);
      assert.ok(!s.sources.some((src) => src.url === 'https://news.ycombinator.com'), 'Hacker News is a signal, not a source');
    }
  });

  test('a fixed edition date, an empty note, and no "sample" key of its own', () => {
    assert.equal(SAMPLE.edition, '2026-12-07');
    assert.equal(SAMPLE.note, '');
    assert.equal('sample' in SAMPLE, false);
  });

  test('breaking.sample.json is a valid [Sample] breaking story with sources from the list', () => {
    assert.deepEqual(validateBreaking(SAMPLE_BREAKING), { ok: true, errors: [] });
    assert.match(SAMPLE_BREAKING.headline, /^\[Sample\] /);
    assert.equal('sample' in SAMPLE_BREAKING, false);
    for (const src of SAMPLE_BREAKING.sources) assert.ok(sourceUrls.has(src.url), src.url);
  });

  test('the server never shows breaking.sample.json as breaking news', () => {
    const server = fs.readFileSync(path.join(REPO_ROOT, 'server', 'news.js'), 'utf8') + fs.readFileSync(path.join(REPO_ROOT, 'server', 'index.js'), 'utf8');
    assert.doesNotMatch(server, /SAMPLE_BREAKING_PATH|breaking\.sample/);
  });
});

// N3 review: two regexes held a raw U+FEFF. Invisible characters belong in code as escapes.
describe('the code itself', () => {
  test('has no raw control or invisible characters (they are written as escapes)', () => {
    const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
    const files = ['server', 'scripts', 'app', 'test'].flatMap((dir) =>
      fs.readdirSync(path.join(REPO_ROOT, dir), { recursive: true }).filter((f) => /\.(js|json|html|css)$/.test(f)).map((f) => path.join(dir, f)),
    );
    assert.ok(files.length > 20);
    const found = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const m of text.matchAll(unsafe)) {
        if (m[0] === '\n' || m[0] === '\r' || m[0] === '\t') continue;
        found.push(`${file}: U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} at line ${text.slice(0, m.index).split('\n').length}`);
      }
    }
    assert.deepEqual(found, []);
  });
});
