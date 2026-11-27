// N2: the News contract (data/schema/news.schema.json, breaking.schema.json, server/news-schema.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { BREAKING_SCHEMA_PATH, NEWS_SCHEMA_PATH, REPO_ROOT } from '../server/config.js';
import {
  checkBreakingFile,
  checkNewsDeskFile,
  checkNewsFile,
  isBreakingFile,
  validateBreaking,
  validateNews,
} from '../server/news-schema.js';
import { DATE_TIME_PARTS, MAX_ERRORS } from '../server/schema-common.js';

const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures', 'news');
const NEWS_FIXTURE = path.join(FIXTURES, 'news.json');
const BREAKING_FIXTURE = path.join(FIXTURES, 'breaking.json');

const edition = () => JSON.parse(fs.readFileSync(NEWS_FIXTURE, 'utf8'));
const breaking = () => JSON.parse(fs.readFileSync(BREAKING_FIXTURE, 'utf8'));
const VALID = { ok: true, errors: [] };

/** How a message writes a hidden character: \u00ad, or \u{e0041} beyond the BMP. */
const escaped = (...points) => points.map((p) => (p > 0xffff ? `\\u{${p.toString(16)}}` : `\\u${p.toString(16).padStart(4, '0')}`)).join('');

const SITE_WORDS =
  'must name a public site like example.com in plain letters, digits, dots, dashes or underscores (xn-- for other alphabets), not localhost or an IP address';

/** A story for padding lists, with its own id and rank. */
const extraStory = (id, rank) => ({ ...edition().more[0], id, rank });

describe('the fixtures', () => {
  test('the edition fixture is a full edition: 3 stories, 2 on the shelf, every region and kind used', () => {
    const news = edition();
    assert.equal(news.stories.length, 3);
    assert.equal(news.more.length, 2);
    const all = [...news.stories, ...news.more];
    assert.deepEqual([...new Set(all.map((s) => s.region))].sort(), ['china', 'eu', 'global', 'other', 'us']);
    assert.deepEqual([...new Set(all.map((s) => s.kind))].sort(), ['deal', 'event', 'launch', 'policy', 'research']);
  });

  test('the breaking schema checks "at" with the same pattern the validator words', () => {
    const schema = JSON.parse(fs.readFileSync(BREAKING_SCHEMA_PATH, 'utf8'));
    assert.equal(schema.properties.at.pattern, DATE_TIME_PARTS.source);
    assert.equal(schema.$ref, 'news.schema.json#/$defs/story', 'breaking borrows the story from the edition schema');
  });

  test('both schemas allow extra fields, like the Product Feed schema', () => {
    const news = JSON.parse(fs.readFileSync(NEWS_SCHEMA_PATH, 'utf8'));
    assert.equal(news.additionalProperties, true);
    assert.equal(news.$defs.story.additionalProperties, true);
    assert.equal(JSON.parse(fs.readFileSync(BREAKING_SCHEMA_PATH, 'utf8')).additionalProperties, true);
  });
});

describe('validateNews: accepts', () => {
  test('a valid edition', () => {
    assert.deepEqual(validateNews(edition()), VALID);
  });

  test('an edition with no note and no more shelf', () => {
    const news = edition();
    delete news.note;
    delete news.more;
    assert.deepEqual(validateNews(news), VALID);
  });

  test('2 stories with a note saying why', () => {
    const news = edition();
    news.stories.pop();
    news.note = 'A quiet day: only two stories were worth your time.';
    assert.deepEqual(validateNews(news), VALID);
  });

  test('no stories at all, when the note says why', () => {
    const news = edition();
    news.stories = [];
    news.note = 'Nothing new worth sending today.';
    assert.deepEqual(validateNews(news), VALID);
  });

  test('a full shelf of 7, and a story with 8 sources', () => {
    const news = edition();
    news.more = Array.from({ length: 7 }, (_, i) => extraStory(`m${i + 1}`, i + 4));
    news.stories[0].sources = Array.from({ length: 8 }, (_, i) => ({ name: `Example ${i}`, url: `https://example.com/${i}` }));
    assert.deepEqual(validateNews(news), VALID);
  });

  test('text at the length limits, counting characters rather than bytes', () => {
    const news = edition();
    news.stories[0].headline = 'é'.repeat(160);
    news.stories[0].summary = 's'.repeat(700);
    news.stories[0].why = 'w'.repeat(300);
    news.stories[0].skeptic = '🌿'.repeat(500);
    news.stories[0].sources[0].name = 'n'.repeat(80);
    assert.deepEqual(validateNews(news), VALID);
  });

  test('extra fields the page does not use yet', () => {
    const news = edition();
    news.generatedBy = 'news agent';
    news.stories[0].tags = ['chips'];
    news.stories[0].sources[0].author = 'A. Writer';
    assert.deepEqual(validateNews(news), VALID);
  });

  test('a "sample" key passes the check (it is stripped later, see checkNewsFile)', () => {
    const news = edition();
    news.sample = true;
    assert.deepEqual(validateNews(news), VALID);
  });

  test('links with an @ after the site name, a query or a port', () => {
    const news = edition();
    news.stories[0].sources[0].url = 'https://example.com/@snow/post';
    news.stories[0].sources[1].url = 'https://example.com:8443/p?q=1&by=a@b.com#top';
    assert.deepEqual(validateNews(news), VALID);
  });
});

