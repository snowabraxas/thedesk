# The Desk

The illustrated home of Snow's Agent House. Every object in the room opens a desk, and each desk is run every day by its own agent.

- Start here: `KICKOFF.md`
- Build guide for Claude Code: `CLAUDE.md`
- Current sprint: `docs/sprints/sprint-1.md`
- Live plan and PRDs: https://claude.ai/artifact/XZgV82Cq3jE4LGkuj2TkAr
- The prototype this repo grows from: `prototype/` (live copy: https://claude.ai/artifact/PJwU5gvgvmUJMBK6WG9FEv)

## Run it

You need Node 22 or newer (on the Mac mini it's in `/opt/homebrew/bin`).

```
npm install            # once, after cloning or pulling new dependencies
npm run dev            # The Desk at http://localhost:4321, restarts when code changes
npm test               # all tests
npm run validate-feed  # checks ~/agent-house/desks/product-feed/feed.json
npm run validate-feed -- path/to/feed.json   # or any other edition
```

`validate-feed` prints `valid`, or a short list of what to fix, and exits 0 or 1.

The server only listens on this Mac (127.0.0.1). `PORT` changes the port and `DESK_HOME` changes where the desks' data lives (default `~/agent-house`). `npm start` runs it without the auto-restart.
