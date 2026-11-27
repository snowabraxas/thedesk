import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULT_PORT, expandHome, feedPath, resolveDeskHome, resolvePort } from '../server/config.js';

describe('config', () => {
  test('PORT defaults to 4321', () => {
    assert.equal(DEFAULT_PORT, 4321);
    assert.equal(resolvePort({}), 4321);
    assert.equal(resolvePort({ PORT: '' }), 4321);
  });

  test('PORT can be overridden', () => {
    assert.equal(resolvePort({ PORT: '5000' }), 5000);
  });

  test('a bad PORT is refused with a clear message', () => {
    for (const PORT of ['abc', '0', '70000', '-1', '43.21']) {
      assert.throws(() => resolvePort({ PORT }), /PORT must be a number from 1 to 65535/);
    }
  });

  test('DESK_HOME defaults to ~/agent-house', () => {
    assert.equal(resolveDeskHome({}, '/Users/someone'), '/Users/someone/agent-house');
  });

  test('DESK_HOME can be overridden, and a leading ~ is expanded', () => {
    assert.equal(resolveDeskHome({ DESK_HOME: '/tmp/desk' }, '/Users/someone'), '/tmp/desk');
    assert.equal(resolveDeskHome({ DESK_HOME: '~/elsewhere' }, '/Users/someone'), '/Users/someone/elsewhere');
    assert.equal(expandHome('~', '/Users/someone'), '/Users/someone');
    assert.equal(expandHome('/a/~/b', '/Users/someone'), '/a/~/b');
  });

  test('the Product Feed lives at desks/product-feed/feed.json', () => {
    assert.equal(feedPath('/h'), path.join('/h', 'desks', 'product-feed', 'feed.json'));
  });
});
