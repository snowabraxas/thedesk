// Log rotation for the service's log (server/log-file.js), and the probe that asks a port
// whether The Desk is answering (server/probe.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createServer } from '../server/index.js';
import { MAX_LOG_BYTES, rotateLog } from '../server/log-file.js';
import { probeDesk } from '../server/probe.js';

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-log-'));
  tmpDirs.push(dir);
  return dir;
};
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

describe('rotateLog', () => {
  test('the limit is 5 MB', () => {
    assert.equal(MAX_LOG_BYTES, 5 * 1024 * 1024);
  });

  test('leaves a log at or under the limit alone', () => {
    const file = path.join(tempDir(), 'the-desk.log');
    fs.writeFileSync(file, 'x'.repeat(100));
    assert.equal(rotateLog(file, { maxBytes: 100 }), null);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x'.repeat(100));
    assert.equal(fs.existsSync(`${file}.1`), false);
  });

  test('over the limit: the old lines go to .1 and the log is emptied in place (same file, for launchd)', () => {
    const file = path.join(tempDir(), 'the-desk.log');
    fs.writeFileSync(file, 'old '.repeat(50));
    const inode = fs.statSync(file).ino;
    assert.equal(rotateLog(file, { maxBytes: 100 }), `${file}.1`);
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'old '.repeat(50));
    assert.equal(fs.statSync(file).size, 0);
    assert.equal(fs.statSync(file).ino, inode, 'emptied, not replaced, so launchd keeps writing to it');
  });

  test('keeps one old copy only', () => {
    const file = path.join(tempDir(), 'the-desk.log');
    fs.writeFileSync(`${file}.1`, 'oldest');
    fs.writeFileSync(file, 'newer '.repeat(50));
    rotateLog(file, { maxBytes: 100 });
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), 'newer '.repeat(50));
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['the-desk.log', 'the-desk.log.1']);
  });

  test('a writer in append mode carries on at the start of the emptied log', () => {
    const file = path.join(tempDir(), 'the-desk.log');
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, 'y'.repeat(200));
      rotateLog(file, { maxBytes: 100 });
      fs.writeSync(fd, 'after\n');
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
  });

  test('never throws: no file, no name, a folder', () => {
    const dir = tempDir();
    assert.equal(rotateLog(path.join(dir, 'missing.log')), null);
    assert.equal(rotateLog(''), null);
    assert.equal(rotateLog(dir, { maxBytes: 0 }), null);
  });
});

describe('probeDesk', () => {
  test('says yes, with the edition source, when The Desk answers', async () => {
    const server = createServer({ deskHome: tempDir(), log: { error() {}, info() {} } });
    const port = await listen(server);
    try {
      assert.deepEqual(await probeDesk(port), { ok: true, source: 'sample' });
    } finally {
      await close(server);
    }
  });

  test('says no when another web server answers', async () => {
    const server = http.createServer((req, res) => res.end('{}'));
    const port = await listen(server);
    try {
      assert.deepEqual(await probeDesk(port), { ok: false, status: 200 });
    } finally {
      await close(server);
    }
  });

  test('says no when nothing listens', async () => {
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe); // nothing listens there now
    const r = await probeDesk(port);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ECONNREFUSED');
  });

  test('says no when nothing answers in time', async () => {
    const sockets = new Set();
    const silent = net.createServer((socket) => sockets.add(socket)); // accepts, never answers
    const port = await listen(silent);
    try {
      const r = await probeDesk(port, { timeoutMs: 200 });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'TimeoutError');
    } finally {
      for (const socket of sockets) socket.destroy();
      await close(silent);
    }
  });
});
