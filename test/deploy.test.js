// npm run deploy (scripts/deploy.js). Each test builds a small git repo in a temp folder that stands in
// for the work folder, and a temp home whose the-desk-live is the live copy. git runs for real on those
// temp folders only (with no global or system git config, so no hooks or signing). npm, launchctl,
// lsof and the health check are fakes: nothing here installs packages or touches Snow's service.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import { deployedPath, readDeployed } from '../server/deployed.js';
import { GIT, deploy, deployConfig, main, parseArgs, resolveNpmPath } from '../scripts/deploy.js';
import { HOMEBREW_NODE, LAUNCHCTL, LSOF, buildPlist } from '../scripts/service.js';

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'the-desk-deploy-'));
  tmpDirs.push(dir);
  return dir;
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

/** Runs real git, isolated from the user's git config. Resolves { code, stdout, stderr }. */
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

const LOCK_V1 = '{ "name": "the-desk", "lockfileVersion": 3, "packages": {} }\n';
const LOCK_V2 = '{ "name": "the-desk", "lockfileVersion": 3, "packages": { "node_modules/ajv": {} } }\n';

/**
 * A work folder (a git repo with main), a temp home, and a fake Mac around them.
 * service: 'moved' (the plist runs the live copy, loaded and running), 'old' (the plist still runs the
 * work folder), 'none' (not installed). npmCode: what npm ci exits with. health: false = never answers.
 */
