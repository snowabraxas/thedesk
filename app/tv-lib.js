// The TV in the room (N5): how it looks, from the News desk's signals, and how the room refreshes them.
// Pure: no DOM, no network. Imported by app.js in the browser and by test/tv-lib.test.js in Node.
//
// The signals come from news.signals() (tvSignals in news-lib.js): { unread, total, breaking, sample },
// where `unread` counts unread top stories and `breaking` is a breaking story Snow hasn't dismissed
// (exactly when the News page shows its banner).

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * How the TV shows in the room.
 * - on: its screen glows, soft rosy (at least one top story is unread; a sample edition counts like a real one)
 * - breaking: the small rosy "on air" mark
 * - tag: the label above the TV, which is also its name for screen readers, so neither cue relies on colour:
 *   "News", "News · 3 new", "News · breaking story", "News · 3 new · breaking story"
 * - short: the label on a touch screen, where every tag shows at once and the room has little space:
 *   "News" or "News · 3 new" (the mark shows the breaking story). Always the start of `tag`, so the
 *   words on screen are the first words of the button's name.
 * Anything unusable (no signals, an edition that couldn't be fetched) is a quiet TV, never an error.
 * @returns {{ on: boolean, breaking: boolean, tag: string, short: string }}
 */
export function tvLook(signals, name = 'News') {
  const s = isPlainObject(signals) ? signals : {};
  const unread = Number.isSafeInteger(s.unread) && s.unread > 0 ? s.unread : 0;
  const breaking = s.breaking === true;
  const short = unread ? `${name} · ${unread} new` : name;
  return { on: unread > 0, breaking, tag: breaking ? `${short} · breaking story` : short, short };
}

/** Asks for the signals; null if asking fails, so the room draws a quiet TV instead of breaking. */
export function readSignals(ask) {
  try {
    return typeof ask === 'function' ? ask() : null;
  } catch {
    return null;
  }
}

/**
 * One refresh at a time. `run` starts the work (news.refresh: fetch the edition and breaking story
 * again) and `apply` draws the result (renderRoom), whether the work succeeded or failed.
 * - While a refresh is running, refresh() hands back that same promise, so a burst of tab events
 *   starts one pair of fetches, not one per event.
 * - Every refresh that starts gets a number, and only the newest may apply: refresh({ force: true })
 *   starts a new one even while another runs, and the older one's answer is then dropped, so it can
 *   never draw last. (Nothing forces yet; N4's tab-return path will.)
 * @param {() => unknown} run
 * @param {() => void} apply
 * @returns {(options?: { force?: boolean }) => Promise<void>}
 */
export function createRefresher(run, apply) {
  let running = null;
  let latest = 0;
  return function refresh({ force = false } = {}) {
    if (running && !force) return running;
    const mine = ++latest;
    const settle = () => {
      if (mine === latest) apply();
    };
    let work;
    try {
      work = Promise.resolve(run());
    } catch (e) {
      work = Promise.reject(e);
    }
    const done = work.then(settle, settle).finally(() => {
      if (running === done) running = null;
    });
    running = done;
    return done;
  };
}
