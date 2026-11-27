// The `npm run validate-news` command, run as a separate process the way the News agent runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { NPM_CLI, runNpm as runNpmScript } from './helpers/npm.js';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'validate-news.js');
const NEWS_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'news', 'news.json');
const BREAKING_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'news', 'breaking.json');

const edition = () => JSON.parse(fs.readFileSync(NEWS_FIXTURE, 'utf8'));
const breaking = () => JSON.parse(fs.readFileSync(BREAKING_FIXTURE, 'utf8'));

function run(args, env = {}) {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.npm_lifecycle_event;
  delete cleanEnv.INIT_CWD;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, env: cleanEnv, encoding: 'utf8' });
}

/** `npm run validate-news -- <args>`, typed in `cwd`, the way the agent runs it. */
const runNpm = (args, options) => runNpmScript('validate-news', args, options);

describe('npm run validate-news', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-news-cli-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return file;
  };

  test('prints "valid" and exits 0 for a good edition', () => {
    const r = run([NEWS_FIXTURE]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'valid\n');
    assert.equal(r.stderr, '');
  });

  test('prints "valid" and exits 0 for a good breaking story', () => {
    const r = run([BREAKING_FIXTURE]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'valid\n');
  });

  test('accepts a path relative to where it is run', () => {
    const r = run(['test/fixtures/news/news.json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'valid\n');
  });

  test('lists each problem with its place and exits 1 for a broken edition', () => {
    const news = edition();
    news.stories[1].sources = news.stories[1].sources.slice(0, 1);
    news.stories[2].skeptic = '  ';
    news.more[0].sources[0].url = 'http://example.org/wire/test-shelf-one';
    news.more[1].id = 's1';
    const file = write('broken-edition.json', news);

    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(
      r.stderr,
      `invalid: ${file}\n` +
        '  - stories[1].sources: needs at least 2 sources (has 1)\n' +
        '  - stories[2].skeptic: must not be empty or only spaces (got "  ")\n' +
        '  - more[0].sources[0].url: must start with https:// (got "http://example.org/wire/test-shelf-one")\n' +
        '  - more[1].id: duplicate id "s1" (also used by stories[0])\n',
    );
  });

  test('says a broken breaking story was checked as one, and exits 1', () => {
    const story = breaking();
    story.at = '2026-12-07 noon';
    story.sources[1].url = 'https://user@example.org/wire/test-breaking';
    const file = write('breaking.json', story);

    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `invalid: ${file} (checked as a breaking story)\n` +
        '  - at: must be a date and time with a timezone, like 2026-12-07T12:04:00-05:00 or 2026-12-07T17:04:00Z (got "2026-12-07 noon")\n' +
        '  - sources[1].url: must not have a user name or password before the site name (got "https://***@example.org/wire/test-breaking")\n',
    );
  });

  test('a file with "at" is checked as a breaking story whatever its name', () => {
    const ok = run([write('found-at-noon.json', breaking())]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'valid\n');

    const file = write('news-with-at.json', { ...edition(), at: '2026-12-07T05:30:00-05:00' });
    const bad = run([file]);
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.startsWith(`invalid: ${file} (checked as a breaking story)\n`), bad.stderr);
  });

  test('several files: names each one, and exits 1 if any fails', () => {
    const both = run([NEWS_FIXTURE, BREAKING_FIXTURE]);
    assert.equal(both.status, 0, both.stderr);
    assert.equal(both.stdout, `valid: ${NEWS_FIXTURE}\nvalid: ${BREAKING_FIXTURE}\n`);

    const news = edition();
    news.stories.push({ ...news.more[0], id: 's4', rank: 9 });
    const bad = write('four-stories.json', news);
    const mixed = run([NEWS_FIXTURE, bad]);
    assert.equal(mixed.status, 1);
    assert.equal(mixed.stdout, `valid: ${NEWS_FIXTURE}\n`);
    assert.equal(mixed.stderr, `invalid: ${bad}\n  - stories: can have at most 3 stories (has 4); the top 3 go in stories, up to 7 more in more\n`);
  });

  test('exits 1 with a clear message when the file is missing', () => {
    const file = path.join(dir, 'missing.json');
    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `invalid: ${file}\n  - file not found\n`);
  });

  test('exits 1 for broken JSON', () => {
    const r = run([write('broken.json', '{"desk": "news",')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  });

  test('with no file, checks $DESK_HOME/desks/news/news.json, and breaking.json when it exists', () => {
    const deskHome = path.join(dir, 'agent-house');
    const live = path.join(deskHome, 'desks', 'news', 'news.json');
    const live2 = path.join(deskHome, 'desks', 'news', 'breaking.json');
    fs.mkdirSync(path.dirname(live), { recursive: true });

    const none = run([], { DESK_HOME: deskHome });
    assert.equal(none.status, 1);
    assert.equal(none.stderr, `invalid: ${live}\n  - file not found\n`, 'no breaking.json is fine: only news.json is checked');

    fs.copyFileSync(NEWS_FIXTURE, live);
    const newsOnly = run([], { DESK_HOME: deskHome });
    assert.equal(newsOnly.status, 0, newsOnly.stderr);
    assert.equal(newsOnly.stdout, 'valid\n');

    fs.copyFileSync(BREAKING_FIXTURE, live2);
    const both = run([], { DESK_HOME: deskHome });
    assert.equal(both.status, 0, both.stderr);
    assert.equal(both.stdout, `valid: ${live}\nvalid: ${live2}\n`);

    fs.writeFileSync(live2, JSON.stringify({ ...breaking(), at: undefined }));
    const badBreaking = run([], { DESK_HOME: deskHome });
    assert.equal(badBreaking.status, 1);
    assert.equal(badBreaking.stdout, `valid: ${live}\n`);
    assert.equal(badBreaking.stderr, `invalid: ${live2} (checked as a breaking story)\n  - breaking: missing required field "at"\n`);
  });

  test('caps a long list of problems', () => {
    const news = edition();
    news.more = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}` }));
    const r = run([write('many.json', news)]);
    assert.equal(r.status, 1);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 22); // header + 20 problems + "and N more"
    assert.match(lines.at(-1), /^ {2}…and \d+ more$/);
  });

  test('--help prints the usage and exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: npm run validate-news /);
    assert.match(r.stdout, /breaking story/);
  });

  test('an unknown option prints the usage and exits 1', () => {
    const r = run(['--fix', NEWS_FIXTURE]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Usage: npm run validate-news /);
    assert.match(r.stderr, /Unknown option: "--fix"/);
  });

  test('quotes untrusted text safely: nothing from the file reaches the terminal raw', () => {
    const news = edition();
    news.stories[0].sources[0].url = 'http://example.com/\u001b]0;pwned\u0007';
    news.stories[0].region = '\u001b[31mred';
    const r = run([write('escapes.json', news)]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim().split('\n').length, 3, 'both values are reported');
    assert.doesNotMatch(r.stderr, /[\u0000-\u0009\u000b-\u001f\u007f]/, 'no control characters besides newlines');
    assert.ok(r.stderr.includes('\\u001b]0;pwned\\u0007'));
  });

  test('through npm: the agent\'s command works, and validate-feed still does too', { skip: !NPM_CLI && 'npm not found' }, () => {
    const deskHome = path.join(dir, 'npm-house');
    const live = path.join(deskHome, 'desks', 'news', 'news.json');
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.copyFileSync(NEWS_FIXTURE, live);

    const explicit = runNpm([live]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.stdout, /^valid$/m);

    const implicit = runNpm([], { env: { DESK_HOME: deskHome } });
    assert.equal(implicit.status, 0, implicit.stderr);
    assert.match(implicit.stdout, /^valid$/m);

    const news = edition();
    news.stories[0].sources[0].url = 'javascript:alert(1)';
    fs.writeFileSync(live, JSON.stringify(news));
    const bad = runNpm([], { env: { DESK_HOME: deskHome } });
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes(`invalid: ${live}\n  - stories[0].sources[0].url: must start with https:// (got "javascript:alert(1)")`), bad.stderr);

    const fromSubfolder = runNpm(['fixtures/news/breaking.json'], { cwd: path.join(REPO_ROOT, 'test') });
    assert.equal(fromSubfolder.status, 0, fromSubfolder.stderr);
    assert.match(fromSubfolder.stdout, /^valid$/m);

    const feed = runNpmScript('validate-feed', ['prototype/feed.json']);
    assert.equal(feed.status, 0, feed.stderr);
    assert.match(feed.stdout, /^valid$/m);
  });
});
