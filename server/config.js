// Where things live. Shared by the server and the scripts so they agree.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(REPO_ROOT, 'app');
export const SCHEMA_PATH = path.join(REPO_ROOT, 'data', 'schema', 'feed.schema.json');
export const NEWS_SCHEMA_PATH = path.join(REPO_ROOT, 'data', 'schema', 'news.schema.json');
export const BREAKING_SCHEMA_PATH = path.join(REPO_ROOT, 'data', 'schema', 'breaking.schema.json');
export const SAMPLE_FEED_PATH = path.join(REPO_ROOT, 'prototype', 'feed.json');
/** The News edition shown before the agent has written a valid one (marked "sample": true by the server). */
export const SAMPLE_NEWS_PATH = path.join(REPO_ROOT, 'data', 'samples', 'news.sample.json');
/** A breaking story for screenshots and tests only. The server never serves it as breaking news. */
export const SAMPLE_BREAKING_PATH = path.join(REPO_ROOT, 'data', 'samples', 'breaking.sample.json');

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

/** A desk's folder under DESK_HOME: desks/product-feed, desks/news. */
export function deskDir(deskHome, desk) {
  return path.join(deskHome, 'desks', desk);
}

export function productFeedDir(deskHome) {
  return deskDir(deskHome, 'product-feed');
}

export function feedPath(deskHome) {
  return path.join(productFeedDir(deskHome), 'feed.json');
}

/** Snow's saved state for a desk (Product Feed unless another desk is named). */
export function statePath(deskHome, desk = 'product-feed') {
  return path.join(deskDir(deskHome, desk), 'state.json');
}

/** The last valid edition The Desk served for a desk, kept so a restart doesn't lose it. */
export function lastGoodPath(deskHome, desk) {
  return path.join(deskDir(deskHome, desk), 'last-good.json');
}

/** The dated copies of a desk's editions: editions/YYYY-MM-DD.json. */
export function editionsDir(deskHome, desk) {
  return path.join(deskDir(deskHome, desk), 'editions');
}

export function newsDir(deskHome) {
  return deskDir(deskHome, 'news');
}

/** The News agent's morning edition. */
export function newsPath(deskHome) {
  return path.join(newsDir(deskHome), 'news.json');
}

/** The News agent's breaking story, when there is one. */
export function breakingPath(deskHome) {
  return path.join(newsDir(deskHome), 'breaking.json');
}
