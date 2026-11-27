import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { SAMPLE_FEED_PATH } from '../server/config.js';
import { checkFeedFile, validateFeed } from '../server/feed-schema.js';

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
    fs.writeFileSync(file, `﻿${fs.readFileSync(SAMPLE_FEED_PATH, 'utf8')}`);
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
