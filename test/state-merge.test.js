// server/state-store.js: every save is merged into the file as it is now (two tabs, old tabs, page closes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { statePath } from '../server/config.js';
import { createServer } from '../server/index.js';
import {
  MAX_FOLDERS, MAX_MAP_ENTRIES, MAX_NOTES, MAX_SEEN_TABS, MAX_STATE_BYTES, STALE_TEMP_MS, TOMBSTONE_MS, asTime, checkState, createStateStore, forPage,
  mergeIncoming, mergeXp, newest,
} from '../server/state-store.js';

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
      notes: [{ id: 'n0' }, { id: 'n1' }],
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

  test('News: awarded and dismissed are unions; read is merged by item (a removal must be listed); the shelf is the incoming one', () => {
    const current = { read: { '2026-12-07/s1': 1 }, awarded: { '2026-12-07/s1': 1 }, dismissed: { '2026-12-07T12:04:00-05:00': 2 }, shelfOpen: false };
    assert.deepEqual(mergeIncoming('news', current, { read: {}, shelfOpen: true }), {
      read: { '2026-12-07/s1': 1 },
      shelfOpen: true,
      awarded: { '2026-12-07/s1': 1 },
      dismissed: { '2026-12-07T12:04:00-05:00': 2 },
    }, 'a save that does not mention s1 keeps it');
    const removed = mergeIncoming('news', current, { read: {}, _removed: { read: ['2026-12-07/s1'] } }, { now: 9 });
    assert.deepEqual(removed.read, {});
    assert.deepEqual(removed._deleted, { 'read:2026-12-07/s1': 9 });
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

describe('merging by item: reads, notes, folders and saved items (N4c)', () => {
  const feed = (current, incoming, now = 1000) => mergeIncoming('product-feed', current, incoming, { now });
  const note = (id, text = id, ts = 1) => ({ id, a: 'a1', text, ts });

  test("an item another tab added survives a save that doesn't mention it", () => {
    const current = { read: { a1: 1 }, notes: [note('n1')], folders: [{ id: 'f1', name: 'Evals' }], saved: { a1: ['f1'] } };
    const merged = feed(current, { read: { a2: 2 }, notes: [note('n2')], folders: [{ id: 'f2', name: 'Later' }], saved: { a2: ['f2'] } });
    assert.deepEqual(merged.read, { a1: 1, a2: 2 });
    assert.deepEqual(merged.notes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(merged.folders.map((f) => f.id), ['f1', 'f2']);
    assert.deepEqual(merged.saved, { a1: ['f1'], a2: ['f2'] });
  });

  test('a listed removal deletes the item and leaves a tombstone; the GET never shows tombstones', () => {
    const current = { read: { a1: 1 }, notes: [note('n1')], folders: [{ id: 'f1', name: 'Evals' }], saved: { a1: ['f1'] } };
    const merged = feed(current, { read: {}, notes: [], folders: [], saved: {}, _removed: { read: ['a1'], notes: ['n1'], folders: ['f1'], saved: [['a1', 'f1']] } }, 500);
    assert.deepEqual([merged.read, merged.notes, merged.folders, merged.saved], [{}, [], [], {}]);
    assert.deepEqual(Object.keys(merged._deleted).sort(), ['folders:f1', 'notes:n1', 'read:a1', 'saved:["a1","f1"]']);
    assert.equal('_deleted' in forPage(merged), false);
    assert.equal('_removed' in merged, false);
  });

  test("a stale tab can't bring a deleted item back; a listed re-add (Undo, re-marking) can, and clears the tombstone", () => {
    const deleted = feed({ notes: [note('n1')], read: { a1: 1 } }, { notes: [], read: {}, _removed: { notes: ['n1'], read: ['a1'] } }, 500);
    const stale = feed(deleted, { notes: [note('n1')], read: { a1: 1 } }, 600);
    assert.deepEqual([stale.notes, stale.read], [[], {}], 'the stale copies stay deleted');
    const undone = feed(deleted, { notes: [note('n1')], read: { a1: 7 }, _added: { notes: ['n1'], read: ['a1'] } }, 700);
    assert.deepEqual(undone.notes.map((n) => n.id), ['n1']);
    assert.deepEqual(undone.read, { a1: 7 });
    assert.equal(undone._deleted, undefined, 'no tombstones left');
  });

  test("an edit or rename wins for that item only; a stale copy can't undo another tab's rename", () => {
    const current = { folders: [{ id: 'f1', name: 'Renamed' }, { id: 'f2', name: 'Two' }], notes: [note('n1', 'edited')] };
    const stale = feed(current, { folders: [{ id: 'f1', name: 'Old name' }, { id: 'f2', name: 'Two' }], notes: [note('n1', 'old text')] });
    assert.deepEqual(stale.folders.map((f) => f.name), ['Renamed', 'Two']);
    assert.equal(stale.notes[0].text, 'edited');
    const renamed = feed(current, { folders: [{ id: 'f2', name: 'Second' }], _added: { folders: ['f2'] } });
    assert.deepEqual(renamed.folders.map((f) => f.name), ['Renamed', 'Second'], 'the later save wins for f2 only');
  });

  test("a deleted folder takes its saved items with it, even from a tab that doesn't know", () => {
    const deleted = feed({ folders: [{ id: 'f1', name: 'X' }], saved: { a1: ['f1'], a2: ['f1', 'f2'] } }, { folders: [], saved: {}, _removed: { folders: ['f1'] } }, 500);
    const stale = feed(deleted, { folders: [{ id: 'f1', name: 'X' }], saved: { a1: ['f1'], a2: ['f1'] } }, 600);
    assert.deepEqual(stale.folders, []);
    assert.deepEqual(stale.saved, {});
  });

  test('a save with no lists (old code): unions with no deletes, and still no bringing back a tombstoned item', () => {
    const current = { read: { a1: 1 }, notes: [note('n1')], folders: [{ id: 'f1', name: 'Evals' }], _deleted: { 'notes:n9': 900 } };
    const merged = feed(current, { read: { a2: 2 }, notes: [note('n2'), note('n9')], folders: [] }, 1000);
    assert.deepEqual(merged.read, { a1: 1, a2: 2 });
    assert.deepEqual(merged.notes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(merged.folders.map((f) => f.id), ['f1']);
  });

  test('tombstones go after 30 days', () => {
    const merged = feed({ notes: [], _deleted: { 'notes:old': 0, 'notes:new': TOMBSTONE_MS } }, { notes: [] }, TOMBSTONE_MS + 1);
    assert.deepEqual(Object.keys(merged._deleted), ['notes:new']);
    const later = feed({ notes: [], _deleted: { 'notes:old': 0 } }, { notes: [note('old')] }, TOMBSTONE_MS + 1);
    assert.deepEqual(later.notes.map((n) => n.id), ['old'], 'after 30 days a very stale tab can bring it back: the price of a bounded file');
  });

  test('News reads merge by item too, with removals', () => {
    const k = '2026-12-07/s1';
    const deleted = mergeIncoming('news', { read: { [k]: 1 } }, { read: {}, _removed: { read: [k] } }, { now: 5 });
    assert.deepEqual(mergeIncoming('news', deleted, { read: { [k]: 1 } }, { now: 6 }).read, {}, 'a stale tab cannot bring it back');
    assert.deepEqual(mergeIncoming('news', deleted, { read: { [k]: 9 }, _added: { read: [k] } }, { now: 7 }).read, { [k]: 9 });
  });

  test('caps: notes keep the newest 2000 by time, folders the first 200, reads the newest 2000', () => {
    const many = Array.from({ length: MAX_NOTES + 10 }, (_, i) => note(`n${i}`, 'x', i));
    const merged = feed({ notes: many.slice(0, 1500) }, { notes: many.slice(1500) });
    assert.equal(merged.notes.length, MAX_NOTES);
    assert.ok(!merged.notes.some((n) => n.id === 'n0') && merged.notes.some((n) => n.id === `n${MAX_NOTES + 9}`));
    const folders = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `f${from + i}`, name: 'x' }));
    assert.equal(feed({ folders: folders(0, 150) }, { folders: folders(150, 100) }).folders.length, MAX_FOLDERS);
    const reads = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`a${i}`, i]));
    assert.equal(Object.keys(feed({ read: reads }, {}).read).length, MAX_MAP_ENTRIES);
  });

  test('the lists and the items are checked', () => {
    assert.deepEqual(checkState({ _removed: { read: ['a1'], notes: ['n1'], folders: ['f1'], saved: [['a1', 'f1']] }, _added: { notes: ['n2'] } }), { ok: true });
    assert.match(checkState({ _removed: { badges: ['x'] } }).error, /can only list/);
    assert.match(checkState({ _removed: { saved: ['a1'] } }).error, /isn't an id/);
    assert.match(checkState({ _removed: 'a1' }).error, /must be an object/);
    assert.deepEqual(checkState({ _removed: { read: ['2026-12-07/s1'] } }, 'news'), { ok: true });
    assert.equal(checkState({ _removed: { read: ['s1'] } }, 'news').ok, false);
    assert.match(checkState({ notes: [{ text: 'no id' }] }).error, /with an id/);
    assert.match(checkState({ notes: [{ id: 'n1' }, { id: 'n1' }] }).error, /twice/);
    assert.match(checkState({ folders: Array.from({ length: MAX_FOLDERS + 1 }, (_, i) => ({ id: `f${i}` })) }).error, /at most 200/);
    assert.match(checkState({ saved: { a1: 'f1' } }).error, /list of folder ids/);
  });
});

