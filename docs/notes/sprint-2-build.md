# Sprint 2: build decisions (lead dev)

Technical notes for the team. Snow doesn't need to read this.

## N1. Live copy separate from work in progress

### The problem

Through Sprint 1 the always-on service ran `node server/index.js` from the main checkout in `~/Documents/Projects/the-desk`. Checking out a story branch there changed Snow's live Desk: `app/` on the next reload, `server/` on the next restart. Story work had to live in separate worktrees to stay safe.

### Layout

```
~/Documents/Projects/the-desk/   the main checkout: where you work, merge and run npm run deploy
~/Documents/Projects/the-desk-*  story worktrees (n1-live-copy, n2-news-contract, ...)
~/the-desk-live/                 the live copy: a git worktree of the same repo, detached HEAD at
                                 a commit of main, plus node_modules (prod only) and .deployed.json
~/the-desk-live.staging/         only while a deploy installs packages: npm ci runs here, never in
                                 the live copy; removed when the deploy ends
~/agent-house/                   Snow's data and the service log (unchanged)
~/Library/LaunchAgents/local.thedesk.server.plist
                                 WorkingDirectory and server/index.js now point into ~/the-desk-live
```

- **Why `~/the-desk-live`.** Outside `~/Documents`, so macOS privacy never has a say over the code the service runs. Outside `~/agent-house`, so the desk agents (which write there) can't touch the code. The sprint doc's example was `~/agent-house/the-desk-live`; the lead dev chose `~/the-desk-live` for that second reason.
- **Why a worktree.** It shares the repo's objects and refs, so deploying is a `git checkout`, with no clone, no fetch and no network. Being detached, it never holds a branch, so `main` stays free to be checked out in the main checkout.
- **Where the path lives.** `resolveLiveDir()` in `server/config.js`. `DESK_LIVE_DIR` overrides it (tests and dry runs only).
- **`.deployed.json`** (in the live copy, gitignored): `{ sha, shortSha, subject, ref, deployedAt }`. Written by deploy, read by the server at start and by `service:status` (`server/deployed.js` checks the sha and strips control characters before anything prints it).

### How `npm run deploy` works (`scripts/deploy.js`)

Run it from your work folder (any checkout of the repo except the live copy). It always takes the local `refs/heads/main`, resolved once to a sha at the start, never the working tree. Pushing to GitHub doesn't matter to it. Every check comes before any change.

1. **Checks.**
   - Run from the live copy itself, it says "Run npm run deploy from your work folder (…), not from the live copy." It refuses a live path that is the work folder or sits inside it.
   - A staging folder left by an interrupted run is removed, but only if it holds nothing beyond `package.json`, `package-lock.json`, `node_modules` and `node_modules.old`. Otherwise it refuses and leaves the folder alone.
   - It reads main's sha and subject. It notes, without stopping, when the folder you ran it from is on another branch or has uncommitted changes. Neither is deployed.
   - If the live copy exists, it must be a worktree of this repo (same `--git-common-dir`, top level is the folder itself), and `git status --porcelain` must be empty. A dirty copy is refused: it lists up to 10 lines and suggests `git -C <live> stash --include-untracked`.
2. **Packages first, outside the live copy.** This step runs only when it's a new copy, `node_modules` is missing, no deploy is recorded, or `git diff --quiet <last deployed> <new> -- package-lock.json` says the lockfile changed. The base is the sha in `.deployed.json`: the last deploy that went all the way through, whose packages are the ones in the live copy.
   - `git show <sha>:package.json` and `<sha>:package-lock.json` are written into `<live>.staging`, and `npm ci --omit=dev` runs there (the npm next to Homebrew node, 10-minute limit).
   - npm 11 empties `node_modules` before it installs, so it never runs in the live copy. If it fails, or the commit has no lockfile, deploy removes the staging folder and stops. The live copy's code, packages and `.deployed.json` are exactly as they were, so a launchd restart, a login or a reboot still runs the old, working version.
3. **Move the live copy.** No live copy yet: `git -C <repo> worktree add --detach <live> <sha>`. Otherwise `git -C <live> checkout --quiet --detach <sha>`, or nothing if it's already there.
4. **Swap the packages in.** Two renames on the same disk: `<live>/node_modules` to `<live>.staging/node_modules.old`, then `<live>.staging/node_modules` to `<live>/node_modules`. Then the staging folder is removed. The old copy goes into the staging folder, not the live copy, so an interrupted swap never leaves untracked files in the live copy. The next run tidies them away.
5. **Record it.** `.deployed.json` is written (temp file and rename) only now, so it only ever names a commit whose packages are in.
6. **Restart.** It reads the installed plist's `WorkingDirectory`. Not installed, or not the live copy: it stops (exit 1) and says to run `npm run service:install` once. Otherwise it calls `restart()` from `scripts/service.js` (`launchctl kickstart -k`, or bootstrap if it was stopped), uses the same health check (`/api/feed` within 15 s, log tail on failure), and ends with one line: `The Desk is live at http://localhost:4321 on main @ 1a2b3c4 "Subject"`.

