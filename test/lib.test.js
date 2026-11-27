// app/lib.js: the front end's pure logic. npm test runs with TZ=America/Toronto.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import {
  articlesFor, autoPhase, blank, createStateClient, dayKey, esc, fmtDate, freshBadges, level, moon,
  normalizeState, readsThisWeek, safeUrl, streak, sunTimes, themeScores, wilaLine,
} from '../app/lib.js';

const MIN = 60e3;
const at = (iso) => new Date(iso);
const minutesApart = (a, b) => Math.abs(a.getTime() - b.getTime()) / MIN;

// Real Toronto sunrise and sunset (timeanddate.com), local clock time.
const DAYS = [
  { name: '27 Nov 2026', date: '2026-11-27', off: '-05:00', rise: '07:22', set: '16:44' },
  { name: '21 Jun 2026', date: '2026-06-21', off: '-04:00', rise: '05:36', set: '21:03' },
  { name: '21 Dec 2026', date: '2026-12-21', off: '-05:00', rise: '07:48', set: '16:43' },
];
const local = (day, hhmm) => at(`${day.date}T${hhmm}:00${day.off}`);
const shift = (d, minutes) => new Date(d.getTime() + minutes * MIN);

describe('sunTimes (Toronto)', () => {
  for (const day of DAYS) {
    test(`${day.name}: sunrise ~${day.rise} and sunset ~${day.set}, within 10 minutes`, () => {
      const st = sunTimes(local(day, '12:00'));
      assert.ok(minutesApart(st.rise, local(day, day.rise)) <= 10, `sunrise was ${st.rise.toISOString()}`);
      assert.ok(minutesApart(st.set, local(day, day.set)) <= 10, `sunset was ${st.set.toISOString()}`);
    });

    test(`${day.name}: the same answer at any time of that day`, () => {
      const noon = sunTimes(local(day, '12:00'));
      for (const hhmm of ['00:05', '06:00', '23:55']) {
        const st = sunTimes(local(day, hhmm));
        assert.equal(st.rise.getTime(), noon.rise.getTime(), hhmm);
        assert.equal(st.set.getTime(), noon.set.getTime(), hhmm);
      }
    });
  }

  test('every day of 2026: sunrise and sunset fall on that Toronto day, around noon', () => {
    const torontoDay = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    for (let d = new Date(2026, 0, 1, 12); d.getFullYear() === 2026; d.setDate(d.getDate() + 1)) {
      const st = sunTimes(d);
      const key = torontoDay(d);
      assert.equal(torontoDay(st.rise), key, `sunrise on ${key}`);
      assert.equal(torontoDay(st.set), key, `sunset on ${key}`);
      assert.ok(st.rise < d && d < st.set, `noon is daylight on ${key}`);
    }
  });

  test("doesn't depend on the computer's time zone", () => {
    const code = `import { sunTimes } from './app/lib.js';
      const st = sunTimes(new Date('2026-06-21T12:00:00-04:00'));
      console.log(st.rise.toISOString(), st.set.toISOString());`;
    const run = (TZ) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: REPO_ROOT, env: { ...process.env, TZ }, encoding: 'utf8' });
    const toronto = run('America/Toronto');
    assert.equal(toronto.status, 0, toronto.stderr);
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      assert.equal(run(tz).stdout, toronto.stdout, tz);
    }
  });
});

describe('autoPhase (Toronto)', () => {
  // night until 30 min before sunrise, daylight until 2 h before sunset, golden until 30 min after it.
  // Checked 15 minutes either side of each boundary, using the real sunrise and sunset.
  for (const day of DAYS) {
    test(`${day.name}: night, daylight and golden hour switch at the right times`, () => {
      const rise = local(day, day.rise);
      const set = local(day, day.set);
      const cases = [
        [shift(rise, -45), 'night'],
        [shift(rise, -15), 'morning'],
        [shift(set, -135), 'morning'],
        [shift(set, -105), 'golden'],
        [shift(set, 15), 'golden'],
        [shift(set, 45), 'night'],
        [local(day, '00:30'), 'night'],
        [local(day, '12:00'), 'morning'],
        [local(day, '23:30'), 'night'],
      ];
      for (const [when, expected] of cases) {
        assert.equal(autoPhase(when), expected, `${when.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto' })}`);
      }
    });
  }

  test('a summer afternoon is daylight, not night (the prototype got this wrong)', () => {
    assert.equal(autoPhase(at('2026-07-15T15:00:00-04:00')), 'morning');
    assert.equal(autoPhase(at('2026-05-01T12:00:00-04:00')), 'morning');
  });
});

