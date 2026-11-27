#!/usr/bin/env node
// npm run validate-feed [path]
// Checks a Product Feed edition against data/schema/feed.schema.json.
// With no path it checks $DESK_HOME/desks/product-feed/feed.json (DESK_HOME defaults to ~/agent-house).
// Prints "valid" and exits 0, or prints the problems and exits 1.
import path from 'node:path';
import { checkFeedFile } from '../server/feed-schema.js';
import { feedPath, resolveDeskHome } from '../server/config.js';

const MAX_SHOWN = 20;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: npm run validate-feed [path/to/feed.json]');
  console.log('Default path: $DESK_HOME/desks/product-feed/feed.json (DESK_HOME defaults to ~/agent-house)');
  process.exit(0);
}
if (args.length > 1) {
  console.error('Usage: npm run validate-feed [path/to/feed.json] (one path at most)');
  process.exit(1);
}

// `npm run` moves to the repo root; INIT_CWD is where the user actually typed the command,
// so a relative path means what they expect.
const viaNpm = process.env.npm_lifecycle_event === 'validate-feed' && process.env.INIT_CWD;
const baseDir = viaNpm ? process.env.INIT_CWD : process.cwd();
const target = args[0] ? path.resolve(baseDir, args[0]) : feedPath(resolveDeskHome());

const { ok, errors } = await checkFeedFile(target);
if (ok) {
  console.log('valid');
  process.exit(0);
}

// File-level problems start with the path; the header already names it.
const lines = [`invalid: ${target}`];
for (const e of errors.slice(0, MAX_SHOWN)) lines.push(`  - ${e.startsWith(`${target}: `) ? e.slice(target.length + 2) : e}`);
if (errors.length > MAX_SHOWN) lines.push(`  …and ${errors.length - MAX_SHOWN} more`);
console.error(lines.join('\n'));
process.exit(1);
