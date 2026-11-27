#!/usr/bin/env node
// npm run deploy                 put the latest committed main live, then restart The Desk
// npm run deploy -- --dry-run    print every step, change nothing
//
// The always-on Desk (scripts/service.js) runs from the live copy, ~/the-desk-live: a git worktree of
// this repo in detached HEAD that only ever holds a commit of main. Run this from your work folder
// (any checkout of the repo works, but not the live copy). It never copies the working tree: it checks
// out the main ref, so uncommitted changes and story branches never reach http://localhost:4321.
//
//   0. Check everything first: the live copy is a clean worktree of this repo (refuse if
//      git status --porcelain shows anything). Remove a staging folder an interrupted run left.
//   1. When packages need installing (a new copy, no node_modules, or package-lock.json changed since
//      the last deploy that went through, the one in .deployed.json): npm ci --omit=dev in a staging
//      folder beside the live copy (<live>.staging), from the new commit's package.json and lockfile.
//      If it fails, stop: the live copy is untouched.
//   2. No live copy yet: git worktree add --detach <live> <main>. Else git checkout --detach <main> there.
//   3. Swap the staged node_modules in with renames, and remove the staging folder.
//   4. Write <live>/.deployed.json (gitignored): the commit, its subject and the deploy time.
//   5. If the installed service doesn't run from the live copy yet, stop and say to run
//      npm run service:install once. Otherwise restart it, wait for it to answer, and say what's live.
//
// Every git, npm and launchctl call goes through an injected runner, so the tests never run them for
// real against Snow's Mac. git runs without GIT_DIR and friends (see gitEnv). DESK_LIVE_DIR moves the
// live copy (the tests use a temp folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST, REPO_ROOT, resolveLiveDir } from '../server/config.js';
import { deployedPath, deployedRecord, describeDeployed, oneLine, readDeployed } from '../server/deployed.js';
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
// A line of git's or npm's own output, printed as is (git status keeps meaning in its leading spaces), minus control characters.
const asIs = (line) => line.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?').slice(0, 300);

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

// Environment variables that tell git which repo, index or object store to use. A git hook,
// `git rebase -x` or `git bisect run` exports them; left in, they would point deploy's
// `git -C <folder>` commands at whatever repo started it instead of the folder named.
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

/** Where packages are installed before they go into the live copy: a folder beside it, never inside. */
export const stagingDir = (liveDir) => `${liveDir}.staging`;

// All a staging folder ever holds. Anything else means it isn't ours, so deploy won't delete it.
const STAGING_ENTRIES = new Set(['package.json', 'package-lock.json', 'node_modules', 'node_modules.old']);

/** The main worktree of the repo (the work folder), from `git worktree list`, or null. */
async function mainWorktree(git, dir) {
  const r = await git(['-C', dir, 'worktree', 'list', '--porcelain']);
  const first = r.code === 0 ? lines(r.stdout).find((l) => l.startsWith('worktree ')) : null;
  return first ? first.slice('worktree '.length) : null;
}

// ---------- deploy ----------

/**
 * @param {ReturnType<typeof deployConfig>} cfg
 * @param {import('./service.js').Deps & { env?: Record<string, string|undefined> }} deps run(cmd, args, { cwd, timeoutMs, env })
 *   runs git, npm and launchctl; env (default process.env) is the environment git gets, minus gitEnv()'s variables
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<number>} the exit code
 */
