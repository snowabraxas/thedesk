// npm run deploy (scripts/deploy.js). Each test builds a small git repo in a temp folder that stands in
// for the work folder, and a temp home whose the-desk-live is the live copy. git runs for real on those
// temp folders only, with no global or system git config (so no hooks or signing) and no inherited
// GIT_* variables (so a hook's GIT_DIR can't point it at the real repo). npm, launchctl, lsof and the
// health check are fakes, except in the one test that drives a stand-in npm through the real runner.
// Nothing here installs packages or touches Snow's service.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { deployedPath, readDeployed } from '../server/deployed.js';
import { GIT, NPM_CI_TIMEOUT_MS, deploy, deployConfig, gitEnv, gitError, main, npmErrorLines, parseArgs, resolveNpmPath, stagingDir } from '../scripts/deploy.js';
import { HOMEBREW_NODE, LAUNCHCTL, LSOF, buildPlist, runCommand } from '../scripts/service.js';

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-deploy-'));
  tmpDirs.push(dir);
  return dir;
};

/**
 * The environment the tests' own git runs with: base without any GIT_* variable (git hooks,
 * `rebase -x` and `bisect run` export GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and more), no global or
 * system config, and a fixed identity for the test commits.
 */
function isolatedGitEnv(base) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith('GIT_')));
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}
const GIT_ENV = isolatedGitEnv(process.env);

