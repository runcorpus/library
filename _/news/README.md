# News

News (`_/news`) is a rolling English-language news corpus built from public RSS
and Atom feeds across general and local news, business, technology, science,
health, sports, gaming, entertainment, travel, automotive, education, and
lifestyle outlets.

## What you can do

- **Search recent news by topic, person, or outlet.** Query in everyday
  language—for example, “interest rate decision”, “semiconductor export
  controls”, “Champions League”, or “Associated Press”—and use retained fields
  such as `source`, `publisher`, `category`, `authors`, `date`, and
  `first_seen_at` to inspect results.
- **Route to original publisher articles.** Each match returns its canonical
  article URL along with retained feed metadata (`title`, optional
  `description`, `date`, `updated_at`, `first_seen_at`, `source`, optional
  `publisher`, `category`, and optional `authors`).
- **Choose a rolling time window.** Run `corpus add news` (or
  `corpus add _/news`) for `latest`, which aliases `thismonth` (last 30 days),
  or pick a narrower window with `corpus add news:today` (24 hours) or
  `corpus add news:thisweek` (7 days). [Install Corpus](https://runcorpus.com/install).

## Coverage

Only entries published in the configured public RSS and Atom feeds are indexed
to route you to publisher URLs. Full articles are not fetched or stored; open
the result URL to read the article at its source.
