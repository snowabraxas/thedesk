// The Desk's local server. node:http only, no framework.
// Serves app/ on 127.0.0.1, refuses requests whose Host header isn't this machine, and answers
// /api/feed (the edition) and /api/state (Snow's reads and notes) from under deskHome.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, HOST, SAMPLE_FEED_PATH, resolveDeskHome, resolvePort, statePath } from './config.js';
import { loadFeed } from './feed.js';
import { CorruptStateError, MAX_STATE_BYTES, checkState, createStateStore } from './state-store.js';

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
 * @param {{ deskHome?: string, appDir?: string, log?: Pick<Console, 'error'>, fsp?: typeof fs.promises, samplePath?: string }} [options]
 *   fsp lets tests make a state write fail part way; samplePath is the edition shown when there is no feed.json.
 */
export function createServer({ deskHome = resolveDeskHome(), appDir = APP_DIR, log = console, fsp, samplePath = SAMPLE_FEED_PATH } = {}) {
  const root = path.resolve(appDir);
  const state = createStateStore(statePath(deskHome), fsp ? { fsp } : {});

  async function getState(res) {
    try {
      return sendJson(res, 200, await state.read());
    } catch (err) {
      // Leave the file alone so it can be recovered. The app sees the 500 and doesn't save over it.
      const why = err instanceof CorruptStateError ? err.message : `can't read ${state.filePath} (${err.code || err.message})`;
      log.error(`The Desk: ${why}. Saving is paused until it's fixed.`);
      return sendJson(res, 500, { error: "Your saved state couldn't be read, so it was left untouched." });
    }
  }

  async function putState(req, res) {
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
    const check = checkState(value);
    if (!check.ok) return sendJson(res, 400, { error: check.error });
    try {
      await state.write(value);
    } catch (err) {
      log.error(`The Desk: couldn't save ${state.filePath} (${err.code || err.message}). The previous state is untouched.`);
      return sendJson(res, 500, { error: "Couldn't save just now. The previous state is untouched." });
    }
    return sendJson(res, 200, { ok: true });
  }

  async function handleApi(req, res, pathname) {
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (pathname === '/api/feed') {
      if (!isRead) return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
      return sendJson(res, 200, await loadFeed(deskHome, { log, samplePath }));
    }
    if (pathname === '/api/state') {
      if (isRead) return getState(res);
      if (req.method === 'PUT') return putState(req, res);
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
  return server;
}

/** Starts The Desk on 127.0.0.1:PORT (default 4321). Used by `npm start` and `npm run dev`. */
export function start(env = process.env) {
  let port;
  try {
    port = resolvePort(env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const deskHome = resolveDeskHome(env);
  const server = createServer({ deskHome });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Is The Desk already running?`);
    } else {
      console.error('The Desk could not start:', err.message);
    }
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.log(`The Desk is running at http://localhost:${port} (data: ${deskHome})`);
  });

  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', stop);
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