export async function deploy(cfg, deps, { dryRun = false } = {}) {
  const { repoRoot: repo, liveDir: live, ref } = cfg;
  const staging = stagingDir(live);
  const env = gitEnv(deps.env || process.env);
  const git = (args, options = {}) => deps.run(GIT, args, { ...options, env });
  const out = (line) => deps.out(line);
  const fail = (...msg) => {
    for (const line of msg) deps.err(line);
    return 1;
  };
  const removeStaging = () => deps.fs.rmSync(staging, { recursive: true, force: true });

  // Run from the work folder, never from the live copy, and keep the live copy (and its staging
  // folder) out of the work folder.
  if (inside(repo, live) || inside(live, repo) || inside(staging, repo) || inside(repo, staging)) {
    const work = inside(repo, live) ? await mainWorktree(git, repo) : null;
    if (work && realpath(deps.fs, repo) !== work) {
      // This folder is the live copy (a linked worktree): point at the real work folder.
      return fail(`Run npm run deploy from your work folder (${work}), not from the live copy. Nothing was changed.`);
    }
    return fail(`The live copy (${live}) can't be your work folder or sit inside it (${repo}), so nothing was changed.`, 'Point DESK_LIVE_DIR somewhere else, or leave it unset for ~/the-desk-live.');
  }

  // A staging folder left by an interrupted deploy goes first, but only if it holds nothing but ours.
  let leftover = false;
  if (deps.fs.existsSync(staging)) {
    let entries = null;
    try {
      entries = deps.fs.readdirSync(staging);
    } catch {
      /* not a folder: not ours */
    }
    if (!entries || entries.some((e) => !STAGING_ENTRIES.has(e))) {
      return fail(`${staging} is there and holds things deploy didn't put there, so nothing was changed.`, 'Move it out of the way, then run npm run deploy again.');
    }
    leftover = true;
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

  // Check the live copy, if there is one. Nothing is changed until every check has passed.
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
        ...changed.slice(0, 10).map((l) => `  ${asIs(l)}`),
        ...(changed.length > 10 ? [`  …and ${changed.length - 10} more`] : []),
        `The live copy only ever holds committed main. Make the change in your work folder and commit it to main.`,
        `To look: git -C ${shellQuote(live)} status. To set them aside (you can get them back with stash pop): git -C ${shellQuote(live)} stash --include-untracked`,
        'Then run npm run deploy again.',
      );
    }
    const now = await git(['-C', live, 'rev-parse', 'HEAD']);
    oldSha = now.code === 0 && SHA.test(now.stdout.trim()) ? now.stdout.trim() : null;
  }

  // Do the packages need installing? The base is the last deploy that went all the way through
  // (.deployed.json): its packages are the ones in the live copy.
  const installed = exists ? readDeployed(live, { fsImpl: deps.fs }) : null;
  let why = null;
  if (!exists) why = 'a new live copy';
  else if (!deps.fs.existsSync(path.join(live, 'node_modules'))) why = 'node_modules is missing';
  else if (!installed) why = 'no earlier deploy is recorded';
  else if (installed.sha !== sha) {
    const d = await git(['-C', repo, 'diff', '--quiet', installed.sha, sha, '--', 'package-lock.json']);
    if (d.code !== 0) why = d.code === 1 ? 'package-lock.json changed' : "git couldn't tell whether package-lock.json changed";
  }

  let step = 0;
  const say = (text) => out(`${++step}. ${text}`);
  const npmArgs = ['ci', '--omit=dev'];
  const showArgs = (file) => ['-C', repo, 'show', `${sha}:${file}`];
  const moveArgs = !exists ? ['-C', repo, 'worktree', 'add', '--detach', live, sha] : ['-C', live, 'checkout', '--quiet', '--detach', sha];
  const moves = !exists || oldSha !== sha;

  if (dryRun) {
    if (leftover) say(`Remove a staging folder left by an interrupted deploy: rm -rf ${shellQuote(staging)}`);
    if (why) {
      say(`Install the packages first, outside the live copy (${why}):`);
      out(`   mkdir ${shellQuote(staging)}`);
      for (const file of ['package.json', 'package-lock.json']) out(`   ${commandLine(GIT, showArgs(file))} > ${shellQuote(path.join(staging, file))}`);
      out(`   cd ${shellQuote(staging)} && ${commandLine(cfg.npm, npmArgs)}`);
      out('   If that fails, deploy removes the staging folder and stops here: the live copy is untouched.');
    } else {
      say('Packages: node_modules is there and package-lock.json is the same, so no npm ci.');
    }
    if (!exists) say(`There's no live copy yet. Make it, a git worktree of this repo detached at ${ref}:`);
    else if (!moves) say(`The live copy already holds ${ref} @ ${short(sha)} and has no changes of its own. Nothing to move.`);
    else say(`The live copy is on ${oldSha ? short(oldSha) : 'an unknown commit'} and has no changes of its own. Move it to ${ref}:`);
    if (moves) out(`   ${commandLine(GIT, moveArgs)}`);
    if (why) {
      say('Swap the new packages in, then remove the staging folder:');
      if (exists && deps.fs.existsSync(path.join(live, 'node_modules'))) out(`   mv ${shellQuote(path.join(live, 'node_modules'))} ${shellQuote(path.join(staging, 'node_modules.old'))}`);
      out(`   mv ${shellQuote(path.join(staging, 'node_modules'))} ${shellQuote(path.join(live, 'node_modules'))}`);
      out(`   rm -rf ${shellQuote(staging)}`);
    }
  } else {
    if (leftover) {
      out('Removing a staging folder left by an interrupted deploy…');
      removeStaging();
    }

    // 1. Packages first, in a staging folder beside the live copy, from the new commit's own
    // package.json and package-lock.json. npm ci empties node_modules before it installs, so it
    // never runs inside the live copy: if it fails, the live copy hasn't changed at all.
    if (why) {
      out(`Installing packages beside the live copy (${commandLine('npm', npmArgs)}, because ${why})…`);
      deps.fs.mkdirSync(staging, { recursive: true });
      for (const file of ['package.json', 'package-lock.json']) {
        const r = await git(showArgs(file));
        if (r.code !== 0) {
          removeStaging();
          return fail(`${ref} @ ${short(sha)} has no ${file} that git can read, so nothing was changed. (git: ${firstLine(r)})`);
        }
        deps.fs.writeFileSync(path.join(staging, file), r.stdout);
      }
      const r = await deps.run(cfg.npm, npmArgs, { cwd: staging, timeoutMs: NPM_CI_TIMEOUT_MS });
      if (r.code !== 0) {
        removeStaging();
        const tail = lines(`${r.stdout}\n${r.stderr}`).slice(-15);
        return fail(
          "npm ci didn't work, so nothing was deployed: the live copy is untouched and The Desk keeps running what it had.",
          ...tail.map((l) => `  ${asIs(l)}`),
          'Fix the problem, then run npm run deploy again.',
        );
      }
    }

    // 2. Move the live copy to main (or make it).
    if (!exists) {
      out(`Making the live copy (a git worktree, detached at ${ref} @ ${short(sha)})…`);
    } else if (moves) {
      out(`Moving the live copy from ${oldSha ? short(oldSha) : 'an unknown commit'} to ${short(sha)}…`);
    } else {
      out(`The live copy already holds ${ref} @ ${short(sha)}.`);
    }
    if (moves) {
      const r = await git(moveArgs);
      if (r.code !== 0) {
        removeStaging();
        return fail(
          `git couldn't ${exists ? `move the live copy to ${ref}` : 'make the live copy'}: ${firstLine(r)}`,
          ...(exists ? [] : ['If it says the folder is a missing but already registered worktree, run git worktree prune, then npm run deploy again.']),
          'The Desk was not restarted, so it keeps running what it had.',
        );
      }
    }

    // 3. Swap the new packages in with renames (same disk, so each is instant), then tidy up.
    if (why) {
      const liveModules = path.join(live, 'node_modules');
      try {
        if (deps.fs.existsSync(liveModules)) deps.fs.renameSync(liveModules, path.join(staging, 'node_modules.old'));
        deps.fs.renameSync(path.join(staging, 'node_modules'), liveModules);
      } catch (err) {
        return fail(`Couldn't move the new packages into the live copy (${err.code || err.message}), so The Desk was not restarted.`, 'Run npm run deploy again: it installs them afresh.');
      }
      removeStaging();
    }
  }

  // 4. Remember what's deployed. Written last, so it only ever names a commit whose packages are in.
  const record = deployedRecord({ sha, subject, ref, deployedAt: localTimestamp(new Date(deps.now())) });
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  if (dryRun) {
    say(`Write ${cfg.deployedFile}:`);
    out(recordText.replace(/^/gm, '   ').trimEnd());
  } else {
    writeFileAtomic(deps.fs, cfg.deployedFile, recordText);
  }

  // 5. The service: it must run from the live copy before a restart means anything.
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
