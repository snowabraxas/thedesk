// Runs `npm run <script> -- <args>` the way an agent types it, for the CLI tests.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../server/config.js';

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

/** Path to npm's CLI script, or null when npm can't be found (the npm tests skip). */
export const NPM_CLI = findNpmCli();

/** `npm run <script> -- <args>`, typed in `cwd`, with none of the outer npm's variables leaking in. */
export function runNpm(script, args, { cwd = REPO_ROOT, env = {} } = {}) {
  const cleanEnv = { ...process.env, ...env };
  for (const key of Object.keys(cleanEnv)) if (/^npm_/i.test(key) || key === 'INIT_CWD') delete cleanEnv[key];
  const npmArgs = [NPM_CLI, 'run', script, ...(args.length ? ['--', ...args] : [])];
  return spawnSync(process.execPath, npmArgs, { cwd, env: cleanEnv, encoding: 'utf8' });
}
