# Sprint 1: the first real edition

**Dates:** Fri 27 Nov to Fri 4 Dec 2026
**Goal:** a Product Feed edition written by its own agent arrives in The Desk on the Mac mini, and Snow's reads and notes are saved there.
**Milestones:** finishes M0 and most of M2 (live plan: Plan tab, Milestones).

Build team stories run in order. Show Snow the result after S2 and again after S4, then stop before S5, which needs her.

---

## Board

Update this table the moment a story changes state (Not started, In progress, In review, Done, Blocked), not only at the end of a session. Commit and push the change on its own.

| Story | Owner | Status | Note |
| --- | --- | --- | --- |
| S0 Foundation fixes | Snow | Done | |
| S1 Repo set up | Developer | Done | |
| S2 The Desk runs from the repo | Developer, designer | Done | |
| S3 Feed schema and validator | Developer, tester | Done | |
| S4 Always on | Developer | Done | Reboot verified 27 Nov |
| S5 The Product Feed agent | Snow and lead dev | Not started | Next, with Snow |
| S6 Stretch: talk with Wila | Build team | Not started | |

---

## S0. Foundation fixes (Snow, about 2 hours, before S5)

The Fix first list on the Plan tab. S5 depends on the first item: OpenClaw must use an Anthropic API key with a monthly cap.

## S1. Repo set up (developer)

- `git init`, `.gitignore`, `package.json` with `npm run dev`, `npm test` and `npm run validate-feed`.
- Folder layout as in CLAUDE.md.

**Done when:** a fresh clone runs `npm install && npm test` with zero failures.

## S2. The Desk runs from this repo (developer, designer)

Port `prototype/` into `app/` and add `server/`:

- `GET /` serves The Desk at http://localhost:4321.
- `GET /api/feed` returns `~/agent-house/desks/product-feed/feed.json`. If it's missing, it returns `prototype/feed.json` and marks it as a sample.
- `GET /api/state` and `PUT /api/state` read and write `~/agent-house/desks/product-feed/state.json`. They replace the prototype's `claude.use("db")` and localStorage. Writes go through a temp file and a rename, so a crash never leaves half a file.
- "Talk with Wila" and "Ask Wila what connects these" are hidden for now (see S6).

**Done when:**
- The room and the Product Feed look the same as the prototype at 1440 px and 390 px (designer screenshots in `docs/screens/`).
- Reads, saves, folders, notes, XP and badges survive a server restart.
- The time-of-day light still follows Toronto's sunrise and sunset.

## S3. Feed schema and validator (developer, tester)

- `data/schema/feed.schema.json` (already drafted) is the contract between the agent and The Desk.
- `npm run validate-feed [path]` checks a file against it.
- The server only serves a valid edition. If the newest file is invalid, it keeps serving the last good one and logs why.
- Every article URL must start with `https://`.

**Done when:** the tester shows a valid file served, an invalid file rejected, and the last good edition still showing.

## S4. Always on (developer, with Snow's OK to install)

- A launchd agent starts the server when Snow logs in and restarts it if it stops.
- The README explains how to start, stop and check it.

**Done when:** after a reboot, http://localhost:4321 loads without anyone touching the terminal.

## S5. The Product Feed agent (Snow and the lead dev, together)

- Create an OpenClaw agent called `product-feed` with its own workspace, using `agents/product-feed/AGENTS.md` as its brief and `agents/product-feed/sources.yaml` as its reading list. Snow reviews the sources first.
- Schedule it daily at 6:00 Toronto time. It writes `feed.json`, archives a copy in `editions/`, and runs the validator.
- Give it a cheap model for gathering and Claude (API key) for writing.

**Done when:** three mornings in a row, a fresh valid edition is waiting in The Desk, and every link opens the article it describes.

## S6 (stretch). Talk with Wila from The Desk

Spike: can The Desk send chat messages to Wila on Hermes running on this Mac (for example through a local API Hermes provides)? Write the findings in `docs/notes/wila-chat.md`. Build it only if it's simple and safe.

## Sprint review (Fri 4 Dec)

Snow uses The Desk for three mornings. We collect what she loved, what got in the way and what she wants next, and Claude updates the plan.
