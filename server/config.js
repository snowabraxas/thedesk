// Where things live. Shared by the server and the scripts so they agree.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(REPO_ROOT, 'app');
export const SCHEMA_PATH = path.join(REPO_ROOT, 'data', 'schema', 'feed.schema.json');
export const SAMPLE_FEED_PATH = path.join(REPO_ROOT, 'prototype', 'feed.json');

export const DEFAULT_PORT = 4321;
export const HOST = '127.0.0.1';

// The always-on service (scripts/service.js): a per-user launchd agent.
export const SERVICE_LABEL = 'local.thedesk.server';
export function servicePlistPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

// Expands a leading "~" so DESK_HOME=~/agent-house works even when no shell expanded it
// (for example inside a launchd plist).
export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function resolveDeskHome(env = process.env, home = os.homedir()) {
  const raw = (env.DESK_HOME || '').trim();
  return path.resolve(raw ? expandHome(raw, home) : path.join(home, 'agent-house'));
}

// The live copy: the folder the always-on service runs The Desk from. A git worktree of this repo
// that only ever holds committed main (npm run deploy moves it). It sits outside ~/Documents, which
// macOS guards, and outside ~/agent-house, where the desk agents write, so neither can touch the code.
// DESK_LIVE_DIR moves it (the tests use a temp folder).
export const LIVE_DIR_NAME = 'the-desk-live';
export function resolveLiveDir(env = process.env, home = os.homedir()) {
  const raw = (env.DESK_LIVE_DIR || '').trim();
  return path.resolve(raw ? expandHome(raw, home) : path.join(home, LIVE_DIR_NAME));
}

export function resolvePort(env = process.env) {
  const raw = (env.PORT ?? '').trim();
  if (raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) throw new Error(`PORT must be a number from 1 to 65535, got "${raw}"`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`PORT must be a number from 1 to 65535, got "${raw}"`);
  return port;
}

export function productFeedDir(deskHome) {
  return path.join(deskHome, 'desks', 'product-feed');
}

export function feedPath(deskHome) {
  return path.join(productFeedDir(deskHome), 'feed.json');
}

export function statePath(deskHome) {
  return path.join(productFeedDir(deskHome), 'state.json');
}
