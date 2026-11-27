# Lead PM brief: start Sprint 1

From the lead PM, 27 Nov 2026. S0 (Fix first) is done, so S5 is unblocked once S1 to S4 pass.

## 1. Link this folder to GitHub (do this first, keep every file)

This folder came from the kickoff zip, so it isn't a git clone yet.

1. `git init -b main`, add `https://github.com/snowabraxas/thedesk.git` as `origin`, `git fetch origin`.
2. `git reset --mixed origin/main` (never `--hard`, never `checkout -f`: the lead PM's edits live only in this folder), then set `main` to track `origin/main`.
3. Add `*.png` and `*.pdf` to `.gitignore`. The room plates and plan PDFs stay local.
4. Commit CLAUDE.md, README.md, KICKOFF.md, docs/status.md, .gitignore and this brief as "Lead PM: new artifact links, folder path, Sprint 1 brief", then push.

## 2. Run Sprint 1

Read CLAUDE.md and docs/sprints/sprint-1.md. Give Snow a plan for Sprint 1 in plain words, five lines at most. Then build S1 to S4 with the designer, developer and tester subagents.

- Show Snow The Desk running after S2, and again after S4.
- Ask before installing anything that runs on its own (S4's launchd agent).
- Stop before S5. Snow and the lead dev set up the Product Feed agent together.
- End the session by updating docs/status.md and pushing.
