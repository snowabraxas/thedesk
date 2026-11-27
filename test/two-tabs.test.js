// Two tabs on one Desk (Snow uses the Claude app's pane and a browser), on the real server.
// The server merges every save into the file as it is now (server/state-store.js); the pages check
// the server before paying and reload when idle. Each scenario below lost XP or paid twice before.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { disposeAll, openTab, startDesk } from './helpers/tabs.js';

const S1 = '2026-12-07/s1';
const AT = '2026-12-07T12:04:00-05:00';

let desk;
before(async () => {
  desk = await startDesk();
});
after(() => desk.stop());
beforeEach(() => desk.reset());
afterEach(() => disposeAll());

const feedState = () => desk.get('/api/state');
const newsState = () => desk.get('/api/news/state');
const seedXp = async (xp) => assert.equal((await desk.put('/api/state', { xp })).status, 200);

describe('XP across tabs', () => {
  test('a stale tab saving a note keeps the XP the other tab earned (was 40 to 15)', async () => {
    await seedXp(15);
    const pane = await openTab(desk);
    const browser = await openTab(desk);
    await browser.readArticle('a1');
    await browser.readArticle('a2');
    browser.S.folders.push({ id: 'f1', name: 'Evals' });
    browser.S.xp += 5; // first folder
    await browser.saveFeed();
    assert.equal((await feedState()).xp, 40);
    await pane.note('written in the pane, which still thinks XP is 15');
    assert.equal((await feedState()).xp, 40, 'the stale save did not take XP back to 15');
    assert.equal((await feedState()).notes.length, 1);
  });

  test("a stale tab's own XP lands on top of the latest total, even when it can't reload first", async () => {
    await seedXp(15);
    const pane = await openTab(desk);
    const browser = await openTab(desk);
    await browser.readArticle('a1');
    pane.S.notes.push({ id: 'n1', a: 'a1', text: 'waiting', ts: 1 });
    pane.feed.save(); // a change is waiting, so the pane can't reload before paying
    await pane.readArticle('a2');
    assert.equal(pane.S.xp, 25, 'the pane still counts from its old 15');
    assert.equal((await feedState()).xp, 35, '15 + 10 from the browser + 10 from the pane');
  });

  test('a page still running old code (no _sync) never lowers XP', async () => {
    await seedXp(15);
    const old = await openTab(desk, { old: true });
    const browser = await openTab(desk);
    await browser.readArticle('a1');
    await browser.readArticle('a2');
    await old.note('from an old tab');
    assert.equal((await feedState()).xp, 35);
  });
});

describe('payments across tabs', () => {
  test('closing a stale page keeps the payment it never saw (was erased, then paid twice)', async () => {
    const pane = await openTab(desk, { delay: 60_000 });
    const browser = await openTab(desk);
    await browser.readStory(S1);
    await browser.readArticle('a1');
    pane.N.shelfOpen = true;
    pane.news.save();
    pane.S.folders.push({ id: 'f1', name: 'Later' });
    pane.feed.save();
    assert.deepEqual(await pane.close(), [true, true], 'both changes went out on the way out');
    const [news, feed] = await Promise.all([newsState(), feedState()]);
    assert.ok(news.awarded[S1], 'the News payment survived');
    assert.equal(news.shelfOpen, true);
    assert.ok(feed.awarded.a1, 'the Product Feed payment survived');
    assert.equal(feed.folders.length, 1);
    const later = await openTab(desk);
    assert.equal((await later.readStory(S1)).award, false);
    later.S.read = {};
    assert.equal((await later.readArticle('a1')).award, false);
    assert.deepEqual([...browser.paid, ...later.paid], [S1, 'a1'], 'each paid once');
    assert.equal((await feedState()).xp, 20);
  });

  test("a stale tab that never saw the payment checks the server and doesn't pay again", async () => {
    const pane = await openTab(desk);
    const browser = await openTab(desk);
    await browser.readStory(S1);
    await browser.readArticle('a1');
    assert.equal((await pane.readStory(S1)).award, false);
    assert.equal((await pane.readArticle('a1')).award, false);
    assert.equal((await feedState()).xp, 20);
  });

  test('a page with no awarded and no _sync (old code) can erase neither payments nor dismissals', async () => {
    const old = await openTab(desk, { old: true });
    const browser = await openTab(desk);
    await browser.readArticle('a1');
    await browser.readStory(S1);
    browser.N.dismissed[AT] = 5;
    await browser.saveNews();
    await old.note('old tab');
    assert.equal('awarded' in old.S, false);
    assert.equal((await desk.put('/api/news/state', { read: {}, shelfOpen: true })).status, 200, 'an old News state with no awarded or dismissed');
    const [feed, news] = await Promise.all([feedState(), newsState()]);
    assert.ok(feed.awarded.a1);
    assert.equal(feed.xp, 20);
    assert.ok(news.awarded[S1]);
    assert.deepEqual(news.dismissed, { [AT]: 5 });
  });

  test('read stays each tab\'s own, so un-marking still works; the payment stays', async () => {
    const pane = await openTab(desk);
    await pane.readStory(S1);
    await pane.readStory(S1);
    const news = await newsState();
    assert.equal(news.read[S1], undefined);
    assert.ok(news.awarded[S1]);
    assert.equal((await pane.readStory(S1)).award, false);
  });
});