/** Runs real git, isolated as above. Resolves { code, stdout, stderr }. */
function realGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
function gitSync(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const NOW = Date.parse('2026-11-28T14:14:03Z'); // 09:14:03 in Toronto

const PACKAGE_JSON = '{ "name": "the-desk", "type": "module", "dependencies": { "ajv": "^8.20.0" } }\n';
const LOCK_V1 = '{ "name": "the-desk", "lockfileVersion": 3, "packages": {} }\n';
const LOCK_V2 = '{ "name": "the-desk", "lockfileVersion": 3, "packages": { "node_modules/ajv": {} } }\n';

/**
 * A work folder (a git repo with main), a temp home, and a fake Mac around them.
 * service: 'moved' (the plist runs the live copy, loaded and running), 'old' (the plist still runs the
 * work folder), 'none' (not installed). state.npmCode: what npm ci exits with (a failing npm empties
 * node_modules in its folder first, as npm 11 does). state.health: whether The Desk answers after a
 * (re)start. Both can change between runs.
 */
function world({ service = 'moved' } = {}) {
  const root = tempDir();
  const repo = path.join(root, 'work');
  const home = path.join(root, 'home');
  const live = path.join(home, 'the-desk-live');
  const staging = stagingDir(live);
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = (subject, files = {}) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-q', '-m', subject);
    return gitSync(repo, 'rev-parse', 'HEAD');
  };
  gitSync(repo, 'init', '-q', '-b', 'main');
  const first = commit('First desk', {
    '.gitignore': 'node_modules\n/.deployed.json*\n',
    'package.json': PACKAGE_JSON,
    'package-lock.json': LOCK_V1,
    'server/index.js': '// v1\n',
    'app/index.html': '<title>v1</title>\n',
  });

  const cfg = deployConfig({ env: { DESK_LIVE_DIR: live }, home, uid: 501, repoRoot: repo, nodePath: HOMEBREW_NODE, npm: '/fake/bin/npm' });
  const svc = cfg.service;
  if (service !== 'none') {
    const runDir = service === 'moved' ? live : repo;
    fs.mkdirSync(path.dirname(svc.plistPath), { recursive: true });
    fs.writeFileSync(svc.plistPath, buildPlist({ ...svc, runDir, serverPath: path.join(runDir, 'server', 'index.js') }));
  }

  // loads: whether the live copy's server loads (the load check); a successful npm ci repairs it.
  const state = { loaded: service !== 'none', pid: service !== 'none' ? 4100 : null, deskUp: service !== 'none', health: true, npmCode: 0, npmStderr: null, loads: true, clock: NOW, nextPid: 4242 };
  const calls = [];
  const npmSaw = []; // the package files npm ci found in its folder, each time it ran
  const out = [];
  const err = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const deps = {
    async run(cmd, args, options = {}) {
      calls.push({ cmd, args, ...options });
      if (cmd === GIT) return realGit(args, options);
      if (cmd === svc.nodePath) {
        assert.equal(args[0], '--input-type=module', 'the load check');
        assert.equal(options.cwd, live, 'it loads the live copy');
        assert.deepEqual(options.env, { ...svc.env, HOME: svc.home }, "with the service's own environment");
        // A commit can carry server/broken.txt to stand for code that doesn't load.
        const broken = fs.existsSync(path.join(live, 'server', 'broken.txt'));
        return state.loads && !broken ? ok() : { code: 1, stdout: '', stderr: "node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\nError: Cannot find module 'fast-deep-equal'\nRequire stack:\n- x\n" };
      }
      if (cmd === cfg.npm) {
        const read = (f) => (fs.existsSync(path.join(options.cwd, f)) ? fs.readFileSync(path.join(options.cwd, f), 'utf8') : null);
        npmSaw.push({ 'package.json': read('package.json'), 'package-lock.json': read('package-lock.json') });
        const modules = path.join(options.cwd, 'node_modules');
        fs.rmSync(modules, { recursive: true, force: true }); // npm ci starts by emptying node_modules
        fs.mkdirSync(modules);
        if (state.npmCode !== 0) return { code: state.npmCode, stdout: '', stderr: state.npmStderr ?? 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/ajv\n' };
        fs.mkdirSync(path.join(modules, 'ajv'));
        fs.writeFileSync(path.join(modules, 'ajv', 'index.js'), '// new ajv\n');
        fs.writeFileSync(path.join(modules, 'ajv', 'package.json'), '{ "name": "ajv" }\n');
        state.loads = true;
        return ok('added 1 package\n');
      }
      if (cmd === LSOF) return state.pid ? ok(`${state.pid}\n`) : { code: 1, stdout: '', stderr: '' };
      assert.equal(cmd, LAUNCHCTL, `unexpected command ${cmd}`);
      switch (args[0]) {
        case 'print':
          return state.loaded ? ok(`${svc.target} = {\n\tstate = ${state.pid ? 'running' : 'spawn scheduled'}\n${state.pid ? `\tpid = ${state.pid}\n` : ''}\truns = 1\n}\n`) : { code: 113, stdout: '', stderr: 'Could not find service\n' };
        case 'kickstart':
        case 'bootstrap':
          state.loaded = true;
          state.pid = state.nextPid++;
          state.deskUp = state.health;
          return ok();
        default:
          throw new Error(`unexpected launchctl ${args.join(' ')}`);
      }
    },
    portIsFree: async () => !state.deskUp,
    probe: async () => (state.deskUp ? { ok: true, source: 'live' } : { ok: false, error: 'ECONNREFUSED' }),
    sleep: async (ms) => {
      state.clock += ms;
    },
    now: () => state.clock,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fs,
    platform: 'darwin',
  };
  const run = (...argv) => main(argv, { env: {}, deps, cfg });
  const liveHead = () => gitSync(live, 'rev-parse', 'HEAD');
  const commands = (cmd) => calls.filter((c) => c.cmd === cmd);
  const launchctl = () => commands(LAUNCHCTL).map((c) => c.args.join(' '));
  const indexOf = (pred) => calls.findIndex(pred);
  const reset = () => {
    calls.length = 0;
    npmSaw.length = 0;
    out.length = 0;
    err.length = 0;
  };
  return { root, repo, home, live, staging, cfg, svc, state, calls, npmSaw, out, err, deps, run, write, commit, first, liveHead, commands, launchctl, indexOf, reset, text: () => out.join('\n'), errors: () => err.join('\n') };
}

/** A world whose service runs the live copy, already deployed at the first commit (packages installed). */
async function deployedWorld() {
  const w = world();
  assert.equal(await deploy(w.cfg, w.deps), 0, w.errors());
  w.reset();
  return w;
}

const ajvIn = (dir) => fs.readFileSync(path.join(dir, 'node_modules', 'ajv', 'index.js'), 'utf8');

// git commands that only read. A dry run may use these and nothing else.
const READ_ONLY = new Set(['log', 'rev-parse', 'status', 'diff', 'worktree list']);
const gitSubcommand = (args) => {
  const rest = [...args];
  while (rest[0] === '-C' || rest[0] === '--no-optional-locks') rest.splice(0, rest[0] === '-C' ? 2 : 1);
  return rest[0] === 'worktree' ? `worktree ${rest[1]}` : rest[0];
};

// What npm 11 prints when the lockfile doesn't match package.json: the cause, then pages of usage.
const NPM_EUSAGE = [
  'npm error code EUSAGE',
  'npm error',
  'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
  'npm error',
  'npm error Missing: ajv@8.17.1 from lock file',
  'npm error',
  'npm error Clean install a project',
  'npm error',
  'npm error Usage:',
  'npm error npm ci',
  'npm error',
  'npm error Options:',
  'npm error [--install-strategy <hoisted|nested|shallow|linked>] [--legacy-bundling]',
  'npm error [--global-style] [--omit <dev|optional|peer> [--omit <dev|optional|peer> ...]]',
  'npm error',
  'npm error aliases: clean-install, ic, install-clean, isntall-clean',
  'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-11-28T14_14_03_000Z-debug-0.log',
  '',
].join('\n');

describe('deploy: what it shows when git or npm fails', () => {
  test('npmErrorLines: the code line, the cause, and where the log is', () => {
    assert.deepEqual(npmErrorLines(NPM_EUSAGE), [
      'npm error code EUSAGE',
      'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
      'npm error Missing: ajv@8.17.1 from lock file',
      'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-11-28T14_14_03_000Z-debug-0.log',
    ]);
    assert.deepEqual(npmErrorLines('npm ERR! code ENOTFOUND\nnpm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org\n'), ['npm ERR! code ENOTFOUND', 'npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org']);
    assert.deepEqual(npmErrorLines('something odd\nlast words\n'), ['something odd', 'last words'], 'no npm error lines: the tail');
  });

  test("gitError: git's fatal: or error: line, else its last line", () => {
    assert.equal(gitError({ code: 128, stdout: '', stderr: "Preparing worktree (detached HEAD 1a2b3c4)\nfatal: '/x' is a missing but already registered worktree;\nuse 'add -f' to override\n" }), "fatal: '/x' is a missing but already registered worktree;");
    assert.equal(gitError({ code: 1, stdout: '', stderr: 'error: Your local changes would be overwritten\n' }), 'error: Your local changes would be overwritten');
    assert.equal(gitError({ code: 1, stdout: '', stderr: 'first\nlast\n' }), 'last');
    assert.equal(gitError({ code: 5, stdout: '', stderr: '' }), 'exit 5');
  });
});

describe('deploy: arguments and config', () => {
  test('parseArgs: no words, --dry-run (also when npm swallowed it), --help, and nothing else', () => {
    assert.deepEqual(parseArgs([]), { dryRun: false });
    assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
    assert.deepEqual(parseArgs([], { npm_config_dry_run: 'true' }), { dryRun: true });
    assert.deepEqual(parseArgs(['--help']), { help: true });
    assert.deepEqual(parseArgs(['-h']), { help: true });
    assert.match(parseArgs(['--force']).error, /Unknown option "--force"/);
    assert.match(parseArgs(['now']).error, /Unknown word "now"/);
  });

  test('the live copy is ~/the-desk-live (DESK_LIVE_DIR moves it), and the service runs from it', () => {
    const cfg = deployConfig({ env: {}, home: '/Users/snow', uid: 501, repoRoot: '/Users/snow/Documents/Projects/the-desk', nodePath: '/opt/homebrew/bin/node', npm: 'npm' });
    assert.equal(cfg.liveDir, '/Users/snow/the-desk-live');
    assert.equal(cfg.deployedFile, '/Users/snow/the-desk-live/.deployed.json');
    assert.equal(cfg.service.runDir, '/Users/snow/the-desk-live');
    assert.equal(cfg.service.serverPath, '/Users/snow/the-desk-live/server/index.js');
    assert.equal(cfg.ref, 'main');
    assert.equal(stagingDir(cfg.liveDir), '/Users/snow/the-desk-live.staging', 'packages are staged beside the live copy, not inside it');
    assert.equal(deployConfig({ env: { DESK_LIVE_DIR: '/tmp/x' }, home: '/Users/snow', uid: 501, nodePath: 'n', npm: 'npm' }).service.runDir, '/tmp/x');
  });

  test('uses the npm next to Homebrew node, else npm from PATH', () => {
    assert.equal(resolveNpmPath('/opt/homebrew/bin/node', { exists: () => true }), '/opt/homebrew/bin/npm');
    assert.equal(resolveNpmPath('/opt/homebrew/bin/node', { exists: () => false }), 'npm');
  });

  test(".gitignore keeps node_modules (a folder or a link) and .deployed.json out of the live copy's git status", () => {
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.match(ignore, /^node_modules$/m, 'no trailing slash: a symlinked node_modules is ignored too');
    assert.match(ignore, /^\/\.deployed\.json\*$/m);
  });

  test('package.json wires npm run deploy', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(scripts.deploy, 'node scripts/deploy.js');
  });

  test('--help prints the usage; a stray word exits 2 (as a real process, which never reaches git)', () => {
    const script = path.join(REPO_ROOT, 'scripts', 'deploy.js');
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /npm run deploy \[-- --dry-run\]/);
    const bad = spawnSync(process.execPath, [script, 'now'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown word "now"[\s\S]*Usage/);
  });
});

