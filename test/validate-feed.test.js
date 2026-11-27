// The `npm run validate-feed` command, run as a separate process the way the agent runs it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { REPO_ROOT, SAMPLE_FEED_PATH } from '../server/config.js';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'validate-feed.js');

function run(args, env = {}) {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.npm_lifecycle_event;
  delete cleanEnv.INIT_CWD;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, env: cleanEnv, encoding: 'utf8' });
}

describe('npm run validate-feed', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-cli-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('prints "valid" and exits 0 for a good file', () => {
    const r = run([SAMPLE_FEED_PATH]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'valid');
  });

  test('accepts a path relative to where it is run', () => {
    const r = run(['prototype/feed.json']);
    assert.equal(r.status, 0, r.stderr);
  });

  test('lists the problems and exits 1 for a bad file', () => {
    const feed = JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));
    feed.articles[0].url = 'http://example.com';
    feed.articles[2].id = feed.articles[1].id;
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify(feed));

    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines[0], `invalid: ${file}`);
    assert.match(lines[1], /^ {2}- articles\[0\]\.url: must start with https:\/\//);
    assert.match(lines[2], /^ {2}- articles\[2\]\.id: duplicate id/);
    assert.equal(lines.length, 3);
  });

  test('exits 1 with a clear message when the file is missing', () => {
    const file = path.join(dir, 'missing.json');
    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `invalid: ${file}\n  - file not found\n`);
  });

  test('exits 1 for broken JSON', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, 'not json');
    const r = run([file]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  });

  test('with no path, checks $DESK_HOME/desks/product-feed/feed.json', () => {
    const deskHome = path.join(dir, 'agent-house');
    fs.mkdirSync(path.join(deskHome, 'desks', 'product-feed'), { recursive: true });
    const r1 = run([], { DESK_HOME: deskHome });
    assert.equal(r1.status, 1);
    assert.equal(r1.stderr, `invalid: ${path.join(deskHome, 'desks', 'product-feed', 'feed.json')}\n  - file not found\n`);

    fs.copyFileSync(SAMPLE_FEED_PATH, path.join(deskHome, 'desks', 'product-feed', 'feed.json'));
    const r2 = run([], { DESK_HOME: deskHome });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout.trim(), 'valid');
  });

  test('caps a long list of problems', () => {
    const feed = JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));
    feed.articles = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}` }));
    const file = path.join(dir, 'many.json');
    fs.writeFileSync(file, JSON.stringify(feed));
    const r = run([file]);
    assert.equal(r.status, 1);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 22); // header + 20 problems + "and N more"
    assert.match(lines.at(-1), /^ {2}…and \d+ more$/);
  });

  test('refuses more than one path', () => {
    const r = run([SAMPLE_FEED_PATH, SAMPLE_FEED_PATH]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage/);
  });
});
