#!/usr/bin/env node
// npm run screens -- <baseUrl> <outDir> [label] [--now=<ISO>|--now=real]
//
// Screenshots The Desk at 1440x900 (laptop) and 390x844 (phone), in morning, golden and night light:
//   <label>-room-<phase>-<width>.png          the room
//   <label>-feed-<phase>-<width>.png          the Product Feed, full page
//   <label>-feed-<phase>-<width>-screen.png   the Product Feed's first screen, as it opens
//   <label>-news-<phase>-<width>.png          the News desk, full page (skipped when the page has no #news)
//   <label>-news-<phase>-<width>-screen.png   the News desk's first screen
//   <label>-news-reading-<width>.png          News in the morning with story 1 marked read, the
//   <label>-news-reading-<width>-screen.png   shelf open and its first story expanded
//
// Example (the prototype, served on its own; it has no News desk):
//   python3 -m http.server 4400 --bind 127.0.0.1 --directory prototype
//   node scripts/screens.js http://127.0.0.1:4400 docs/screens/prototype prototype
//
// Example (the News desk with a breaking banner, on a test Desk; never port 4321):
//   node scripts/screens-home.js .tmp-design/home
//   DESK_HOME=.tmp-design/home PORT=4423 node server/index.js
//   node scripts/screens.js http://127.0.0.1:4423 docs/screens/news app
//
// Shots are made deterministic: reduced motion, Toronto time zone, en-CA locale and a frozen
// clock (default 2026-11-27 10:00 Toronto; --now=<ISO> to pick another, --now=real to use the
// real time). The desk pages are shot later in the day for golden (+6 h) and night (+10.5 h), so
// Wila's greeting fits the light; the Preview chip picks the plate either way. The phone viewport
// emulates a touch screen, so hover-only details look as they do on a phone.
//
// The shots never change the Desk they look at: saves (PUT /api/state, PUT /api/news/state) are
// answered by the script and never reach the server, so marking a story read pays no real XP.
//
// Exits 1 with a clear message if the page doesn't load, a console error or page error happens,
// a same-origin request fails, a font or image fails, or the room or a desk page never renders.
// Uses the installed Google Chrome (playwright-core, channel 'chrome'); no browser download.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const USAGE = 'Usage: node scripts/screens.js <baseUrl> <outDir> [label] [--now=<ISO>|--now=real]';
const VIEWPORTS = [
  { width: 1440, height: 900, isMobile: false, hasTouch: false },
  { width: 390, height: 844, isMobile: true, hasTouch: true },
];
const PHASES = ['morning', 'golden', 'night'];
const DEFAULT_NOW = '2026-11-27T10:00:00-05:00';
const ROOM_FONTS = ['Fredoka', 'Inter'];
// Caveat is only for Snow's own notes, so the browser loads it only when a note is on screen.
// A Caveat file that fails to load is still caught (any font with status "error" fails the run).
const FEED_FONTS = ['Fredoka', 'Inter'];
const NEWS_FONTS = ['Fredoka', 'Inter'];
// Hours after the frozen clock for each light on the desk pages (10:00 → 16:00 golden, 20:30 night).
const PHASE_HOURS = { morning: 0, golden: 6, night: 10.5 };
const STEP_TIMEOUT = 15_000;

class ShotError extends Error {}

// ---------- arguments ----------
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); process.exit(0); }
const flags = argv.filter(a => a.startsWith('--'));
const positional = argv.filter(a => !a.startsWith('--'));
const unknown = flags.filter(f => !f.startsWith('--now='));
if (positional.length < 2 || positional.length > 3 || unknown.length) {
  console.error(USAGE);
  if (unknown.length) console.error(`Unknown option: ${unknown.join(' ')}`);
  process.exit(2);
}
const [rawBase, rawOut, label = 'app'] = positional;

let base;
try {
  base = new URL(rawBase);
  if (!/^https?:$/.test(base.protocol)) throw new Error('not http(s)');
} catch {
  console.error(`screens: "${rawBase}" is not an http(s) URL.\n${USAGE}`);
  process.exit(2);
}
if (!/^[\w.-]+$/.test(label)) {
  console.error(`screens: label "${label}" may only use letters, digits, ".", "_" and "-".`);
  process.exit(2);
}

