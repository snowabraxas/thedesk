# Status

Updated by whoever worked last (Claude Code at the end of each session, the lead PM when specs change). Five lines or fewer.

- **2026-11-27 · lead dev:** S1–S4 done, tested and merged to `main`. The Desk runs from the repo at http://localhost:4321 as an always-on login item, saves Snow's reads and notes to `~/agent-house`, and only shows a valid feed edition (else the last good one). Details and follow-ups: `docs/notes/sprint-1-build.md`. Stopped before S5.
- **2026-11-27 · lead PM:** News discovery done: all 7 kickoff questions answered in the News PRD (Phase 1: top 3 stories + shelf, no paywalls, rare breaking alerts, simple page; lenses + Analyst agent in Phase 2). Phase 1 requirements (N1-N7), news.json contract and agents/news/ brief + sources written. Ready for Sprint 2.
- **2026-11-27 · lead PM:** S0 done. Sprint 1 brief in `docs/lead-pm-brief.md`. Plan, PRDs, art doc and prototype rebuilt in the account linked to the Mac mini; links in CLAUDE.md and README updated. This folder is now the working copy.
- **Next:** Snow restarts the Mac once and checks http://localhost:4321 loads by itself (S4's last check). Then S5 with Snow: review `agents/product-feed/sources.yaml`, set up the OpenClaw `product-feed` agent.
- **Open question for the lead PM:** the always-on Desk runs whatever code is checked out in this folder, so story branches go live on Snow's 4321. Keep it, or run the service from a separate `main` copy outside ~/Documents? Also: schedule a design polish story for the 390 px and contrast issues listed in the build notes?
