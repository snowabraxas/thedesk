// The always-on service (scripts/service.js). launchctl is never called: every command goes through
// a fake that keeps launchd's state in memory. Files go to a temp home folder, and the live copy the
// service runs from is a stand-in folder at <temp home>/the-desk-live.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, servicePlistPath } from '../server/config.js';
import { deployedPath, deployedRecord } from '../server/deployed.js';
import {
  GIT,
  CLI_SCRIPTS,
  HOMEBREW_NODE,
  LOAD_CHECK_CODE,
  isCliEntry,
  guardLaunchctl,
  launchdRefusal,
  liveStatusArgs,
  loadCheck,
  outputKeeper,
  missingPackages,
  runCommand,
  LAUNCHCTL,
  LSOF,
  PLUTIL,
  buildPlist,
  dryRunText,
  isDisabled,
  lastLines,
  main,
  parseArgs,
  parseLaunchctlPrint,
  plistWorkingDirectory,
  protectedFolder,
  readLogSince,
  realDeps,
  runningGroups,
  resolveNodePath,
  serviceConfig,
  shellQuote,
  xmlEscape,
} from '../scripts/service.js';

const tmpDirs = [];
after(() => tmpDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = (prefix = 'the-desk-service-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

// What `launchctl print gui/501/local.thedesk.server` says, in its real layout.
function printText(s) {
  return [
    'gui/501/local.thedesk.server = {',
    '\tactive count = 1',
    '\tpath = /Users/x/Library/LaunchAgents/local.thedesk.server.plist',
    '\ttype = LaunchAgent',
    `\tstate = ${s.pid ? 'running' : 'spawn scheduled'}`,
    '',
    '\tprogram = /opt/homebrew/bin/node',
    '\tenvironment = {',
    '\t\tpid = 1',
    '\t\tstate = nested, not ours',
    '\t}',
    `\truns = ${s.runs}`,
    ...(s.pid ? [`\tpid = ${s.pid}`] : []),
    `\tlast exit code = ${s.lastExit}`,
    '}',
  ].join('\n');
}

/** Every file and folder under dir, as relative paths, sorted. */
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

const SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

// What node prints when ajv can't find fast-deep-equal.
const LOAD_FAIL = "node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\nError: Cannot find module 'fast-deep-equal'\nRequire stack:\n- /x/node_modules/ajv/dist/compile/resolve.js\n";

const RECORD = deployedRecord({ sha: SHA, subject: 'N1: live copy', deployedAt: '2026-11-28T09:14:03-05:00' });

/**
 * A fake Mac: launchd's state for our label, who holds the port, whether The Desk answers, a clock.
 * onStart(state, world) runs when launchd would start the server (bootstrap or kickstart).
 * The live copy is <home>/the-desk-live, fully deployed: server/index.js, a package.json naming ajv,
 * node_modules/ajv/package.json, and a .deployed.json for the commit git says it holds
 * (state.liveHead). liveCopy: false leaves it all out; inDocuments: true puts it in ~/Documents
 * instead, where macOS privacy applies.
 */
function fakeMac({ loaded = false, pid = null, portHolder = null, deskUp = false, disabled = false, platform = 'darwin', lint = 0, bootstrapCode = 0, onStart, liveCopy = true, inDocuments = false } = {}) {
  const home = tempDir();
  const runDir = inDocuments ? path.join(home, 'Documents', 'Projects', 'the-desk') : path.join(home, 'the-desk-live');
  const cfg = serviceConfig({ home, uid: 501, runDir, nodePath: HOMEBREW_NODE });
  if (liveCopy) {
    fs.mkdirSync(path.join(runDir, 'server'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'node_modules', 'ajv'), { recursive: true });
    fs.writeFileSync(cfg.serverPath, '// stand-in\n');
    fs.writeFileSync(path.join(runDir, 'package.json'), JSON.stringify({ name: 'the-desk', dependencies: { ajv: '^8.20.0' }, devDependencies: { 'playwright-core': '^1' } }));
    fs.writeFileSync(path.join(runDir, 'node_modules', 'ajv', 'package.json'), '{ "name": "ajv" }');
    fs.writeFileSync(deployedPath(runDir), JSON.stringify(RECORD));
  }
  // liveHead: the commit git says the live copy holds; liveStatus: its git status; loads: whether its server loads.
  const state = { loaded, pid, portHolder, deskUp, disabled, runs: loaded ? 1 : 0, lastExit: '(never exited)', clock: 0, nextPid: 4242, liveHead: SHA, liveStatus: '', loads: true };
  const calls = [];
  const out = [];
  const err = [];
  const appendLog = (text) => {
    fs.mkdirSync(cfg.logDir, { recursive: true });
    fs.appendFileSync(cfg.logPath, text);
  };
  const startServer =
    onStart ||
    ((s) => {
      s.pid = s.nextPid++;
      s.portHolder = s.pid;
      s.deskUp = true;
      appendLog('The Desk is running at http://localhost:4321\n');
    });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const stopServer = () => {
    if (state.portHolder !== null && state.portHolder === state.pid) {
      state.portHolder = null;
      state.deskUp = false;
    }
    state.pid = null;
  };
  const deps = {
    async run(cmd, args, options = {}) {
      calls.push([cmd, ...args].join(' '));
      if (cmd === GIT && args[2] === 'rev-parse') {
        assert.deepEqual(args, ['-C', cfg.runDir, 'rev-parse', 'HEAD']);
        return state.liveHead ? ok(`${state.liveHead}\n`) : { code: 128, stdout: '', stderr: 'fatal: not a git repository\n' };
      }
      if (cmd === GIT) {
        assert.deepEqual(args, liveStatusArgs(cfg.runDir), 'the only other git the service runs');
        return ok(state.liveStatus);
      }
      if (cmd === cfg.nodePath) {
        assert.deepEqual(args, ['--input-type=module', '-e', LOAD_CHECK_CODE]);
        assert.equal(options.cwd, cfg.runDir, 'the load check runs in the live copy');
        return state.loads ? ok() : { code: 1, stdout: '', stderr: LOAD_FAIL };
      }
      if (cmd === PLUTIL) return lint === 0 ? ok(`${args[1]}: OK\n`) : { code: 1, stdout: `${args[1]}: Encountered unexpected element\n`, stderr: '' };
      if (cmd === LSOF) return state.portHolder ? ok(`${state.portHolder}\n`) : { code: 1, stdout: '', stderr: '' };
      assert.equal(cmd, LAUNCHCTL);
      switch (args[0]) {
        case 'print':
          return state.loaded ? ok(printText(state)) : { code: 113, stdout: '', stderr: `Bad request.\nCould not find service "${cfg.label}" in domain for user gui: 501\n` };
        case 'print-disabled':
          return ok(`\tdisabled services = {\n\t\t"com.example.other" => disabled\n\t\t"${cfg.label}" => ${state.disabled ? 'disabled' : 'enabled'}\n\t}\n`);
        case 'enable':
          state.disabled = false;
          return ok();
        case 'bootstrap':
          if (bootstrapCode !== 0) return { code: bootstrapCode, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' };
          if (state.loaded || state.disabled) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' };
          state.loaded = true;
          state.runs += 1;
          startServer(state, { appendLog });
          return ok();
        case 'bootout':
          if (!state.loaded) return { code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process\n' };
          stopServer();
          state.loaded = false;
          return ok();
        case 'kickstart':
          stopServer();
          state.runs += 1;
          startServer(state, { appendLog });
          return ok();
        default:
          throw new Error(`unexpected launchctl ${args.join(' ')}`);
      }
    },
    portIsFree: async () => state.portHolder === null,
    probe: async () => (state.deskUp ? { ok: true, source: 'sample' } : { ok: false, error: 'ECONNREFUSED' }),
    sleep: async (ms) => {
      state.clock += ms;
    },
    now: () => state.clock,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fs,
    platform,
  };
  const launchctl = () => calls.filter((c) => c.startsWith(`${LAUNCHCTL} `)).map((c) => c.slice(LAUNCHCTL.length + 1));
  const run = (...argv) => main(argv, { env: {}, deps, cfg });
  return { home, cfg, state, calls, launchctl, out, err, deps, run, appendLog, text: () => out.join('\n'), errors: () => err.join('\n') };
}

describe('parseArgs', () => {
  test('takes one command, and --dry-run with install only', () => {
    for (const command of ['install', 'uninstall', 'start', 'stop', 'restart', 'status']) {
      assert.deepEqual(parseArgs([command]), { command, dryRun: false });
    }
    assert.deepEqual(parseArgs(['install', '--dry-run']), { command: 'install', dryRun: true });
    assert.deepEqual(parseArgs(['--dry-run', 'install']), { command: 'install', dryRun: true });
    assert.match(parseArgs(['stop', '--dry-run']).error, /--dry-run only works with install/);
  });

  test('a --dry-run that npm swallowed (npm_config_dry_run) still counts', () => {
    assert.deepEqual(parseArgs(['install'], { npm_config_dry_run: 'true' }), { command: 'install', dryRun: true });
    assert.deepEqual(parseArgs(['install'], { npm_config_dry_run: '' }), { command: 'install', dryRun: false });
  });

  test('refuses unknown commands, extra words and unknown options', () => {
    assert.match(parseArgs([]).error, /Say which command/);
    assert.match(parseArgs(['launch']).error, /Unknown command "launch"/);
    assert.match(parseArgs(['start', 'stop']).error, /Unknown command "start stop"/);
    assert.match(parseArgs(['install', '--force']).error, /Unknown option "--force"/);
  });

  test('help', () => {
    assert.deepEqual(parseArgs(['--help']), { command: 'help' });
    assert.deepEqual(parseArgs(['-h']), { command: 'help' });
    assert.deepEqual(parseArgs(['help']), { command: 'help' });
  });
});

describe('service config and plist', () => {
  test('prefers Homebrew node (the symlink, which follows upgrades), else the node running this', () => {
    assert.equal(resolveNodePath({ exists: (p) => p === '/opt/homebrew/bin/node', execPath: '/x/node' }), '/opt/homebrew/bin/node');
    assert.equal(resolveNodePath({ exists: () => false, execPath: '/usr/local/bin/node' }), '/usr/local/bin/node');
  });

  test('derives every path from the home folder and the user id; it runs the live copy, not this checkout', () => {
    const cfg = serviceConfig({ home: '/Users/snow', uid: 501, env: {}, nodePath: '/opt/homebrew/bin/node' });
    assert.equal(cfg.label, 'local.thedesk.server');
    assert.equal(cfg.domain, 'gui/501');
    assert.equal(cfg.target, 'gui/501/local.thedesk.server');
    assert.equal(cfg.plistPath, '/Users/snow/Library/LaunchAgents/local.thedesk.server.plist');
    assert.equal(cfg.runDir, '/Users/snow/the-desk-live');
    assert.equal(cfg.serverPath, '/Users/snow/the-desk-live/server/index.js');
    assert.notEqual(cfg.runDir, REPO_ROOT);
    assert.equal(cfg.logPath, '/Users/snow/agent-house/logs/the-desk.log');
    assert.equal(cfg.port, 4321);
    assert.deepEqual(cfg.env, {
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      DESK_HOME: '/Users/snow/agent-house',
      PORT: '4321',
      DESK_LOG: '/Users/snow/agent-house/logs/the-desk.log',
      DESK_SERVICE: '1',
    });
  });

  test('DESK_LIVE_DIR (or runDir) moves the live copy it runs', () => {
    assert.equal(serviceConfig({ home: '/Users/snow', uid: 501, env: { DESK_LIVE_DIR: '/tmp/live' }, nodePath: 'n' }).serverPath, '/tmp/live/server/index.js');
    assert.equal(serviceConfig({ home: '/Users/snow', uid: 501, runDir: '/srv/desk', nodePath: 'n' }).runDir, '/srv/desk');
  });

  test('the plist runs node on server/index.js in the live copy, at login, and again whenever it stops', () => {
    const cfg = serviceConfig({ home: '/Users/snow', uid: 501, env: {}, nodePath: '/opt/homebrew/bin/node' });
    const plist = buildPlist(cfg);
    assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    assert.match(plist, /<key>Label<\/key>\n\t<string>local\.thedesk\.server<\/string>/);
    assert.match(plist, /<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/opt\/homebrew\/bin\/node<\/string>\n\t\t<string>\/Users\/snow\/the-desk-live\/server\/index\.js<\/string>\n\t<\/array>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\n\t<string>\/Users\/snow\/the-desk-live<\/string>/);
    assert.equal(plistWorkingDirectory(plist), '/Users/snow/the-desk-live');
    assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\n\t<true\/>/, 'KeepAlive true: restarted after a crash and after a clean exit (SIGTERM exits 0)');
    assert.match(plist, /<key>ThrottleInterval<\/key>\n\t<integer>10<\/integer>/);
    assert.match(plist, /<key>StandardOutPath<\/key>\n\t<string>\/Users\/snow\/agent-house\/logs\/the-desk\.log<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>\n\t<string>\/Users\/snow\/agent-house\/logs\/the-desk\.log<\/string>/);
    assert.match(plist, /<key>DESK_HOME<\/key>\n\t\t<string>\/Users\/snow\/agent-house<\/string>/);
    assert.match(plist, /<key>PORT<\/key>\n\t\t<string>4321<\/string>/);
    assert.equal(buildPlist(cfg), plist, 'pure: the same config gives the same text');
  });

  test('every value is XML-escaped: &, <, >, quotes and spaces in paths', () => {
    const odd = `/Users/s & o/Projects <dev>/"the" desk's`;
    const cfg = serviceConfig({ home: '/Users/s & o', uid: 501, runDir: odd, nodePath: '/opt/node <1> & "2"' });
    const plist = buildPlist(cfg);
    assert.ok(plist.includes(`<string>/Users/s &amp; o/Projects &lt;dev&gt;/&quot;the&quot; desk&apos;s</string>`));
    assert.ok(plist.includes('<string>/opt/node &lt;1&gt; &amp; &quot;2&quot;</string>'));
    assert.ok(plist.includes('<string>/Users/s &amp; o/agent-house/logs/the-desk.log</string>'));
    const text = plist.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '');
    const values = text.replace(/<\/?(plist|dict|key|string|array|true|integer)( version="1\.0")?\/?>/g, '');
    assert.doesNotMatch(values, /[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/, 'no raw <, >, quotes or & left in any value');
    assert.equal(plistWorkingDirectory(plist), odd, 'and reads back the same');
  });

  test('plistWorkingDirectory reads the folder an installed plist runs in', () => {
    assert.equal(plistWorkingDirectory('<key>WorkingDirectory</key>\n\t<string>/a/&#38;b &#x3c;c&#x3E;</string>'), '/a/&b <c>');
    assert.equal(plistWorkingDirectory('<plist><dict></dict></plist>'), null);
    assert.equal(plistWorkingDirectory(''), null);
  });

  test('plutil reads the escaped values back exactly (macOS only)', { skip: !fs.existsSync(PLUTIL) && 'no plutil here' }, () => {
    const odd = `/tmp/a & b/<c> "d" 'e'/the desk`;
    const cfg = serviceConfig({ home: '/Users/s & o', uid: 501, runDir: odd, nodePath: '/opt/homebrew/bin/node' });
    const file = path.join(tempDir(), 'odd.plist');
    fs.writeFileSync(file, buildPlist(cfg));
    const lint = spawnSync(PLUTIL, ['-lint', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const json = spawnSync(PLUTIL, ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.ProgramArguments, ['/opt/homebrew/bin/node', path.join(odd, 'server', 'index.js')]);
    assert.equal(parsed.WorkingDirectory, odd);
    assert.equal(parsed.Label, 'local.thedesk.server');
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.KeepAlive, true);
    assert.equal(parsed.ThrottleInterval, 10);
    assert.deepEqual(parsed.EnvironmentVariables, cfg.env);
    assert.equal(parsed.StandardOutPath, '/Users/s & o/agent-house/logs/the-desk.log');
  });

  test('refuses control characters, which XML cannot carry', () => {
    assert.throws(() => xmlEscape('/tmp/a\u0001b'), /control character/);
    assert.equal(xmlEscape('tab\tand\nnewline'), 'tab\tand\nnewline');
  });

  test('shellQuote quotes only what needs it', () => {
    assert.equal(shellQuote('/bin/launchctl'), '/bin/launchctl');
    assert.equal(shellQuote('gui/501/local.thedesk.server'), 'gui/501/local.thedesk.server');
    assert.equal(shellQuote("/Users/s o/it's"), `'/Users/s o/it'\\''s'`);
  });
});

describe('reading launchctl and the log', () => {
  test('parseLaunchctlPrint reads the top-level fields only', () => {
    assert.deepEqual(parseLaunchctlPrint(printText({ pid: 812, runs: 3, lastExit: '1' })), {
      state: 'running',
      pid: 812,
      lastExitCode: '1',
      lastSignal: null,
      runs: 3,
    });
    const stopped = parseLaunchctlPrint(printText({ pid: null, runs: 2, lastExit: '78: EX_CONFIG' }));
    assert.equal(stopped.pid, null);
    assert.equal(stopped.state, 'spawn scheduled');
    assert.equal(stopped.lastExitCode, '78: EX_CONFIG');
    assert.equal(parseLaunchctlPrint('\tlast terminating signal = Killed: 9\n').lastSignal, 'Killed: 9');
  });

  test('isDisabled reads launchctl print-disabled', () => {
    const text = '\tdisabled services = {\n\t\t"local.thedesk.server" => disabled\n\t\t"local.thedesk.serverx" => enabled\n\t}\n';
    assert.equal(isDisabled(text, 'local.thedesk.server'), true);
    assert.equal(isDisabled(text.replace('=> disabled', '=> enabled'), 'local.thedesk.server'), false);
    assert.equal(isDisabled('"local.thedesk.server" => true', 'local.thedesk.server'), true);
    assert.equal(isDisabled('"localXthedeskXserver" => disabled', 'local.thedesk.server'), false);
  });

  test('protectedFolder spots Documents, Desktop and Downloads', () => {
    assert.equal(protectedFolder('/Users/snow/Documents/Projects/the-desk', '/Users/snow'), 'Documents');
    assert.equal(protectedFolder('/Users/snow/Desktop/the-desk', '/Users/snow'), 'Desktop');
    assert.equal(protectedFolder('/Users/snow/code/the-desk', '/Users/snow'), null);
    assert.equal(protectedFolder('/Users/snow/DocumentsOld/the-desk', '/Users/snow'), null);
  });

  test('readLogSince reads only what is new, and all of it after the log was emptied', () => {
    const file = path.join(tempDir(), 'the-desk.log');
    fs.writeFileSync(file, 'old line\n');
    const offset = fs.statSync(file).size;
    fs.appendFileSync(file, 'new line\n');
    assert.equal(readLogSince(fs, file, offset), 'new line\n');
    fs.writeFileSync(file, 'x\n');
    assert.equal(readLogSince(fs, file, 1000), 'x\n');
    assert.equal(readLogSince(fs, path.join(path.dirname(file), 'missing.log'), 0), '');
  });

  test('lastLines', () => {
    assert.deepEqual(lastLines(''), []);
    assert.deepEqual(lastLines('a\nb\nc\n', 2), ['b', 'c']);
  });
});

describe('service:install', () => {
  test('--dry-run prints the plist and the exact commands, and changes nothing', async () => {
    const mac = fakeMac();
    fs.writeFileSync(deployedPath(mac.cfg.runDir), JSON.stringify(deployedRecord({ sha: SHA, subject: 'N1: live copy', deployedAt: '2026-11-28T09:14:03-05:00' })));
    const before = tree(mac.home);
    assert.equal(await mac.run('install', '--dry-run'), 0);
    assert.deepEqual(mac.launchctl(), [], 'no launchctl');
    assert.deepEqual(
      mac.calls.map((c) => c.split(' ').slice(0, 4).join(' ')),
      [`git -C ${mac.cfg.runDir} rev-parse`, `git -C ${mac.cfg.runDir} --no-optional-locks`, `${HOMEBREW_NODE} --input-type=module -e const`],
      'only read-only looks: its commit, its git status, and whether its server loads',
    );
    assert.deepEqual(tree(mac.home), before, 'no file or folder was written');
    const text = mac.text();
    assert.ok(text.startsWith('Dry run: nothing is changed.'));
    assert.ok(text.includes(`The service will run The Desk from the live copy: ${mac.cfg.runDir}, main @ c0ffee0 "N1: live copy", deployed 2026-11-28T09:14:03-05:00`));
    assert.ok(text.includes(buildPlist(mac.cfg)), 'the whole plist');
    assert.ok(text.includes(`<key>WorkingDirectory</key>\n\t<string>${mac.cfg.runDir}</string>`));
    assert.ok(text.includes(`8. Load and start it: /bin/launchctl bootstrap gui/501 ${mac.cfg.plistPath}`));
    assert.ok(text.includes('/bin/launchctl bootout gui/501/local.thedesk.server'));
    assert.ok(text.includes('/bin/launchctl kickstart -k gui/501/local.thedesk.server'));
    assert.ok(text.includes(`/usr/bin/plutil -lint ${mac.cfg.plistPath}`));
  });

  test('--dry-run says so when the live copy is not there yet', async () => {
    const mac = fakeMac({ liveCopy: false });
    assert.equal(await mac.run('install', '--dry-run'), 0);
    assert.deepEqual(mac.calls, []);
    assert.deepEqual(tree(mac.home), []);
    assert.ok(mac.text().includes(`The service will run The Desk from the live copy: ${mac.cfg.runDir} (not there yet: make it with npm run deploy)`));
    assert.equal(mac.text(), dryRunText(mac.cfg, { liveCopy: `${mac.cfg.runDir} (not there yet: make it with npm run deploy)` }));
  });

  test('refuses, changing nothing, when the live copy is not there yet: run npm run deploy first', async () => {
    const mac = fakeMac({ liveCopy: false });
    assert.equal(await mac.run('install'), 1);
    assert.match(mac.errors(), new RegExp(`The live copy isn't there yet \\(${mac.cfg.runDir}\\), so nothing was changed\\.\\nRun npm run deploy first`));
    assert.deepEqual(mac.calls, [], 'not even launchctl print');
    assert.deepEqual(tree(mac.home), []);
  });

  /** Install must refuse a half-deployed live copy before it touches launchd at all. */
  async function refusesHalfDeployed(mac, problem) {
    const before = tree(mac.home);
    assert.equal(await mac.run('install'), 1);
    const errors = mac.errors();
    assert.ok(errors.startsWith(`The live copy isn't fully deployed yet (${mac.cfg.runDir}: ${problem}), so nothing was changed.\n`), errors);
    assert.match(errors, /Run npm run deploy until it finishes \(it repairs this, or says what to do\), then run npm run service:install again\./);
    assert.deepEqual(mac.launchctl(), [], 'no launchctl at all: the running service is left alone');
    assert.deepEqual(tree(mac.home), before);
  }

  test('refuses, changing nothing, when the live copy has no packages yet (a deploy stopped at npm ci)', async () => {
    const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    fs.rmSync(path.join(mac.cfg.runDir, 'node_modules'), { recursive: true });
    await refusesHalfDeployed(mac, 'no node_modules');
    assert.equal(mac.state.pid, 4100);
  });

  test('refuses an empty or incomplete node_modules: every package in package.json must be there', async () => {
    const empty = fakeMac();
    fs.rmSync(path.join(empty.cfg.runDir, 'node_modules', 'ajv'), { recursive: true });
    await refusesHalfDeployed(empty, 'node_modules is incomplete (no ajv)');

    const half = fakeMac();
    fs.rmSync(path.join(half.cfg.runDir, 'node_modules', 'ajv', 'package.json'));
    await refusesHalfDeployed(half, 'node_modules is incomplete (no ajv)');

    const noManifest = fakeMac();
    fs.rmSync(path.join(noManifest.cfg.runDir, 'package.json'));
    await refusesHalfDeployed(noManifest, 'no readable package.json');
  });

  test('refuses, changing nothing, when the live copy has no readable .deployed.json', async () => {
    for (const broken of [null, 'not json', JSON.stringify({ sha: 'main' })]) {
      const mac = fakeMac();
      if (broken === null) fs.rmSync(deployedPath(mac.cfg.runDir));
      else fs.writeFileSync(deployedPath(mac.cfg.runDir), broken);
      await refusesHalfDeployed(mac, 'no readable .deployed.json');
      assert.equal(fs.existsSync(mac.cfg.plistPath), false);
    }
  });

  test('refuses a stale .deployed.json: the live copy holds another commit than the last finished deploy', async () => {
    const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    mac.state.liveHead = 'beef00000000000000000000000000000000beef';
    await refusesHalfDeployed(mac, 'it holds beef000, but the last deploy that finished was main @ c0ffee0 "N1: live copy"');
    assert.equal(mac.state.pid, 4100);
  });

  test("refuses when git can't say which commit the live copy holds", async () => {
    const mac = fakeMac();
    mac.state.liveHead = null;
    await refusesHalfDeployed(mac, "git can't read which commit it holds");
  });

  test('refuses a live copy with changes of its own (a deleted tracked file)', async () => {
    const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    mac.state.liveStatus = ' D server/feed.js\n';
    await refusesHalfDeployed(mac, 'it has changes of its own (D server/feed.js)');
    assert.ok(!mac.calls.some((c) => c.startsWith(HOMEBREW_NODE)), 'no load check once something else is wrong');
  });

  test("refuses a live copy whose server doesn't load (ajv without fast-deep-equal)", async () => {
    const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    mac.state.loads = false;
    await refusesHalfDeployed(mac, "its server doesn't load: Error: Cannot find module 'fast-deep-equal'");
    assert.equal(mac.state.pid, 4100);
  });

  test('the live copy git status leaves out .deployed.json and its temp file, nothing else', () => {
    assert.deepEqual(liveStatusArgs('/x/live'), ['-C', '/x/live', '--no-optional-locks', 'status', '--porcelain', '--', '.', ':!/.deployed.json*']);
    const dir = tempDir();
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, '.deployed.json'), '{}');
    fs.writeFileSync(path.join(dir, '.deployed.json.tmp-123'), '{}');
    assert.equal(git(...liveStatusArgs(dir)).stdout, '', 'an older .gitignore without them: still clean');
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
    assert.equal(git(...liveStatusArgs(dir)).stdout, '?? stray.txt\n');
  });

  test('loadCheck imports the server in a child node: a missing package fails, the real repo loads', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'server'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'ajv'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'index.js'), "import 'ajv';\n");
    fs.writeFileSync(path.join(dir, 'node_modules', 'ajv', 'package.json'), '{ "name": "ajv", "main": "index.js" }');
    fs.writeFileSync(path.join(dir, 'node_modules', 'ajv', 'index.js'), "require('fast-deep-equal');\n");
    const deps = { run: runCommand };
    const svc = { nodePath: process.execPath, env: { PATH: process.env.PATH }, home: os.homedir() };
    assert.deepEqual(await loadCheck(dir, svc, deps), { ok: false, error: "Error: Cannot find module 'fast-deep-equal'" });
    fs.writeFileSync(path.join(dir, 'node_modules', 'ajv', 'index.js'), 'module.exports = {};\n');
    assert.deepEqual(await loadCheck(dir, svc, deps), { ok: true });
    assert.deepEqual(await loadCheck(REPO_ROOT, svc, deps), { ok: true }, 'this repo: server/index.js imports without starting');
  });

  test("loadCheck runs with the service's own environment (plus HOME), never this shell's", async () => {
    const seen = [];
    const cfg = serviceConfig({ home: '/Users/snow', uid: 501, env: {}, nodePath: HOMEBREW_NODE });
    await loadCheck('/Users/snow/the-desk-live', cfg, { run: async (cmd, args, options) => (seen.push({ cmd, options }), { code: 0, stdout: '', stderr: '' }) });
    assert.equal(seen[0].cmd, HOMEBREW_NODE);
    assert.deepEqual(seen[0].options.env, { ...cfg.env, HOME: '/Users/snow' });
    assert.equal(seen[0].options.cwd, '/Users/snow/the-desk-live');

    // For real: code that only loads thanks to this shell's NODE_OPTIONS fails, as it would under launchd.
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'index.js'), "if (!globalThis.preloaded) throw new Error('needs a preload the service will not have');\n");
    const preload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(preload, 'globalThis.preloaded = true;\n');
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require ${preload}`;
    try {
      const svc = { nodePath: process.execPath, env: { PATH: process.env.PATH }, home: os.homedir() };
      assert.deepEqual(await loadCheck(dir, svc, { run: runCommand }), { ok: false, error: 'Error: needs a preload the service will not have' });
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
  });

  test('missingPackages lists dependencies (not devDependencies) with no package.json in node_modules', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { ajv: '1', '@scope/x': '1' }, devDependencies: { dev: '1' } }));
    assert.deepEqual(missingPackages(dir), ['ajv', '@scope/x']);
    fs.mkdirSync(path.join(dir, 'node_modules', '@scope', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '@scope', 'x', 'package.json'), '{}');
    assert.deepEqual(missingPackages(dir), ['ajv']);
    assert.deepEqual(missingPackages(dir, fs, path.join(dir, 'elsewhere')), ['ajv', '@scope/x']);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    assert.deepEqual(missingPackages(dir), []);
    fs.writeFileSync(path.join(dir, 'package.json'), 'nope');
    assert.equal(missingPackages(dir), null);
  });

  test('--dry-run says when the live copy is not fully deployed', async () => {
    const mac = fakeMac();
    fs.rmSync(path.join(mac.cfg.runDir, 'node_modules'), { recursive: true });
    fs.rmSync(deployedPath(mac.cfg.runDir));
    assert.equal(await mac.run('install', '--dry-run'), 0);
    assert.ok(mac.text().includes(`from the live copy: ${mac.cfg.runDir} (not fully deployed: no node_modules; no readable .deployed.json; run npm run deploy)`), mac.text());
    assert.match(mac.text(), /1\. Check that the live copy is fully deployed: server\/index\.js and no changes of its own, every package in its package\.json, a \.deployed\.json for the commit it holds, and a server that loads\./);
  });

  test('moves a service that ran from the work folder over to the live copy', async () => {
    const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    const old = buildPlist({ ...mac.cfg, runDir: path.join(mac.home, 'Documents', 'Projects', 'the-desk'), serverPath: path.join(mac.home, 'Documents', 'Projects', 'the-desk', 'server', 'index.js') });
    fs.mkdirSync(path.dirname(mac.cfg.plistPath), { recursive: true });
    fs.writeFileSync(mac.cfg.plistPath, old);
    assert.equal(await mac.run('install'), 0, mac.errors());
    const plist = fs.readFileSync(mac.cfg.plistPath, 'utf8');
    assert.equal(plistWorkingDirectory(plist), mac.cfg.runDir);
    assert.ok(plist.includes(`<string>${mac.cfg.runDir}/server/index.js</string>`));
    assert.ok(!plist.includes(path.join(mac.home, 'Documents')), 'nothing in the plist points at the work folder any more');
    const calls = mac.launchctl();
    assert.ok(calls.indexOf('bootout gui/501/local.thedesk.server') < calls.indexOf(`bootstrap gui/501 ${mac.cfg.plistPath}`), 'the old one stops first');
    assert.match(mac.text(), new RegExp(`running The Desk from ${mac.cfg.runDir}`));
  });

  test('a --dry-run that npm swallowed is still a dry run', async () => {
    const mac = fakeMac();
    assert.equal(await main(['install'], { env: { npm_config_dry_run: 'true' }, deps: mac.deps, cfg: mac.cfg }), 0);
    assert.deepEqual(mac.launchctl(), []);
    assert.equal(fs.existsSync(mac.cfg.plistPath), false);
    assert.match(mac.text(), /^Dry run/);
  });

  test('writes the plist, makes the log folder, loads it and waits for The Desk to answer', async () => {
    const mac = fakeMac();
    assert.equal(await mac.run('install'), 0, mac.errors());
    assert.equal(fs.readFileSync(mac.cfg.plistPath, 'utf8'), buildPlist(mac.cfg));
    assert.ok(fs.statSync(mac.cfg.logDir).isDirectory());
    assert.ok(mac.calls.includes(`${PLUTIL} -lint ${mac.cfg.plistPath}`));
    assert.deepEqual(mac.launchctl(), ['print gui/501/local.thedesk.server', 'print-disabled gui/501', `bootstrap gui/501 ${mac.cfg.plistPath}`, 'print gui/501/local.thedesk.server']);
    assert.match(mac.text(), /OK: The Desk is running at http:\/\/localhost:4321 \(process 4242\)\. It starts by itself when you log in/);
    assert.match(mac.text(), new RegExp(`Installed ${mac.cfg.plistPath}, running The Desk from ${mac.cfg.runDir}`));
    assert.equal(protectedFolder(mac.cfg.runDir, mac.home), null);
    assert.doesNotMatch(mac.text(), /inside Documents|click Allow/, 'the live copy is outside Documents: macOS has nothing to ask');
  });

  test('if the live copy is ever put inside Documents, it says macOS may ask', async () => {
    const mac = fakeMac({ inDocuments: true });
    assert.equal(await mac.run('install'), 0, mac.errors());
    assert.match(mac.text(), /inside Documents\. If macOS asks whether "node" may access it, click Allow/);
  });

  test('refuses, changing nothing, when something else has port 4321', async () => {
    const mac = fakeMac({ portHolder: 777, deskUp: true });
    assert.equal(await mac.run('install'), 1);
    assert.match(mac.errors(), /Port 4321 is already in use by something other than The Desk service \(process 777, a copy of The Desk\), so nothing was changed\./);
    assert.match(mac.errors(), /npm run dev or npm start\)\? Stop it there with Ctrl\+C/);
    assert.deepEqual(mac.launchctl(), ['print gui/501/local.thedesk.server']);
    assert.equal(fs.existsSync(mac.cfg.plistPath), false);
    assert.equal(fs.existsSync(mac.cfg.logDir), false);
  });

  test('says plainly when the port holder is not The Desk', async () => {
    const mac = fakeMac({ portHolder: 555 });
    assert.equal(await mac.run('install'), 1);
    assert.match(mac.errors(), /\(process 555\), so nothing was changed\.\nStop that program, or free port 4321/);
  });

  test('reinstalling replaces the loaded service (the port is its own)', async () => {
    const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    assert.equal(await mac.run('install'), 0, mac.errors());
    const calls = mac.launchctl();
    assert.ok(calls.indexOf('bootout gui/501/local.thedesk.server') < calls.indexOf(`bootstrap gui/501 ${mac.cfg.plistPath}`));
    assert.match(mac.text(), /Replacing the service that was already installed/);
    assert.equal(mac.state.pid, 4242);
  });

  test('refuses when the service is loaded but someone else holds the port', async () => {
    const mac = fakeMac({ loaded: true, pid: null, portHolder: 999, deskUp: true });
    assert.equal(await mac.run('install'), 1);
    assert.match(mac.errors(), /process 999/);
    assert.ok(!mac.launchctl().some((c) => c.startsWith('bootout') || c.startsWith('bootstrap')));
  });

  test('switches the service back on first if it was disabled', async () => {
    const mac = fakeMac({ disabled: true });
    assert.equal(await mac.run('install'), 0, mac.errors());
    const calls = mac.launchctl();
    assert.ok(calls.indexOf('enable gui/501/local.thedesk.server') >= 0);
    assert.ok(calls.indexOf('enable gui/501/local.thedesk.server') < calls.indexOf(`bootstrap gui/501 ${mac.cfg.plistPath}`));
  });

  test('when macOS privacy blocks node, says how to allow it, without waiting the full 15 s', async () => {
    const mac = fakeMac({
      inDocuments: true,
      onStart: (s, { appendLog }) => {
        appendLog(`node:internal/modules/run_main:123\nError: EPERM: operation not permitted, open '${mac.cfg.serverPath}'\n`);
        s.lastExit = '1';
      },
    });
    assert.equal(await mac.run('install'), 1);
    const errors = mac.errors();
    assert.match(errors, /The Desk couldn't start, so http:\/\/localhost:4321 doesn't answer\./);
    assert.match(errors, /macOS is stopping node from reading The Desk's folder: it's inside Documents/);
    assert.match(errors, /click Allow/);
    assert.match(errors, /System Settings > Privacy & Security > Full Disk Access/);
    assert.match(errors, /type \/opt\/homebrew\/bin\/node/);
    assert.match(errors, /EPERM: operation not permitted, open/);
    assert.ok(mac.state.clock < 15_000, `stopped early (${mac.state.clock} ms)`);
  });

  test('when it never answers, prints the last 20 new log lines and a hint after 15 s', async () => {
    const mac = fakeMac({
      inDocuments: true,
      onStart: (s, { appendLog }) => {
        appendLog(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
        s.lastExit = '1';
      },
    });
    mac.appendLog('an old EPERM from yesterday\n');
    assert.equal(await mac.run('install'), 1);
    const errors = mac.errors();
    assert.ok(mac.state.clock >= 15_000);
    assert.match(errors, /didn't answer at http:\/\/localhost:4321 within 15 seconds/);
    assert.match(errors, /launchd says: spawn scheduled, last exit: 1\./);
    assert.match(errors, /Last lines of .*the-desk\.log:\n {2}line 11\n/);
    assert.match(errors, /line 30/);
    assert.doesNotMatch(errors, /line 10\n/);
    assert.doesNotMatch(errors, /old EPERM|Full Disk Access/, 'only lines from this start count');
    assert.match(errors, /If macOS asked whether "node" may access your Documents folder, click Allow/);
    assert.match(errors, /npm run service:status/);
  });

  test('stops when plutil rejects the plist', async () => {
    const mac = fakeMac({ lint: 1 });
    assert.equal(await mac.run('install'), 1);
    assert.match(mac.errors(), /didn't pass plutil -lint/);
    assert.ok(!mac.launchctl().some((c) => c.startsWith('bootstrap')));
  });

  test('reports a launchctl bootstrap failure with a hint', async () => {
    const mac = fakeMac({ bootstrapCode: 5 });
    assert.equal(await mac.run('install'), 1);
    assert.equal(mac.launchctl().filter((c) => c.startsWith('bootstrap')).length, 2, 'tried twice');
    assert.match(mac.errors(), /couldn't load the service: Bootstrap failed: 5: Input\/output error/);
    assert.match(mac.errors(), /Login Items/);
  });

  test('only on macOS', async () => {
    const mac = fakeMac({ platform: 'linux' });
    assert.equal(await mac.run('install'), 1);
    assert.match(mac.errors(), /only works on macOS/);
    assert.deepEqual(mac.calls, []);
  });
});

describe('service:start, stop, restart, uninstall', () => {
  const installed = (opts) => {
    const mac = fakeMac(opts);
    fs.mkdirSync(path.dirname(mac.cfg.plistPath), { recursive: true });
    fs.writeFileSync(mac.cfg.plistPath, buildPlist(mac.cfg));
    return mac;
  };

  test('stop boots it out and leaves the plist, so it comes back at the next login', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    assert.equal(await mac.run('stop'), 0);
    assert.ok(mac.launchctl().includes('bootout gui/501/local.thedesk.server'));
    assert.equal(mac.state.loaded, false);
    assert.ok(fs.existsSync(mac.cfg.plistPath));
    assert.match(mac.text(), /Stopped\. The Desk stays off until you run npm run service:start, or until you next log in\./);
  });

  test('stop when it is not running', async () => {
    const mac = installed();
    assert.equal(await mac.run('stop'), 0);
    assert.match(mac.text(), /isn't running/);
    assert.ok(!mac.launchctl().some((c) => c.startsWith('bootout')));
  });

  test('start bootstraps the plist and waits for The Desk', async () => {
    const mac = installed();
    assert.equal(await mac.run('start'), 0, mac.errors());
    assert.ok(mac.launchctl().includes(`bootstrap gui/501 ${mac.cfg.plistPath}`));
    assert.match(mac.text(), /OK: The Desk is running at http:\/\/localhost:4321/);
  });

  test('start when it is already on, or not installed', async () => {
    const on = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    assert.equal(await on.run('start'), 0);
    assert.match(on.text(), /already on \(process 4100\)/);
    assert.ok(!on.launchctl().some((c) => c.startsWith('bootstrap')));

    const none = fakeMac();
    assert.equal(await none.run('start'), 1);
    assert.match(none.errors(), /isn't installed yet\. Install it with: npm run service:install/);
    assert.deepEqual(none.calls, []);
  });

  test('start refuses when something else has the port', async () => {
    const mac = installed({ portHolder: 321, deskUp: true });
    assert.equal(await mac.run('start'), 1);
    assert.match(mac.errors(), /Port 4321 is already in use by something other than The Desk service \(process 321/);
    assert.ok(!mac.launchctl().some((c) => c.startsWith('bootstrap')));
  });

  test('restart kickstarts it with -k and waits for The Desk', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    assert.equal(await mac.run('restart'), 0, mac.errors());
    assert.ok(mac.launchctl().includes('kickstart -k gui/501/local.thedesk.server'));
    assert.equal(mac.state.pid, 4242);
    assert.match(mac.text(), new RegExp(`Restarted with the code in ${mac.cfg.runDir}\\.`));
  });

  test('restart starts it when it was stopped', async () => {
    const mac = installed();
    assert.equal(await mac.run('restart'), 0, mac.errors());
    assert.match(mac.text(), /wasn't running, so starting it/);
    assert.ok(mac.launchctl().includes(`bootstrap gui/501 ${mac.cfg.plistPath}`));
  });

  test('uninstall boots it out and removes the plist, leaving data and logs alone', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    mac.appendLog('keep me\n');
    const state = path.join(mac.cfg.deskHome, 'desks', 'product-feed', 'state.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, '{}');
    assert.equal(await mac.run('uninstall'), 0);
    assert.ok(mac.launchctl().includes('bootout gui/501/local.thedesk.server'));
    assert.equal(fs.existsSync(mac.cfg.plistPath), false);
    assert.equal(fs.readFileSync(mac.cfg.logPath, 'utf8'), 'keep me\n');
    assert.equal(fs.readFileSync(state, 'utf8'), '{}');
    assert.match(mac.text(), /Removed\. The Desk won't start by itself any more\./);
  });

  test('uninstall when nothing is installed', async () => {
    const mac = fakeMac();
    assert.equal(await mac.run('uninstall'), 0);
    assert.match(mac.text(), /nothing to remove/);
  });
});

describe('service:status', () => {
  const installed = (opts) => {
    const mac = fakeMac(opts);
    fs.mkdirSync(path.dirname(mac.cfg.plistPath), { recursive: true });
    fs.writeFileSync(mac.cfg.plistPath, buildPlist(mac.cfg));
    return mac;
  };

  test('running and answering, from the live copy, on the deployed commit', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    fs.writeFileSync(deployedPath(mac.cfg.runDir), JSON.stringify(deployedRecord({ sha: SHA, subject: 'N1: live copy', deployedAt: '2026-11-28T09:14:03-05:00' })));
    mac.appendLog('hello\n');
    assert.equal(await mac.run('status'), 0);
    const text = mac.text();
    assert.match(text, /Installed: {2}yes/);
    assert.ok(text.includes(`\n  Runs from:  ${mac.cfg.runDir}\n  Deployed:   main @ c0ffee0 "N1: live copy", deployed 2026-11-28T09:14:03-05:00\n`));
    assert.match(text, /Loaded: {5}yes, launchd keeps it running/);
    assert.match(text, /Running: {4}yes, process 4100/);
    assert.match(text, /Last exit: {2}\(never exited\)/);
    assert.match(text, /Answers: {4}yes, http:\/\/localhost:4321 \(served by the service; edition: sample\)/);
    assert.match(text, /Log: {8}.*the-desk\.log \(1 KB\)/);
    assert.doesNotMatch(text, /differs|still runs from/);
  });

  test('a live copy with no deploy recorded says so', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    fs.rmSync(deployedPath(mac.cfg.runDir));
    await mac.run('status');
    assert.match(mac.text(), /Deployed: {3}not recorded \(this folder isn't a live copy made by npm run deploy\)/);
  });

  test('a service still running from the work folder: says to move it with service:install', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    const work = path.join(mac.home, 'Documents', 'Projects', 'the-desk');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(mac.cfg.plistPath, buildPlist({ ...mac.cfg, runDir: work, serverPath: path.join(work, 'server', 'index.js') }));
    await mac.run('status');
    const text = mac.text();
    assert.ok(text.includes(`\n  Runs from:  ${work}\n  Deployed:   not recorded`));
    assert.ok(text.includes(`The service still runs from ${work}, not from the live copy ${mac.cfg.runDir}.\nRun npm run service:install once to move it to the live copy.`));
    assert.doesNotMatch(text, /differs/);
  });

  test('a service still running from the work folder, and no live copy yet: deploy first', async () => {
    const mac = installed({ liveCopy: false });
    const work = path.join(mac.home, 'Documents', 'Projects', 'the-desk');
    fs.writeFileSync(mac.cfg.plistPath, buildPlist({ ...mac.cfg, runDir: work, serverPath: path.join(work, 'server', 'index.js') }));
    await mac.run('status');
    assert.match(mac.text(), new RegExp(`Deployed: {3}nothing: ${work} doesn't exist`));
    assert.match(mac.text(), /Run npm run deploy to make the live copy, then npm run service:install once to move the service to it\./);
  });

  test('stopped, with someone else answering on the port', async () => {
    const mac = installed({ portHolder: 5150, deskUp: true });
    assert.equal(await mac.run('status'), 0);
    const text = mac.text();
    assert.match(text, /Loaded: {5}no \(stopped: npm run service:start, or it starts at your next login\)\n {2}Running: {4}no\n/);
    assert.match(text, /served by process 5150, not the service \(npm run dev or npm start in a Terminal\?\)/);
    assert.match(text, /Log: {8}.*\(not created yet\)/);
  });

  test('not installed', async () => {
    const mac = fakeMac();
    assert.equal(await mac.run('status'), 0);
    assert.match(mac.text(), /Installed: {2}no \(npm run service:install\)\n {2}Live copy: {2}.*the-desk-live\n {2}Deployed: {3}main @ c0ffee0 "N1: live copy".*\n {2}Loaded: {5}no\n {2}Running: {4}no\n/);
    assert.match(mac.text(), /Answers: {4}no/);
  });

  test('notices a plist that is out of date', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    fs.writeFileSync(mac.cfg.plistPath, buildPlist({ ...mac.cfg, nodePath: '/old/node' }));
    await mac.run('status');
    assert.match(mac.text(), /differs from what service:install would write now[\s\S]*npm run service:install/);
  });

  test('loaded but failing: shows the log, and the privacy steps when that is the cause', async () => {
    const mac = installed({ loaded: true, pid: null, inDocuments: true });
    mac.state.lastExit = '1';
    mac.appendLog("Error: EPERM: operation not permitted, uv_cwd\n");
    await mac.run('status');
    const text = mac.text();
    assert.match(text, /Running: {4}no \(spawn scheduled; launchd retries every 10 s\)/);
    assert.match(text, /Last exit: {2}1/);
    assert.match(text, /Full Disk Access/);
    assert.match(text, /Last lines of .*\n {2}Error: EPERM/);
  });
});

