// app/news-lib.js (the News page's logic) and app/news-html.js (its markup). npm test runs with TZ=America/Toronto.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { DATE_TIME_PARTS as SERVER_DATE_TIME_PARTS, isCalendarDate as serverIsCalendarDate, isDateTime as serverIsDateTime } from '../server/schema-common.js';
import { checkState } from '../server/state-store.js';
import {
  DATE_TIME_PARTS, KIND_LABEL, MAX_MORE, READ_XP, REGION_LABEL, blankNewsState, breakingTime, breakingView, buildNewsView, dismissBreaking,
  editionLine, greeting, isBreakingVisible, isCalendarDate, isDateTime, isStoryKey, kindLabel, newsLine, normalizeNewsState, readingMinutes,
  regionOf, sourcesOf, storyKey, text, toggleRead, tvSignals,
} from '../app/news-lib.js';
import { breakingHtml, glanceHtml, noStoriesHtml, shelfItemHtml, sourceLinksHtml, storyCardHtml } from '../app/news-html.js';

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'));
const SAMPLE = readJson('data/samples/news.sample.json');
const BREAKING = readJson('data/samples/breaking.sample.json');
const clone = (v) => structuredClone(v);
const story = (over = {}) => ({
  id: 's1', rank: 1, headline: 'A headline', date: '2026-12-07', region: 'us', kind: 'launch',
  summary: 'A summary.', why: 'Why.', skeptic: 'But.', sources: [{ name: 'One', url: 'https://one.example.com/' }, { name: 'Two', url: 'https://two.example.com/' }],
  ...over,
});

// Markup in every text field, and links that must never become links.
const EVIL = `<img src=x onerror=alert(1)>"'&<script>alert(2)</script>`;
const hostileStory = (id, rank) => ({
  id, rank, headline: EVIL, date: EVIL, region: EVIL, kind: EVIL, summary: EVIL, why: EVIL, skeptic: EVIL,
  sources: [
    { name: EVIL, url: 'javascript:alert(1)' },
    { name: EVIL, url: 'https://user:pw@evil.example.com/' },
    { name: EVIL, url: 'https://example.com/" onmouseover="alert(1)' },
    { name: EVIL, url: 'https://good.example.com/a?b=1&c=2' },
  ],
});
const HOSTILE = {
  desk: 'news', edition: '2026-12-07', note: EVIL, sample: 'yes',
  stories: [hostileStory('s1', 1), hostileStory('s2', 2), hostileStory('s3', 3)],
  more: Array.from({ length: 7 }, (_, i) => hostileStory(`m${i + 1}`, i + 4)),
};

describe('labels', () => {
  test('regions and kinds have their labels', () => {
    assert.deepEqual(REGION_LABEL, { us: 'United States', china: 'China', eu: 'European Union', global: 'Global', other: 'Elsewhere' });
    assert.deepEqual(Object.values(KIND_LABEL), ['Launch', 'Policy', 'Research', 'Deal', 'Event']);
  });

  test('an unknown or missing region is "other" (Elsewhere), even a name on Object.prototype', () => {
    for (const r of ['mars', '', undefined, null, 42, 'constructor', '__proto__', 'toString', EVIL]) assert.equal(regionOf(r), 'other', String(r));
    assert.equal(regionOf('china'), 'china');
  });

  test('kinds are capitalised; an unknown kind is capitalised as given, a missing one is empty', () => {
    assert.equal(kindLabel('policy'), 'Policy');
    assert.equal(kindLabel('  briefing  '), 'Briefing');
    assert.equal(kindLabel(undefined), '');
    assert.equal(kindLabel({}), '');
    assert.equal(kindLabel('constructor'), 'Constructor');
    assert.equal(kindLabel('x'.repeat(80)).length, 30, 'cut short');
  });

  test('text() keeps strings and numbers on one line and drops anything else', () => {
    assert.equal(text('  a\n\tb  '), 'a b');
    assert.equal(text(3), '3');
    assert.equal(text(NaN), '');
    assert.equal(text({ toString: () => 'x' }), '');
    assert.equal(text(['a']), '');
    assert.equal(text(null), '');
  });
});

