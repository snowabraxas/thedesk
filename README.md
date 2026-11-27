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
                       # (if the always-on service has 4321: PORT=4322 npm run dev)
npm test               # all tests
npm run validate-feed  # checks ~/agent-house/desks/product-feed/feed.json
npm run validate-feed -- path/to/feed.json   # or any other edition
npm run validate-news  # checks ~/agent-house/desks/news/news.json (and breaking.json if there)
npm run validate-news -- path/to/news.json path/to/breaking.json   # or any News files
```

`validate-feed` and `validate-news` print `valid`, or a short list of what to fix, and exit 0 or 1.

The server only listens on this Mac (127.0.0.1). `PORT` changes the port and `DESK_HOME` changes where the desks' data lives (default `~/agent-house`). `npm start` runs it without the auto-restart.

## The API

What the desk pages talk to. Everything is JSON, never cached, and only answers requests addressed to `localhost:<port>` or `127.0.0.1:<port>` (anything else gets 403). Paths below are under `DESK_HOME/desks/`.

| Route | What it does |
| --- | --- |
| `GET /api/feed` | Product Feed's edition. The `X-Desk-Feed-Source` header says which one: `live` (`product-feed/feed.json`), `last-good` (the last valid one, kept in `product-feed/last-good.json`), `edition:<YYYY-MM-DD.json>` (from `product-feed/editions/`) or `sample` (marked `"sample": true`). |
| `GET` / `PUT /api/state` | Snow's Product Feed state (reads, saves, folders, notes, XP, streak, badges) in `product-feed/state.json`. |
| `GET /api/news` | The News morning edition, in the same order: `X-Desk-News-Source` is `live` (`news/news.json`), `last-good` (`news/last-good.json`), `edition:<file>` (`news/editions/`) or `sample` (`data/samples/news.sample.json`, marked `"sample": true`). |
| `GET /api/breaking` | `{"breaking": {...}}` when `news/breaking.json` is valid and from today in Toronto, otherwise `{"breaking": null}`. |
| `GET` / `PUT /api/news/state` | Snow's News state (`read`, `dismissed`, `shelfOpen`, and `awarded`, the stories already paid XP) in `news/state.json`. |

`PUT` takes a JSON object up to 1 MB (`Content-Type: application/json`) and saves it whole, so a crash never leaves half a file. Details: `docs/notes/sprint-2-build.md` (N3).

## Always on

The Desk can run by itself in the background. macOS starts it when you log in and starts it again if it ever stops, so http://localhost:4321 is simply there.

```
npm run service:install     # set it up and start it (once)
npm run service:status      # is it running, does the page answer, where's the log
npm run service:stop        # stop it (it comes back with service:start, or at your next login)
npm run service:start       # start it again
npm run service:restart     # restart it, for example after changing server code
npm run service:uninstall   # remove it (your reads, notes and logs stay in ~/agent-house)
```

`npm run service:install -- --dry-run` shows what install would do, without changing anything. Stop any copy you started in a Terminal (Ctrl+C) before installing; install won't take a port that's in use.

- **The log** is `~/agent-house/logs/the-desk.log`. Past 5 MB, the older part moves to `the-desk.log.1`.
- **After restarting the Mac**, it starts when you log in (or by itself, if the Mac logs you in automatically).
- **macOS privacy.** This folder is inside Documents, which macOS protects. If macOS asks whether "node" may access your Documents folder, click Allow. If install says node isn't allowed, follow the steps it prints (Full Disk Access for `/opt/homebrew/bin/node`; note that this lets every node program on the Mac read everything). After Homebrew upgrades Node, macOS may ask again.
- **Background Items Added**: macOS shows this notice when it's installed. That's The Desk; leave it switched on in System Settings > General > Login Items & Extensions (it may be listed as "node").
- **Moved this folder?** Run `npm run service:install` again (`service:status` tells you when it's needed).

**Working on the code while it runs.** The service runs the code in this folder on port 4321. Run your own copy next to it with `PORT=4322 npm run dev` (http://localhost:4322). Changes in `app/` show up in both on reload; after changing `server/` code, run `npm run service:restart` so the always-on copy picks it up.