describe('validateNews: the rules', () => {
  test('4 stories are too many, and it says where the rest go', () => {
    const news = edition();
    news.stories.push(extraStory('s4', 9));
    assert.deepEqual(validateNews(news).errors, ['stories: can have at most 3 stories (has 4); the top 3 go in stories, up to 7 more in more']);
  });

  test('2 stories with no note are refused', () => {
    const news = edition();
    news.stories.pop();
    news.note = '';
    assert.deepEqual(validateNews(news).errors, ['note: must say why there are fewer than 3 stories (stories has 2)']);
  });

  test('2 stories with the note missing, or only spaces, are refused', () => {
    for (const note of [undefined, '   ', '\n\t']) {
      const news = edition();
      news.stories.pop();
      if (note === undefined) delete news.note;
      else news.note = note;
      assert.deepEqual(validateNews(news).errors, ['note: must say why there are fewer than 3 stories (stories has 2)'], JSON.stringify(note));
    }
  });

  test('no stories and no note are refused', () => {
    const news = edition();
    news.stories = [];
    assert.deepEqual(validateNews(news).errors, ['note: must say why there are fewer than 3 stories (stories has 0)']);
  });

  test('a note that is not text gets one line, not two', () => {
    const news = edition();
    news.stories.pop();
    news.note = 42;
    assert.deepEqual(validateNews(news).errors, ['note: must be text']);
  });

  test('8 stories on the shelf are too many', () => {
    const news = edition();
    news.stories = [];
    news.note = 'Test: everything went on the shelf.';
    news.more = Array.from({ length: 8 }, (_, i) => extraStory(`m${i + 1}`, i + 1));
    assert.deepEqual(validateNews(news).errors, ['more: can have at most 7 stories (has 8); leave the weakest out']);
  });

  // N2 review: the brief says rank 1 to 10 across stories and more, and the schema now agrees.
  test('a rank above 10 is refused', () => {
    const news = edition();
    news.more[1].rank = 11;
    assert.deepEqual(validateNews(news).errors, ['more[1].rank: must be <= 10']);
  });

  test('a story with 1 source is refused, in stories and in more', () => {
    const news = edition();
    news.stories[1].sources = news.stories[1].sources.slice(0, 1);
    news.more[0].sources = news.more[0].sources.slice(0, 1);
    assert.deepEqual(validateNews(news).errors, [
      'stories[1].sources: needs at least 2 sources (has 1)',
      'more[0].sources: needs at least 2 sources (has 1)',
    ]);
  });

  test('a story with no sources, or more than 8, is refused', () => {
    const news = edition();
    news.stories[0].sources = [];
    news.stories[2].sources = Array.from({ length: 9 }, (_, i) => ({ name: `Example ${i}`, url: `https://example.com/${i}` }));
    assert.deepEqual(validateNews(news).errors, [
      'stories[0].sources: needs at least 2 sources (has 0)',
      'stories[2].sources: can have at most 8 sources (has 9); keep the 8 strongest',
    ]);
  });

  test('an empty or whitespace skeptic is refused', () => {
    for (const skeptic of ['', '   ', '\n\t ']) {
      const news = edition();
      news.stories[0].skeptic = skeptic;
      assert.deepEqual(validateNews(news).errors, [`stories[0].skeptic: must not be empty or only spaces (got ${JSON.stringify(skeptic)})`], JSON.stringify(skeptic));
    }
  });

  test('a missing skeptic is refused', () => {
    const news = edition();
    delete news.more[1].skeptic;
    assert.deepEqual(validateNews(news).errors, ['more[1]: missing required field "skeptic"']);
  });

  test('headline, summary, why and source name must not be blank either', () => {
    const news = edition();
    news.stories[0].headline = ' ';
    news.stories[0].summary = '';
    news.stories[0].why = '\t';
    news.stories[0].sources[1].name = '';
    assert.deepEqual(validateNews(news).errors, [
      'stories[0].headline: must not be empty or only spaces (got " ")',
      'stories[0].summary: must not be empty or only spaces (got "")',
      'stories[0].why: must not be empty or only spaces (got "\\t")',
      'stories[0].sources[1].name: must not be empty or only spaces (got "")',
    ]);
  });

  test('text over the limits is refused, and it says how long it is', () => {
    const news = edition();
    news.stories[0].headline = 'h'.repeat(161);
    news.stories[0].summary = 's'.repeat(701);
    news.stories[0].why = 'w'.repeat(301);
    news.stories[0].skeptic = 'k'.repeat(501);
    news.stories[0].sources[0].name = 'n'.repeat(81);
    news.note = 'x'.repeat(301);
    assert.deepEqual(validateNews(news).errors, [
      'note: must be at most 300 characters (it has 301)',
      'stories[0].headline: must be at most 160 characters (it has 161)',
      'stories[0].summary: must be at most 700 characters (it has 701)',
      'stories[0].why: must be at most 300 characters (it has 301)',
      'stories[0].skeptic: must be at most 500 characters (it has 501)',
      'stories[0].sources[0].name: must be at most 80 characters (it has 81)',
    ]);
  });

  test('an http:// link is refused', () => {
    const news = edition();
    news.stories[2].sources[1].url = 'http://example.com/news/test-story-three';
    assert.deepEqual(validateNews(news).errors, ['stories[2].sources[1].url: must start with https:// (got "http://example.com/news/test-story-three")']);
  });

  test('a javascript: link is refused, and so are data:, mixed-case and padded links', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>hi</b>', 'HTTPS://example.com', ' https://example.com']) {
      const news = edition();
      news.more[0].sources[0].url = url;
      assert.deepEqual(validateNews(news).errors, [`more[0].sources[0].url: must start with https:// (got ${JSON.stringify(url)})`], url);
    }
  });

  test('a https://user@host link is refused, and a password is never printed', () => {
    for (const url of ['https://user@example.com/', 'https://user:secret@example.com/post', 'https://@example.com/']) {
      const news = edition();
      news.stories[0].sources[0].url = url;
      const { errors } = validateNews(news);
      assert.equal(errors.length, 1, url);
      assert.match(errors[0], /^stories\[0\]\.sources\[0\]\.url: must not have a user name or password before the site name \(got "https:\/\/(\*\*\*)?@example\.com\//, url);
      assert.ok(!errors[0].includes('secret') && !errors[0].includes('user@'));
    }
  });

  test('a link with no site name, or with spaces, is refused', () => {
    const news = edition();
    news.stories[0].sources[0].url = 'https://';
    news.stories[0].sources[1].url = 'https://example.com/a b';
    assert.deepEqual(validateNews(news).errors, [
      'stories[0].sources[0].url: must be a whole link that starts with https://, with a site name and no spaces (got "https://")',
      'stories[0].sources[1].url: must be a whole link that starts with https://, with a site name and no spaces (got "https://example.com/a b")',
    ]);
  });

  test('a source without a url or name is refused', () => {
    const news = edition();
    delete news.stories[1].sources[2].url;
    delete news.stories[1].sources[0].name;
    assert.deepEqual(validateNews(news).errors, ['stories[1].sources[0]: missing required field "name"', 'stories[1].sources[2]: missing required field "url"']);
  });

  test('duplicate ids within stories are refused, naming both places', () => {
    const news = edition();
    news.stories[2].id = 's1';
    assert.deepEqual(validateNews(news).errors, ['stories[2].id: duplicate id "s1" (also used by stories[0])']);
  });

  test('duplicate ids between stories and more are refused', () => {
    const news = edition();
    news.more[1].id = 's2';
    assert.deepEqual(validateNews(news).errors, ['more[1].id: duplicate id "s2" (also used by stories[1])']);
  });

  test('duplicate ids within more are refused', () => {
    const news = edition();
    news.more[1].id = 'm1';
    assert.deepEqual(validateNews(news).errors, ['more[1].id: duplicate id "m1" (also used by more[0])']);
  });

  test('duplicate ranks are refused, within stories and across the edition', () => {
    const news = edition();
    news.stories[1].rank = 1;
    news.more[0].rank = 3;
    assert.deepEqual(validateNews(news).errors, [
      'stories[1].rank: duplicate rank 1 (also used by stories[0])',
      'more[0].rank: duplicate rank 3 (also used by stories[2])',
    ]);
  });

  test('a rank must be a whole number from 1', () => {
    const news = edition();
    news.stories[0].rank = 0;
    news.stories[1].rank = 1.5;
    news.stories[2].rank = '3';
    assert.deepEqual(validateNews(news).errors, ['stories[0].rank: must be >= 1', 'stories[1].rank: must be a whole number', 'stories[2].rank: must be a whole number']);
  });

  test('a bad region or kind is refused, listing the allowed ones', () => {
    const news = edition();
    news.stories[0].region = 'asia';
    news.more[1].kind = 'opinion';
    news.stories[1].region = 'US';
    assert.deepEqual(validateNews(news).errors, [
      'stories[0].region: must be one of "us", "china", "eu", "global", "other" (got "asia")',
      'stories[1].region: must be one of "us", "china", "eu", "global", "other" (got "US")',
      'more[1].kind: must be one of "launch", "policy", "research", "deal", "event" (got "opinion")',
    ]);
  });

  test('a bad edition date is refused: wrong shape, not on the calendar, or missing', () => {
    const shape = edition();
    shape.edition = '7 Dec 2026';
    assert.deepEqual(validateNews(shape).errors, ['edition: must be a date like YYYY-MM-DD (got "7 Dec 2026")']);

    for (const date of ['2026-02-30', '2026-13-01', '2026-12-00']) {
      const news = edition();
      news.edition = date;
      assert.deepEqual(validateNews(news).errors, [`edition: must be a real calendar date like YYYY-MM-DD (got "${date}")`], date);
    }

    const missing = edition();
    delete missing.edition;
    assert.deepEqual(validateNews(missing).errors, ['news: missing required field "edition"']);
  });

  test('a story date must be empty or a real YYYY-MM-DD', () => {
    const news = edition();
    news.stories[0].date = 'yesterday';
    news.stories[1].date = '2026-04-31';
    assert.deepEqual(validateNews(news).errors, [
      'stories[0].date: must be a date like YYYY-MM-DD, or empty (got "yesterday")',
      'stories[1].date: must be a real calendar date like YYYY-MM-DD, or empty (got "2026-04-31")',
    ]);
  });

  test('an id must be short, with no spaces', () => {
    const news = edition();
    news.stories[0].id = 'story one';
    news.stories[1].id = 'x'.repeat(41);
    news.stories[2].id = '';
    const words = 'must be 1 to 40 letters, digits, dashes or underscores';
    assert.deepEqual(validateNews(news).errors, [
      `stories[0].id: ${words} (got "story one")`,
      `stories[1].id: ${words} (got "${'x'.repeat(41)}")`,
      `stories[2].id: ${words} (got "")`,
    ]);
  });

  test('the desk must be "news", and stories must be there', () => {
    const news = edition();
    news.desk = 'product-feed';
    delete news.stories;
    assert.deepEqual(validateNews(news).errors, [
      'this looks like a Product Feed file: run npm run validate-feed',
      'news: missing required field "stories"',
      'desk: must be "news"',
    ]);
  });

  test('lists every problem in one go', () => {
    const news = edition();
    news.stories.pop();
    news.stories[0].sources = news.stories[0].sources.slice(0, 1);
    news.stories[1].skeptic = '';
    news.more[0].id = 's1';
    assert.equal(validateNews(news).errors.length, 4);
  });

  test('quotes untrusted values safely and keeps them short', () => {
    const news = edition();
    news.stories[0].sources[0].url = `http://example.com/\u001b[31m${'x'.repeat(200)}`;
    const [line] = validateNews(news).errors;
    assert.ok(!line.includes('\u001b'), 'control characters are escaped');
    assert.ok(line.includes('\\u001b'));
    assert.ok(line.length < 150, 'long values are cut short');
  });

  test('refuses things that are not a JSON object', () => {
    for (const value of [null, [], 'news', 42, undefined]) {
      assert.deepEqual(validateNews(value), { ok: false, errors: ['news: must be a JSON object'] });
    }
  });

  test('a story that is not an object gets one line', () => {
    const news = edition();
    news.more[0] = 'a story';
    assert.deepEqual(validateNews(news).errors, ['more[0]: must be an object']);
  });
});