describe('deploy: git never follows an inherited GIT_DIR', () => {
  const leaky = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/x',
    GIT_DIR: '/real/repo/.git',
    GIT_WORK_TREE: '/real/repo',
    GIT_INDEX_FILE: '/real/repo/.git/index',
    GIT_COMMON_DIR: '/real/repo/.git',
    GIT_OBJECT_DIRECTORY: '/real/repo/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/objects',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/x',
  };

  test('gitEnv drops every variable that redirects git, and keeps the rest', () => {
    assert.deepEqual(gitEnv(leaky), { PATH: '/usr/bin:/bin', HOME: '/Users/x' });
  });

  test("the tests' own git drops every GIT_* variable it inherits", () => {
    const env = isolatedGitEnv(leaky);
    for (const name of Object.keys(leaky).filter((n) => n.startsWith('GIT_'))) assert.equal(name in env, false, name);
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.PATH, '/usr/bin:/bin');
  });

  test('every git command deploy runs gets the cleaned environment', async () => {
    const w = world();
    w.deps.env = { ...leaky, PATH: process.env.PATH };
    assert.equal(await deploy(w.cfg, w.deps), 0, w.errors());
    const gits = w.commands(GIT);
    assert.ok(gits.length > 5);
    const npm = w.commands(w.cfg.npm);
    assert.equal(npm.length, 1);
    for (const c of [...gits, ...npm]) {
      assert.equal(c.env.GIT_DIR, undefined, `${c.cmd} ${c.args.join(' ')}`);
      assert.equal(c.env.GIT_WORK_TREE, undefined);
      assert.equal(c.env.GIT_INDEX_FILE, undefined);
      assert.equal(c.env.PATH, process.env.PATH);
    }
  });
});

