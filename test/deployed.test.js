// <live copy>/.deployed.json (server/deployed.js): written by npm run deploy, read by the server
// log and service:status. It is a file on disk, so whatever is in it is cleaned before printing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { DEPLOYED_FILE, deployedPath, deployedRecord, describeDeployed, oneLine, readDeployed } from '../server/deployed.js';

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-deployed-'));
  tmpDirs.push(dir);
  return dir;
};
const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

describe('.deployed.json', () => {
  test('lives in the live copy, next to server/', () => {
    assert.equal(DEPLOYED_FILE, '.deployed.json');
    assert.equal(deployedPath('/Users/snow/the-desk-live'), '/Users/snow/the-desk-live/.deployed.json');
  });

  test('deployedRecord keeps the sha, a short sha, the subject, the ref and the time', () => {
    assert.deepEqual(deployedRecord({ sha: SHA, subject: 'News: routes', deployedAt: '2026-11-28T09:14:03-05:00' }), {
      sha: SHA,
      shortSha: '1a2b3c4',
      subject: 'News: routes',
      ref: 'main',
      deployedAt: '2026-11-28T09:14:03-05:00',
    });
  });

  test('reads back what deploy wrote', () => {
    const dir = tempDir();
    const record = deployedRecord({ sha: SHA, subject: 'Lotus: tester fixes', deployedAt: '2026-11-28T09:14:03-05:00' });
    fs.writeFileSync(deployedPath(dir), JSON.stringify(record));
    assert.deepEqual(readDeployed(dir), record);
    assert.equal(describeDeployed(readDeployed(dir)), 'main @ 1a2b3c4 "Lotus: tester fixes"');
  });

  test('null when it is missing, not JSON, or has no real commit sha', () => {
    const dir = tempDir();
    assert.equal(readDeployed(dir), null);
    for (const text of ['not json', '[]', 'null', '{}', JSON.stringify({ sha: 'main', subject: 'x' }), JSON.stringify({ sha: SHA.toUpperCase() })]) {
      fs.writeFileSync(deployedPath(dir), text);
      assert.equal(readDeployed(dir), null, text);
    }
  });

  test('control characters and very long subjects are cleaned before anyone prints them', () => {
    const dir = tempDir();
    fs.writeFileSync(deployedPath(dir), JSON.stringify({ sha: SHA, subject: 'Fix\u001b[31m red\nsecond line\u0007', ref: 'main\r\n', deployedAt: 42 }));
    const info = readDeployed(dir);
    assert.equal(info.subject, 'Fix [31m red second line');
    assert.equal(info.ref, 'main');
    assert.equal(info.deployedAt, '42');
    assert.equal(oneLine('x'.repeat(300)).length, 200);
    assert.ok(oneLine('x'.repeat(300)).endsWith('…'));
  });
});
