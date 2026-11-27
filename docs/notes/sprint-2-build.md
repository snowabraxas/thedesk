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
~/agent-house/                   Snow's data and the service log (unchanged)
~/Library/LaunchAgents/local.thedesk.server.plist
                                 WorkingDirectory and server/index.js now point into ~/the-desk-live
```

- **Why `~/the-desk-live`.** Outside `~/Documents`, so macOS privacy never has a say over the code the service runs. Outside `~/agent-house`, so the desk agents (which write there) can't touch the code. The sprint doc's example was `~/agent-house/the-desk-live`; the lead dev chose `~/the-desk-live` for that second reason.
- **Why a worktree.** It shares the repo's objects and refs, so deploying is a `git checkout`, with no clone, no fetch and no network. Being detached, it never holds a branch, so `main` stays free to be checked out in the main checkout.
- **Where the path lives.** `resolveLiveDir()` in `server/config.js`. `DESK_LIVE_DIR` overrides it (tests and dry runs only).
- **`.deployed.json`** (in the live copy, gitignored): `{ sha, shortSha, subject, ref, deployedAt }`. Written by deploy, read by the server at start and by `service:status` (`server/deployed.js` checks the sha and strips control characters before anything prints it).

### How `npm run deploy` works (`scripts/deploy.js`)

Run it from any checkout of the repo. It always takes the local `refs/heads/main`, resolved once to a sha at the start, never the working tree. Pushing to GitHub doesn't matter to it.

1. Refuses if the live path is the checkout itself or sits inside it (or around it).
2. Reads main's sha and subject. Notes, without stopping, when the folder you ran it from is on another branch or has uncommitted changes. Neither is deployed.
3. **No live copy:** `git -C <repo> worktree add --detach <live> <sha>`.
   **Live copy exists:** checks that it is a worktree of this repo (same `--git-common-dir`, top level is the folder itself), else refuses. Refuses if `git status --porcelain` shows anything (lists up to 10 lines, suggests `git -C <live> stash --include-untracked`). Otherwise `git -C <live> checkout --quiet --detach <sha>`, or nothing if it's already there.
4. `npm ci --omit=dev` in the live copy (npm from next to Homebrew node), only when it's a new copy, `node_modules` is missing, no deploy is recorded, or `git diff --quiet <last deployed> <new> -- package-lock.json` says it changed. The base is the sha in `.deployed.json` (the last deploy that went all the way through), not the live copy's HEAD, so a deploy whose `npm ci` failed gets its packages installed by the next one. If npm fails it stops: no restart, no new `.deployed.json`.
5. Writes `.deployed.json` (temp file and rename).
6. Reads the installed plist's `WorkingDirectory`. Not installed, or not the live copy: stops (exit 1) and says to run `npm run service:install` once. Otherwise it calls `restart()` from `scripts/service.js` (`launchctl kickstart -k`, or bootstrap if it was stopped), uses the same health check (`/api/feed` within 15 s, log tail on failure), and ends with one line: `The Desk is live at http://localhost:4321 on main @ 1a2b3c4 "Subject"`.

`--dry-run` runs only read-only git (`log`, `rev-parse`, `status --no-optional-locks`, `diff`) and prints each step with its exact command. It changes nothing, and it stops where the real run would refuse.

Between the checkout and the restart (a few seconds) the running server already serves the new `app/` files from disk. Harmless for now. If a story ever needs both halves to change at once, deploy into a fresh folder and swap the folder instead.

**To undo a bad deploy:** `git revert` the commit on main, then `npm run deploy`. Avoid checking out an old commit in the live copy by hand: `.deployed.json` would no longer match it.

### `service:install` and `service:status`

- `serviceConfig()` takes `runDir` (default: the live copy) instead of the old `repoRoot`. The plist is otherwise unchanged: same label, RunAtLoad, KeepAlive, ThrottleInterval 10, PATH, `DESK_HOME=~/agent-house`, `PORT=4321`, `DESK_LOG`, `DESK_SERVICE=1`, same log path.
- `install` refuses, changing nothing and calling no launchctl, when `<live>/server/index.js` is missing: "run npm run deploy first". The dry run says the same at the top.
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

