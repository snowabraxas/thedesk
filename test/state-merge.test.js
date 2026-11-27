// server/state-store.js: every save is merged into the file as it is now (two tabs, old tabs, page closes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { statePath } from '../server/config.js';
import { createServer } from '../server/index.js';
import { MAX_MAP_ENTRIES, MAX_SEEN_TABS, MAX_STATE_BYTES, STALE_TEMP_MS, checkState, createStateStore, mergeIncoming, mergeXp, newest } from '../server/state-store.js';

const homes = [];
const tempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-merge-'));
  homes.push(dir);
  return dir;
};
after(() => homes.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('mergeXp', () => {
  test("with a base, adds the page's own change to what is saved now, and never goes down", () => {
    assert.equal(mergeXp(40, 15, 15), 40, 'a stale page with no new XP keeps 40');
    assert.equal(mergeXp(40, 25, 15), 50, 'its own 10 lands on top');
    assert.equal(mergeXp(40, 10, 15), 40, 'a lower value never takes XP away');
  });
  test('without a base (old code): the larger', () => {
    assert.equal(mergeXp(40, 15, undefined), 40);
    assert.equal(mergeXp(40, 55, undefined), 55);
  });
  test('nothing saved yet: the page\'s XP; no XP sent: the saved one', () => {
    assert.equal(mergeXp(undefined, 20, 0), 20);
    assert.equal(mergeXp(undefined, -5, 0), 0);
    assert.equal(mergeXp(40, undefined, 10), 40);
  });
});

describe('mergeIncoming', () => {
  test('Product Feed: awarded and badges are unions keeping the earliest time; days a sorted union; _sync never saved', () => {
    const current = { xp: 40, awarded: { a1: 1, a2: 5 }, badges: { 'first-read': 10 }, days: ['2026-11-25', '2026-11-27'], notes: [{ id: 'n0' }] };
    const incoming = { xp: 15, awarded: { a2: 3, a3: 7 }, badges: { 'first-read': 20, curator: 30 }, days: ['2026-11-26'], notes: [{ id: 'n1' }], _sync: { xp: 15 } };
    assert.deepEqual(mergeIncoming('product-feed', current, incoming), {
      xp: 40,
      awarded: { a1: 1, a2: 3, a3: 7 },
      badges: { 'first-read': 10, curator: 30 },
      days: ['2026-11-25', '2026-11-26', '2026-11-27'],
      notes: [{ id: 'n1' }],
    });
  });

  test('days keep only real calendar days (anything else in the file is dropped), each once, the last 120', () => {
    const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    const current = { days: [...Array.from({ length: 120 }, (_, i) => day(i)), 'yesterday', '2026-02-30', 7] };
    const merged = mergeIncoming('product-feed', current, { days: ['2026-11-27', '2026-11-27'] });
    assert.equal(merged.days.length, 120);
    assert.equal(merged.days.at(-1), '2026-11-27');
    assert.equal(merged.days.filter((d) => d === '2026-11-27').length, 1);
    assert.ok(merged.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== '2026-02-30'));
  });

  test('News: awarded and dismissed are unions; read and shelfOpen are the incoming ones', () => {
    const current = { read: { '2026-12-07/s1': 1 }, awarded: { '2026-12-07/s1': 1 }, dismissed: { '2026-12-07T12:04:00-05:00': 2 }, shelfOpen: false };
    const incoming = { read: {}, shelfOpen: true };
    assert.deepEqual(mergeIncoming('news', current, incoming), {
      read: {},
      shelfOpen: true,
      awarded: { '2026-12-07/s1': 1 },
      dismissed: { '2026-12-07T12:04:00-05:00': 2 },
    });
  });

  test('keys neither side has stay absent; an empty file takes the incoming state as it is', () => {
    assert.deepEqual(mergeIncoming('product-feed', {}, { xp: 5, read: {} }), { xp: 5, read: {} });
    assert.deepEqual(mergeIncoming('news', {}, { read: {} }), { read: {} });
  });

  test("an entry in the file that isn't a time (a hand edit) is dropped; a __proto__ key never becomes a prototype", () => {
    const merged = mergeIncoming('product-feed', JSON.parse('{"awarded": {"a1": "soon", "a2": 5, "__proto__": {"x": 1}}}'), { awarded: { a1: 3 } });
    assert.deepEqual(merged.awarded, { a1: 3, a2: 5 });
    assert.equal(Object.getPrototypeOf(merged.awarded), Object.prototype);
    const fromFileOnly = mergeIncoming('product-feed', { badges: { ok: 1, bad: 'later' } }, {});
    assert.deepEqual(fromFileOnly.badges, { ok: 1 });
  });

  test('Product Feed keys are left alone on News and the other way round', () => {
    assert.deepEqual(mergeIncoming('news', { xp: 40, badges: { b: 1 } }, { xp: 1 }), { xp: 1 });
    assert.deepEqual(mergeIncoming('product-feed', { dismissed: { x: 1 } }, { read: {} }), { read: {} });
  });
});

