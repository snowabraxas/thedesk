#!/usr/bin/env node
// npm run deploy                 put the latest committed main live, then restart The Desk
// npm run deploy -- --dry-run    print every step, change nothing
//
// The always-on Desk (scripts/service.js) runs from the live copy, ~/the-desk-live: a git worktree of
// this repo in detached HEAD that only ever holds a commit of main. Run this from your work folder
// (any checkout of the repo works). It never copies the working tree: it checks out the main ref, so
// uncommitted changes and story branches never reach http://localhost:4321.
//
//   1. No live copy yet: git worktree add --detach <live> <main>. Else refuse if the live copy has
//      changes of its own (git status --porcelain), and otherwise git checkout --detach <main> there.
//   2. npm ci --omit=dev in the live copy when node_modules is missing or package-lock.json changed.
//   3. Write <live>/.deployed.json (gitignored): the commit, its subject and the deploy time.
//   4. If the installed service doesn't run from the live copy yet, stop and say to run
//      npm run service:install once. Otherwise restart it, wait for it to answer, and say what's live.
//
// Every git, npm and launchctl call goes through an injected runner, so the tests never run them for
// real against Snow's Mac. DESK_LIVE_DIR moves the live copy (the tests use a temp folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST, REPO_ROOT, resolveLiveDir } from '../server/config.js';
import { deployedPath, deployedRecord, describeDeployed, oneLine } from '../server/deployed.js';
import { localTimestamp } from '../server/log-file.js';
import { HEALTH_TIMEOUT_MS, LAUNCHCTL, launchctlArgs, readInstalledPlist, realDeps, resolveNodePath, restart, serviceConfig, shellQuote } from './service.js';

export const GIT = 'git';
export const DEPLOY_REF = 'main';
export const NPM_CI_TIMEOUT_MS = 10 * 60_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const USAGE = `Usage: npm run deploy [-- --dry-run]

  Puts the latest committed main live: updates the live copy (~/the-desk-live) to main,
  installs its packages when they changed, and restarts The Desk on http://localhost:4321.
  Uncommitted changes and other branches are never deployed.

  --dry-run   print every step, change nothing`;

// ---------- arguments and configuration ----------

/**
 * @param {string[]} argv the words after `node scripts/deploy.js`
 * @param {Record<string, string|undefined>} [env] npm swallows a --dry-run typed without "--" and
 *   sets npm_config_dry_run=true instead, so that counts as a dry run too
 * @returns {{ dryRun: boolean } | { help: true } | { error: string }}
 */