describe('runCommand (the real runner deploy and the service use)', () => {
  test('runs the command in the folder it is given (npm ci must never run in the work folder)', async () => {
    const dir = tempDir('the-desk-cwd-');
    const r = await runCommand(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), fs.realpathSync(dir));
    const here = await runCommand(process.execPath, ['-e', 'console.log(process.cwd())']);
    assert.equal(here.stdout.trim(), process.cwd(), 'without cwd: this process\'s folder');
  });

  test('stops a command that runs past timeoutMs, and says so', async () => {
    const started = Date.now();
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 300 });
    assert.ok(Date.now() - started < 10_000, `stopped early (${Date.now() - started} ms)`);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /stopped after 300 ms: it took too long/);
  });

  test('the time limit is hard: a command that ignores SIGTERM gets SIGKILL after the grace period', async () => {
    const script = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
    const started = Date.now();
    const r = await runCommand(process.execPath, ['-e', script], { timeoutMs: 800, graceMs: 300 });
    const took = Date.now() - started;
    assert.ok(took >= 1000 && took < 10_000, `waited for the grace period, then stopped (${took} ms)`);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /stopped after 800 ms: it took too long/);
    const pid = Number(r.stdout.trim());
    assert.ok(pid > 0, r.stdout);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the child is gone');
  });

  test('a command that exits while something it started keeps running is done, with its real exit code', async () => {
    const pidFile = path.join(tempDir(), 'bg.pid');
    const started = Date.now();
    const r = await runCommand('/bin/sh', ['-c', `echo hi; sleep 6 & echo $! > '${pidFile}'; exit 0`], { timeoutMs: 1000, graceMs: 500 });
    try {
      assert.ok(Date.now() - started < 2500, `didn't wait for the background sleep (${Date.now() - started} ms)`);
      assert.deepEqual(r, { code: 0, stdout: 'hi\n', stderr: '' });
      assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the sleep still holding its output was stopped when the drain ended');
    } finally {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  /** Waits up to 3 s for a process to be gone. */
  async function gone(pid) {
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  test("the hard stop reaches the command's own children too (its whole process group)", async () => {
    const pidFile = path.join(tempDir(), 'child.pid');
    // sh and its sleep both ignore SIGTERM (an ignored signal is inherited), so only SIGKILL to the group stops them.
    const r = await runCommand('/bin/sh', ['-c', `trap '' TERM; sleep 30 & echo $! > '${pidFile}'; wait`], { timeoutMs: 500, graceMs: 300 });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /stopped after 500 ms: it took too long/);
    assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'the orphan sleep was stopped as well');
  });

  test('when this process is stopped (Ctrl+C), the command it is running is stopped too', async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, 'sleep.pid');
    const wrapper = path.join(dir, 'wrapper.mjs');
    const serviceUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'service.js')).href;
    fs.writeFileSync(wrapper, `import { runCommand } from ${JSON.stringify(serviceUrl)};\nawait runCommand('/bin/sh', ['-c', ${JSON.stringify(`echo $$ > '${pidFile}'; exec sleep 30`)}], { timeoutMs: 60000 });\n`);
    const child = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));
      child.kill('SIGINT');
      assert.equal(await ended, 'SIGINT', 'the wrapper still stops the way Ctrl+C stops it');
      assert.ok(await gone(pid), 'and its sleep, in its own process group, was stopped with it');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  /** Runs a node script that calls runCommand on cmd/args, waits for readyFile, then sends it sig. */
  async function stopWrapper({ args, readyFile, sig, extra = '', after = '' }) {
    const dir = path.dirname(readyFile);
    const wrapper = path.join(dir, `wrapper-${Math.random().toString(36).slice(2)}.mjs`);
    const serviceUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'service.js')).href;
    fs.writeFileSync(wrapper, `import { runCommand } from ${JSON.stringify(serviceUrl)};\n${extra}\nawait runCommand(${JSON.stringify(args[0])}, ${JSON.stringify(args.slice(1))}, { timeoutMs: 60000 });\n${after}\n`);
    const child = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 80 && !fs.existsSync(readyFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(fs.existsSync(readyFile), 'the command started');
      const started = Date.now();
      const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ how: signal || code, took: Date.now() - started })));
      child.kill(sig);
      return await ended;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }

  test('the signal that arrived is the one passed on: SIGINT stays SIGINT, SIGHUP stays SIGHUP', async () => {
    for (const sig of ['SIGINT', 'SIGHUP', 'SIGQUIT']) {
      const dir = tempDir();
      const got = path.join(dir, 'got');
      const ready = path.join(dir, 'ready');
      const script = `for (const s of ['SIGINT','SIGTERM','SIGHUP','SIGQUIT']) process.on(s, () => { require('fs').writeFileSync(${JSON.stringify(got)}, s); process.exit(0); }); require('fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000);`;
      const { how } = await stopWrapper({ args: [process.execPath, '-e', script], readyFile: ready, sig });
      assert.equal(how, sig, `the wrapper stops the way ${sig} stops it`);
      assert.equal(fs.readFileSync(got, 'utf8'), sig, `the command got ${sig}`);
    }
  });

  test('a command that ignores the signal is SIGKILLed after about 2 s, before this process stops', async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, 'sleep.pid');
    const { how, took } = await stopWrapper({ args: ['/bin/sh', '-c', `trap '' INT; echo $$ > '${pidFile}'; exec sleep 30`], readyFile: pidFile, sig: 'SIGINT' });
    assert.equal(how, 'SIGINT');
    assert.ok(took >= 1500 && took < 8000, `waited for it, then stopped (${took} ms)`);
    assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'no orphan left');
  });

  test("after a signal the caller can't carry on: a command that finishes during the wait never settles", async () => {
    // Two commands: the first exits on SIGINT at once, the second ignores it for the whole 2 s wait.
    // The caller waits on the first only; if that settled, it would carry on (and could put the
    // handler back, swallowing the re-raise) while the second is still being waited for.
    const dir = tempDir();
    const ready = path.join(dir, 'ready');
    const pidFile = path.join(dir, 'sleep.pid');
    const marker = path.join(dir, 'carried-on');
    const wrapper = path.join(dir, 'wrapper.mjs');
    const serviceUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'service.js')).href;
    const quick = `process.on('SIGINT', () => process.exit(0)); require('fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000);`;
    fs.writeFileSync(
      wrapper,
      [
        "import fs from 'node:fs';",
        `import { runCommand } from ${JSON.stringify(serviceUrl)};`,
        `const quick = runCommand(process.execPath, ['-e', ${JSON.stringify(quick)}], { timeoutMs: 60000 });`,
        `runCommand('/bin/sh', ['-c', ${JSON.stringify(`trap '' INT; echo $$ > '${pidFile}'; exec sleep 30`)}], { timeoutMs: 60000 });`,
        'await quick;',
        `fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
        "await runCommand('/bin/sleep', ['30'], { timeoutMs: 60000 });",
      ].join('\n'),
    );
    const child = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 80 && !(fs.existsSync(ready) && fs.existsSync(pidFile)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));
      child.kill('SIGINT');
      assert.equal(await ended, 'SIGINT', 'the re-raised SIGINT stopped it');
      assert.equal(fs.existsSync(marker), false, 'the code after the first runCommand never ran');
      assert.ok(await gone(pid), 'the command that ignored SIGINT was SIGKILLed');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('a second signal while it waits stops the commands and this process at once', async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, 'sleep.pid');
    const wrapper = path.join(dir, 'wrapper.mjs');
    const serviceUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'service.js')).href;
    fs.writeFileSync(wrapper, `import { runCommand } from ${JSON.stringify(serviceUrl)};\nawait runCommand('/bin/sh', ['-c', ${JSON.stringify(`trap '' INT; echo $$ > '${pidFile}'; exec sleep 30`)}], { timeoutMs: 60000 });\n`);
    const child = spawn(process.execPath, [wrapper], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 80 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const started = Date.now();
      const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));
      child.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 300));
      child.kill('SIGINT');
      assert.equal(await ended, 'SIGINT');
      assert.ok(Date.now() - started < 1500, `didn't wait the full 2 s (${Date.now() - started} ms)`);
      assert.ok(await gone(pid), 'the command that ignored SIGINT was SIGKILLed');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test('one shared signal handler, however many commands run at once (no MaxListenersExceededWarning)', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
    const counts = () => Object.fromEntries(signals.map((sig) => [sig, process.listenerCount(sig)]));
    const start = counts();
    const before = start.SIGINT;
    const warnings = [];
    const onWarning = (w) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const runs = Array.from({ length: 15 }, () => runCommand('/bin/sleep', ['0.3']));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(runningGroups(), 15);
      assert.deepEqual(counts(), Object.fromEntries(signals.map((sig) => [sig, start[sig] + 1])), 'one listener per signal, not fifteen');
      const results = await Promise.all(runs);
      assert.ok(results.every((r) => r.code === 0));
      assert.equal(runningGroups(), 0);
      assert.deepEqual(counts(), start, 'and they go once nothing runs');
      assert.equal(process.listenerCount('SIGINT'), before);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(warnings.filter((n) => n === 'MaxListenersExceededWarning'), []);
    } finally {
      process.off('warning', onWarning);
    }
  });

  test('a very long output keeps its start and its end (npm puts its error lines last)', async () => {
    const script = "process.stderr.write('START' + 'x'.repeat(3_000_000) + 'END'); process.exitCode = 1;";
    const r = await runCommand(process.execPath, ['-e', script], { timeoutMs: 10_000 });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.startsWith('START'));
    assert.ok(r.stderr.endsWith('END'));
    assert.match(r.stderr, /… \(\d+ characters left out\) …/);
    assert.ok(r.stderr.length < 2.2 * 1024 * 1024, `${r.stderr.length} characters`);
  });

  test('outputKeeper keeps everything when it fits, else the head and the tail', () => {
    const small = outputKeeper(5, 5);
    small.add('abc');
    small.add('def');
    assert.equal(small.text(), 'abcdef');
    const big = outputKeeper(3, 3);
    for (const chunk of ['abc', 'defgh', 'ijklmnop', 'xyz']) big.add(chunk);
    assert.equal(big.text(), 'abc\n… (13 characters left out) …\nxyz');
  });

  test('passes env when given one, and never rejects', async () => {
    const r = await runCommand(process.execPath, ['-e', 'console.log(process.env.DESK_RUNNER_CHECK)'], { env: { DESK_RUNNER_CHECK: 'yes' } });
    assert.equal(r.stdout.trim(), 'yes');
    const missing = await runCommand(path.join(tempDir(), 'no-such-program'), []);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /ENOENT/);
  });
});