describe('N4b nits closed in N4c', () => {
  test('a zoneless ISO badge time is read as UTC, in the file and in a save, rather than refused', () => {
    assert.equal(asTime('2026-11-27T10:00:00'), '2026-11-27T10:00:00Z');
    assert.equal(asTime('2026-11-27T10:00'), '2026-11-27T10:00Z');
    assert.equal(asTime('2026-11-27'), null);
    assert.deepEqual(checkState({ badges: { curator: '2026-11-27T10:00:00' } }), { ok: true });
    const merged = mergeIncoming('product-feed', { badges: { curator: '2026-11-27T10:00:00' } }, { badges: { 'first-read': 5 } });
    assert.deepEqual(merged.badges, { 'first-read': 5, curator: '2026-11-27T10:00:00Z' });
  });

  test('_seen is ordered by a counter that only goes up, not by the clock', () => {
    let state = {};
    // The clock goes backwards; the counter still orders them.
    for (let i = 0; i < MAX_SEEN_TABS + 5; i++) state = mergeIncoming('product-feed', state, { xp: 0, _sync: { xp: 0, tab: `t${i}`, sent: 0 } }, { now: 10_000 - i });
    const seen = state._seen;
    assert.equal(Object.keys(seen).length, MAX_SEEN_TABS);
    assert.ok(seen[`t${MAX_SEEN_TABS + 4}`] && !seen.t0, 'the newest by counter kept, despite the older times');
    assert.equal(seen[`t${MAX_SEEN_TABS + 4}`].n, MAX_SEEN_TABS + 5);
    // Marks from before the counter count as 0; among them the newer time wins.
    const old = mergeIncoming('product-feed', { _seen: Object.fromEntries(Array.from({ length: MAX_SEEN_TABS }, (_, i) => [`o${i}`, { xp: 0, at: i }])) }, { xp: 0, _sync: { xp: 0, tab: 'fresh', sent: 0 } }, { now: 1 });
    assert.ok(old._seen.fresh && !old._seen.o0 && old._seen[`o${MAX_SEEN_TABS - 1}`]);
  });

  test('the temp-file sweep runs once more a minute after start', async () => {
    const home = tempHome();
    const dir = path.dirname(statePath(home));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.state.json.dddddddddddd.tmp'), '{}'); // too new at start
    let clock = Date.now();
    const store = createStateStore(home, 'product-feed', { now: () => clock, sweepAgainAfter: 30 });
    assert.equal(await store.swept, 0);
    clock += STALE_TEMP_MS + 1000;
    assert.equal(await store.sweptAgain, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