describe('dates and story keys (the same rules as the server)', () => {
  test('DATE_TIME_PARTS is identical to the server copy', () => {
    assert.equal(DATE_TIME_PARTS.source, SERVER_DATE_TIME_PARTS.source);
    assert.equal(DATE_TIME_PARTS.flags, SERVER_DATE_TIME_PARTS.flags);
  });

  test('calendar dates and date-times agree with the server', () => {
    const dates = ['2026-12-07', '2028-02-29', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', ' 2026-12-07', '', null, 20261207];
    for (const d of dates) assert.equal(isCalendarDate(d), serverIsCalendarDate(d), String(d));
    const times = ['2026-12-07T12:04:00-05:00', '2026-12-07T17:04Z', '2026-12-07T23:59:59.123456789+14:59', '2026-12-07T24:00:00Z', '2026-12-07T12:60Z',
      '2026-12-07T12:00:00+15:00', '2026-02-30T12:00Z', '2026-12-07 12:04:00Z', '2026-12-07T12:04:00', '', undefined, 0];
    for (const t of times) assert.equal(isDateTime(t), serverIsDateTime(t), String(t));
  });

  test('storyKey is "<edition>/<story id>"', () => {
    assert.equal(storyKey('2026-12-07', 's1'), '2026-12-07/s1');
    assert.equal(storyKey('2026-12-07', 'A_b-9'), '2026-12-07/A_b-9');
  });

  test('storyKey refuses what the server would refuse, so a bad key never stops saving', () => {
    for (const [ed, id] of [['2026-02-30', 's1'], ['', 's1'], [undefined, 's1'], ['2026-12-07', ''], ['2026-12-07', 's 1'], ['2026-12-07', 's/1'],
      ['2026-12-07', EVIL], ['2026-12-07', 'x'.repeat(41)], ['2026-12-07', 7], ['2026-12-07', undefined]]) {
      assert.equal(storyKey(ed, id), null, `${ed} ${id}`);
    }
  });

  test('every key storyKey makes passes the server state check', () => {
    const key = storyKey('2026-12-07', 'm7');
    assert.ok(isStoryKey(key));
    assert.deepEqual(checkState({ read: { [key]: Date.now() } }, 'news'), { ok: true });
  });
});

describe('reading time', () => {
  test('about 200 words a minute over the headline, summary, why and skeptic, at least 1', () => {
    const words = (n) => Array(n).fill('word').join(' ');
    assert.equal(readingMinutes(story({ headline: '', summary: '', why: '', skeptic: '' })), 1);
    assert.equal(readingMinutes({ headline: words(100), summary: words(100) }), 1);
    assert.equal(readingMinutes({ headline: words(100), summary: words(101) }), 2);
    assert.equal(readingMinutes({ summary: words(600), why: words(1) }), 4);
    assert.equal(readingMinutes(null), 1);
    assert.equal(readingMinutes({ summary: 42 }), 1);
  });
});

describe('buildNewsView', () => {
  test('the sample edition: top 3 and 7 on the shelf, in rank order, numbered 1 to 3', () => {
    const v = buildNewsView({ ...SAMPLE, sample: true }, blankNewsState());
    assert.equal(v.edition, '2026-12-07');
    assert.equal(v.sample, true);
    assert.deepEqual(v.top.map((s) => s.id), ['s1', 's2', 's3']);
    assert.deepEqual(v.top.map((s) => s.position), [1, 2, 3]);
    assert.equal(v.more.length, 7);
    assert.deepEqual(v.more.map((s) => s.rank), [4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual([v.total, v.readCount], [3, 0]);
    assert.equal(v.top[0].regionLabel, 'China');
    assert.equal(v.top[0].kindLabel, 'Launch');
    assert.equal(v.top[0].key, '2026-12-07/s1');
    assert.equal(v.minutes, v.top.reduce((a, s) => a + s.minutes, 0));
  });

  test('sorts by rank whatever order the stories come in; a story without a usable rank goes last', () => {
    const shuffled = { edition: '2026-12-07', stories: [story({ id: 'c', rank: 3 }), story({ id: 'x', rank: 'first' }), story({ id: 'a', rank: 1 })] };
    assert.deepEqual(buildNewsView(shuffled, {}).top.map((s) => [s.id, s.position]), [['a', 1], ['c', 2], ['x', 3]]);
  });

  test('only "sample": true marks a sample', () => {
    for (const sample of ['yes', 1, 'true', undefined]) assert.equal(buildNewsView({ ...SAMPLE, sample }, {}).sample, false, String(sample));
  });

  test('reads count by edition and id: yesterday\'s s1 is not today\'s s1', () => {
    const state = { read: { '2026-12-07/s2': 1, '2026-12-06/s1': 1, '2026-12-07/m3': 1 } };
    const v = buildNewsView(SAMPLE, state);
    assert.deepEqual(v.top.map((s) => s.read), [false, true, false]);
    assert.equal(v.readCount, 1);
    assert.equal(v.more.find((s) => s.id === 'm3').read, true);
    assert.equal(v.minutesLeft, v.top[0].minutes + v.top[2].minutes);
  });

  test('glance: stories, different sources, where it happened and what kind', () => {
    const v = buildNewsView(SAMPLE, {});
    const all = [...SAMPLE.stories, ...SAMPLE.more];
    assert.equal(v.glance.stories, 10);
    assert.equal(v.glance.sources, new Set(all.flatMap((s) => s.sources.map((x) => x.name.toLowerCase()))).size);
    const count = (field, value) => all.filter((s) => s[field] === value).length;
    assert.deepEqual(v.glance.regions.map((r) => [r.region, r.count]), ['us', 'china', 'eu', 'global', 'other'].map((r) => [r, count('region', r)]).filter(([, n]) => n));
    assert.equal(Math.max(...v.glance.regions.map((r) => r.share)), 1);
    const kinds = v.glance.kinds.map((k) => k.count);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => b - a), 'most common kind first');
    assert.equal(kinds.reduce((a, b) => a + b, 0), 10);
  });

  test('the same source name in different stories counts once, ignoring case', () => {
    const e = { edition: '2026-12-07', stories: [story({ id: 'a' }), story({ id: 'b', rank: 2, sources: [{ name: 'one', url: 'https://x.example.com/' }, { name: 'Three', url: 'https://y.example.com/' }] })] };
    assert.equal(buildNewsView(e, {}).glance.sources, 3);
  });

  test('an empty edition, a missing one, or junk gives an empty view, never an error', () => {
    for (const news of [{ edition: '2026-12-07', stories: [] }, null, undefined, [], 'news', { stories: 'three', more: {} }]) {
      const v = buildNewsView(news, undefined);
      assert.deepEqual([v.top, v.more, v.total, v.readCount, v.minutes, v.glance.stories, v.glance.sources, v.glance.regions, v.glance.kinds], [[], [], 0, 0, 0, 0, 0, [], []]);
    }
  });

  test('odd stories and fields: nulls are skipped as blank stories, missing fields are empty, keys only when the id fits', () => {
    const v = buildNewsView({ edition: '2026-12-07', stories: [null, { id: 'bad id!', rank: 1 }, 'story'] }, {});
    assert.equal(v.top.length, 3);
    const s = v.top[0];
    assert.equal(s.key, null);
    assert.deepEqual([s.headline, s.summary, s.why, s.skeptic, s.kindLabel, s.regionLabel], ['', '', '', '', '', 'Elsewhere']);
    assert.deepEqual(s.sources, []);
    assert.equal(buildNewsView({ edition: 'today', stories: [story()] }, {}).top[0].key, null, 'no edition date, no key');
  });

  test('caps at 3 top stories and 7 on the shelf', () => {
    const e = { edition: '2026-12-07', stories: Array.from({ length: 5 }, (_, i) => story({ id: `s${i}`, rank: i + 1 })), more: Array.from({ length: 9 }, (_, i) => story({ id: `m${i}`, rank: i + 6 })) };
    const v = buildNewsView(e, {});
    assert.deepEqual(v.top.map((s) => s.id), ['s0', 's1', 's2']);
    assert.equal(v.more.length, MAX_MORE);
  });

  test('hostile text stays plain text (escaped later), and hostile links are dropped', () => {
    const v = buildNewsView(HOSTILE, {});
    const s = v.top[0];
    for (const f of ['headline', 'summary', 'why', 'skeptic']) assert.equal(s[f], EVIL.replace(/\s+/g, ' '));
    assert.equal(v.note, EVIL);
    assert.equal(s.regionLabel, 'Elsewhere');
    assert.equal(s.sources.length, 4);
    assert.deepEqual(s.sources.map((x) => x.url), [null, null, null, 'https://good.example.com/a?b=1&c=2']);
    assert.equal(v.more.length, 7);
    assert.equal(v.sample, false);
  });
});

describe('sources', () => {
  test('a missing name shows "Source N", never the link', () => {
    assert.deepEqual(sourcesOf([{ url: 'https://a.example.com/' }, { name: '   ', url: 'https://b.example.com/' }, { name: 'C', url: 'ftp://c' }]), [
      { name: 'Source 1', url: 'https://a.example.com/' },
      { name: 'Source 2', url: 'https://b.example.com/' },
      { name: 'C', url: null },
    ]);
  });

  test('junk in the list is skipped, and at most 8 are kept', () => {
    assert.deepEqual(sourcesOf('x'), []);
    assert.deepEqual(sourcesOf([null, 'a', 3]), []);
    assert.equal(sourcesOf(Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, url: 'https://a.example.com/' }))).length, 8);
  });
});

