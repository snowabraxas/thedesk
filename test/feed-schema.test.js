import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SAMPLE_FEED_PATH } from '../server/config.js';
import { checkFeedFile, isCalendarDate, isHttpsLink, validateFeed } from '../server/feed-schema.js';

const sample = () => JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));

describe('validateFeed', () => {
  test('accepts prototype/feed.json', () => {
    const result = validateFeed(sample());
    assert.deepEqual(result, { ok: true, errors: [] });
  });

  // S3 rule: every article URL must start with https://.
  test('rejects an article url that is not https', () => {
    const feed = sample();
    feed.articles[1].url = 'http://example.com/post';
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, ['articles[1].url: must start with https:// (got "http://example.com/post")']);
  });

  test('the https:// rule applies to every article, and https:// passes', () => {
    const feed = sample();
    for (const article of feed.articles) assert.match(article.url, /^https:\/\//);
    feed.articles.forEach((article) => {
      article.url = article.url.replace(/^https:/, 'http:');
    });
    const { errors } = validateFeed(feed);
    assert.equal(errors.length, feed.articles.length);
    errors.forEach((line, i) => assert.match(line, new RegExp(`^articles\\[${i}\\]\\.url: must start with https://`)));
  });

  test('rejects javascript: and data: urls', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>hi</b>', ' https://example.com', 'HTTPS://example.com']) {
      const feed = sample();
      feed.articles[0].url = url;
      assert.equal(validateFeed(feed).ok, false, `should reject ${url}`);
    }
  });

  test('rejects https:// links that are not whole links: no site, spaces, a backslash or hidden characters', () => {
    const bad = {
      'https://': 'https://',
      'https:// evil': 'https:// evil',
      'https://exa mple.com/post': 'https://exa mple.com/post',
      'https://example.com/a b': 'https://example.com/a b',
      'https://example.com/a\tb': 'https://example.com/a\\tb',
      'https://example.com/ ': 'https://example.com/ ',
      'https://example.com/\u0000x': 'https://example.com/\\u0000x',
      'https://:443/': 'https://:443/',
      'https:///example.com': 'https:///example.com',
      'https://example.com\\@evil.example/': 'https://example.com\\\\@evil.example/',
      'https://example.com/\u202ex': 'https://example.com/\\u202ex',
      'https://exa\u200bmple.com/': 'https://exa\\u200bmple.com/',
    };
    for (const [url, shown] of Object.entries(bad)) {
      const feed = sample();
      feed.articles[2].url = url;
      assert.deepEqual(
        validateFeed(feed).errors,
        [`articles[2].url: must be a whole link that starts with https://, with a site name and no spaces (got "${shown}")`],
        `should reject ${JSON.stringify(url)}`,
      );
    }
  });

  test('accepts whole https:// links, including query, fragment, port, capitals, a trailing dot and punycode site names', () => {
    for (const url of ['https://example.com', 'https://example.com/p?q=1&r=a%20b#part', 'https://example.com:8443/x', 'https://xn--bcher-kva.de/', 'https://localhost/x', 'https://Example.COM/x', 'https://example.com./x']) {
      const feed = sample();
      feed.articles[0].url = url;
      assert.deepEqual(validateFeed(feed), { ok: true, errors: [] }, url);
    }
  });

  // N2 review: the site the browser opens must be the site as written.
  test('rejects lookalike, non-ASCII, percent-encoded and numeric site names, and IP addresses', () => {
    const words = 'must name its site in plain letters, digits, dots and dashes (xn-- for other alphabets), not as an IP address';
    const cases = {
      'https://evil.example∕good.example/': 'https://evil.example∕good.example/',
      'https://evil.example⁄good.example/': 'https://evil.example⁄good.example/',
      'https://ｅxample.com/': 'https://ｅxample.com/',
      'https://еxample.com/': 'https://еxample.com/',
      'https://bücher.de/': 'https://bücher.de/',
      'https://ex%61mple.com/': 'https://ex%61mple.com/',
      'https://0x7f.1/': 'https://0x7f.1/',
      'https://2130706433/': 'https://2130706433/',
      'https://127.0.0.1/': 'https://127.0.0.1/',
      'https://[::1]/': 'https://[::1]/',
    };
    for (const [url, shown] of Object.entries(cases)) {
      const feed = sample();
      feed.articles[0].url = url;
      assert.deepEqual(validateFeed(feed).errors, [`articles[0].url: ${words} (got "${shown}")`], url);
    }
  });

  // Sprint 1 follow-up, done in N2: a link may not carry a user name or password before the site name.
  test('rejects links with a user name or password in them, and never prints the password', () => {
    const cases = {
      'https://user@example.com/post': 'https://***@example.com/post',
      'https://user:secret@example.com/post': 'https://***@example.com/post',
      'https://:secret@example.com/': 'https://***@example.com/',
      'https://@example.com/': 'https://***@example.com/',
      'https://@/': 'https://***@/',
      'https://a@b@example.com/': 'https://***@example.com/',
      'https://user%40x@example.com/': 'https://***@example.com/',
      // N2 review: the parser skips any run of / and \ after "https:", and drops tabs and newlines.
      'https:///user:secret@evil.example': 'https:///***@evil.example',
      'https:///@evil.example': 'https:///***@evil.example',
      'https://us\ner:secret@evil.example/': 'https://***@evil.example/',
      // N2 review: user info is checked first, so a link that is also broken still hides it.
      'https://user:secret@exa mple.com/': 'https://***@exa mple.com/',
      'https://user:secret@example.com:99999/': 'https://***@example.com:99999/',
      'https://user:secret@0x7f.1/': 'https://***@0x7f.1/',
    };
    for (const [url, shown] of Object.entries(cases)) {
      const feed = sample();
      feed.articles[1].url = url;
      const { ok, errors } = validateFeed(feed);
      assert.equal(ok, false, url);
      assert.deepEqual(errors, [`articles[1].url: must not have a user name or password before the site name (got "${shown}")`], url);
      assert.ok(!errors[0].includes('secret'), 'the password is hidden');
    }
  });

  test('a link that fails the https:// pattern still never prints a password', () => {
    const cases = {
      'http://user:secret@example.com/': 'http://***@example.com/',
      'HTTPS://user:secret@example.com/': 'HTTPS://***@example.com/',
      'https:\\\\user:secret@evil.example': 'https:\\\\\\\\***@evil.example',
      'javascript://user:secret@x/': 'javascript://***@x/',
    };
    for (const [url, shown] of Object.entries(cases)) {
      const feed = sample();
      feed.articles[1].url = url;
      const { errors } = validateFeed(feed);
      assert.deepEqual(errors, [`articles[1].url: must start with https:// (got "${shown}")`], url);
      assert.ok(!errors[0].includes('secret'));
    }
  });

  test('an @ after the site name is fine: profile pages and queries', () => {
    for (const url of ['https://example.com/@snow', 'https://example.com/p?by=a@b.com', 'https://example.com/#@top']) {
      const feed = sample();
      feed.articles[0].url = url;
      assert.deepEqual(validateFeed(feed), { ok: true, errors: [] }, url);
    }
  });

  test('an http:// link gets one line, not two', () => {
    const feed = sample();
    feed.articles[0].url = 'http:// evil';
    assert.deepEqual(validateFeed(feed).errors, ['articles[0].url: must start with https:// (got "http:// evil")']);
  });

  test('rejects an edition date that is not on the calendar', () => {
    for (const edition of ['2026-02-30', '2026-13-45', '2026-02-29', '2026-04-31', '2026-00-10', '2026-01-00', '1900-02-29']) {
      const feed = sample();
      feed.edition = edition;
      assert.deepEqual(validateFeed(feed).errors, [`edition: must be a real calendar date like YYYY-MM-DD (got "${edition}")`], edition);
    }
  });

  test('accepts real edition dates, leap days included', () => {
    for (const edition of ['2026-11-27', '2028-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) {
      const feed = sample();
      feed.edition = edition;
      assert.deepEqual(validateFeed(feed), { ok: true, errors: [] }, edition);
    }
  });

  test('rejects an article date that is not on the calendar; an empty date is still fine', () => {
    const feed = sample();
    feed.articles[0].date = '2026-13-45';
    feed.articles[1].date = '2026-02-30';
    feed.articles[2].date = '';
    feed.articles[3].date = '2028-02-29';
    assert.deepEqual(validateFeed(feed).errors, [
      'articles[0].date: must be a real calendar date like YYYY-MM-DD, or empty (got "2026-13-45")',
      'articles[1].date: must be a real calendar date like YYYY-MM-DD, or empty (got "2026-02-30")',
    ]);
  });

  test('a date in the wrong shape gets the pattern line only', () => {
    const feed = sample();
    feed.articles[0].date = '30 Feb 2026';
    assert.deepEqual(validateFeed(feed).errors, ['articles[0].date: must be a date like YYYY-MM-DD, or empty (got "30 Feb 2026")']);
  });

  test('rejects an article missing a required field', () => {
    const feed = sample();
    delete feed.articles[0].summary;
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, ['articles[0]: missing required field "summary"']);
  });

  test('rejects a feed missing a top-level field', () => {
    const feed = sample();
    delete feed.articles;
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, ['feed: missing required field "articles"']);
  });

  test('rejects duplicate article ids and names both places', () => {
    const feed = sample();
    feed.articles[3].id = feed.articles[0].id;
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, [`articles[3].id: duplicate id "${feed.articles[0].id}" (also used by articles[0])`]);
  });

  test('rejects duplicate theme ids and names both places', () => {
    const feed = sample();
    feed.themes.push({ id: 'evals', name: 'Evals, again' });
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, [`themes[${feed.themes.length - 1}].id: duplicate id "evals" (also used by themes[0])`]);
  });

  test('rejects an article theme that is not in the themes list, and says how to fix it', () => {
    const feed = sample();
    feed.articles[2].themes = ['pm-role', 'pricing'];
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, ['articles[2].themes[1]: "pricing" is not in the themes list (add it to themes first, or use one that is)']);
  });

  test('accepts a new theme once it is added to the themes list', () => {
    const feed = sample();
    feed.themes.push({ id: 'pricing', name: 'Pricing' });
    feed.articles[2].themes = ['pm-role', 'pricing'];
    assert.deepEqual(validateFeed(feed), { ok: true, errors: [] });
  });

  test('a missing themes list is reported once, not once per article theme', () => {
    const feed = sample();
    delete feed.themes;
    assert.deepEqual(validateFeed(feed).errors, ['feed: missing required field "themes"']);
  });

  test('says how long a value is, and what an id may hold', () => {
    const feed = sample();
    feed.articles[0].summary = 'Too short.';
    feed.articles[1].why = 'y'.repeat(201);
    feed.articles[2].title = '';
    feed.themes.push({ id: 'Pricing Two', name: 'Pricing' });
    assert.deepEqual(validateFeed(feed).errors, [
      `themes[${feed.themes.length - 1}].id: must be 1 to 40 lowercase letters, digits or dashes (got "Pricing Two")`,
      'articles[0].summary: must be at least 20 characters (it has 10)',
      'articles[1].why: must be at most 200 characters (it has 201)',
      'articles[2].title: must not be empty',
    ]);
  });

  test('says how many articles there are when there are too many or none', () => {
    const feed = sample();
    feed.articles = Array.from({ length: 13 }, (_, i) => ({ ...sample().articles[0], id: `a${i}` }));
    assert.deepEqual(validateFeed(feed).errors, ['articles: must have at most 12 items (it has 13)']);
    feed.articles = [];
    assert.deepEqual(validateFeed(feed).errors, ['articles: must not be empty']);
  });

  test('lists every problem, not just the first', () => {
    const feed = sample();
    feed.desk = 'other-desk';
    feed.edition = '27 Nov';
    feed.articles[0].url = 'http://example.com';
    feed.articles[1].minutes = 0;
    const { ok, errors } = validateFeed(feed);
    assert.equal(ok, false);
    assert.deepEqual(errors, [
      'desk: must be "product-feed"',
      'edition: must be a date like YYYY-MM-DD (got "27 Nov")',
      'articles[0].url: must start with https:// (got "http://example.com")',
      'articles[1].minutes: must be >= 1',
    ]);
  });

  // N2 review: JSON.stringify leaves C1 controls, bidi and zero-width characters raw.
  test('escapes C1 controls, bidi and zero-width characters in quoted values', () => {
    const feed = sample();
    feed.edition = 'x\u009b31m\u0085\u202e\u200b\u2066\u2028\u061c\ufeff';
    const [line] = validateFeed(feed).errors;
    assert.equal(line, 'edition: must be a date like YYYY-MM-DD (got "x\\u009b31m\\u0085\\u202e\\u200b\\u2066\\u2028\\u061c\\ufeff")');
  });

  // N2 review: ajv runs with allErrors, so a huge list used to take minutes.
  test('refuses far too long articles or themes lists at once, before the schema runs', () => {
    const articles = sample();
    articles.articles = Array.from({ length: 100_000 }, () => ({}));
    let started = performance.now();
    assert.deepEqual(validateFeed(articles).errors, ['articles: far too long (100000 articles); at most 12 allowed, so nothing else was checked']);
    assert.ok(performance.now() - started < 1000, 'well under a second');

    const themes = sample();
    themes.themes = Array.from({ length: 100_000 }, () => ({}));
    started = performance.now();
    assert.deepEqual(validateFeed(themes).errors, ['themes: far too long (100000 themes); at most 50 allowed, so nothing else was checked']);
    assert.ok(performance.now() - started < 1000, 'well under a second');
  });

  test('lists at most 100 problems', () => {
    const feed = sample();
    feed.articles = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, url: 'http://example.com', title: '', source: '', themes: [], summary: '', why: '', minutes: 0, date: 'x' }));
    feed.themes = Array.from({ length: 50 }, (_, i) => ({ id: 'Bad Id', name: '' }));
    const { errors } = validateFeed(feed);
    assert.equal(errors.length, 100);
    assert.equal(new Set(errors).size, 100, 'each line once');
  });

  test('quotes untrusted values safely and keeps them short', () => {
    const feed = sample();
    feed.articles[0].url = `http://example.com/\u001b[31m${'x'.repeat(200)}`;
    const [line] = validateFeed(feed).errors;
    assert.ok(!line.includes('\u001b'), 'control characters are escaped');
    assert.ok(line.includes('\\u001b'));
    assert.ok(line.length < 140, 'long values are cut short');
  });

  test('rejects things that are not a JSON object', () => {
    for (const value of [null, [], 'feed', 42, undefined]) {
      assert.deepEqual(validateFeed(value), { ok: false, errors: ['feed: must be a JSON object'] });
    }
  });
});

