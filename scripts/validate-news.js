#!/usr/bin/env node
// npm run validate-news [file ...]
// Checks News desk files against the News contract in server/news-schema.js: the same check the
// server makes before it serves them. breaking.json is checked as a breaking story
// (data/schema/breaking.schema.json); news.json, or any file in an editions/ folder, as a morning
// edition (data/schema/news.schema.json); any other file as a breaking story unless it has "stories".
// With no file it checks $DESK_HOME/desks/news/news.json (DESK_HOME defaults to ~/agent-house),
// and breaking.json there too when it exists.
// A relative path is taken from where the command was typed, even through `npm run`.
// One file: prints "valid" and exits 0, or prints the problems and exits 1.
// More than one: prints "valid: <file>" or the problems for each, and exits 1 if any failed.
import fs from 'node:fs';
import path from 'node:path';
import { checkNewsDeskFile } from '../server/news-schema.js';
import { MAX_ERRORS, plain } from '../server/schema-common.js';
import { breakingPath, newsPath, resolveDeskHome } from '../server/config.js';

const MAX_SHOWN = 20;
const USAGE = 'Usage: npm run validate-news [path/to/news.json or breaking.json ...]';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  console.log('Default: $DESK_HOME/desks/news/news.json, plus breaking.json there if it exists (DESK_HOME defaults to ~/agent-house)');
  console.log('breaking.json is checked as a breaking story; news.json, or a file in editions/, as an edition;');
  console.log('any other file as a breaking story unless it has "stories".');
  process.exit(0);
}
const unknown = args.find((a) => a.startsWith('-'));
if (unknown) {
  console.error(`${USAGE}\nUnknown option: ${JSON.stringify(unknown)}`);
  process.exit(1);
}

// `npm run` moves to the repo root; INIT_CWD is where the user actually typed the command,
// so a relative path means what they expect.
const viaNpm = process.env.npm_lifecycle_event === 'validate-news' && process.env.INIT_CWD;
const baseDir = viaNpm ? process.env.INIT_CWD : process.cwd();

function defaultFiles() {
  const deskHome = resolveDeskHome();
  const files = [newsPath(deskHome)];
  if (fs.existsSync(breakingPath(deskHome))) files.push(breakingPath(deskHome));
  return files;
}

const files = args.length ? args.map((a) => path.resolve(baseDir, a)) : defaultFiles();
const named = files.length > 1;
let failed = false;

for (const file of files) {
  const { ok, errors, kind } = await checkNewsDeskFile(file);
  if (ok) {
    console.log(named ? `valid: ${plain(file, Infinity)}` : 'valid');
    continue;
  }
  failed = true;
  // File-level problems start with the path; the header already names it.
  // The path is printed through plain(), so a file name can't carry control or bidi characters to the terminal.
  const lines = [`invalid: ${plain(file, Infinity)}${kind === 'breaking' ? ' (checked as a breaking story)' : ''}`];
  for (const e of errors.slice(0, MAX_SHOWN)) lines.push(`  - ${e.startsWith(`${file}: `) ? e.slice(file.length + 2) : e}`);
  // The validator lists at most MAX_ERRORS problems; a full list means there may be more.
  if (errors.length > MAX_SHOWN) lines.push(`  …and ${errors.length >= MAX_ERRORS ? 'at least ' : ''}${errors.length - MAX_SHOWN} more`);
  console.error(lines.join('\n'));
}

// exitCode, not exit(): lets a long report finish writing to a pipe first.
process.exitCode = failed ? 1 : 0;