describe('deploy: the first time (no live copy yet)', () => {
  test('installs packages beside the live copy, then makes it, swaps them in, records it, and says to move the service', async () => {
    const w = world({ service: 'old' });
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first);
    assert.equal(gitSync(w.live, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached, not on a branch');
    assert.ok(gitSync(w.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${fs.realpathSync(w.live)}`), 'a worktree of the work folder');
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>v1</title>\n');

    const npm = w.commands(w.cfg.npm);
    assert.equal(npm.length, 1);
    assert.deepEqual(npm[0].args, ['ci', '--omit=dev']);
    assert.equal(npm[0].cwd, w.staging, 'npm ci runs in the staging folder, never in the live copy or the work folder');
    assert.equal(npm[0].timeoutMs, NPM_CI_TIMEOUT_MS);
    assert.deepEqual(w.npmSaw, [{ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCK_V1 }], "the new commit's own package files");
    const npmAt = w.indexOf((c) => c.cmd === w.cfg.npm);
    const addAt = w.indexOf((c) => c.cmd === GIT && c.args.includes('worktree') && c.args.includes('add'));
    assert.ok(npmAt >= 0 && npmAt < addAt, 'packages first, then the live copy');

    assert.equal(ajvIn(w.live), '// new ajv\n', 'the packages were swapped into the live copy');
    assert.equal(fs.existsSync(w.staging), false, 'and the staging folder is gone');
    assert.deepEqual(readDeployed(w.live), { sha: w.first, shortSha: w.first.slice(0, 7), subject: 'First desk', ref: 'main', deployedAt: '2026-11-28T09:14:03-05:00' });
    assert.equal(gitSync(w.live, 'status', '--porcelain'), '', '.deployed.json and node_modules are ignored: the copy stays clean');

    assert.deepEqual(w.launchctl(), [], 'the service was not touched');
    assert.ok(w.errors().includes(`The live copy is ready (main @ ${w.first.slice(0, 7)} "First desk"), but The Desk service still runs from ${w.repo}.`));
    assert.match(w.errors(), /Run npm run service:install once to move the service to the live copy\./);
    assert.doesNotMatch(w.text(), /is live at/);
  });

  test('when npm ci fails the first time, no live copy is made at all', async () => {
    const w = world({ service: 'old' });
    w.state.npmCode = 1;
    assert.equal(await w.run(), 1);
    assert.equal(fs.existsSync(w.live), false);
    assert.equal(fs.existsSync(w.staging), false);
    assert.ok(!w.commands(GIT).some((c) => c.args.includes('add')));
    assert.match(w.errors(), /npm ci didn't work, so nothing was deployed: the live copy is untouched/);
  });

  test('with no service installed at all, says to install it', async () => {
    const w = world({ service: 'none' });
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first);
    assert.match(w.errors(), /The Desk service isn't installed\.\nInstall it with: npm run service:install/);
    assert.deepEqual(w.launchctl(), []);
  });

  test('when the service already runs the live copy, it restarts it and says what is live', async () => {
    const w = world({ service: 'moved' });
    assert.equal(await w.run(), 0, w.errors());
    assert.deepEqual(w.launchctl().filter((c) => !c.startsWith('print')), ['kickstart -k gui/501/local.thedesk.server']);
    assert.equal(w.out.at(-1), `The Desk is live at http://localhost:4321 on main @ ${w.first.slice(0, 7)} "First desk"`);
  });
});

describe('deploy: updating the live copy', () => {
  test('happy path: moves it to the new main, no npm ci when the lockfile is the same, restarts, one plain last line', async () => {
    const w = await deployedWorld();
    const second = w.commit('News: routes', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.liveHead(), second);
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>v2</title>\n');
    assert.equal(w.commands(w.cfg.npm).length, 0, 'no npm ci');
    assert.equal(fs.existsSync(w.staging), false, 'no staging folder either');
    assert.equal(readDeployed(w.live).sha, second);
    assert.equal(readDeployed(w.live).subject, 'News: routes');
    assert.deepEqual(w.launchctl().filter((c) => !c.startsWith('print')), ['kickstart -k gui/501/local.thedesk.server']);
    assert.equal(w.state.pid, 4243, 'a new process');
    assert.match(w.text(), new RegExp(`Moving the live copy from ${w.first.slice(0, 7)} to ${second.slice(0, 7)}`));
    assert.match(w.text(), new RegExp(`OK: The Desk is running at http://localhost:4321 \\(process 4243\\)\\. Restarted from ${w.live}\\.`));
    assert.equal(w.out.at(-1), `The Desk is live at http://localhost:4321 on main @ ${second.slice(0, 7)} "News: routes"`);
  });

  test('package-lock.json changed: npm ci in staging first, then the checkout, then the old node_modules is swapped out', async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, 'node_modules', 'old-marker'), 'old');
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    assert.equal(await w.run(), 0, w.errors());
    const npm = w.commands(w.cfg.npm);
    assert.equal(npm.length, 1);
    assert.deepEqual(npm[0].args, ['ci', '--omit=dev']);
    assert.equal(npm[0].cwd, w.staging);
    assert.deepEqual(w.npmSaw, [{ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCK_V2 }]);
    const npmAt = w.indexOf((c) => c.cmd === w.cfg.npm);
    const checkoutAt = w.indexOf((c) => c.cmd === GIT && c.args.includes('checkout'));
    assert.ok(npmAt >= 0 && npmAt < checkoutAt, 'packages first, then the checkout');
    assert.equal(ajvIn(w.live), '// new ajv\n');
    assert.equal(fs.existsSync(path.join(w.live, 'node_modules', 'old-marker')), false, 'the old node_modules is gone');
    assert.equal(fs.existsSync(w.staging), false);
    assert.equal(gitSync(w.live, 'status', '--porcelain'), '');
    assert.match(w.text(), /because package-lock\.json changed/);
  });

  test('runs npm ci when node_modules is missing, even if the lockfile is the same', async () => {
    const w = await deployedWorld();
    fs.rmSync(path.join(w.live, 'node_modules'), { recursive: true });
    w.commit('Copy change', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.commands(w.cfg.npm).length, 1);
    assert.equal(ajvIn(w.live), '// new ajv\n');
    assert.match(w.text(), /because node_modules is missing/);
  });

  test('main already deployed: nothing to move, still records and restarts', async () => {
    const w = await deployedWorld();
    assert.equal(await w.run(), 0, w.errors());
    assert.ok(!w.commands(GIT).some((c) => c.args.includes('checkout')));
    assert.equal(w.commands(w.cfg.npm).length, 0);
    assert.match(w.text(), /The live copy already holds main @/);
    assert.ok(w.launchctl().includes('kickstart -k gui/501/local.thedesk.server'));
  });

  test('uncommitted work and story branches in the work folder never go live', async () => {
    const w = await deployedWorld();
    const onMain = w.commit('On main', { 'app/index.html': '<title>main</title>\n' });
    gitSync(w.repo, 'switch', '-q', '-c', 'n9-story');
    w.commit('Story work', { 'app/index.html': '<title>story</title>\n', 'package-lock.json': LOCK_V2 });
    w.write('app/index.html', '<title>uncommitted</title>\n');
    w.write('app/new.js', '// untracked\n');
    w.write('package.json', '{ "name": "uncommitted" }\n');
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.liveHead(), onMain);
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>main</title>\n');
    assert.equal(fs.existsSync(path.join(w.live, 'app', 'new.js')), false);
    assert.equal(w.commands(w.cfg.npm).length, 0, "main's lockfile didn't change, whatever the branch did");
    assert.match(w.text(), /This folder is on branch n9-story\. That doesn't matter: deploy always takes main\./);
    assert.match(w.text(), /This folder has uncommitted changes\. They stay here/);
    assert.equal(fs.readFileSync(path.join(w.repo, 'app', 'index.html'), 'utf8'), '<title>uncommitted</title>\n', 'and the work folder is left alone');
  });

  test('refuses when the live copy has changes of its own, changing nothing', async () => {
    const w = await deployedWorld();
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    w.commit('Next', { 'app/index.html': '<title>v2</title>\n', 'package-lock.json': LOCK_V2 });
    fs.writeFileSync(path.join(w.live, 'app', 'index.html'), '<title>hand edit</title>\n');
    fs.writeFileSync(path.join(w.live, 'stray.txt'), 'x');
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first, 'not moved');
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>hand edit</title>\n', 'the hand edit is kept');
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.equal(w.commands(w.cfg.npm).length, 0, 'not even staged: every check comes before any change');
    assert.equal(fs.existsSync(w.staging), false);
    assert.deepEqual(w.launchctl(), []);
    const errors = w.errors();
    assert.match(errors, /The live copy has changes of its own, so nothing was deployed:\n {2} M app\/index\.html\n {2}\?\? stray\.txt/);
    assert.match(errors, /stash --include-untracked/);
  });

  test('refuses a folder at the live path that is not a worktree of this repo', async () => {
    const w = world();
    fs.mkdirSync(w.live, { recursive: true });
    fs.writeFileSync(path.join(w.live, 'notes.txt'), 'mine');
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /is there, but it isn't a live copy of this repo \(a git worktree of it\), so nothing was changed\./);
    assert.deepEqual(fs.readdirSync(w.live), ['notes.txt']);

    const other = world();
    gitSync(other.root, 'init', '-q', '-b', 'main', w.live.replace(w.root, other.root));
    assert.equal(await other.run(), 1, 'a different repo is refused too');
    assert.match(other.errors(), /isn't a live copy of this repo/);
  });

  test('run from inside the live copy: says to run it from the work folder, plainly', async () => {
    const w = await deployedWorld();
    const cfg = deployConfig({ env: { DESK_LIVE_DIR: w.live }, home: w.home, uid: 501, repoRoot: w.live, nodePath: HOMEBREW_NODE, npm: '/fake/bin/npm' });
    assert.equal(await deploy(cfg, w.deps), 1);
    assert.equal(w.errors(), `Run npm run deploy from your work folder (${fs.realpathSync(w.repo)}), not from the live copy. Nothing was changed.`);
    assert.ok(w.calls.every((c) => c.cmd === GIT && gitSubcommand(c.args) === 'worktree list'), 'only asks git where the work folder is');
  });

  test('refuses a live copy that is the work folder itself, or inside it', async () => {
    const w = world();
    for (const live of [w.repo, path.join(w.repo, 'live')]) {
      w.reset();
      const cfg = deployConfig({ env: { DESK_LIVE_DIR: live }, home: w.home, uid: 501, repoRoot: w.repo, nodePath: HOMEBREW_NODE, npm: '/fake/bin/npm' });
      assert.equal(await deploy(cfg, w.deps), 1);
      assert.ok(
        w.errors().startsWith(`The live copy (${live}) can't be your work folder or sit inside it (${w.repo}), so nothing was changed.\nPoint DESK_LIVE_DIR somewhere else`),
        w.errors(),
      );
      assert.ok(w.calls.every((c) => c.cmd === GIT && READ_ONLY.has(gitSubcommand(c.args))));
    }
  });

  test('refuses when there is no main branch', async () => {
    const w = world();
    gitSync(w.repo, 'branch', '-q', '-m', 'main', 'trunk');
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /There's no main branch in .* to deploy, so nothing was changed\./);
    assert.equal(fs.existsSync(w.live), false);
  });

  test('a failed npm ci changes nothing in the live copy: same commit, same packages, same record, no restart', async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, 'node_modules', 'ajv', 'index.js'), '// old ajv\n');
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    w.state.npmCode = 1;
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first, 'not moved: the next launchd start still runs the old code');
    assert.equal(ajvIn(w.live), '// old ajv\n', 'with its old packages, untouched');
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.equal(fs.existsSync(w.staging), false, 'the staging folder is cleaned up');
    assert.ok(!w.commands(GIT).some((c) => c.args.includes('checkout')));
    assert.deepEqual(w.launchctl(), []);
    assert.equal(gitSync(w.live, 'status', '--porcelain'), '');
    assert.match(w.errors(), /^npm ci didn't work, so nothing was deployed: the live copy is untouched and The Desk keeps running what it had\.\n {2}npm error code E404/);
  });

  test('after a failed npm ci, the next deploy installs the packages and moves the copy', async () => {
    const w = await deployedWorld();
    const second = w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    w.state.npmCode = 1;
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first);
    w.state.npmCode = 0;
    w.reset();
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.commands(w.cfg.npm).length, 1);
    assert.match(w.text(), /because package-lock\.json changed/);
    assert.equal(w.liveHead(), second);
    assert.equal(readDeployed(w.live).sha, second);
  });

  test('a commit with no package-lock.json is refused before the live copy changes', async () => {
    const w = await deployedWorld();
    fs.rmSync(path.join(w.repo, 'package-lock.json'));
    w.commit('Drop the lockfile');
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /main @ [0-9a-f]{7} has no package-lock\.json that git can read, so nothing was changed\./);
    assert.equal(w.liveHead(), w.first);
    assert.equal(fs.existsSync(w.staging), false);
    assert.equal(w.commands(w.cfg.npm).length, 0);
  });

  test('a live copy with packages but no deploy recorded gets a fresh npm ci', async () => {
    const w = await deployedWorld();
    fs.rmSync(deployedPath(w.live));
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.commands(w.cfg.npm).length, 1);
    assert.match(w.text(), /because no earlier deploy is recorded/);
  });

  test('a staging folder left by an interrupted deploy is removed first', async () => {
    const w = await deployedWorld();
    fs.mkdirSync(path.join(w.staging, 'node_modules', 'half'), { recursive: true });
    fs.mkdirSync(path.join(w.staging, 'node_modules.old'));
    fs.writeFileSync(path.join(w.staging, 'package.json'), '{}');
    w.commit('Next', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(fs.existsSync(w.staging), false);
    assert.match(w.text(), /Removing a staging folder left by an interrupted deploy/);
  });

  test("a staging folder holding anything deploy didn't put there is left alone, and deploy stops", async () => {
    const w = await deployedWorld();
    fs.mkdirSync(w.staging);
    fs.writeFileSync(path.join(w.staging, 'thesis.docx'), 'precious');
    w.commit('Next', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run(), 1);
    assert.equal(fs.readFileSync(path.join(w.staging, 'thesis.docx'), 'utf8'), 'precious');
    assert.equal(w.liveHead(), w.first);
    assert.match(w.errors(), /holds things deploy didn't put there, so nothing was changed\./);
    assert.deepEqual(w.calls, []);
  });

  test('an incomplete node_modules (a package the live package.json names is missing) gets a fresh npm ci', async () => {
    const w = await deployedWorld();
    fs.rmSync(path.join(w.live, 'node_modules', 'ajv', 'package.json'));
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.commands(w.cfg.npm).length, 1);
    assert.match(w.text(), /because node_modules is incomplete/);
    assert.ok(fs.existsSync(path.join(w.live, 'node_modules', 'ajv', 'package.json')), 'repaired: what the install guard refuses, deploy fixes');
  });

  test('a node_modules that is a symlink, dangling or not, is moved aside too', async () => {
    const dangling = await deployedWorld();
    fs.rmSync(path.join(dangling.live, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(dangling.root, 'nowhere'), path.join(dangling.live, 'node_modules'));
    assert.equal(await dangling.run(), 0, dangling.errors());
    assert.match(dangling.text(), /because node_modules is missing/);
    assert.ok(!fs.lstatSync(path.join(dangling.live, 'node_modules')).isSymbolicLink());
    assert.equal(ajvIn(dangling.live), '// new ajv\n');

    const linked = await deployedWorld();
    const elsewhere = path.join(linked.root, 'elsewhere-modules');
    fs.mkdirSync(path.join(elsewhere, 'keep'), { recursive: true });
    fs.rmSync(path.join(linked.live, 'node_modules'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(linked.live, 'node_modules'));
    assert.equal(await linked.run(), 0, linked.errors());
    assert.match(linked.text(), /because node_modules is incomplete/);
    assert.ok(!fs.lstatSync(path.join(linked.live, 'node_modules')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(elsewhere, 'keep')), "the folder the link pointed to isn't touched");
  });

  test('if the second rename fails, the old packages and the old commit are put back', async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, 'node_modules', 'ajv', 'index.js'), '// old ajv\n');
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    const liveModules = path.join(w.live, 'node_modules');
    w.deps.fs = {
      ...fs,
      renameSync(from, to) {
        if (to === liveModules && from === path.join(w.staging, 'node_modules')) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        return fs.renameSync(from, to);
      },
    };
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first, 'back on the old commit');
    assert.equal(ajvIn(w.live), '// old ajv\n', 'with the old packages');
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.equal(fs.existsSync(w.staging), false);
    assert.equal(gitSync(w.live, 'status', '--porcelain'), '');
    assert.deepEqual(w.launchctl(), []);
    assert.match(w.errors(), new RegExp(`Couldn't move the new packages into the live copy \\(EXDEV\\), so The Desk was not restarted\\.\\nThe live copy is back on ${w.first.slice(0, 7)} with its old packages\\.`));
  });

  test("a leftover staging folder holding the live copy's moved-aside packages puts them back first", async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, 'node_modules', 'ajv', 'index.js'), '// old ajv\n');
    fs.mkdirSync(path.join(w.staging, 'node_modules'), { recursive: true }); // cut off between the two renames
    fs.renameSync(path.join(w.live, 'node_modules'), path.join(w.staging, 'node_modules.old'));
    w.commit('Copy', { 'app/index.html': '<title>v2</title>\n' });

    const dry = await w.run('--dry-run');
    assert.equal(dry, 0, w.errors());
    assert.ok(w.text().includes(`1. Put the live copy's packages back, which an interrupted deploy had moved aside: mv ${w.staging}/node_modules.old ${w.live}/node_modules`), w.text());
    assert.match(w.text(), /Packages: node_modules is there and package-lock\.json is the same, so no npm ci\./, 'judged on the packages it would put back');
    assert.ok(fs.existsSync(path.join(w.staging, 'node_modules.old')), 'the dry run left it there');

    w.reset();
    assert.equal(await w.run(), 0, w.errors());
    assert.match(w.text(), /Putting back the live copy's packages/);
    assert.equal(w.commands(w.cfg.npm).length, 0, 'nothing to reinstall');
    assert.equal(ajvIn(w.live), '// old ajv\n');
    assert.equal(fs.existsSync(w.staging), false);
  });

  test("npm's own error lines are shown (code and cause), not its usage text", async () => {
    const w = await deployedWorld();
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    w.state.npmCode = 1;
    w.state.npmStderr = NPM_EUSAGE;
    assert.equal(await w.run(), 1);
    const errors = w.errors();
    assert.match(errors, /\n {2}npm error code EUSAGE\n {2}npm error `npm ci` can only install packages when your package\.json and package-lock\.json/);
    assert.match(errors, /npm error Missing: ajv@8\.17\.1 from lock file/);
    assert.match(errors, /npm error A complete log of this run can be found in/);
    assert.doesNotMatch(errors, /--install-strategy|Options:|Usage:/);
  });

  test("when git can't make the live copy, its fatal: line is shown, not \"Preparing worktree\"", async () => {
    const w = await deployedWorld();
    fs.rmSync(w.live, { recursive: true, force: true }); // deleted by hand: git still has it registered
    assert.equal(await w.run(), 1);
    const errors = w.errors();
    assert.match(errors, /^git couldn't make the live copy: fatal: '.*the-desk-live' is a missing but already registered worktree;/);
    assert.doesNotMatch(errors, /Preparing worktree/);
    assert.match(errors, /run git worktree prune, then npm run deploy again/);
    assert.equal(fs.existsSync(w.staging), false);
  });

  test('a deploy that changes nothing keeps .deployed.json, deploy time and all', async () => {
    const w = await deployedWorld();
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    w.state.clock += 3 * 3600_000;
    assert.equal(await w.run('--dry-run'), 0);
    assert.match(w.text(), /\.deployed\.json already names this commit \(deployed 2026-11-28T09:14:03-05:00\), so it stays as it is\./);
    w.reset();
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.equal(w.out.at(-1), `The Desk is live at http://localhost:4321 on main @ ${w.first.slice(0, 7)} "First desk"`);
  });

  test('a checkout that fails after moving HEAD (a post-checkout hook) carries on with the swap and warns', async () => {
    const w = await deployedWorld();
    const second = w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const hook = path.join(w.repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.liveHead(), second);
    assert.equal(ajvIn(w.live), '// new ajv\n', 'new code, new packages: they match');
    assert.equal(readDeployed(w.live).sha, second);
    assert.match(w.text(), new RegExp(`Warning: git moved the live copy to ${second.slice(0, 7)} but then said: hook says no\\. Carrying on\\.`));
    assert.equal(fs.existsSync(w.staging), false);
  });

  test('a checkout that fails and leaves HEAD somewhere else: back to the old commit, packages untouched', async () => {
    const w = await deployedWorld();
    const middle = w.commit('Middle', { 'app/index.html': '<title>middle</title>\n' });
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    fs.writeFileSync(path.join(w.live, 'node_modules', 'ajv', 'index.js'), '// old ajv\n');
    const realRun = w.deps.run;
    w.deps.run = async (cmd, args, options) => {
      if (cmd === GIT && args.includes('checkout') && !args.includes(w.first)) {
        await realGit(['-C', w.live, 'checkout', '--quiet', '--detach', middle]); // half way, then fails
        return { code: 1, stdout: '', stderr: 'error: something broke half way\n' };
      }
      return realRun(cmd, args, options);
    };
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first, 'back on the old commit');
    assert.equal(ajvIn(w.live), '// old ajv\n', 'with its old packages');
    assert.equal(fs.existsSync(w.staging), false);
    assert.deepEqual(w.launchctl(), []);
    assert.match(w.errors(), new RegExp(`^git couldn't move the live copy to main: error: something broke half way\\nThe live copy is on ${w.first.slice(0, 7)} as before, with its packages\\. The Desk was not restarted\\.`));
  });

  test('a checkout that fails without moving: nothing changed, and it says so', async () => {
    const w = await deployedWorld();
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const realRun = w.deps.run;
    let checkouts = 0;
    w.deps.run = async (cmd, args, options) => {
      if (cmd === GIT && args.includes('checkout')) {
        checkouts += 1;
        return { code: 128, stdout: '', stderr: 'fatal: unable to write new index file\n' };
      }
      return realRun(cmd, args, options);
    };
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first);
    assert.equal(checkouts, 1, 'no second checkout needed');
    assert.match(w.errors(), /fatal: unable to write new index file\nThe live copy is on [0-9a-f]{7} as before/);
  });

  test("a live copy whose server doesn't load (a missing package of a package) gets a fresh npm ci", async () => {
    const w = await deployedWorld();
    w.state.loads = false;
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.commands(w.cfg.npm).length, 1);
    assert.match(w.text(), /because its server doesn't load: Error: Cannot find module 'fast-deep-equal'\)/);
    assert.notEqual(w.out.at(-1).indexOf('is live at'), -1);
  });

  test('a hand checkout to an older commit whose .gitignore lacks .deployed.json still deploys (not "dirty")', async () => {
    const w = await deployedWorld();
    const old = w.commit('Before N1', { '.gitignore': 'node_modules\n' });
    const latest = w.commit('After N1', { '.gitignore': 'node_modules\n/.deployed.json*\n' });
    gitSync(w.live, 'checkout', '-q', '--detach', old);
    assert.match(gitSync(w.live, 'status', '--porcelain'), /\?\? \.deployed\.json/, 'plain git status would call it dirty');
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.liveHead(), latest);
  });

  test('leftover .deployed.json temp files are removed at the start', async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, '.deployed.json.tmp-999'), '{ "half');
    assert.equal(await w.run('--dry-run'), 0);
    assert.ok(w.text().includes(`Remove a temp file left by an interrupted deploy: ${w.live}/.deployed.json.tmp-999`), w.text());
    assert.ok(fs.existsSync(path.join(w.live, '.deployed.json.tmp-999')), 'not by a dry run');
    w.reset();
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(fs.existsSync(path.join(w.live, '.deployed.json.tmp-999')), false);
  });

  test("if the staging folder can't be removed after a good swap, it warns and still records and restarts", async () => {
    const w = await deployedWorld();
    const second = w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    w.deps.fs = {
      ...fs,
      rmSync(target, options) {
        if (target === w.staging) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return fs.rmSync(target, options);
      },
    };
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(readDeployed(w.live).sha, second);
    assert.match(w.text(), new RegExp(`Couldn't remove ${w.staging} \\(EBUSY\\)\\. It's left for the next deploy to tidy\\.`));
    assert.ok(w.launchctl().includes('kickstart -k gui/501/local.thedesk.server'));
    assert.equal(w.out.at(-1), `The Desk is live at http://localhost:4321 on main @ ${second.slice(0, 7)} "Add a package"`);

    w.deps.fs = fs; // the next run tidies it
    w.reset();
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(fs.existsSync(w.staging), false);
  });

  test("if a leftover staging folder can't be removed, it says so plainly and changes nothing", async () => {
    const w = await deployedWorld();
    fs.mkdirSync(path.join(w.staging, 'node_modules'), { recursive: true });
    w.commit('Next', { 'app/index.html': '<title>v2</title>\n' });
    w.deps.fs = {
      ...fs,
      rmSync(target, options) {
        if (target === w.staging) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        return fs.rmSync(target, options);
      },
    };
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /^Couldn't tidy up after an interrupted deploy \(EPERM\), so nothing was deployed\.\nLook at /);
    assert.equal(w.liveHead(), w.first);
    assert.deepEqual(w.launchctl(), []);
  });

  test('with a fake HOME (the deps say so), it never restarts the real service, though the live copy is ready', async () => {
    const w = await deployedWorld();
    const second = w.commit('Next', { 'app/index.html': '<title>v2</title>\n' });
    const why = "HOME (/tmp/fake) is not your real home folder (/Users/snow), so I won't touch the real launchd service (its name is shared). Use --dry-run or the test hooks.";
    w.deps.launchdRefusal = (svc) => {
      assert.equal(svc, w.svc);
      return why;
    };
    assert.equal(await w.run('--dry-run'), 0);
    assert.ok(w.text().includes(`   But this run stops here without restarting it: ${why}`));
    w.reset();
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), second);
    assert.equal(readDeployed(w.live).sha, second);
    assert.deepEqual(w.launchctl(), [], 'not even launchctl print');
    assert.equal(w.errors(), `The live copy is ready (main @ ${second.slice(0, 7)} "Next"), but The Desk was not restarted.\n${why}`);
  });

  test('when The Desk does not answer after the restart, it says so and never claims it is live', async () => {
    const w = await deployedWorld();
    w.state.health = false;
    w.commit('Broken server', { 'server/index.js': '// v2\n' });
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /didn't answer at http:\/\/localhost:4321 within 15 seconds/);
    assert.doesNotMatch(w.text(), /is live at/);
  });
});