describe('esc', () => {
  test('escapes the five HTML characters', () => {
    assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  test('turns null and undefined into empty text and other values into strings', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(0), '0');
    assert.equal(esc(12), '12');
    assert.equal(esc('plain words'), 'plain words');
  });

  test('a script tag from a feed comes out as text', () => {
    assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('safeUrl', () => {
  test('keeps https links', () => {
    assert.equal(safeUrl('https://example.com/post?a=1'), 'https://example.com/post?a=1');
  });

  test('refuses everything else', () => {
    for (const u of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', ' https://example.com', 'HTTPS://example.com', 'https://', '//example.com', '', null, undefined, 42, {}]) {
      assert.equal(safeUrl(u), null, String(u));
    }
  });
});

describe('dates', () => {
  test('dayKey is the local date as YYYY-MM-DD', () => {
    assert.equal(dayKey(at('2026-11-27T23:30:00-05:00')), '2026-11-27');
    assert.equal(dayKey(at('2026-11-28T04:30:00Z')), '2026-11-27');
  });

  test('fmtDate shows a short date and ignores junk', () => {
    assert.equal(fmtDate('2026-11-26'), 'Nov 26, 2026');
    assert.equal(fmtDate(''), '');
    assert.equal(fmtDate(undefined), '');
    assert.equal(fmtDate('not a date'), '');
  });

  test('moon names the phase', () => {
    assert.equal(moon(at('2026-11-24T15:00:00Z')).name, 'Full moon');
    assert.equal(moon(at('2026-11-09T07:00:00Z')).name, 'New moon');
    const { age } = moon(at('2026-11-27T12:00:00Z'));
    assert.ok(age >= 0 && age < 29.6);
  });
});

describe('state and progress', () => {
  test('normalizeState keeps good values, replaces wrong types and keeps unknown keys', () => {
    assert.deepEqual(normalizeState(null), blank());
    assert.deepEqual(normalizeState([]), blank());
    const S = normalizeState({ xp: 30, notes: 'oops', read: { a1: 1 }, badges: [], later: { x: 1 } });
    assert.equal(S.xp, 30);
    assert.deepEqual(S.notes, []);
    assert.deepEqual(S.read, { a1: 1 });
    assert.deepEqual(S.badges, {});
    assert.deepEqual(S.later, { x: 1 });
    assert.deepEqual(S.folders, []);
  });

  test('level goes up every 100 XP', () => {
    assert.equal(level(0), 1);
    assert.equal(level(99), 1);
    assert.equal(level(100), 2);
    assert.equal(level(undefined), 1);
  });

  test('streak counts days in a row, ending today or yesterday', () => {
    const now = at('2026-11-27T10:00:00-05:00');
    assert.equal(streak([], now), 0);
    assert.equal(streak(['2026-11-25', '2026-11-26', '2026-11-27'], now), 3);
    assert.equal(streak(['2026-11-25', '2026-11-26'], now), 2);
    assert.equal(streak(['2026-11-24', '2026-11-26'], now), 1);
    assert.equal(streak(['2026-11-25'], now), 0);
  });

  test('readsThisWeek counts reads since Monday', () => {
    const now = at('2026-11-27T10:00:00-05:00'); // a Friday
    const read = {
      a: at('2026-11-23T00:01:00-05:00').getTime(), // Monday
      b: at('2026-11-27T09:00:00-05:00').getTime(),
      c: at('2026-11-22T23:59:00-05:00').getTime(), // Sunday before
    };
    assert.equal(readsThisWeek(read, now), 2);
  });

  const feed = {
    themes: [{ id: 'evals', name: 'Evals' }, { id: 'agents', name: 'Agents' }, { id: 'growth', name: 'AI growth' }],
    articles: [
      { id: 'a1', themes: ['evals'] },
      { id: 'a2', themes: ['agents', 'evals'] },
      { id: 'a3', themes: ['growth'] },
    ],
  };

  test('articlesFor fills each shelf', () => {
    const S = { ...blank(), read: { a1: 1 }, saved: { a2: ['f1'], a3: ['f2'] } };
    assert.deepEqual(articlesFor(feed, S, 'all').map((a) => a.id), ['a1', 'a2', 'a3']);
    assert.deepEqual(articlesFor(feed, S, 'unread').map((a) => a.id), ['a2', 'a3']);
    assert.deepEqual(articlesFor(feed, S, 'saved').map((a) => a.id), ['a2', 'a3']);
    assert.deepEqual(articlesFor(feed, S, 'f:f1').map((a) => a.id), ['a2']);
  });

  test('themeScores and badges follow reads and notes', () => {
    const S = { ...blank(), read: { a1: 1, a2: 2, a3: 3 }, notes: [{ a: 'a1' }, { a: 'a1' }, { a: 'a2' }] };
    const evals = themeScores(feed, S).find((t) => t.id === 'evals');
    assert.equal(evals.reads, 2);
    assert.equal(evals.notes, 3);
    const ids = freshBadges(S, feed).map((b) => b.id);
    assert.deepEqual(ids, ['first-read', 'first-note', 'connector', 'deep-diver']);
    S.badges = { 'first-read': 1 };
    assert.ok(!freshBadges(S, feed).some((b) => b.id === 'first-read'));
  });

  test('wilaLine fits the moment', () => {
    assert.equal(wilaLine('morning', 0, false), 'Your Product Feed is still being set up.');
    assert.match(wilaLine('morning', 3, true), /^Good morning, Snow\. 3 picks are waiting/);
    assert.match(wilaLine('golden', 1, true), /^Golden hour, Snow\. 1 pick is still/);
    assert.match(wilaLine('night', 2, true), /^Evening, Snow\./);
    assert.match(wilaLine('night', 0, true), /Rest well/);
  });
});

describe('createStateClient', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const okResponse = (value = {}) => ({ ok: true, status: 200, json: async () => value });

  // A fetch that records calls. GETs answer `getAnswer`; PUTs wait until the test resolves them.
  function fakeServer(getAnswer = okResponse({ xp: 40, notes: [{ id: 'n1' }] })) {
    const calls = [];
    const puts = [];
    const fetchFn = (url, opts = {}) => {
      calls.push({ url, ...opts });
      if (!opts.method || opts.method === 'GET') return typeof getAnswer === 'function' ? getAnswer() : Promise.resolve(getAnswer);
      return new Promise((resolve, reject) => puts.push({ body: opts.body, keepalive: opts.keepalive, resolve, reject }));
    };
    return { calls, puts, fetchFn, putCalls: () => calls.filter((c) => c.method === 'PUT') };
  }

  test('loads the saved state from GET /api/state', async () => {
    const srv = fakeServer();
    const client = createStateClient({ getState: () => ({}), fetchFn: srv.fetchFn });
    const r = await client.load();
    assert.equal(r.ok, true);
    assert.equal(r.state.xp, 40);
    assert.deepEqual(r.state.folders, []);
    assert.equal(srv.calls[0].url, '/api/state');
    assert.equal(client.canSave, true);
  });

  test('saves nothing before the first GET has finished', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const client = createStateClient({ getState: () => ({ xp: 0 }), fetchFn: srv.fetchFn });
    client.save();
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(client.flushOnExit(), false);
    assert.equal(srv.putCalls().length, 0);
  });

  for (const [what, answer] of [
    ['answers 500', { ok: false, status: 500, json: async () => ({ error: 'unreadable' }) }],
    ['is unreachable', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['answers something that is not JSON', { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }],
  ]) {
    test(`never saves if the first GET ${what}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const srv = fakeServer(answer);
      const client = createStateClient({ getState: () => ({ xp: 0 }), fetchFn: srv.fetchFn });
      const r = await client.load();
      assert.equal(r.ok, false);
      assert.deepEqual(r.state, blank());
      client.save();
      t.mock.timers.tick(5000);
      await settle();
      assert.equal(client.flushOnExit(), false);
      assert.equal(srv.putCalls().length, 0);
    });
  }

  test('debounces saves by 600 ms and sends the latest state as JSON', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const S = { xp: 0 };
    const client = createStateClient({ getState: () => S, fetchFn: srv.fetchFn });
    await client.load();
    S.xp = 10;
    client.save();
    t.mock.timers.tick(300);
    S.xp = 20;
    client.save();
    t.mock.timers.tick(599);
    assert.equal(srv.putCalls().length, 0);
    t.mock.timers.tick(1);
    assert.equal(srv.putCalls().length, 1);
    const put = srv.putCalls()[0];
    assert.equal(put.url, '/api/state');
    assert.equal(put.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(put.body), { xp: 20 });
  });

  test('keeps a single write in flight; changes made meanwhile follow it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const S = { xp: 1 };
    const client = createStateClient({ getState: () => S, fetchFn: srv.fetchFn });
    await client.load();
    client.save();
    t.mock.timers.tick(600);
    assert.equal(srv.puts.length, 1);
    S.xp = 2;
    client.save();
    t.mock.timers.tick(600);
    S.xp = 3;
    client.save();
    t.mock.timers.tick(600);
    assert.equal(srv.puts.length, 1, 'no second PUT while the first is in flight');
    srv.puts[0].resolve({ ok: true });
    await settle();
    assert.equal(srv.puts.length, 2);
    assert.deepEqual(JSON.parse(srv.puts[1].body), { xp: 3 });
    srv.puts[1].resolve({ ok: true });
    await settle();
    assert.equal(client.dirty, false);
  });

  test('a failed save keeps the state, tells Snow once, and retries with the next change', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const S = { xp: 1 };
    let told = 0;
    const client = createStateClient({ getState: () => S, fetchFn: srv.fetchFn, onSaveFail: () => told++ });
    await client.load();

    client.save();
    t.mock.timers.tick(600);
    srv.puts[0].resolve({ ok: false, status: 500 });
    await settle();
    assert.equal(told, 1);
    assert.equal(client.dirty, true, 'still waiting to be saved');
    t.mock.timers.tick(60_000);
    assert.equal(srv.puts.length, 1, 'no retry until something changes');

    S.xp = 2;
    client.save();
    t.mock.timers.tick(600);
    srv.puts[1].reject(new TypeError('Failed to fetch'));
    await settle();
    assert.equal(told, 1, 'only one message for a run of failures');
    assert.deepEqual(JSON.parse(srv.puts[1].body), { xp: 2 });

    S.xp = 3;
    client.save();
    t.mock.timers.tick(600);
    srv.puts[2].resolve({ ok: true });
    await settle();
    assert.equal(client.dirty, false);

    client.save();
    t.mock.timers.tick(600);
    srv.puts[3].resolve({ ok: false, status: 503 });
    await settle();
    assert.equal(told, 2, 'a new failure after a good save is told again');
  });

  test('on leaving the page, sends the waiting save with keepalive', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const S = { xp: 5 };
    const client = createStateClient({ getState: () => S, fetchFn: srv.fetchFn });
    await client.load();
    assert.equal(client.flushOnExit(), false, 'nothing waiting, nothing sent');

    client.save();
    assert.equal(client.flushOnExit(), true);
    await settle();
    assert.equal(srv.puts.length, 1);
    assert.equal(srv.puts[0].keepalive, true);
    assert.deepEqual(JSON.parse(srv.puts[0].body), { xp: 5 });
    t.mock.timers.tick(600);
    assert.equal(srv.puts.length, 1, 'the debounced save was cancelled');
  });

  test('a state too big for keepalive is still sent, without keepalive', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const S = { notes: [{ text: 'x'.repeat(70_000) }] };
    const client = createStateClient({ getState: () => S, fetchFn: srv.fetchFn });
    await client.load();
    client.save();
    client.flushOnExit();
    await settle();
    assert.equal(srv.puts[0].keepalive, false);
  });
});
