// Two tabs on one Desk, Product Feed side: the real server, and two state clients built exactly as
// app/app.js builds them (merge: mergeFeedState), reading articles through readArticle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createStateClient, mergeFeedState, readArticle, toggleArticleRead } from '../app/lib.js';
import { createServer } from '../server/index.js';

let server;
let port;
let home;
before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-feed-sync-'));
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

const url = () => `http://127.0.0.1:${port}/api/state`;
const serverState = async () => (await fetch(url())).json();

/**
 * A tab: its Product Feed state and client, as app.js makes them. read() follows the click handler:
 * readArticle with peek, and also() reloading the state when nothing is waiting to be saved; a
 * payment adds 10 XP to the state the tab holds, as award() does. merge: false is the old client.
 */
async function openTab({ merge = true } = {}) {
  const tab = { S: null, paid: 0 };
  tab.client = createStateClient({ url: url(), getState: () => tab.S, merge: merge ? mergeFeedState : null, delay: 0 });
  const r = await tab.client.load();
  assert.equal(r.ok, true);
  tab.S = r.state;
  tab.save = async () => {
    tab.client.save();
    await tab.client.flush();
  };
  tab.reload = async () => {
    const r2 = await tab.client.reload();
    if (r2.ok) tab.S = r2.state;
  };
  tab.read = async (id) => {
    const r2 = merge
      ? await readArticle(() => tab.S, id, { canPay: tab.client.canSave, peek: () => tab.client.peek(), also: tab.reload })
      : toggleArticleRead(tab.S, id);
    if (r2.award) {
      tab.paid++;
      tab.S.xp += 10;
    }
    await tab.save();
    return r2;
  };
  return tab;
}

describe('Product Feed: two tabs, one server', () => {
  test("a stale tab that only makes a folder keeps the other tab's payment, and the article never pays twice", async () => {
    const pane = await openTab();
    const browser = await openTab();
    assert.equal((await browser.read('a1')).award, true);
    pane.S.folders.push({ id: 'f1', name: 'Evals' }); // the pane loaded before that read
    await pane.save();
    assert.ok((await serverState()).awarded.a1, 'the payment survived the stale save');
    assert.deepEqual(await pane.read('a1'), { read: true, award: false });
    assert.equal(pane.paid + browser.paid, 1);
  });

  test('a stale tab that has saved nothing checks the server before paying', async () => {
    const pane = await openTab();
    const browser = await openTab();
    await browser.read('a1');
    assert.deepEqual(await pane.read('a1'), { read: true, award: false });
    assert.equal(pane.paid + browser.paid, 1);
    assert.equal((await serverState()).xp, 10);
  });

  test('a payment in a stale tab goes onto the latest XP', async () => {
    const pane = await openTab();
    const browser = await openTab();
    await browser.read('a1');
    assert.equal((await pane.read('a2')).award, true);
    assert.equal((await serverState()).xp, 20, 'the pane reloaded before adding its 10');
  });

  test('un-marking still works, and the article stays paid', async () => {
    const pane = await openTab();
    await pane.read('a1');
    await pane.read('a1');
    const saved = await serverState();
    assert.equal(saved.read.a1, undefined);
    assert.ok(saved.awarded.a1);
    assert.equal((await pane.read('a1')).award, false);
  });

  test('without the merge and the check (the old client), the article pays twice', async () => {
    const pane = await openTab({ merge: false });
    const browser = await openTab({ merge: false });
    await browser.read('a1');
    pane.S.folders.push({ id: 'f1', name: 'Evals' });
    await pane.save();
    assert.equal((await serverState()).awarded.a1, undefined, 'erased');
    await pane.read('a1');
    assert.equal(pane.paid + browser.paid, 2, 'this is the bug the merge and the check fix');
  });
});
