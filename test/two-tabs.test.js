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

  test('even when the other tab saves first (no catch-up at all), the note and the folder both survive', async () => {
    const pane = await openTab(desk, { delay: 60_000 });
    const browser = await openTab(desk, { delay: 60_000 });
    await pane.note('written just before switching', { wait: true });
    await browser.show(); // the pane's save is still waiting
    await browser.folder('Later');
    await pane.hide(); // the pane's save lands last, and doesn't know the folder
    const feed = await feedState();
    assert.deepEqual([feed.notes.length, feed.folders.length], [1, 1], 'nothing lost: the server merges notes and folders by item');
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

describe('merged by item: nothing of Snow\'s is lost to the other tab (N4c)', () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const gap of [0, 30, 100]) {
    test(`a fast switch ${gap} ms after reading a story: the read survives the other tab's save`, async () => {
      const pane = await openTab(desk, { delay: 600 });
      const browser = await openTab(desk, { delay: 600 });
      await pane.readStory(S1, { wait: true });
      await wait(gap);
      await Promise.all([pane.hide(), browser.show().then(() => {
        browser.N.shelfOpen = true;
        return browser.saveNews();
      })]);
      const news = await newsState();
      assert.ok(news.read[S1], 'still read');
      assert.equal(news.shelfOpen, true);
    });

    test(`a fast switch ${gap} ms after writing a note: the note survives the other tab's save`, async () => {
      const pane = await openTab(desk, { delay: 600 });
      const browser = await openTab(desk, { delay: 600 });
      await pane.note('just before switching', { wait: true });
      await wait(gap);
      await Promise.all([pane.hide(), browser.show().then(() => browser.folder('Later'))]);
      const feed = await feedState();
      assert.deepEqual([feed.notes.length, feed.folders.length], [1, 1]);
    });
  }

  test("writing a note in a tab whose drawer kept it from catching up doesn't wipe the other tab's read", async () => {
    const reader = await openTab(desk);
    const writer = await openTab(desk); // its notes drawer is open: it never catches up
    await reader.readArticle('a1');
    await reader.readStory(S1);
    await writer.note('written with the drawer open');
    const feed = await feedState();
    assert.ok(feed.read.a1, 'the read survived');
    assert.equal(feed.notes.length, 1);
    assert.ok((await newsState()).read[S1]);
  });

  test('an un-mark reaches the other tab, and its stale save can\'t bring the read back', async () => {
    const pane = await openTab(desk);
    await pane.readArticle('a1');
    await pane.readStory(S1);
    const browser = await openTab(desk); // sees both read
    await pane.readArticle('a1'); // un-mark
    await pane.readStory(S1);
    await browser.note('a stale save');
    browser.N.shelfOpen = true;
    await browser.saveNews();
    assert.equal((await feedState()).read.a1, undefined);
    assert.equal((await newsState()).read[S1], undefined);
    await browser.show();
    assert.equal(browser.S.read.a1, undefined, 'and the other tab sees it once it catches up');
  });

  test("a deleted note stays deleted: a stale tab can't bring it back", async () => {
    const pane = await openTab(desk);
    const n = await pane.note('to delete');
    const browser = await openTab(desk); // has the note
    await pane.deleteNote(n.id);
    await browser.folder('Later'); // a stale save that still carries the deleted note
    assert.deepEqual((await feedState()).notes, []);
    await pane.restoreNote(n); // Undo brings it back on purpose
    assert.deepEqual((await feedState()).notes.map((x) => x.id), [n.id]);
  });

  test('a deleted folder (and what was saved in it) reaches the other tab', async () => {
    const pane = await openTab(desk);
    const f = await pane.folder('Evals');
    await pane.setSaved('a1', f.id, true);
    const browser = await openTab(desk);
    await pane.deleteFolder(f.id);
    await browser.note('a stale save that still has the folder');
    const feed = await feedState();
    assert.deepEqual([feed.folders, feed.saved], [[], {}]);
  });

  test('a rename in one tab survives a stale copy from the other; the later rename wins', async () => {
    const pane = await openTab(desk);
    const f = await pane.folder('Evals');
    const browser = await openTab(desk);
    await pane.renameFolder(f.id, 'Evals reading');
    await browser.note('stale');
    assert.equal((await feedState()).folders[0].name, 'Evals reading');
    await browser.renameFolder(f.id, 'Evals, later');
    assert.equal((await feedState()).folders[0].name, 'Evals, later');
  });

  test('old pages (no lists): their saves add, never delete, and never bring a deleted item back', async () => {
    const pane = await openTab(desk);
    const doomed = await pane.note('will be deleted');
    const old = await openTab(desk, { old: true }); // loaded with the note
    await pane.deleteNote(doomed.id);
    await pane.readArticle('a2');
    await old.note('from the old page');
    const feed = await feedState();
    assert.deepEqual(feed.notes.map((x) => x.text), ['from the old page']);
    assert.ok(feed.read.a2, "the new page's read survived the old page's save");
  });
});

