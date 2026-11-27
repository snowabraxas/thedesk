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

// npm's own CLI: npm sets npm_execpath while it runs `npm test`; otherwise look for npm on PATH.
function findNpmCli() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try {
      const cli = fs.realpathSync(path.join(dir, 'npm'));
      if (cli.endsWith('.js')) return cli;
    } catch {
      /* not here */
    }
  }
  return null;
}
const NPM_CLI = findNpmCli();

/** `npm run validate-feed -- <args>`, typed in `cwd`, the way the agent runs it. */
function runNpm(args, { cwd = REPO_ROOT, env = {} } = {}) {
  const cleanEnv = { ...process.env, ...env };
  for (const key of Object.keys(cleanEnv)) if (/^npm_/i.test(key) || key === 'INIT_CWD') delete cleanEnv[key];
  const npmArgs = [NPM_CLI, 'run', 'validate-feed', ...(args.length ? ['--', ...args] : [])];
  return spawnSync(process.execPath, npmArgs, { cwd, env: cleanEnv, encoding: 'utf8' });
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

  test('--help prints the usage and exits 0', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: npm run validate-feed \[path\/to\/feed\.json\]/);
  });

  test('names theme problems so the agent can fix them, and exits 1', () => {
    const feed = JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));
    feed.themes.push({ id: 'evals', name: 'Evals, again' });
    feed.articles[1].themes = ['pricing'];
    const file = path.join(dir, 'themes.json');
    fs.writeFileSync(file, JSON.stringify(feed));
    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `invalid: ${file}\n` +
        `  - themes[${feed.themes.length - 1}].id: duplicate id "evals" (also used by themes[0])\n` +
        '  - articles[1].themes[0]: "pricing" is not in the themes list (add it to themes first, or use one that is)\n',
    );
  });

  test('through npm: no path checks the live feed.json, a relative path works from the repo root or a subfolder', { skip: !NPM_CLI && 'npm not found' }, () => {
    const deskHome = path.join(dir, 'npm-house');
    const live = path.join(deskHome, 'desks', 'product-feed', 'feed.json');
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.copyFileSync(SAMPLE_FEED_PATH, live);

    const ok = runNpm([], { env: { DESK_HOME: deskHome } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^valid$/m);

    const feed = JSON.parse(fs.readFileSync(SAMPLE_FEED_PATH, 'utf8'));
    feed.articles[0].url = 'http://example.com';
    fs.writeFileSync(live, JSON.stringify(feed));
    const bad = runNpm([], { env: { DESK_HOME: deskHome } });
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes(`invalid: ${live}\n  - articles[0].url: must start with https://`), bad.stderr);

    const fromRoot = runNpm(['prototype/feed.json']);
    assert.equal(fromRoot.status, 0, fromRoot.stderr);
    assert.match(fromRoot.stdout, /^valid$/m);

    const fromSubfolder = runNpm(['../prototype/feed.json'], { cwd: path.join(REPO_ROOT, 'test') });
    assert.equal(fromSubfolder.status, 0, fromSubfolder.stderr);
    assert.match(fromSubfolder.stdout, /^valid$/m);

    const wrongPlace = runNpm(['prototype/feed.json'], { cwd: path.join(REPO_ROOT, 'test') });
    assert.equal(wrongPlace.status, 1);
    const expected = `invalid: ${path.join(REPO_ROOT, 'test', 'prototype', 'feed.json')}\n  - file not found`;
    assert.ok(wrongPlace.stderr.includes(expected), wrongPlace.stderr);
  });
});
