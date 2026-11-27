# Building News

## Ingest

Each deduplicated feed item inside a rolling time window becomes one document
identified by its canonical article URL (with tracking parameters and URL
fragments stripped). Illustrative shape:

```json
{
  "url": "https://example.com/article",
  "meta": {
    "title": "Headline",
    "description": "Lead summary from the feed",
    "date": "2026-11-24T12:00:00.000Z",
    "updated_at": "2026-11-24T13:00:00.000Z",
    "first_seen_at": "2026-11-24T12:05:00.000Z",
    "source": "Associated Press",
    "publisher": "Syndicated Wire",
    "category": "general",
    "authors": ["Jane Doe"]
  },
  "body": {
    "media_type": "text/plain",
    "data": "Full article content\nCaption\nEconomy, Markets"
  }
}
```

`url` is the stable document identity. `description` falls back to content when
summary is absent, filters out non-abstract link boilerplate, and is truncated to
at most 500 characters on a word boundary when present; `description`, `date`,
`updated_at`, `publisher`, and `authors` are omitted when absent. The transient
`text/plain` body keeps full feed content, captions, and feed tags when they
provide additional source text. If a description is truncated, the body keeps
the complete original summary. Headline, description, authors, and source
attribution are indexed from metadata. The body is omitted when no additional
source text remains.

## Source / Dataset

The dataset is polled from the configured public RSS, Atom, and Google News
Sitemap feeds in `feeds.yaml` (loaded and validated by `feed/index.ts`) using
conditional GET (`ETag` and `If-Modified-Since`) and per-feed exponential
backoff.

`feed/poll.ts` persists fetched items in a per-feed UTC day-bucketed JSONL
store under `_/news/feed/` (overridable with `NEWS_STORE_DIR`):
`_/news/feed/<feedId>/YYYY-MM-DD.jsonl` and `_/news/feed/<feedId>/state.json`,
preserving the earliest `firstSeenAt` and merging non-empty metadata fields
across overlapping feeds per canonical URL.

`bun run build` polls the feeds into the store, reads the widest rolling window
once from `readWindow(storeDir, maxWindowHours)`, and builds the three
snapshots in a single stacked pass—`today` (24h) → `thisweek` (7d) →
`thismonth` (30d)—by opening each prior sealed snapshot and appending only the
wider window’s delta items so unchanged chunks are reused. It seals and verifies
each snapshot against the local Corpus daemon, moves `_/news:today`,
`_/news:thisweek`, and `_/news:thismonth` (with `_/news:latest` aliasing
`thismonth`), and detaches superseded untagged local snapshots. The package’s
`push` script publishes `today`, `thisweek`, `thismonth`, and `latest`. Per-feed
data directories (`_/news/feed/*/`) are gitignored on `main`, and
`.github/workflows/news.yml` restores and persists them on the orphan
`library/_/news` data branch.
