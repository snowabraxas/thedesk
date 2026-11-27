// The desktop app's Preview button (.claude/launch.json, port 3000) runs its own Desk on its own data,
// so a tab on 3000 and Snow's live Desk on 4321 can never overwrite each other's saves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT, resolveDeskHome, resolvePort } from '../server/config.js';

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The NAME=value words in front of an npm script's command. */
function scriptEnv(script) {
  const env = {};
  for (const m of script.matchAll(/(?:^|\s)([A-Z_]+)=(\S+)/g)) env[m[1]] = m[2];
  return env;
}

describe('npm run preview', () => {
  const { scripts } = JSON.parse(read('package.json'));
  const env = scriptEnv(scripts.preview);

  test('runs the dev server on port 3000', () => {
    assert.match(scripts.preview, /node --watch server\/index\.js$/);
    assert.equal(resolvePort(env), 3000);
  });

  test("keeps its data in a gitignored folder inside the repo, never Snow's ~/agent-house", () => {
    const deskHome = path.resolve(REPO_ROOT, env.DESK_HOME); // npm runs scripts from the repo root
    assert.equal(deskHome, path.join(REPO_ROOT, '.desk-preview'));
    assert.notEqual(deskHome, resolveDeskHome({}));
    assert.match(read('.gitignore'), /^\.desk-preview\/$/m);
  });

  test('the Preview button runs it', () => {
    const launch = JSON.parse(read('.claude/launch.json'));
    assert.equal(launch.configurations.length, 1);
    const [config] = launch.configurations;
    assert.equal(config.runtimeExecutable, 'npm');
    assert.deepEqual(config.runtimeArgs, ['run', 'preview']);
    assert.equal(config.port, 3000);
  });
});
