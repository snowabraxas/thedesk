// Static checks on app/ that need no browser. (The look itself is checked with scripts/screens.js.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { APP_DIR } from '../server/config.js';

const read = (file) => fs.readFileSync(path.join(APP_DIR, file), 'utf8');

/** Every selector whose rule sets the given declaration (comments removed, media blocks included). */
function selectorsWith(css, declaration) {
  const found = new Set();
  for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (declaration.test(body)) selectors.split(',').forEach((s) => found.add(s.trim()));
  }
  return found;
}

describe('app/style.css', () => {
  test('a very long word in agent or note text wraps instead of widening the page', () => {
    const wraps = selectorsWith(read('style.css'), /overflow-wrap\s*:\s*anywhere/);
    const needed = {
      'article title': '.art h3',
      'summary and why': '.art p',
      'meta line': '.art .meta',
      'tag chips': '.tagchip',
      'drawer title': '.drawer h3',
      'note text in the drawer': '.notes li p',
      'note text in My notes': '.notecard p',
    };
    for (const [what, selector] of Object.entries(needed)) assert.ok(wraps.has(selector), `${what} (${selector})`);
  });

  test('the feed rise animation lets go of its transform when it ends, so the toast and drawer stay on screen', () => {
    // A fill that holds the end keyframe keeps #feed the containing block of its position:fixed
    // children (#toast2, #drawer, #scrim): they would land at the bottom of the page.
    const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const feedRules = [...css.matchAll(/(?:^|})\s*\.feed\s*\{([^{}]*)\}/g)].map((m) => m[1]);
    const animations = feedRules.flatMap((body) => [...body.matchAll(/animation\s*:\s*([^;}]*)/g)].map((m) => m[1]));
    assert.ok(animations.some((a) => /\brise\b/.test(a)), 'the feed still rises in');
    for (const a of animations) assert.doesNotMatch(a, /\b(both|forwards)\b/, `.feed animation: ${a}`);
  });
});

describe('app/app.js', () => {
  test('XP and badge toasts say "not saved" while saving is paused', () => {
    assert.match(read('app.js'), /toast\(awardText\(\{[^}]*saved: store\.canSave \}\)\)/);
  });
});