describe('validateBreaking', () => {
  test('accepts a valid breaking story', () => {
    assert.deepEqual(validateBreaking(breaking()), VALID);
  });

  test('accepts "at" with Z, an offset, no seconds, or fractions of a second', () => {
    for (const at of ['2026-12-07T17:04:00Z', '2026-12-07T12:04:00-05:00', '2026-12-07T12:04-05:00', '2026-12-07T17:04:00.123Z', '2026-12-08T07:04:00+14:00']) {
      const story = breaking();
      story.at = at;
      assert.deepEqual(validateBreaking(story), VALID, at);
    }
  });

  test('refuses "at" in the wrong shape: no timezone, a space, a date only, or not text', () => {
    const words = 'must be a date and time with a timezone, like 2026-12-07T12:04:00-05:00 or 2026-12-07T17:04:00Z';
    for (const at of ['2026-12-07T12:04:00', '2026-12-07 12:04:00-05:00', '2026-12-07', 'Dec 7, 12:04 pm', '2026-12-07t12:04:00z', '']) {
      const story = breaking();
      story.at = at;
      assert.deepEqual(validateBreaking(story).errors, [`at: ${words} (got ${JSON.stringify(at)})`], at);
    }
    const number = breaking();
    number.at = 1765127040000;
    assert.deepEqual(validateBreaking(number).errors, ['at: must be text']);
  });

  test('refuses an "at" that is not a real moment', () => {
    for (const at of ['2026-02-30T10:00:00Z', '2026-12-07T24:00:00Z', '2026-12-07T12:60:00Z', '2026-12-07T12:04:60Z', '2026-12-07T12:04:00+15:00', '2026-12-07T12:04:00-05:60']) {
      const story = breaking();
      story.at = at;
      assert.deepEqual(validateBreaking(story).errors, [`at: must be a real date and time, like 2026-12-07T12:04:00-05:00 (got "${at}")`], at);
    }
  });

  test('refuses a breaking story with no "at"', () => {
    const story = breaking();
    delete story.at;
    assert.deepEqual(validateBreaking(story).errors, ['breaking: missing required field "at"']);
  });

  test('applies the story rules, pointing at the field', () => {
    const story = breaking();
    story.sources = [{ name: 'Example News', url: 'http://example.com/x' }];
    story.skeptic = ' ';
    story.region = 'asia';
    assert.deepEqual(validateBreaking(story).errors, [
      'region: must be one of "us", "china", "eu", "global", "other" (got "asia")',
      'skeptic: must not be empty or only spaces (got " ")',
      'sources: needs at least 2 sources (has 1)',
      'sources[0].url: must start with https:// (got "http://example.com/x")',
    ]);
  });

  test('refuses links with a user name, links with no site, and dates not on the calendar', () => {
    const story = breaking();
    story.sources[0].url = 'https://user@example.com/x';
    story.sources[1].url = 'https://';
    story.date = '2026-02-30';
    assert.deepEqual(validateBreaking(story).errors, [
      'date: must be a real calendar date like YYYY-MM-DD, or empty (got "2026-02-30")',
      'sources[0].url: must not have a user name or password before the site name (got "https://***@example.com/x")',
      'sources[1].url: must be a whole link that starts with https://, with a site name and no spaces (got "https://")',
    ]);
  });

  test('needs every story field, rank included', () => {
    const story = breaking();
    delete story.rank;
    delete story.headline;
    assert.deepEqual(validateBreaking(story).errors, ['breaking: missing required field "rank"', 'breaking: missing required field "headline"']);
  });

  test('refuses things that are not a JSON object, including a whole edition-style list', () => {
    for (const value of [null, [breaking()], 'breaking', undefined]) {
      assert.deepEqual(validateBreaking(value), { ok: false, errors: ['breaking: must be a JSON object'] });
    }
  });
});