describe('deploy: the new code must load before it goes live', () => {
  test("code that doesn't load is never put live: old commit back, no record, no restart", async () => {
    const w = await deployedWorld();
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    w.commit('Broken import', { 'server/broken.txt': 'x' });
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first, 'back on the last good commit');
    assert.equal(fs.existsSync(path.join(w.live, 'server', 'broken.txt')), false);
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.deepEqual(w.launchctl(), [], 'no restart: the running Desk keeps the last good version');
    assert.equal(gitSync(w.live, 'status', '--porcelain'), '');
    assert.equal(
      w.errors(),
      `The new code doesn't load, so it wasn't put live: Error: Cannot find module 'fast-deep-equal'\nThe live copy is back on ${w.first.slice(0, 7)} with its packages, and The Desk keeps running it (no restart). Fix main, then run npm run deploy again.`,
    );
  });

  test('with new packages too, the old packages come back from the staging folder', async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, 'node_modules', 'ajv', 'index.js'), '// old ajv\n');
    w.commit('New package, broken code', { 'package-lock.json': LOCK_V2, 'server/broken.txt': 'x' });
    assert.equal(await w.run(), 1);
    assert.equal(w.commands(w.cfg.npm).length, 1, 'the packages were installed and swapped in first');
    assert.equal(w.liveHead(), w.first);
    assert.equal(ajvIn(w.live), '// old ajv\n', 'the old packages are back');
    assert.equal(fs.existsSync(w.staging), false, 'the new ones went with the staging folder');
    assert.deepEqual(w.launchctl(), []);
  });

  test('the load check runs after the checkout and the swap, and before the record and the restart', async () => {
    const w = await deployedWorld();
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    assert.equal(await w.run(), 0, w.errors());
    const at = (pred) => w.calls.findIndex(pred);
    const checkout = at((c) => c.cmd === GIT && c.args.includes('checkout'));
    const loads = w.calls.map((c, i) => (c.cmd === w.svc.nodePath ? i : -1)).filter((i) => i >= 0);
    const kick = at((c) => c.cmd === LAUNCHCTL && c.args[0] === 'kickstart');
    assert.ok(loads.some((i) => i > checkout && i < kick), `a load check between the checkout (${checkout}) and the restart (${kick}): ${loads}`);
  });

  test("a first deploy whose code doesn't load records nothing", async () => {
    const w = world({ service: 'old' });
    fs.mkdirSync(path.join(w.repo, 'server'), { recursive: true });
    w.commit('Broken from the start', { 'server/broken.txt': 'x' });
    assert.equal(await w.run(), 1);
    assert.equal(fs.existsSync(deployedPath(w.live)), false);
    assert.equal(fs.existsSync(w.staging), false);
    assert.match(w.errors(), /^The new code doesn't load, so it wasn't put live: .*\nNothing was recorded or restarted\./);
  });

  test('for real: code importing a package the lockfile lacks fails the load check, and the old commit stays', async () => {
    const w = await deployedWorld();
    const fakeRun = w.deps.run;
    w.deps.run = (cmd, args, options) => (cmd === w.svc.nodePath ? runCommand(process.execPath, args, options) : fakeRun(cmd, args, options));
    w.commit('Uses a package nobody installed', { 'server/index.js': "import 'left-pad-that-is-not-there';\n" });
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /^The new code doesn't load, so it wasn't put live: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package 'left-pad-that-is-not-there'/);
    assert.equal(w.liveHead(), w.first);
    assert.equal(fs.readFileSync(path.join(w.live, 'server', 'index.js'), 'utf8'), '// v1\n');
    assert.deepEqual(w.launchctl(), []);
  });
});

