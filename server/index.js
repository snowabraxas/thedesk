// The Desk's local server. node:http only, no framework.
// Serves app/ on 127.0.0.1, refuses requests whose Host header isn't this machine (every route,
// the API included), and answers from under deskHome:
//   GET /api/feed              Product Feed's edition; X-Desk-Feed-Source says which (feed.js)
//   GET/PUT /api/state         Snow's Product Feed state: reads, notes, XP, streak (state-store.js)
//   GET /api/news              News's morning edition; X-Desk-News-Source says which (news.js)
//   GET /api/breaking          {"breaking": today's breaking story or null} (news.js)
//   GET/PUT /api/news/state    Snow's News state: stories read, banners dismissed, shelf open
// The edition sources are live, last-good, edition:<YYYY-MM-DD.json> or sample.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, HOST, REPO_ROOT, SAMPLE_FEED_PATH, SAMPLE_NEWS_PATH, expandHome, resolveDeskHome, resolvePort, servicePlistPath } from './config.js';
import { describeDeployed, readDeployed } from './deployed.js';
import { createFeedLoader } from './feed.js';
import { createLogger, rotateLog } from './log-file.js';
import { createBreakingReader, createNewsLoader } from './news.js';
import { probeDesk } from './probe.js';
import { CorruptStateError, MAX_STATE_BYTES, StateTooLargeError, createStateStore } from './state-store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Sent with every response. The app has no inline scripts or event handlers, so script-src 'self'
// holds; styles allow inline because the room positions its hotspots with style attributes.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * Only answer requests addressed to this machine on our own port. A web page on another
 * site that rebinds its DNS to 127.0.0.1 still sends its own Host, so it gets refused.
 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !port) return false;
  const host = hostHeader.trim().toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

class BodyTooLargeError extends Error {}

/** Reads the request body, refusing it once it passes maxBytes. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      fn(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) return finish(reject, new BodyTooLargeError());
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => finish(reject, err));
  });
}

/**
 * Maps a URL path to a file inside root, or null. Refuses "..", dotfiles, encoded
 * separators that would climb out, NUL bytes, and symlinks that point outside root.
 */
export async function resolveStaticFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.') || s.includes('\\'))) return null;

  const base = path.resolve(root);
  let filePath = path.join(base, ...segments);
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;

  try {
    let stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.promises.stat(filePath);
    }
    if (!stat.isFile()) return null;
    const [realBase, realFile] = await Promise.all([fs.promises.realpath(base), fs.promises.realpath(filePath)]);
    if (!realFile.startsWith(realBase + path.sep)) return null;
    return { filePath: realFile, size: stat.size };
  } catch {
    return null;
  }
}

