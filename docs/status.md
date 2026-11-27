# Status

Updated by whoever worked last (Claude Code at the end of each session, the lead PM when specs change). Five lines or fewer.

- **2026-11-27 · lead dev:** S1–S4 done (reboot verified twice), and L1 done: Lotus is live on 4321 for the room and Product Feed, Snow approved, tester passed. Tester leftovers are listed for N6 in `docs/notes/sprint-1-build.md`. Sprint 2 (N1 onward) not started yet; S5 still waits for Snow.
- **2026-11-27 · lead PM:** Games discovery done: all 10 kickoff questions answered in the Games PRD (random game kind daily, smaller games + a long Friday game, visible timer, adaptive difficulty, hints/replay, contestant rank + skill levels, Wila nudge + teammate/opponent mode, Mac mini only for now). Requirements next. Build after Product Feed and News.
- **2026-11-27 · lead PM:** News discovery done: all 7 kickoff questions answered in the News PRD (Phase 1: top 3 stories + shelf, no paywalls, rare breaking alerts, simple page; lenses + Analyst agent in Phase 2). Phase 1 requirements (N1-N7), news.json contract and agents/news/ brief + sources written. Ready for Sprint 2. Lotus design system (new base theme for every desk, Snow approved) in `docs/design/lotus/`; theme switch is a Sprint 2 story.
- **Next:** Sprint 2 from `docs/lead-pm-brief.md`, starting with a five-line plan for Snow and N1. S5 (Product Feed agent) whenever Snow is ready.
- **Open question for the lead PM:** none. (Note: the desktop app's Preview button runs a second Desk on port 3000 from this folder with Snow's real data; two open tabs on 3000 and 4321 can overwrite each other's saves. N1 is a good moment to point `.claude/launch.json` at a temp DESK_HOME.)
