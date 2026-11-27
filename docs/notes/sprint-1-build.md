# Sprint 1: build decisions (lead dev)

Technical notes for the team. Snow doesn't need to read this.

## Toolchain

- Node from Homebrew (`/opt/homebrew/bin/node`, v26). Non-login shells may not have `/opt/homebrew/bin` on `PATH`: prefix commands with `export PATH=/opt/homebrew/bin:$PATH`.
- ES modules (`"type": "module"`), no framework. Tests use Node's built-in runner (`node --test`), run with `TZ=America/Toronto` so time-of-day tests are deterministic.
- One runtime dependency: `ajv` (JSON Schema 2020-12) for the feed contract.
- One dev dependency: `playwright-core`, driving the Google Chrome already installed on the Mac mini (`channel: 'chrome'`). No browser download.

## Layout

```
app/            front end, ported from prototype/ (prototype/ stays as the reference)
server/         node:http server, no framework
scripts/        validate-feed, screenshots, launchd helpers
test/           node:test suites
data/schema/    feed.schema.json (the agent <-> Desk contract)
```

## Server

- Listens on `127.0.0.1:4321` only (Snow's notes never leave the machine). `PORT` and `DESK_HOME` (default `~/agent-house`) can be overridden; tests point `DESK_HOME` at a temp folder.
- Rejects requests whose `Host` header isn't `localhost:<port>` or `127.0.0.1:<port>` (blocks DNS-rebinding pages from reading Snow's notes). Sends no CORS headers, so other sites can't `PUT` state.
- Static files from `app/` only, with path-traversal protection.
- `GET /api/feed`: the newest valid edition. Order of preference: `desks/product-feed/feed.json`, then the last good `feed.json` kept in memory, then the newest valid file in `editions/`, then `prototype/feed.json` marked `"sample": true` (only the server may set `sample`; it's stripped from agent files). An invalid file is logged once (with the reasons) when it changes, not on every request. The `X-Desk-Feed-Source` header says which one was served: `live`, `last-good`, `edition:<file>` or `sample`.
- The validator (`server/feed-schema.js`, shared by `npm run validate-feed` and the server) adds two rules on top of the schema: article and theme ids are unique, and every article theme is listed in `themes`.
- `GET /api/state` / `PUT /api/state`: `desks/product-feed/state.json`. PUT accepts a JSON object up to 1 MB, writes to a temp file in the same folder, fsyncs, then renames, so a crash never leaves half a file.

## Front end

- Same look as the prototype. `localStorage` and `claude.use("db")` are replaced by the two state endpoints. Saves are debounced as before.
- "Talk with Wila" (article button and drawer tab) and "Ask Wila what connects these" are hidden until S6.
- The "sample picks" line under the edition title shows only when the server marks the feed as a sample.
- Pure logic (sun times, phase, escaping, https check) lives in a small module the browser and the tests both import.

## Always on (S4)

- Per-user LaunchAgent `local.thedesk.server` in `~/Library/LaunchAgents`, managed by `scripts/service.js` (`npm run service:*`). RunAtLoad + KeepAlive true + ThrottleInterval 10: it restarts in under a second after a stop or crash, and a crash loop retries every 10 s.
- Runs `/opt/homebrew/bin/node server/index.js` from this folder with `DESK_HOME=~/agent-house`, logging to `~/agent-house/logs/the-desk.log` (one 5 MB rotation). Installed 27 Nov 2026 with Snow's OK; macOS didn't block node from reading ~/Documents.
- Verified: kill, kill -9, stop/start (same path as a login), restart, and a real reboot on 27 Nov 2026 (boot 02:18:38, the service started itself at 02:19:14 after login, `runs = 1`, never exited, GET / 200, nobody touched Terminal).

## Follow-ups (not in Sprint 1)

- **The service runs whatever is checked out here.** Switching to a story branch changes Snow's live Desk (`app/` on reload, `server/` on the next restart). Lead PM's answer: Sprint 2 story N1 (a `main`-only copy outside ~/Documents plus `npm run deploy`). Until then, story work happens in a separate worktree (Lotus used `~/Documents/Projects/the-desk-lotus`).
- The server log has no timestamps and no "stopping" line; add both (makes reboot checks provable). Now part of N1.
- **Lotus leftovers for N6** (from the L1 tester's re-check, none blocking):
  - Theme map: once most themes are read, the lit spoke runs through "you" and a moss link touches "How teams operate" (2.6–3.5:1). Fix: a halo on map labels (`paint-order:stroke` with a midnight-green stroke) or move "you" off the spoke. The "Theme map" heading hits 4.44:1 at night on a phone at one scroll position when all are read.
  - Focus ring on a wrapped article title: the 7 px box-shadow paints a bar across the first line. Fix: `outline` with `outline-offset` instead of box-shadow on `.art h3 a:focus-visible`.
  - After keyboard Undo of a note delete, focus stays on the faded toast button; move it to `#noteText` (drawer open) or back to where it was.
  - Undo of a note delete after the drawer closed leaves "Notes (n)" and the My notes count stale until the next render; call `renderFeed()` when the drawer is hidden.
  - Still open from Sprint 1: phone-room hotspots and Wila's orb under 44 px with overlapping labels; article title links 25 px tall.
- "Last good" edition lives only in memory; after a restart with a bad `feed.json` and no `editions/`, the sample shows. Fine once S5 archives editions; could persist to disk. **Done in Sprint 2 (N3):** kept on disk as `desks/product-feed/last-good.json` (see sprint-2-build notes).
- Validator accepts `https://user@host/` links; consider rejecting userinfo.
- Un-marking and re-marking an article read grants XP again (inherited from the prototype).
- Design list from the S2 baseline (needs Snow's OK before any change): hotspot labels clipped and overlapping at 390 px, tap targets under 44 px (hotspots, Wila orb at 390, Preview chip, card buttons), a few texts under 4.5:1 contrast, "Save ▾" sits 8 px high, folder input cut off at 1440, shelves scroll sideways at 390 with no hint, empty space under Wila at 390.
- Favicon: lamp is live; a leaf option is in `docs/screens/favicon-option-b-leaf.svg` if Snow prefers it.

## Branches

One branch per story (`s1-repo-setup`, `s2-desk-runs`, `s3-feed-validator`, `s4-always-on`), merged to `main` after the tester passes it.