const nowFlag = (flags.find(f => f.startsWith('--now=')) || `--now=${DEFAULT_NOW}`).slice(6);
const frozenNow = nowFlag === 'real' ? null : new Date(nowFlag);
if (frozenNow && Number.isNaN(frozenNow.getTime())) {
  console.error(`screens: --now="${nowFlag}" is not a date (use an ISO time, or --now=real).`);
  process.exit(2);
}

// `npm run` moves to the repo root; INIT_CWD is where the command was typed.
const viaNpm = process.env.npm_lifecycle_event === 'screens' && process.env.INIT_CWD;
const outDir = path.resolve(viaNpm ? process.env.INIT_CWD : process.cwd(), rawOut);

// ---------- page helpers ----------

// Chrome asks for /favicon.ico by itself when a page links no icon. A 404 there is worth
// a warning (link one!), not a failed run.
const isAutoFavicon = url => { try { return new URL(url).pathname === '/favicon.ico'; } catch { return false; } };
let warnedFavicon = false;
function warnFavicon() {
  if (warnedFavicon) return;
  warnedFavicon = true;
  console.warn('  (warning) /favicon.ico is missing: the page links no icon (add <link rel="icon" href="favicon.svg">).');
}

// Collects everything that should fail the run: console errors, uncaught errors,
// failed or 4xx/5xx same-origin requests.
function watch(page) {
  const problems = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    if (loc && isAutoFavicon(loc.url)) return warnFavicon();
    problems.push(`console error: ${m.text()}${loc && loc.url ? ` (${loc.url}${loc.lineNumber ? ':' + loc.lineNumber : ''})` : ''}`);
  });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => {
    const f = r.failure();
    if (f && /ERR_ABORTED/.test(f.errorText)) return; // navigation away / cancelled, not a failure
    problems.push(`request failed: ${r.url()} (${f ? f.errorText : 'unknown'})`);
  });
  page.on('response', r => {
    if (r.status() < 400 || new URL(r.url()).origin !== base.origin) return;
    if (isAutoFavicon(r.url())) return warnFavicon();
    problems.push(`HTTP ${r.status()} for ${r.url()}`);
  });
  return {
    check(step) {
      if (problems.length) throw new ShotError(`${step}:\n  - ${problems.join('\n  - ')}`);
    },
  };
}

async function load(page, url, step) {
  let res;
  try {
    res = await page.goto(url, { waitUntil: 'load', timeout: STEP_TIMEOUT });
  } catch (e) {
    throw new ShotError(`${step}: could not load ${url}\n  ${e.message.split('\n')[0]}\n  Is the server running?`);
  }
  if (res && !res.ok()) throw new ShotError(`${step}: ${url} answered HTTP ${res.status()}.`);
  // Fonts, the feed and the state come in after "load". Settle, but don't hang on a long poll.
  await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT }).catch(() => {
    console.warn(`  (warning) ${step}: network never went idle; continuing.`);
  });
  // On the phone viewport Chrome sometimes keeps a rougher raster of the plate painted at load.
  // Nudging the viewport by 1 px forces a fresh raster at the final size, so shots repeat exactly.
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width + 1, height: vp.height });
  await page.setViewportSize(vp);
}

