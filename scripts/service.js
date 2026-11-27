#!/usr/bin/env node
// npm run service:install | service:uninstall | service:start | service:stop | service:restart | service:status
// npm run service:install -- --dry-run     prints the plist and the launchctl commands, changes nothing
//
// Keeps The Desk always on with a per-user launchd agent, ~/Library/LaunchAgents/local.thedesk.server.plist.
// launchd starts `node server/index.js` from the live copy (~/the-desk-live, a main-only git worktree
// that npm run deploy keeps up to date; never the checkout you work in) when Snow logs in (RunAtLoad)
// and starts it again whenever it stops, crash or clean exit alike (KeepAlive true; ThrottleInterval
// keeps a crash loop to one try every 10 s). Only bootout (service:stop / service:uninstall) keeps it
// stopped. It runs on 127.0.0.1:4321 with DESK_HOME=~/agent-house, and logs to ~/agent-house/logs/the-desk.log.
//
// Uses the modern launchctl verbs: bootstrap gui/<uid> <plist>, bootout gui/<uid>/<label>,
// kickstart -k, print, print-disabled and enable. Every command goes through an injected runner,
// so the tests never call launchctl.
//
// macOS privacy: the live copy sits outside ~/Documents, so macOS has nothing to ask. If DESK_LIVE_DIR
// ever puts it in a protected folder, a node started by launchd may be refused ("Operation not
// permitted") until node is allowed in System Settings; the health check spots that and prints the steps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PORT, HOST, SERVICE_LABEL, resolveLiveDir, servicePlistPath } from '../server/config.js';
import { describeDeployed, readDeployed } from '../server/deployed.js';
import { rotateLog } from '../server/log-file.js';
import { probeDesk } from '../server/probe.js';

export const COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status'];
export const HOMEBREW_NODE = '/opt/homebrew/bin/node';
export const LAUNCHCTL = '/bin/launchctl';
export const PLUTIL = '/usr/bin/plutil';
export const LSOF = '/usr/sbin/lsof';
export const THROTTLE_SECONDS = 10;
export const HEALTH_TIMEOUT_MS = 15_000;
export const SERVICE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const GIT = 'git';
export const KILL_GRACE_MS = 10_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

// Environment variables that tell git which repo, index or object store to use. A git hook,
// `git rebase -x` or `git bisect run` exports them; left in, they would point `git -C <folder>`
// at whatever repo started us instead of the folder named.
export const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/** A copy of env without the variables that would redirect git (GIT_CONFIG_KEY_n / _VALUE_n too). */
export function gitEnv(env = process.env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (GIT_LOCATION_VARS.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete clean[name];
  }
  return clean;
}

const USAGE = `Usage: npm run service:<command>

  service:install     install the always-on service and start it, running the live copy
                      (~/the-desk-live; make it first with npm run deploy)
                      (add "-- --dry-run" to see what it would do, changing nothing)
  service:status      is it running, which commit is live, does http://localhost:${DEFAULT_PORT} answer, where is the log
  service:stop        stop it (it stays off until service:start, or until you next log in)
  service:start       start it again
  service:restart     restart it (npm run deploy does this for you after updating the live copy)
  service:uninstall   stop it and remove it (your data and logs stay in ~/agent-house)`;

// ---------- arguments ----------

/**
 * @param {string[]} argv the words after `node scripts/service.js`
 * @param {Record<string, string|undefined>} [env] npm swallows a --dry-run typed without "--" and
 *   sets npm_config_dry_run=true instead, so that counts as a dry run too
 * @returns {{ command: string, dryRun: boolean } | { command: 'help' } | { error: string }}
 */
export function parseArgs(argv, env = {}) {
  const flags = argv.filter((a) => a.startsWith('-'));
  const words = argv.filter((a) => !a.startsWith('-'));
  if (flags.includes('-h') || flags.includes('--help') || (words.length === 1 && words[0] === 'help')) return { command: 'help' };
  if (words.length === 0) return { error: 'Say which command to run.' };
  if (words.length > 1 || !COMMANDS.includes(words[0])) return { error: `Unknown command ${JSON.stringify(words.join(' '))}.` };
  const unknown = flags.filter((f) => f !== '--dry-run');
  if (unknown.length) return { error: `Unknown option ${JSON.stringify(unknown.join(' '))}.` };
  const command = words[0];
  const dryRun = flags.includes('--dry-run') || env.npm_config_dry_run === 'true';
  if (dryRun && command !== 'install') return { error: `--dry-run only works with install: npm run service:install -- --dry-run` };
  return { command, dryRun };
}