describe('invariants over long mixed sessions: everything exact', () => {
  // mulberry32: a small seeded random generator, so a failure can be replayed.
  const random = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: reads, notes, folders, saved items, XP and payments match what Snow did`, async () => {
      const rnd = random(seed);
      const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
      // What Snow did, in order, as each tab saw it: the model the server must end up holding.
      const model = { read: new Set(), stories: new Set(), notes: new Map(), folders: new Map(), saved: new Set() };
      const tabs = [await openTab(desk), await openTab(desk)];
      const closed = [];
      let made = 0;
      for (let step = 0; step < 150; step++) {
        const i = Math.floor(rnd() * tabs.length);
        const tab = tabs[i];
        const action = pick(['article', 'article', 'story', 'story', 'note', 'deleteNote', 'folder', 'rename', 'deleteFolder', 'save', 'save', 'show', 'close']);
        if (action === 'article') {
          const id = pick(['a1', 'a2', 'a3', 'a4', 'a5']);
          const r = await tab.readArticle(id);
          if (r.read) model.read.add(id); else model.read.delete(id);
        } else if (action === 'story') {
          const key = pick(['2026-12-07/s1', '2026-12-07/s2', '2026-12-07/s3', '2026-12-07/m1']);
          const r = await tab.readStory(key);
          if (r.read) model.stories.add(key); else model.stories.delete(key);
        } else if (action === 'note') {
          const n = await tab.note(`note ${step}`, { id: `n${made++}` });
          model.notes.set(n.id, n.text);
        } else if (action === 'deleteNote' && tab.S.notes.length) {
          const n = pick(tab.S.notes);
          await tab.deleteNote(n.id);
          model.notes.delete(n.id);
        } else if (action === 'folder') {
          const f = await tab.folder(`folder ${step}`, { id: `f${made++}` });
          model.folders.set(f.id, f.name);
        } else if (action === 'rename' && tab.S.folders.length) {
          const f = pick(tab.S.folders);
          await tab.renameFolder(f.id, `renamed ${step}`);
          model.folders.set(f.id, `renamed ${step}`); // a listed edit wins, even over a delete it never saw
        } else if (action === 'deleteFolder' && tab.S.folders.length) {
          const f = pick(tab.S.folders);
          await tab.deleteFolder(f.id);
          model.folders.delete(f.id);
          for (const pair of [...model.saved]) if (JSON.parse(pair)[1] === f.id) model.saved.delete(pair);
        } else if (action === 'save' && tab.S.folders.length) {
          const f = pick(tab.S.folders);
          const a = pick(['a1', 'a2', 'a3']);
          const on = !(tab.S.saved[a] || []).includes(f.id);
          await tab.setSaved(a, f.id, on);
          const pair = JSON.stringify([a, f.id]);
          if (on && model.folders.has(f.id)) model.saved.add(pair);
          if (!on) model.saved.delete(pair);
        } else if (action === 'show') await tab.show();
        else if (action === 'close') {
          await tab.close();
          closed.push(tab);
          tabs[i] = await openTab(desk);
        }
      }
      for (const tab of tabs) await Promise.all([tab.feed.flush(), tab.news.flush()]);
      const [feed, news] = await Promise.all([feedState(), newsState()]);
      const paid = [...closed, ...tabs].flatMap((t) => t.paid);
      const pairs = new Set(Object.entries(feed.saved || {}).flatMap(([a, fs]) => fs.map((f) => JSON.stringify([a, f]))));
      assert.deepEqual(Object.keys(feed.read || {}).sort(), [...model.read].sort(), 'Product Feed reads');
      assert.deepEqual(Object.keys(news.read || {}).sort(), [...model.stories].sort(), 'News reads');
      assert.deepEqual(new Map((feed.notes || []).map((n) => [n.id, n.text])), model.notes, 'notes');
      assert.deepEqual(new Map((feed.folders || []).map((f) => [f.id, f.name])), model.folders, 'folders');
      assert.deepEqual(pairs, model.saved, 'saved items');
      assert.equal(new Set(paid).size, paid.length, 'nothing paid twice');
      assert.equal(feed.xp, 10 * paid.length, 'XP is 10 per payment');
      assert.deepEqual(Object.keys(feed.awarded || {}).sort(), paid.filter((k) => !k.includes('/')).sort(), 'article payments recorded');
      assert.deepEqual(Object.keys(news.awarded || {}).sort(), paid.filter((k) => k.includes('/')).sort(), 'story payments recorded');
    });
  }
});
