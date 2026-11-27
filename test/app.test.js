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
      'News headline': '.nstory h3',
      'News summary, why and skeptic': '.nstory p',
      'News shelf headline': '.nitemtitle',
      'News shelf summary, why and skeptic': '.nitem p',
      'News source names': '.nsrcs a',
      'News refused links, shown as text': '.nsrc-plain',
      'News region and kind tags': '.ntag',
      'News kind counts': '.nkinds li',
      'breaking headline': '.nbhead',
      "the News agent's note": '.nnote',
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
    for (const id of ['toast', 'drawer', 'scrim', 'rail', 'newsRail']) {
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
    for (const file of ['style.css', 'app.js', 'news.js', 'news-html.js', 'news-lib.js', 'index.html', 'favicon.svg']) {
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
    for (const file of ['app.js', 'news.js', 'news-html.js']) assert.doesNotMatch(read(file), /Caveat|font-hand/, `no handwriting set from ${file}`);
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

  test("the News desk's one opening motion, the TV warm-up, is under a second and invisible at rest", () => {
    const css = read('style.css');
    const glow = rulesFor(css, '.backdrop[data-view=news]::after').join(';');
    const [, name, seconds] = glow.match(/animation\s*:\s*(\w+)\s+([\d.]+)s/) || [];
    assert.equal(name, 'tvwarm');
    assert.ok(Number(seconds) > 0 && Number(seconds) < 1, `the warm-up takes ${seconds}s`);
    assert.doesNotMatch(glow, /infinite/, 'it plays once per opening');
    assert.match(glow, /(^|;)\s*opacity\s*:\s*0\s*(;|$)/, 'without animation (reduced motion) the glow never shows');
    assert.match(glow, /pointer-events\s*:\s*none/);
    const frames = stripCssComments(css).match(/@keyframes tvwarm\{(.*?)\}\}/)[1];
    assert.match(frames, /100%\{opacity:0/, 'it ends invisible');
    assert.equal(rulesFor(css, '.news').some((b) => /animation/.test(b)), false, 'the News page has no second opening motion');
  });

  test('News focus rings are outline only (a box-shadow ring paints a bar across wrapped lines)', () => {
    const css = read('style.css');
    const ring = rulesFor(css, '#news :focus-visible').join(';');
    assert.match(ring, /outline\s*:\s*3px solid/);
    assert.match(ring, /outline-offset\s*:\s*\dpx/);
    assert.match(ring, /box-shadow\s*:\s*none/);
    assert.match(rulesFor(css, '#news .frost :focus-visible').join(';'), /outline-color\s*:\s*var\(--midnight-green\)/, 'dark ring on frost');
    for (const s of selectorsWith(css, /box-shadow/)) assert.ok(!(s.startsWith('#news') && s.includes(':focus')) || s === '#news :focus-visible', `${s} sets a box-shadow ring`);
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

  test("the top stories heading leaves room for its focus ring when the rail scrolls to it", () => {
    const m = rulesFor(read('style.css'), '#newsTopTitle').join(';').match(/scroll-margin-top\s*:\s*(\d+)px/);
    assert.ok(m && Number(m[1]) >= 16, 'scroll-margin-top of at least 16px (ring: 3px wide, 4px out)');
  });

  test("the TV's warm-up glow stays soft enough for 4.5:1 at night (reviewer's measured stops)", () => {
    const glow = rulesFor(read('style.css'), '.backdrop[data-view=news]::after').join(';');
    assert.match(glow, /rgba\(var\(--tv-glow\),\.3\),rgba\(var\(--tv-glow\),\.06\) 45%,rgba\(var\(--tv-glow\),0\) 80%/);
  });

  test('buttons are at least 44px tall', () => {
    const css = read('style.css');
    const px = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+)px`)); return m ? Number(m[1]) : 0; };
    for (const s of ['.act', '.ab', '.addbtn', '.rb', '.shelf>button.s', '.shelf .mini', '.shelf.confirm button', '.x', '.toast button', '.notes li button', '.chip', '.notecard .on button', '.nbx', '#newsMoreBtn', '.nitembtn', '.nsrcs a', '.nbreaking a']) {
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

  test('the News desk is its own hidden section, with its h1, a way back to the room, and a closed shelf', () => {
    const html = read('index.html');
    assert.match(html, /<section id="news" class="view news" hidden aria-labelledby="newsTitle">/);
    assert.match(html, /<h1 id="newsTitle">/);
    assert.match(html, /<nav class="rail glass" id="newsRail" aria-label="News sections">\s*<a class="rb back" href="#" aria-label="Back to the room"/);
    assert.match(html, /<button type="button" id="newsMoreBtn" aria-expanded="false" aria-controls="newsMoreList">/);
    assert.match(html, /<ul class="nmore" id="newsMoreList" hidden><\/ul>/);
    assert.match(html, /<h2 id="newsLensesTitle">Lenses arrive in Phase 2<\/h2>/);
    // Lenses on the rail is a promise, not a control: an image with a name, never a link or button.
    assert.match(html, /<span class="rb soon" role="img" aria-label="Lenses, coming in Phase 2"/);
  });

  test('the News page has one h1, then h2 for each section (h3 is for headlines, drawn from the edition)', () => {
    const news = read('index.html').match(/<section id="news"[\s\S]*?\n<\/section>/)[0];
    assert.equal((news.match(/<h1\b/g) || []).length, 1);
    assert.equal((news.match(/<h3\b/g) || []).length, 0);
    assert.deepEqual([...news.matchAll(/<h2\b[^>]*id="(\w+)"/g)].map((m) => m[1]), ['newsTopTitle', 'newsMoreTitle', 'newsGlanceTitle', 'newsRegionsTitle', 'newsKindsTitle', 'newsLensesTitle']);
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

  test('the TV opens the News desk with the same zoom as the laptop, and #news is routed like #feed', () => {
    const js = read('app.js');
    assert.match(js, /\{ id: 'news', name: 'News', [^}]*go: 'news' \}/);
    assert.match(js, /\{ id: 'feed', name: 'Product Feed', [^}]*go: 'feed' \}/);
    assert.match(js, /if \(o\.go\) return openDesk\(o\.go\);/);
    assert.match(js, /function openDesk\(desk\) \{ \$\('#frame'\)\.dataset\.zoom = desk; \$\('#frame'\)\.classList\.add\('zoom'\); setTimeout\(\(\) => \{ location\.hash = desk; \}, 750\); \}/);
    assert.match(js, /const DESK_VIEWS = \{ '#feed': 'feed', '#news': 'news' \};/);
    assert.match(js, /\$\('#feed'\)\.hidden = view !== 'feed'; \$\('#news'\)\.hidden = view !== 'news'; \$\('#room'\)\.hidden = view !== 'room';/);
    assert.ok(selectorsWith(read('style.css'), /transform-origin/).has('.frame[data-zoom=news] .stage'), 'the zoom goes into the TV');
  });

  test('reading a News story pays through the same award() as the feed, once everything has loaded', () => {
    const js = read('app.js');
    assert.match(js, /const news = createNewsPage\(\{ award, toast, isReady: \(\) => ready, canAward: \(\) => store\.canSave, reloadXpState: reloadState \}\);/);
    assert.match(js, /Promise\.all\(\[loadState\(\), loadFeed\(\), news\.load\(\)\]\)\.then\(\(\) => \{ ready = true; renderAll\(\); \}\);/);
    const nj = read('news.js');
    assert.match(nj, /r = await readStory\(\(\) => N, key, \{ canPay, peek: \(\) => store\.peek\(\), also: reloadXpState \}\);[\s\S]*?store\.save\(\);\s*if \(r\.award\) award\(READ_XP, 'story read'\);\s*else if \(r\.read && sample\) toast\('Sample story: marked read, no XP\.'\);/);
    assert.match(nj, /const canPay = !sample && store\.canSave && canAward\(\);/, 'no XP for the sample, or when a state cannot be saved');
    assert.match(nj, /url: STATE_URL,\s*normalize: normalizeNewsState,\s*empty: blankNewsState,\s*merge: mergeNewsState,/);
    assert.match(nj, /const STATE_URL = '\/api\/news\/state';/);
  });

  test("two tabs: before paying, News checks the server's awarded and the latest XP; opening #news reloads both states", () => {
    const nj = read('news.js');
    assert.match(nj, /const \[state\] = await Promise\.all\(\[store\.reload\(\), reloadXpState\(\), loadEdition\(\), loadBreaking\(\)\]\);\s*if \(state\.ok\) N = state\.state;/);
    assert.match(read('app.js'), /async function reloadState\(\) \{\s*if \(!ready\) return;\s*const r = await store\.reload\(\);\s*if \(r\.ok\) S = r\.state;\s*\}/);
  });

  test('the Product Feed pays once per article: un-marking and re-marking does not pay again', () => {
    assert.match(read('app.js'), /if \(toggleArticleRead\(S, id\)\.award\) award\(10, 'article read'\); else save\(\);/);
    assert.doesNotMatch(read('app.js'), /S\.read\[id\] = Date\.now\(\)/);
  });

  test('the "where it happened" hint hides when there are no stories', () => {
    assert.match(read('index.html'), /<p class="hint" id="newsRegionsHint">US and China weighted highest; others by relevance\.<\/p>/);
    assert.match(read('news.js'), /\$\('#newsRegionsHint'\)\.hidden = !view\.glance\.regions\.length;/);
  });

  test('news.js puts agent text in the page only through textContent or news-html.js', () => {
    const nj = read('news.js');
    for (const [, value] of nj.matchAll(/\.innerHTML = ([^;]+);/g)) {
      assert.match(value, /^(show \? breakingHtml\(breakingView\(breaking\)\) : ''|n \? view\.top\.map\(storyCardHtml\)\.join\(''\) : noStoriesHtml\(!!news\)|more\.map\(\(s, i\) => shelfItemHtml\(s, i, openItems\.has\(`m\$\{i\}`\)\)\)\.join\(''\)|g\.(numbers|regions|kinds))$/, value);
    }
    assert.doesNotMatch(nj, /insertAdjacentHTML|outerHTML|document\.write/);
  });

  test('the "Sample picks" label shows only when the server marks the feed as a sample', () => {
    assert.match(read('app.js'), /feed\.sample === true \? '<span>Sample picks from real articles<\/span>' : ''/);
  });
});