- `test/deploy.test.js`: real git on small temp repos (with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so no hooks or signing). npm, launchctl, lsof and the health check are fakes. Covers the first deploy (service not moved, not installed, already moved), the happy path, lockfile changed or not, `node_modules` missing, already on main, uncommitted work and story branches never going live, a dirty live copy, a foreign folder or repo at the live path, the live path inside the checkout, no main, npm failing, the restart failing, and dry runs that only read.
- `test/service.test.js`: the plist points at the live copy, install refuses without it, an old plist from the work folder gets moved, and status shows the folder and deployed commit.
- `test/server.test.js` and `test/log-file.test.js`: timestamps (winter, summer, the local day, offsets east and on the half hour), every line stamped, the stopping line on SIGTERM and SIGINT with exit 0, the deployed line at start. `test/deployed.test.js`: reading and cleaning `.deployed.json`. `test/preview.test.js`: the preview script and `launch.json`.
- Scratch servers in this story used ports 4399–4404 with `DESK_HOME` under `.tmp-*/` (gitignored). Dry runs used a fake `HOME` outside the repo: deploy refuses a live path inside the checkout.

### One-time cutover (lead dev, with Snow's OK)

Snow's OK is needed because this reinstalls the always-on service. Expect about two seconds when 4321 doesn't answer. Her data in `~/agent-house` is untouched.

1. **Merge.** In `~/Documents/Projects/the-desk`, with `git status` clean and on `main`: `git merge --no-ff n1-live-copy`, then `npm test`. Until step 5 the service still runs from this folder, now on N1's code (`app/` is unchanged by N1, so 4321 looks the same).
2. **Look first:** `npm run deploy -- --dry-run`. It should plan `git worktree add --detach /Users/snow/the-desk-live <sha>`, `npm ci --omit=dev`, `.deployed.json`, and then stop because the service "still runs from /Users/snow/Documents/Projects/the-desk".
3. **Make the live copy:** `npm run deploy`. It makes `~/the-desk-live`, installs its packages and records the commit, then stops (exit 1 is expected here) with "Run npm run service:install once to move the service to the live copy."
4. **Look first:** `npm run service:install -- --dry-run`. Check the top line names `/Users/snow/the-desk-live, main @ <sha>`, and that the plist's `WorkingDirectory` and `server/index.js` are inside `/Users/snow/the-desk-live`.
5. **Move the service:** `npm run service:install`. It boots out the old service, writes the new plist, starts it, and waits for `OK: The Desk is running at http://localhost:4321`.
6. **Check:**
   - `npm run service:status`: `Runs from: /Users/snow/the-desk-live`, `Deployed: main @ <sha> ...`, `Answers: yes`, and no "still runs from" warning.
   - `tail -n 3 ~/agent-house/logs/the-desk.log`: timestamped `running at` and `this is main @ <sha>` lines.
   - The story's "done when": `git switch -c n1-check` here, change nothing, reload http://localhost:4321 (same page), and `service:status` still shows the same commit. Then `git switch main && git branch -d n1-check`.
   - `npm run deploy` once more: "already holds main", a restart, and `The Desk is live at http://localhost:4321 on main @ <sha> "<subject>"`. The log now shows `The Desk is stopping (SIGTERM)` followed by a new `running at`.
7. Nothing new to commit (`.deployed.json` lives only in the live copy). Update the board and `docs/status.md` as usual.

**Afterwards:** merge to main, then `npm run deploy`. That's the whole release. Don't delete `~/the-desk-live` by hand. If it ever has to go, run `npm run service:uninstall`, then `git worktree remove ~/the-desk-live`. If it was deleted anyway, `git worktree prune` before the next deploy.

**Rollback to the Sprint 1 setup** (only if the cutover fails): in the main checkout run `git switch --detach <main before the merge>` and `npm run service:install` (that version installs from the folder it runs in), then `git switch main`. That brings back the old problem until it's fixed.