function world({ service = 'moved', npmCode = 0, health = true } = {}) {
  const root = tempDir();
  const repo = path.join(root, 'work');
  const home = path.join(root, 'home');
  const live = path.join(home, 'the-desk-live');
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
    '.gitignore': 'node_modules/\n/.deployed.json*\n',
    'package.json': '{ "name": "the-desk", "type": "module" }\n',
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

  // health: whether The Desk answers after launchd (re)starts it; a test may change it later.
  const state = { loaded: service !== 'none', pid: service !== 'none' ? 4100 : null, deskUp: service !== 'none', health, clock: NOW, nextPid: 4242 };
  const calls = [];
  const out = [];
  const err = [];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const deps = {
    async run(cmd, args, options = {}) {
      calls.push({ cmd, args, cwd: options.cwd });
      if (cmd === GIT) return realGit(args, options);
      if (cmd === cfg.npm) {
        if (npmCode !== 0) return { code: npmCode, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/ajv\n' };
        fs.mkdirSync(path.join(options.cwd, 'node_modules', 'ajv'), { recursive: true });
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
  return { root, repo, home, live, cfg, svc, state, calls, out, err, deps, run, write, commit, first, liveHead, commands, launchctl, text: () => out.join('\n'), errors: () => err.join('\n') };
}

/** A world whose service runs the live copy, already deployed at the first commit (packages installed). */
async function deployedWorld() {
  const w = world();
  assert.equal(await deploy(w.cfg, w.deps), 0, w.errors());
  w.calls.length = 0;
  w.out.length = 0;
  w.err.length = 0;
  return w;
}

// git subcommands that only read. A dry run may use these and nothing else.
const READ_ONLY = new Set(['log', 'rev-parse', 'status', 'diff']);
const gitSubcommand = (args) => {
  const rest = [...args];
  while (rest[0] === '-C' || rest[0] === '--no-optional-locks') rest.splice(0, rest[0] === '-C' ? 2 : 1);
  return rest[0];
};

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
    assert.equal(deployConfig({ env: { DESK_LIVE_DIR: '/tmp/x' }, home: '/Users/snow', uid: 501, nodePath: 'n', npm: 'npm' }).service.runDir, '/tmp/x');
  });

  test('uses the npm next to Homebrew node, else npm from PATH', () => {
    assert.equal(resolveNpmPath('/opt/homebrew/bin/node', { exists: () => true }), '/opt/homebrew/bin/npm');
    assert.equal(resolveNpmPath('/opt/homebrew/bin/node', { exists: () => false }), 'npm');
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

describe('deploy: the first time (no live copy yet)', () => {
  test('makes the live copy as a worktree detached at main, installs packages, records it, then says to move the service', async () => {
    const w = world({ service: 'old' });
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first);
    assert.equal(gitSync(w.live, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached, not on a branch');
    assert.ok(gitSync(w.repo, 'worktree', 'list', '--porcelain').includes(`worktree ${fs.realpathSync(w.live)}`), 'a worktree of the work folder');
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>v1</title>\n');

    const npm = w.commands(w.cfg.npm);
    assert.equal(npm.length, 1);
    assert.deepEqual(npm[0].args, ['ci', '--omit=dev']);
    assert.equal(npm[0].cwd, w.live, 'npm ci runs in the live copy');

    assert.deepEqual(readDeployed(w.live), { sha: w.first, shortSha: w.first.slice(0, 7), subject: 'First desk', ref: 'main', deployedAt: '2026-11-28T09:14:03-05:00' });
    assert.equal(gitSync(w.live, 'status', '--porcelain'), '', '.deployed.json and node_modules are ignored: the copy stays clean');

    assert.deepEqual(w.launchctl(), [], 'the service was not touched');
    assert.ok(w.errors().includes(`The live copy is ready (main @ ${w.first.slice(0, 7)} "First desk"), but The Desk service still runs from ${w.repo}.`));
    assert.match(w.errors(), /Run npm run service:install once to move the service to the live copy\./);
    assert.doesNotMatch(w.text(), /is live at/);
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
    assert.equal(readDeployed(w.live).sha, second);
    assert.equal(readDeployed(w.live).subject, 'News: routes');
    assert.deepEqual(w.launchctl().filter((c) => !c.startsWith('print')), ['kickstart -k gui/501/local.thedesk.server']);
    assert.equal(w.state.pid, 4243, 'a new process');
    assert.match(w.text(), new RegExp(`Moving the live copy from ${w.first.slice(0, 7)} to ${second.slice(0, 7)}`));
    assert.match(w.text(), new RegExp(`OK: The Desk is running at http://localhost:4321 \\(process 4243\\)\\. Restarted from ${w.live}\\.`));
    assert.equal(w.out.at(-1), `The Desk is live at http://localhost:4321 on main @ ${second.slice(0, 7)} "News: routes"`);
  });

  test('runs npm ci --omit=dev in the live copy when package-lock.json changed', async () => {
    const w = await deployedWorld();
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    assert.equal(await w.run(), 0, w.errors());
    const npm = w.commands(w.cfg.npm);
    assert.equal(npm.length, 1);
    assert.deepEqual(npm[0].args, ['ci', '--omit=dev']);
    assert.equal(npm[0].cwd, w.live);
    assert.match(w.text(), /because package-lock\.json changed/);
  });

  test('runs npm ci when node_modules is missing, even if the lockfile is the same', async () => {
    const w = await deployedWorld();
    fs.rmSync(path.join(w.live, 'node_modules'), { recursive: true });
    w.commit('Copy change', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.commands(w.cfg.npm).length, 1);
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
    w.commit('Story work', { 'app/index.html': '<title>story</title>\n' });
    w.write('app/index.html', '<title>uncommitted</title>\n');
    w.write('app/new.js', '// untracked\n');
    assert.equal(await w.run(), 0, w.errors());
    assert.equal(w.liveHead(), onMain);
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>main</title>\n');
    assert.equal(fs.existsSync(path.join(w.live, 'app', 'new.js')), false);
    assert.match(w.text(), /This folder is on branch n9-story\. That doesn't matter: deploy always takes main\./);
    assert.match(w.text(), /This folder has uncommitted changes\. They stay here/);
    assert.equal(fs.readFileSync(path.join(w.repo, 'app', 'index.html'), 'utf8'), '<title>uncommitted</title>\n', 'and the work folder is left alone');
  });

  test('refuses when the live copy has changes of its own, changing nothing', async () => {
    const w = await deployedWorld();
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    w.commit('Next', { 'app/index.html': '<title>v2</title>\n' });
    fs.writeFileSync(path.join(w.live, 'app', 'index.html'), '<title>hand edit</title>\n');
    fs.writeFileSync(path.join(w.live, 'stray.txt'), 'x');
    assert.equal(await w.run(), 1);
    assert.equal(w.liveHead(), w.first, 'not moved');
    assert.equal(fs.readFileSync(path.join(w.live, 'app', 'index.html'), 'utf8'), '<title>hand edit</title>\n', 'the hand edit is kept');
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.equal(w.commands(w.cfg.npm).length, 0);
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

  test('refuses to use the work folder itself, or a folder inside it, as the live copy', async () => {
    const w = world();
    for (const live of [w.repo, path.join(w.repo, 'live')]) {
      const cfg = deployConfig({ env: { DESK_LIVE_DIR: live }, home: w.home, uid: 501, repoRoot: w.repo, nodePath: HOMEBREW_NODE, npm: '/fake/bin/npm' });
      assert.equal(await deploy(cfg, w.deps), 1);
    }
    assert.match(w.errors(), /can't be this folder or sit inside it/);
    assert.deepEqual(w.calls, []);
  });

  test('refuses when there is no main branch', async () => {
    const w = world();
    gitSync(w.repo, 'branch', '-q', '-m', 'main', 'trunk');
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /There's no main branch in .* to deploy, so nothing was changed\./);
    assert.equal(fs.existsSync(w.live), false);
  });

  test('when npm ci fails, it does not restart or record the deploy', async () => {
    const w = await deployedWorld();
    w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const before = fs.readFileSync(deployedPath(w.live), 'utf8');
    const failing = world({ npmCode: 1 });
    w.deps.run = ((run) => async (cmd, args, options) => (cmd === w.cfg.npm ? failing.deps.run(cmd, args, options) : run(cmd, args, options)))(w.deps.run);
    assert.equal(await w.run(), 1);
    assert.match(w.errors(), /npm ci didn't work in the live copy, so The Desk was not restarted[\s\S]*E404/);
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), before);
    assert.ok(!w.launchctl().includes('kickstart -k gui/501/local.thedesk.server'));
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

describe('deploy --dry-run', () => {
  const assertReadOnly = (w) => {
    for (const c of w.calls) {
      assert.equal(c.cmd, GIT, `only git, got ${c.cmd} ${c.args.join(' ')}`);
      assert.ok(READ_ONLY.has(gitSubcommand(c.args)), `read-only git only, got git ${c.args.join(' ')}`);
    }
  };

  test('no live copy yet: prints every step, runs only read-only git, and creates nothing', async () => {
    const w = world({ service: 'old' });
    const plistBefore = fs.readFileSync(w.svc.plistPath, 'utf8');
    assert.equal(await w.run('--dry-run'), 0, w.errors());
    assertReadOnly(w);
    assert.equal(fs.existsSync(w.live), false, 'no live copy made');
    assert.equal(gitSync(w.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.equal(fs.readFileSync(w.svc.plistPath, 'utf8'), plistBefore);
    const text = w.text();
    const short = w.first.slice(0, 7);
    assert.ok(text.startsWith('Dry run: nothing is changed.\n'));
    assert.ok(text.includes(`Deploying main @ ${short} "First desk" to the live copy, ${w.live}`));
    assert.ok(text.includes(`1. There's no live copy yet. Make it, a git worktree of this repo detached at main:\n   git -C ${w.repo} worktree add --detach ${w.live} ${w.first}`));
    assert.ok(text.includes(`2. Install its packages (a new live copy):\n   cd ${w.live} && /fake/bin/npm ci --omit=dev`));
    assert.ok(text.includes(`3. Write ${w.live}/.deployed.json:\n   {\n     "sha": "${w.first}",`));
    assert.ok(text.includes('"deployedAt": "2026-11-28T09:14:03-05:00"'));
    assert.ok(text.includes(`4. Check that the service runs from the live copy (WorkingDirectory in ${w.svc.plistPath}).\n   It doesn't yet, so deploy stops here and says:`));
    assert.ok(text.includes('Run npm run service:install once to move the service to the live copy.'));
  });

  test('existing live copy with a new lockfile: shows the checkout, npm ci and the restart, changes nothing', async () => {
    const w = await deployedWorld();
    const second = w.commit('Add a package', { 'package-lock.json': LOCK_V2 });
    const recorded = fs.readFileSync(deployedPath(w.live), 'utf8');
    assert.equal(await w.run('--dry-run'), 0, w.errors());
    assertReadOnly(w);
    assert.equal(w.liveHead(), w.first, 'not moved');
    assert.equal(fs.readFileSync(deployedPath(w.live), 'utf8'), recorded);
    const text = w.text();
    assert.ok(text.includes(`1. The live copy is on ${w.first.slice(0, 7)} and has no changes of its own. Move it to main:\n   git -C ${w.live} checkout --quiet --detach ${second}`));
    assert.ok(text.includes(`2. Install its packages (package-lock.json changed):\n   cd ${w.live} && /fake/bin/npm ci --omit=dev`));
    assert.ok(text.includes('   It does.'));
    assert.ok(text.includes('5. Restart it and wait up to 15 s for http://127.0.0.1:4321/api/feed to answer:\n   /bin/launchctl kickstart -k gui/501/local.thedesk.server'));
    assert.ok(text.endsWith(`6. Say: The Desk is live at http://localhost:4321 on main @ ${second.slice(0, 7)} "Add a package"`));
  });

  test('same lockfile and node_modules there: says no npm ci is needed', async () => {
    const w = await deployedWorld();
    w.commit('Copy', { 'app/index.html': '<title>v2</title>\n' });
    assert.equal(await w.run('--dry-run'), 0);
    assert.match(w.text(), /2\. Packages: node_modules is there and package-lock\.json is the same, so no npm ci\./);
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