describe('isCalendarDate and isHttpsLink', () => {
  test('isCalendarDate knows month lengths and leap years', () => {
    assert.equal(isCalendarDate('2026-11-27'), true);
    assert.equal(isCalendarDate('2024-02-29'), true);
    assert.equal(isCalendarDate('2400-02-29'), true);
    assert.equal(isCalendarDate('2100-02-29'), false);
    assert.equal(isCalendarDate('2026-06-31'), false);
    assert.equal(isCalendarDate('2026-6-30'), false);
    assert.equal(isCalendarDate(''), false);
    assert.equal(isCalendarDate(20261127), false);
  });

  test('isHttpsLink wants https, a site name and no spaces', () => {
    assert.equal(isHttpsLink('https://example.com/post'), true);
    assert.equal(isHttpsLink('http://example.com/post'), false);
    assert.equal(isHttpsLink('https://'), false);
    assert.equal(isHttpsLink('https:// evil'), false);
    assert.equal(isHttpsLink('https://example.com/\n'), false);
    assert.equal(isHttpsLink(' https://example.com'), false);
    assert.equal(isHttpsLink(null), false);
  });

  test('isHttpsLink refuses a user name or password, and allows an @ in the path', () => {
    assert.equal(isHttpsLink('https:///@example.com/'), false);
    assert.equal(isHttpsLink('https://user@example.com/'), false);
    assert.equal(isHttpsLink('https://user:pw@example.com/'), false);
    assert.equal(isHttpsLink('https://@example.com/'), false);
    assert.equal(isHttpsLink('https://example.com/@snow'), true);
  });
});

