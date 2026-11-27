// Two tabs on one Desk (Snow uses the Claude app's pane and a browser): the real server, and two
// News state clients built exactly as app/news.js builds them, reading stories through readStory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createStateClient } from '../app/lib.js';
import { blankNewsState, dismissBreaking, mergeNewsState, normalizeNewsState, readStory, toggleRead } from '../app/news-lib.js';
import { createServer } from '../server/index.js';

const S1 = '2026-12-07/s1';
const S2 = '2026-12-07/s2';
const AT = '2026-12-07T12:04:00-05:00';

let server;
let port;
let home;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-sync-'));
  server = createServer({ deskHome: home, log: { error() {}, info() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => fs.rmSync(path.join(home, 'desks'), { recursive: true, force: true }));

const url = () => `http://127.0.0.1:${port}/api/news/state`;
const serverState = async () => (await fetch(url())).json();

/** A tab: its News state and its client, as news.js makes them. merge: false is the old, last-save-wins client. */
async function openTab({ merge = true } = {}) {
  const tab = { N: blankNewsState(), paid: 0 };
  tab.client = createStateClient({
    url: url(),
    normalize: normalizeNewsState,
    empty: blankNewsState,
    merge: merge ? mergeNewsState : null,
    getState: () => tab.N,
    delay: 0,
  });
  const r = await tab.client.load();
  assert.equal(r.ok, true);
  tab.N = r.state;
  tab.read = async (key) => {
    const r2 = merge
      ? await readStory(() => tab.N, key, { canPay: tab.client.canSave, peek: () => tab.client.peek() })
      : toggleRead(tab.N, key);
    if (r2.award) tab.paid++;
    await tab.save();
    return r2;
  };
  tab.save = async () => {
    tab.client.save();
    await tab.client.flush();
  };
  return tab;
}

describe('two tabs, one server', () => {
  test('a stale tab that only opens the shelf keeps the other tab\'s award, and the story never pays twice', async () => {
    const pane = await openTab();
    const browser = await openTab();
    assert.equal((await browser.read(S1)).award, true, 'the browser pays for s1');
    pane.N.shelfOpen = true; // the pane loaded before that, and only opens the shelf
    await pane.save();
    const saved = await serverState();
    assert.ok(saved.awarded[S1], 'the award survived the stale save');
    assert.equal(saved.shelfOpen, true);
    assert.equal((await pane.read(S1)).award, false, 'reading s1 in the pane does not pay again');
    assert.equal(pane.paid + browser.paid, 1);
  });

  test('a stale tab that has saved nothing still checks the server before paying', async () => {
    const pane = await openTab();
    const browser = await openTab();
    await browser.read(S1);
    assert.deepEqual(await pane.read(S1), { read: true, award: false });
    assert.equal(pane.paid + browser.paid, 1);
  });

  test('a dismissal in one tab survives a save from the other; read stays each tab\'s own, so un-marking works', async () => {
    const pane = await openTab();
    const browser = await openTab();
    await pane.read(S2);
    dismissBreaking(browser.N, AT, 5);
    await browser.save();
    assert.equal((await pane.read(S2)).read, false, 'the pane un-marks s2');
    const saved = await serverState();
    assert.deepEqual(saved.dismissed, { [AT]: 5 }, "the browser's dismissal is kept");
    assert.equal(saved.read[S2], undefined, "the pane's un-mark is saved");
    assert.ok(saved.awarded[S2], 'and s2 stays paid');
  });

  test('reload picks up the other tab only when nothing is waiting to be saved', async () => {
    const pane = await openTab();
    const browser = await openTab();
    await browser.read(S1);
    const r = await pane.client.reload();
    assert.equal(r.ok, true);
    assert.ok(r.state.awarded[S1]);
    pane.client.save(); // a change of the pane's own is waiting
    assert.deepEqual(await pane.client.reload(), { ok: false });
  });

  test('without the merge (the old client), the stale save erases the award and the story pays twice', async () => {
    const pane = await openTab({ merge: false });
    const browser = await openTab({ merge: false });
    await browser.read(S1);
    pane.N.shelfOpen = true;
    await pane.save();
    assert.equal((await serverState()).awarded[S1], undefined, 'erased');
    await pane.read(S1);
    assert.equal(pane.paid + browser.paid, 2, 'this is the bug the merge fixes');
  });
});
