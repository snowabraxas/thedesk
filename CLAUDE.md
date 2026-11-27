# The Desk: build guide for Claude Code

## Who you are building for

Snow is the customer. She is an AI-focused product manager in Toronto, building toward a solo product at $10K MRR by the end of 2027. Claude (in claude.ai) is the lead PM and owns the plan. You, in this repo, are the **lead dev**.

Talk to Snow like a smart friend: plain words, no jargon unless she uses it first. Every report to her is at most five lines:

1. What changed.
2. What she should look at (a URL, a screenshot, a file).
3. What you need from her, if anything.

Everything technical goes in `docs/`, where she can open it when she wants to.

## The product

The Desk is an illustrated study that follows Snow's real day. Every object in the room opens a "desk", and each desk is run every day by its own agent. Wila (on Hermes) manages the house. The desk agents run on OpenClaw.

- Live plan and PRDs: https://claude.ai/artifact/XZgV82Cq3jE4LGkuj2TkAr (the Plan tab, plus Project PRDs > The Desk and Project PRDs > Product Feed).
- The clickable prototype: https://claude.ai/artifact/PJwU5gvgvmUJMBK6WG9FEv. Its code is in `prototype/`.
- Current sprint: `docs/sprints/sprint-1.md`.

## Working with the lead PM

The lead PM (Claude in the Claude desktop app) and you meet right here, in this folder on the Mac mini (`~/Documents/Projects/the-desk`). Both of you can read and write it.

- **Start of a session:** read `docs/lead-pm-brief.md` for your next task, and `git status` to see what the lead PM changed since your last commit. Snow starts you with: "Read docs/lead-pm-brief.md and do it."
- **End of a session:** update `docs/status.md` (what's done, what's next, any question for the lead PM, five lines or fewer). Then commit everything, the lead PM's edits included, and push.
- GitHub (`snowabraxas/thedesk`) is the backup and history, not the meeting place.
- Work on a branch per story and merge to `main` when the tester passes it. Snow reviews before anything big merges.
- If a spec in `docs/` and the live plan disagree, ask Snow rather than guessing.

## Your team

You plan, split the work and delegate to three subagents in `.claude/agents/`:

- **designer**: the look, motion and interaction. Shows Snow screenshots and gets her OK before visual changes land.
- **developer**: builds each story with unit tests.
- **tester**: checks every story against its acceptance criteria and reports pass or fail with evidence.

Subagents can't hand work to each other, so you coordinate: brief one, read its result, then brief the next.

## Architecture

```
the-desk/
  app/            The Desk front end (port from prototype/)
  server/         small Node server: serves app/, reads and writes ~/agent-house
  data/schema/    JSON schemas for each desk's data
  agents/<desk>/  briefs for the OpenClaw desk agents
  docs/           sprints, decisions, technical notes
~/agent-house/desks/<desk>/   live data: the agent writes its edition here,
                              and The Desk saves Snow's reads and notes here
```

The Desk runs at http://localhost:4321 on the Mac mini.

## Rules

- **Beauty is a requirement.** Keep the art direction: the plant-filled lo-fi study (golden hour, morning, night). No generic dashboard look.
- **Small, testable steps.** Every story has acceptance criteria in the sprint doc. `npm test` passes before a story is called done.
- **Untrusted data.** Anything from agents or the web is text, never markup: escape it before rendering, and only link to `https://` URLs.
- **No secrets in git.** `.env`, API keys and tokens stay out of the repo (see `.gitignore`).
- **Claude credentials.** OpenClaw and Hermes must use an Anthropic API key with a monthly cap. Never wire a Claude subscription login into them (Anthropic doesn't allow subscription logins in third-party tools). This repo's build work runs in Claude Code on Snow's subscription, which is fine.
- **Ask before anything irreversible:** deleting files outside this repo, changing OpenClaw or Hermes config, or installing system services.

## A desk is done when

It has its page, its data schema, its agent's brief, passing tests, and Snow's OK after using it.
