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
    "data": "Lead summary or content\nCaption\nJane Doe\nEconomy, Markets\nAssociated Press"
  }
}
```

`url` is the stable document identity. `description` is truncated to at most
200 characters on a word boundary when present, and `description`, `date`,
`updated_at`, `publisher`, and `authors` are omitted when absent. `body` uses
`text/plain` combining non-redundant full summary/content, media caption,
authors, tags, and source attribution without label boilerplate. Title and body
are indexed; metadata is retained for search results.

## Source / Dataset

The dataset is polled from the configured public RSS and Atom feeds in
`feeds.yaml` (loaded and validated by `feed/index.ts`) using conditional GET
(`ETag` and `If-Modified-Since`) and per-feed exponential backoff.

`feed/poll.ts` persists fetched items in a per-feed UTC day-bucketed JSONL
store under `_/news/feed/` (overridable with `NEWS_STORE_DIR`):
`_/news/feed/<feedId>/YYYY-MM-DD.jsonl` and `_/news/feed/<feedId>/state.json`,
preserving the earliest `firstSeenAt` per canonical URL.

`bun run build` polls the feeds into the store and rebuilds three clean
snapshots from `readWindow(storeDir, windowHours)`—`today` (24h), `thisweek`
(7d), and `thismonth` (30d)—sealing and verifying each snapshot against the
local Corpus daemon, moving `_/news:today`, `_/news:thisweek`, and
`_/news:thismonth` (with `_/news:latest` aliasing `thismonth`), and detaching
superseded untagged local snapshots. The package’s `push` script publishes
`today`, `thisweek`, `thismonth`, and `latest`. Per-feed data directories
(`_/news/feed/*/`) are gitignored on `main`, and `.github/workflows/news.yml`
restores and persists them on the orphan `library/_/news` data branch.