// ---------- configuration ----------

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Homebrew's /opt/homebrew/bin/node is a symlink that follows Node upgrades, so it is used as is
 * (not resolved into the Cellar). Without it, the node running this script.
 */
export function resolveNodePath({ exists = isExecutable, execPath = process.execPath } = {}) {
  return exists(HOMEBREW_NODE) ? HOMEBREW_NODE : execPath;
}

/**
 * Everything about the service, derived from the home folder, the user id and the folder it runs
 * The Desk from: the live copy (runDir, default ~/the-desk-live or DESK_LIVE_DIR), not this checkout.
 */
export function serviceConfig({ home = os.homedir(), uid = process.getuid?.() ?? 0, env = process.env, runDir = resolveLiveDir(env, home), nodePath = resolveNodePath() } = {}) {
  const deskHome = path.join(home, 'agent-house');
  const logDir = path.join(deskHome, 'logs');
  return {
    label: SERVICE_LABEL,
    uid,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${SERVICE_LABEL}`,
    home,
    plistPath: servicePlistPath(home),
    nodePath,
    runDir,
    serverPath: path.join(runDir, 'server', 'index.js'),
    deskHome,
    logDir,
    logPath: path.join(logDir, 'the-desk.log'),
    port: DEFAULT_PORT,
    env: {
      PATH: SERVICE_PATH,
      DESK_HOME: deskHome,
      PORT: String(DEFAULT_PORT),
      DESK_LOG: path.join(logDir, 'the-desk.log'),
      DESK_SERVICE: '1',
    },
  };
}

// ---------- the plist ----------

/** Escapes text for an XML element. Control characters can't be written in XML 1.0 at all. */
export function xmlEscape(value) {
  const text = String(value);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text)) {
    throw new Error(`can't write ${JSON.stringify(text)} into a plist: it has a control character`);
  }
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

const str = (v) => `<string>${xmlEscape(v)}</string>`;
const key = (k) => `<key>${xmlEscape(k)}</key>`;

/** The launchd plist for the service. Pure: same config in, same text out. */
export function buildPlist(cfg) {
  const env = Object.entries(cfg.env).map(([k, v]) => `\t\t${key(k)}\n\t\t${str(v)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t${key('Label')}
\t${str(cfg.label)}
\t${key('ProgramArguments')}
\t<array>
\t\t${str(cfg.nodePath)}
\t\t${str(cfg.serverPath)}
\t</array>
\t${key('WorkingDirectory')}
\t${str(cfg.runDir)}
\t${key('EnvironmentVariables')}
\t<dict>
${env}
\t</dict>
\t${key('RunAtLoad')}
\t<true/>
\t${key('KeepAlive')}
\t<true/>
\t${key('ThrottleInterval')}
\t<integer>${THROTTLE_SECONDS}</integer>
\t${key('StandardOutPath')}
\t${str(cfg.logPath)}
\t${key('StandardErrorPath')}
\t${str(cfg.logPath)}
</dict>
</plist>
`;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlUnescape = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e],
  );

/** The WorkingDirectory an installed plist runs the server in, or null when it names none. */
export function plistWorkingDirectory(text) {
  const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(String(text));
  return m ? xmlUnescape(m[1]) : null;
}

/** Reads the installed plist: { installed, text, runDir } (runDir: its WorkingDirectory, or null). */
export function readInstalledPlist(cfg, deps) {
  let text;
  try {
    text = deps.fs.readFileSync(cfg.plistPath, 'utf8');
  } catch {
    return { installed: deps.fs.existsSync(cfg.plistPath), text: '', runDir: null };
  }
  return { installed: true, text, runDir: plistWorkingDirectory(text) };
}

// ---------- launchctl ----------

export const launchctlArgs = {
  print: (cfg) => ['print', cfg.target],
  printDisabled: (cfg) => ['print-disabled', cfg.domain],
  enable: (cfg) => ['enable', cfg.target],
  bootstrap: (cfg) => ['bootstrap', cfg.domain, cfg.plistPath],
  bootout: (cfg) => ['bootout', cfg.target],
  kickstart: (cfg) => ['kickstart', '-k', cfg.target],
};

/** Quotes a word for a shell, only when it needs it. */
export function shellQuote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_\/.,:=+@%-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
const commandLine = (cmd, args) => [cmd, ...args].map(shellQuote).join(' ');

/**
 * Reads launchctl print output. Only top-level lines (one tab in) count, so nested blocks
 * like "environment" can't be mistaken for the service's own fields.
 */
export function parseLaunchctlPrint(text) {
  const fields = {};
  for (const m of String(text).matchAll(/^\t([a-z][a-z ]*?) = (.*)$/gm)) {
    if (!(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  return {
    state: fields.state ?? null,
    pid: /^\d+$/.test(fields.pid ?? '') ? Number(fields.pid) : null,
    lastExitCode: fields['last exit code'] ?? null,
    lastSignal: fields['last terminating signal'] ?? null,
    runs: /^\d+$/.test(fields.runs ?? '') ? Number(fields.runs) : null,
  };
}

/** True when `launchctl print-disabled gui/<uid>` lists the label as disabled. */
export function isDisabled(printDisabledText, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${escaped}"\\s*=>\\s*(disabled|true)`).test(String(printDisabledText));
}

/**
 * Runs a command; resolves { code, stdout, stderr } and never rejects.
 * The time limit is hard: at timeoutMs it sends SIGTERM, and if the command is still there graceMs
 * later (npm ignores SIGTERM while it waits on a hung registry connection), SIGKILL.
 * @param {{ timeoutMs?: number, graceMs?: number, cwd?: string, env?: Record<string, string|undefined> }} [options]
 *   cwd: the folder to run it in (npm ci depends on it); env: its environment (default: this process's)
 */
export function runCommand(cmd, args, { timeoutMs = 20_000, graceMs = KILL_GRACE_MS, cwd, env } = {}) {
  return new Promise((resolve) => {
    const limit = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let killTimer = null;
    let child;
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (!error && code === 0 && !timedOut) return resolve({ code: 0, stdout, stderr });
      const why = error ? error.message : signal ? `stopped by ${signal}` : `exit ${code}`;
      const note = timedOut ? `\n(stopped after ${limit(timeoutMs)}: it took too long)` : '';
      resolve({ code: typeof code === 'number' && code !== 0 ? code : 1, stdout, stderr: `${stderr || why}${note}` });
    };
    const termTimer = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGTERM');
      killTimer = setTimeout(() => child?.kill('SIGKILL'), graceMs);
    }, timeoutMs);
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
    } catch (err) {
      return finish(null, null, err);
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout = stdout.length < MAX_OUTPUT ? stdout + c : stdout));
    child.stderr.on('data', (c) => (stderr = stderr.length < MAX_OUTPUT ? stderr + c : stderr));
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));
    // A killed command's own children can keep its output pipes open; don't wait on them.
    child.on('exit', (code, signal) => {
      if (!timedOut) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(code, signal);
    });
  });
}

