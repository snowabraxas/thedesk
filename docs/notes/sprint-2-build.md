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
   - A staging folder left by an interrupted run is removed, but only if it holds nothing beyond `package.json`, `package-lock.json`, `node_modules` and `node_modules.old`. Otherwise it refuses and leaves the folder alone. If the run was cut off between the two renames of step 4 (the live copy has no `node_modules`, the staging folder has `node_modules.old`), those packages go back into the live copy first.
   - It reads main's sha and subject. It notes, without stopping, when the folder you ran it from is on another branch or has uncommitted changes. Neither is deployed.
   - If the live copy exists, it must be a worktree of this repo (same `--git-common-dir`, top level is the folder itself), and `git status --porcelain -- . ':!/.deployed.json*'` must be empty. `.deployed.json` and its temp file are deploy's own, and an older commit's `.gitignore` may not list them, so a hand checkout to a pre-N1 commit doesn't block the repair. A dirty copy is refused: it lists up to 10 lines and suggests `git -C <live> stash --include-untracked`.
   - Leftover `<live>/.deployed.json.tmp-*` files from an interrupted run are removed. If tidying up after an interrupted run fails, deploy stops with a plain message and changes nothing.
2. **Packages first, outside the live copy.** This step runs only when one of these holds:
   - it's a new copy;
   - `node_modules` is missing;
   - `node_modules` is incomplete (a name in the live `package.json` "dependencies" has no `node_modules/<name>/package.json`, the same test the install guard uses);
   - no deploy is recorded;
   - `git diff --quiet <last deployed> <new> -- package-lock.json` says the lockfile changed. The base is the sha in `.deployed.json`: the last deploy that went all the way through, whose packages are the ones in the live copy;
   - or the live copy's server doesn't load (`loadCheck()`, the same check as the install guard): every file is there but, say, ajv can't find `fast-deep-equal`.

   When it runs:
   - `git show <sha>:package.json` and `<sha>:package-lock.json` are written into `<live>.staging`, and `npm ci --omit=dev` runs there. It uses the npm next to Homebrew node, gets the same cleaned environment as git, and has a hard 10-minute limit (see `runCommand`). On failure deploy shows npm's `npm error code` line, the cause lines after it and the log path, not the usage text.
   - npm 11 empties `node_modules` before it installs, so it never runs in the live copy. If it fails, or the commit has no lockfile, deploy removes the staging folder and stops. The live copy's code, packages and `.deployed.json` are exactly as they were, so a launchd restart, a login or a reboot still runs the old, working version.
