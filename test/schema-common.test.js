// The pieces both desk contracts share (server/schema-common.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hasUserInfo, isDateTime, linkProblem, readablePath, withoutSample } from '../server/schema-common.js';

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
    assert.equal(hasUserInfo('http://user@example.com/'), false, 'non-https links are the pattern\'s job');
  });

  test('linkProblem leaves non-https links to the schema, so each link gets one line', () => {
    assert.equal(linkProblem('http://example.com'), null);
    assert.equal(linkProblem('javascript:alert(1)'), null);
    assert.equal(linkProblem(undefined), null);
    assert.equal(linkProblem('https://example.com/ok'), null);
    assert.match(linkProblem('https:// evil'), /^must be a whole link/);
    assert.equal(linkProblem('https://me:hunter2@example.com/a?b=c'), 'must not have a user name or password before the site name (got "https://***@example.com/a?b=c")');
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