describe('isBreakingFile', () => {
  test('a file named breaking.json is a breaking story, whatever is in it', () => {
    assert.equal(isBreakingFile('/h/desks/news/breaking.json', edition()), true);
    assert.equal(isBreakingFile('/h/desks/news/Breaking.JSON', undefined), true);
  });

  // N2 review: the name decides first, then whether there is a `stories` key; `at` no longer decides.
  test('news.json and anything in an editions/ folder is an edition, whatever is in it', () => {
    assert.equal(isBreakingFile('/h/desks/news/news.json', { ...edition(), at: '2026-12-07T05:30:00-05:00' }), false);
    assert.equal(isBreakingFile('/h/desks/news/News.JSON', breaking()), false);
    assert.equal(isBreakingFile('/h/desks/news/editions/2026-12-07.json', breaking()), false);
    assert.equal(isBreakingFile('/h/desks/news/Editions/draft.json', {}), false);
  });

  test('any other file is a breaking story unless it has a stories key', () => {
    assert.equal(isBreakingFile('/tmp/story.json', breaking()), true);
    const draft = breaking();
    delete draft.at;
    assert.equal(isBreakingFile('/tmp/draft.json', draft), true, 'a breaking draft missing "at" is still a breaking story');
    assert.equal(isBreakingFile('/tmp/list.json', [{ at: 'x' }]), true);
    assert.equal(isBreakingFile('/tmp/copy.json', edition()), false);
    assert.equal(isBreakingFile('/tmp/copy-with-at.json', { ...edition(), at: '2026-12-07T05:30:00-05:00' }), false);
    assert.equal(isBreakingFile('/tmp/empty-edition.json', { stories: [] }), false);
  });

  test('a file that could not be read counts by its name only', () => {
    assert.equal(isBreakingFile('/tmp/missing.json', undefined), false);
    assert.equal(isBreakingFile('/tmp/breaking.json', undefined), true);
  });
});

