// Static checks on app/ that need no browser. (The look itself is checked with scripts/screens.js.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { APP_DIR, REPO_ROOT } from '../server/config.js';

const read = (file) => fs.readFileSync(path.join(APP_DIR, file), 'utf8');
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector whose rule sets the given declaration (comments removed, media blocks included). */
function selectorsWith(css, declaration) {
  const found = new Set();
  for (const [, selectors, body] of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (declaration.test(body)) selectors.split(',').forEach((s) => found.add(s.trim()));
  }
  return found;
}

/** The body of every rule for exactly this selector (media blocks included). */
function rulesFor(css, selector) {
  const out = [];
  for (const [, selectors, body] of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.split(',').some((s) => s.trim() === selector)) out.push(body);
  }
  return out;
}

const VOID = new Set(['meta', 'link', 'img', 'input', 'br', 'hr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
/** The chain of ancestors (outermost first) of the element with this id in index.html, each as its simple selectors. */
function ancestorsOf(html, id) {
  const stack = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
  for (const [tag, close, name, attrs] of clean.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g).map((m) => [m[0], m[1], m[2].toLowerCase(), m[3]])) {
    if (close) {
      const i = stack.map((e) => e.name).lastIndexOf(name);
      if (i >= 0) stack.length = i;
      continue;
    }
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    const classMatch = attrs.match(/\bclass="([^"]+)"/);
    const el = {
      name,
      selectors: [name, ...(idMatch ? [`#${idMatch[1]}`] : []), ...(classMatch ? classMatch[1].split(/\s+/).filter(Boolean).map((c) => `.${c}`) : [])],
    };
    if (idMatch && idMatch[1] === id) return stack.map((e) => e.selectors);
    if (!VOID.has(name) && !tag.endsWith('/>')) stack.push(el);
  }
  throw new Error(`#${id} is not in index.html`);
}