git always runs with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_PARAMETERS` (and `GIT_CONFIG_COUNT/KEY_n/VALUE_n`, `GIT_NAMESPACE`, `GIT_PREFIX`) removed (`gitEnv()`). If deploy is ever started from a git hook, `git -C <live>` still means the live copy.

`--dry-run` runs only read-only git (`log`, `rev-parse`, `status --no-optional-locks`, `diff`, `worktree list`) and prints each step in the order above, with its exact command. It changes nothing, and it stops where the real run would refuse.

Packages are installed from `package.json` and the lockfile alone, so a lifecycle script in our own `package.json` (`prepare`, `postinstall`) would run without the source next to it. There are none today. Add one only with that in mind.

Between the checkout and the restart (a few seconds) the running server already serves the new `app/` files from disk. Harmless for now. If a story ever needs both halves to change at once, deploy into a fresh folder and swap the folder instead.

**To undo a bad deploy:** `git revert` the commit on main, then `npm run deploy`. Avoid checking out an old commit in the live copy by hand: `.deployed.json` would no longer match it.

### `service:install` and `service:status`

- `serviceConfig()` takes `runDir` (default: the live copy) instead of the old `repoRoot`. The plist is otherwise unchanged: same label, RunAtLoad, KeepAlive, ThrottleInterval 10, PATH, `DESK_HOME=~/agent-house`, `PORT=4321`, `DESK_LOG`, `DESK_SERVICE=1`, same log path.
- `install` refuses, changing nothing and calling no launchctl (so the running service is left alone), unless the live copy is fully deployed:
  - no `<live>/server/index.js`: "The live copy isn't there yet … run npm run deploy first".
  - no `<live>/node_modules` or no readable `.deployed.json`: "The live copy isn't fully deployed yet … Run npm run deploy until it gets past installing packages".

  The dry run says which at the top.
- `runCommand` takes `cwd`, `timeoutMs` and `env`, and says "(stopped after N s: it took too long)" when it times out.
- `status` shows `Runs from:` (the installed plist's WorkingDirectory) and `Deployed:` (that folder's `.deployed.json`). When the plist still points elsewhere, it says to run `service:install` (or `deploy` first, if there is no live copy).
- `service:restart` now says "Restarted with the code in ~/the-desk-live."
- The macOS-privacy hints stay, keyed on the folder the service runs from. With the live copy outside Documents they no longer appear.

### Server log

- Every line starts with the local time and offset: `2026-11-28T09:14:03-05:00 The Desk is running at ...`. `createLogger()` in `server/log-file.js` stamps each line of a multi-line message (validator reasons, stack traces). Node's own crash output (an uncaught exception) is still unstamped. launchd's next start line dates it.
- At start, in the live copy: `The Desk: this is main @ 1a2b3c4 "Subject", deployed <time>`.
- SIGTERM (launchd stop, logout, shutdown) or SIGINT (Ctrl+C): `The Desk is stopping (SIGTERM)`, close, exit 0. A second signal while stopping ends it at once. A reboot now reads as a "stopping" line followed by a "running at" line after login.

### Preview button (port 3000)

`.claude/launch.json` ran `npm run dev` from the main checkout, against Snow's real `~/agent-house`. It now runs `npm run preview`, which is `PORT=3000 DESK_HOME=.desk-preview node --watch server/index.js`. That folder is gitignored and starts empty (sample edition, no reads), so a preview tab can't overwrite Snow's saves. The configuration keeps the name `dev`, so the desktop app's button still finds it.

### Tests

- `test/deploy.test.js`: real git on small temp repos. Their git runs with every inherited `GIT_*` variable removed, plus `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so no hooks, no signing, and no hook-exported `GIT_DIR` pointing at the real repo.
  - npm, launchctl, lsof and the health check are fakes. The fake npm empties `node_modules` first, as npm 11 does.
  - Covers: the first deploy (service not moved, not installed, already moved; npm failing leaves no live copy); the happy path; lockfile changed (npm in staging before the checkout, old `node_modules` swapped out) or not; `node_modules` missing; no deploy recorded; already on main; uncommitted work and story branches never going live.
  - Refusals: a dirty live copy (nothing staged), a foreign folder or repo at the live path, running from the live copy, a live path in the work folder, no main, a commit with no lockfile.
  - Failures and leftovers: npm failing (live copy's commit, packages and record untouched, no restart) and the retry after it; a leftover staging folder removed, a foreign one left alone; the restart failing.
  - Also: git getting the cleaned environment, and dry runs that only read.
  - One test drives a stand-in `npm` shell script through the real `runCommand`: it must run in `<live>.staging`, never the work folder.
- `test/service.test.js`: the plist points at the live copy; install refuses without it, without `node_modules` or without a readable `.deployed.json` (no launchctl at all); an old plist from the work folder gets moved; status shows the folder and deployed commit. `runCommand` is tested for real: it runs in the given `cwd`, a `timeoutMs` stops a long child, and `env` is passed. Assertions check the actual work-folder path, not the word "Documents", so a `TMPDIR` containing "Documents" passes.
- `test/server.test.js` and `test/log-file.test.js`: timestamps (winter, summer, the local day, offsets east and on the half hour), every line stamped, the stopping line on SIGTERM and SIGINT with exit 0, the deployed line at start. `test/deployed.test.js`: reading and cleaning `.deployed.json`. `test/preview.test.js`: the preview script and `launch.json`.
- Scratch servers in this story used ports 4399–4404 with `DESK_HOME` under `.tmp-*/` (gitignored). Dry runs used a fake `HOME` outside the repo: deploy refuses a live path inside the checkout.

### One-time cutover (lead dev, with Snow's OK)

Snow's OK is needed because this reinstalls the always-on service. Expect about two seconds when 4321 doesn't answer. Her data in `~/agent-house` is untouched.

1. **Merge.** In `~/Documents/Projects/the-desk`, with `git status` clean and on `main`: `git merge --no-ff n1-live-copy`, then `npm test`. Until step 5 the service still runs from this folder, now on N1's code (`app/` is unchanged by N1, so 4321 looks the same).
2. **Look first:** `npm run deploy -- --dry-run`. It should plan `npm ci --omit=dev` in `/Users/snow/the-desk-live.staging`, then `git worktree add --detach /Users/snow/the-desk-live <sha>`, the swap, and `.deployed.json`. Then it stops because the service "still runs from /Users/snow/Documents/Projects/the-desk".
3. **Make the live copy:** `npm run deploy`. It installs the packages beside the live copy, makes `~/the-desk-live`, swaps them in and records the commit. Then it stops (exit 1 is expected here) with "Run npm run service:install once to move the service to the live copy." If npm fails, nothing is made. Fix it and run it again.
4. **Look first:** `npm run service:install -- --dry-run`. Check the top line names `/Users/snow/the-desk-live, main @ <sha>`, and that the plist's `WorkingDirectory` and `server/index.js` are inside `/Users/snow/the-desk-live`.
5. **Move the service:** `npm run service:install`. It boots out the old service, writes the new plist, starts it, and waits for `OK: The Desk is running at http://localhost:4321`.
6. **Check:**
   - `npm run service:status`: `Runs from: /Users/snow/the-desk-live`, `Deployed: main @ <sha> ...`, `Answers: yes`, and no "still runs from" warning.
   - `tail -n 3 ~/agent-house/logs/the-desk.log`: timestamped `running at` and `this is main @ <sha>` lines.
   - **The story's "done when"**, in a throwaway story worktree. Never switch branches in the main checkout: other sessions share it.
     ```
     cd ~/Documents/Projects/the-desk
     git worktree add -b n1-check ../the-desk-n1-check main
     cd ../the-desk-n1-check
     echo 'N1 check' > app/n1-check.txt
     git add app/n1-check.txt && git commit -m "N1 check (throwaway)"
     curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/n1-check.txt   # 404: 4321 doesn't serve it
     npm run service:status                                                         # Deployed: still main @ <same sha>
     cd ../the-desk
     git worktree remove ../the-desk-n1-check && git branch -D n1-check
     ```
   - `npm run deploy` once more: "already holds main", a restart, and `The Desk is live at http://localhost:4321 on main @ <sha> "<subject>"`. The log now shows `The Desk is stopping (SIGTERM)` followed by a new `running at`.
7. Nothing new to commit (`.deployed.json` lives only in the live copy). Update the board and `docs/status.md` as usual.

**Afterwards:** merge to main, then `npm run deploy`. That's the whole release. Don't delete `~/the-desk-live` by hand. If it ever has to go, run `npm run service:uninstall`, then `git worktree remove ~/the-desk-live`. If it was deleted anyway, `git worktree prune` before the next deploy.

**Rollback** (only if the cutover fails, with Snow's OK). Neither way switches branches in the main checkout.

- **Quick: run the pre-N1 code from its own folder.** Sprint 1's `service:install` points the service at whatever folder it runs from, so give it a detached worktree of the commit before the merge, outside `~/Documents` (not `/tmp`, which macOS empties on restart):
  ```
  cd ~/Documents/Projects/the-desk
  git worktree add --detach ~/the-desk-rollback <main before the merge>
  cd ~/the-desk-rollback && npm ci --omit=dev && npm run service:install
  npm run service:status        # Running: yes, and it answers on 4321
  ```
  `main` keeps N1. To return to the live copy after a fix: merge it, `npm run deploy`, `npm run service:install` (from the work folder), then `git worktree remove ~/the-desk-rollback`.
- **Withdraw N1 from main:** on `main` in the work folder, `git revert -m 1 <merge sha>`, then `npm run service:install` (the Sprint 1 version runs the service from the work folder again, with the old branch-switching problem). To bring N1 back later, revert that revert and redo the cutover.
- In both cases `~/the-desk-live` stays but is unused. Remove it with `git worktree remove ~/the-desk-live` once it's no longer needed.
