// The pieces both desk contracts share (server/schema-common.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { hasUserInfo, hideUserInfo, isDateTime, linkKey, linkProblem, plain, readablePath, show, withoutSample } from '../server/schema-common.js';

describe('schema-common', () => {
  test('isDateTime wants a real moment with a timezone', () => {
    for (const ok of ['2026-12-07T12:04:00-05:00', '2026-12-07T17:04:00Z', '2026-12-07T12:04Z', '2028-02-29T00:00:00.5+00:00', '2026-12-31T23:59:59+14:00']) {
      assert.equal(isDateTime(ok), true, ok);
    }
    for (const bad of ['2026-12-07T12:04:00', '2026-12-07', '2026-02-29T12:00:00Z', '2026-12-07T24:00Z', '2026-12-07T12:04:00+15:00', 1765127040000, null]) {
      assert.equal(isDateTime(bad), false, String(bad));
    }
  });

  test('hasUserInfo looks only before the site name', () => {
    assert.equal(hasUserInfo('https://user@example.com/'), true);
    assert.equal(hasUserInfo('https://user:pw@example.com/'), true);
    assert.equal(hasUserInfo('https://:pw@example.com/'), true);
    assert.equal(hasUserInfo('https://@example.com/'), true);
    assert.equal(hasUserInfo('https://example.com/@snow'), false);
    assert.equal(hasUserInfo('https://example.com?by=a@b'), false);
    assert.equal(hasUserInfo('https://example.com#a@b'), false);
    assert.equal(hasUserInfo('https:///@example.com/'), true, 'a run of slashes is skipped, as a browser does');
    assert.equal(hasUserInfo('https:\\\\u:p@example.com/'), true, 'backslashes too');
    assert.equal(hasUserInfo('http://user@example.com/'), true, 'any scheme');
  });

  test('hideUserInfo hides everything before the site\'s last @, for any scheme, and leaves other links alone', () => {
    const cases = {
      'https://user:pw@example.com/a': 'https://***@example.com/a',
      'https:///user:pw@example.com': 'https:///***@example.com',
      'https:\\\\user:pw@example.com': 'https:\\\\***@example.com',
      'https:user:pw@example.com': 'https:***@example.com',
      'HTTP://u:pw@example.com': 'HTTP://***@example.com',
      'javascript://u:pw@x/': 'javascript://***@x/',
      '  https://u:pw@example.com': '  https://***@example.com',
      'https://us\ner:p\tw@example.com/': 'https://***@example.com/',
      'https://a@b:pw@example.com/x?y=@z': 'https://***@example.com/x?y=@z',
      'https://example.com/@snow': 'https://example.com/@snow',
      'https://example.com?by=a@b': 'https://example.com?by=a@b',
    };
    for (const [link, hidden] of Object.entries(cases)) assert.equal(hideUserInfo(link), hidden, JSON.stringify(link));
    assert.equal(hideUserInfo(42), 42);
  });

  test('hideUserInfo is linear: a 1 MB link of spaces or letters costs milliseconds', () => {
    const started = performance.now();
    hideUserInfo(' '.repeat(1_000_000));
    hideUserInfo(`https://${'a'.repeat(1_000_000)}`);
    hideUserInfo(`${'a'.repeat(1_000_000)}:`);
    assert.ok(performance.now() - started < 500);
  });

  test('show and plain escape C0 and C1 controls, DEL, bidi and zero-width characters', () => {
    const nasty = 'a\u001b[31m\u007f\u0085\u009b\u061c\u200b\u200e\u202a\u202e\u2028\u2066\u2069\ufeffz';
    const quoted = show(nasty, 500);
    assert.doesNotMatch(quoted, /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/);
    assert.equal(quoted, '"a\\u001b[31m\\u007f\\u0085\\u009b\\u061c\\u200b\\u200e\\u202a\\u202e\\u2028\\u2066\\u2069\\ufeffz"');
    assert.doesNotMatch(plain(nasty), /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/);
    assert.equal(show('caf\u00e9 \u2215'), '"caf\u00e9 \u2215"', 'ordinary non-ASCII text stays readable');
  });

  test('linkKey is the page a link opens, without its #fragment', () => {
    assert.equal(linkKey('https://EXAMPLE.com:443/a#top'), 'https://example.com/a');
    assert.equal(linkKey('https://example.com'), 'https://example.com/');
    assert.notEqual(linkKey('https://example.com/a?x=1'), linkKey('https://example.com/a?x=2'));
  });

  test('linkProblem leaves non-https links to the schema, so each link gets one line', () => {
    assert.equal(linkProblem('http://example.com'), null);
    assert.equal(linkProblem('javascript:alert(1)'), null);
    assert.equal(linkProblem(undefined), null);
    assert.equal(linkProblem('https://example.com/ok'), null);
    assert.match(linkProblem('https:// evil'), /^must be a whole link/);
    assert.match(linkProblem('https://0x7f.1/'), /^must name its site in plain letters/);
    assert.match(linkProblem('https://user:pw@exa mple.com'), /^must not have a user name or password/, 'user info is checked first');
    assert.equal(linkProblem('https://me:hunter2@example.com/a?b=c'), 'must not have a user name or password before the site name (got "https://***@example.com/a?b=c")');
  });

  test('withoutSample is defined once, here, and the Product Feed loader uses it', () => {
    const serverDir = path.join(REPO_ROOT, 'server');
    const definitions = fs.readdirSync(serverDir).filter((name) => name.endsWith('.js') && /function withoutSample\b/.test(fs.readFileSync(path.join(serverDir, name), 'utf8')));
    assert.deepEqual(definitions, ['schema-common.js']);
    assert.match(fs.readFileSync(path.join(serverDir, 'feed.js'), 'utf8'), /import \{ withoutSample \} from '\.\/schema-common\.js'/);
  });

  test('withoutSample drops only the "sample" key and leaves the original alone', () => {
    const original = { desk: 'news', sample: true, stories: [] };
    assert.deepEqual(withoutSample(original), { desk: 'news', stories: [] });
    assert.equal(original.sample, true);
  });

  test('readablePath names the root and turns pointers into dotted paths', () => {
    assert.equal(readablePath('', 'breaking'), 'breaking');
    assert.equal(readablePath('/stories/1/sources/0/url', 'news'), 'stories[1].sources[0].url');
    assert.equal(readablePath('/a~1b/c~0d', 'news'), 'a/b.c~d');
  });
});
