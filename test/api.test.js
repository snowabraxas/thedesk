// /api/feed and /api/state, plus the security headers. Every test uses a temp DESK_HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { APP_DIR, SAMPLE_FEED_PATH, feedPath, productFeedDir, statePath } from '../server/config.js';
import { CONTENT_SECURITY_POLICY, createServer } from '../server/index.js';
import { MAX_STATE_BYTES, checkState, createStateStore } from '../server/state-store.js';

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";

const quiet = { error() {}, info() {} };
const tmpDirs = [];
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-api-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.chmodSync(path.dirname(statePath(dir)), 0o755);
    } catch {
      /* folder may not exist */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function start(options) {
  const server = createServer({ log: quiet, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}
function stop(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

// Raw http.request so tests can send any Host header and body.
function request(port, { method = 'GET', path: urlPath = '/', host = `localhost:${port}`, headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host, ...headers };
    if (body !== undefined && !chunked) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined && chunked) {
      for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.slice(i, i + 64 * 1024));
      req.end();
    } else {
      req.end(body);
    }
  });
}
const putState = (port, value, extra = {}) =>
  request(port, {
    method: 'PUT',
    path: '/api/state',
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
    ...extra,
  });

const SAMPLE = JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));
const STATE = {
  read: { a1: 1764250000000 },
  saved: { a2: ['f1'] },
  folders: [{ id: 'f1', name: 'Evals reading' }],
  notes: [{ id: 'n1', a: 'a1', text: 'Try error discovery <first>', ts: 1764250001000 }],
  xp: 30,
  days: ['2026-11-27'],
  badges: { 'first-read': 1764250000000 },
};
const folderFiles = (deskHome) => fs.readdirSync(path.dirname(statePath(deskHome))).sort();