describe('deploy with the real runner', () => {
  test('npm ci runs in the staging folder (not the work folder) and its packages land in the live copy', async () => {
    const w = world();
    const bin = path.join(w.root, 'bin');
    const log = path.join(w.root, 'npm.log');
    const npm = path.join(bin, 'npm');
    fs.mkdirSync(bin);
    // A stand-in npm: notes where it ran, what it was asked and which lockfile it found, then "installs".
    fs.writeFileSync(npm, `#!/bin/sh\npwd -P >> '${log}'\necho "$*" >> '${log}'\nhead -c 40 package-lock.json >> '${log}'\necho >> '${log}'\nmkdir -p node_modules/ajv\necho '{}' > node_modules/ajv/package.json\n`, { mode: 0o755 });
    const fakeRun = w.deps.run;
    w.deps.run = (cmd, args, options) => (cmd === npm ? runCommand(cmd, args, options) : fakeRun(cmd, args, options));
    assert.equal(await deploy({ ...w.cfg, npm }, w.deps), 0, w.errors());
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      path.join(fs.realpathSync(w.home), 'the-desk-live.staging'),
      'ci --omit=dev',
      LOCK_V1.slice(0, 40),
    ]);
    assert.ok(fs.statSync(path.join(w.live, 'node_modules', 'ajv')).isDirectory());
    assert.equal(fs.existsSync(path.join(w.repo, 'node_modules')), false, 'nothing was installed in the work folder');
  });
});

