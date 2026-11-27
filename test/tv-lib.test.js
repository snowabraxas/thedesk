// The TV in the room (N5): how the News desk's signals turn into the TV's glow, mark and tag.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { blankNewsState, dismissBreaking, tvSignals } from '../app/news-lib.js';
import { createRefresher, readSignals, tvLook } from '../app/tv-lib.js';

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'));
const SAMPLE = readJson('data/samples/news.sample.json');
const BREAKING = readJson('data/samples/breaking.sample.json');
const QUIET = { on: false, breaking: false, tag: 'News', short: 'News' };

describe('tvLook', () => {
  test('unread top stories: the screen glows and the tag counts them, like "Product Feed · N new"', () => {
    assert.deepEqual(tvLook({ unread: 3, total: 3, breaking: false, sample: false }), { on: true, breaking: false, tag: 'News · 3 new', short: 'News · 3 new' });
    assert.deepEqual(tvLook({ unread: 1, total: 3, breaking: false, sample: false }), { on: true, breaking: false, tag: 'News · 1 new', short: 'News · 1 new' });
  });

  test('a breaking story Snow has not dismissed: the mark, and the tag says so in words', () => {
    assert.deepEqual(tvLook({ unread: 0, total: 3, breaking: true, sample: false }), { on: false, breaking: true, tag: 'News · breaking story', short: 'News' });
    assert.deepEqual(tvLook({ unread: 2, total: 3, breaking: true, sample: false }), { on: true, breaking: true, tag: 'News · 2 new · breaking story', short: 'News · 2 new' });
  });

  test('the short label (touch screens, where every tag shows) is always the start of the full one', () => {
    // So the words on screen are the first words of the button's name (WCAG 2.5.3), and voice
    // control ("tap News") works; the mark, an icon, shows the breaking story beside it.
    for (const unread of [0, 1, 3, 12]) for (const breaking of [false, true]) {
      const look = tvLook({ unread, total: 3, breaking, sample: false });
      assert.ok(look.tag.startsWith(look.short), `${look.tag} / ${look.short}`);
      assert.doesNotMatch(look.short, /breaking/);
      assert.ok(look.short.length <= 'News · 12 new'.length, look.short);
    }
  });

  test('everything read and nothing breaking: a quiet TV with the plain tag', () => {
    assert.deepEqual(tvLook({ unread: 0, total: 3, breaking: false, sample: false }), QUIET);
  });

  test('a sample edition glows like a real one', () => {
    assert.deepEqual(tvLook({ unread: 3, total: 3, breaking: false, sample: true }), tvLook({ unread: 3, total: 3, breaking: false, sample: false }));
  });

  test('no signals or unusable ones are a quiet TV, never an error', () => {
    for (const bad of [undefined, null, 0, 'News', [], [3], {}, { unread: '3' }, { unread: -1 }, { unread: 1.5 }, { unread: Number.NaN },
      { unread: Number.POSITIVE_INFINITY }, { unread: 2 ** 60 }, { breaking: 'yes' }, { breaking: 1 }]) {
      assert.deepEqual(tvLook(bad), QUIET, JSON.stringify(bad) ?? String(bad));
    }
  });

  test('the name comes first', () => {
    assert.equal(tvLook({ unread: 2, breaking: true }, 'TV').tag, 'TV · 2 new · breaking story');
  });
});

describe('readSignals', () => {
  test("passes news.signals()'s answer through", () => {
    const s = { unread: 1, total: 3, breaking: false, sample: false };
    assert.equal(readSignals(() => s), s);
  });

  test('a throwing or missing source gives null, which tvLook draws as a quiet TV', () => {
    assert.equal(readSignals(() => { throw new Error('not loaded'); }), null);
    assert.equal(readSignals(undefined), null);
    assert.deepEqual(tvLook(readSignals(() => { throw new Error('x'); })), QUIET);
  });
});

