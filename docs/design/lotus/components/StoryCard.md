# StoryCard

The frosted card for one item you read: a story, an article, a pick. First built for the News desk; other desks reuse the shape.

- Frost surface, `radius-lg`, padding `space-6`, gap `space-3`.
- Top row: a rank circle (`midnight-green` fill, `beige` numeral in Fredoka) and chips (`chip` or a region tint, `label` style).
- Headline in `title` style, `dark-green`; body in `body`, secondary in `ink-muted`.
- Two inner boxes at `radius-md`: `moss-tint` with a `moss-ink` label, `rosy-tint` with a `rosy-ink` label.
- Source pills at `radius-pill`; a "Mark read" pill button in `midnight-green`, filled once read.
- The consumer provides the content and the read handler. All text from agents is escaped and links are https only.