const hexes = (text) => [...text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].map((m) => {
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return { text: m[0], rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) };
});
const rgbs = (text) => [...text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)].map((m) => ({ text: m[0], rgb: [m[1], m[2], m[3]].map(Number) }));
/** Amber or yellow: a hue between orange and yellow-green, clearly coloured, not near black. */
function isAmberOrYellow([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return false;
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return hue >= 30 && hue <= 70 && d / max > 0.35 && max > 80;
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
      "Wila's line (holds a theme and a source from the feed)": '.mentor',
    };
    for (const [what, selector] of Object.entries(needed)) assert.ok(wraps.has(selector), `${what} (${selector})`);
  });

  test('the toast, drawer, scrim and phone bar stay pinned to the screen', () => {
    // An ancestor with transform, filter, backdrop-filter (every glass and frost panel has one),
    // perspective, will-change or contain becomes the containing block of a position:fixed child,
    // which would then sit somewhere on the page instead of on the screen.
    const html = read('index.html');
    const css = read('style.css');
    for (const id of ['toast', 'drawer', 'scrim']) {
      assert.deepEqual(ancestorsOf(html, id).map((s) => s[0]), ['html', 'body'], `#${id} sits directly in <body>`);
    }
    const traps = selectorsWith(css, /(^|;|\s)(transform|filter|backdrop-filter|-webkit-backdrop-filter|perspective|will-change|contain)\s*:/);
    const holdsTransform = selectorsWith(css, /animation\s*:[^;}]*\b(both|forwards)\b/);
    for (const id of ['toast', 'drawer', 'scrim', 'rail']) {
      for (const selectors of ancestorsOf(html, id)) {
        for (const s of selectors) {
          assert.ok(!traps.has(s), `${s} (around #${id}) must not set transform, filter or backdrop-filter`);
          assert.ok(!holdsTransform.has(s), `${s} (around #${id}) must not hold an animation's end state`);
        }
      }
    }
  });

  test('the Lotus tokens are defined once, at the top, with the names and values from tokens.json', () => {
    const tokens = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/design/lotus/tokens.json'), 'utf8'));
    const root = stripCssComments(read('style.css')).match(/:root\s*\{([^}]*)\}/)[1];
    const defined = new Map([...root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const norm = (v) => v.replace(/\s+/g, '').toLowerCase();
    const groups = [tokens.color.tokens, tokens.spacing.tokens, tokens.radius.tokens, tokens.shadow.tokens, tokens.blur.tokens];
    for (const t of groups.flat()) {
      assert.ok(defined.has(t.name), `--${t.name} is defined in :root`);
      assert.equal(norm(defined.get(t.name)), norm(t.value), `--${t.name}`);
    }
    for (const [name, family] of Object.entries(tokens.type.families)) {
      assert.equal(norm(defined.get(`font-${name}`) || ''), norm(family), `--font-${name}`);
    }
    const all = stripCssComments(read('style.css'));
    assert.equal([...all.matchAll(/:root\s*\{/g)].length, 1, 'one :root block');
  });

  test('no amber or yellow anywhere in the app', () => {
    for (const file of ['style.css', 'app.js', 'index.html', 'favicon.svg']) {
      const text = read(file);
      for (const c of [...hexes(text), ...rgbs(text)]) assert.ok(!isAmberOrYellow(c.rgb), `${file}: ${c.text} is amber or yellow`);
    }
    const css = stripCssComments(read('style.css'));
    assert.doesNotMatch(css, /--amber|--wood|--leaf|--teal\b/, 'old palette tokens are gone');
    assert.doesNotMatch(css, /:\s*[^;{}]*\b(gold|yellow|orange|goldenrod|amber)\b/i, 'no named amber or yellow colours');
  });

  test("Caveat is only for Snow's own notes", () => {
    const hand = selectorsWith(read('style.css'), /font(-family)?\s*:[^;]*(var\(--font-hand\)|Caveat)/);
    assert.deepEqual([...hand].sort(), ['.notecard p', '.notes li p', '.pane textarea'].sort());
    assert.doesNotMatch(read('app.js'), /Caveat|font-hand/, 'no handwriting set from script');
  });

  test("the desk's one opening motion is under a second, and reduced motion turns every motion off", () => {
    const css = read('style.css');
    const caret = rulesFor(css, '.caret').join(';');
    const [, seconds] = caret.match(/animation\s*:\s*\w+\s+([\d.]+)s/) || [];
    assert.ok(Number(seconds) > 0 && Number(seconds) < 1, `caret blink takes ${seconds}s`);
    assert.doesNotMatch(caret, /infinite/, 'the cursor settles instead of blinking forever');
    assert.equal(rulesFor(css, '.feed').some((b) => /animation/.test(b)), false, 'the feed has no second opening motion');
    assert.match(stripCssComments(css), /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important/);
  });

  test('opening the page shows the study straight away: the backdrop only fades once it has settled', () => {
    const css = read('style.css');
    assert.equal(rulesFor(css, '.bd').some((b) => /transition/.test(b)), false, '.bd has no transition of its own');
    assert.ok(selectorsWith(css, /transition\s*:\s*opacity/).has('.backdrop.settled .bd'), 'the fade waits for .settled');
    assert.match(read('app.js'), /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \$\('#backdrop'\)\.classList\.add\('settled'\)\)\)/);
  });

  test('the toast only animates its fade and slide', () => {
    for (const body of rulesFor(read('style.css'), '.toast')) {
      const t = body.match(/transition\s*:\s*([^;}]*)/);
      if (t) assert.equal(t[1].split(',').map((x) => x.trim().split(/\s+/)[0]).sort().join(','), 'opacity,transform');
    }
  });

  test("Wila's orb is drawn from Lotus tokens only", () => {
    const orb = stripCssComments(read('style.css')).match(/--orb\s*:\s*([^;]+);/)[1];
    assert.doesNotMatch(orb, /#[0-9a-f]{3,6}\b/i, orb);
  });

  test("the note box prompt is app text (Inter); only what Snow types is in Caveat", () => {
    const ph = rulesFor(read('style.css'), '.pane textarea::placeholder').join(';');
    assert.match(ph, /var\(--font-sans\)/);
  });

  test('buttons are at least 44px tall', () => {
    const css = read('style.css');
    const px = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+)px`)); return m ? Number(m[1]) : 0; };
    for (const s of ['.act', '.ab', '.addbtn', '.rb', '.shelf>button.s', '.shelf .mini', '.shelf.confirm button', '.x', '.toast button', '.notes li button', '.chip', '.notecard .on button']) {
      const bodies = rulesFor(css, s);
      assert.ok(bodies.length, `${s} has a rule`);
      const tallest = Math.max(...bodies.map((b) => Math.max(px(b, 'min-height'), px(b, 'height'))));
      assert.ok(tallest >= 44, `${s} is ${tallest}px tall`);
    }
  });
});

describe('app/index.html', () => {
  test('the notes drawer is a modal dialog', () => {
    assert.match(read('index.html'), /<aside class="drawer frost" id="drawer" hidden role="dialog" aria-modal="true" aria-label="Article notes">/);
  });
});

describe('app/app.js', () => {
  test('pressing Enter to finish a rename does not press the rename button again', () => {
    // finishRename moves focus to the pencil during the key press; the default action must be cancelled.
    assert.match(read('app.js'), /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); finishRename\(inp, true\); \}/);
  });

  test('while the drawer is open, focus stays inside it and the page behind is inert', () => {
    const js = read('app.js');
    assert.match(js, /function setBehindDrawer\(off\) \{ \$\('#feed'\)\.inert = off; \$\('#room'\)\.inert = off; \}/);
    assert.match(js, /setBehindDrawer\(true\);[\s\S]*renderNotes\(\);[\s\S]*\$\('#noteText'\)\.focus/);
    assert.match(js, /\$\('#drawer'\)\.hidden = true; \$\('#scrim'\)\.hidden = true; setBehindDrawer\(false\); renderFeed\(\);/);
    assert.match(js, /if \(e\.key !== 'Tab' \|\| \$\('#drawer'\)\.hidden\) return;/);
  });

  test('XP and badge toasts say "not saved" while saving is paused', () => {
    assert.match(read('app.js'), /toast\(awardText\(\{[^}]*saved: store\.canSave \}\)\)/);
  });

  test("Wila's line on the feed is set as plain text", () => {
    assert.match(read('app.js'), /\$\('#mentorLine'\)\.textContent = mentorLine\(feed, S\);/);
  });

  test('the "Sample picks" label shows only when the server marks the feed as a sample', () => {
    assert.match(read('app.js'), /feed\.sample === true \? '<span>Sample picks from real articles<\/span>' : ''/);
  });
});
