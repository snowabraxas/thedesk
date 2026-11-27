// The pieces both desk contracts share (server/schema-common.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { hasUserInfo, hideUserInfo, isBlank, isDateTime, linkKey, linkProblem, plain, readablePath, show, withoutSample } from '../server/schema-common.js';

/** How a message writes a hidden character: \u00ad, or \u{e0041} beyond the BMP. */
const escaped = (...points) => points.map((p) => (p > 0xffff ? `\\u{${p.toString(16)}}` : `\\u${p.toString(16).padStart(4, '0')}`)).join('');

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

  // N2 review: hidden anywhere in the value, split only at / ? #, never stopping at a backslash.
  test('hideUserInfo hides everything before the last @ in each piece between / ? and #, anywhere in the value', () => {
    const cases = {
      'https://user:pw@example.com/a': 'https://***@example.com/a',
      'https:///user:pw@example.com': 'https:///***@example.com',
      'https:\\\\user:pw@example.com': '***@example.com',
      'https:user:pw@example.com': '***@example.com',
      'HTTP://u:pw@example.com': 'HTTP://***@example.com',
      'javascript://u:pw@x/': 'javascript://***@x/',
      'ssh://git:hunt\\er2@example.com/': 'ssh://***@example.com/',
      '  https://u:pw@example.com': '  https://***@example.com',
      'https://us\ner:p\tw@example.com/': 'https://***@example.com/',
      'https://user:p w@example.com/': 'https://***@example.com/',
      'https://a@b:pw@example.com/x?y=@z': 'https://***@example.com/x?***@z',
      'Source: https://u:pw@x.example and https://v:pw@y.example/': 'Source: https://***@x.example and https://***@y.example/',
      'see u:pw@x.example': '***@x.example',
      'https://example.com/@snow': 'https://example.com/@snow',
      'https://@example.com/': 'https://@example.com/',
      'https://example.com?by=a@b': 'https://example.com?***@b',
      'no at sign here': 'no at sign here',
    };
    for (const [link, hidden] of Object.entries(cases)) assert.equal(hideUserInfo(link), hidden, JSON.stringify(link));
    const zw = String.fromCodePoint(0x200b);
    assert.equal(hideUserInfo(`${zw}https://admin:pw@example.com/`), `${zw}https://***@example.com/`, 'not only at the start');
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
    const points = [0x1b, 0x7f, 0x85, 0x9b, 0x61c, 0x200b, 0x200e, 0x202a, 0x202e, 0x2028, 0x2066, 0x2069, 0xfeff];
    const nasty = `a${String.fromCodePoint(...points)}z`;
    assert.equal(show(nasty, 500), `"a${escaped(...points)}z"`);
    assert.equal(plain(nasty), `a${escaped(...points)}z`);
    assert.equal(show(`caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2215)}`), `"caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2215)}"`, 'ordinary non-ASCII text stays readable');
  });

  // N2 review: by Unicode property, so tag characters, the soft hyphen, invisible operators,
  // variation selectors and Hangul fillers are caught too; astral ones are escaped as \u{...}.
  test('show escapes every control, format or default-ignorable character, by code point', () => {
    const points = [0xad, 0x34f, 0x115f, 0x180e, 0x2061, 0x2064, 0x3164, 0xfe0f, 0xffa0, 0x1d173, 0xe0001, 0xe0041, 0xe007f];
    const quoted = show(String.fromCodePoint(...points), 500);
    assert.equal(quoted, `"${escaped(...points)}"`);
    assert.match(escaped(0xe0041), /^\\u\{e0041\}$/);
    assert.equal(isBlank(String.fromCodePoint(...points)), true);
    assert.equal(isBlank(` ${String.fromCodePoint(0xa0)}\t`), true);
    assert.equal(isBlank('a'), false);
  });

  test('show cuts by code points, never leaving half of a surrogate pair', () => {
    const leaves = String.fromCodePoint(0x1f33f).repeat(100);
    const quoted = show(leaves, 10);
    assert.equal(Array.from(quoted).length, 10);
    assert.ok(quoted.endsWith('…'));
    assert.doesNotMatch(quoted, /\p{Cs}/u, 'no lone surrogates');
    assert.equal(show(String.fromCodePoint(0x1f33f).repeat(3), 10), `"${String.fromCodePoint(0x1f33f).repeat(3)}"`, 'short values are left whole');
  });

  test('plain keeps a long path whole when asked, and escapes it', () => {
    const long = `/tmp/${'a'.repeat(300)}${String.fromCodePoint(0x202e)}.json`;
    assert.equal(plain(long, Infinity), `/tmp/${'a'.repeat(300)}${escaped(0x202e)}.json`);
  });

  test('linkKey is the page a link opens: no plain #fragment, no utm_*, no empty ?, no trailing dot', () => {
    assert.equal(linkKey('https://EXAMPLE.com:443/a#top'), 'https://example.com/a');
    assert.equal(linkKey('https://example.com'), 'https://example.com/');
    assert.equal(linkKey('https://example.com./a?'), 'https://example.com/a');
    assert.equal(linkKey('https://example.com/a?utm_source=x&b=2&utm_medium=y&a=1'), 'https://example.com/a?b=2&a=1');
    assert.equal(linkKey('https://example.com/#/route/1'), 'https://example.com/#/route/1');
    assert.equal(linkKey('https://example.com/#!/route/1'), 'https://example.com/#!/route/1');
    assert.notEqual(linkKey('https://example.com/a?x=1'), linkKey('https://example.com/a?x=2'));
  });

  test('linkProblem leaves non-https links to the schema, so each link gets one line', () => {
    assert.equal(linkProblem('http://example.com'), null);
    assert.equal(linkProblem('javascript:alert(1)'), null);
    assert.equal(linkProblem(undefined), null);
    assert.equal(linkProblem('https://example.com/ok'), null);
    assert.match(linkProblem('https:// evil'), /^must be a whole link/);
    assert.match(linkProblem('https://0x7f.1/'), /^must name a public site like example\.com/);
    assert.match(linkProblem('https://example.com/a\\b'), /^must not contain a backslash or hidden characters/);
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