describe("Wila's line, the greeting and the edition date", () => {
  const v = (total, readCount, minutes, minutesLeft) => ({ total, readCount, minutes, minutesLeft });
  test('counts the stories and the minutes, then what is left, then says you are up to date', () => {
    assert.equal(newsLine(v(3, 0, 6, 6)), 'Three stories today, about 6 minutes.');
    assert.equal(newsLine(v(1, 0, 1, 1)), 'One story today, about 1 minute.');
    assert.equal(newsLine(v(3, 1, 6, 4)), 'Two left, about 4 minutes.');
    assert.equal(newsLine(v(3, 2, 6, 1)), 'One left, about 1 minute.');
    assert.equal(newsLine(v(3, 3, 6, 0)), "All three read. You're up to date.");
    assert.equal(newsLine(v(1, 1, 1, 0)), "Today's story is read. You're up to date.");
    assert.equal(newsLine(v(0, 0, 0, 0)), 'No top stories in this edition.');
    assert.equal(newsLine(undefined), 'No top stories in this edition.');
  });

  test('from the sample edition', () => {
    assert.match(newsLine(buildNewsView(SAMPLE, {})), /^Three stories today, about \d+ minutes?\.$/);
  });

  test('greets by the time of day in Toronto', () => {
    const at = (hhmm) => new Date(`2026-12-07T${hhmm}:00-05:00`);
    assert.equal(greeting(at('04:59')), 'Hello, Snow');
    assert.equal(greeting(at('05:00')), 'Good morning, Snow');
    assert.equal(greeting(at('11:59')), 'Good morning, Snow');
    assert.equal(greeting(at('12:00')), 'Good afternoon, Snow');
    assert.equal(greeting(at('17:00')), 'Good evening, Snow');
    assert.equal(greeting(at('23:59')), 'Good evening, Snow');
    assert.equal(greeting(at('00:00')), 'Hello, Snow');
  });

  test('writes the edition date out', () => {
    assert.equal(editionLine('2026-12-07'), 'Monday 7 December · Morning edition');
    assert.equal(editionLine('2027-01-01'), 'Friday 1 January · Morning edition');
    assert.equal(editionLine('2026-02-30'), 'Morning edition');
    assert.equal(editionLine(EVIL), 'Morning edition');
  });
});