describe('checkFeedFile', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-feed-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('reads and accepts a valid file, returning the feed', async () => {
    const result = await checkFeedFile(SAMPLE_FEED_PATH);
    assert.equal(result.ok, true);
    assert.equal(result.feed.desk, 'product-feed');
  });

  test('accepts a file that starts with a byte-order mark', async () => {
    const file = path.join(dir, 'bom.json');
    fs.writeFileSync(file, `\ufeff${fs.readFileSync(SAMPLE_FEED_PATH, 'utf8')}`);
    assert.equal((await checkFeedFile(file)).ok, true);
  });

  test('reports a missing file', async () => {
    const file = path.join(dir, 'nope.json');
    assert.deepEqual(await checkFeedFile(file), { ok: false, errors: [`${file}: file not found`] });
  });

  test('reports broken JSON', async () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{"desk": "product-feed",');
    const { ok, errors } = await checkFeedFile(file);
    assert.equal(ok, false);
    assert.match(errors[0], /not valid JSON/);
  });

  test('a JSON error that quotes the file passes no control characters through', async () => {
    const file = path.join(dir, 'escape.json');
    fs.writeFileSync(file, `\u001b[31mred\u0007\n${'x'.repeat(400)}`);
    const { errors } = await checkFeedFile(file);
    assert.match(errors[0], /not valid JSON/);
    assert.doesNotMatch(errors[0], /[\u0000-\u001f\u007f-\u009f]/);
    assert.ok(errors[0].includes('\\u001b'));
  });

  test('refuses a file over the size limit without reading it', async () => {
    const file = path.join(dir, 'big.json');
    fs.writeFileSync(file, 'x'.repeat(2048));
    const { ok, errors } = await checkFeedFile(file, { maxBytes: 1024 });
    assert.equal(ok, false);
    assert.match(errors[0], /too big/);
  });

  test('does not return the feed when it is invalid', async () => {
    const file = path.join(dir, 'invalid.json');
    const feed = sample();
    feed.articles[0].url = 'http://example.com';
    fs.writeFileSync(file, JSON.stringify(feed));
    const result = await checkFeedFile(file);
    assert.equal(result.ok, false);
    assert.equal(result.feed, undefined);
  });
});