describe('checkNewsFile, checkBreakingFile and checkNewsDeskFile', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-news-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };

  test('read and accept the fixtures, returning what they hold', async () => {
    const news = await checkNewsFile(NEWS_FIXTURE);
    assert.equal(news.ok, true);
    assert.equal(news.news.edition, '2026-12-07');
    const story = await checkBreakingFile(BREAKING_FIXTURE);
    assert.equal(story.ok, true);
    assert.equal(story.breaking.at, '2026-12-07T12:04:00-05:00');
  });

  test('strip a "sample" key from the agent\'s files: only The Desk may say sample', async () => {
    const news = await checkNewsFile(write('sample-news.json', { ...edition(), sample: true }));
    assert.equal(news.ok, true);
    assert.equal('sample' in news.news, false);
    const story = await checkBreakingFile(write('sample-breaking.json', { ...breaking(), sample: 'yes' }));
    assert.equal(story.ok, true);
    assert.equal('sample' in story.breaking, false);
    const desk = await checkNewsDeskFile(write('sample-desk.json', { ...edition(), sample: true }));
    assert.equal('sample' in desk.news, false);
  });

  test('do not return the file when it is invalid', async () => {
    const bad = edition();
    bad.stories[0].sources[0].url = 'http://example.com';
    const result = await checkNewsFile(write('invalid.json', bad));
    assert.equal(result.ok, false);
    assert.equal(result.news, undefined);
  });

  test('report a missing file, broken JSON and a file that is too big', async () => {
    const missing = path.join(dir, 'nope.json');
    assert.deepEqual(await checkNewsFile(missing), { ok: false, errors: [`${missing}: file not found`] });

    const broken = await checkBreakingFile(write('broken.json', '{"id": "b1",'));
    assert.equal(broken.ok, false);
    assert.match(broken.errors[0], /not valid JSON/);

    const big = await checkNewsFile(write('big.json', 'x'.repeat(2048)), { maxBytes: 1024 });
    assert.equal(big.ok, false);
    assert.match(big.errors[0], /too big \(2048 bytes, limit is 1024\)/);
  });

  test('accept a file that starts with a byte-order mark', async () => {
    const file = write('bom.json', `\uFEFF${fs.readFileSync(NEWS_FIXTURE, 'utf8')}`);
    assert.equal((await checkNewsFile(file)).ok, true);
  });

  test('checkNewsDeskFile checks breaking.json and files with "at" as breaking stories', async () => {
    const byContent = await checkNewsDeskFile(write('found-at-noon.json', breaking()));
    assert.equal(byContent.kind, 'breaking');
    assert.equal(byContent.ok, true);
    assert.equal(byContent.breaking.id, 'b1');

    const fixture = await checkNewsDeskFile(BREAKING_FIXTURE);
    assert.equal(fixture.kind, 'breaking');
    assert.equal(fixture.ok, true);

    fs.mkdirSync(path.join(dir, 'named'));
    const byName = await checkNewsDeskFile(path.join(dir, 'named', 'breaking.json'));
    assert.equal(byName.kind, 'breaking', 'a missing breaking.json is still named as one');
    assert.equal(byName.ok, false);
  });

  test('checkNewsDeskFile checks anything else as an edition', async () => {
    const result = await checkNewsDeskFile(NEWS_FIXTURE);
    assert.equal(result.kind, 'news');
    assert.equal(result.ok, true);
    assert.equal(result.news.desk, 'news');

    const edition2 = await checkNewsDeskFile(write('2026-12-06.json', { ...edition(), edition: '2026-12-06' }));
    assert.equal(edition2.kind, 'news');
    assert.equal(edition2.ok, true);
  });

  // N2 review: the CLI and the server (which uses checkNewsFile) must agree on an edition with an extra "at".
  test('news.json with an extra top-level "at" is a valid edition, for the CLI and the server alike', async () => {
    fs.mkdirSync(path.join(dir, 'live'));
    const file = path.join(dir, 'live', 'news.json');
    fs.writeFileSync(file, JSON.stringify({ ...edition(), at: '2026-12-07T05:30:00-05:00' }));
    const desk = await checkNewsDeskFile(file);
    assert.equal(desk.kind, 'news');
    assert.equal(desk.ok, true, desk.errors.join('\n'));
    assert.equal((await checkNewsFile(file)).ok, true);

    const copy = await checkNewsDeskFile(write('edition-copy-with-at.json', { ...edition(), at: '2026-12-07T05:30:00-05:00' }));
    assert.equal(copy.kind, 'news', 'a copy under another name has stories, so it is an edition too');
    assert.equal(copy.ok, true);
  });

  test('a breaking draft under another name that is missing "at" is told exactly that', async () => {
    const draft = breaking();
    delete draft.at;
    const result = await checkNewsDeskFile(write('breaking-draft.json', draft));
    assert.equal(result.kind, 'breaking');
    assert.deepEqual(result.errors, ['breaking: missing required field "at"']);
  });

  test('a file in editions/ is checked as an edition, even when it looks like a breaking story', async () => {
    fs.mkdirSync(path.join(dir, 'editions'));
    const result = await checkNewsDeskFile(write(path.join('editions', '2026-12-07.json'), breaking()));
    assert.equal(result.kind, 'news');
    assert.ok(result.errors.includes('news: missing required field "stories"'), result.errors.join('\n'));
  });
});