describe('breaking', () => {
  test('shows when there is a story with a real "at" and a headline that Snow has not dismissed', () => {
    assert.equal(isBreakingVisible(BREAKING, blankNewsState()), true);
    assert.equal(isBreakingVisible(BREAKING, { dismissed: { [BREAKING.at]: 1 } }), false);
    assert.equal(isBreakingVisible(BREAKING, { dismissed: { '2026-12-06T12:04:00-05:00': 1 } }), true, 'an older dismissal does not hide a new story');
    assert.equal(isBreakingVisible(BREAKING, undefined), true);
  });

  test('nothing to show for no story, a missing or odd "at", or no headline', () => {
    for (const b of [null, undefined, 'breaking', [], { ...BREAKING, at: 'today' }, { ...BREAKING, at: undefined }, { ...BREAKING, at: 'constructor' }, { ...BREAKING, headline: '  ' }]) {
      assert.equal(isBreakingVisible(b, {}), false, JSON.stringify(b));
    }
  });

  test('the time is HH:MM on a Toronto clock, from any offset', () => {
    assert.equal(breakingTime('2026-12-07T12:04:00-05:00'), '12:04');
    assert.equal(breakingTime('2026-12-07T17:04:00Z'), '12:04');
    assert.equal(breakingTime('2026-12-08T01:30:00+09:00'), '11:30');
    assert.equal(breakingTime('2026-07-01T00:05:00-04:00'), '00:05');
    assert.equal(breakingTime('nope'), '');
  });

  test('the banner view links only to a safe first source', () => {
    assert.deepEqual(breakingView(BREAKING).source, { name: 'EU AI Office', url: 'https://digital-strategy.ec.europa.eu/en/policies/ai-office' });
    assert.equal(breakingView({ ...BREAKING, sources: [{ name: 'X', url: 'javascript:alert(1)' }] }).source.url, null);
    assert.equal(breakingView({ ...BREAKING, sources: [] }).source, null);
    assert.equal(breakingView(null).headline, '');
  });

  test('dismissing saves dismissed[at] = now, once, and only for a real "at"', () => {
    const N = blankNewsState();
    assert.equal(dismissBreaking(N, BREAKING.at, 1234), true);
    assert.deepEqual(N.dismissed, { [BREAKING.at]: 1234 });
    assert.equal(dismissBreaking(N, BREAKING.at, 9999), false);
    assert.equal(N.dismissed[BREAKING.at], 1234);
    assert.equal(dismissBreaking(N, 'today', 1), false);
    assert.deepEqual(checkState(N, 'news'), { ok: true });
  });
});