describe('a reply cut after the save (a restart during a deploy)', () => {
  test('the retry of a PUT that already landed adds its XP once', async () => {
    await seedXp(40);
    let cut = 0;
    const fetchFn = async (url, opts = {}) => {
      const r = await fetch(url, opts);
      if (opts.method === 'PUT' && url.endsWith('/api/state') && cut < 1) {
        cut++;
        await r.text();
        throw new TypeError('the connection was cut after the save'); // saved, but the page never hears back
      }
      return r;
    };
    const pane = await openTab(desk, { fetchFn, retryDelay: 30 });
    await pane.readArticle('a1'); // pays 10; its PUT lands, the reply is cut
    assert.equal(pane.feed.dirty, true, 'the page thinks it failed');
    while (pane.feed.dirty || !pane.feed.idle) await new Promise((r) => setTimeout(r, 10)); // the retry
    assert.equal(cut, 1);
    assert.equal((await feedState()).xp, 50, 'not 60');
  });
});

describe('a quick tab switch, inside the 600 ms save delay', () => {
  test('a note written just before switching reaches the other tab, and its next save keeps it', async () => {
    const pane = await openTab(desk, { delay: 60_000 });
    const browser = await openTab(desk, { delay: 60_000 });
    await pane.note('written just before switching', { wait: true });
    await pane.hide(); // the pane is left: its waiting save goes now
    await browser.show(); // the browser comes into view: it catches up
    assert.equal(browser.S.notes.length, 1, 'the browser has the note');
    browser.S.folders.push({ id: 'f1', name: 'Later' });
    await browser.saveFeed();
    assert.equal((await feedState()).notes.length, 1, "the browser's save kept it");
  });

  test('a story read just before switching stays read after the other tab saves', async () => {
    const pane = await openTab(desk, { delay: 60_000 });
    const browser = await openTab(desk, { delay: 60_000 });
    await pane.readStory(S1, { wait: true });
    await pane.hide();
    await browser.show();
    assert.ok(browser.N.read[S1], 'the browser sees it read');
    browser.N.shelfOpen = true;
    await browser.saveNews();
    const news = await newsState();
    assert.ok(news.read[S1], 'still read');
    assert.equal(news.shelfOpen, true);
  });

  test('without sending on leaving (before), the switch loses the note', async () => {
    const pane = await openTab(desk, { delay: 60_000 });
    const browser = await openTab(desk, { delay: 60_000 });
    await pane.note('written just before switching', { wait: true });
    await browser.show(); // the pane's save is still waiting
    browser.S.folders.push({ id: 'f1', name: 'Later' });
    await browser.saveFeed();
    await pane.hide(); // the pane's save lands afterwards and is last: but the browser had already saved without it
    await browser.show();
    // Last-save-wins: whichever saved last decides; here the pane's late save restores the note, but the folder is lost instead.
    const feed = await feedState();
    assert.equal(feed.notes.length + feed.folders.length, 1, 'one of the two changes was lost');
  });
});

