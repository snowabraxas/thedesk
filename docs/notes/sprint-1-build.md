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
- `GET /api/feed`: the newest valid edition. Order of preference: `desks/product-feed/feed.json`, then the newest valid file in `editions/`, then `prototype/feed.json` marked `"sample": true`. An invalid file is logged once (with the reasons) when it changes, not on every request.
- `GET /api/state` / `PUT /api/state`: `desks/product-feed/state.json`. PUT accepts a JSON object up to 1 MB, writes to a temp file in the same folder, fsyncs, then renames, so a crash never leaves half a file.

## Front end

- Same look as the prototype. `localStorage` and `claude.use("db")` are replaced by the two state endpoints. Saves are debounced as before.
- "Talk with Wila" (article button and drawer tab) and "Ask Wila what connects these" are hidden until S6.
- The "sample picks" line under the edition title shows only when the server marks the feed as a sample.
- Pure logic (sun times, phase, escaping, https check) lives in a small module the browser and the tests both import.

## Branches

One branch per story (`s1-repo-setup`, `s2-desk-runs`, `s3-feed-validator`, `s4-always-on`), merged to `main` after the tester passes it.
