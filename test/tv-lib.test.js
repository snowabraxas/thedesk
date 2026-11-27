// The TV in the room (N5): how the News desk's signals turn into the TV's glow, mark and tag.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { blankNewsState, dismissBreaking, tvSignals } from '../app/news-lib.js';
import { readSignals, tvLook } from '../app/tv-lib.js';

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'));
const SAMPLE = readJson('data/samples/news.sample.json');
const BREAKING = readJson('data/samples/breaking.sample.json');
const QUIET = { on: false, breaking: false, tag: 'News' };

describe('tvLook', () => {
  test('unread top stories: the screen glows and the tag counts them, like "Product Feed · N new"', () => {
    assert.deepEqual(tvLook({ unread: 3, total: 3, breaking: false, sample: false }), { on: true, breaking: false, tag: 'News · 3 new' });
    assert.deepEqual(tvLook({ unread: 1, total: 3, breaking: false, sample: false }), { on: true, breaking: false, tag: 'News · 1 new' });
  });

  test('a breaking story Snow has not dismissed: the mark, and the tag says so in words', () => {
    assert.deepEqual(tvLook({ unread: 0, total: 3, breaking: true, sample: false }), { on: false, breaking: true, tag: 'News · breaking story' });
    assert.deepEqual(tvLook({ unread: 2, total: 3, breaking: true, sample: false }), { on: true, breaking: true, tag: 'News · breaking story · 2 new' });
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
    assert.equal(tvLook({ unread: 2, breaking: true }, 'TV').tag, 'TV · breaking story · 2 new');
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
    assert.deepEqual(look({ ...SAMPLE, sample: true }, BREAKING, blankNewsState()), { on: true, breaking: true, tag: 'News · breaking story · 3 new' });
  });

  test('dismissing the banner on the News page clears the mark; the glow stays until the stories are read', () => {
    const N = blankNewsState();
    assert.ok(dismissBreaking(N, BREAKING.at));
    assert.deepEqual(look(SAMPLE, BREAKING, N), { on: true, breaking: false, tag: 'News · 3 new' });
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