describe('GET /api/feed', () => {
  let deskHome;
  let server;
  let port;
  beforeEach(async () => {
    deskHome = tempHome();
    ({ server, port } = await start({ deskHome }));
  });
  afterEach(() => stop(server));

  const writeFeed = (value) => {
    fs.mkdirSync(path.dirname(feedPath(deskHome)), { recursive: true });
    fs.writeFileSync(feedPath(deskHome), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const withHttpUrl = (feed) => ({ ...feed, articles: feed.articles.map((a, i) => (i ? a : { ...a, url: 'http://example.com/post' })) });

  test('without a feed.json, serves the prototype edition marked as a sample', async () => {
    const res = await request(port, { path: '/api/feed' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-desk-feed-source'], 'sample');
    assert.equal(res.json.sample, true);
    assert.deepEqual(res.json.articles, SAMPLE.articles);
    assert.equal(res.json.edition, SAMPLE.edition);
  });

  test("serves the agent's valid feed.json as live, not marked as a sample", async () => {
    const feed = { ...SAMPLE, edition: '2026-11-27', note: 'Written by the agent' };
    writeFeed(feed);
    const res = await request(port, { path: '/api/feed' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-desk-feed-source'], 'live');
    assert.deepEqual(res.json, feed);
    assert.equal(res.json.sample, undefined);
  });

  test('an agent file can never mark itself as a sample', async () => {
    writeFeed({ ...SAMPLE, edition: '2026-11-27', sample: true });
    const res = await request(port, { path: '/api/feed' });
    assert.equal(res.headers['x-desk-feed-source'], 'live');
    assert.equal('sample' in res.json, false);
  });

  test("falls back to the sample, and logs why once, when feed.json doesn't parse", async () => {
    await stop(server);
    const logged = [];
    ({ server, port } = await start({ deskHome, log: { error: (...a) => logged.push(a.join(' ')) } }));
    writeFeed('{"desk": "product-feed",');
    for (let i = 0; i < 3; i++) {
      const res = await request(port, { path: '/api/feed' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-desk-feed-source'], 'sample');
      assert.equal(res.json.sample, true);
    }
    assert.equal(logged.length, 1, 'logged once, not on every request');
    assert.match(logged[0], /feed\.json isn't a valid edition, so it keeps showing the sample edition:\n {2}- not valid JSON/);
  });

  test('a valid feed is served, an invalid one is rejected, and the last good edition keeps showing', async () => {
    await stop(server);
    const logged = [];
    ({ server, port } = await start({ deskHome, log: { error: (m) => logged.push(m), info() {} } }));
    writeFeed({ ...SAMPLE, edition: '2026-11-27' });
    const good = await request(port, { path: '/api/feed' });
    assert.equal(good.headers['x-desk-feed-source'], 'live');

    writeFeed(withHttpUrl({ ...SAMPLE, edition: '2026-11-28' }));
    const kept = await request(port, { path: '/api/feed' });
    assert.equal(kept.status, 200);
    assert.equal(kept.headers['x-desk-feed-source'], 'last-good');
    assert.deepEqual(kept.json, good.json);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /articles\[0\]\.url: must start with https:\/\//);
  });

  test('after a restart with a bad feed.json, serves the newest valid edition from editions/', async () => {
    await stop(server);
    writeFeed(withHttpUrl({ ...SAMPLE, edition: '2026-11-28' }));
    const editions = path.join(productFeedDir(deskHome), 'editions');
    fs.mkdirSync(editions, { recursive: true });
    fs.writeFileSync(path.join(editions, '2026-11-27.json'), JSON.stringify({ ...SAMPLE, edition: '2026-11-27' }));
    fs.writeFileSync(path.join(editions, '2026-11-28.json'), JSON.stringify(withHttpUrl({ ...SAMPLE, edition: '2026-11-28' })));
    ({ server, port } = await start({ deskHome }));
    const res = await request(port, { path: '/api/feed' });
    assert.equal(res.headers['x-desk-feed-source'], 'edition:2026-11-27.json');
    assert.equal(res.json.edition, '2026-11-27');
    assert.equal(res.json.sample, undefined);
  });

  test('HEAD answers with headers only; other methods are refused', async () => {
    const head = await request(port, { method: 'HEAD', path: '/api/feed' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['x-desk-feed-source'], 'sample');
    const post = await request(port, { method: 'POST', path: '/api/feed', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
  });

  test('an unexpected error answers 500 in JSON, not cached', async () => {
    await stop(server);
    // No feed.json and no sample to fall back on.
    ({ server, port } = await start({ deskHome, samplePath: path.join(deskHome, 'missing-sample.json') }));
    const res = await request(port, { path: '/api/feed' });
    assert.equal(res.status, 500);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json, { error: 'Something went wrong' });
  });

  test('unknown API paths answer 404 in JSON', async () => {
    const res = await request(port, { path: '/api/nope' });
    assert.equal(res.status, 404);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

describe('GET and PUT /api/state', () => {
  let deskHome;
  let server;
  let port;
  beforeEach(async () => {
    deskHome = tempHome();
    ({ server, port } = await start({ deskHome }));
  });
  afterEach(() => stop(server));

  test('GET answers {} when nothing has been saved, and creates nothing', async () => {
    const res = await request(port, { path: '/api/state' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {});
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(fs.existsSync(path.join(deskHome, 'desks')), false);
  });

  test('PUT then GET gives the same state back, and it lands in state.json', async () => {
    const put = await putState(port, STATE);
    assert.equal(put.status, 200);
    assert.deepEqual(put.json, { ok: true });
    assert.equal(put.headers['cache-control'], 'no-store');
    const get = await request(port, { path: '/api/state' });
    assert.deepEqual(get.json, STATE);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(deskHome), 'utf8')), STATE);
  });

  test('the state survives a server restart', async () => {
    assert.equal((await putState(port, STATE)).status, 200);
    await stop(server);
    ({ server, port } = await start({ deskHome }));
    const get = await request(port, { path: '/api/state' });
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, STATE);
  });

  test('accepts application/json with a charset, and keeps unknown keys', async () => {
    const value = { xp: 5, later: { anything: true } };
    const put = await putState(port, value, { headers: { 'content-type': 'application/json; charset=utf-8' } });
    assert.equal(put.status, 200);
    assert.deepEqual((await request(port, { path: '/api/state' })).json, value);
  });

  test('415 unless the body is sent as application/json', async () => {
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
      const headers = type ? { 'content-type': type } : {};
      const res = await request(port, { method: 'PUT', path: '/api/state', headers, body: JSON.stringify(STATE) });
      assert.equal(res.status, 415, String(type));
    }
    assert.equal(fs.existsSync(statePath(deskHome)), false);
  });

  test('413 for a body over 1 MB, declared or streamed, and the saved state stays', async () => {
    assert.equal((await putState(port, STATE)).status, 200);
    const big = JSON.stringify({ ...STATE, pad: 'x'.repeat(MAX_STATE_BYTES) });
    assert.equal((await putState(port, big)).status, 413);
    assert.equal((await putState(port, big, { chunked: true })).status, 413);
    assert.deepEqual((await request(port, { path: '/api/state' })).json, STATE);
  });

  test('a body of exactly 1 MB is accepted', async () => {
    const shell = JSON.stringify({ pad: '' });
    const exact = JSON.stringify({ pad: 'x'.repeat(MAX_STATE_BYTES - shell.length) });
    assert.equal(Buffer.byteLength(exact), MAX_STATE_BYTES);
    assert.equal((await putState(port, exact)).status, 200);
  });

  test('400 for anything that is not a state object with the right types', async () => {
    const bad = [
      '',
      'not json',
      '{"xp": 1,',
      '[]',
      'null',
      '"state"',
      '42',
      { read: [] },
      { read: null },
      { saved: 'a2' },
      { folders: {} },
      { notes: 'note' },
      { xp: '30' },
      { xp: null },
      { days: '2026-11-27' },
      { badges: [] },
    ];
    for (const value of bad) {
      const res = await putState(port, value);
      assert.equal(res.status, 400, JSON.stringify(value));
      assert.equal(typeof res.json.error, 'string');
    }
    assert.equal(fs.existsSync(statePath(deskHome)), false);
  });

  test('leaves no temp files behind after a save', async () => {
    await putState(port, STATE);
    await putState(port, { ...STATE, xp: 40 });
    assert.deepEqual(folderFiles(deskHome), ['state.json']);
  });

  test('concurrent PUTs all land whole, one after another', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => putState(port, { ...STATE, xp: i })));
    assert.ok(results.every((r) => r.status === 200));
    const saved = JSON.parse(fs.readFileSync(statePath(deskHome), 'utf8'));
    assert.ok(saved.xp >= 0 && saved.xp < 20);
    assert.deepEqual({ ...saved, xp: 0 }, { ...STATE, xp: 0 });
    assert.deepEqual(folderFiles(deskHome), ['state.json']);
  });

  test("GET answers 500, logs it and leaves the file alone when state.json isn't valid JSON", async () => {
    await stop(server);
    const logged = [];
    ({ server, port } = await start({ deskHome, log: { error: (...a) => logged.push(a.join(' ')) } }));
    fs.mkdirSync(path.dirname(statePath(deskHome)), { recursive: true });
    const broken = '{"xp": 30, "notes": [';
    fs.writeFileSync(statePath(deskHome), broken);
    const res = await request(port, { path: '/api/state' });
    assert.equal(res.status, 500);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /state\.json is not valid JSON/);
    assert.equal(fs.readFileSync(statePath(deskHome), 'utf8'), broken);
  });

  // N2 review: V8's JSON errors quote the file; for state.json that went straight to the-desk.log.
  test('a corrupt state.json is logged without quoting the file: no control bytes, no password', async () => {
    await stop(server);
    const logged = [];
    ({ server, port } = await start({ deskHome, log: { error: (...a) => logged.push(a.join(' ')) } }));
    fs.mkdirSync(path.dirname(statePath(deskHome)), { recursive: true });
    fs.writeFileSync(statePath(deskHome), `{"notes": [${String.fromCodePoint(0x1b)}[31m https://admin:SECRET@example.com/]}`);
    assert.equal((await request(port, { path: '/api/state' })).status, 500);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /state\.json is not valid JSON \(Unexpected token '\\u001b'\)/);
    assert.ok(!logged[0].includes('SECRET') && !logged[0].includes(String.fromCodePoint(0x1b)), logged[0]);
  });

  test('a state.json that starts with a byte-order mark still loads', async () => {
    fs.mkdirSync(path.dirname(statePath(deskHome)), { recursive: true });
    fs.writeFileSync(statePath(deskHome), `${String.fromCodePoint(0xfeff)}{"xp": 12}`);
    assert.deepEqual(await createStateStore(deskHome, 'product-feed').read(), { xp: 12 });
  });

  test('GET answers 500 when state.json holds something other than an object', async () => {
    fs.mkdirSync(path.dirname(statePath(deskHome)), { recursive: true });
    fs.writeFileSync(statePath(deskHome), '[1, 2, 3]');
    assert.equal((await request(port, { path: '/api/state' })).status, 500);
  });

  test('other methods are refused', async () => {
    const res = await request(port, { method: 'POST', path: '/api/state', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET, HEAD, PUT');
  });

  test('the Host check applies to the API too', async () => {
    await putState(port, STATE);
    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port + 1}`]) {
      const get = await request(port, { path: '/api/state', host });
      assert.equal(get.status, 403, host);
      assert.doesNotMatch(get.body, /Evals reading/);
      const put = await putState(port, { xp: 999 }, { host });
      assert.equal(put.status, 403, host);
      const feed = await request(port, { path: '/api/feed', host });
      assert.equal(feed.status, 403, host);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(deskHome), 'utf8')), STATE);
  });
});

describe('a failed write', () => {
  // fs.promises with one step made to fail, the way a full disk or a crash would.
  function failing(step) {
    const fsp = fs.promises;
    return {
      ...fsp,
      rename: async (...args) => {
        if (step === 'rename') throw Object.assign(new Error('rename failed'), { code: 'EIO' });
        return fsp.rename(...args);
      },
      open: async (file, flags, mode) => {
        const handle = await fsp.open(file, flags, mode);
        if (flags === 'wx') {
          if (step === 'write') {
            handle.writeFile = async (data) => {
              await fsp.appendFile(file, String(data).slice(0, 10)); // half a file, then the disk fills up
              throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
            };
          }
          if (step === 'fsync') handle.sync = async () => {
            throw Object.assign(new Error('fsync failed'), { code: 'EIO' });
          };
        }
        return handle;
      },
    };
  }

  for (const step of ['write', 'fsync', 'rename']) {
    test(`at ${step}: answers 500, keeps the previous state.json and leaves no temp file`, async () => {
      const deskHome = tempHome();
      let { server, port } = await start({ deskHome });
      assert.equal((await putState(port, STATE)).status, 200);
      const before = fs.readFileSync(statePath(deskHome), 'utf8');
      await stop(server);

      const logged = [];
      ({ server, port } = await start({ deskHome, fsp: failing(step), log: { error: (m) => logged.push(m) } }));
      try {
        const res = await putState(port, { ...STATE, xp: 999 });
        assert.equal(res.status, 500);
        assert.equal(fs.readFileSync(statePath(deskHome), 'utf8'), before);
        assert.deepEqual(folderFiles(deskHome), ['state.json']);
        assert.equal(logged.length, 1);
        assert.deepEqual((await request(port, { path: '/api/state' })).json, STATE);
      } finally {
        await stop(server);
      }
    });
  }

  test("when the folder can't be written: answers 500 and keeps the previous state.json", { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async () => {
    const deskHome = tempHome();
    const { server, port } = await start({ deskHome });
    try {
      assert.equal((await putState(port, STATE)).status, 200);
      const before = fs.readFileSync(statePath(deskHome), 'utf8');
      fs.chmodSync(path.dirname(statePath(deskHome)), 0o555);
      const res = await putState(port, { ...STATE, xp: 999 });
      assert.equal(res.status, 500);
      fs.chmodSync(path.dirname(statePath(deskHome)), 0o755);
      assert.equal(fs.readFileSync(statePath(deskHome), 'utf8'), before);
      assert.deepEqual(folderFiles(deskHome), ['state.json']);
    } finally {
      await stop(server);
    }
  });

  test('the next write after a failure works', async () => {
    const deskHome = tempHome();
    let failNext = true;
    const fsp = {
      ...fs.promises,
      rename: async (...args) => {
        if (failNext) {
          failNext = false;
          throw new Error('rename failed');
        }
        return fs.promises.rename(...args);
      },
    };
    const store = createStateStore(deskHome, 'product-feed', { fsp });
    await assert.rejects(store.write({ xp: 1 }));
    await store.write({ xp: 2 });
    assert.deepEqual(await store.read(), { xp: 2 });
    assert.deepEqual(folderFiles(deskHome), ['state.json']);
  });
});

describe('the state store', () => {
  test('creates the folder when needed', async () => {
    const deskHome = tempHome();
    const store = createStateStore(deskHome, 'product-feed');
    await store.write({ xp: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(deskHome), 'utf8')), { xp: 1 });
  });

  test('runs writes one at a time, in order', async () => {
    const deskHome = tempHome();
    let open = 0;
    let most = 0;
    const fsp = {
      ...fs.promises,
      open: async (file, flags, mode) => {
        const handle = await fs.promises.open(file, flags, mode);
        if (flags === 'wx') {
          open++;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return handle;
      },
      rename: async (...args) => {
        await fs.promises.rename(...args);
        open--;
      },
    };
    const store = createStateStore(deskHome, 'product-feed', { fsp });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.write({ xp: i })));
    assert.equal(most, 1, 'never more than one write at a time');
    assert.deepEqual(await store.read(), { xp: 9 }, 'the last write wins');
  });

  test('checkState names the field that is wrong', () => {
    assert.deepEqual(checkState({}), { ok: true });
    assert.deepEqual(checkState(STATE), { ok: true });
    assert.deepEqual(checkState({ xp: '1' }), { ok: false, error: 'xp must be a number' });
    assert.deepEqual(checkState({ folders: {} }), { ok: false, error: 'folders must be a list' });
    assert.deepEqual(checkState([]), { ok: false, error: 'state must be a JSON object' });
  });
});

describe('security headers', () => {
  let server;
  let port;
  beforeEach(async () => {
    ({ server, port } = await start({ deskHome: tempHome(), appDir: APP_DIR }));
  });
  afterEach(() => stop(server));

  test('the policy is the one agreed', () => {
    assert.equal(CONTENT_SECURITY_POLICY, EXPECTED_CSP);
  });

  for (const urlPath of ['/', '/api/feed', '/api/state', '/app.js', '/nope.html']) {
    test(`${urlPath} sends CSP, nosniff and no-referrer`, async () => {
      const res = await request(port, { path: urlPath });
      assert.equal(res.headers['content-security-policy'], EXPECTED_CSP);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });
  }

  test('a refused Host still gets the headers', async () => {
    const res = await request(port, { path: '/api/state', host: 'evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.headers['content-security-policy'], EXPECTED_CSP);
  });
});

describe('the real app/ under the policy', () => {
  let server;
  let port;
  beforeEach(async () => {
    ({ server, port } = await start({ deskHome: tempHome(), appDir: APP_DIR }));
  });
  afterEach(() => stop(server));

  test('serves each file type with the right Content-Type', async () => {
    const files = [
      ['/', /^text\/html/],
      ['/style.css', /^text\/css/],
      ['/app.js', /^text\/javascript/],
      ['/lib.js', /^text\/javascript/],
      ['/assets/plate-night.webp', /^image\/webp$/],
      ['/assets/plate-morning.webp', /^image\/webp$/],
      ['/assets/plate-golden.webp', /^image\/webp$/],
    ];
    for (const [urlPath, type] of files) {
      const res = await request(port, { path: urlPath });
      assert.equal(res.status, 200, urlPath);
      assert.match(res.headers['content-type'], type, urlPath);
    }
  });

  test('index.html loads app.js as a module and has no inline script or event handler', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    assert.match(html, /<script type="module" src="app\.js"><\/script>/);
    const scripts = html.match(/<script\b[^>]*>/g) || [];
    assert.ok(scripts.every((tag) => /\ssrc=/.test(tag)), 'every script has a src');
    assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, 'no inline event handlers');
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/);
  });

  test('the markup app.js builds has no inline event handlers or javascript: links', () => {
    for (const file of ['app.js', 'lib.js']) {
      const js = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
      assert.doesNotMatch(js, /<[a-z][^>]*\son[a-z]+\s*=/i, `${file}: inline handler in markup`);
      assert.doesNotMatch(js, /javascript:/i, file);
      assert.doesNotMatch(js, /\beval\(|new Function\(/, file);
    }
  });

  test('Talk with Wila and Ask Wila are hidden until S6; the Wila orb stays', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
    for (const gone of ['tabChat', 'paneChat', 'chatForm', 'mapAsk', 'mapRead', 'data-chat', 'claude.use', 'localStorage']) {
      assert.ok(!html.includes(gone) && !js.includes(gone), gone);
    }
    assert.doesNotMatch(html + js, /Talk with Wila|Ask Wila/);
    assert.match(html, /id="wilaOrb"/);
    assert.match(html, /id="dialogue"/);
    assert.match(html, /aria-label="Article notes"/);
  });
});
