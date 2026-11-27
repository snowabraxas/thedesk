// The News page's markup, as pure functions of news-lib.js's view model: no DOM, so the tests can
// feed them hostile editions. Every value from the agent goes through esc(). Attributes only ever
// hold our own values: list positions ("t0", "m3"), ids built from them, region keys from the fixed
// list in news-lib.js, numbers we computed, and links that passed safeUrl (escaped as well).
import { esc } from './lib.js';

// Inline stroke icons, as in app.js. Static markup, never agent text.
const icon = (paths) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
export const ICON = {
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevron: icon('<path d="M7 10l5 5 5-5"/>'),
};

const NEW_TAB = '<span class="sr"> (opens in a new tab)</span>';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (n) => (Number.isFinite(n) ? String(n) : '0');
// A region key from news-lib's fixed list, for a class name; anything else is "other".
const regionClass = (r) => `region-${/^(us|china|eu|global|other)$/.test(r) ? r : 'other'}`;

/** A link for each source (its name as the text, never the link) or, when the link isn't safe, the name as plain text. */
export function sourceLinksHtml(sources) {
  return sources
    .map((src) => (src.url
      ? `<li><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.name)}${NEW_TAB}</a></li>`
      : `<li><span class="nsrc-plain">${esc(src.name)}</span></li>`))
    .join('');
}

// ref: "t0" for the first top story, "m3" for the fourth on the shelf. titleId: the id of its headline.
function readButton(s, ref, titleId) {
  if (!s.key) return '';
  return `<button type="button" class="ab nread ${s.read ? 'on' : ''}" data-read="${ref}" aria-pressed="${s.read ? 'true' : 'false'}" aria-describedby="${titleId}">${s.read ? `${ICON.check}Read` : 'Mark read'}</button>`;
}

// Summary, why, skeptic, sources and the read toggle: the body of a top card and of an opened shelf item.
function storyBody(s, ref, titleId) {
  const box = (cls, label, body) => (body ? `<div class="${cls}"><p class="lbl">${label}</p><p>${esc(body)}</p></div>` : '');
  const sources = s.sources.length
    ? `<span class="nsrclbl" id="${titleId}-src">Sources</span><ul class="nsrcs" aria-labelledby="${titleId}-src">${sourceLinksHtml(s.sources)}</ul>`
    : '';
  return `${s.summary ? `<p class="nsum">${esc(s.summary)}</p>` : ''}
    <div class="nboxes">${box('nwhy', 'Why it matters', s.why)}${box('nskeptic', 'The skeptic’s view', s.skeptic)}</div>
    <div class="nrow">${sources}${readButton(s, ref, titleId)}</div>`;
}

/** A top story's card. i: its place in view.top. */
export function storyCardHtml(s, i) {
  const ref = `t${Number(i)}`;
  const titleId = `ns-${ref}`;
  return `<article class="nstory frost ${s.read ? 'read' : ''}" aria-labelledby="${titleId}">
    <div class="nmeta">
      <span class="nrank"><span class="sr">Story </span>${num(s.position)}</span>
      <span class="ntag ${regionClass(s.region)}">${esc(s.regionLabel)}</span>
      ${s.kindLabel ? `<span class="ntag">${esc(s.kindLabel)}</span>` : ''}
      <span class="nmins">${num(s.minutes)} min read</span>
    </div>
    <h3 id="${titleId}">${esc(s.headline)}</h3>
    ${storyBody(s, ref, titleId)}
  </article>`;
}

/** A story on the "More stories" shelf: region, headline, kind and number of sources; opens to the full story. */
export function shelfItemHtml(s, i, open) {
  const ref = `m${Number(i)}`;
  const titleId = `ns-${ref}`;
  const meta = [s.kindLabel, plural(s.sources.length, 'source', 'sources'), s.read ? 'Read' : ''].filter(Boolean).map(esc).join(' · ');
  return `<li class="nitem frost ${s.read ? 'read' : ''}">
    <h3><button type="button" class="nitembtn" data-item="${ref}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${titleId}-body">
      <span class="ntag ${regionClass(s.region)}">${esc(s.regionLabel)}</span>
      <span class="nitemtitle" id="${titleId}">${esc(s.headline)}</span>
      <span class="nitemmeta">${meta}</span>${ICON.chevron}
    </button></h3>
    <div class="nitembody" id="${titleId}-body"${open ? '' : ' hidden'}>${storyBody(s, ref, titleId)}</div>
  </li>`;
}

/** The inside of the breaking banner, from news-lib's breakingView: time, headline, its first source, dismiss. */
export function breakingHtml(b) {
  const src = b.source;
  const read = !src ? ''
    : src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">Read<span class="sr"> at ${esc(src.name)} (opens in a new tab)</span></a>`
      : `<span class="nbsrc">${esc(src.name)}</span>`;
  const time = b.time ? ` · <time datetime="${esc(b.at)}">${esc(b.time)}</time>` : '';
  return `<h2 class="nblabel" id="newsBreakingLabel">Breaking${time}</h2>
    <p class="nbhead">${esc(b.headline)}</p>${read}
    <button type="button" class="nbx" id="newsDismiss" aria-label="Dismiss breaking news">${ICON.close}</button>`;
}

/** The glance tiles' insides: the two numbers, the regions with bars, the kinds with counts. */
export function glanceHtml(g) {
  const none = '<li class="nnone">No stories yet</li>';
  return {
    numbers: `<p><b>${num(g.stories)}</b><span>${g.stories === 1 ? 'story' : 'stories'}</span></p><p><b>${num(g.sources)}</b><span>${g.sources === 1 ? 'source' : 'sources'}</span></p>`,
    regions: g.regions.length
      ? g.regions.map((r) => `<li><span class="nrname">${esc(r.label)}</span><span class="nrcount">${num(r.count)}</span><span class="nbar" aria-hidden="true"><span class="${regionClass(r.region)}" style="width:${num(Math.round(Math.min(1, Math.max(0, r.share)) * 100))}%"></span></span></li>`).join('')
      : none,
    kinds: g.kinds.length ? g.kinds.map((k) => `<li class="pill">${esc(k.label)} · ${num(k.count)}</li>`).join('') : none,
  };
}

/** No top stories: a friendly card (N7 brings the full set of friendly states). */
export function noStoriesHtml(hasEdition) {
  return `<div class="empty-state frost"><p><strong>No top stories yet.</strong> ${hasEdition ? 'This edition came without any.' : 'Wila will let you know when the edition lands.'}</p></div>`;
}