async function serveStatic(req, res, root, pathname) {
  const found = await resolveStaticFile(root, pathname);
  if (!found) return sendText(res, 404, 'Not found\n');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(found.filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': found.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(found.filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const isJsonType = (header) => (header || '').split(';')[0].trim().toLowerCase() === 'application/json';

/**
 * Builds the server without listening, so tests can start it on a random port
 * with a temporary DESK_HOME.
 * @param {{ deskHome?: string, appDir?: string, log?: { error: Function, info?: Function }, fsp?: typeof fs.promises, samplePath?: string, newsSamplePath?: string, now?: () => number }} [options]
 *   fsp lets tests make a state write fail part way; samplePath and newsSamplePath are the
 *   Product Feed and News editions shown when there is no valid one; now picks the moment that
 *   counts as "today" for /api/breaking.
 */
export function createServer({
  deskHome = resolveDeskHome(),
  appDir = APP_DIR,
  log = console,
  fsp,
  samplePath = SAMPLE_FEED_PATH,
  newsSamplePath = SAMPLE_NEWS_PATH,
  now = Date.now,
} = {}) {
  const root = path.resolve(appDir);
  const storeOptions = fsp ? { fsp, now } : { now };
  // Each desk's saved state, by route. Both follow the same rules (state-store.js).
  const stateRoutes = new Map([
    ['/api/state', createStateStore(deskHome, 'product-feed', storeOptions)],
    ['/api/news/state', createStateStore(deskHome, 'news', storeOptions)],
  ]);
  const feeds = createFeedLoader(deskHome, { log, samplePath });
  const news = createNewsLoader(deskHome, { log, samplePath: newsSamplePath });
  const breaking = createBreakingReader(deskHome, { log, now });

  async function getState(res, state) {
    try {
      return sendJson(res, 200, await state.readForPage());
    } catch (err) {
      // Leave the file alone so it can be recovered. The app sees the 500 and doesn't save over it.
      const why = err instanceof CorruptStateError ? err.message : `can't read ${state.filePath} (${err.code || err.message})`;
      log.error(`The Desk: ${why}. Saving is paused until it's fixed.`);
      return sendJson(res, 500, { error: "Your saved state couldn't be read, so it was left untouched." });
    }
  }

  async function putState(req, res, state) {
    if (!isJsonType(req.headers['content-type'])) {
      return sendJson(res, 415, { error: 'Send the state as application/json.' });
    }
    // No "Connection: close" here: Node reads and drops the rest of the body after we answer,
    // so the client gets the 413 instead of a connection reset mid-upload.
    const tooLarge = () => sendJson(res, 413, { error: `The state is over ${MAX_STATE_BYTES} bytes.` });
    if (Number(req.headers['content-length']) > MAX_STATE_BYTES) return tooLarge();
    let text;
    try {
      text = await readBody(req, MAX_STATE_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return tooLarge();
      throw err;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return sendJson(res, 400, { error: 'The state is not valid JSON.' });
    }
    const check = state.check(value);
    if (!check.ok) return sendJson(res, 400, { error: check.error });
    try {
      await state.write(value);
    } catch (err) {
      if (err instanceof StateTooLargeError) return tooLarge();
      if (err instanceof CorruptStateError) {
        // Each save is merged into the file as it is now, so a file that can't be read isn't saved over.
        log.error(`The Desk: ${err.message}. Saving is paused until it's fixed.`);
        return sendJson(res, 500, { error: "Your saved state couldn't be read, so it was left untouched." });
      }
      log.error(`The Desk: couldn't save ${state.filePath} (${err.code || err.message}). The previous state is untouched.`);
      return sendJson(res, 500, { error: "Couldn't save just now. The previous state is untouched." });
    }
    return sendJson(res, 200, { ok: true });
  }

  async function handleApi(req, res, pathname) {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (pathname === '/api/feed') {
      if (!isRead) return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      const { feed, source } = await feeds.load();
      return sendJson(res, 200, feed, { 'X-Desk-Feed-Source': source });
    }
    if (pathname === '/api/news') {
      if (!isRead) return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      const { news: edition, source } = await news.load();
      return sendJson(res, 200, edition, { 'X-Desk-News-Source': source });
    }
    if (pathname === '/api/breaking') {
      if (!isRead) return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      return sendJson(res, 200, { breaking: await breaking.load() });
    }
    const state = stateRoutes.get(pathname);
    if (state) {
      if (isRead) return getState(res, state);
      if (req.method === 'PUT') return putState(req, res, state);
      return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD, PUT' });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, server.address()?.port)) {
        return sendText(res, 403, 'Forbidden: The Desk only answers on localhost.\n');
      }

      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return sendText(res, 400, 'Bad request\n');
      }

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url.pathname);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      }
      await serveStatic(req, res, root, url.pathname);
    } catch (err) {
      log.error('The Desk server error:', err);
      if (res.headersSent) res.destroy();
      else if (/^\/api(\/|$|\?)/.test(req.url || '')) sendJson(res, 500, { error: 'Something went wrong' });
      else sendText(res, 500, 'Something went wrong\n');
    }
  });

  server.desk = { deskHome, appDir: root };
  /** Resolves once every state save queued so far has finished (start()'s stop waits for it). */
  server.settled = () => Promise.all([...stateRoutes.values()].map((store) => store.settled())).then(() => {});
  return server;
}

/**
 * What to say when PORT is taken. The always-on service (scripts/service.js) runs on 4321, so a
 * second copy started for development needs another port.
 * @param {{ port: number, deskAnswers: boolean, serviceInstalled: boolean, isService: boolean }} facts
 *   deskAnswers: The Desk itself answers on that port; serviceInstalled: the launchd plist exists;
 *   isService: this process was started by launchd (DESK_SERVICE=1).
 */
