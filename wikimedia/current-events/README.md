# Wikimedia Current Events

Wikimedia Current Events (`wikimedia/current-events`) is a rolling English-language
corpus of daily world event summaries and cited news URLs curated on English
Wikipedia's [Portal:Current events](https://en.wikipedia.org/wiki/Portal:Current_events).

## What you can do

- **Search breaking and historical world events by summary, topic, or category.**
  Query in natural language—for example, "NZ election coalition", "ECB president",
  "Yemen airstrikes", or "SpaceX satellites"—using full summary text, inherited
  topic labels, and categories.
- **Route directly to primary news reporting.** Each match returns the cited
  external news URL (`url`) alongside retained metadata (`title`, `description`,
  `date`, `updated_at`, `category`, `topics`, `sources`, and `wikipedia_path`).
- **Choose a rolling time window.** Run `corpus add wikimedia/current-events`
  for `latest` (which aliases `thisyear`, last 365 days), or select a narrower
  window with `wikimedia/current-events:thisweek` (7 days) or
  `wikimedia/current-events:thismonth` (30 days).
  [Install Corpus](https://runcorpus.com/install).

## Attribution and coverage

Event summaries, topic hierarchies, and categories originate from English
Wikipedia's `Portal:Current events` daily pages, contributed by Wikipedia editors
and available under CC BY-SA 4.0. Only bullet entries with an external citation
URL are indexed; linked external publisher articles are not fetched or stored.
Open `url` to read the cited reporting or prepend `https://en.wikipedia.org` to
`wikipedia_path` to view the Wikipedia daily entry and revision history.