3. **Move the live copy.** No live copy yet: `git -C <repo> worktree add --detach <live> <sha>`. Otherwise `git -C <live> checkout --quiet --detach <sha>`, or nothing if it's already there. git can fail after it has moved HEAD (a post-checkout hook that exits 1), so on failure deploy asks where HEAD is:
   - at the target: it carries on with the swap and shows git's message as a warning;
   - anywhere other than the old commit: it checks the old commit out again (judged by HEAD afterwards, not by git's exit code);
   - then it removes the staging folder and stops, showing git's `fatal:` line.
4. **Swap the packages in.** Two renames on the same disk: `<live>/node_modules` to `<live>.staging/node_modules.old`, then `<live>.staging/node_modules` to `<live>/node_modules`. Then the staging folder is removed.
   - Whether there is an old `node_modules` is checked with `lstat`, so a symlink (dangling or not) is moved aside too. `.gitignore` says `node_modules` without the trailing slash, so such a link doesn't make the live copy look dirty.
   - The old copy goes into the staging folder, not the live copy, so an interrupted swap never leaves untracked files in the live copy.
   - If the second rename fails, deploy puts the old `node_modules` back, checks the old commit out again and says so. No restart, no new `.deployed.json`.
   - If the staging folder can't be removed after a good swap, deploy warns, then still records and restarts. The next run tidies the folder away.
5. **Record it.** `.deployed.json` is written (temp file and rename) only now, so it only ever names a commit whose packages are in. A deploy that changed nothing (same commit, no install) leaves it as it was, deploy time included.
6. **Restart.** It reads the installed plist's `WorkingDirectory`. Not installed, or not the live copy: it stops (exit 1) and says to run `npm run service:install` once. With a fake HOME (see "The real launchd service is shared" below) it stops before the restart with that reason; the live copy is ready but nothing touches launchd. Otherwise it calls `restart()` from `scripts/service.js` (`launchctl kickstart -k`, or bootstrap if it was stopped), uses the same health check (`/api/feed` within 15 s, log tail on failure), and ends with one line: `The Desk is live at http://localhost:4321 on main @ 1a2b3c4 "Subject"`.

git always runs with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG_PARAMETERS` (and `GIT_CONFIG_COUNT/KEY_n/VALUE_n`, `GIT_NAMESPACE`, `GIT_PREFIX`) removed (`gitEnv()`). If deploy is ever started from a git hook, `git -C <live>` still means the live copy.

`--dry-run` runs only read-only git (`log`, `rev-parse`, `status --no-optional-locks`, `diff`, `worktree list`) and prints each step in the order above, with its exact command. It changes nothing, and it stops where the real run would refuse.

Packages are installed from `package.json` and the lockfile alone, so a lifecycle script in our own `package.json` (`prepare`, `postinstall`) would run without the source next to it. There are none today. Add one only with that in mind.

Between the checkout and the restart (a few seconds) the running server already serves the new `app/` files from disk. Harmless for now. If a story ever needs both halves to change at once, deploy into a fresh folder and swap the folder instead.

**To undo a bad deploy:** `git revert` the commit on main, then `npm run deploy`. Avoid checking out an old commit in the live copy by hand: `.deployed.json` would no longer match it.

### `service:install` and `service:status`

- `serviceConfig()` takes `runDir` (default: the live copy) instead of the old `repoRoot`. The plist is otherwise unchanged: same label, RunAtLoad, KeepAlive, ThrottleInterval 10, PATH, `DESK_HOME=~/agent-house`, `PORT=4321`, `DESK_LOG`, `DESK_SERVICE=1`, same log path.
- `install` refuses, changing nothing and calling no launchctl (so the running service is left alone), unless the live copy is fully deployed (`liveCopyState()`):
  - no `<live>/server/index.js`: "The live copy isn't there yet … run npm run deploy first".
  - Otherwise, any of these: no `node_modules`; a package from the live `package.json` "dependencies" missing (`node_modules is incomplete (no ajv)`); no readable `package.json` or `.deployed.json`; `git -C <live> rev-parse HEAD` (with `gitEnv`) not equal to the sha in `.deployed.json` ("it holds 1a2b3c4, but the last deploy that finished was main @ 9f8e7d6 …"); changes of its own (the same `git status` as deploy, e.g. `D server/feed.js`).
  - When all of that holds, the load check must pass. A child `node --input-type=module -e …`, run in the live copy, imports `server/index.js` and exits. Importing it doesn't start the server: it only listens when it is the program node was started with, and `test/server.test.js` holds it to that. This catches a missing package of a package (ajv without `fast-deep-equal`) or a module that throws: "its server doesn't load: Error: Cannot find module 'fast-deep-equal'".
  - The message is "The live copy isn't fully deployed yet (<dir>: <problems>), so nothing was changed. Run npm run deploy until it finishes (it repairs this, or says what to do)". Deploy reinstalls on the same package and load checks, so it repairs whatever the guard refuses, except changes of its own, which deploy refuses with the stash hint.

  The dry run says which at the top. It runs only read-only commands: `git rev-parse`, `git status` and the load check.
- `runCommand` (spawn-based) takes `cwd`, `timeoutMs`, `graceMs` and `env`.
  - The command runs in its own process group (`detached: true`). Every stop goes to the whole group (`process.kill(-pid, …)`), so nothing it started survives a timeout.
  - Because the group no longer gets the terminal's Ctrl+C, a SIGINT or SIGTERM to the script passes SIGTERM on to the group, then stops the script the usual way.
  - The limit is hard: SIGTERM at `timeoutMs`, then SIGKILL `graceMs` (10 s) later, because npm ignores SIGTERM on a hung registry connection. It counts as timed out only if the command was still running at the deadline ("(stopped after N s: it took too long)").
  - Once the command exits, its output gets a drain of at most `min(graceMs, 2 s)`. Something it left running may hold the pipes open, and that doesn't change the result: the real exit code stands.
  - Output keeps its first and last 1 MB (`outputKeeper`), so npm's error lines at the end survive.
- `gitEnv()` and `GIT` now live in `scripts/service.js` (deploy re-exports them), so the guard and deploy share them.

### The real launchd service is shared

launchd's label `local.thedesk.server` in `gui/<uid>` is the same whatever HOME says. A run with a fake HOME that reaches the real `/bin/launchctl` acts on Snow's live service: on 27 Nov a review run restarted it (runs = 2). So:
- `launchdRefusal()` names a reason when HOME isn't the account's real home (`os.userInfo().homedir`), when the config's home isn't, or when `DESK_LIVE_DIR` or the live copy sits outside the real home.
- `realDeps().run` is wrapped in `guardLaunchctl()`. Whenever there is such a reason, it refuses every launchctl verb that changes state (`bootstrap`, `bootout`, `kickstart`, `enable`, `disable`, `kill`, `load`, `unload`, `remove`) with "HOME (…) is not your real home folder (…), so I won't touch the real launchd service (its name is shared). Use --dry-run or the test hooks." `print` and `print-disabled` still run.
- `service.js` `main()` refuses `install` (not `--dry-run`), `uninstall`, `start`, `stop` and `restart` up front for the same reasons. `deploy` stops before its restart.
- **Rule for tests and fake-HOME runs: inject the runner** (`deps.run`) and the rest of `deps`. Never hand `realDeps()` to code that may reach launchctl. The tests do this throughout. The only test that touches `realDeps().run` swaps HOME and points it at a `launchctl` path that doesn't exist, so even a broken guard could only fail with ENOENT.
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
  - Also: git and npm getting the cleaned environment, and dry runs that only read.
  - Round three: `node_modules` incomplete (repaired); a symlinked `node_modules` (dangling or not) moved aside; the second rename failing (old packages and commit put back); a leftover `node_modules.old` restored before cleanup (and the dry run judging those packages); npm's code and cause lines shown, not usage; git's `fatal:` line shown when `worktree add` fails on a hand-deleted live copy; an unchanged deploy keeping `.deployed.json` byte for byte; the repo's `.gitignore` rules.
  - One test drives a stand-in `npm` shell script through the real `runCommand`: it must run in `<live>.staging`, never the work folder.
- Closing round: `runCommand` with a background grandchild (done in 0.5 s, exit 0), the hard stop reaching the whole group (an orphan `sleep` that ignores SIGTERM is gone), Ctrl+C on the script stopping its command, long output keeping start and end. Plus `launchdRefusal` and `guardLaunchctl` cases, the guarded real runner under a fake HOME, `main()` refusing state-changing commands, the guard on a dirty copy and a server that doesn't load, `loadCheck` for real (a missing `fast-deep-equal`, and this repo), and deploy on:
  - a post-checkout hook that fails after the move;
  - a checkout that lands elsewhere, or doesn't move;
  - a server that doesn't load (repaired);
  - a pre-N1 `.gitignore`;
  - leftover temp files;
  - staging cleanup failing after a swap, or at the start;
  - a fake HOME at restart.
- `test/service.test.js`: the plist points at the live copy; install refuses without it, without `node_modules` or without a readable `.deployed.json` (no launchctl at all); an old plist from the work folder gets moved; status shows the folder and deployed commit. `runCommand` is tested for real: it runs in the given `cwd`, a `timeoutMs` stops a long child, a child that ignores SIGTERM is SIGKILLed after the grace period (and is gone afterwards), and `env` is passed. The guard is tested on every half-deployed state: no or incomplete `node_modules`, no `package.json`, no or broken `.deployed.json`, a stale `.deployed.json` (HEAD differs) and an unreadable HEAD. Assertions check the actual work-folder path, not the word "Documents", so a `TMPDIR` containing "Documents" passes.
- `test/server.test.js` and `test/log-file.test.js`: timestamps (winter, summer, the local day, offsets east and on the half hour), every line stamped, the stopping line on SIGTERM and SIGINT with exit 0, the deployed line at start. `test/deployed.test.js`: reading and cleaning `.deployed.json`. `test/preview.test.js`: the preview script and `launch.json`.
- Scratch servers in this story used ports 4399–4404 with `DESK_HOME` under `.tmp-*/` (gitignored). Dry runs used a fake `HOME` outside the repo: deploy refuses a live path inside the checkout.

### One-time cutover (lead dev, with Snow's OK)

Snow's OK is needed because this reinstalls the always-on service. Expect about two seconds when 4321 doesn't answer. Her data in `~/agent-house` is untouched.

1. **Record the rollback point, then merge.** In `~/Documents/Projects/the-desk`, with `git status` clean and on `main`:
   ```
   # main before N1, kept outside the repo for a rollback; only while N1 isn't merged yet
   git merge-base --is-ancestor n1-live-copy main || git rev-parse main > ~/the-desk-pre-n1.sha
   git merge --no-ff --no-edit n1-live-copy && npm test
   ```
   Until step 5 the service still runs from this folder, now on N1's code (`app/` is unchanged by N1, so 4321 looks the same).
2. **Look first:** `npm run deploy -- --dry-run`. It should plan `npm ci --omit=dev` in `/Users/snow/the-desk-live.staging`, then `git worktree add --detach /Users/snow/the-desk-live <sha>`, the swap, and `.deployed.json`. Then it stops because the service "still runs from /Users/snow/Documents/Projects/the-desk".
3. **Make the live copy:** `npm run deploy`. It installs the packages beside the live copy, makes `~/the-desk-live`, swaps them in and records the commit. Then it stops (exit 1 is expected here) with "Run npm run service:install once to move the service to the live copy." If npm fails, nothing is made. Fix it and run it again.
4. **Look first:** `npm run service:install -- --dry-run`. Check that the line "The service will run The Desk from the live copy: …" names `/Users/snow/the-desk-live, main @ <sha>`, and that the plist's `WorkingDirectory` and `server/index.js` are inside `/Users/snow/the-desk-live`.
5. **Move the service:** `npm run service:install`. It writes the new plist, boots out the old service, starts the new one, and waits for `OK: The Desk is running at http://localhost:4321`.
6. **Check:**
   - `npm run service:status`: `Runs from: /Users/snow/the-desk-live`, `Deployed: main @ <sha> ...`, `Answers: yes`, and no "still runs from" warning.
   - `grep -E 'running at|this is main' ~/agent-house/logs/the-desk.log | tail -n 2`: timestamped `running at` and `this is main @ <sha>` lines.
   - **The story's "done when", part 1: work in the work folder no longer reaches 4321.** Under Sprint 1 this check gives 200, because the service served `app/` straight from this folder. After N1 it must give 404. The file is never committed; delete it straight away:
     ```
     cd ~/Documents/Projects/the-desk
     echo 'N1 check' > app/n1-check.txt
     curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/n1-check.txt   # must be 404 (Sprint 1: 200)
     rm app/n1-check.txt && git status --short                                     # nothing left over
     npm run service:status                         # Runs from: /Users/snow/the-desk-live, Deployed: main @ <sha>
     PID=$(lsof -nP -iTCP:4321 -sTCP:LISTEN -t)
     lsof -a -p "$PID" -d cwd -Fn | grep '^n'       # n/Users/snow/the-desk-live
     ```
   - **Part 2: `npm run deploy` brings it up to date.** Commit the board update ("Board: N1 done") on `main` as usual, then `npm run deploy`. It should say "Moving the live copy from <old> to <new>…", restart, and end with `The Desk is live at http://localhost:4321 on main @ <new sha> "Board: N1 done"`. `service:status` then shows that sha. The log shows `The Desk is stopping (SIGTERM)` followed by a new `running at` and `this is main @ <new sha>`.
7. Nothing else to commit (`.deployed.json` lives only in the live copy). Update `docs/status.md` as usual, then `npm run deploy` again if you like (a deploy that changes nothing keeps `.deployed.json` as it is). Keep `~/the-desk-pre-n1.sha` until N1 has run a few days, then delete it.

**Afterwards:** merge to main, then `npm run deploy`. That's the whole release. Don't delete `~/the-desk-live` by hand. If it ever has to go, run `npm run service:uninstall`, then `git worktree remove ~/the-desk-live`. If it was deleted anyway, `git worktree prune` before the next deploy.

**Rollback** (only if the cutover fails, with Snow's OK). Neither way switches branches in the main checkout.

- **The rollback point** is main before the N1 merge, in `~/the-desk-pre-n1.sha` (step 1). If that file is gone, use the merge's first parent: `git rev-parse "$(git log --merges --first-parent --grep='n1-live-copy' -1 --format=%H main)^1" > ~/the-desk-pre-n1.sha`. Don't use a later sha: anything after the merge contains N1, and its install would just put the service back on the live copy.
- **Quick: run the pre-N1 code from its own folder.** Sprint 1's `service:install` points the service at whatever folder it runs from, so give it a detached worktree of that commit, outside `~/Documents` (not `/tmp`, which macOS empties on restart). One chained block, so any failed check stops it:
  ```
  cd ~/Documents/Projects/the-desk && PRE=$(cat ~/the-desk-pre-n1.sha) && git worktree add --detach ~/the-desk-rollback "$PRE" && test -f ~/the-desk-rollback/server/index.js && test ! -e ~/the-desk-rollback/scripts/deploy.js && cd ~/the-desk-rollback && npm ci --omit=dev && npm run service:install
  ```
  (`test ! -e …/scripts/deploy.js` proves it is pre-N1 code: deploy.js only exists with N1.) Check:
  - `npm run service:status` says it runs and answers. It must NOT show `Runs from: /Users/snow/the-desk-live`: Sprint 1's status has no "Runs from" line at all.
  - `plutil -extract WorkingDirectory raw ~/Library/LaunchAgents/local.thedesk.server.plist` prints `/Users/snow/the-desk-rollback`.
  - `lsof -a -p "$(lsof -nP -iTCP:4321 -sTCP:LISTEN -t)" -d cwd -Fn` shows `n/Users/snow/the-desk-rollback`.

  `main` keeps N1. To return to the live copy after a fix: merge it, then redo the cutover from step 2 (keeping `~/the-desk-pre-n1.sha`), and finally `git worktree remove ~/the-desk-rollback`.
- **Withdraw N1 from main:** on `main` in the work folder, `git revert --no-edit -m 1 <merge sha>`, then `npm run service:install` (the Sprint 1 version runs the service from the work folder again, with the old branch-switching problem). The same checks apply, with the work folder in place of `~/the-desk-rollback`. To bring N1 back later, `git revert --no-edit <that revert's sha>`, then redo the cutover from step 2, keeping `~/the-desk-pre-n1.sha`.
- In both cases `~/the-desk-live` stays but is unused. Remove it with `git worktree remove ~/the-desk-live` once it's no longer needed.

## N2. News contract: schemas and validator

**Files.** `data/schema/news.schema.json` (the morning edition) and `data/schema/breaking.schema.json` (one breaking story), JSON Schema 2020-12. `server/news-schema.js` is the validator, shared by `npm run validate-news` now and by the server from N3. `server/schema-common.js` holds what Product Feed and News share (ajv setup, error wording, file reading, date and link checks); `server/feed-schema.js` now uses it, with Product Feed's messages unchanged except for the stricter link rules from the review (below). Fixtures for tests and N3: `test/fixtures/news/news.json` (3 stories, 2 on the shelf, every region and kind) and `test/fixtures/news/breaking.json`. Paths: `newsDir`, `newsPath`, `breakingPath` in `server/config.js`.

**The schemas.**
- Edition: `desk` is `"news"`, `edition` is `YYYY-MM-DD`, `stories` 0 to 3, `more` 0 to 7. `desk`, `edition` and `stories` are required; `note` (max 300) and `more` are optional and mean `""` and `[]` when absent, the same way Product Feed treats `note`.
- Story (`$defs/story`): `id` (`^[A-Za-z0-9_-]{1,40}$`, safe as a state key or DOM id), `rank` (integer from 1), `headline` 160, `summary` 700, `why` 300, `skeptic` 500 (each must have a non-space character, pattern `\S`), `date` (`""` or `YYYY-MM-DD`), `region` and `kind` enums, `sources` 2 to 8 of `{ name (max 80, not blank), url (^https://) }`. Every field is required, `rank` included, so a breaking story really is "the same shape".
- Breaking: `"$ref": "news.schema.json#/$defs/story"` plus a required `at`. The validator registers the edition schema with ajv first so the reference resolves. `at` is ISO 8601 with a timezone (`Z` or `±HH:MM`); seconds and fractions are optional. ajv-formats isn't installed (strict mode refuses `format` without it), so `at` uses a pattern, and `schema-common.js` exports the same regex (`DATE_TIME_PARTS`); a test keeps them identical.
- `additionalProperties: true`, as in `feed.schema.json`: an agent that adds a field (a tag, an author on a source) shouldn't take the desk down for the day, and the page only ever renders the fields it knows, as escaped text. It's written out on the edition, story, source and breaking objects so the agent reading the schema sees it.

**Rules on top of the schema** (in `news-schema.js`, checked only on values that passed their pattern, so each value gets one line):
- fewer than 3 `stories` needs a `note` that isn't blank: `note: must say why there are fewer than 3 stories (stories has 2)`. 0 stories with a note is allowed.
- ids are unique across `stories` and `more`, ranks unique across the whole edition: `more[1].id: duplicate id "s2" (also used by stories[1])`.
- `edition` and story `date` are real calendar days; `at` is a real moment (hours 0-23, minutes and seconds 0-59, offset at most 14:59).
- links are whole `https://` links (they parse, name a site, no spaces, backslashes or hidden characters) that open the site they show, with no user name or password before the site name, and a story never lists the same page twice (see the review fixes below). `https://user@host/`, `https://:pw@host/` and even an empty `https://@host/` are refused; an `@` later in the link (`/@snow`, `?by=a@b`) is fine. The message shows the link as `https://***@host/...`, so a password never reaches the terminal or `the-desk.log`.
- Error wording comes from `schema-common.js`: lists say what they hold (`stories[1].sources: needs at least 2 sources (has 1)`, `stories: can have at most 3 stories (has 4); the top 3 go in stories, up to 7 more in more`), enums list the allowed values, and untrusted values are quoted with controls and invisible characters escaped and cut at 60 characters. At most 100 problems are listed per file.

**Product Feed follow-up from Sprint 1.** The same user-name/password rule now applies to Product Feed article links (`isHttpsLink` refuses them too). Tests in `test/feed-schema.test.js`. The front end's own `safeUrl` in `app/lib.js` still allows user info; the server never serves such a link now, but N4 could tighten `safeUrl` to match for defence in depth.

**`sample`.** Same as Product Feed: only The Desk may mark an edition as a sample. The schema doesn't fail a file because of a `sample` key (extra keys are allowed); `checkNewsFile`, `checkBreakingFile` and `checkNewsDeskFile` return a valid file with `sample` removed (`withoutSample` in `schema-common.js`). N3's loader should use those results, then add `sample: true` only to its own fallback (N7's sample edition).

**CLI.** `npm run validate-news [file ...]`, in the style of `validate-feed`. `breaking.json` is checked against the breaking schema, and its failure header says `(checked as a breaking story)`; `news.json`, or any file in an `editions/` folder, is an edition; any other file is a breaking story unless it has a `stories` key. With no file it checks `$DESK_HOME/desks/news/news.json`, and `breaking.json` there when it exists. One file: prints `valid` (exit 0) or `invalid: <path>` and each reason (exit 1). Several files: `valid: <path>` per good file, and exit 1 if any failed. Relative paths are taken from where the command was typed, even through `npm run` (INIT_CWD). Up to 20 reasons per file are shown, then "…and N more" ("at least N" when the validator stopped at 100). An unknown option prints the usage and exits 1. It sets `process.exitCode` rather than calling `process.exit()`, so a long report always finishes writing to a pipe. `npm run validate-feed` is unchanged.

**Review fixes, round 1 (after the tester passed N2).** Each has tests. Items 4, 6 and 7 were refined in round 2 below.
1. File kind: the name decides first. `breaking.json` is a breaking story; `news.json`, or any file whose folder is `editions/`, is an edition; any other file is a breaking story unless it has a `stories` key. `at` no longer decides, so the CLI and `checkNewsFile` (what the server uses) agree on an edition with an extra `at`, and a breaking draft missing `at` is told `breaking: missing required field "at"`.
2. Repeated links: a story may not list the same page twice, compared as `new URL(u).href` without the `#fragment` (so capitals in the site, `:443` or a bare `/` don't make a new page): `stories[0].sources[1].url: same link as sources[0]; a story needs 2 different sources`. Only links that passed the link checks are compared, so a bad link gets one line.
3. Sources cap: `maxItems` stays 8; the brief (step 7) and the schema description now both say at least 2, at most 8, keep the 8 strongest, and the too-many message ends "keep the 8 strongest". A test reads both files.
4. Passwords: user info is checked before anything else about a link. `hideUserInfo` reads a link the way the WHATWG parser does (drops tabs and newlines, skips any run of `/` and `\` after the scheme, any scheme or none), in linear time, and every quoted link goes through it, including the schema's `^https://` message (any field named `url`). Empty user info like `https:///@host` is refused.
5. Runaway files: `schemaErrors` de-duplicates with a Set and stops at 100 lines, and both validators return at most 100 (`MAX_ERRORS`). Before ajv runs, any list over 50 items (`GUARD_ITEMS`: stories, more, a story's sources, breaking sources, Product Feed articles and themes) is refused with one line, and nothing else is checked. `more` with 100,000 `{}` now takes under a millisecond (3,000 took 845 ms before). So the guard matches the contract, `feed.schema.json` now caps `themes` at 50 (the sample has 6). A single article's `themes` list isn't guarded: checking it is linear (250,000 entries take about 50 ms) and the output is capped.
6. Lookalike sites: the site as written must be plain ASCII letters, digits, dots and dashes (`xn--` punycode is fine), equal (ignoring case) to `new URL(u).hostname`, and not an IP address (v4 or v6). That refuses slash lookalikes (U+2215, U+2044), fullwidth and mixed-script names, percent-encoding, and numeric forms like `0x7f.1` or `2130706433`, with the message `must name its site in plain letters, digits, dots and dashes (xn-- for other alphabets), not as an IP address`. This tightens Product Feed too: `https://bücher.de/` is now refused (write `https://xn--bcher-kva.de/`). A backslash anywhere in a link is refused (browsers read it as `/`).
7. Hidden characters: `show()` and `plain()` escape C1 controls, DEL and the invisible or direction-changing characters (U+061C, U+200B to U+200F, U+2028 to U+202E, U+2060 to U+2069, U+FEFF), and links containing any of them are refused.
8. `withoutSample` lives only in `schema-common.js`; `server/feed.js` imports it.

**Review fixes, round 2 (after the re-check).** Each has tests.
1. Hiding passwords anywhere: `show()` now hides user info in every quoted value, anywhere in it. The value is split at `/`, `?` and `#` (never at `\`, which can be part of a user name, as in `ssh://git:hunt\er2@host`), and in each piece everything before its last `@` becomes `***`. That covers a link after invisible characters, `Source: https://u:p@x.com`, a second link, and any field. I split on fewer characters than the review suggested (not on spaces, quotes or brackets), because the URL parser keeps those inside user info (`https://user:p w@host`), so splitting there could print part of a password. Over-hiding inside an error message is fine (`?by=a@b` shows as `?***@b`). `hasUserInfo` still uses the exact URL-parser reading to decide whether a link is refused. V8's quoted snippet is dropped from "not valid JSON (...)" messages (`not valid JSON (Unexpected token 'h')`).
2. Article themes: `feed.schema.json` caps `articles[].themes` at 10 with `uniqueItems`, and the guard refuses an over-50 list before ajv runs (250,000 themes: instant). A repeated theme reads `articles[1].themes: lists "evals" twice (items 0 and 2)`.
3. Invisible characters by Unicode property: escaping, the link check and the blank-text check use `[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]` (tag characters, soft hyphen, invisible operators, variation selectors, Hangul fillers). Escapes go by code point (`\u00ad`, `\u{e0041}`). `cut()` counts code points, so no lone surrogates. Both CLIs print paths through `plain()`.
4. `linkKey` keeps route fragments (`#/...`, `#!...`), and drops `utm_*` parameters, an empty `?`, and a trailing dot on the site. Other parameters keep their order.
5. `localhost`, `*.localhost` and one-word site names (no dot) are refused with the site message, which now reads `must name a public site like example.com in plain letters, digits, dots, dashes or underscores (xn-- for other alphabets), not localhost or an IP address`.
6. Underscores in site names (`my_bucket.s3.amazonaws.com`) and an empty port (`example.com:/x`) are accepted; the written name must still equal `url.hostname`, and the IP check still runs.
7. A backslash or hidden character in a link gets its own message: `must not contain a backslash or hidden characters`. Spaces keep the "whole link ... no spaces" message.
8. The 51+ cutoff lines carry the same hint as the normal messages: `(keep the 8 strongest)` for sources, `(leave the weakest out)` for more, `(the top 3 go in stories, up to 7 more in more)` for stories.
9. A News text field (headline, summary, why, skeptic, source name) made only of invisible characters counts as empty: the schema pattern is now `VISIBLE_CHAR_PATTERN` from `schema-common.js`, and a test keeps them identical. A note made only of invisible characters doesn't explain fewer than 3 stories.
10. Brief step 7 says what `id`, `rank` (1 to 10) and `note` hold; the schema now caps `rank` at 10 to match.

**Review fixes, round 3 (closing check).** Each has tests.
1. A password with a raw `/`, `?` or `#` is hidden too: `hideUserInfo` now hides everything from just after the first `//` (or from the start, when no `//` comes before it) to the last `@` in the value. So `https://AKIA...:wJal.../K7MD.../bPx...@bucket.example.com/report` prints as `https://***@bucket.example.com/report`, and `admin:p/w@corp` as `***@corp`. That replaces round 2's split-into-pieces rule. It over-hides more (`https://example.com/@snow` shows as `https://***@snow`), which is fine in a message, and it's linear. Detection is unchanged: to the URL parser such a link isn't user info (a raw `/` ends the site part), so it fails as a broken link, still with the password hidden.
2. Blank-looking text counts as empty: `VISIBLE_CHAR_PATTERN` (identical in the schema and the code) also excludes `\p{M}` (combining marks alone, U+16FE4), `\p{Co}` (private use), U+2800 braille blank, U+1D159 null notehead and the Hangul fillers U+3164, U+FFA0, U+115F, U+1160.
3. `state-store.js` builds its "not valid JSON" message with `jsonErrorText` (shared with `readJsonFile`: no quoted snippet, user info hidden, escaped), so a corrupt `state.json` can't put control bytes or a password in `the-desk.log`. The raw BOM in its regex is now an escape.
4. `validate-news` prints an unknown option through `plain()`.
5. The hidden-character link message ends `(percent-encode them, e.g. %E2%80%8C)`.
6. `validateFeed` on a file whose `desk` is `"news"` starts with `this looks like a News file: run npm run validate-news`, and, the other way round, `validateNews` on a `"product-feed"` file starts with `this looks like a Product Feed file: run npm run validate-feed`.

**Worth knowing (for S5).** These review rounds tightened the Product Feed contract too, so the Product Feed agent's brief should say:
- Article links: no user name or password; the site written in plain ASCII (other alphabets as `xn--` punycode); no IP addresses, `localhost` or one-word sites; no backslashes, spaces or hidden characters (percent-encode them).
- `themes` at most 50; each article's `themes` at most 10, each listed once.
- The sample feed (`prototype/feed.json`) passes all of these.

**For N3 and later.**
- Story ids repeat every day (`s1` each morning), so N3's read state should key stories by edition and id (for example `2026-12-07/s1`), and a breaking story by its `at`.
- N3 decides "breaking is from today" from `at`; every accepted form parses with `Date.parse`.
- `agents/news/AGENTS.md` step 9 and the breaking section now give the real command. N9 should pin the folder the agent runs it from (likely N1's main-only live copy).

## N3. News server routes

**Routes** (all JSON, `Cache-Control: no-store`, refused with 403 unless the Host is `localhost:<port>` or `127.0.0.1:<port>`, like every route):

| Route | Answer |
| --- | --- |
| `GET /api/news` | The morning edition. `X-Desk-News-Source`: `live`, `last-good`, `edition:<YYYY-MM-DD.json>` or `sample`. HEAD too; other methods 405. |
| `GET /api/breaking` | `{"breaking": <story with at>}` when `desks/news/breaking.json` is valid and its `at` falls on today in Toronto, else `{"breaking": null}`. Never 404 or 500 for a missing or broken file. |
| `GET` / `PUT /api/news/state` | Snow's News state in `desks/news/state.json`. |
| `GET /api/feed`, `GET` / `PUT /api/state` | Product Feed, unchanged (`X-Desk-Feed-Source` keeps its values). |

**Fallback order, both desks** (`server/edition-loader.js`, used by `feed.js` and `news.js`):
1. `live`: the agent's `news.json` / `feed.json`, when it passes the contract (`checkNewsFile` / `checkFeedFile`).
2. `last-good`: the last valid live file this server served. In memory, and on disk as `last-good.json` next to the live file. After a restart it's read from disk and checked against the contract again; a damaged one is logged once per change and skipped.
3. `edition:<file>`: the newest valid `editions/YYYY-MM-DD.json`, by the date in the name. Other names (`latest.json`, `.bak`, a folder) are ignored; invalid files are logged once per change and skipped. Only the newest 60 dated names are looked at (`MAX_EDITION_FILES`, two months of mornings), with one info line while there are more. **It wins over last-good when its `edition` date is later** (the `edition` inside, compared with last-good's), so an old `last-good.json` never hides a newer edition the agent archived; on the same date, last-good (what Snow was shown) stays.
4. `sample`: News `data/samples/news.sample.json`, Product Feed `prototype/feed.json`, with `"sample": true` added by the server. Every agent file (live, last-good, editions, breaking) comes back without a `sample` key.

As in Sprint 1, a file is re-read only when its stat changes, and each change is logged once (an invalid live file names what is shown instead). Log lines quote agent values only through the `schema-common.js` helpers. While the live file is broken, each request also lists `editions/` (one readdir plus at most 60 stats), since a newer archived edition can now replace last-good.

**Files The Desk writes into `desks/news/`** (and the same two into `desks/product-feed/`):
- `last-good.json`: a byte-for-byte copy of the live file as it was read and checked (`readJsonFile` now returns the bytes; `checkNewsFile` and `checkFeedFile` pass them through on a valid file). So it's exactly as big as a file that passed the 1 MB limit, and keeps the agent's formatting (BOM, tabs, CRLF). Any `sample` key in it is dropped again when it's read back. Written whenever a valid live file is served and `last-good.json` doesn't already hold those exact bytes. That covers a new edition and also a `last-good.json` deleted or damaged while the live file stayed the same; a request costs one extra stat. Atomic (temp file `.last-good.json.<random>.tmp` in the same folder, fsync, rename, folder fsync: `server/atomic-file.js`, shared with the state store), one write at a time, mode 0600. A failed write is logged once per change (`couldn't keep a copy of the <date> edition in .../last-good.json (ENOSPC)`) and the live edition is still served. The sample is never written there.
- `state.json`: on `PUT /api/news/state`.
- Never `news.json`, `breaking.json` or `editions/`: those are the agent's. N9's brief could say "leave `last-good.json` and `state.json` alone".

This closes the Sprint 1 follow-up: a restart with a bad `feed.json` and no `editions/` now shows the last good edition, not the sample.

**Breaking: "today in Toronto".** `Date.parse(at)` (every form the contract accepts parses), then the calendar day of that moment in `America/Toronto` (`Intl.DateTimeFormat`, so the machine's `TZ` doesn't matter; a test runs it under UTC, Asia/Tokyo, Pacific/Kiritimati and Pacific/Pago_Pago), compared with today's Toronto day. So `2026-12-08T01:30:00+09:00` is today on 7 Dec in Toronto, `2026-12-07T02:00:00Z` is yesterday evening there, and anything dated tomorrow or later is not shown. Missing, old or future files are silent; an invalid one is logged once per change. Yesterday's story stops showing at Toronto midnight without the file changing. `createServer({ now })` sets the clock for tests.

**State** (`server/state-store.js`). `createStateStore(deskHome, desk)` now takes the desk name and saves to `desks/<desk>/state.json`; Product Feed and News share the same code (1 MB cap, 415 unless `application/json`, 400 for a non-object or a known key with the wrong shape, unknown keys kept, atomic queued writes, and `GET` answers 500 and leaves the file alone when it's not a JSON object, so the page knows not to save over it). `/api/state` is unchanged. The rules per desk are in `STATE_RULES`; `checkState(value, desk = 'product-feed')`.

News keys:
- `read`: `{ "<edition>/<story id>": time }`, for example `{ "2026-12-07/s1": "2026-12-07T13:05:00.000Z" }`. Keys must be a real date, `/`, and a story id (`[A-Za-z0-9_-]{1,40}`), because ids repeat every morning.
- `dismissed`: `{ "<breaking at>": time }`, keyed by the breaking story's `at` exactly as served.
- `shelfOpen`: `true` or `false`.
- A time is an ISO date-time with a timezone (what `toISOString()` gives) or a number (`Date.now()`).
- Error answers name the problem: `read keys must be "<edition>/<story id>", like "2026-12-07/s1" (got "s1")`, `read["2026-12-07/s1"] must be an ISO time or a number`, `shelfOpen must be true or false`.
- XP and the streak stay in Product Feed's state: N4 awards them with `PUT /api/state`.

**Sample edition** (`data/samples/news.sample.json`, for N4's screenshots and N7). Edition `2026-12-07`, empty note, 3 stories and 7 on the shelf, ranks 1 to 10, every region and kind. The top 3 and five shelf headlines are the approved design's; every headline starts with `[Sample]`, actors are generic, and every source is a section or home page from `agents/news/sources.yaml` (no invented article links, no person's blog). `data/samples/breaking.sample.json` is a valid `[Sample]` breaking story (`at` 2026-12-07 12:04 Toronto) for screenshots and tests only: the server never reads it. To show the banner on a test Desk, copy it to `$DESK_HOME/desks/news/breaking.json` with `at` set to today. Tests check both pass the contract and the rules above.

**Review fixes (after the tester passed N3).** Each has tests.
1. A newer valid file in `editions/` wins over an older `last-good.json` (by `edition` date), for News and Product Feed, after a restart and in memory alike.
2. `last-good.json` is the live file's exact bytes, not `JSON.stringify(value, null, 2)`: pretty-printing a valid file near the 1 MB cap could push it over, so it would fail to save or be refused after a restart. `readJsonFile` also refuses a file that grew past the cap between its stat and its read.
3. `editions/`: only the newest 60 dated names are looked at, and the cache is pruned with a Set (was `names.includes()` in a loop).
4. Two regexes held a raw U+FEFF; they're escapes now, and a test scans `server/`, `scripts/`, `app/` and `test/` for raw control or invisible characters.

**Tests.** `test/news.test.js` (loader fallbacks, last-good writes and restarts, editions by name, the sample, once-per-change logging, Toronto dates, breaking, News state rules, the sample's content) and new blocks in `test/api.test.js` (each route over HTTP, restarts, 1 MB cap, corrupt state on disk, the Host check on every new route, security headers) and `test/feed.test.js` (Product Feed's last-good on disk).