/** True when nothing listens on host:port, the same check the server's own listen() makes. */
export function portIsFree(port, host = HOST) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

// ---------- the log ----------

const PROTECTED_FOLDERS = ['Documents', 'Desktop', 'Downloads'];

/** "Documents" when the folder sits in one macOS guards with a privacy prompt, else null. */
export function protectedFolder(folder, home) {
  for (const name of PROTECTED_FOLDERS) {
    const dir = path.join(home, name);
    if (folder === dir || folder.startsWith(dir + path.sep)) return name;
  }
  return null;
}

/**
 * macOS privacy (TCC) refusals show up as EPERM / "Operation not permitted", and only matter when
 * the service runs from a protected folder.
 */
export const looksBlockedByPrivacy = (cfg, logText) =>
  protectedFolder(cfg.runDir, cfg.home) !== null && /EPERM|operation not permitted/i.test(String(logText));

// Log text is printed to the terminal: control characters other than tab and newline become "?".
const printable = (text) => String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');

function fileSize(fsImpl, file) {
  try {
    return fsImpl.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The log written since byte `offset` (from the start if the log was emptied since), at most 64 KB. */
export function readLogSince(fsImpl, file, offset) {
  try {
    const size = fsImpl.statSync(file).size;
    const from = Math.max(offset <= size ? offset : 0, size - 64 * 1024);
    const fd = fsImpl.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fsImpl.readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** The last `count` lines of a text ([] for none). */
export function lastLines(text, count = 20) {
  const trimmed = String(text).replace(/\s+$/, '');
  return trimmed ? trimmed.split('\n').slice(-count) : [];
}

// ---------- messages ----------

export function privacySteps(cfg) {
  const folder = protectedFolder(cfg.runDir, cfg.home) || 'Documents';
  return [
    `macOS is stopping node from reading The Desk's folder: it's inside ${folder}, which macOS protects.`,
    'To let it in:',
    `  - If macOS showed a box asking to let "node" access files in your ${folder} folder, click Allow.`,
    '  - Otherwise: open System Settings > Privacy & Security > Full Disk Access, click +,',
    `    press Cmd+Shift+G, type ${cfg.nodePath}, press Return, click Open, and make sure "node" is switched on.`,
    `launchd tries again every ${THROTTLE_SECONDS} seconds, so The Desk starts by itself once node is allowed.`,
    'Check with: npm run service:status',
  ].join('\n');
}

function describeExit(svc) {
  if (svc.lastSignal) return `stopped by a signal (${svc.lastSignal})`;
  return svc.lastExitCode ?? 'unknown';
}

// ---------- the commands ----------

/**
 * @typedef {object} Deps
 * @property {(cmd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} run
 * @property {(port: number) => Promise<boolean>} portIsFree
 * @property {(port: number) => Promise<{ ok: boolean, source?: string }>} probe
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 * @property {typeof fs} fs
 * @property {string} platform
 */

export function realDeps() {
  return {
    run: runCommand,
    portIsFree,
    probe: (port) => probeDesk(port, { timeoutMs: 2000 }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    fs,
    platform: process.platform,
  };
}

/** Is the service loaded into launchd, and is it running? */
export async function readService(cfg, deps) {
  const r = await deps.run(LAUNCHCTL, launchctlArgs.print(cfg));
  if (r.code !== 0) return { loaded: false, state: null, pid: null, lastExitCode: null, lastSignal: null, runs: null };
  return { loaded: true, ...parseLaunchctlPrint(r.stdout) };
}

/** The pid listening on the port, from lsof, or null when it can't tell. */
export async function listenerPid(port, deps) {
  const r = await deps.run(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const first = r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).find((s) => /^\d+$/.test(s)) : undefined;
  return first ? Number(first) : null;
}

async function waitUntilUnloaded(cfg, deps, timeoutMs = 5000) {
  const end = deps.now() + timeoutMs;
  while ((await readService(cfg, deps)).loaded) {
    if (deps.now() >= end) return false;
    await deps.sleep(250);
  }
  return true;
}

async function waitUntilPortFree(cfg, deps, timeoutMs = 5000) {
  const end = deps.now() + timeoutMs;
  while (!(await deps.portIsFree(cfg.port))) {
    if (deps.now() >= end) return false;
    await deps.sleep(250);
  }
  return true;
}

/**
 * Refuses when the port is held by anything but this service.
 * @returns {Promise<string|null>} the refusal message, or null when it's fine to go on
 */
async function portRefusal(cfg, deps, svc) {
  if (await deps.portIsFree(cfg.port)) return null;
  const holder = await listenerPid(cfg.port, deps);
  if (svc.loaded && svc.pid != null && (holder === null || holder === svc.pid)) return null;
  const desk = await deps.probe(cfg.port);
  const who = holder ? ` (process ${holder}${desk.ok ? ', a copy of The Desk' : ''})` : desk.ok ? ' (a copy of The Desk)' : '';
  const hint = desk.ok
    ? 'Is The Desk running in a Terminal (npm run dev or npm start)? Stop it there with Ctrl+C, then run this again.'
    : `Stop that program, or free port ${cfg.port}, then run this again.`;
  return `Port ${cfg.port} is already in use by something other than The Desk service${who}, so nothing was changed.\n${hint}`;
}

/**
 * Waits up to HEALTH_TIMEOUT_MS for The Desk to answer, then says how it went.
 * Stops early when the log shows macOS privacy refusing node.
 */
export async function waitForDesk(cfg, deps, logOffset, timeoutMs = HEALTH_TIMEOUT_MS) {
  const end = deps.now() + timeoutMs;
  for (;;) {
    const r = await deps.probe(cfg.port);
    if (r.ok) return { ok: true, source: r.source };
    const log = readLogSince(deps.fs, cfg.logPath, logOffset);
    if (looksBlockedByPrivacy(cfg, log)) return { ok: false, privacy: true, log };
    if (deps.now() >= end) return { ok: false, privacy: false, log };
    await deps.sleep(500);
  }
}

async function reportHealth(cfg, deps, logOffset, done) {
  const health = await waitForDesk(cfg, deps, logOffset);
  if (health.ok) {
    const svc = await readService(cfg, deps);
    deps.out(`OK: The Desk is running at http://localhost:${cfg.port}${svc.pid ? ` (process ${svc.pid})` : ''}. ${done}`);
    return 0;
  }
  const svc = await readService(cfg, deps);
  deps.err(
    health.privacy
      ? `The Desk couldn't start, so http://localhost:${cfg.port} doesn't answer.`
      : `The Desk didn't answer at http://localhost:${cfg.port} within ${HEALTH_TIMEOUT_MS / 1000} seconds.`,
  );
  if (svc.loaded) deps.err(`launchd says: ${svc.state || 'unknown state'}, last exit: ${describeExit(svc)}.`);
  if (health.privacy) {
    deps.err('');
    deps.err(privacySteps(cfg));
  }
  const tail = lastLines(health.log, 20);
  deps.err('');
  if (tail.length) {
    deps.err(`Last lines of ${cfg.logPath}:`);
    for (const line of tail) deps.err(`  ${printable(line)}`);
  } else {
    deps.err(`${cfg.logPath} has nothing new from this start.`);
  }
  if (!health.privacy) {
    deps.err('');
    const folder = protectedFolder(cfg.runDir, cfg.home);
    if (folder) deps.err(`If macOS asked whether "node" may access your ${folder} folder, click Allow; it starts by itself within ${THROTTLE_SECONDS} seconds.`);
    deps.err('It stays installed and launchd keeps trying. Check again with: npm run service:status');
    deps.err('To take it away: npm run service:uninstall');
  }
  return 1;
}

function writePlist(cfg, deps, text) {
  deps.fs.mkdirSync(path.dirname(cfg.plistPath), { recursive: true });
  const tmp = `${cfg.plistPath}.tmp-${process.pid}`;
  deps.fs.writeFileSync(tmp, text, { mode: 0o644 });
  deps.fs.renameSync(tmp, cfg.plistPath);
}

async function bootstrap(cfg, deps) {
  let r = await deps.run(LAUNCHCTL, launchctlArgs.bootstrap(cfg));
  if (r.code !== 0) {
    // Right after a bootout, launchd can still be tidying up the old one. One more try.
    await deps.sleep(1000);
    r = await deps.run(LAUNCHCTL, launchctlArgs.bootstrap(cfg));
  }
  if (r.code === 0) return true;
  deps.err(`launchctl couldn't load the service: ${printable((r.stderr || r.stdout).trim()) || `exit ${r.code}`}`);
  deps.err('If The Desk was switched off in System Settings > General > Login Items & Extensions ("node" under');
  deps.err('Allow in the Background), switch it back on and run this again.');
  return false;
}

/**
 * The names in dir/package.json "dependencies" that have no <modulesDir>/<name>/package.json,
 * or null when package.json can't be read. Shared by the install guard and deploy's "packages needed?".
 * modulesDir defaults to dir/node_modules.
 */
export function missingPackages(dir, fsImpl = fs, modulesDir = path.join(dir, 'node_modules')) {
  let pkg;
  try {
    pkg = JSON.parse(fsImpl.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const names = pkg && typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? Object.keys(pkg.dependencies) : [];
  return names.filter((name) => !fsImpl.existsSync(path.join(modulesDir, name, 'package.json')));
}

/**
 * Is the live copy ready to run? It needs its code (server/index.js), every package its package.json
 * names, and a finished deploy (.deployed.json) for the very commit it holds. Anything less would
 * crash-loop the moment launchd starts it.
 * @returns {Promise<{ ready: true, deployed: object } | { ready: false, there: boolean, problems: string[] }>}
 */
export async function liveCopyState(cfg, deps) {
  if (!deps.fs.existsSync(cfg.serverPath)) return { ready: false, there: false, problems: ['no server/index.js'] };
  const problems = [];
  if (!deps.fs.existsSync(path.join(cfg.runDir, 'node_modules'))) {
    problems.push('no node_modules');
  } else {
    const missing = missingPackages(cfg.runDir, deps.fs);
    if (missing === null) problems.push('no readable package.json');
    else if (missing.length) problems.push(`node_modules is incomplete (no ${missing.join(', ')})`);
  }
  const deployed = readDeployed(cfg.runDir, { fsImpl: deps.fs });
  if (!deployed) {
    problems.push('no readable .deployed.json');
  } else {
    const head = await deps.run(GIT, ['-C', cfg.runDir, 'rev-parse', 'HEAD'], { env: gitEnv(deps.env || process.env) });
    const sha = head.code === 0 ? head.stdout.trim() : '';
    if (!sha) problems.push("git can't read which commit it holds");
    else if (sha !== deployed.sha) problems.push(`it holds ${sha.slice(0, 7)}, but the last deploy that finished was ${describeDeployed(deployed)}`);
  }
  return problems.length ? { ready: false, there: true, problems } : { ready: true, deployed };
}

/** One line about the live copy: which commit it holds, or what is wrong with it. */
export async function liveCopyLine(cfg, deps) {
  const live = await liveCopyState(cfg, deps);
  if (live.ready) return `${cfg.runDir}, ${describeDeployed(live.deployed)}${live.deployed.deployedAt ? `, deployed ${live.deployed.deployedAt}` : ''}`;
  if (!live.there) return `${cfg.runDir} (not there yet: make it with npm run deploy)`;
  return `${cfg.runDir} (not fully deployed: ${live.problems.join('; ')}; run npm run deploy)`;
}

/**
 * What install would do. liveCopy: liveCopyLine() for the folder it would run, so the dry run says
 * when the live copy is missing (install refuses until npm run deploy has made it).
 */
export function dryRunText(cfg, { liveCopy = cfg.runDir } = {}) {
  const plist = buildPlist(cfg);
  const L = (args) => commandLine(LAUNCHCTL, args);
  return [
    'Dry run: nothing is changed.',
    '',
    `The service will run The Desk from the live copy: ${liveCopy}`,
    '',
    `1. Check that the live copy is fully deployed: server/index.js, every package in its package.json, and a .deployed.json for the commit it holds. If not, stop and say: run npm run deploy.`,
    `2. Check that port ${cfg.port} is free, or held by this service (which is then replaced). Refuse otherwise.`,
    `3. Create the log folder: ${cfg.logDir}`,
    `4. Write ${cfg.plistPath}:`,
    '',
    plist,
    `5. Check it: ${commandLine(PLUTIL, ['-lint', cfg.plistPath])}`,
    `6. Only if it was switched off before: ${L(launchctlArgs.enable(cfg))}`,
    `7. Only if an older copy is loaded (the one in your work folder, too): ${L(launchctlArgs.bootout(cfg))}`,
    `8. Load and start it: ${L(launchctlArgs.bootstrap(cfg))}`,
    `9. Wait up to ${HEALTH_TIMEOUT_MS / 1000} s for http://${HOST}:${cfg.port}/api/feed to answer and say how it went`,
    `   (on failure: the last 20 lines of ${cfg.logPath}).`,
    '',
    'Afterwards:',
    `  service:status     ${L(launchctlArgs.print(cfg))}`,
    `  service:stop       ${L(launchctlArgs.bootout(cfg))}`,
    `  service:start      ${L(launchctlArgs.bootstrap(cfg))}`,
    `  service:restart    ${L(launchctlArgs.kickstart(cfg))}`,
    `  service:uninstall  ${L(launchctlArgs.bootout(cfg))}, then delete ${shellQuote(cfg.plistPath)}`,
  ].join('\n');
}

export async function install(cfg, deps, { dryRun = false } = {}) {
  const plist = buildPlist(cfg);
  if (dryRun) {
    deps.out(dryRunText(cfg, { liveCopy: await liveCopyLine(cfg, deps) }));
    return 0;
  }
  if (deps.platform !== 'darwin') {
    deps.err('The always-on service uses launchd, so it only works on macOS.');
    return 1;
  }
  // Before anything touches the running service: a live copy without its code, its packages or a
  // finished deploy would crash-loop the moment launchd starts it.
  const live = await liveCopyState(cfg, deps);
  if (!live.ready && !live.there) {
    deps.err(`The live copy isn't there yet (${cfg.runDir}), so nothing was changed.`);
    deps.err('Run npm run deploy first: it makes the live copy from main. Then run npm run service:install again.');
    return 1;
  }
  if (!live.ready) {
    deps.err(`The live copy isn't fully deployed yet (${cfg.runDir}: ${live.problems.join('; ')}), so nothing was changed.`);
    deps.err('Run npm run deploy until it finishes (it repairs this), then run npm run service:install again.');
    return 1;
  }
  const svc = await readService(cfg, deps);
  const refusal = await portRefusal(cfg, deps, svc);
  if (refusal) {
    deps.err(refusal);
    return 1;
  }

  deps.fs.mkdirSync(cfg.logDir, { recursive: true });
  writePlist(cfg, deps, plist);
  const lint = await deps.run(PLUTIL, ['-lint', cfg.plistPath]);
  if (lint.code !== 0) {
    deps.err(`The plist didn't pass plutil -lint, so it wasn't loaded:\n${printable((lint.stdout + lint.stderr).trim())}`);
    return 1;
  }

  const disabled = await deps.run(LAUNCHCTL, launchctlArgs.printDisabled(cfg));
  if (disabled.code === 0 && isDisabled(disabled.stdout, cfg.label)) await deps.run(LAUNCHCTL, launchctlArgs.enable(cfg));

  if (svc.loaded) {
    deps.out('Replacing the service that was already installed…');
    await deps.run(LAUNCHCTL, launchctlArgs.bootout(cfg));
    await waitUntilUnloaded(cfg, deps);
    if (!(await waitUntilPortFree(cfg, deps))) {
      deps.err(`The old service stopped, but port ${cfg.port} is still taken. Run npm run service:status to see what has it.`);
      return 1;
    }
  }

  rotateLog(cfg.logPath, { fsImpl: deps.fs });
  const offset = fileSize(deps.fs, cfg.logPath);
  const folder = protectedFolder(cfg.runDir, cfg.home);
  deps.out(`Installed ${cfg.plistPath}, running The Desk from ${cfg.runDir}`);
  if (folder) deps.out(`(This folder is inside ${folder}. If macOS asks whether "node" may access it, click Allow.)`);
  deps.out(`Starting The Desk and waiting for http://localhost:${cfg.port} to answer…`);
  if (!(await bootstrap(cfg, deps))) return 1;
  return reportHealth(cfg, deps, offset, 'It starts by itself when you log in, and again if it ever stops.');
}

export async function start(cfg, deps) {
  if (!deps.fs.existsSync(cfg.plistPath)) {
    deps.err("The Desk service isn't installed yet. Install it with: npm run service:install");
    return 1;
  }
  const svc = await readService(cfg, deps);
  if (svc.loaded) {
    deps.out(`The Desk service is already on${svc.pid ? ` (process ${svc.pid})` : ''}. To restart it: npm run service:restart`);
    return 0;
  }
  const refusal = await portRefusal(cfg, deps, svc);
  if (refusal) {
    deps.err(refusal);
    return 1;
  }
  rotateLog(cfg.logPath, { fsImpl: deps.fs });
  const offset = fileSize(deps.fs, cfg.logPath);
  deps.out(`Starting The Desk and waiting for http://localhost:${cfg.port} to answer…`);
  if (!(await bootstrap(cfg, deps))) return 1;
  return reportHealth(cfg, deps, offset, 'It also starts by itself when you log in.');
}

export async function stop(cfg, deps) {
  const svc = await readService(cfg, deps);
  if (!svc.loaded) {
    deps.out(deps.fs.existsSync(cfg.plistPath) ? "The Desk service isn't running." : "The Desk service isn't installed.");
    return 0;
  }
  const r = await deps.run(LAUNCHCTL, launchctlArgs.bootout(cfg));
  if (!(await waitUntilUnloaded(cfg, deps))) {
    deps.err(`launchctl couldn't stop it: ${printable((r.stderr || r.stdout).trim()) || `exit ${r.code}`}`);
    return 1;
  }
  deps.out('Stopped. The Desk stays off until you run npm run service:start, or until you next log in.');
  return 0;
}

export async function restart(cfg, deps, { done = `Restarted with the code in ${cfg.runDir}.` } = {}) {
  const svc = await readService(cfg, deps);
  if (!svc.loaded) {
    if (deps.fs.existsSync(cfg.plistPath)) deps.out("It wasn't running, so starting it.");
    return start(cfg, deps);
  }
  rotateLog(cfg.logPath, { fsImpl: deps.fs });
  const offset = fileSize(deps.fs, cfg.logPath);
  deps.out(`Restarting The Desk and waiting for http://localhost:${cfg.port} to answer…`);
  const r = await deps.run(LAUNCHCTL, launchctlArgs.kickstart(cfg));
  if (r.code !== 0) {
    deps.err(`launchctl couldn't restart it: ${printable((r.stderr || r.stdout).trim()) || `exit ${r.code}`}`);
    return 1;
  }
  return reportHealth(cfg, deps, offset, done);
}

export async function uninstall(cfg, deps) {
  const svc = await readService(cfg, deps);
  const hadPlist = deps.fs.existsSync(cfg.plistPath);
  if (!svc.loaded && !hadPlist) {
    deps.out("The Desk service isn't installed, so there's nothing to remove.");
    return 0;
  }
  if (svc.loaded) {
    const r = await deps.run(LAUNCHCTL, launchctlArgs.bootout(cfg));
    if (!(await waitUntilUnloaded(cfg, deps))) {
      deps.err(`launchctl couldn't stop it, so it wasn't removed: ${printable((r.stderr || r.stdout).trim()) || `exit ${r.code}`}`);
      return 1;
    }
  }
  if (hadPlist) deps.fs.rmSync(cfg.plistPath, { force: true });
  deps.out("Removed. The Desk won't start by itself any more.");
  deps.out(`Your data and logs are untouched in ${cfg.deskHome}.`);
  return 0;
}

/** The Deployed: line for the folder the service runs (or would run) from. */
function deployedLine(folder, deps) {
  if (!folder) return 'unknown (the installed plist names no folder)';
  if (!deps.fs.existsSync(folder)) return `nothing: ${printable(folder)} doesn't exist (npm run deploy makes it)`;
  const deployed = readDeployed(folder, { fsImpl: deps.fs });
  if (!deployed) return "not recorded (this folder isn't a live copy made by npm run deploy)";
  return `${describeDeployed(deployed)}${deployed.deployedAt ? `, deployed ${deployed.deployedAt}` : ''}`;
}

export async function status(cfg, deps) {
  const plist = readInstalledPlist(cfg, deps);
  const installed = plist.installed;
  const svc = await readService(cfg, deps);
  const desk = await deps.probe(cfg.port);
  const lines = [`The Desk service (${cfg.label})`];
  // The folder the installed plist runs, which is the live copy once the service has moved there.
  const folder = installed ? plist.runDir : cfg.runDir;
  const running = folder ? { ...cfg, runDir: folder } : cfg;

  lines.push(`  Installed:  ${installed ? `yes, ${cfg.plistPath}` : 'no (npm run service:install)'}`);
  lines.push(installed ? `  Runs from:  ${folder ? printable(folder) : 'unknown'}` : `  Live copy:  ${cfg.runDir}`);
  lines.push(`  Deployed:   ${deployedLine(folder, deps)}`);
  if (svc.loaded) {
    lines.push('  Loaded:     yes, launchd keeps it running');
    lines.push(`  Running:    ${svc.pid ? `yes, process ${svc.pid}` : `no (${svc.state || 'unknown'}; launchd retries every ${THROTTLE_SECONDS} s)`}`);
    lines.push(`  Last exit:  ${describeExit(svc)}${svc.runs != null ? ` (started ${svc.runs} time${svc.runs === 1 ? '' : 's'} since it was loaded)` : ''}`);
  } else {
    lines.push(`  Loaded:     no${installed ? ' (stopped: npm run service:start, or it starts at your next login)' : ''}`);
    lines.push('  Running:    no');
  }

  let holder = null;
  if (desk.ok || !(await deps.portIsFree(cfg.port))) holder = await listenerPid(cfg.port, deps);
  if (desk.ok) {
    const byService = svc.pid != null && (holder === null || holder === svc.pid);
    const who = byService ? 'by the service' : `by process ${holder ?? '?'}, not the service (npm run dev or npm start in a Terminal?)`;
    lines.push(`  Answers:    yes, http://localhost:${cfg.port} (served ${who}; edition: ${desk.source})`);
  } else {
    lines.push(`  Answers:    no, nothing from The Desk at http://localhost:${cfg.port}${holder ? ` (process ${holder} holds the port)` : ''}`);
  }
  lines.push(`  Log:        ${cfg.logPath}${deps.fs.existsSync(cfg.logPath) ? ` (${Math.ceil(fileSize(deps.fs, cfg.logPath) / 1024)} KB)` : ' (not created yet)'}`);
  deps.out(lines.join('\n'));

  if (installed && plist.runDir !== cfg.runDir) {
    deps.out(`\nThe service still runs from ${plist.runDir ? printable(plist.runDir) : 'an unknown folder'}, not from the live copy ${cfg.runDir}.`);
    deps.out(
      deps.fs.existsSync(cfg.serverPath)
        ? 'Run npm run service:install once to move it to the live copy.'
        : 'Run npm run deploy to make the live copy, then npm run service:install once to move the service to it.',
    );
  } else if (installed && plist.text !== buildPlist(cfg)) {
    deps.out('\nThe installed plist differs from what service:install would write now (Node moved, or the settings changed).');
    deps.out('Run npm run service:install to update it.');
  }
  if (svc.loaded && !desk.ok) {
    const tail = lastLines(readLogSince(deps.fs, cfg.logPath, 0), 20);
    if (looksBlockedByPrivacy(running, tail.join('\n'))) deps.out(`\n${privacySteps(running)}`);
    if (tail.length) {
      deps.out(`\nLast lines of ${cfg.logPath}:`);
      for (const line of tail) deps.out(`  ${printable(line)}`);
    }
  }
  return 0;
}

const RUNNERS = { install, uninstall, start, stop, restart, status };

/** The whole CLI, with everything outside injected. Returns the exit code. */
export async function main(argv, { env = process.env, deps = realDeps(), cfg } = {}) {
  const args = parseArgs(argv, env);
  if (args.error) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.command === 'help') {
    deps.out(USAGE);
    return 0;
  }
  const config = cfg || serviceConfig({ env });
  if (args.command === 'install') return install(config, deps, { dryRun: args.dryRun });
  return RUNNERS[args.command](config, deps);
}

function runDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`The Desk service: ${err?.message || err}`);
      process.exit(1);
    },
  );
}
