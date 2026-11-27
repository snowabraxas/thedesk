// <live copy>/.deployed.json: which commit `npm run deploy` put live, and when. Written by
// scripts/deploy.js, read by the server at start (for its log) and by `npm run service:status`.
// The file is plain text on disk, so it is checked and cleaned before anything prints it.
import fs from 'node:fs';
import path from 'node:path';

export const DEPLOYED_FILE = '.deployed.json';

export const deployedPath = (dir) => path.join(dir, DEPLOYED_FILE);

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/; // sha-1 or sha-256
const MAX_SUBJECT = 200;

/** Text that is safe to print on one line of a terminal or a log: no control characters, at most max long. */
export function oneLine(value, max = MAX_SUBJECT) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Builds the record for a deploy.
 * @param {{ sha: string, subject: string, ref?: string, deployedAt: string }} facts
 */
export function deployedRecord({ sha, subject, ref = 'main', deployedAt }) {
  return { sha, shortSha: sha.slice(0, 7), subject: oneLine(subject), ref, deployedAt };
}

/**
 * Reads dir/.deployed.json.
 * @returns {{ sha: string, shortSha: string, subject: string, ref: string, deployedAt: string } | null}
 *   null when there is none or it doesn't make sense. Never throws.
 */
export function readDeployed(dir, { fsImpl = fs } = {}) {
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(deployedPath(dir), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof raw.sha !== 'string' || !SHA.test(raw.sha)) return null;
  return {
    sha: raw.sha,
    shortSha: raw.sha.slice(0, 7),
    subject: oneLine(raw.subject),
    ref: oneLine(raw.ref, 60) || 'main',
    deployedAt: oneLine(raw.deployedAt, 40),
  };
}

/** `main @ 1a2b3c4 "Subject"`, the way deploy, status and the server log name a commit. */
export function describeDeployed(info) {
  return `${info.ref || 'main'} @ ${info.shortSha} "${info.subject}"`;
}