describe('_sync and News awarded are checked like every other key', () => {
  test('_sync must be an object with a number xp', () => {
    assert.deepEqual(checkState({ _sync: { xp: 15 } }), { ok: true });
    assert.deepEqual(checkState({ _sync: {} }), { ok: true });
    assert.equal(checkState({ _sync: { xp: '15' } }).ok, false);
    assert.equal(checkState({ _sync: 15 }).ok, false);
  });
  test('News awarded keys are story keys', () => {
    assert.deepEqual(checkState({ awarded: { '2026-12-07/s1': 1 } }, 'news'), { ok: true });
    assert.equal(checkState({ awarded: { s1: 1 } }, 'news').ok, false);
  });
});

describe('the store and the routes', () => {
  async function start() {
    const deskHome = tempHome();
    const server = createServer({ deskHome, log: { error() {}, info() {} } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const put = (route, value) => fetch(base + route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: typeof value === 'string' ? value : JSON.stringify(value) });
    const stop = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });
    return { deskHome, base, put, stop };
  }

  test('each queued write merges into what the write before it saved (20 at once)', async () => {
    const store = createStateStore(tempHome(), 'product-feed');
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.write({ xp: 0, awarded: { [`a${i}`]: i }, _sync: { xp: 0 } })));
    const saved = await store.read();
    assert.equal(Object.keys(saved.awarded).length, 20);
    assert.equal(saved.xp, 0);
    assert.equal('_sync' in saved, false);
  });

  test('PUT: _sync is stripped, XP is added as a change, awarded kept', async () => {
    const { base, put, stop } = await start();
    try {
      assert.equal((await put('/api/state', { xp: 40, awarded: { a1: 1 } })).status, 200);
      assert.equal((await put('/api/state', { xp: 25, notes: [], _sync: { xp: 15 } })).status, 200);
      const saved = await (await fetch(`${base}/api/state`)).json();
      assert.deepEqual(saved, { xp: 50, notes: [], awarded: { a1: 1 } });
      assert.equal((await put('/api/state', { xp: 1, _sync: 'x' })).status, 400);
    } finally {
      await stop();
    }
  });

  test("PUT over a state.json that can't be read answers 500 and leaves the file alone", async () => {
    const { deskHome, put, stop } = await start();
    try {
      fs.mkdirSync(path.dirname(statePath(deskHome)), { recursive: true });
      fs.writeFileSync(statePath(deskHome), '{"xp": 30, "notes": [');
      const res = await put('/api/state', { xp: 1 });
      assert.equal(res.status, 500);
      assert.equal(fs.readFileSync(statePath(deskHome), 'utf8'), '{"xp": 30, "notes": [');
    } finally {
      await stop();
    }
  });

  test('PUT that would pass 1 MB once merged answers 413 and leaves the file alone', async () => {
    const { deskHome, put, stop } = await start();
    try {
      // Badges are a union with no cap of their own: two halves of different 200-character names.
      const names = (tag) => Object.fromEntries(Array.from({ length: 2600 }, (_, i) => [`${tag}${String(i).padStart(6, '0')}${'x'.repeat(190)}`, 1]));
      assert.equal((await put('/api/state', { badges: names('a') })).status, 200);
      const before = fs.readFileSync(statePath(deskHome), 'utf8');
      assert.ok(Buffer.byteLength(JSON.stringify(names('b'))) < MAX_STATE_BYTES);
      assert.equal((await put('/api/state', { badges: names('b') })).status, 413);
      assert.equal(fs.readFileSync(statePath(deskHome), 'utf8'), before);
    } finally {
      await stop();
    }
  });
});