describe('from the edition to the TV (tvSignals, then tvLook)', () => {
  const look = (news, breaking, state) => tvLook(tvSignals(news, breaking, state));

  test('the sample edition, nothing read, a breaking story: glow, mark and both in the tag', () => {
    assert.deepEqual(look({ ...SAMPLE, sample: true }, BREAKING, blankNewsState()), { on: true, breaking: true, tag: 'News · 3 new · breaking story', short: 'News · 3 new' });
  });

  test('dismissing the banner on the News page clears the mark; the glow stays until the stories are read', () => {
    const N = blankNewsState();
    assert.ok(dismissBreaking(N, BREAKING.at));
    assert.deepEqual(look(SAMPLE, BREAKING, N), { on: true, breaking: false, tag: 'News · 3 new', short: 'News · 3 new' });
    N.read[`${SAMPLE.edition}/${SAMPLE.stories[0].id}`] = 1;
    assert.equal(look(SAMPLE, BREAKING, N).tag, 'News · 2 new');
    for (const s of SAMPLE.stories) N.read[`${SAMPLE.edition}/${s.id}`] = 1;
    assert.deepEqual(look(SAMPLE, BREAKING, N), QUIET);
  });

  test('reading shelf stories does not count: the glow is about the top 3', () => {
    const N = blankNewsState();
    for (const s of SAMPLE.more) N.read[`${SAMPLE.edition}/${s.id}`] = 1;
    assert.equal(look(SAMPLE, null, N).tag, 'News · 3 new');
  });

  test('yesterday\'s reads do not quiet today\'s edition (story ids repeat every morning)', () => {
    const N = blankNewsState();
    for (const s of SAMPLE.stories) N.read[`2026-12-06/${s.id}`] = 1;
    assert.equal(look(SAMPLE, null, N).on, true);
  });

  test('no edition and no breaking story (nothing could be fetched): quiet', () => {
    assert.deepEqual(look(null, null, blankNewsState()), QUIET);
  });

  test('an edition with no top stories does not glow', () => {
    assert.deepEqual(look({ ...SAMPLE, stories: [], note: 'Quiet day.' }, null, blankNewsState()), QUIET);
  });
});

// A promise to settle by hand, and a way to let pending callbacks run.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('createRefresher (one room refresh at a time)', () => {
  test('a burst of calls while one runs shares it: 25 tab events start one refresh and draw once', async () => {
    const work = deferred();
    let runs = 0, draws = 0;
    const refresh = createRefresher(() => { runs++; return work.promise; }, () => { draws++; });
    const promises = Array.from({ length: 25 }, () => refresh());
    assert.equal(runs, 1);
    assert.ok(promises.every((p) => p === promises[0]), 'every caller gets the same promise');
    assert.equal(draws, 0, 'nothing drawn before the answer');
    work.resolve();
    await promises[0];
    assert.equal(draws, 1);
  });

  test('asked from inside its own run (as a retry queued by the run would be), refresh() hands back that run; force starts anew', async () => {
    let runs = 0;
    let fromInside = null, forced = null;
    const refresh = createRefresher(async () => {
      runs++;
      if (runs === 1) {
        await Promise.resolve();
        fromInside = refresh();
        forced = refresh({ force: true });
      }
    }, () => {});
    const first = refresh();
    await first;
    await forced;
    assert.equal(fromInside, first, 'shared: no new round');
    assert.notEqual(forced, first);
    assert.equal(runs, 2, 'only the forced call ran again');
  });

  test('once it has settled, the next call starts a new refresh', async () => {
    let runs = 0, draws = 0;
    const refresh = createRefresher(() => { runs++; return Promise.resolve(); }, () => { draws++; });
    await refresh();
    await refresh();
    assert.deepEqual([runs, draws], [2, 2]);
  });

  test('the draw gets the answer (app.js redraws the feed only if it changed), or nothing when the work failed', async () => {
    const got = [];
    await createRefresher(() => Promise.resolve(true), (a) => got.push(a))();
    await createRefresher(() => Promise.reject(new Error('offline')), (...a) => got.push(a.length))();
    assert.deepEqual(got, [true, 0]);
  });

  test('a failed refresh still draws (the room keeps what it had), and never rejects', async () => {
    let draws = 0;
    const refresh = createRefresher(() => Promise.reject(new Error('offline')), () => { draws++; });
    await refresh();
    const thrower = createRefresher(() => { throw new Error('not ready'); }, () => { draws++; });
    await thrower();
    assert.equal(draws, 2);
  });

  test('an older refresh that answers after a newer one started is dropped, so it can never draw last', async () => {
    const older = deferred(), newer = deferred();
    const answers = [older, newer];
    const drawn = [];
    let current = '';
    const refresh = createRefresher(() => answers.shift().promise, () => drawn.push(current));
    const first = refresh();
    const second = refresh({ force: true }); // N4's tab-return path will force
    assert.notEqual(first, second);
    current = 'newer'; newer.resolve(); await second;
    current = 'older'; older.resolve(); await first;
    assert.deepEqual(drawn, ['newer'], 'only the newest refresh draws');
  });

  test('a forced refresh becomes the one later callers share', async () => {
    const a = deferred(), b = deferred();
    const answers = [a, b];
    let runs = 0;
    const refresh = createRefresher(() => { runs++; return answers.shift().promise; }, () => {});
    refresh();
    const forced = refresh({ force: true });
    assert.equal(refresh(), forced);
    a.resolve(); await flush();
    assert.equal(refresh(), forced, 'the older one settling does not free the slot while the newer runs');
    b.resolve(); await forced;
    assert.equal(runs, 2);
  });
});
