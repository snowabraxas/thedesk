#!/usr/bin/env node
// npm run screens-home -- <dir>
//
// Makes a test DESK_HOME for screenshots (scripts/screens.js) and design checks:
//   - no News edition, so the server shows its sample (data/samples/news.sample.json)
//   - desks/news/breaking.json: data/samples/breaking.sample.json with `at` set to 08:30 today,
//     Toronto time, so the server serves it as today's breaking story and the banner shows
//   - no Product Feed edition, so the server shows its sample too
//
// Run it again on the same folder to move the breaking story to the new day. It only writes into a
// folder that is new, empty, or one it made before (it leaves a .screens-home marker), and never
// anywhere in ~/agent-house, Snow's real Desk data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SAMPLE_BREAKING_PATH, breakingPath, newsPath } from '../server/config.js';

const USAGE = 'Usage: node scripts/screens-home.js <dir>';
const MARKER = '.screens-home';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) { console.log(USAGE); process.exit(0); }
if (args.length !== 1 || args[0].startsWith('-')) { console.error(USAGE); process.exit(2); }

// `npm run` moves to the repo root; INIT_CWD is where the command was typed.
const viaNpm = process.env.npm_lifecycle_event === 'screens-home' && process.env.INIT_CWD;
const home = path.resolve(viaNpm ? process.env.INIT_CWD : process.cwd(), args[0]);

const realHome = path.join(os.homedir(), 'agent-house');
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
if (inside(home, realHome) || inside(realHome, home)) {
  console.error(`screens-home: refusing to write to ${home}: it is or holds ~/agent-house, Snow's real Desk data.`);
  process.exit(2);
}
if (fs.existsSync(home)) {
  const entries = fs.readdirSync(home);
  if (entries.length && !entries.includes(MARKER)) {
    console.error(`screens-home: ${home} already has files and wasn't made by this script. Pick a new or empty folder.`);
    process.exit(2);
  }
}

// Today's date and UTC offset in Toronto, e.g. 2026-11-27 and -05:00.
const now = new Date();
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const morning = new Date(`${day}T08:30:00Z`);
const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'longOffset' })
  .formatToParts(morning).find((p) => p.type === 'timeZoneName').value; // "GMT-05:00"
const offset = zone.replace('GMT', '') || '+00:00';

const breaking = JSON.parse(fs.readFileSync(SAMPLE_BREAKING_PATH, 'utf8'));
breaking.at = `${day}T08:30:00${offset}`;

fs.mkdirSync(path.dirname(breakingPath(home)), { recursive: true });
fs.writeFileSync(path.join(home, MARKER), 'Made by scripts/screens-home.js for screenshots. Safe to delete.\n');
fs.writeFileSync(breakingPath(home), `${JSON.stringify(breaking, null, 2)}\n`);
if (fs.existsSync(newsPath(home))) console.warn(`  (warning) ${newsPath(home)} exists, so the server shows it instead of the sample edition.`);

console.log(`Test Desk ready in ${home}`);
console.log(`  breaking story at ${breaking.at} (today in Toronto)`);
console.log(`  start it with: DESK_HOME="${home}" PORT=4423 node server/index.js`);