describe('News state', () => {
  test('blank: nothing read or dismissed, the shelf closed', () => {
    assert.deepEqual(blankNewsState(), { read: {}, dismissed: {}, shelfOpen: false, awarded: {} });
  });

  test('normalize keeps good entries, drops ones the server would refuse, and keeps unknown keys', () => {
    const N = normalizeNewsState({
      read: { '2026-12-07/s1': 1, s1: 2, '2026-02-30/s1': 3, '2026-12-07/s2': 'yesterday', '2026-12-07/s3': '2026-12-07T13:05:00.000Z' },
      dismissed: { '2026-12-07T12:04:00-05:00': 5, today: 6 },
      awarded: { '2026-12-07/s1': 1, nope: 1 },
      shelfOpen: 'yes',
      later: { x: 1 },
    });
    assert.deepEqual(N.read, { '2026-12-07/s1': 1, '2026-12-07/s3': '2026-12-07T13:05:00.000Z' });
    assert.deepEqual(N.dismissed, { '2026-12-07T12:04:00-05:00': 5 });
    assert.deepEqual(N.awarded, { '2026-12-07/s1': 1 });
    assert.equal(N.shelfOpen, false);
    assert.deepEqual(N.later, { x: 1 });
    assert.deepEqual(checkState(N, 'news'), { ok: true });
  });

  test('normalize copes with junk and never sets a prototype', () => {
    for (const raw of [null, [], 'x', 3]) assert.deepEqual(normalizeNewsState(raw), blankNewsState());
    assert.deepEqual(normalizeNewsState({ read: [], dismissed: 'x', shelfOpen: true }), { ...blankNewsState(), shelfOpen: true });
    const N = normalizeNewsState(JSON.parse('{"__proto__": {"polluted": true}}'));
    assert.equal(N.polluted, undefined);
    assert.equal(Object.getPrototypeOf(N), Object.prototype);
  });
});