export function portInUseMessage({ port, deskAnswers, serviceInstalled, isService }) {
  const otherPort = port < 65535 ? port + 1 : port - 1;
  const elsewhere = `use another port: PORT=${otherPort} npm run dev`;
  if (isService) {
    const holder = deskAnswers ? 'another copy of The Desk (npm run dev or npm start in a Terminal?)' : 'another program';
    return `The Desk service can't start: port ${port} is taken by ${holder}. launchd tries again every few seconds, so it starts by itself once that one stops.`;
  }
  if (deskAnswers && serviceInstalled) {
    return `Port ${port} is taken: The Desk is already running at http://localhost:${port}, as the always-on service or in another Terminal (npm run service:status tells you which). To run this copy alongside it, ${elsewhere}`;
  }
  if (deskAnswers) {
    return `Port ${port} is taken: The Desk is already running at http://localhost:${port} (npm run dev or npm start in another Terminal?). Stop that one with Ctrl+C, or ${elsewhere}`;
  }
  return `Port ${port} is taken by another program. To run The Desk anyway, ${elsewhere}`;
}

async function explainPortInUse(port, env) {
  const desk = await probeDesk(port, { timeoutMs: 1500 });
  let serviceInstalled = false;
  try {
    serviceInstalled = fs.existsSync(servicePlistPath());
  } catch {
    /* no home folder: no service */
  }
  return portInUseMessage({ port, deskAnswers: desk.ok, serviceInstalled, isService: env.DESK_SERVICE === '1' });
}

/**
 * What the server says once it listens: where, on which data, and, in the live copy that
 * npm run deploy keeps (it has a .deployed.json next to server/), which commit is live.
 */
export function startedLines({ port, deskHome, deployed = null }) {
  const lines = [`The Desk is running at http://localhost:${port} (data: ${deskHome})`];
  if (deployed) lines.push(`The Desk: this is ${describeDeployed(deployed)}${deployed.deployedAt ? `, deployed ${deployed.deployedAt}` : ''}`);
  return lines;
}

/**
 * Starts The Desk on 127.0.0.1:PORT (default 4321). Used by `npm start`, `npm run dev` and the
 * always-on service. When DESK_LOG names the service's log file, a log over 5 MB is rotated first.
 * Every line it writes starts with the local time (see createLogger). On SIGTERM (launchd stopping
 * it) or SIGINT (Ctrl+C) it says so, closes the server and exits 0.
 * @param {Record<string, string|undefined>} [env]
 * @param {{ logger?: ReturnType<typeof createLogger>, codeDir?: string }} [options] codeDir: where to look for .deployed.json
 */
export function start(env = process.env, { logger = createLogger(), codeDir = REPO_ROOT } = {}) {
  let port;
  try {
    port = resolvePort(env);
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  const deskHome = resolveDeskHome(env);
  const logFile = (env.DESK_LOG || '').trim();
  if (logFile) {
    const old = rotateLog(path.resolve(expandHome(logFile)));
    if (old) logger.info(`The Desk: the log passed 5 MB, so its older lines moved to ${old}.`);
  }
  const server = createServer({ deskHome, log: logger });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(await explainPortInUse(port, env));
    } else {
      logger.error('The Desk could not start:', err.message);
    }
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    for (const line of startedLines({ port, deskHome, deployed: readDeployed(codeDir) })) logger.info(line);
  });

  // Stopping: close the server, let the saves already queued finish (so state.json is whole and
  // up to date), then exit; never longer than 2 s.
  const stop = (signal) => {
    logger.info(`The Desk is stopping (${signal})`);
    const exit = () => process.exit(0);
    server.close(() => server.settled().then(exit, exit));
    server.closeAllConnections?.();
    setTimeout(exit, 2000).unref();
  };
  process.once('SIGINT', stop); // a signal listener is called with the signal's name
  process.once('SIGTERM', stop);
  return server;
}

function runDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runDirectly()) start();