describe('the real launchd service is shared: fake HOMEs never change it', () => {
  // Every test here uses a fake runner. The real launchctl never runs in the tests.
  const REAL = '/Users/snow';
  const ENTRY = CLI_SCRIPTS[0]; // scripts/service.js: the program npm run service:* runs
  const cfgAt = (home, runDir = path.join(home, 'the-desk-live')) => ({ home, runDir });

  test('launchdRefusal: fine with the real home and a live copy inside it', () => {
    assert.equal(launchdRefusal({ entry: ENTRY, env: {}, cfg: cfgAt(REAL), homedir: REAL, realHome: REAL }), null);
    assert.equal(launchdRefusal({ entry: ENTRY, env: { DESK_LIVE_DIR: '/Users/snow/elsewhere/live' }, cfg: cfgAt(REAL, '/Users/snow/elsewhere/live'), homedir: REAL, realHome: REAL }), null);
  });

  test('launchdRefusal: refuses a fake HOME, a config for another home, or a live copy outside the real home', () => {
    const tail = "so I won't touch the real launchd service (its name is shared). Use --dry-run or the test hooks.";
    assert.equal(launchdRefusal({ entry: ENTRY, env: {}, homedir: '/tmp/fake', realHome: REAL }), `HOME (/tmp/fake) is not your real home folder (/Users/snow), ${tail}`);
    assert.equal(launchdRefusal({ entry: ENTRY, env: {}, cfg: cfgAt('/tmp/fake'), homedir: REAL, realHome: REAL }), `This run's home folder (/tmp/fake) is not your real one (/Users/snow), ${tail}`);
    assert.equal(launchdRefusal({ entry: ENTRY, env: { DESK_LIVE_DIR: '/tmp/live' }, homedir: REAL, realHome: REAL }), `DESK_LIVE_DIR (/tmp/live) is outside your real home folder (/Users/snow), ${tail}`);
    assert.equal(launchdRefusal({ entry: ENTRY, env: {}, cfg: cfgAt(REAL, '/srv/live'), homedir: REAL, realHome: REAL }), `The live copy (/srv/live) is outside your real home folder (/Users/snow), ${tail}`);
    assert.match(launchdRefusal({ entry: ENTRY, env: {}, homedir: REAL, realHome: null }), /^I can't tell your real home folder, so I won't touch/);
    assert.match(launchdRefusal({ entry: ENTRY, env: {}, homedir: '/Users/snowy', realHome: REAL }), /is not your real home folder/, 'a look-alike prefix is not the real home');
  });

  test('guardLaunchctl refuses launchctl verbs that change state, and lets reads and everything else through', async () => {
    const seen = [];
    const inner = async (cmd, args) => {
      seen.push([cmd, ...args].join(' '));
      return { code: 0, stdout: 'ran', stderr: '' };
    };
    const run = guardLaunchctl(inner, () => 'HOME is not your real home folder');
    for (const verb of ['bootstrap', 'bootout', 'kickstart', 'enable', 'disable', 'kill']) {
      assert.deepEqual(await run(LAUNCHCTL, [verb, 'gui/501/local.thedesk.server']), { code: 1, stdout: '', stderr: 'HOME is not your real home folder' }, verb);
      assert.equal((await run('launchctl', [verb, 'x'])).code, 1, `${verb}, by name from PATH`);
    }
    assert.deepEqual(seen, [], 'none of them reached the runner');
    assert.equal((await run(LAUNCHCTL, ['print', 'gui/501/local.thedesk.server'])).stdout, 'ran');
    assert.equal((await run(LAUNCHCTL, ['print-disabled', 'gui/501'])).stdout, 'ran');
    assert.equal((await run(GIT, ['status'])).stdout, 'ran');
    const open = guardLaunchctl(inner, () => null);
    assert.equal((await open(LAUNCHCTL, ['kickstart', '-k', 'gui/501/local.thedesk.server'])).stdout, 'ran', 'no reason: it goes through');
  });

  test('launchdRefusal: a test run (NODE_TEST_CONTEXT) and a missing config are refused too', () => {
    assert.match(launchdRefusal({ entry: ENTRY, env: { NODE_TEST_CONTEXT: 'child-v8' }, cfg: cfgAt(REAL), homedir: REAL, realHome: REAL }), /^This is a test run \(NODE_TEST_CONTEXT is set\), so I won't touch the real launchd service/);
    assert.match(launchdRefusal({ entry: ENTRY, env: {}, homedir: REAL, realHome: REAL, requireCfg: true }), /^No service config was bound to this runner, so I won't touch/);
    assert.equal(launchdRefusal({ entry: ENTRY, env: {}, cfg: cfgAt(REAL), homedir: REAL, realHome: REAL, requireCfg: true }), null);
  });

  test('launchdRefusal: only npm run service:* or npm run deploy may change state (a belt for test runs without NODE_TEST_CONTEXT)', () => {
    const ok = { env: {}, cfg: cfgAt(REAL), homedir: REAL, realHome: REAL };
    assert.equal(launchdRefusal({ ...ok, entry: CLI_SCRIPTS[0] }), null, 'scripts/service.js');
    assert.equal(launchdRefusal({ ...ok, entry: CLI_SCRIPTS[1] }), null, 'scripts/deploy.js');
    const testFile = path.join(REPO_ROOT, 'test', 'service.test.js');
    assert.equal(launchdRefusal({ ...ok, entry: testFile }), `This isn't npm run service:* or npm run deploy (the program is ${testFile}), so I won't touch the real launchd service (its name is shared). Use --dry-run or the test hooks.`);
    assert.match(launchdRefusal({ ...ok, entry: null }), /the program is unknown/);
  });

  test('isCliEntry: the two scripts, also through a symlink; nothing else', () => {
    assert.ok(isCliEntry(path.join(REPO_ROOT, 'scripts', 'service.js')));
    assert.ok(isCliEntry(path.join(REPO_ROOT, 'scripts', 'deploy.js')));
    const link = path.join(tempDir(), 'deploy-link.js');
    fs.symlinkSync(path.join(REPO_ROOT, 'scripts', 'deploy.js'), link);
    assert.ok(isCliEntry(link));
    assert.equal(isCliEntry(path.join(REPO_ROOT, 'scripts', 'validate-feed.js')), false);
    assert.equal(isCliEntry(process.argv[1]), false, 'this test file');
    assert.equal(isCliEntry(path.join(tempDir(), 'missing.js')), false);
    assert.equal(isCliEntry(undefined), false);
  });

  test('guardLaunchctl lets only reading verbs through when there is a reason; launchctl is matched in any case', async () => {
    const seen = [];
    const inner = async (cmd, args) => {
      seen.push(args[0]);
      return { code: 0, stdout: 'ran', stderr: '' };
    };
    const run = guardLaunchctl(inner, () => 'no', { realHome: REAL });
    for (const verb of ['asuser', 'bsexec', 'submit', 'setenv', 'start', 'stop', 'remove', 'reboot', 'config', '']) {
      assert.equal((await run(LAUNCHCTL, verb ? [verb, 'x'] : [])).code, 1, `"${verb}" refused`);
    }
    assert.equal((await run('/bin/LAUNCHCTL', ['kickstart', 'x'])).code, 1, 'upper case');
    assert.equal((await run('LaunchCtl', ['bootout', 'x'])).code, 1, 'mixed case');
    assert.deepEqual(seen, []);
    for (const verb of ['print', 'print-disabled', 'list', 'blame', 'version', 'help']) {
      assert.equal((await run(LAUNCHCTL, [verb, 'gui/501/local.thedesk.server'])).stdout, 'ran', verb);
    }
  });

  test('guardLaunchctl: a bootstrap must load the real ~/Library/LaunchAgents plist, whatever else says yes', async () => {
    const inner = async () => ({ code: 0, stdout: 'ran', stderr: '' });
    const run = guardLaunchctl(inner, () => null, { realHome: REAL });
    const refused = await run(LAUNCHCTL, ['bootstrap', 'gui/501', '/tmp/fake-home/Library/LaunchAgents/local.thedesk.server.plist']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^launchctl bootstrap may only load \/Users\/snow\/Library\/LaunchAgents\/local\.thedesk\.server\.plist, not \/tmp\/fake-home/);
    assert.equal((await run(LAUNCHCTL, ['bootstrap', 'gui/501'])).code, 1, 'no plist at all');
    assert.equal((await run(LAUNCHCTL, ['bootstrap', 'gui/501', servicePlistPath(REAL)])).stdout, 'ran');
    assert.equal((await run(LAUNCHCTL, ['kickstart', '-k', 'gui/501/local.thedesk.server'])).stdout, 'ran');
  });

  // These call the real runner, but always with a launchctl path that doesn't exist: if a guard ever
  // failed, the worst that could happen is ENOENT. The real launchctl is never reached.
  const missingLaunchctl = () => path.join(tempDir(), 'no-such-dir', 'launchctl');
  const realCfg = () => serviceConfig({ home: os.userInfo().homedir, uid: 501, env: {}, nodePath: HOMEBREW_NODE });
  async function withoutTestContext(fn) {
    const saved = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      return await fn();
    } finally {
      if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
    }
  }

  test('the real runner refuses any state change during a test run, even with the real HOME and config', async () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets it');
    const r = await realDeps(realCfg()).run(missingLaunchctl(), ['kickstart', '-k', 'gui/501/local.thedesk.server']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^This is a test run \(NODE_TEST_CONTEXT is set\)/);
    assert.match(realDeps(realCfg()).launchdRefusal(), /^This is a test run/);
  });

  test('even without NODE_TEST_CONTEXT, the real runner refuses state changes from anything but the two scripts', async () => {
    await withoutTestContext(async () => {
      const r = await realDeps(realCfg()).run(missingLaunchctl(), ['kickstart', '-k', 'gui/501/local.thedesk.server']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^This isn't npm run service:\* or npm run deploy \(the program is .*\)/);
      assert.doesNotMatch(r.stderr, /ENOENT/);
    });
  });

  // The only test that needs the real HOME: with every check passing (the entry stands in for
  // scripts/service.js), the guard lets a kickstart through, to a launchctl that isn't there.
  const realHomeHere = path.resolve(os.homedir()) === path.resolve(os.userInfo().homedir);
  test('with every check passing, the guard lets state changes through; a config for another home or none is refused', { skip: !realHomeHere && 'HOME is not the real home folder here' }, async () => {
    const guarded = (cfg) =>
      guardLaunchctl(runCommand, () => launchdRefusal({ cfg, requireCfg: true, env: {}, entry: CLI_SCRIPTS[0] }));
    const kick = (run) => run(missingLaunchctl(), ['kickstart', '-k', 'gui/501/local.thedesk.server']);
    assert.match((await kick(guarded(realCfg()))).stderr, /ENOENT/, 'reached the runner');
    assert.match((await kick(guarded(null))).stderr, /^No service config was bound to this runner/);
    const temp = serviceConfig({ home: tempDir(), uid: 501, env: {}, nodePath: HOMEBREW_NODE });
    assert.match((await kick(guarded(temp))).stderr, /^This run's home folder \(.*\) is not your real one/);
    const bootstrap = await guarded(realCfg())(missingLaunchctl(), ['bootstrap', 'gui/501', path.join(tempDir(), 'x.plist')]);
    assert.match(bootstrap.stderr, /^launchctl bootstrap may only load/);
  });

  test('install, start, stop, restart and uninstall stop before anything when the deps say so; status and dry runs go on', async () => {
    for (const command of ['install', 'uninstall', 'start', 'stop', 'restart']) {
      const mac = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
      mac.deps.launchdRefusal = () => "HOME (/tmp/fake) is not your real home folder (/Users/snow), so I won't touch the real launchd service (its name is shared). Use --dry-run or the test hooks.";
      assert.equal(await mac.run(command), 1, command);
      assert.match(mac.errors(), /^HOME \(\/tmp\/fake\) is not your real home folder/);
      assert.deepEqual(mac.calls, [], `${command}: nothing ran`);
      assert.equal(mac.state.pid, 4100);
    }
    const status = fakeMac({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    status.deps.launchdRefusal = () => 'no';
    assert.equal(await status.run('status'), 0);
    assert.match(status.text(), /Running: {4}yes, process 4100/);
    const dry = fakeMac();
    dry.deps.launchdRefusal = () => 'no';
    assert.equal(await dry.run('install', '--dry-run'), 0);
    assert.match(dry.text(), /^Dry run/);
  });
});

describe('scripts/service.js as a command', () => {
  test('package.json wires every npm run service:* script', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    for (const command of ['install', 'uninstall', 'start', 'stop', 'restart', 'status']) {
      assert.equal(scripts[`service:${command}`], `node scripts/service.js ${command}`);
    }
  });

  // Only commands that can't reach launchctl run as a real process here.
  test('--help prints the usage; an unknown command exits 2 with it', () => {
    const script = path.join(REPO_ROOT, 'scripts', 'service.js');
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /service:install/);
    const bad = spawnSync(process.execPath, [script, 'launch'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown command "launch"[\s\S]*Usage/);
  });
});
