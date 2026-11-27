# The Desk · Lotus

Frosted glass over a painted study, in lotus-pond colours: the base theme for every desk in Snow's Agent House.

Approved by Snow on 27 Nov 2026 from the News desk design test ([canvas](https://claude.ai/artifact/GNqGN9WTsevnvK1yuNbE38), version C · Lotus glass). It replaces the old teal and amber look. **No amber or yellow anywhere.**

## The idea

Every desk page floats over the study it came from. The room stays visible behind the glass, blurred, and follows the real time of day (morning, golden hour, night), so a desk feels like a screen inside the room and never like a separate dashboard.

- **Calm and warm.** Soft greens, rosy warmth, off-white light. A friend's study, not an office.
- **Glass for glancing, frost for reading.** Short labels and numbers sit on full glass; anything you read sits on frosted, near-solid cards.
- **Round like lily pads.** Big radii (`radius-lg` 28px) and pills (`radius-pill`) everywhere; no sharp corners.
- **Beauty and play are requirements.** Progress, streaks and small rewards belong on every desk.

## Colour

| Token | Value | Use |
| --- | --- | --- |
| `midnight-green` | #105666 | The house colour: glass tint, primary buttons, links |
| `rosy-brown` | #D3968C | Warm accent (replaces amber): highlights, alerts, Wila's glow |
| `moss-green` | #839958 | Calm accent: growth, "why it matters", good progress |
| `beige` | #FCFBF3 | Frosted cards and text on glass |
| `dark-green` | #0A3323 | Ink only, never a big fill |

Pairs that pass 4.5:1: `dark-green` on `beige`; `ink-muted` on `beige`; `beige` on `glass-tint` over `room-veil`; `moss-ink` on `moss-tint`; `rosy-ink` on `rosy-tint`. `rosy-light` is for headings (17px+) on glass only.

## The two glass strengths

| Strength | Tokens | Used for |
| --- | --- | --- |
| **Full glass** | `glass-tint` + `blur-glass` + `glass-edge` + `shadow-glass` | Rail, top capsule, glance tiles, shelves, banners |
| **Frost** | `frost-tint` + `blur-frost` + `frost-edge` + `shadow-frost` | Story cards, articles, notes, anything longer than a line |

The page background is always: the study plate (blurred by `blur-room`), then `room-veil`, then the panels.

## Type

- **Fredoka** (display): desk names, headings, numbers. 500 and 600.
- **Inter** (sans): everything you read.
- **Caveat** (hand): Snow's own notes only.

All three come from Google Fonts.

## Layout skeleton (every desk)

1. A floating **pill rail** on the left: Back to the room, then the desk's own sections. Icons only, 52px circles, the current one filled.
2. A **top capsule**: Wila's orb, the greeting and date, Wila's one-line note, and today's progress.
3. The desk's main column of **frosted cards**, plus a narrow side column of **glass glance tiles**.
4. On a phone, the rail becomes a bottom bar and the columns stack.

## Icons

Inline stroke icons, 1.8px stroke, round caps, on 22px. No emoji.

## Every desk is its own room

The system fixes the bones; each desk gets its own soul through five dials. See **Desk identities** for the rules and the first three desks.

## Accessibility

Real buttons and links, 44px touch targets, text contrast 4.5:1 at every time of day (check the night plate first), and colour never carries meaning alone.

## Links

- Design system (live, browsable): https://claude.ai/artifact/1HskfWPQKw2CQVExBuD2eH
- News desk design test (C · Lotus glass chosen): https://claude.ai/artifact/GNqGN9WTsevnvK1yuNbE38
- Product Feed in Lotus: https://claude.ai/artifact/HJbkJMqyj6rBQqEyUDGWc9
- Room plates: `app/assets/plate-*.webp`