describe('the same XP sent twice is added once (per-tab high-water mark)', () => {
  const body = (xp, base, tab = 'tab-a') => ({ xp, _sync: { xp: base, tab, sent: xp } });

  test('the exact same PUT three times pays once', async () => {
    const store = createStateStore(tempHome(), 'product-feed');
    await store.write({ xp: 40 });
    for (let i = 0; i < 3; i++) await store.write(body(50, 40));
    assert.equal((await store.read()).xp, 50);
  });

  test('a cut reply, then the retry with more XP since: only the new XP is added', async () => {
    const store = createStateStore(tempHome(), 'product-feed');
    await store.write({ xp: 40 });
    await store.write(body(50, 40)); // landed, but the page never heard back
    await store.write(body(60, 40)); // the retry still counts from 40, with 10 more earned since
    assert.equal((await store.read()).xp, 60);
  });

  test('another tab is counted on its own; a page with no tab id falls back to its base', async () => {
    const store = createStateStore(tempHome(), 'product-feed');
    await store.write({ xp: 40 });
    await store.write(body(50, 40, 'tab-a'));
    await store.write(body(45, 40, 'tab-b'));
    assert.equal((await store.read()).xp, 55);
    await store.write({ xp: 45, _sync: { xp: 40 } });
    assert.equal((await store.read()).xp, 60);
  });

  test('the marks survive a restart, are never shown to a page, and keep the newest 50 tabs', async () => {
    const home = tempHome();
    let store = createStateStore(home, 'product-feed', { now: () => 1000 });
    await store.write({ xp: 40 });
    await store.write(body(50, 40));
    store = createStateStore(home, 'product-feed', { now: () => 2000 }); // a restart
    await store.write(body(50, 40));
    assert.equal((await store.read()).xp, 50, 'not paid again after the restart');
    assert.equal('_seen' in (await store.readForPage()), false, 'GET never shows the marks');
    for (let i = 0; i < 60; i++) {
      store = createStateStore(home, 'product-feed', { now: () => 3000 + i });
      await store.write({ xp: 50, _sync: { xp: 50, tab: `t${i}`, sent: 50 } });
    }
    const seen = (await store.read())._seen;
    assert.equal(Object.keys(seen).length, MAX_SEEN_TABS);
    assert.ok(seen.t59 && !seen.t0 && !seen['tab-a'], 'the newest kept, the oldest pruned');
  });

  test("a page's own _seen is ignored, and __proto__ is never a tab", () => {
    const merged = mergeIncoming('product-feed', { xp: 40, _seen: { a: { xp: 99, at: 1 } } }, { xp: 50, _seen: { a: { xp: 0, at: 9 } }, _sync: { xp: 40, tab: 'a', sent: 50 } }, { now: 5 });
    assert.equal(merged.xp, 40, "the server's own mark (99) holds");
    assert.equal(checkState({ _sync: { xp: 1, tab: '__proto__', sent: 2 } }).ok, false);
  });
});

describe('union values are checked (they are permanent)', () => {
  const now = () => Date.parse('2026-11-27T15:00:00Z');
  test('days must be real calendar days, at most a day ahead', () => {
    assert.deepEqual(checkState({ days: ['2026-11-27', '2026-11-28'] }, 'product-feed', { now }), { ok: true });
    assert.match(checkState({ days: ['2026-11-30'] }, 'product-feed', { now }).error, /future/);
    assert.match(checkState({ days: ['2026-02-30'] }, 'product-feed', { now }).error, /days like/);
    assert.match(checkState({ days: ['yesterday'] }, 'product-feed', { now }).error, /days like/);
    assert.match(checkState({ days: [20261127] }, 'product-feed', { now }).error, /days like/);
  });
  test('awarded and badges hold times under names', () => {
    assert.deepEqual(checkState({ awarded: { a1: 1, a2: '2026-11-27T10:00:00-05:00' }, badges: { curator: 5 } }), { ok: true });
    assert.equal(checkState({ awarded: { a1: true } }).ok, false);
    assert.equal(checkState({ badges: { curator: 'soon' } }).ok, false);
    assert.equal(checkState({ awarded: { ['x'.repeat(201)]: 1 } }).ok, false);
  });
  test('XP: no negatives, nothing past Number.MAX_SAFE_INTEGER, and never a sum past it', () => {
    assert.equal(checkState({ _sync: { xp: -1 } }).ok, false);
    assert.equal(checkState({ _sync: { xp: 1, sent: -5 } }).ok, false);
    assert.equal(checkState({ xp: Number.MAX_SAFE_INTEGER + 2 }).ok, false);
    assert.equal(checkState({ _sync: { xp: Number.MAX_SAFE_INTEGER + 2 } }).ok, false);
    assert.equal(checkState({ xp: -3 }).ok, false);
    const top = Number.MAX_SAFE_INTEGER - 5;
    assert.equal(mergeXp(top, 100, 0), top, 'a sum past the limit keeps what is saved');
    assert.equal(mergeXp(10, 20, 5), 25);
  });
});

