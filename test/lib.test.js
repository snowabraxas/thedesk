// app/lib.js: the front end's pure logic. npm test runs with TZ=America/Toronto.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { isHttpsLink } from '../server/schema-common.js';
import {
  articlesFor, autoPhase, awardText, blank, createStateClient, dayKey, esc, fmtDate, fmtDay, freshBadges, level, mentorLine,
  markArticleRead, mergeFeedState, moon, normalizeState, readArticle, readsThisWeek, safeUrl, streak, sunTimes, themeScores, toggleArticleRead, wilaLine,
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

  // The server's rules from N2 (isHttpsLink in server/schema-common.js), link for link.
  const GOOD = [
    'https://example.com',
    'https://example.com/',
    'https://www.example.com/a/b?x=1&y=2#top',
    'https://Example.COM/path',
    'https://example.com:8443/x',
    'https://example.com:/x',
    'https://example.com./x',
    'https://my_bucket.s3.amazonaws.com/report.pdf',
    'https://xn--bcher-kva.de/',
    'https://example.com/@snow',
    'https://example.com/?by=a@b',
    'https://example.com/%E2%80%8C',
    'https://digital-strategy.ec.europa.eu/en/policies/ai-office',
  ];
  const BAD = {
    'a user name': 'https://user@example.com/',
    'a user name and password': 'https://user:pw@example.com/',
    'only a password': 'https://:pw@example.com/',
    'empty user info': 'https://@example.com/',
    'empty user info after an extra slash': 'https:///@example.com/',
    'a password with a raw slash': 'https://id:a/b@example.com/',
    'a space': 'https://example.com/a b',
    'a tab': 'https://exa\tmple.com/',
    'a newline': 'https://example.com/\n',
    'a backslash': 'https://example.com\\@evil.com/',
    'a zero-width joiner': 'https://exa\u200Dmple.com/',
    'a right-to-left override': 'https://example.com/\u202Efdp.exe',
    'a soft hyphen': 'https://exam\u00ADple.com/',
    'a byte-order mark': 'https://example.com/\uFEFF',
    'a control character': 'https://example.com/\u0007',
    'a division slash lookalike': 'https://example.com∕evil.com/',
    'a fullwidth site': 'https://ｅｘａｍｐｌｅ.com/',
    'a non-ASCII site': 'https://bücher.de/',
    'a percent-encoded site': 'https://ex%61mple.com/',
    'an IPv4 address': 'https://127.0.0.1/',
    'a public IPv4 address': 'https://8.8.8.8/',
    'a numeric IPv4 form': 'https://2130706433/',
    'a hex IPv4 form': 'https://0x7f.1/',
    'a short IPv4 form': 'https://127.1/',
    'an IPv6 address': 'https://[::1]/',
    'localhost': 'https://localhost/',
    'a localhost subdomain': 'https://desk.localhost/',
    'a one-word site': 'https://intranet/',
    'no site': 'https:///path',
    'a port too large': 'https://example.com:99999/',
    'http': 'http://example.com/',
  };

  test('keeps links that pass the server rules', () => {
    for (const u of GOOD) assert.equal(safeUrl(u), u, u);
  });

  for (const [what, u] of Object.entries(BAD)) {
    test(`refuses a link with ${what}`, () => assert.equal(safeUrl(u), null, JSON.stringify(u)));
  }

  test('agrees with the server contract on every link above', () => {
    for (const u of [...GOOD, ...Object.values(BAD)]) assert.equal(safeUrl(u) !== null, isHttpsLink(u), JSON.stringify(u));
  });

  test('every link in the Product Feed sample still passes', () => {
    const feed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototype/feed.json'), 'utf8'));
    assert.ok(feed.articles.length > 0);
    for (const a of feed.articles) assert.equal(safeUrl(a.url), a.url, a.url);
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

  test('fmtDay shows month and day only, and ignores junk', () => {
    assert.equal(fmtDay('2026-11-26'), 'Nov 26');
    assert.equal(fmtDay('2026-01-01'), 'Jan 1');
    assert.equal(fmtDay(''), '');
    assert.equal(fmtDay(undefined), '');
    assert.equal(fmtDay('not a date'), '');
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

  test('a state saved before "awarded" existed counts every read article as already paid', () => {
    assert.deepEqual(normalizeState({ read: { a1: 1, a2: 2 } }).awarded, { a1: 1, a2: 2 });
    assert.deepEqual(normalizeState({ read: { a1: 1 }, awarded: ['a1'] }).awarded, { a1: 1 }, 'a broken awarded is rebuilt the same way');
    assert.deepEqual(normalizeState({ read: { a1: 1, a2: 2 }, awarded: { a1: 1 } }).awarded, { a1: 1 }, 'a saved awarded is kept as it is');
    assert.deepEqual(normalizeState({}).awarded, {});
    const S = normalizeState(JSON.parse('{"__proto__": {"xp": 999}}'));
    assert.equal(Object.getPrototypeOf(S), Object.prototype);
  });

  test('toggleArticleRead pays once per article, ever', () => {
    const S = blank();
    assert.deepEqual(toggleArticleRead(S, 'a1', 1), { read: true, award: true });
    assert.deepEqual([S.read, S.awarded], [{ a1: 1 }, { a1: 1 }]);
    assert.deepEqual(toggleArticleRead(S, 'a1', 2), { read: false, award: false });
    assert.deepEqual([S.read, S.awarded], [{}, { a1: 1 }]);
    assert.deepEqual(toggleArticleRead(S, 'a1', 3), { read: true, award: false }, 're-marking does not pay again');
    assert.deepEqual(toggleArticleRead(S, 'a2', 4), { read: true, award: true });
    const old = normalizeState({ read: { a1: 1 } });
    toggleArticleRead(old, 'a1');
    assert.equal(toggleArticleRead(old, 'a1').award, false, 'an article read before the fix is not paid again');
    for (const bad of ['', '__proto__', null, 7]) assert.deepEqual(toggleArticleRead(blank(), bad), { read: false, award: false }, String(bad));
  });

  test('markArticleRead keeps a read article read and pays only if unpaid; canAward false never pays or records', () => {
    const S = blank();
    assert.deepEqual(markArticleRead(S, 'a1', { now: 1 }), { read: true, award: true });
    assert.deepEqual(markArticleRead(S, 'a1', { now: 2 }), { read: true, award: false });
    assert.deepEqual([S.read, S.awarded], [{ a1: 1 }, { a1: 1 }]);
    const T = blank();
    assert.deepEqual(markArticleRead(T, 'a2', { canAward: false }), { read: true, award: false });
    assert.deepEqual(T.awarded, {});
  });

  test('mergeFeedState: awarded becomes the union; everything else stays this tab\'s', () => {
    const local = { ...blank(), xp: 30, read: { a2: 2 }, awarded: { a2: 2 } };
    const server = { ...blank(), xp: 10, read: { a1: 1 }, awarded: { a1: 1, a2: 9 }, notes: [{ id: 'n' }] };
    assert.equal(mergeFeedState(local, server), local);
    assert.deepEqual(local, { ...blank(), xp: 30, read: { a2: 2 }, awarded: { a2: 2, a1: 1 } });
    for (const odd of [null, {}, { awarded: [] }]) assert.deepEqual(mergeFeedState(blank(), odd).awarded, {});
    const bare = { read: {} };
    mergeFeedState(bare, JSON.parse('{"awarded": {"__proto__": 1, "a3": 3}}'));
    assert.deepEqual(bare.awarded, { a3: 3 });
    assert.equal(Object.getPrototypeOf(bare.awarded), Object.prototype);
  });

  describe('readArticle (checks the server before paying)', () => {
    const peekOf = (state, calls = []) => async () => { calls.push('peek'); return { ok: true, state }; };
    test("pays when the server hasn't, and runs also() alongside", async () => {
      const S = blank();
      const calls = [];
      assert.deepEqual(await readArticle(() => S, 'a1', { peek: peekOf(blank(), calls), also: async () => calls.push('also') }), { read: true, award: true });
      assert.deepEqual(calls.sort(), ['also', 'peek']);
    });
    test('does not pay when another tab already did', async () => {
      const S = blank();
      assert.deepEqual(await readArticle(() => S, 'a1', { peek: peekOf({ awarded: { a1: 1 } }) }), { read: true, award: false });
      assert.ok(S.awarded.a1);
    });
    test("marks read without paying or recording when the server's copy can't be read", async () => {
      const S = blank();
      assert.deepEqual(await readArticle(() => S, 'a1', { peek: async () => ({ ok: false }) }), { read: true, award: false });
      assert.deepEqual(S.awarded, {});
    });
    test('asks nothing when it would not pay: un-marking, already paid, or saving paused', async () => {
      const calls = [];
      const peek = peekOf(blank(), calls);
      const S = normalizeState({ read: { a1: 1 } });
      assert.deepEqual(await readArticle(() => S, 'a1', { peek }), { read: false, award: false });
      assert.deepEqual(await readArticle(() => S, 'a1', { peek }), { read: true, award: false });
      assert.deepEqual(await readArticle(() => blank(), 'a9', { canPay: false, peek }), { read: true, award: false });
      assert.deepEqual(calls, []);
    });
    test('a reload during the check that already has it read keeps it read, never un-marks', async () => {
      let S = blank();
      const fresh = normalizeState({ read: { a1: 5 }, awarded: { a1: 5 }, xp: 10 });
      const r = await readArticle(() => S, 'a1', { peek: async () => ({ ok: true, state: fresh }), also: async () => { S = fresh; } });
      assert.deepEqual(r, { read: true, award: false });
      assert.deepEqual(fresh.read, { a1: 5 });
    });
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

describe("mentorLine (Wila's note on the Product Feed)", () => {
  const themes = [
    { id: 'evals', name: 'Evals' },
    { id: 'pm-role', name: 'The AI PM role' },
    { id: 'growth', name: 'AI growth' },
  ];
  const articles = [
    { id: 'a1', source: "Lenny's Newsletter", themes: ['evals'] },
    { id: 'a2', source: 'CX Network', themes: ['pm-role'] },
    { id: 'a3', source: 'Product School', themes: ['pm-role'] },
    { id: 'a4', source: 'Braintrust', themes: ['evals', 'pm-role'] },
    { id: 'a5', source: "Lenny's Podcast", themes: ['growth'] },
  ];
  const feed = { themes, articles };
  const readOf = (...ids) => ({ ...blank(), read: Object.fromEntries(ids.map((id) => [id, 1])) });

  test('counts unread picks, names the theme with the most, and starts with the first unread source', () => {
    assert.equal(mentorLine(feed, blank()), "5 picks to read, 3 on The AI PM role. Start with Lenny's Newsletter.");
  });

  test('follows what Snow has read', () => {
    assert.equal(mentorLine(feed, readOf('a1', 'a2')), '3 picks to read, 2 on The AI PM role. Start with Product School.');
  });

  test('says "all on" when every unread pick shares the theme', () => {
    assert.equal(mentorLine(feed, readOf('a1', 'a2', 'a5')), '2 picks to read, all on The AI PM role. Start with Product School.');
  });

  test('a tie goes to the theme listed first in the edition', () => {
    const tie = { themes, articles: [articles[0], articles[1], { id: 'x', source: 'X', themes: ['evals'] }, { id: 'y', source: 'Y', themes: ['pm-role'] }] };
    assert.equal(mentorLine(tie, blank()), "4 picks to read, 2 on Evals. Start with Lenny's Newsletter.");
  });

  test('leaves the theme out when no theme has more than one unread pick', () => {
    const spread = { themes, articles: [articles[0], articles[1], articles[4]] };
    assert.equal(mentorLine(spread, blank()), "3 picks to read. Start with Lenny's Newsletter.");
  });

  test('one pick left', () => {
    assert.equal(mentorLine(feed, readOf('a1', 'a2', 'a3', 'a4')), "One pick to read, on AI growth. It's from Lenny's Podcast.");
  });

  test('all caught up is a short warm line with no numbers', () => {
    const line = mentorLine(feed, readOf('a1', 'a2', 'a3', 'a4', 'a5'));
    assert.equal(line, 'All caught up. Nicely done, Snow. What stuck with you?');
  });

  test('no picks yet', () => {
    assert.equal(mentorLine({ articles: [], themes: [] }, blank()), 'Your Product Feed is still being set up.');
    assert.equal(mentorLine({}, blank()), 'Your Product Feed is still being set up.');
    assert.equal(mentorLine(undefined, undefined), 'Your Product Feed is still being set up.');
  });

  test('copes with missing themes, sources and state', () => {
    const bare = { articles: [{ id: 'a1' }, { id: 'a2', themes: 'evals' }, null] };
    assert.equal(mentorLine(bare, {}), '2 picks to read.');
    assert.equal(mentorLine({ themes: [{ id: 'evals' }], articles: [{ id: 'a1', themes: ['evals'], source: '  ' }] }, blank()), 'One pick to read.');
  });

  test('agent text stays plain text: it is passed through, never turned into markup, and kept on one line', () => {
    const odd = {
      themes: [{ id: 't', name: '<b>Evals</b>' }],
      articles: [
        { id: 'a1', source: '<img src=x onerror=alert(1)>\nNews', themes: ['t'] },
        { id: 'a2', source: 'Two', themes: ['t'] },
      ],
    };
    // The caller sets it with textContent, so the angle brackets show as characters.
    assert.equal(mentorLine(odd, blank()), '2 picks to read, all on <b>Evals</b>. Start with <img src=x onerror=alert(1)> News.');
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
      t.mock.timers.tick(60_000); // past any retry, too
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

  test('a failed save keeps the state, tells Snow once, and retries every 15 s until it works', async (t) => {
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
    t.mock.timers.tick(14_999);
    assert.equal(srv.puts.length, 1, 'waits 15 s before trying again');
    t.mock.timers.tick(1);
    assert.equal(srv.puts.length, 2, 'tries again by itself, with no new change');
    assert.deepEqual(JSON.parse(srv.puts[1].body), { xp: 1 });

    srv.puts[1].reject(new TypeError('Failed to fetch'));
    await settle();
    assert.equal(told, 1, 'only one message for a run of failures');
    S.xp = 2; // changed in memory without a save() call: the retry still sends the latest state
    t.mock.timers.tick(15_000);
    assert.equal(srv.puts.length, 3);
    assert.deepEqual(JSON.parse(srv.puts[2].body), { xp: 2 });

    srv.puts[2].resolve({ ok: true }); // the server is back
    await settle();
    assert.equal(client.dirty, false);
    t.mock.timers.tick(120_000);
    assert.equal(srv.puts.length, 3, 'stops retrying once it is saved');

    client.save();
    t.mock.timers.tick(600);
    srv.puts[3].resolve({ ok: false, status: 503 });
    await settle();
    assert.equal(told, 2, 'a new failure after a good save is told again');
  });

  test('a change while waiting to retry goes out after the usual 600 ms, then retrying stops', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const S = { xp: 1 };
    const client = createStateClient({ getState: () => S, fetchFn: srv.fetchFn });
    await client.load();
    client.save();
    t.mock.timers.tick(600);
    srv.puts[0].resolve({ ok: false, status: 500 });
    await settle();

    t.mock.timers.tick(5_000);
    S.xp = 2;
    client.save();
    t.mock.timers.tick(600);
    assert.equal(srv.puts.length, 2, 'sent with the change, not 15 s after the failure');
    assert.deepEqual(JSON.parse(srv.puts[1].body), { xp: 2 });
    srv.puts[1].resolve({ ok: true });
    await settle();
    t.mock.timers.tick(60_000);
    assert.equal(srv.puts.length, 2, 'the old retry timer is gone');
  });

  test('the retry waits can be set', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const client = createStateClient({ getState: () => ({ xp: 1 }), fetchFn: srv.fetchFn, retryDelay: 1000 });
    await client.load();
    client.save();
    t.mock.timers.tick(600);
    srv.puts[0].resolve({ ok: false, status: 500 });
    await settle();
    t.mock.timers.tick(1000);
    assert.equal(srv.puts.length, 2);
  });

  test('a failed save on leaving the page is retried if the page stays open', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const srv = fakeServer();
    const client = createStateClient({ getState: () => ({ xp: 7 }), fetchFn: srv.fetchFn });
    await client.load();
    client.save();
    assert.equal(client.flushOnExit(), true);
    await settle();
    srv.puts[0].resolve({ ok: false, status: 500 });
    await settle();
    assert.equal(client.dirty, true);
    t.mock.timers.tick(15_000);
    assert.equal(srv.puts.length, 2);
    srv.puts[1].resolve({ ok: true });
    await settle();
    assert.equal(client.dirty, false);
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

  describe('for another desk (News: its own endpoint, normalizer and blank state)', () => {
    const newsBlank = () => ({ read: {}, shelfOpen: false });
    const newsNormalize = (raw) => ({ ...newsBlank(), ...(raw && typeof raw === 'object' ? raw : {}) });
    const newsClient = (srv, S = {}) =>
      createStateClient({ url: '/api/news/state', normalize: newsNormalize, empty: newsBlank, getState: () => S, fetchFn: srv.fetchFn });

    test('loads from its endpoint through its own normalizer', async () => {
      const srv = fakeServer(okResponse({ read: { '2026-12-07/s1': 1 } }));
      const r = await newsClient(srv).load();
      assert.equal(r.ok, true);
      assert.deepEqual(r.state, { read: { '2026-12-07/s1': 1 }, shelfOpen: false });
      assert.equal(srv.calls[0].url, '/api/news/state');
      assert.equal('xp' in r.state, false, "no Product Feed keys in News's state");
    });

    test('saves to its endpoint', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const srv = fakeServer(okResponse({}));
      const S = { read: {}, shelfOpen: true };
      const client = newsClient(srv, S);
      await client.load();
      client.save();
      t.mock.timers.tick(600);
      assert.equal(srv.putCalls().length, 1);
      assert.equal(srv.putCalls()[0].url, '/api/news/state');
      assert.deepEqual(JSON.parse(srv.putCalls()[0].body), S);
    });

    test('a failed GET gives its own blank state and never saves', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const srv = fakeServer({ ok: false, status: 500, json: async () => ({}) });
      const client = newsClient(srv, { read: {} });
      const r = await client.load();
      assert.equal(r.ok, false);
      assert.deepEqual(r.state, newsBlank());
      client.save();
      t.mock.timers.tick(60_000);
      await settle();
      assert.equal(client.flushOnExit(), false);
      assert.equal(srv.putCalls().length, 0);
    });
  });

  describe('two tabs: counters, reading the server copy, reload and leaving the page', () => {
    // A tiny server in memory: GET answers its copy, PUT replaces it (it records each body). down: GETs answer 500.
    function memoryServer(value = {}) {
      const srv = { value, gets: 0, puts: [], down: false };
      srv.fetchFn = async (url, opts = {}) => {
        if (opts.method === 'PUT') {
          srv.puts.push(JSON.parse(opts.body));
          srv.value = JSON.parse(opts.body);
          return { ok: true, status: 200, text: async () => '' };
        }
        srv.gets++;
        if (srv.down) return { ok: false, status: 500, text: async () => '' };
        return { ok: true, status: 200, json: async () => structuredClone(srv.value) };
      };
      return srv;
    }
    const tab = (srv, extra = {}) => {
      const T = { S: null };
      T.client = createStateClient({ getState: () => T.S, fetchFn: srv.fetchFn, counters: ['xp'], ...extra });
      return T;
    };

    test('each PUT carries the XP last synced as _sync, and the base moves to what was sent once it lands', async () => {
      const srv = memoryServer({ xp: 15 });
      const A = tab(srv);
      A.S = (await A.client.load()).state;
      A.S.xp += 10;
      A.client.save();
      await A.client.flush();
      assert.deepEqual(srv.puts[0]._sync, { xp: 15 });
      assert.equal(srv.puts[0].xp, 25);
      A.S.notes.push({ id: 'n1' });
      A.client.save();
      await A.client.flush();
      assert.deepEqual(srv.puts[1]._sync, { xp: 25 }, 'the next save counts from what the server has added');
    });

    test('a failed PUT keeps the base, so the retry carries the whole change', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let fail = true;
      const srv = memoryServer({ xp: 0 });
      const fetchFn = async (url, opts = {}) => (opts.method === 'PUT' && fail ? { ok: false, status: 500, text: async () => '' } : srv.fetchFn(url, opts));
      const A = tab(srv, { fetchFn });
      A.S = (await A.client.load()).state;
      A.S.xp = 10;
      A.client.save();
      await A.client.flush();
      fail = false;
      t.mock.timers.tick(15_000);
      await settle();
      assert.deepEqual(srv.puts.at(-1)._sync, { xp: 0 });
    });

    test('without counters, the body is the state as it is (News)', async () => {
      const srv = memoryServer({ read: {} });
      const N = { S: null };
      const c = createStateClient({ getState: () => N.S, fetchFn: srv.fetchFn, normalize: (r) => r, empty: () => ({}) });
      N.S = (await c.load()).state;
      N.S.shelfOpen = true;
      c.save();
      await c.flush();
      assert.deepEqual(srv.puts[0], { read: {}, shelfOpen: true });
      assert.equal(srv.gets, 1, 'no GET before a PUT');
    });

    test('nothing is awaited between taking the state and sending it, so closing the page mid-save loses nothing', async () => {
      const srv = memoryServer({ xp: 0 });
      let sent = 0;
      const fetchFn = (url, opts = {}) => { if (opts.method === 'PUT') sent++; return srv.fetchFn(url, opts); };
      const A = tab(srv, { fetchFn });
      A.S = (await A.client.load()).state;
      A.client.save();
      const flushing = A.client.flush(); // not awaited: the PUT must already be out
      assert.equal(sent, 1);
      assert.equal(A.client.dirty, false);
      assert.equal(A.client.flushOnExit(), false, 'nothing left to send: it is on its way');
      await flushing;
    });

    test('leaving the page while a PUT is on its way counts from what that PUT carries', async () => {
      const srv = memoryServer({ xp: 0 });
      let release;
      const fetchFn = (url, opts = {}) => (opts.method === 'PUT' && !opts.keepalive ? new Promise((r) => (release = () => r(srv.fetchFn(url, opts)))) : srv.fetchFn(url, opts));
      const A = tab(srv, { fetchFn });
      A.S = (await A.client.load()).state;
      A.S.xp = 10;
      A.client.save();
      const flushing = A.client.flush();
      A.S.xp = 20;
      A.client.save();
      assert.equal(A.client.flushOnExit(), true);
      await settle();
      assert.deepEqual(srv.puts.at(-1)._sync, { xp: 10 }, 'the first PUT will add 10, this one the next 10');
      release();
      await flushing;
    });

    test('peek reads the server copy without changing what will be saved', async () => {
      const srv = memoryServer({ xp: 5 });
      const A = tab(srv);
      A.S = (await A.client.load()).state;
      srv.value = { xp: 50 };
      const r = await A.client.peek();
      assert.equal(r.state.xp, 50);
      assert.equal(A.S.xp, 5);
      A.client.save();
      await A.client.flush();
      assert.deepEqual(srv.puts[0]._sync, { xp: 5 }, 'peek did not move the base');
    });

    test('reload applies the fresh copy (and its XP as the base) only when nothing is waiting, before and after the GET', async () => {
      const srv = memoryServer({ xp: 0 });
      let hold = null;
      const fetchFn = async (url, opts = {}) => { if (!opts.method && hold) await new Promise((r) => (hold = r)); return srv.fetchFn(url, opts); };
      const A = tab(srv, { fetchFn });
      A.S = (await A.client.load()).state;
      const apply = (fresh) => { A.S = fresh; };
      A.client.save();
      assert.deepEqual(await A.client.reload(apply), { ok: false }, 'a change is waiting');
      await A.client.flush();
      srv.value = { ...srv.value, xp: 40 };
      assert.equal((await A.client.reload(apply)).ok, true);
      assert.equal(A.S.xp, 40);
      A.client.save();
      await A.client.flush();
      assert.deepEqual(srv.puts.at(-1)._sync, { xp: 40 });
      // The refresh race: a change made while the GET is out wins over the fresh copy.
      hold = true;
      srv.value = { ...srv.value, xp: 99 };
      const pending = A.client.reload(apply);
      await settle();
      A.S.notes.push({ id: 'mine' });
      A.client.save();
      hold();
      assert.deepEqual(await pending, { ok: false });
      assert.deepEqual(A.S.notes, [{ id: 'mine' }], 'not replaced');
    });

    test('after a failed read, leaving the page sends nothing and keeps the change waiting', async () => {
      const srv = memoryServer({ xp: 0 });
      const A = tab(srv);
      A.S = (await A.client.load()).state;
      A.S.xp = 10;
      A.client.save();
      srv.down = true;
      assert.equal((await A.client.peek()).ok, false);
      assert.equal(A.client.flushOnExit(), false);
      assert.equal(A.client.dirty, true);
      assert.equal(srv.puts.length, 0);
      srv.down = false;
      assert.equal((await A.client.peek()).ok, true);
      assert.equal(A.client.flushOnExit(), true, 'a good read lets it go again');
    });

    test('flush resolves only once everything changed up to now is saved, including the PUT that follows one on its way', async () => {
      const srv = memoryServer({ xp: 0 });
      let release;
      let first = true;
      const fetchFn = (url, opts = {}) => {
        if (opts.method === 'PUT' && first) {
          first = false;
          return new Promise((r) => (release = () => r(srv.fetchFn(url, opts))));
        }
        return srv.fetchFn(url, opts);
      };
      const A = tab(srv, { fetchFn });
      A.S = (await A.client.load()).state;
      A.S.xp = 10;
      A.client.save();
      const one = A.client.flush();
      A.S.xp = 20;
      A.client.save();
      let done = false;
      const two = A.client.flush().then(() => { done = true; });
      await settle();
      assert.equal(done, false, 'still waiting on the first PUT');
      release();
      await Promise.all([one, two]);
      assert.equal(srv.puts.length, 2);
      assert.equal(srv.value.xp, 20, 'the second flush waited for the follow-up PUT');
      assert.equal(A.client.idle, true);
    });

    test('dispose stops saving and retrying for good', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const srv = memoryServer({ xp: 0 });
      const A = tab(srv);
      A.S = (await A.client.load()).state;
      A.client.save();
      A.client.dispose();
      t.mock.timers.tick(60_000);
      await A.client.flush();
      assert.equal(A.client.flushOnExit(), false);
      assert.equal(srv.puts.length, 0);
      assert.equal(A.client.canSave, false);
    });

    test('a client whose first GET failed never reads, reloads or saves', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const srv = memoryServer({ xp: 1 });
      srv.down = true;
      const A = tab(srv);
      A.S = (await A.client.load()).state;
      srv.down = false;
      A.client.save();
      t.mock.timers.tick(60_000);
      await A.client.flush();
      assert.equal(A.client.flushOnExit(), false);
      assert.deepEqual(await A.client.peek(), { ok: false });
      assert.deepEqual(await A.client.reload(), { ok: false });
      assert.deepEqual([srv.gets, srv.puts.length], [1, 0]);
    });
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

describe('awardText', () => {
  test('XP, badge and level-up toasts read as before', () => {
    assert.equal(awardText({ xp: 10, msg: 'article read' }), '+10 XP · article read');
    assert.equal(awardText({ xp: 5, msg: 'folder made', badges: ['Curator'] }), 'New badge: Curator · +5 XP');
    assert.equal(awardText({ xp: 10, msg: 'article read', newLevel: 3 }), 'Level 3! +10 XP · article read');
    assert.equal(
      awardText({ xp: 15, msg: 'note saved', badges: ['Thinking out loud', 'Deep diver'], newLevel: 2 }),
      'Level 2! New badge: Thinking out loud, Deep diver · +15 XP',
    );
  });

  test("while saving is paused, says gently that it isn't saved", () => {
    assert.equal(awardText({ xp: 10, msg: 'article read', saved: false }), '+10 XP · article read · not saved');
    assert.equal(awardText({ xp: 5, msg: 'folder made', badges: ['Curator'], saved: false }), 'New badge: Curator · +5 XP · not saved');
    assert.equal(awardText({ xp: 10, msg: 'article read', newLevel: 2, saved: false }), 'Level 2! +10 XP · article read · not saved');
  });
});