describe('reading pays XP once per story, ever', () => {
  const KEY = '2026-12-07/s1';
  test('the first read pays and records the key; un-marking and re-marking does not pay again', () => {
    const N = blankNewsState();
    assert.deepEqual(toggleRead(N, KEY, { now: 1 }), { read: true, award: true });
    assert.deepEqual(N.read, { [KEY]: 1 });
    assert.deepEqual(N.awarded, { [KEY]: 1 });
    assert.deepEqual(toggleRead(N, KEY, { now: 2 }), { read: false, award: false });
    assert.deepEqual(N.read, {});
    assert.deepEqual(N.awarded, { [KEY]: 1 }, 'the award is remembered');
    assert.deepEqual(toggleRead(N, KEY, { now: 3 }), { read: true, award: false });
    assert.deepEqual(N.read, { [KEY]: 3 });
    assert.deepEqual(checkState(N, 'news'), { ok: true });
  });

  test('a key awarded before a reload (in the saved state) is not paid again', () => {
    const N = normalizeNewsState({ awarded: { [KEY]: 1 } });
    assert.deepEqual(toggleRead(N, KEY), { read: true, award: false });
  });

  test('the same id in another edition pays again (ids repeat every morning)', () => {
    const N = normalizeNewsState({ awarded: { '2026-12-06/s1': 1 } });
    assert.equal(toggleRead(N, KEY).award, true);
  });

  test('when nothing can be saved, a read is marked but not paid or recorded', () => {
    const N = blankNewsState();
    assert.deepEqual(toggleRead(N, KEY, { canAward: false }), { read: true, award: false });
    assert.deepEqual(N.awarded, {});
  });

  test('a key the server would refuse changes nothing', () => {
    const N = blankNewsState();
    assert.deepEqual(toggleRead(N, 's1'), { read: false, award: false });
    assert.deepEqual(toggleRead(N, null), { read: false, award: false });
    assert.deepEqual(N, blankNewsState());
  });

  test('pays 10 XP, the same as an article on the Product Feed', () => {
    assert.equal(READ_XP, 10);
  });
});

describe('tvSignals (the hook for the TV in the room, N5)', () => {
  test('unread top stories and an undismissed breaking story', () => {
    assert.deepEqual(tvSignals(SAMPLE, BREAKING, blankNewsState()), { unread: 3, total: 3, breaking: true, sample: false });
    const N = { read: { '2026-12-07/s1': 1, '2026-12-07/m1': 1 }, dismissed: { [BREAKING.at]: 1 } };
    assert.deepEqual(tvSignals({ ...SAMPLE, sample: true }, BREAKING, N), { unread: 2, total: 3, breaking: false, sample: true });
  });

  test('no edition and no breaking story', () => {
    assert.deepEqual(tvSignals(null, null, undefined), { unread: 0, total: 0, breaking: false, sample: false });
  });
});

