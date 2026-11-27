// The TV in the room (N5): how it looks, from the News desk's signals. Pure: no DOM, no network.
// Imported by app.js in the browser and by test/tv-lib.test.js in Node.
//
// The signals come from news.signals() (tvSignals in news-lib.js): { unread, total, breaking, sample },
// where `unread` counts unread top stories and `breaking` is a breaking story Snow hasn't dismissed
// (exactly when the News page shows its banner).

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * How the TV shows in the room.
 * - on: its screen glows, soft rosy (at least one top story is unread; a sample edition counts like a real one)
 * - breaking: the small rosy mark on its corner
 * - tag: the label above the TV, which is also its name for screen readers, so neither cue relies on colour:
 *   "News", "News · 3 new", "News · breaking story", "News · breaking story · 3 new"
 * Anything unusable (no signals, an edition that couldn't be fetched) is a quiet TV, never an error.
 * @returns {{ on: boolean, breaking: boolean, tag: string }}
 */
export function tvLook(signals, name = 'News') {
  const s = isPlainObject(signals) ? signals : {};
  const unread = Number.isSafeInteger(s.unread) && s.unread > 0 ? s.unread : 0;
  const breaking = s.breaking === true;
  const tag = [name, breaking ? 'breaking story' : '', unread ? `${unread} new` : ''].filter(Boolean).join(' · ');
  return { on: unread > 0, breaking, tag };
}

/** Asks for the signals; null if asking fails, so the room draws a quiet TV instead of breaking. */
export function readSignals(ask) {
  try {
    return typeof ask === 'function' ? ask() : null;
  } catch {
    return null;
  }
}
