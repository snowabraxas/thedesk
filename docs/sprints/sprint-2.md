# Sprint 2: News goes live, in Lotus

**Dates:** Sat 28 Nov to Fri 11 Dec 2026. Joint check-in with the Sprint 1 review on Fri 4 Dec.
**Goal:** the TV opens the News desk in the Lotus look, and the News agent's morning edition is waiting there every morning, with a rare breaking banner when it matters.
**Milestones:** M3 (News, Phase 1). Live plan: Plan tab > Current sprint; spec: Project PRDs > News (N1 to N7).
**Runs alongside:** Sprint 1's S5 (Product Feed agent, with Snow). N9 reuses what S5 teaches us, so N9 starts after S5.

## Board

Update this table the moment a story changes state (Not started, In progress, In review, Done, Blocked), not only at the end of a session. Commit and push the change on its own ("Board: N3 in review"). Owner = who moves it next.

| Story | Owner | Status | Note |
| --- | --- | --- | --- |
| L1 Lotus theme on The Desk and Product Feed | Lead dev | Done | Live on 4321 since 27 Nov. Tester leftovers (theme map label contrast, title focus ring, two small Undo fixes) moved to N6 |
| N1 Live copy separate from work in progress | Developer | Done | Live since 27 Nov 13:42: the service runs from `~/the-desk-live`; release = merge to main, then `npm run deploy`. 498 tests; tester passed; four review rounds fixed. Small hardening follow-up (load check before restart) in progress |
| N2 News contract: schemas and validator | Developer, tester | Done | Merged 27 Nov. `npm run validate-news`. Tester passed; 3 review rounds fixed. Product Feed links got stricter too (see sprint-2-build notes, for S5) |
| N3 News server routes | Developer, tester | Done | Merged and live 27 Nov. /api/news (live, last good on disk, editions, sample), /api/breaking (today in Toronto), /api/news/state. Product Feed keeps its last good edition on disk too |
| N4 The News desk page | Developer, then designer | In progress | Branch n4-news-page (on top of N3). Logic first, then the Lotus look. Snow approves the design |
| N5 The TV in the room | Designer, developer | Not started | |
| N6 Polish at 390 px and contrast | Designer, tester | Not started | Snow's OK before changes land |
| N7 Sample edition and friendly states | Developer, tester | Not started | |
| N9 The News agent | Snow and lead dev | Not started | After S5 |

---

## L1. Lotus theme (already in progress)

Finish the tester's re-check, merge, and switch the always-on Desk to Lotus.

## N1. Live copy separate from work in progress (developer, with Snow's OK)

Answers the lead dev's open question: yes, keep Snow's live Desk off story branches.

- The service runs from a `main`-only copy outside ~/Documents, for example a git worktree at `~/agent-house/the-desk-live`.
- `npm run deploy` updates it to the latest `main` and restarts the service. Story branches never touch 4321.
- Add timestamps and a "stopping" line to the server log (from the Sprint 1 follow-ups).

**Done when:** checking out a story branch here leaves 4321 unchanged, and `npm run deploy` brings it up to date.

## N2. News contract (developer, tester)

- `data/schema/news.schema.json` and `breaking.schema.json`, from the contract in the News PRD (section 7).
- The validator checks both: exactly 3 `stories` (fewer only with a `note`), up to 7 in `more`, at least 2 sources per story, a non-empty `skeptic`, `https://` links only (reject links with a user name in them), unique ids.
- `npm run validate-feed` handles both desks (or add `npm run validate-news`; your call).

**Done when:** the tester shows a valid edition accepted, and each rule above rejecting a broken one.

## N3. News server routes (developer, tester)

- `GET /api/news`: the newest valid `~/agent-house/desks/news/news.json`, falling back to the last good edition, then the newest valid file in `editions/`, then a sample, the same order as Product Feed. Keep the last good edition on disk, so a restart doesn't lose it.
- `GET /api/breaking`: `breaking.json` when it's from today and valid, else nothing.
- Snow's News state (banner dismissed, shelf opened, stories read) saves to `desks/news/state.json` the same way as Product Feed.

**Done when:** the API tests cover each fallback, and state survives a restart.

## N4. The News desk page (designer, developer)

- N1 and N7 from the PRD: opens from the TV into its own page in Lotus glass, from the approved design test (version C). Simple, clean, dashboard-style.
- The top 3 stories as frost cards: headline, 2 to 3 sentence summary, "why it matters", the skeptic's view, region tag, and links to every source.
- N3 in the PRD: a "more stories" shelf with up to 7 stories, closed by default.
- N4 in the PRD: a breaking banner when `/api/breaking` has a story; Snow can dismiss it.
- Gamified, lightly: a story read counts toward XP and the streak like Product Feed. No new mechanics this sprint.

**Done when:** Snow approves screenshots at 1440 px and 390 px, then uses it on a sample edition.

## N5. The TV in the room (designer, developer)

- The retro TV hotspot opens the News desk (it's currently a "coming soon" object).
- The TV glows when there's an unread edition, and shows a small rosy mark when there's an undismissed breaking story.

**Done when:** the TV shows each state on the sample data, morning, golden hour and night.

## N6. Polish at 390 px and contrast (designer, tester)

The design list from the Sprint 1 build notes, redone in Lotus: hotspot labels clipped at 390 px, tap targets under 44 px, texts under 4.5:1, the "Save" button 8 px high, the folder input cut off at 1440, shelves with no scroll hint, the empty space under Wila at 390.

**Done when:** Snow okays the before and after screenshots, and the tester's contrast and tap-target checks pass.

## N7. Sample edition and friendly states (developer, tester)

- A realistic sample `news.json` (marked as a sample) so the desk works before the agent runs.
- N7 in the PRD: friendly states for a late, missing or thin edition. No blank page, no error text.

**Done when:** the tester shows each state on purpose.

## N9. The News agent (Snow and the lead dev, after S5)

- Create the OpenClaw `news` agent from `agents/news/AGENTS.md` and `agents/news/sources.yaml`. The lead PM checks every source URL first.
- Schedule: the morning edition at 5:30 Toronto time; breaking checks at 12:00, 17:00 and 21:00, at most 1 alert a day. It writes `news.json` (archiving a copy in `editions/`) or `breaking.json`, and runs the validator until it says `valid`.
- A breaking alert also reaches Snow as a message from Wila on Discord. Find the simplest safe way and propose it before building.
- Models: T2 to gather and scan, T1 to pick and write.

**Done when:** three mornings in a row a fresh, valid edition is waiting, every link opens the story it describes, and a test breaking alert shows as the banner and as a Wila message.