// ---------------- the markup ----------------

const tagsIn = (html) => html.match(/<[^>]*>/g) || [];
const ATTRIBUTE_NAMES = new Set(['class', 'id', 'href', 'target', 'rel', 'type', 'data-read', 'data-item', 'aria-pressed', 'aria-describedby', 'aria-expanded',
  'aria-controls', 'aria-labelledby', 'aria-label', 'aria-hidden', 'focusable', 'viewBox', 'd', 'datetime', 'style', 'hidden']);

/** Every tag is one of ours: escaped agent text can't open a tag or add an attribute, and every link is safe. */
function assertSafeMarkup(html, safeLinks) {
  assert.doesNotMatch(html, /javascript:/i, 'a refused link never shows, not even as text');
  for (const tag of tagsIn(html)) {
    assert.match(tag, /^<\/?(article|div|span|h2|h3|p|ul|li|a|button|svg|path|time|b)\b/, tag);
    assert.doesNotMatch(tag, /onerror|onmouseover|<script|<img|user:pw/i, tag);
    const rest = tag.replace(/^<\/?[\w]+/, '').replace(/\/?>$/, '');
    const attrs = [...rest.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)];
    assert.equal(rest.replace(/\s([\w-]+)(?:="([^"]*)")?/g, '').trim(), '', `nothing but attributes in ${tag}`);
    for (const [, name, value = ''] of attrs) {
      assert.ok(ATTRIBUTE_NAMES.has(name), `${name} in ${tag}`);
      if (name === 'href') assert.ok(safeLinks.includes(value), `href ${value}`);
      if (name === 'style') assert.match(value, /^width:\d{1,3}%$/);
    }
  }
  for (const a of html.match(/<a\b[^>]*>/g) || []) {
    assert.match(a, /target="_blank"/, a);
    assert.match(a, /rel="noopener noreferrer"/, a);
  }
}

