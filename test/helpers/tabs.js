// Tabs on one Desk, for the two-tab tests: each tab has its Product Feed and News state clients,
// built exactly as app/app.js and app/news.js build them, and acts the way the pages do:
//   readArticle / readStory  check the server before paying, reload Product Feed's state alongside
//                            (when idle), and a payment adds 10 XP to the state the tab holds (award)
//   reload                   reload(apply), as on opening a desk or the tab coming back into view
//   close                    flushOnExit, as on pagehide
// Also an "old" client: a page still running main's code, which sends its whole state as it is
// (no _sync, maybe no awarded) and pays without checking.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateClient, readArticle } from '../../app/lib.js';
import { blankNewsState, normalizeNewsState, readStory } from '../../app/news-lib.js';
import { createServer } from '../../server/index.js';

const opened = new Set();
/**
 * Stops every tab opened so far (no more saves or retries), so a test that fails part way can't
 * leave a client retrying against a stopped server and keep the test process alive.
 */
export function disposeAll() {
  for (const tab of opened) {
    tab.feed.dispose();
    tab.news.dispose();
  }
  opened.clear();
}

/** A real server on a free port with its own temp DESK_HOME. */
export async function startDesk() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-tabs-'));
  const server = createServer({ deskHome: home, log: { error() {}, info() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    home,
    base,
    feedUrl: `${base}/api/state`,
    newsUrl: `${base}/api/news/state`,
    reset: () => fs.rmSync(path.join(home, 'desks'), { recursive: true, force: true }),
    get: async (route) => (await fetch(base + route)).json(),
    put: (route, value) => fetch(base + route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
    async stop() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Opens a tab. fetchFn lets a test hold a request. old: true is a page running main's code.
 * delay: the save debounce (a long one keeps a change waiting, for a page-close test).
 * paid counts the payments this tab made, by key.
 */
export async function openTab(desk, { old = false, fetchFn, delay = 0, retryDelay } = {}) {
  const tab = { S: null, N: blankNewsState(), paid: [] };
  // Every request is tracked, so a test can wait for a page-close flush to land (settled()).
  const inflight = new Set();
  const send = fetchFn || ((...args) => globalThis.fetch(...args));
  const opts = {
    ...(retryDelay ? { retryDelay } : {}),
    fetchFn: (...args) => {
      const p = Promise.resolve(send(...args));
      inflight.add(p);
      p.finally(() => inflight.delete(p)).catch(() => {});
      return p;
    },
  };
  tab.settled = async () => {
    while (inflight.size) await Promise.allSettled([...inflight]);
  };
  tab.feed = createStateClient({ url: desk.feedUrl, getState: () => tab.S, counters: old ? [] : ['xp'], delay, ...opts });
  tab.news = createStateClient({ url: desk.newsUrl, normalize: normalizeNewsState, empty: blankNewsState, getState: () => tab.N, delay, ...opts });
  opened.add(tab);
  const [f, n] = await Promise.all([tab.feed.load(), tab.news.load()]);
  if (!f.ok || !n.ok) throw new Error('a tab could not load');
  tab.S = f.state;
  tab.N = n.state;
  if (old) delete tab.S.awarded; // main's Product Feed state has no awarded

  const award = (xp, key) => {
    tab.S.xp += xp;
    tab.paid.push(key);
  };
  const saveFeed = async () => {
    tab.feed.save();
    await tab.feed.flush();
  };
  const saveNews = async () => {
    tab.news.save();
    await tab.news.flush();
  };
  tab.reloadFeed = () => tab.feed.reload((s) => { tab.S = s; });
  tab.reloadNews = () => tab.news.reload((s) => { tab.N = s; });
  tab.reload = () => Promise.all([tab.reloadFeed(), tab.reloadNews()]);
  tab.saveFeed = saveFeed;
  tab.saveNews = saveNews;

  tab.readArticle = async (id) => {
    if (old) {
      // main: marks read and pays 10, every time it isn't read
      if (tab.S.read[id]) delete tab.S.read[id];
      else {
        tab.S.read[id] = Date.now();
        award(10, id);
      }
      await saveFeed();
      return;
    }
    const r = await readArticle(() => tab.S, id, { canPay: tab.feed.canSave, peek: () => tab.feed.peek(), also: tab.reloadFeed });
    if (r.award) award(10, id);
    await saveFeed();
    return r;
  };
  // wait: true leaves the save waiting (the app's 600 ms delay), as when Snow switches tabs right away.
  tab.readStory = async (key, { wait = false } = {}) => {
    const r = await readStory(() => tab.N, key, { canPay: tab.news.canSave && tab.feed.canSave, peek: () => tab.news.peek(), also: tab.reloadFeed });
    if (wait) tab.news.save();
    else await saveNews();
    if (r.award) {
      award(10, key);
      await saveFeed();
    }
    return r;
  };
  tab.note = async (text, { wait = false } = {}) => {
    tab.S.notes.push({ id: `n${Math.random().toString(36).slice(2, 8)}`, a: 'a1', text, ts: Date.now() });
    if (wait) tab.feed.save();
    else await saveFeed();
  };
  /** The tab is hidden or loses focus: the page sends what is waiting at once (app.js sendNow). */
  tab.hide = () => Promise.all([tab.feed.flush(), tab.news.flush()]);
  /** The tab is shown or focused: the page reloads both states when idle (app.js syncTab). */
  tab.show = () => tab.reload();
  /** pagehide: flushOnExit on both, then wait for what it sent to land. Returns what each sent. */
  tab.close = async () => {
    const sent = [tab.feed.flushOnExit(), tab.news.flushOnExit()];
    await new Promise((r) => setImmediate(r));
    await tab.settled();
    return sent;
  };
  return tab;
}

