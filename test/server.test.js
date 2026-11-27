import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { createServer, isAllowedHost, portInUseMessage, startedLines } from '../server/index.js';

// Raw http.request so tests can send any Host header (fetch won't let us).
function request(port, { method = 'GET', path: urlPath = '/', host = `localhost:${port}`, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = setHost && host !== undefined ? { host } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, setHost: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('isAllowedHost', () => {
  test('allows localhost and 127.0.0.1 on our port only', () => {
    assert.equal(isAllowedHost('localhost:4321', 4321), true);
    assert.equal(isAllowedHost('127.0.0.1:4321', 4321), true);
    assert.equal(isAllowedHost('LocalHost:4321', 4321), true);
    assert.equal(isAllowedHost('localhost:4322', 4321), false);
    assert.equal(isAllowedHost('localhost', 4321), false);
    assert.equal(isAllowedHost('evil.example:4321', 4321), false);
    assert.equal(isAllowedHost('localhost.evil.example:4321', 4321), false);
    assert.equal(isAllowedHost('[::1]:4321', 4321), false);
    assert.equal(isAllowedHost(undefined, 4321), false);
    assert.equal(isAllowedHost('localhost:4321', undefined), false);
  });
});

describe('server', () => {
  let tmp;
  let server;
  let port;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-server-'));
    const appDir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(appDir, 'css'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>The Desk</title>');
    fs.writeFileSync(path.join(appDir, 'css', 'style.css'), 'body{}');
    fs.writeFileSync(path.join(appDir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the app folder');
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(appDir, 'link.txt'));

    server = createServer({ deskHome: path.join(tmp, 'agent-house'), appDir, log: { error() {} } });
    port = await listen(server);
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('starts on a random port, listening on 127.0.0.1 only', () => {
    assert.ok(port > 0);
    assert.equal(server.address().address, '127.0.0.1');
  });

  test('GET / answers 200 with the app page', async () => {
    const res = await request(port);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /The Desk/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('accepts Host 127.0.0.1:<port> too', async () => {
    const res = await request(port, { host: `127.0.0.1:${port}` });
    assert.equal(res.status, 200);
  });

  test('rejects a bad Host header with 403', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port + 1}`, 'localhost']) {
      const res = await request(port, { host });
      assert.equal(res.status, 403, `Host ${host}`);
      assert.doesNotMatch(res.body, /The Desk<\/title>/);
    }
  });

  test('rejects a request with no Host header', async () => {
    const res = await request(port, { setHost: false });
    assert.ok(res.status === 400 || res.status === 403, `got ${res.status}`);
  });

  test('sends no CORS headers', async () => {
    const res = await request(port);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  test('serves other files from app/ with the right type', async () => {
    const res = await request(port, { path: '/css/style.css' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/css/);
    assert.equal(res.body, 'body{}');
  });

  test('HEAD / answers 200 with no body', async () => {
    const res = await request(port, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });

  test('refuses other methods on static files', async () => {
    const res = await request(port, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  });

  test('answers 404 for missing files and unknown API paths', async () => {
    assert.equal((await request(port, { path: '/nope.html' })).status, 404);
    assert.equal((await request(port, { path: '/api/nope' })).status, 404);
    assert.equal((await request(port, { path: '/api' })).status, 404);
  });

  test('never serves files outside app/', async () => {
    const attempts = [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/css/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/link.txt',
      '/.env',
      '/index.html%00.txt',
      '/%E0%A4%A',
    ];
    for (const p of attempts) {
      const res = await request(port, { path: p });
      assert.notEqual(res.status, 200, p);
      assert.doesNotMatch(res.body, /outside the app folder|SECRET/, p);
    }
  });

  test('remembers its DESK_HOME for the API routes', () => {
    assert.equal(server.desk.deskHome, path.join(tmp, 'agent-house'));
  });
});

describe('running server/index.js', () => {
  test('importing it does not start a server', () => {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./server/index.js'); console.log('imported');"],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'imported');
  });

  const STAMP = '\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d';

  /** Starts server/index.js on a free port with a temp DESK_HOME; resolves once it says it's running. */
  async function startServer() {
    const freePort = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const deskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-start-'));
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(freePort), DESK_HOME: deskHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '' };
    child.stdout.on('data', (d) => (output.stdout += d));
    const cleanup = () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(deskHome, { recursive: true, force: true });
    };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start: ${output.stdout}`)), 10_000);
        child.stdout.on('data', () => {
          if (output.stdout.includes('running at')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${output.stdout}`)));
      });
    } catch (err) {
      cleanup();
      throw err;
    }
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, port: freePort, output, exited, cleanup };
  }

  test('npm start serves the real app/ on PORT and stops cleanly on SIGTERM, saying so', async () => {
    const s = await startServer();
    try {
      assert.match(s.output.stdout, new RegExp(`^${STAMP} The Desk is running at http://localhost:${s.port} \\(data: `));

      const res = await request(s.port);
      assert.equal(res.status, 200);
      assert.match(res.body, /<title>The Desk<\/title>/);

      s.child.kill('SIGTERM');
      assert.equal(await s.exited, 0);
      assert.match(s.output.stdout, new RegExp(`\\n${STAMP} The Desk is stopping \\(SIGTERM\\)\\n$`));
      for (const line of s.output.stdout.trimEnd().split('\n')) assert.match(line, new RegExp(`^${STAMP} `), 'every line has a timestamp');
    } finally {
      s.cleanup();
    }
  });

  test('Ctrl+C (SIGINT) stops it the same way, exit 0', async () => {
    const s = await startServer();
    try {
      s.child.kill('SIGINT');
      assert.equal(await s.exited, 0);
      assert.match(s.output.stdout, new RegExp(`\\n${STAMP} The Desk is stopping \\(SIGINT\\)\\n$`));
    } finally {
      s.cleanup();
    }
  });

  test('at start it names the deployed commit when there is a .deployed.json next to server/', () => {
    assert.deepEqual(startedLines({ port: 4321, deskHome: '/Users/snow/agent-house' }), [
      'The Desk is running at http://localhost:4321 (data: /Users/snow/agent-house)',
    ]);
    const deployed = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'News: routes', ref: 'main', deployedAt: '2026-11-28T09:14:03-05:00' };
    assert.deepEqual(startedLines({ port: 4321, deskHome: '/Users/snow/agent-house', deployed }), [
      'The Desk is running at http://localhost:4321 (data: /Users/snow/agent-house)',
      'The Desk: this is main @ aaaaaaa "News: routes", deployed 2026-11-28T09:14:03-05:00',
    ]);
    assert.equal(startedLines({ port: 1, deskHome: '/h', deployed: { ...deployed, deployedAt: '' } })[1], 'The Desk: this is main @ aaaaaaa "News: routes"');
  });
});

describe('a port that is already taken', () => {
  test('portInUseMessage says who has it and how to run alongside it', () => {
    const base = { port: 4321, deskAnswers: false, serviceInstalled: false, isService: false };
    assert.equal(
      portInUseMessage({ ...base, deskAnswers: true, serviceInstalled: true }),
      'Port 4321 is taken: The Desk is already running at http://localhost:4321, as the always-on service or in another Terminal (npm run service:status tells you which). To run this copy alongside it, use another port: PORT=4322 npm run dev',
    );
    assert.equal(
      portInUseMessage({ ...base, deskAnswers: true }),
      'Port 4321 is taken: The Desk is already running at http://localhost:4321 (npm run dev or npm start in another Terminal?). Stop that one with Ctrl+C, or use another port: PORT=4322 npm run dev',
    );
    assert.equal(portInUseMessage(base), 'Port 4321 is taken by another program. To run The Desk anyway, use another port: PORT=4322 npm run dev');
    assert.match(portInUseMessage({ ...base, port: 5000 }), /PORT=5001 npm run dev/);
    assert.match(portInUseMessage({ ...base, port: 65535 }), /PORT=65534 npm run dev/);
    assert.match(
      portInUseMessage({ ...base, deskAnswers: true, serviceInstalled: true, isService: true }),
      /^The Desk service can't start: port 4321 is taken by another copy of The Desk \(npm run dev or npm start in a Terminal\?\)\. launchd tries again/,
    );
    assert.match(portInUseMessage({ ...base, isService: true }), /taken by another program\. launchd tries again/);
  });

  const freePort = () =>
    new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });

  /** Runs server/index.js until it exits; HOME is a temp folder so the real service plist never counts. */
  function runServer(env, { untilOutput } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['server/index.js'], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let stopping = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`server did not finish: ${stdout}${stderr}`));
      }, 10_000);
      child.stdout.on('data', (d) => {
        stdout += d;
        // Once only: a second SIGTERM while it is stopping ends it at once (no exit 0).
        if (untilOutput && !stopping && stdout.includes(untilOutput)) {
          stopping = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  test('npm start says The Desk is already running there when it is', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-home-'));
    const desk = createServer({ deskHome: path.join(home, 'agent-house'), log: { error() {}, info() {} } });
    const port = await listen(desk);
    try {
      const r = await runServer({ PORT: String(port), HOME: home, DESK_HOME: path.join(home, 'agent-house') });
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`Port ${port} is taken: The Desk is already running at http://localhost:${port} \\(npm run dev or npm start in another Terminal\\?\\)`));
      assert.match(r.stderr, new RegExp(`PORT=${port + 1} npm run dev`));

      // With the service installed, it says it may be the service.
      fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
      fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'local.thedesk.server.plist'), '<plist/>');
      const r2 = await runServer({ PORT: String(port), HOME: home, DESK_HOME: path.join(home, 'agent-house') });
      assert.equal(r2.code, 1);
      assert.match(r2.stderr, /as the always-on service or in another Terminal \(npm run service:status tells you which\)/);
    } finally {
      await new Promise((resolve) => desk.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('npm start says another program has the port when it is not The Desk', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-home-'));
    const other = net.createServer((socket) => socket.resume().end()); // reads, then hangs up
    const port = await listen(other);
    try {
      const r = await runServer({ PORT: String(port), HOME: home, DESK_HOME: path.join(home, 'agent-house') });
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`Port ${port} is taken by another program\\. To run The Desk anyway, use another port`));
    } finally {
      await new Promise((resolve) => other.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('started with DESK_LOG (as the service is), a log over 5 MB is rotated first', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-home-'));
    const log = path.join(home, 'the-desk.log');
    fs.writeFileSync(log, 'z'.repeat(5 * 1024 * 1024 + 1));
    try {
      const r = await runServer(
        { PORT: String(await freePort()), HOME: home, DESK_HOME: path.join(home, 'agent-house'), DESK_LOG: log },
        { untilOutput: 'running at' },
      );
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /the log passed 5 MB, so its older lines moved to .*the-desk\.log\.1/);
      assert.equal(fs.statSync(log).size, 0);
      assert.equal(fs.statSync(`${log}.1`).size, 5 * 1024 * 1024 + 1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