describe('markup (news-html.js)', () => {
  const GOOD_LINK = 'https://good.example.com/a?b=1&amp;c=2';
  const view = buildNewsView(HOSTILE, {});

  test('a top card escapes every field, links only the safe source, and shows the rest as plain text', () => {
    const html = storyCardHtml(view.top[0], 0);
    assertSafeMarkup(html, [GOOD_LINK]);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;&lt;script&gt;'));
    assert.equal((html.match(/<a /g) || []).length, 1, 'one link: the safe source');
    assert.equal((html.match(/class="nsrc-plain"/g) || []).length, 3, 'the three refused links are plain text');
    assert.match(html, /<span class="ntag region-other">Elsewhere<\/span>/);
  });

  test('link text is the source name, never the link', () => {
    const html = sourceLinksHtml([{ name: 'Rest of World', url: 'https://restofworld.org' }]);
    assert.equal(html, '<li><a href="https://restofworld.org" target="_blank" rel="noopener noreferrer">Rest of World<span class="sr"> (opens in a new tab)</span></a></li>');
  });

  test('a card has its number, tags, reading time, why, skeptic and a Mark read toggle', () => {
    const v = buildNewsView(SAMPLE, { read: { '2026-12-07/s2': 1 } });
    const first = storyCardHtml(v.top[0], 0);
    assert.match(first, /<span class="nrank"><span class="sr">Story <\/span>1<\/span>/);
    assert.match(first, /<span class="ntag region-china">China<\/span>/);
    assert.match(first, /<span class="ntag">Launch<\/span>/);
    assert.match(first, /\d+ min read/);
    assert.match(first, /Why it matters/);
    assert.match(first, /The skeptic’s view/);
    assert.match(first, /<h3 id="ns-t0">/);
    assert.match(first, /<button type="button" class="ab nread " data-read="t0" aria-pressed="false" aria-describedby="ns-t0">Mark read<\/button>/);
    assert.match(storyCardHtml(v.top[1], 1), /data-read="t1" aria-pressed="true"[^>]*>.*Read<\/button>/s);
    assertSafeMarkup(first, v.top[0].sources.map((s) => s.url));
  });

  test('no Mark read button for a story whose key the server would refuse', () => {
    const v = buildNewsView({ edition: '2026-12-07', stories: [story({ id: 'bad id' })] }, {});
    assert.doesNotMatch(storyCardHtml(v.top[0], 0), /data-read/);
  });

  test('a shelf item: region, headline, kind and number of sources; closed until opened', () => {
    const v = buildNewsView(SAMPLE, {});
    const closed = shelfItemHtml(v.more[0], 0, false);
    assert.match(closed, /<button type="button" class="nitembtn" data-item="m0" aria-expanded="false" aria-controls="ns-m0-body">/);
    assert.match(closed, /<span class="nitemmeta">Deal · 2 sources<\/span>/);
    assert.match(closed, /<div class="nitembody" id="ns-m0-body" hidden>/);
    const open = shelfItemHtml(v.more[0], 0, true);
    assert.match(open, /aria-expanded="true"/);
    assert.match(open, /<div class="nitembody" id="ns-m0-body">/);
    assert.match(open, /data-read="m0"/);
  });

  test('every hostile shelf item is safe', () => {
    assert.equal(view.more.length, 7);
    view.more.forEach((s, i) => assertSafeMarkup(shelfItemHtml(s, i, true), [GOOD_LINK]));
  });

  test('the breaking banner: label with Toronto time, headline, a link to the first source, and the dismiss button', () => {
    const html = breakingHtml(breakingView(BREAKING));
    assert.match(html, /<h2 class="nblabel" id="newsBreakingLabel">Breaking · <time datetime="2026-12-07T12:04:00-05:00">12:04<\/time><\/h2>/);
    assert.match(html, /<button type="button" class="nbx" id="newsDismiss" aria-label="Dismiss breaking news">/);
    assert.match(html, /<a href="https:\/\/digital-strategy\.ec\.europa\.eu\/en\/policies\/ai-office" target="_blank" rel="noopener noreferrer">Read<span class="sr"> at EU AI Office \(opens in a new tab\)<\/span><\/a>/);
    assertSafeMarkup(html, ['https://digital-strategy.ec.europa.eu/en/policies/ai-office']);
  });

  test('a hostile breaking story is safe, and its refused link is plain text', () => {
    const html = breakingHtml(breakingView({ ...hostileStory('b1', 1), at: '2026-12-07T12:04:00-05:00' }));
    assertSafeMarkup(html, []);
    assert.match(html, /<span class="nbsrc">&lt;img/);
  });

  test('glance tiles from the hostile edition are safe', () => {
    const g = glanceHtml(view.glance);
    for (const part of Object.values(g)) assertSafeMarkup(part, []);
    assert.match(g.numbers, /<b>10<\/b><span>stories<\/span>/);
    assert.match(g.kinds, /&lt;img/);
  });

  test('glance tiles from the sample, and an empty edition', () => {
    const g = glanceHtml(buildNewsView(SAMPLE, {}).glance);
    assert.match(g.regions, /<span class="nrname">United States<\/span>/);
    assert.match(g.regions, /style="width:100%"/);
    assert.match(g.kinds, /<li class="pill">Policy · \d+<\/li>/);
    const empty = glanceHtml(buildNewsView(null, {}).glance);
    assert.match(empty.numbers, /<b>0<\/b><span>stories<\/span>/);
    assert.match(empty.regions, /No stories yet/);
  });

  test('the no-stories card', () => {
    assert.match(noStoriesHtml(true), /This edition came without any/);
    assert.match(noStoriesHtml(false), /Wila will let you know/);
  });
});
