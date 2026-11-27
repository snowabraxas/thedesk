# Sprint 2: build decisions (lead dev)

Technical notes for the team. Snow doesn't need to read this.

## N2. News contract: schemas and validator

**Files.** `data/schema/news.schema.json` (the morning edition) and `data/schema/breaking.schema.json` (one breaking story), JSON Schema 2020-12. `server/news-schema.js` is the validator, shared by `npm run validate-news` now and by the server from N3. `server/schema-common.js` holds what Product Feed and News share (ajv setup, error wording, file reading, date and link checks); `server/feed-schema.js` now uses it, with Product Feed's messages unchanged except for the stricter link rules from the review (below). Fixtures for tests and N3: `test/fixtures/news/news.json` (3 stories, 2 on the shelf, every region and kind) and `test/fixtures/news/breaking.json`. Paths: `newsDir`, `newsPath`, `breakingPath` in `server/config.js`.

**The schemas.**
- Edition: `desk` is `"news"`, `edition` is `YYYY-MM-DD`, `stories` 0 to 3, `more` 0 to 7. `desk`, `edition` and `stories` are required; `note` (max 300) and `more` are optional and mean `""` and `[]` when absent, the same way Product Feed treats `note`.
- Story (`$defs/story`): `id` (`^[A-Za-z0-9_-]{1,40}$`, safe as a state key or DOM id), `rank` (integer from 1), `headline` 160, `summary` 700, `why` 300, `skeptic` 500 (each must have a non-space character, pattern `\S`), `date` (`""` or `YYYY-MM-DD`), `region` and `kind` enums, `sources` 2 to 8 of `{ name (max 80, not blank), url (^https://) }`. Every field is required, `rank` included, so a breaking story really is "the same shape".
- Breaking: `"$ref": "news.schema.json#/$defs/story"` plus a required `at`. The validator registers the edition schema with ajv first so the reference resolves. `at` is ISO 8601 with a timezone (`Z` or `±HH:MM`); seconds and fractions are optional. ajv-formats isn't installed (strict mode refuses `format` without it), so `at` uses a pattern, and `schema-common.js` exports the same regex (`DATE_TIME_PARTS`); a test keeps them identical.
- `additionalProperties: true`, as in `feed.schema.json`: an agent that adds a field (a tag, an author on a source) shouldn't take the desk down for the day, and the page only ever renders the fields it knows, as escaped text. It's written out on the edition, story, source and breaking objects so the agent reading the schema sees it.

**Rules on top of the schema** (in `news-schema.js`, checked only on values that passed their pattern, so each value gets one line):
- fewer than 3 `stories` needs a `note` that isn't blank: `note: must say why there are fewer than 3 stories (stories has 2)`. 0 stories with a note is allowed.
- ids are unique across `stories` and `more`, ranks unique across the whole edition: `more[1].id: duplicate id "s2" (also used by stories[1])`.
- `edition` and story `date` are real calendar days; `at` is a real moment (hours 0-23, minutes and seconds 0-59, offset at most 14:59).
- links are whole `https://` links (they parse, name a site, no spaces, backslashes or hidden characters) that open the site they show, with no user name or password before the site name, and a story never lists the same page twice (see the review fixes below). `https://user@host/`, `https://:pw@host/` and even an empty `https://@host/` are refused; an `@` later in the link (`/@snow`, `?by=a@b`) is fine. The message shows the link as `https://***@host/...`, so a password never reaches the terminal or `the-desk.log`.
- Error wording comes from `schema-common.js`: lists say what they hold (`stories[1].sources: needs at least 2 sources (has 1)`, `stories: can have at most 3 stories (has 4); the top 3 go in stories, up to 7 more in more`), enums list the allowed values, and untrusted values are quoted with controls and invisible characters escaped and cut at 60 characters. At most 100 problems are listed per file.

**Product Feed follow-up from Sprint 1.** The same user-name/password rule now applies to Product Feed article links (`isHttpsLink` refuses them too). Tests in `test/feed-schema.test.js`. The front end's own `safeUrl` in `app/lib.js` still allows user info; the server never serves such a link now, but N4 could tighten `safeUrl` to match for defence in depth.