// Fonts loaded, images decoded, two frames painted.
async function settle(page, step, fonts) {
  const report = await page.evaluate(async ({ fonts, timeout }) => {
    const limit = ms => new Promise(r => setTimeout(r, ms));
    await Promise.race([document.fonts.ready, limit(timeout)]);
    const faces = [...document.fonts];
    const failedFonts = [...new Set(faces.filter(f => f.status === 'error').map(f => f.family.replace(/["']/g, '')))];
    const loaded = new Set(faces.filter(f => f.status === 'loaded').map(f => f.family.replace(/["']/g, '')));
    const missingFonts = fonts.filter(f => !loaded.has(f));
    const imgs = [...document.images].filter(i => i.getAttribute('src'));
    await Promise.race([Promise.all(imgs.map(i => i.decode().catch(() => {}))), limit(timeout)]);
    const brokenImages = imgs.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute('src'));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { failedFonts, missingFonts, brokenImages };
  }, { fonts, timeout: STEP_TIMEOUT });
  const issues = [];
  if (report.failedFonts.length) issues.push(`font files failed to load: ${report.failedFonts.join(', ')}`);
  if (report.missingFonts.length) issues.push(`fonts not loaded: ${report.missingFonts.join(', ')}`);
  if (report.brokenImages.length) issues.push(`images did not load: ${report.brokenImages.join(', ')}`);
  if (issues.length) throw new ShotError(`${step}:\n  - ${issues.join('\n  - ')}`);
}

// Clicks the Preview chip until the wanted light is on as a preview (not auto),
// then waits for that plate's fade to finish and the others to be gone.
async function showPhase(page, phase, step) {
  const btn = page.locator('#phaseBtn');
  if (!(await btn.count())) throw new ShotError(`${step}: no Preview chip (#phaseBtn) on the page.`);
  const isShown = () => page.evaluate(p => {
    const on = document.querySelector('.plate.on');
    const name = document.querySelector('#phaseName');
    return !!on && on.dataset.phase === p && !!name && name.textContent.trim().toLowerCase() !== 'auto';
  }, phase);
  for (let i = 0; i < 5 && !(await isShown()); i++) await btn.click();
  if (!(await isShown())) throw new ShotError(`${step}: the Preview chip never showed the ${phase} plate.`);
  try {
    await page.waitForFunction(p => [...document.querySelectorAll('.plate')].every(img => {
      const o = parseFloat(getComputedStyle(img).opacity);
      return img.dataset.phase === p ? o === 1 : o === 0;
    }), phase, { timeout: STEP_TIMEOUT });
  } catch {
    throw new ShotError(`${step}: the ${phase} plate never finished fading in.`);
  }
}

// Saves are answered here and never reach the server (see the header).
const SAVE_PATH = /^\/api\/(news\/)?state$/;
async function keepDataUntouched(page) {
  await page.route(url => url.origin === base.origin && SAVE_PATH.test(url.pathname), route => (
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      : route.continue()));
}

// A desk page in one light: open the room (where the Preview chip lives), pick the light, then
// follow the hash to the desk, as the room's own links do. Returns the page and its watcher.
async function openDeskPage(context, { hash, ready, fonts, phase, step }) {
  if (frozenNow) await context.clock.setFixedTime(new Date(frozenNow.getTime() + PHASE_HOURS[phase] * 3600e3));
  const page = await context.newPage();
  const w = watch(page);
  await keepDataUntouched(page);
  await load(page, base.href, step);
  w.check(step);
  await showPhase(page, phase, step);
  await page.evaluate(h => { location.hash = h; }, hash);
  try {
    await page.locator(ready).first().waitFor({ state: 'visible' });
  } catch {
    throw new ShotError(`${step}: ${hash} never rendered (${ready}).`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, step, fonts);
  w.check(step);
  return { page, w };
}

// Chrome may first paint a big downscaled plate with a quick filter and sharpen it a moment
// later, so keep shooting until two shots in a row match. Then before/after diffs are real.
//
// whole: true (default) shoots the whole page. Chrome paints position:fixed layers (the blurred
// study behind every page, the phone's bottom bar) only once, in the first screen of a full-page
// capture, although on screen they stay put while you scroll. So the viewport is first made as tall
// as the page, which puts those layers behind (and under) the whole page, as when scrolling.
// whole: false shoots just the first screen, exactly as it looks when the page opens.
async function shoot(page, file, { whole = true } = {}) {
  const target = path.join(outDir, file);
  const opts = { fullPage: whole, animations: 'disabled' };
  const vp = page.viewportSize();
  if (whole) {
    const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    if (height > vp.height) {
      await page.setViewportSize({ width: vp.width, height });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
  }
  let shot;
  let stable = false;
  try {
    shot = await page.screenshot(opts);
    for (let i = 0; i < 10 && !stable; i++) {
      await page.waitForTimeout(150);
      const next = await page.screenshot(opts);
      stable = next.equals(shot);
      shot = next;
    }
  } finally {
    if (whole) await page.setViewportSize(vp);
  }
  if (!stable) console.warn(`  (warning) ${file}: the page kept changing; saved the last shot.`);
  await writeFile(target, shot);
  const rel = path.relative(process.cwd(), target);
  console.log(`  ${rel && !rel.startsWith('..') ? rel : target}`);
  return target;
}

// ---------- run ----------
async function run() {
  await mkdir(outDir, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (e) {
    throw new ShotError(`could not start Google Chrome: ${e.message.split('\n')[0]}`);
  }
  const written = [];
  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        reducedMotion: 'reduce',
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
        colorScheme: 'dark',
      });
      context.setDefaultTimeout(STEP_TIMEOUT);
      if (frozenNow) await context.clock.setFixedTime(frozenNow);
      console.log(`${vp.width}x${vp.height}`);

      // The room, in each light.
      const room = await context.newPage();
      const roomWatch = watch(room);
      await load(room, base.href, `room @${vp.width}`);
      roomWatch.check(`room @${vp.width}`);
      for (const phase of PHASES) {
        const step = `room ${phase} @${vp.width}`;
        await showPhase(room, phase, step);
        await settle(room, step, ROOM_FONTS);
        roomWatch.check(step);
        written.push(await shoot(room, `${label}-room-${phase}-${vp.width}.png`));
      }
      // The prototype has no News desk: skip it there.
      const hasNews = (await room.locator('#news').count()) > 0;
      if (!hasNews && vp === VIEWPORTS[0]) console.log('  (no #news on this page, so no News shots)');
      await room.close();

      // The Product Feed, in each light.
      for (const phase of PHASES) {
        const step = `feed ${phase} @${vp.width}`;
        const { page, w } = await openDeskPage(context, { hash: '#feed', ready: '#list .art, #list .empty-state, #list .notecard', fonts: FEED_FONTS, phase, step });
        written.push(await shoot(page, `${label}-feed-${phase}-${vp.width}-screen.png`, { whole: false }));
        written.push(await shoot(page, `${label}-feed-${phase}-${vp.width}.png`));
        w.check(step);
        await page.close();
      }

      // The News desk, in each light, then with a story read and the shelf open.
      if (hasNews) {
        const NEWS_READY = '#newsStories .nstory, #newsStories .empty-state';
        for (const phase of PHASES) {
          const step = `news ${phase} @${vp.width}`;
          const { page, w } = await openDeskPage(context, { hash: '#news', ready: NEWS_READY, fonts: NEWS_FONTS, phase, step });
          if (phase === PHASES[0] && vp === VIEWPORTS[0] && (await page.locator('#newsBreaking').isHidden())) {
            console.warn('  (warning) no breaking story today, so no banner (make a test Desk with scripts/screens-home.js).');
          }
          written.push(await shoot(page, `${label}-news-${phase}-${vp.width}-screen.png`, { whole: false }));
          written.push(await shoot(page, `${label}-news-${phase}-${vp.width}.png`));
          w.check(step);
          await page.close();
        }
        const step = `news reading @${vp.width}`;
        const { page, w } = await openDeskPage(context, { hash: '#news', ready: NEWS_READY, fonts: NEWS_FONTS, phase: 'morning', step });
        try {
          await page.locator('#newsStories [data-read="t0"]').click();
          await page.locator('#newsStories [data-read="t0"][aria-pressed="true"]').waitFor();
          await page.locator('#newsMoreBtn').click();
          await page.locator('#newsMoreList [data-item="m0"]').click();
          await page.locator('#newsMoreList [data-item="m0"][aria-expanded="true"]').waitFor();
          // The XP toast fades after a few seconds; the shots show the page under it.
          await page.waitForFunction(() => !document.querySelector('#toast.on'), null, { timeout: 10_000 });
        } catch (e) {
          throw new ShotError(`${step}: couldn't mark story 1 read and open the shelf.\n  ${e.message.split('\n')[0]}`);
        }
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        await settle(page, step, NEWS_FONTS);
        written.push(await shoot(page, `${label}-news-reading-${vp.width}-screen.png`, { whole: false }));
        written.push(await shoot(page, `${label}-news-reading-${vp.width}.png`));
        w.check(step);
        await page.close();
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`Done: ${written.length} screenshots in ${outDir}`);
}

run().catch(e => {
  console.error(`screens failed: ${e instanceof ShotError ? e.message : e.stack || e}`);
  process.exit(1);
});
