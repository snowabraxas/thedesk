// The always-on service (scripts/service.js). launchctl is never called: every command goes through
// a fake that keeps launchd's state in memory. Files go to a temp home folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { REPO_ROOT } from '../server/config.js';
import {
  HOMEBREW_NODE,
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
  protectedFolder,
  readLogSince,
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

/**
 * A fake Mac: launchd's state for our label, who holds the port, whether The Desk answers, a clock.
 * onStart(state, world) runs when launchd would start the server (bootstrap or kickstart).
 */
function fakeMac({ loaded = false, pid = null, portHolder = null, deskUp = false, disabled = false, platform = 'darwin', lint = 0, bootstrapCode = 0, onStart } = {}) {
  const home = tempDir();
  const repoRoot = path.join(home, 'Documents', 'Projects', 'the-desk');
  const cfg = serviceConfig({ home, uid: 501, repoRoot, nodePath: HOMEBREW_NODE });
  const state = { loaded, pid, portHolder, deskUp, disabled, runs: loaded ? 1 : 0, lastExit: '(never exited)', clock: 0, nextPid: 4242 };
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
    async run(cmd, args) {
      calls.push([cmd, ...args].join(' '));
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

  test('derives every path from the home folder, the user id and the repo', () => {
    const cfg = serviceConfig({ home: '/Users/snow', uid: 501, repoRoot: '/Users/snow/Documents/Projects/the-desk', nodePath: '/opt/homebrew/bin/node' });
    assert.equal(cfg.label, 'local.thedesk.server');
    assert.equal(cfg.domain, 'gui/501');
    assert.equal(cfg.target, 'gui/501/local.thedesk.server');
    assert.equal(cfg.plistPath, '/Users/snow/Library/LaunchAgents/local.thedesk.server.plist');
    assert.equal(cfg.serverPath, '/Users/snow/Documents/Projects/the-desk/server/index.js');
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

  test('the plist runs node on server/index.js from the repo, at login, and again whenever it stops', () => {
    const cfg = serviceConfig({ home: '/Users/snow', uid: 501, repoRoot: '/Users/snow/Documents/Projects/the-desk', nodePath: '/opt/homebrew/bin/node' });
    const plist = buildPlist(cfg);
    assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    assert.match(plist, /<key>Label<\/key>\n\t<string>local\.thedesk\.server<\/string>/);
    assert.match(plist, /<key>ProgramArguments<\/key>\n\t<array>\n\t\t<string>\/opt\/homebrew\/bin\/node<\/string>\n\t\t<string>\/Users\/snow\/Documents\/Projects\/the-desk\/server\/index\.js<\/string>\n\t<\/array>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\n\t<string>\/Users\/snow\/Documents\/Projects\/the-desk<\/string>/);
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
    const cfg = serviceConfig({ home: '/Users/s & o', uid: 501, repoRoot: odd, nodePath: '/opt/node <1> & "2"' });
    const plist = buildPlist(cfg);
    assert.ok(plist.includes(`<string>/Users/s &amp; o/Projects &lt;dev&gt;/&quot;the&quot; desk&apos;s</string>`));
    assert.ok(plist.includes('<string>/opt/node &lt;1&gt; &amp; &quot;2&quot;</string>'));
    assert.ok(plist.includes('<string>/Users/s &amp; o/agent-house/logs/the-desk.log</string>'));
    const text = plist.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '');
    const values = text.replace(/<\/?(plist|dict|key|string|array|true|integer)( version="1\.0")?\/?>/g, '');
    assert.doesNotMatch(values, /[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/, 'no raw <, >, quotes or & left in any value');
  });

  test('plutil reads the escaped values back exactly (macOS only)', { skip: !fs.existsSync(PLUTIL) && 'no plutil here' }, () => {
    const odd = `/tmp/a & b/<c> "d" 'e'/the desk`;
    const cfg = serviceConfig({ home: '/Users/s & o', uid: 501, repoRoot: odd, nodePath: '/opt/homebrew/bin/node' });
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
    assert.equal(await mac.run('install', '--dry-run'), 0);
    assert.deepEqual(mac.calls, [], 'no command was run');
    assert.deepEqual(fs.readdirSync(mac.home), [], 'no file or folder was written');
    const text = mac.text();
    assert.ok(text.startsWith('Dry run: nothing is changed.'));
    assert.ok(text.includes(buildPlist(mac.cfg)), 'the whole plist');
    assert.ok(text.includes(`7. Load and start it: /bin/launchctl bootstrap gui/501 ${mac.cfg.plistPath}`));
    assert.ok(text.includes('/bin/launchctl bootout gui/501/local.thedesk.server'));
    assert.ok(text.includes('/bin/launchctl kickstart -k gui/501/local.thedesk.server'));
    assert.ok(text.includes(`/usr/bin/plutil -lint ${mac.cfg.plistPath}`));
    assert.equal(text, dryRunText(mac.cfg));
  });

  test('a --dry-run that npm swallowed is still a dry run', async () => {
    const mac = fakeMac();
    assert.equal(await main(['install'], { env: { npm_config_dry_run: 'true' }, deps: mac.deps, cfg: mac.cfg }), 0);
    assert.deepEqual(mac.calls, []);
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
    assert.match(mac.text(), /Restarted with the code in this folder/);
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

  test('running and answering', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    mac.appendLog('hello\n');
    assert.equal(await mac.run('status'), 0);
    const text = mac.text();
    assert.match(text, /Installed: {2}yes/);
    assert.match(text, /Loaded: {5}yes, launchd keeps it running/);
    assert.match(text, /Running: {4}yes, process 4100/);
    assert.match(text, /Last exit: {2}\(never exited\)/);
    assert.match(text, /Answers: {4}yes, http:\/\/localhost:4321 \(served by the service; edition: sample\)/);
    assert.match(text, /Log: {8}.*the-desk\.log \(1 KB\)/);
    assert.doesNotMatch(text, /differs/);
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
    assert.match(mac.text(), /Installed: {2}no \(npm run service:install\)\n {2}Loaded: {5}no\n {2}Running: {4}no\n/);
    assert.match(mac.text(), /Answers: {4}no/);
  });

  test('notices a plist that is out of date', async () => {
    const mac = installed({ loaded: true, pid: 4100, portHolder: 4100, deskUp: true });
    fs.writeFileSync(mac.cfg.plistPath, buildPlist({ ...mac.cfg, nodePath: '/old/node' }));
    await mac.run('status');
    assert.match(mac.text(), /differs from what this folder would install now[\s\S]*npm run service:install/);
  });

  test('loaded but failing: shows the log, and the privacy steps when that is the cause', async () => {
    const mac = installed({ loaded: true, pid: null });
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