describe('N2 review: links, quoting and runaway files', () => {
  test('the same link twice in one story is refused: a story needs 2 different sources', () => {
    const news = edition();
    news.stories[0].sources[1].url = news.stories[0].sources[0].url;
    assert.deepEqual(validateNews(news).errors, ['stories[0].sources[1].url: same link as sources[0]; a story needs 2 different sources']);
  });

  test('two names on one link count once, and so do links that differ only by #fragment, capitals in the site or a bare /', () => {
    const variants = [
      ['https://example.com/a', 'https://example.com/a#section-2'],
      ['https://example.com/a', 'https://EXAMPLE.com/a'],
      ['https://example.com', 'https://example.com/'],
      ['https://example.com:443/a', 'https://example.com/a'],
    ];
    for (const [first, second] of variants) {
      const news = edition();
      news.more[1].sources = [
        { name: 'Example News', url: first },
        { name: 'Example Wire', url: second },
      ];
      assert.deepEqual(validateNews(news).errors, ['more[1].sources[1].url: same link as sources[0]; a story needs 2 different sources'], second);
    }
  });

  // N2 review: tracking parameters, an empty "?" and a trailing dot don't make a new page; a route fragment does.
  test('utm_* parameters, an empty ? and a trailing dot on the site do not make a link a different source', () => {
    const variants = [
      ['https://example.com/a?id=7', 'https://example.com/a?utm_source=x&id=7&UTM_Medium=y'],
      ['https://example.com/a', 'https://example.com/a?utm_campaign=z'],
      ['https://example.com/a', 'https://example.com/a?'],
      ['https://example.com/a', 'https://example.com./a'],
      ['https://example.com/a', 'https://example.com/a#'],
    ];
    for (const [first, second] of variants) {
      const news = edition();
      news.stories[1].sources = [
        { name: 'Example News', url: first },
        { name: 'Example Wire', url: second },
      ];
      assert.deepEqual(validateNews(news).errors, ['stories[1].sources[1].url: same link as sources[0]; a story needs 2 different sources'], second);
    }
  });

  test('hash routes are different pages, and other parameters keep their order', () => {
    const news = edition();
    news.stories[1].sources = [
      { name: 'Example App', url: 'https://app.example.com/#/story/1' },
      { name: 'Example App', url: 'https://app.example.com/#/story/2' },
      { name: 'Example App', url: 'https://app.example.com/#!/story/3' },
      { name: 'Example News', url: 'https://example.com/a?x=1&y=2' },
      { name: 'Example News', url: 'https://example.com/a?y=2&x=1' },
    ];
    assert.deepEqual(validateNews(news), VALID);
  });

  test('different pages on one site, or different queries, are different sources', () => {
    const news = edition();
    news.stories[1].sources = [
      { name: 'Example News', url: 'https://example.com/a' },
      { name: 'Example News', url: 'https://example.com/b' },
      { name: 'Example News', url: 'https://example.com/a?page=2' },
    ];
    assert.deepEqual(validateNews(news), VALID);
  });

  test('a repeated bad link is reported for being bad, not again for being repeated', () => {
    const news = edition();
    news.stories[2].sources = [
      { name: 'Example News', url: 'http://example.com/a' },
      { name: 'Example Wire', url: 'http://example.com/a' },
    ];
    news.stories[0].sources = [
      { name: 'Example News', url: 'https://u:secret@example.com/a' },
      { name: 'Example Wire', url: 'https://u:secret@example.com/a' },
    ];
    assert.deepEqual(validateNews(news).errors, [
      'stories[2].sources[0].url: must start with https:// (got "http://example.com/a")',
      'stories[2].sources[1].url: must start with https:// (got "http://example.com/a")',
      'stories[0].sources[0].url: must not have a user name or password before the site name (got "https://***@example.com/a")',
      'stories[0].sources[1].url: must not have a user name or password before the site name (got "https://***@example.com/a")',
    ]);
  });

  test('the same link twice in a breaking story is refused too', () => {
    const story = breaking();
    story.sources[1].url = `${story.sources[0].url}#top`;
    assert.deepEqual(validateBreaking(story).errors, ['sources[1].url: same link as sources[0]; a story needs 2 different sources']);
  });

  test('the brief and the schema agree: 2 to 8 sources, keep the 8 strongest', () => {
    const schema = JSON.parse(fs.readFileSync(NEWS_SCHEMA_PATH, 'utf8'));
    const sources = schema.$defs.story.properties.sources;
    assert.equal(sources.minItems, 2);
    assert.equal(sources.maxItems, 8);
    assert.match(sources.description, /at most 8 \(if more were used, keep the 8 strongest\)/);
    const brief = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'news', 'AGENTS.md'), 'utf8');
    const line = brief.split('\n').find((l) => l.includes('`sources`:'));
    assert.match(line, /at least 2 and at most 8 \(if you used more, keep the 8 strongest\)/);
  });

  test('the brief says what id, rank and note hold, and rank 1 to 10 matches the schema', () => {
    const schema = JSON.parse(fs.readFileSync(NEWS_SCHEMA_PATH, 'utf8'));
    assert.equal(schema.$defs.story.properties.rank.minimum, 1);
    assert.equal(schema.$defs.story.properties.rank.maximum, 10);
    const brief = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'news', 'AGENTS.md'), 'utf8');
    assert.ok(brief.includes("`id`: short and unique in the edition; `rank`: 1 to 10 across stories and more. Leave `note` empty when there's nothing to add."));
  });

  test('a password never shows, whatever else is wrong with the link', () => {
    const cases = [
      ['https://user:secret@exa mple.com/', 'must not have a user name or password before the site name (got "https://***@exa mple.com/")'],
      ['https:///user:secret@evil.example', 'must not have a user name or password before the site name (got "https://***@evil.example")'],
      ['https:///@evil.example', 'must not have a user name or password before the site name (got "https://***@evil.example")'],
      // Not user info to the URL parser (a raw / ends the site part), so it fails as a broken link; still hidden.
      ['https://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY@bucket.example.com/report', 'must be a whole link that starts with https://, with a site name and no spaces (got "https://***@bucket.example.com/report")'],
      ['http://user:pa#secret@example.com/', 'must start with https:// (got "http://***@example.com/")'],
      ['http://user:secret@example.com/', 'must start with https:// (got "http://***@example.com/")'],
      ['HTTPS://user:secret@example.com/', 'must start with https:// (got "HTTPS://***@example.com/")'],
      ['https:\\\\user:secret@evil.example', 'must start with https:// (got "***@evil.example")'],
      ['ssh://git:hunt\\er2secret@example.com/', 'must start with https:// (got "ssh://***@example.com/")'],
      ['Source: https://admin:secret@example.com/', 'must start with https:// (got "Source: https://***@example.com/")'],
      [`${String.fromCodePoint(0xfeff)}https://admin:secret@example.com/`, `must start with https:// (got "${escaped(0xfeff)}https://***@example.com/")`],
      [`${String.fromCodePoint(0x202e)}https://admin:secret@example.com/`, `must start with https:// (got "${escaped(0x202e)}https://***@example.com/")`],
    ];
    for (const [url, words] of cases) {
      const news = edition();
      news.stories[1].sources[0].url = url;
      const { errors } = validateNews(news);
      assert.deepEqual(errors, [`stories[1].sources[0].url: ${words}`], url);
      assert.ok(!/secret|hunt|K7MDENG|EXAMPLEKEY|AKIA/.test(errors[0]), errors[0]);
    }
  });

  test('user info is hidden in any quoted value, not only in links', () => {
    const news = edition();
    news.stories[0].region = 'https://admin:secret@example.com/';
    news.stories[1].region = 'admin:p/w@corp';
    assert.deepEqual(validateNews(news).errors, [
      'stories[0].region: must be one of "us", "china", "eu", "global", "other" (got "https://***@example.com/")',
      'stories[1].region: must be one of "us", "china", "eu", "global", "other" (got "***@corp")',
    ]);
  });

  test('a lookalike, numeric, local or one-word site name is refused', () => {
    const urls = [
      `https://evil.example${String.fromCodePoint(0x2215)}good.example/`,
      `https://${String.fromCodePoint(0x0435)}xample.com/`,
      'https://0x7f.1/',
      'https://127.0.0.1/',
      'https://localhost/',
      'https://wire.localhost/x',
      'https://newsroom/x',
    ];
    for (const url of urls) {
      const news = edition();
      news.stories[0].sources[0].url = url;
      assert.deepEqual(validateNews(news).errors, [`stories[0].sources[0].url: ${SITE_WORDS} (got ${JSON.stringify(url)})`], url);
    }
  });

  test('underscores and an empty port are fine in a site name', () => {
    const news = edition();
    news.stories[0].sources[0].url = 'https://my_bucket.s3.amazonaws.com/report.pdf';
    news.stories[0].sources[1].url = 'https://example.org:/wire/test-story-one';
    assert.deepEqual(validateNews(news), VALID);
  });

  test('a backslash, bidi or zero-width character in a link has its own message, and is escaped', () => {
    const news = edition();
    news.stories[0].sources[0].url = `https://example.com/${String.fromCodePoint(0x202e)}gnp.exe`;
    news.stories[0].sources[1].url = 'https://example.org/a\\b';
    news.stories[0].region = `us${String.fromCodePoint(0x200b, 0x9b)}`;
    assert.deepEqual(validateNews(news).errors, [
      `stories[0].region: must be one of "us", "china", "eu", "global", "other" (got "us${escaped(0x200b, 0x9b)}")`,
      `stories[0].sources[0].url: must not contain a backslash or hidden characters (percent-encode them, e.g. %E2%80%8C) (got "https://example.com/${escaped(0x202e)}gnp.exe")`,
      'stories[0].sources[1].url: must not contain a backslash or hidden characters (percent-encode them, e.g. %E2%80%8C) (got "https://example.org/a\\\\b")',
    ]);
  });

  // N2 review: invisible characters beyond the old hand-made list (tag characters, soft hyphen,
  // invisible operators, Hangul fillers) go by Unicode property now.
  test('a text field of only invisible characters counts as empty, and they are escaped by code point', () => {
    for (const points of [[0x200b], [0xad], [0x2061, 0x2064], [0xe0041, 0xe0042], [0x3164], [0x200d, 0xfe0f]]) {
      const news = edition();
      news.stories[0].skeptic = String.fromCodePoint(...points);
      assert.deepEqual(validateNews(news).errors, [`stories[0].skeptic: must not be empty or only spaces (got "${escaped(...points)}")`], escaped(...points));
    }
    const news = edition();
    news.stories[0].skeptic = `${String.fromCodePoint(0x200b)}A fair critique.`;
    assert.deepEqual(validateNews(news), VALID, 'one visible character is enough');
  });

  // N2 review: text can look blank without being invisible: braille blank, combining marks alone,
  // a null notehead, private-use characters, a Khitan filler.
  test('a text field that only looks blank counts as empty too', () => {
    const raw = (...points) => String.fromCodePoint(...points);
    const cases = [
      [[0x2800], raw(0x2800)],
      [[0x300, 0x301], raw(0x300, 0x301)],
      [[0x1d159], raw(0x1d159)],
      [[0xe000], raw(0xe000)],
      [[0x16fe4], raw(0x16fe4)],
      [[0x20, 0x2800, 0x300], raw(0x20, 0x2800, 0x300)],
      [[0xffa0, 0x115f, 0x1160], escaped(0xffa0, 0x115f, 0x1160)], // default-ignorable, so escaped when quoted
    ];
    for (const [points, shown] of cases) {
      const news = edition();
      news.stories[0].why = String.fromCodePoint(...points);
      assert.deepEqual(validateNews(news).errors, [`stories[0].why: must not be empty or only spaces (got "${shown}")`], escaped(...points));
    }
    const news = edition();
    news.stories[0].why = `Caf${String.fromCodePoint(0x65, 0x301)} chains matter.`;
    news.stories[0].headline = `${String.fromCodePoint(0x2800)}A real headline`;
    assert.deepEqual(validateNews(news), VALID, 'marks on letters and one visible character are fine');
  });

  test('a note of only invisible characters does not explain fewer than 3 stories', () => {
    const news = edition();
    news.stories.pop();
    news.note = String.fromCodePoint(0x200b, 0xfeff);
    assert.deepEqual(validateNews(news).errors, ['note: must say why there are fewer than 3 stories (stories has 2)']);
  });

  test('more with 100,000 empty objects fails in well under a second', () => {
    const news = edition();
    news.more = Array.from({ length: 100_000 }, () => ({}));
    const started = performance.now();
    const { ok, errors } = validateNews(news);
    assert.ok(performance.now() - started < 1000, 'well under a second');
    assert.equal(ok, false);
    assert.deepEqual(errors, ['more: far too long (100000 stories); at most 7 allowed (leave the weakest out), so nothing else was checked']);
  });

  test('far too long stories, sources, or breaking sources fail at once too', () => {
    const started = performance.now();
    const stories = edition();
    stories.stories = Array.from({ length: 100_000 }, () => ({}));
    assert.deepEqual(validateNews(stories).errors, ['stories: far too long (100000 stories); at most 3 allowed (the top 3 go in stories, up to 7 more in more), so nothing else was checked']);

    const sources = edition();
    sources.more[1].sources = Array.from({ length: 100_000 }, () => ({}));
    assert.deepEqual(validateNews(sources).errors, ['more[1].sources: far too long (100000 sources); at most 8 allowed (keep the 8 strongest), so nothing else was checked']);

    const story = breaking();
    story.sources = Array.from({ length: 100_000 }, () => ({}));
    assert.deepEqual(validateBreaking(story).errors, ['sources: far too long (100000 sources); at most 8 allowed (keep the 8 strongest), so nothing else was checked']);
    assert.ok(performance.now() - started < 1000, 'well under a second for all three');
  });

  test('a list just under the guard is checked normally, and at most 100 problems are listed', () => {
    const news = edition();
    news.more = Array.from({ length: 50 }, () => ({}));
    const { errors } = validateNews(news);
    assert.equal(MAX_ERRORS, 100);
    assert.equal(errors.length, 100);
    assert.equal(errors[0], 'more: can have at most 7 stories (has 50); leave the weakest out');
    assert.equal(new Set(errors).size, errors.length, 'each line once');
  });
});