describe('caps on the unions, so they can never fill the 1 MB cap', () => {
  const times = (n, prefix = 'k', start = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, start + i]));
  test('newest keeps the newest entries by time', () => {
    assert.deepEqual(Object.keys(newest({ a: 3, b: 1, c: 2 }, 2)).sort(), ['a', 'c']);
    assert.deepEqual(newest({ a: 1 }, 2), { a: 1 });
  });
  test('awarded (both desks), dismissed and News read keep the newest 2000 on merge', () => {
    const feed = mergeIncoming('product-feed', { awarded: times(1500, 'old', 0) }, { awarded: times(1500, 'new', 10_000) });
    assert.equal(Object.keys(feed.awarded).length, MAX_MAP_ENTRIES);
    assert.ok(feed.awarded.new1499 && !feed.awarded.old0, 'the oldest go first');
    const key = (i) => `2026-12-07/s${i}`;
    const keyed = (n, start) => Object.fromEntries(Array.from({ length: n }, (_, i) => [key(start + i), start + i]));
    const news = mergeIncoming('news', { awarded: keyed(1500, 0), dismissed: {} }, { awarded: keyed(1500, 1500), read: keyed(2500, 0) });
    assert.equal(Object.keys(news.awarded).length, MAX_MAP_ENTRIES);
    assert.equal(Object.keys(news.read).length, MAX_MAP_ENTRIES);
    const at = (i) => new Date(Date.UTC(2026, 0, 1) + i * 60e3).toISOString().replace('.000Z', 'Z');
    const dis = mergeIncoming('news', { dismissed: Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [at(i), i])) }, {});
    assert.equal(Object.keys(dis.dismissed).length, MAX_MAP_ENTRIES);
  });
});

describe('reading, stopping and cleaning up', () => {
  test('GET waits for saves already queued, so a tab switching in reads the save that just went out', async () => {
    const store = createStateStore(tempHome(), 'product-feed');
    const writing = store.write({ notes: [{ id: 'n1' }] });
    const read = await store.readForPage();
    assert.deepEqual(read.notes, [{ id: 'n1' }]);
    await writing;
  });

  test('settled() resolves once every queued save is on disk', async () => {
    const home = tempHome();
    let release;
    const gate = new Promise((r) => (release = r));
    const fsp = { ...fs.promises, open: async (...a) => { await gate; return fs.promises.open(...a); } };
    const store = createStateStore(home, 'product-feed', { fsp });
    store.write({ xp: 7 });
    let done = false;
    const settled = store.settled().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(done, false, 'still writing');
    release();
    await settled;
    assert.equal(JSON.parse(fs.readFileSync(statePath(home), 'utf8')).xp, 7);
  });

  test('on start, stale .state.json.*.tmp files are swept; fresh ones, other files and state.json stay', async () => {
    const home = tempHome();
    const dir = path.dirname(statePath(home));
    fs.mkdirSync(dir, { recursive: true });
    const old = (Date.now() - STALE_TEMP_MS - 5000) / 1000;
    const files = { stale: '.state.json.aaaaaaaaaaaa.tmp', fresh: '.state.json.bbbbbbbbbbbb.tmp', other: '.last-good.json.cccccccccccc.tmp', state: 'state.json' };
    for (const f of Object.values(files)) fs.writeFileSync(path.join(dir, f), '{}');
    fs.utimesSync(path.join(dir, files.stale), old, old);
    fs.utimesSync(path.join(dir, files.other), old, old);
    const store = createStateStore(home, 'product-feed');
    assert.equal(await store.swept, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), [files.fresh, files.other, files.state].sort());
    assert.equal(await createStateStore(tempHome(), 'news').swept, 0, 'no folder yet: nothing to do');
  });
});

describe('stopping the server', () => {
  test("start()'s stop waits for the queued saves (at most 2 s) before it exits", () => {
    const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
    assert.match(src, /server\.close\(\(\) => server\.settled\(\)\.then\(exit, exit\)\);/);
    assert.match(src, /setTimeout\(exit, 2000\)\.unref\(\);/);
    assert.match(src, /server\.settled = \(\) => Promise\.all\(\[\.\.\.stateRoutes\.values\(\)\]\.map\(\(store\) => store\.settled\(\)\)\)/);
  });
});