**`sample`.** Same as Product Feed: only The Desk may mark an edition as a sample. The schema doesn't fail a file because of a `sample` key (extra keys are allowed); `checkNewsFile`, `checkBreakingFile` and `checkNewsDeskFile` return a valid file with `sample` removed (`withoutSample` in `schema-common.js`). N3's loader should use those results, then add `sample: true` only to its own fallback (N7's sample edition).

**CLI.** `npm run validate-news [file ...]`, in the style of `validate-feed`. `breaking.json` is checked against the breaking schema, and its failure header says `(checked as a breaking story)`; `news.json`, or any file in an `editions/` folder, is an edition; any other file is a breaking story unless it has a `stories` key. With no file it checks `$DESK_HOME/desks/news/news.json`, and `breaking.json` there when it exists. One file: prints `valid` (exit 0) or `invalid: <path>` and each reason (exit 1). Several files: `valid: <path>` per good file, and exit 1 if any failed. Relative paths are taken from where the command was typed, even through `npm run` (INIT_CWD). Up to 20 reasons per file are shown, then "…and N more" ("at least N" when the validator stopped at 100). An unknown option prints the usage and exits 1. It sets `process.exitCode` rather than calling `process.exit()`, so a long report always finishes writing to a pipe. `npm run validate-feed` is unchanged.

**Review fixes, round 1 (after the tester passed N2).** Each has tests. Items 4, 6 and 7 were refined in round 2 below.
1. File kind: the name decides first. `breaking.json` is a breaking story; `news.json`, or any file whose folder is `editions/`, is an edition; any other file is a breaking story unless it has a `stories` key. `at` no longer decides, so the CLI and `checkNewsFile` (what the server uses) agree on an edition with an extra `at`, and a breaking draft missing `at` is told `breaking: missing required field "at"`.
2. Repeated links: a story may not list the same page twice, compared as `new URL(u).href` without the `#fragment` (so capitals in the site, `:443` or a bare `/` don't make a new page): `stories[0].sources[1].url: same link as sources[0]; a story needs 2 different sources`. Only links that passed the link checks are compared, so a bad link gets one line.
3. Sources cap: `maxItems` stays 8; the brief (step 7) and the schema description now both say at least 2, at most 8, keep the 8 strongest, and the too-many message ends "keep the 8 strongest". A test reads both files.
4. Passwords: user info is checked before anything else about a link. `hideUserInfo` reads a link the way the WHATWG parser does (drops tabs and newlines, skips any run of `/` and `\` after the scheme, any scheme or none), in linear time, and every quoted link goes through it, including the schema's `^https://` message (any field named `url`). Empty user info like `https:///@host` is refused.
5. Runaway files: `schemaErrors` de-duplicates with a Set and stops at 100 lines, and both validators return at most 100 (`MAX_ERRORS`). Before ajv runs, any list over 50 items (`GUARD_ITEMS`: stories, more, a story's sources, breaking sources, Product Feed articles and themes) is refused with one line, and nothing else is checked. `more` with 100,000 `{}` now takes under a millisecond (3,000 took 845 ms before). So the guard matches the contract, `feed.schema.json` now caps `themes` at 50 (the sample has 6). A single article's `themes` list isn't guarded: checking it is linear (250,000 entries take about 50 ms) and the output is capped.
6. Lookalike sites: the site as written must be plain ASCII letters, digits, dots and dashes (`xn--` punycode is fine), equal (ignoring case) to `new URL(u).hostname`, and not an IP address (v4 or v6). That refuses slash lookalikes (U+2215, U+2044), fullwidth and mixed-script names, percent-encoding, and numeric forms like `0x7f.1` or `2130706433`, with the message `must name its site in plain letters, digits, dots and dashes (xn-- for other alphabets), not as an IP address`. This tightens Product Feed too: `https://bücher.de/` is now refused (write `https://xn--bcher-kva.de/`). A backslash anywhere in a link is refused (browsers read it as `/`).
7. Hidden characters: `show()` and `plain()` escape C1 controls, DEL and the invisible or direction-changing characters (U+061C, U+200B to U+200F, U+2028 to U+202E, U+2060 to U+2069, U+FEFF), and links containing any of them are refused.
8. `withoutSample` lives only in `schema-common.js`; `server/feed.js` imports it.

**Review fixes, round 2 (after the re-check).** Each has tests.
1. Hiding passwords anywhere: `show()` now hides user info in every quoted value, anywhere in it. The value is split at `/`, `?` and `#` (never at `\`, which can be part of a user name, as in `ssh://git:hunt\er2@host`), and in each piece everything before its last `@` becomes `***`. That covers a link after invisible characters, `Source: https://u:p@x.com`, a second link, and any field. I split on fewer characters than the review suggested (not on spaces, quotes or brackets), because the URL parser keeps those inside user info (`https://user:p w@host`), so splitting there could print part of a password. Over-hiding inside an error message is fine (`?by=a@b` shows as `?***@b`). `hasUserInfo` still uses the exact URL-parser reading to decide whether a link is refused. V8's quoted snippet is dropped from "not valid JSON (...)" messages (`not valid JSON (Unexpected token 'h')`).
2. Article themes: `feed.schema.json` caps `articles[].themes` at 10 with `uniqueItems`, and the guard refuses an over-50 list before ajv runs (250,000 themes: instant). A repeated theme reads `articles[1].themes: lists "evals" twice (items 0 and 2)`.
3. Invisible characters by Unicode property: escaping, the link check and the blank-text check use `[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]` (tag characters, soft hyphen, invisible operators, variation selectors, Hangul fillers). Escapes go by code point (`\u00ad`, `\u{e0041}`). `cut()` counts code points, so no lone surrogates. Both CLIs print paths through `plain()`.
4. `linkKey` keeps route fragments (`#/...`, `#!...`), and drops `utm_*` parameters, an empty `?`, and a trailing dot on the site. Other parameters keep their order.
5. `localhost`, `*.localhost` and one-word site names (no dot) are refused with the site message, which now reads `must name a public site like example.com in plain letters, digits, dots, dashes or underscores (xn-- for other alphabets), not localhost or an IP address`.
6. Underscores in site names (`my_bucket.s3.amazonaws.com`) and an empty port (`example.com:/x`) are accepted; the written name must still equal `url.hostname`, and the IP check still runs.
7. A backslash or hidden character in a link gets its own message: `must not contain a backslash or hidden characters`. Spaces keep the "whole link ... no spaces" message.
8. The 51+ cutoff lines carry the same hint as the normal messages: `(keep the 8 strongest)` for sources, `(leave the weakest out)` for more, `(the top 3 go in stories, up to 7 more in more)` for stories.
9. A News text field (headline, summary, why, skeptic, source name) made only of invisible characters counts as empty: the schema pattern is now `VISIBLE_CHAR_PATTERN` from `schema-common.js`, and a test keeps them identical. A note made only of invisible characters doesn't explain fewer than 3 stories.
10. Brief step 7 says what `id`, `rank` (1 to 10) and `note` hold; the schema now caps `rank` at 10 to match.

**Review fixes, round 3 (closing check).** Each has tests.
1. A password with a raw `/`, `?` or `#` is hidden too: `hideUserInfo` now hides everything from just after the first `//` (or from the start, when no `//` comes before it) to the last `@` in the value. So `https://AKIA...:wJal.../K7MD.../bPx...@bucket.example.com/report` prints as `https://***@bucket.example.com/report`, and `admin:p/w@corp` as `***@corp`. That replaces round 2's split-into-pieces rule. It over-hides more (`https://example.com/@snow` shows as `https://***@snow`), which is fine in a message, and it's linear. Detection is unchanged: to the URL parser such a link isn't user info (a raw `/` ends the site part), so it fails as a broken link, still with the password hidden.
2. Blank-looking text counts as empty: `VISIBLE_CHAR_PATTERN` (identical in the schema and the code) also excludes `\p{M}` (combining marks alone, U+16FE4), `\p{Co}` (private use), U+2800 braille blank, U+1D159 null notehead and the Hangul fillers U+3164, U+FFA0, U+115F, U+1160.
3. `state-store.js` builds its "not valid JSON" message with `jsonErrorText` (shared with `readJsonFile`: no quoted snippet, user info hidden, escaped), so a corrupt `state.json` can't put control bytes or a password in `the-desk.log`. The raw BOM in its regex is now an escape.
4. `validate-news` prints an unknown option through `plain()`.
5. The hidden-character link message ends `(percent-encode them, e.g. %E2%80%8C)`.
6. `validateFeed` on a file whose `desk` is `"news"` starts with `this looks like a News file: run npm run validate-news`, and, the other way round, `validateNews` on a `"product-feed"` file starts with `this looks like a Product Feed file: run npm run validate-feed`.

**Worth knowing (for S5).** These review rounds tightened the Product Feed contract too, so the Product Feed agent's brief should say:
- Article links: no user name or password; the site written in plain ASCII (other alphabets as `xn--` punycode); no IP addresses, `localhost` or one-word sites; no backslashes, spaces or hidden characters (percent-encode them).
- `themes` at most 50; each article's `themes` at most 10, each listed once.
- The sample feed (`prototype/feed.json`) passes all of these.

**For N3 and later.**
- Story ids repeat every day (`s1` each morning), so N3's read state should key stories by edition and id (for example `2026-12-07/s1`), and a breaking story by its `at`.
- N3 decides "breaking is from today" from `at`; every accepted form parses with `Date.parse`.
- `agents/news/AGENTS.md` step 9 and the breaking section now give the real command. N9 should pin the folder the agent runs it from (likely N1's main-only live copy).

## N3. News server routes

**Routes** (all JSON, `Cache-Control: no-store`, refused with 403 unless the Host is `localhost:<port>` or `127.0.0.1:<port>`, like every route):

| Route | Answer |
| --- | --- |
| `GET /api/news` | The morning edition. `X-Desk-News-Source`: `live`, `last-good`, `edition:<YYYY-MM-DD.json>` or `sample`. HEAD too; other methods 405. |
| `GET /api/breaking` | `{"breaking": <story with at>}` when `desks/news/breaking.json` is valid and its `at` falls on today in Toronto, else `{"breaking": null}`. Never 404 or 500 for a missing or broken file. |
| `GET` / `PUT /api/news/state` | Snow's News state in `desks/news/state.json`. |
| `GET /api/feed`, `GET` / `PUT /api/state` | Product Feed, unchanged (`X-Desk-Feed-Source` keeps its values). |

**Fallback order, both desks** (`server/edition-loader.js`, used by `feed.js` and `news.js`):
1. `live`: the agent's `news.json` / `feed.json`, when it passes the contract (`checkNewsFile` / `checkFeedFile`).
2. `last-good`: the last valid live file this server served. In memory, and on disk as `last-good.json` next to the live file. After a restart it's read from disk and checked against the contract again; a damaged one is logged once per change and skipped.
3. `edition:<file>`: the newest valid `editions/YYYY-MM-DD.json`, by the date in the name. Other names (`latest.json`, `.bak`, a folder) are ignored; invalid files are logged once per change and skipped. Only the newest 60 dated names are looked at (`MAX_EDITION_FILES`, two months of mornings), with one info line while there are more. **It wins over last-good when its `edition` date is later** (the `edition` inside, compared with last-good's), so an old `last-good.json` never hides a newer edition the agent archived; on the same date, last-good (what Snow was shown) stays.
4. `sample`: News `data/samples/news.sample.json`, Product Feed `prototype/feed.json`, with `"sample": true` added by the server. Every agent file (live, last-good, editions, breaking) comes back without a `sample` key.

As in Sprint 1, a file is re-read only when its stat changes, and each change is logged once (an invalid live file names what is shown instead). Log lines quote agent values only through the `schema-common.js` helpers. While the live file is broken, each request also lists `editions/` (one readdir plus at most 60 stats), since a newer archived edition can now replace last-good.

**Files The Desk writes into `desks/news/`** (and the same two into `desks/product-feed/`):
- `last-good.json`: a byte-for-byte copy of the live file as it was read and checked (`readJsonFile` now returns the bytes; `checkNewsFile` and `checkFeedFile` pass them through on a valid file). So it's exactly as big as a file that passed the 1 MB limit, and keeps the agent's formatting (BOM, tabs, CRLF). Any `sample` key in it is dropped again when it's read back. Written whenever a valid live file is served and `last-good.json` doesn't already hold those exact bytes. That covers a new edition and also a `last-good.json` deleted or damaged while the live file stayed the same; a request costs one extra stat. Atomic (temp file `.last-good.json.<random>.tmp` in the same folder, fsync, rename, folder fsync: `server/atomic-file.js`, shared with the state store), one write at a time, mode 0600. A failed write is logged once per change (`couldn't keep a copy of the <date> edition in .../last-good.json (ENOSPC)`) and the live edition is still served. The sample is never written there.
- `state.json`: on `PUT /api/news/state`.
- Never `news.json`, `breaking.json` or `editions/`: those are the agent's. N9's brief could say "leave `last-good.json` and `state.json` alone".

This closes the Sprint 1 follow-up: a restart with a bad `feed.json` and no `editions/` now shows the last good edition, not the sample.

**Breaking: "today in Toronto".** `Date.parse(at)` (every form the contract accepts parses), then the calendar day of that moment in `America/Toronto` (`Intl.DateTimeFormat`, so the machine's `TZ` doesn't matter; a test runs it under UTC, Asia/Tokyo, Pacific/Kiritimati and Pacific/Pago_Pago), compared with today's Toronto day. So `2026-12-08T01:30:00+09:00` is today on 7 Dec in Toronto, `2026-12-07T02:00:00Z` is yesterday evening there, and anything dated tomorrow or later is not shown. Missing, old or future files are silent; an invalid one is logged once per change. Yesterday's story stops showing at Toronto midnight without the file changing. `createServer({ now })` sets the clock for tests.

**State** (`server/state-store.js`). `createStateStore(deskHome, desk)` now takes the desk name and saves to `desks/<desk>/state.json`; Product Feed and News share the same code (1 MB cap, 415 unless `application/json`, 400 for a non-object or a known key with the wrong shape, unknown keys kept, atomic queued writes, and `GET` answers 500 and leaves the file alone when it's not a JSON object, so the page knows not to save over it). `/api/state` is unchanged. The rules per desk are in `STATE_RULES`; `checkState(value, desk = 'product-feed')`.

News keys:
- `read`: `{ "<edition>/<story id>": time }`, for example `{ "2026-12-07/s1": "2026-12-07T13:05:00.000Z" }`. Keys must be a real date, `/`, and a story id (`[A-Za-z0-9_-]{1,40}`), because ids repeat every morning.
- `dismissed`: `{ "<breaking at>": time }`, keyed by the breaking story's `at` exactly as served.
- `shelfOpen`: `true` or `false`.
- A time is an ISO date-time with a timezone (what `toISOString()` gives) or a number (`Date.now()`).
- Error answers name the problem: `read keys must be "<edition>/<story id>", like "2026-12-07/s1" (got "s1")`, `read["2026-12-07/s1"] must be an ISO time or a number`, `shelfOpen must be true or false`.
- XP and the streak stay in Product Feed's state: N4 awards them with `PUT /api/state`.

**Sample edition** (`data/samples/news.sample.json`, for N4's screenshots and N7). Edition `2026-12-07`, empty note, 3 stories and 7 on the shelf, ranks 1 to 10, every region and kind. The top 3 and five shelf headlines are the approved design's; every headline starts with `[Sample]`, actors are generic, and every source is a section or home page from `agents/news/sources.yaml` (no invented article links, no person's blog). `data/samples/breaking.sample.json` is a valid `[Sample]` breaking story (`at` 2026-12-07 12:04 Toronto) for screenshots and tests only: the server never reads it. To show the banner on a test Desk, copy it to `$DESK_HOME/desks/news/breaking.json` with `at` set to today. Tests check both pass the contract and the rules above.

**Review fixes (after the tester passed N3).** Each has tests.
1. A newer valid file in `editions/` wins over an older `last-good.json` (by `edition` date), for News and Product Feed, after a restart and in memory alike.
2. `last-good.json` is the live file's exact bytes, not `JSON.stringify(value, null, 2)`: pretty-printing a valid file near the 1 MB cap could push it over, so it would fail to save or be refused after a restart. `readJsonFile` also refuses a file that grew past the cap between its stat and its read.
3. `editions/`: only the newest 60 dated names are looked at, and the cache is pruned with a Set (was `names.includes()` in a loop).
4. Two regexes held a raw U+FEFF; they're escapes now, and a test scans `server/`, `scripts/`, `app/` and `test/` for raw control or invisible characters.

**Tests.** `test/news.test.js` (loader fallbacks, last-good writes and restarts, editions by name, the sample, once-per-change logging, Toronto dates, breaking, News state rules, the sample's content) and new blocks in `test/api.test.js` (each route over HTTP, restarts, 1 MB cap, corrupt state on disk, the Host check on every new route, security headers) and `test/feed.test.js` (Product Feed's last-good on disk).