describe('deploy --dry-run', () => {
  const assertReadOnly = (w) => {
    for (const c of w.calls) {
      if (c.cmd === w.svc.nodePath && c.args[0] === '--input-type=module') continue; // the load check only imports modules
      assert.equal(c.cmd, GIT, `only git and the load check, got ${c.cmd} ${c.args.join(' ')}`);
      assert.ok(READ_ONLY.has(gitSubcommand(c.args)), `read-only git only, got git ${c.args.join(' ')}`);
    }
  };

  test('no live copy yet: prints every step in order, runs only read-only git, and creates nothing', async () => {
    const w = world({ service: 'old' });
    const plistBefore = fs.readFileSync(w.svc.plistPath, 'utf8');
    assert.equal(await w.run('--dry-run'), 0, w.errors());
    assertReadOnly(w);
    assert.equal(fs.existsSync(w.live), false, 'no live copy made');
    assert.equal(fs.existsSync(w.staging), false, 'no staging folder made');
    assert.equal(gitSync(w.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.equal(fs.readFileSync(w.svc.plistPath, 'utf8'), plistBefore);
    const text = w.text();
    const short = w.first.slice(0, 7);
    assert.ok(text.startsWith('Dry run: nothing is changed.\n'));
    assert.ok(text.includes(`Deploying main @ ${short} "First desk" to the live copy, ${w.live}`));
    assert.ok(
      text.includes(
        [
          '1. Install the packages first, outside the live copy (a new live copy):',
          `   mkdir ${w.staging}`,
          `   git -C ${w.repo} show ${w.first}:package.json > ${w.staging}/package.json`,
          `   git -C ${w.repo} show ${w.first}:package-lock.json > ${w.staging}/package-lock.json`,
          `   cd ${w.staging} && /fake/bin/npm ci --omit=dev`,
          '   If that fails, deploy removes the staging folder and stops here: the live copy is untouched.',
          "2. There's no live copy yet. Make it, a git worktree of this repo detached at main:",
          `   git -C ${w.repo} worktree add --detach ${w.live} ${w.first}`,
          '3. Swap the new packages in (the old ones wait in the staging folder until the new code loads):',
          `   mv ${w.staging}/node_modules ${w.live}/node_modules`,
          `4. Check that the new code loads: ${HOMEBREW_NODE} imports server/index.js in the live copy, with the service's environment.`,
          "   If it doesn't, stop without recording or restarting anything.",
          `   Then remove the staging folder: rm -rf ${w.staging}`,
          `5. Write ${w.live}/.deployed.json:`,
          '   {',
          `     "sha": "${w.first}",`,
        ].join('\n'),
      ),
      text,
    );
    assert.ok(text.includes('"deployedAt": "2026-11-28T09:14:03-05:00"'));
    assert.ok(text.includes(`6. Check that the service runs from the live copy (WorkingDirectory in ${w.svc.plistPath}).\n   It doesn't yet, so deploy stops here and says:`));
    assert.ok(text.includes('Run npm run service:install once to move the service to the live copy.'));
  });

  test('existing live copy with a new lockfile: install first, then checkout, swap, record and restart; changes nothing', async () => {
    const w = await deployedWorld();
    const second = w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const recorded = fs.readFileSync(deployedPath(w.live), 'utf8');
    assert.equal(await w.run('--dry-run'), 0, w.errors());
    assertReadOnly(w);
    assert.equal(w.liveHead(), w.first, 'not moved');
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), recorded);
    assert.equal(fs.existsSync(w.staging), false);
    const text = w.text();
    assert.ok(text.includes(`1. Install the packages first, outside the live copy (package-lock.json changed):\n   mkdir ${w.staging}`), text);
    assert.ok(text.includes(`2. The live copy is on ${w.first.slice(0, 7)} and has no changes of its own. Move it to main:\n   git -C ${w.live} checkout --quiet --detach ${second}`));
    const old = w.first.slice(0, 7);
    assert.ok(text.includes(`3. Swap the new packages in (the old ones wait in the staging folder until the new code loads):\n   mv ${w.live}/node_modules ${w.staging}/node_modules.old\n   mv ${w.staging}/node_modules ${w.live}/node_modules\n4. Check that the new code loads:`), text);
    assert.ok(text.includes(`   If it doesn't, put ${old} and its packages back and stop without a restart: The Desk keeps running ${old}.\n   Then remove the staging folder: rm -rf ${w.staging}\n5. Write ${w.live}/.deployed.json:`));
    assert.ok(text.includes('   It does.'));
    assert.ok(text.includes('7. Restart it and wait up to 15 s for http://127.0.0.1:4321/api/feed to answer:\n   /bin/launchctl kickstart -k gui/501/local.thedesk.server'));
    assert.ok(text.endsWith(`8. Say: The Desk is live at http://localhost:4321 on main @ ${second.slice(0, 7)} "Add a package"`));
  });

  test('same lockfile and node_modules there: no npm ci, no swap', async () => {
    const w = await deployedWorld();
    w.commit('Copy', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run('--dry-run'), 0);
    assert.match(w.text(), /1\. Packages: node_modules is there and package-lock\.json is the same, so no npm ci\.\n2\. The live copy is on/);
    assert.doesNotMatch(w.text(), /Swap/);
  });

  test('a leftover staging folder: says it would be removed, and leaves it there', async () => {
    const w = await deployedWorld();
    fs.mkdirSync(path.join(w.staging, 'node_modules'), { recursive: true });
    assert.equal(await w.run('--dry-run'), 0);
    assertReadOnly(w);
    assert.ok(w.text().includes(`1. Remove a staging folder left by an interrupted deploy: rm -rf ${w.staging}`), w.text());
    assert.ok(fs.existsSync(path.join(w.staging, 'node_modules')));
  });

  test('a dirty live copy: the dry run stops where the deploy would', async () => {
    const w = await deployedWorld();
    fs.writeFileSync(path.join(w.live, 'stray.txt'), 'x');
    assert.equal(await w.run('--dry-run'), 1);
    assertReadOnly(w);
    assert.match(w.errors(), /changes of its own/);
  });

  test('a --dry-run that npm swallowed is still a dry run', async () => {
    const w = world();
    assert.equal(await main([], { env: { npm_config_dry_run: 'true' }, deps: w.deps, cfg: w.cfg }), 0);
    assertReadOnly(w);
    assert.equal(fs.existsSync(w.live), false);
  });
});