export function parseArgs(argv, env = {}) {
  if (argv.includes('-h') || argv.includes('--help') || (argv.length === 1 && argv[0] === 'help')) return { help: true };
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) return { error: `Unknown ${unknown[0].startsWith('-') ? 'option' : 'word'} ${JSON.stringify(unknown.join(' '))}.` };
  return { dryRun: argv.includes('--dry-run') || env.npm_config_dry_run === 'true' };
}

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The npm that sits next to the node the service uses (Homebrew's), else whatever "npm" PATH finds. */
export function resolveNpmPath(nodePath, { exists = isExecutable } = {}) {
  const beside = path.join(path.dirname(nodePath), 'npm');
  return path.isAbsolute(nodePath) && exists(beside) ? beside : 'npm';
}

/** Where everything is: this checkout, the live copy, and the service that runs it. */
export function deployConfig({ env = process.env, home = os.homedir(), uid, repoRoot = REPO_ROOT, nodePath = resolveNodePath(), npm } = {}) {
  const liveDir = resolveLiveDir(env, home);
  return {
    repoRoot: path.resolve(repoRoot),
    liveDir,
    ref: DEPLOY_REF,
    deployedFile: deployedPath(liveDir),
    npm: npm || resolveNpmPath(nodePath),
    service: serviceConfig({ home, uid, runDir: liveDir, nodePath }),
  };
}

// ---------- helpers ----------

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const commandLine = (cmd, args) => [cmd, ...args].map(shellQuote).join(' ');
const short = (sha) => sha.slice(0, 7);
const firstLine = (r) => oneLine((r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.code}`, 300);
const lines = (text) => String(text).split('\n').filter(Boolean);

function realpath(fsImpl, p) {
  try {
    return fsImpl.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Writes a small file whole or not at all: a temp file in the same folder, then a rename. */
function writeFileAtomic(fsImpl, file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, text);
  fsImpl.renameSync(tmp, file);
}

// ---------- deploy ----------

/**
 * @param {ReturnType<typeof deployConfig>} cfg
 * @param {import('./service.js').Deps} deps run(cmd, args, { cwd, timeoutMs }) runs git, npm and launchctl
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<number>} the exit code
 */
export async function deploy(cfg, deps, { dryRun = false } = {}) {
  const { repoRoot: repo, liveDir: live, ref } = cfg;
  const git = (args, options) => deps.run(GIT, args, options);
  const out = (line) => deps.out(line);
  const fail = (...msg) => {
    for (const line of msg) deps.err(line);
    return 1;
  };

  // The live copy is never this checkout, nor a folder around it or inside it.
  if (inside(live, repo) || inside(repo, live)) {
    return fail(`The live copy (${live}) can't be this folder or sit inside it (${repo}), so nothing was changed.`, 'Point DESK_LIVE_DIR somewhere else, or leave it unset for ~/the-desk-live.');
  }

  // What is main, right now? Everything below uses this one commit, even if main moves meanwhile.
  const head = await git(['-C', repo, 'log', '-1', '--format=%H%n%s', `refs/heads/${ref}`, '--']);
  const [sha = '', subject = ''] = head.stdout.split('\n');
  if (head.code !== 0 || !SHA.test(sha)) {
    return fail(`There's no ${ref} branch in ${repo} to deploy, so nothing was changed. (git: ${firstLine(head)})`);
  }
  const target = { sha, shortSha: short(sha), subject: oneLine(subject), ref };
  if (dryRun) out('Dry run: nothing is changed.\n');
  out(`Deploying ${describeDeployed(target)} to the live copy, ${live}`);

  // Heads-ups only: uncommitted work and other branches here never go live.
  const branch = await git(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const onBranch = branch.code === 0 ? branch.stdout.trim() : '';
  if (onBranch && onBranch !== ref) out(`(This folder is on ${onBranch === 'HEAD' ? 'a detached commit' : `branch ${oneLine(onBranch, 100)}`}. That doesn't matter: deploy always takes ${ref}.)`);
  const here = await git(['-C', repo, '--no-optional-locks', 'status', '--porcelain']);
  if (here.code === 0 && here.stdout.trim()) out("(This folder has uncommitted changes. They stay here: only what's committed to main goes live.)");

  // 1. The live copy: make it, or check it and move it to main.
  const exists = deps.fs.existsSync(live);
  let oldSha = null;
  if (exists) {
    const top = await git(['-C', live, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    const ours = await git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const [liveTop, liveCommon] = lines(top.stdout);
    if (top.code !== 0 || ours.code !== 0 || liveTop !== realpath(deps.fs, live) || liveCommon !== ours.stdout.trim()) {
      return fail(`${live} is there, but it isn't a live copy of this repo (a git worktree of it), so nothing was changed.`, 'Move that folder out of the way, then run npm run deploy again.');
    }
    const dirty = await git(['-C', live, '--no-optional-locks', 'status', '--porcelain']);
    if (dirty.code !== 0) return fail(`Couldn't check the live copy for changes, so nothing was changed. (git: ${firstLine(dirty)})`);
    if (dirty.stdout.trim()) {
      const changed = lines(dirty.stdout);
      return fail(
        `The live copy has changes of its own, so nothing was deployed:`,
        ...changed.slice(0, 10).map((l) => `  ${oneLine(l, 200)}`),
        ...(changed.length > 10 ? [`  …and ${changed.length - 10} more`] : []),
        `The live copy only ever holds committed main. Make the change in your work folder and commit it to main.`,
        `To look: git -C ${shellQuote(live)} status. To set them aside (you can get them back with stash pop): git -C ${shellQuote(live)} stash --include-untracked`,
        'Then run npm run deploy again.',
      );
    }
    const now = await git(['-C', live, 'rev-parse', 'HEAD']);
    oldSha = now.code === 0 && SHA.test(now.stdout.trim()) ? now.stdout.trim() : null;
  }

  let step = 0;
  const say = (text) => out(`${++step}. ${text}`);

  if (!exists) {
    const args = ['-C', repo, 'worktree', 'add', '--detach', live, sha];
    if (dryRun) {
      say(`There's no live copy yet. Make it, a git worktree of this repo detached at ${ref}:`);
      out(`   ${commandLine(GIT, args)}`);
    } else {
      out(`Making the live copy (a git worktree, detached at ${ref} @ ${short(sha)})…`);
      const r = await git(args);
      if (r.code !== 0) {
        return fail(
          `git couldn't make the live copy: ${firstLine(r)}`,
          "If it says the folder is a missing but already registered worktree, run git worktree prune, then npm run deploy again.",
        );
      }
    }
  } else if (oldSha === sha) {
    if (dryRun) say(`The live copy already holds ${ref} @ ${short(sha)} and has no changes of its own. Nothing to move.`);
    else out(`The live copy already holds ${ref} @ ${short(sha)}.`);
  } else {
    const args = ['-C', live, 'checkout', '--quiet', '--detach', sha];
    if (dryRun) {
      say(`The live copy is on ${oldSha ? short(oldSha) : 'an unknown commit'} and has no changes of its own. Move it to ${ref}:`);
      out(`   ${commandLine(GIT, args)}`);
    } else {
      out(`Moving the live copy from ${oldSha ? short(oldSha) : 'an unknown commit'} to ${short(sha)}…`);
      const r = await git(args);
      if (r.code !== 0) return fail(`git couldn't move the live copy to ${ref}: ${firstLine(r)}`, 'The Desk was not restarted, so it keeps running what it had.');
    }
  }

  // 2. Packages: only when they could have changed.
  let why = null;
  if (!exists) why = 'a new live copy';
  else if (!deps.fs.existsSync(path.join(live, 'node_modules'))) why = 'node_modules is missing';
  else if (oldSha === null) why = "the live copy's old commit is unknown";
  else if (oldSha !== sha) {
    const d = await git(['-C', repo, 'diff', '--quiet', oldSha, sha, '--', 'package-lock.json']);
    if (d.code !== 0) why = d.code === 1 ? 'package-lock.json changed' : "git couldn't tell whether package-lock.json changed";
  }
  const npmArgs = ['ci', '--omit=dev'];
  if (why && dryRun) {
    say(`Install its packages (${why}):`);
    out(`   cd ${shellQuote(live)} && ${commandLine(cfg.npm, npmArgs)}`);
  } else if (why) {
    out(`Installing packages (${commandLine('npm', npmArgs)}, because ${why})…`);
    const r = await deps.run(cfg.npm, npmArgs, { cwd: live, timeoutMs: NPM_CI_TIMEOUT_MS });
    if (r.code !== 0) {
      const tail = lines(`${r.stdout}\n${r.stderr}`).slice(-15);
      return fail(
        `npm ci didn't work in the live copy, so The Desk was not restarted (it keeps running what it had):`,
        ...tail.map((l) => `  ${oneLine(l, 300)}`),
        'Fix the problem, then run npm run deploy again.',
      );
    }
  } else if (dryRun) {
    say('Packages: node_modules is there and package-lock.json is the same, so no npm ci.');
  }

  // 3. Remember what's deployed.
  const record = deployedRecord({ sha, subject, ref, deployedAt: localTimestamp(new Date(deps.now())) });
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  if (dryRun) {
    say(`Write ${cfg.deployedFile}:`);
    out(recordText.replace(/^/gm, '   ').trimEnd());
  } else {
    writeFileAtomic(deps.fs, cfg.deployedFile, recordText);
  }

  // 4. The service: it must run from the live copy before a restart means anything.
  const svc = cfg.service;
  const plist = readInstalledPlist(svc, deps);
  const moved = plist.installed && plist.runDir !== null && path.resolve(plist.runDir) === live;
  const notMoved = !plist.installed
    ? [`The live copy is ready (${describeDeployed(record)}), but The Desk service isn't installed.`, 'Install it with: npm run service:install']
    : [
        `The live copy is ready (${describeDeployed(record)}), but The Desk service still runs from ${plist.runDir ? oneLine(plist.runDir, 300) : 'another folder'}.`,
        'Run npm run service:install once to move the service to the live copy. After that, npm run deploy restarts it for you.',
      ];
  const liveLine = `The Desk is live at http://localhost:${svc.port} on ${describeDeployed(record)}`;

  if (dryRun) {
    say(`Check that the service runs from the live copy (WorkingDirectory in ${svc.plistPath}).`);
    if (!moved) {
      out(`   It doesn't yet, so deploy stops here and says:`);
      for (const line of notMoved) out(`   ${line}`);
      return 0;
    }
    out('   It does.');
    say(`Restart it and wait up to ${HEALTH_TIMEOUT_MS / 1000} s for http://${HOST}:${svc.port}/api/feed to answer:`);
    out(`   ${commandLine(LAUNCHCTL, launchctlArgs.kickstart(svc))}`);
    out(`   (or, if it's stopped: ${commandLine(LAUNCHCTL, launchctlArgs.bootstrap(svc))})`);
    say(`Say: ${liveLine}`);
    return 0;
  }

  if (!moved) return fail(...notMoved);
  const code = await restart(svc, deps, { done: `Restarted from ${live}.` });
  if (code !== 0) return code;
  out(liveLine);
  return 0;
}

/** The whole CLI, with everything outside injected. Returns the exit code. */
export async function main(argv, { env = process.env, deps = realDeps(), cfg } = {}) {
  const args = parseArgs(argv, env);
  if (args.error) {
    deps.err(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    deps.out(USAGE);
    return 0;
  }
  return deploy(cfg || deployConfig({ env }), deps, { dryRun: args.dryRun });
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
      console.error(`npm run deploy: ${err?.message || err}`);
      process.exit(1);
    },
  );
}
