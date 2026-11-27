# Sprint 2: build decisions (lead dev)

Technical notes for the team. Snow doesn't need to read this.

## N2. News contract: schemas and validator

**Files.** `data/schema/news.schema.json` (the morning edition) and `data/schema/breaking.schema.json` (one breaking story), JSON Schema 2020-12. `server/news-schema.js` is the validator, shared by `npm run validate-news` now and by the server from N3. `server/schema-common.js` holds what Product Feed and News share (ajv setup, error wording, file reading, date and link checks); `server/feed-schema.js` now uses it, with every Product Feed message unchanged. Fixtures for tests and N3: `test/fixtures/news/news.json` (3 stories, 2 on the shelf, every region and kind) and `test/fixtures/news/breaking.json`. Paths: `newsDir`, `newsPath`, `breakingPath` in `server/config.js`.

**The schemas.**
- Edition: `desk` is `"news"`, `edition` is `YYYY-MM-DD`, `stories` 0 to 3, `more` 0 to 7. `desk`, `edition` and `stories` are required; `note` (max 300) and `more` are optional and mean `""` and `[]` when absent, the same way Product Feed treats `note`.
- Story (`$defs/story`): `id` (`^[A-Za-z0-9_-]{1,40}$`, safe as a state key or DOM id), `rank` (integer from 1), `headline` 160, `summary` 700, `why` 300, `skeptic` 500 (each must have a non-space character, pattern `\S`), `date` (`""` or `YYYY-MM-DD`), `region` and `kind` enums, `sources` 2 to 8 of `{ name (max 80, not blank), url (^https://) }`. Every field is required, `rank` included, so a breaking story really is "the same shape".
- Breaking: `"$ref": "news.schema.json#/$defs/story"` plus a required `at`. The validator registers the edition schema with ajv first so the reference resolves. `at` is ISO 8601 with a timezone (`Z` or `±HH:MM`); seconds and fractions are optional. ajv-formats isn't installed (strict mode refuses `format` without it), so `at` uses a pattern, and `schema-common.js` exports the same regex (`DATE_TIME_PARTS`); a test keeps them identical.
- `additionalProperties: true`, as in `feed.schema.json`: an agent that adds a field (a tag, an author on a source) shouldn't take the desk down for the day, and the page only ever renders the fields it knows, as escaped text. It's written out on the edition, story, source and breaking objects so the agent reading the schema sees it.

**Rules on top of the schema** (in `news-schema.js`, checked only on values that passed their pattern, so each value gets one line):
- fewer than 3 `stories` needs a `note` that isn't blank: `note: must say why there are fewer than 3 stories (stories has 2)`. 0 stories with a note is allowed.
- ids are unique across `stories` and `more`, ranks unique across the whole edition: `more[1].id: duplicate id "s2" (also used by stories[1])`.
- `edition` and story `date` are real calendar days; `at` is a real moment (hours 0-23, minutes and seconds 0-59, offset at most 14:59).
- links are whole `https://` links (they parse, name a site, no spaces), with no user name or password before the site name. `https://user@host/`, `https://:pw@host/` and even an empty `https://@host/` are refused; an `@` later in the link (`/@snow`, `?by=a@b`) is fine. The message shows the link as `https://***@host/...`, so a password never reaches the terminal or `the-desk.log`.
- Error wording comes from `schema-common.js`: lists say what they hold (`stories[1].sources: needs at least 2 sources (has 1)`, `stories: can have at most 3 stories (has 4); the top 3 go in stories, up to 7 more in more`), enums list the allowed values, and untrusted values are quoted with control characters escaped and cut at 60 characters.

**Product Feed follow-up from Sprint 1.** The same user-name/password rule now applies to Product Feed article links (`isHttpsLink` refuses them too). Tests in `test/feed-schema.test.js`. The front end's own `safeUrl` in `app/lib.js` still allows user info; the server never serves such a link now, but N4 could tighten `safeUrl` to match for defence in depth.

**`sample`.** Same as Product Feed: only The Desk may mark an edition as a sample. The schema doesn't fail a file because of a `sample` key (extra keys are allowed); `checkNewsFile`, `checkBreakingFile` and `checkNewsDeskFile` return a valid file with `sample` removed (`withoutSample` in `schema-common.js`). N3's loader should use those results, then add `sample: true` only to its own fallback (N7's sample edition).

**CLI.** `npm run validate-news [file ...]`, in the style of `validate-feed`. A file named `breaking.json`, or one with an `at` field, is checked against the breaking schema, and its failure header says `(checked as a breaking story)`; anything else is an edition. With no file it checks `$DESK_HOME/desks/news/news.json`, and `breaking.json` there when it exists. One file: prints `valid` (exit 0) or `invalid: <path>` and each reason (exit 1). Several files: `valid: <path>` per good file, and exit 1 if any failed. Relative paths are taken from where the command was typed, even through `npm run` (INIT_CWD). Up to 20 reasons per file are shown. An unknown option prints the usage and exits 1. It sets `process.exitCode` rather than calling `process.exit()`, so a long report always finishes writing to a pipe. `npm run validate-feed` is unchanged.

**For N3 and later.**
- Story ids repeat every day (`s1` each morning), so N3's read state should key stories by edition and id (for example `2026-12-07/s1`), and a breaking story by its `at`.
- N3 decides "breaking is from today" from `at`; every accepted form parses with `Date.parse`.
- `agents/news/AGENTS.md` step 9 and the breaking section now give the real command. N9 should pin the folder the agent runs it from (likely N1's main-only live copy).
