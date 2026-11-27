// server/state-store.js: every save is merged into the file as it is now (two tabs, old tabs, page closes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { statePath } from '../server/config.js';
import { createServer } from '../server/index.js';
import { MAX_STATE_BYTES, checkState, createStateStore, mergeIncoming, mergeXp } from '../server/state-store.js';

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

  test('days keep only day strings, each once, the last 120', () => {
    const current = { days: Array.from({ length: 120 }, (_, i) => `2026-01-${String(i).padStart(3, '0')}`) };
    const merged = mergeIncoming('product-feed', current, { days: ['2027-01-01', 7, null, '2027-01-01'] });
    assert.equal(merged.days.length, 120);
    assert.equal(merged.days.at(-1), '2027-01-01');
    assert.equal(merged.days.filter((d) => d === '2027-01-01').length, 1);
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

  test("a time that can't be compared keeps the file's; a __proto__ key never becomes a prototype", () => {
    const merged = mergeIncoming('product-feed', JSON.parse('{"awarded": {"a1": "soon", "__proto__": {"x": 1}}}'), { awarded: { a1: 3 } });
    assert.deepEqual(merged.awarded, { a1: 'soon' });
    assert.equal(Object.getPrototypeOf(merged.awarded), Object.prototype);
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
      const half = Math.floor(MAX_STATE_BYTES / 2) + 1000;
      assert.equal((await put('/api/state', { awarded: { big: 'x'.repeat(half) } })).status, 200);
      const before = fs.readFileSync(statePath(deskHome), 'utf8');
      assert.equal((await put('/api/state', { awarded: { other: 'y'.repeat(half) } })).status, 413);
      assert.equal(fs.readFileSync(statePath(deskHome), 'utf8'), before);
    } finally {
      await stop();
    }
  });
});