describe('the refresh race', () => {
  test('a change made while a reload is out is never replaced by the reloaded copy', async () => {
    let holding = false;
    let release = null;
    const fetchFn = async (url, opts = {}) => {
      if (holding && !opts.method) {
        holding = false;
        await new Promise((r) => (release = r));
      }
      return fetch(url, opts);
    };
    const pane = await openTab(desk, { fetchFn, delay: 60_000 }); // the change waits, as the app's 600 ms debounce does
    const browser = await openTab(desk);
    await browser.readStory(S1);
    holding = true; // hold the next GET
    const reloading = pane.reloadNews();
    while (!release) await new Promise((r) => setImmediate(r));
    pane.N.shelfOpen = true; // Snow opens the shelf while the reload is out
    pane.news.save();
    release();
    assert.deepEqual(await reloading, { ok: false });
    assert.equal(pane.N.shelfOpen, true, 'kept');
    await pane.news.flush();
    const news = await newsState();
    assert.equal(news.shelfOpen, true);
    assert.ok(news.awarded[S1], 'and the browser\'s payment is still there');
  });
});

describe('invariants over a long mixed session', () => {
  // mulberry32: a small seeded random generator, so a failure can be replayed.
  const random = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (const seed of [1, 2, 3]) {
    test(`seed ${seed}: XP never lost, payments never lost, nothing paid twice`, async () => {
      const rnd = random(seed);
      const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
      const tabs = [await openTab(desk, { delay: 60_000 }), await openTab(desk, { delay: 60_000 })];
      const closed = [];
      const dismissed = new Set();
      for (let step = 0; step < 120; step++) {
        const i = Math.floor(rnd() * tabs.length);
        const tab = tabs[i];
        const action = pick(['article', 'article', 'story', 'story', 'note', 'shelf', 'dismiss', 'reload', 'close', 'wait']);
        if (action === 'article') await tab.readArticle(pick(['a1', 'a2', 'a3', 'a4', 'a5']));
        else if (action === 'story') await tab.readStory(pick(['2026-12-07/s1', '2026-12-07/s2', '2026-12-07/s3', '2026-12-07/m1']));
        else if (action === 'note') await tab.note(`step ${step}`);
        else if (action === 'shelf') {
          tab.N.shelfOpen = !tab.N.shelfOpen;
          tab.news.save(); // left waiting: saved by a later flush or the page closing
        } else if (action === 'dismiss') {
          const at = `2026-12-0${1 + Math.floor(rnd() * 7)}T12:00:00-05:00`;
          tab.N.dismissed[at] = step;
          dismissed.add(at);
          tab.news.save();
        } else if (action === 'reload') await tab.reload();
        else if (action === 'close') {
          await tab.close();
          closed.push(tab);
          tabs[i] = await openTab(desk, { delay: 60_000 });
        } else await Promise.all([tab.feed.flush(), tab.news.flush()]);
      }
      for (const tab of tabs) await Promise.all([tab.feed.flush(), tab.news.flush()]);
      const paid = [...closed, ...tabs].flatMap((t) => t.paid);
      const [feed, news] = await Promise.all([feedState(), newsState()]);
      assert.equal(new Set(paid).size, paid.length, `nothing paid twice: ${paid.join(', ')}`);
      assert.equal(feed.xp, 10 * paid.length, 'XP is exactly 10 per payment');
      assert.deepEqual(Object.keys(feed.awarded || {}).sort(), paid.filter((k) => !k.includes('/')).sort(), 'every article payment is recorded');
      assert.deepEqual(Object.keys(news.awarded || {}).sort(), paid.filter((k) => k.includes('/')).sort(), 'every story payment is recorded');
      for (const at of dismissed) assert.ok(news.dismissed[at] !== undefined, `dismissal ${at} kept`);
      assert.ok(paid.length >= 5, `the session paid for something (${paid.length})`);
    });
  }
});
