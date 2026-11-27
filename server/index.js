// The Desk's local server. node:http only, no framework.
// S1: serves app/ on 127.0.0.1 and refuses requests whose Host header isn't this machine.
// S2 adds /api/feed and /api/state (reading and writing under deskHome).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, HOST, resolveDeskHome, resolvePort } from './config.js';

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
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
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
    'Content-Type': MIME[path.extname(found.filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': found.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(found.filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Builds the server without listening, so tests can start it on a random port
 * with a temporary DESK_HOME.
 * @param {{ deskHome?: string, appDir?: string, log?: Pick<Console, 'error'> }} [options]
 */
export function createServer({ deskHome = resolveDeskHome(), appDir = APP_DIR, log = console } = {}) {
  const root = path.resolve(appDir);

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

      // S2: /api/feed and /api/state go here, reading and writing under deskHome.
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return sendText(res, 404, 'Not found\n');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      }
      await serveStatic(req, res, root, url.pathname);
    } catch (err) {
      log.error('The Desk server error:', err);
      if (!res.headersSent) sendText(res, 500, 'Something went wrong\n');
      else res.destroy();
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
