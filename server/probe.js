// Asks a port whether The Desk is answering there: GET /api/feed must answer 200 with the
// X-Desk-Feed-Source header that only The Desk sends. Used by the service health check and
// status, and by `npm start` / `npm run dev` to explain a port that is already taken.
import { HOST } from './config.js';

/**
 * @param {number} port
 * @param {{ host?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, source: string } | { ok: false, status?: number, error?: string }>} never throws
 */
export async function probeDesk(port, { host = HOST, timeoutMs = 2000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/api/feed`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const source = res.headers.get('x-desk-feed-source');
    await res.arrayBuffer().catch(() => {});
    if (res.ok && source) return { ok: true, source };
    return { ok: false, status: res.status };
  } catch (err) {
    // ECONNREFUSED and friends sit on err.cause; a timeout is a DOMException named TimeoutError
    // (whose numeric legacy .code means nothing here).
    const code = [err?.cause?.code, err?.code].find((c) => typeof c === 'string');
    return { ok: false, error: code || err?.name || String(err) };
  }
}
