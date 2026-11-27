# Building Wikimedia Current Events

## Ingest

Each external-link bullet from English Wikipedia's `Portal:Current events`
daily pages inside a rolling window becomes one document identified by the
canonical URL of its primary external news citation (with tracking query
parameters, fragments, and trailing slashes stripped). Illustrative shape:

```json
{
  "url": "https://www.reuters.com/world/africa/example-story-2026-11-25/",
  "meta": {
    "title": "Herder–farmer conflicts in Nigeria",
    "description": "Thirty people are killed and homes are burned by gunmen in Niger State, Nigeria.",
    "date": "2026-11-26",
    "updated_at": "2026-11-26T22:14:00.000Z",
    "category": "Armed conflicts and attacks",
    "topics": ["Herder–farmer conflicts in Nigeria"],
    "sources": ["Reuters"],
    "wikipedia_path": "/wiki/Portal:Current_events/2026_November_26"
  },
  "body": null
}
```

`url` is the stable document identity. `title` uses the most specific parent
topic when available (falling back to the lead sentence for top-level bullets).
`description` is truncated to at most 500 characters on a word boundary and
omitted when identical to `title`; `updated_at`, `topics`, and `sources` are
omitted when empty. The cleaned summary and its topic, category, and source
descriptors are indexed from metadata. When the summary description is
truncated, the body preserves the complete original summary; otherwise the body
is omitted because the source text is already represented in metadata.

## Source / Dataset

`wikipedia.ts` fetches trailing UTC daily subpages (`Portal:Current events/YYYY Month D`)
in batches of 50 via the MediaWiki Action API (`action=query&prop=revisions`).
`parseDayWikitext()` tracks bold/semicolon category headings and multi-level `*`
topic stacks, strips MediaWiki templates/wikilinks/comments, extracts external
citations `[https://... (Source)]`, and deduplicates across pages by canonical
citation URL.

`bun run build` (`build.ts`) builds three rolling snapshots in a single stacked
pass—`thisweek` (7d) → `thismonth` (30d) → `thisyear` (365d, aliased as
`latest`)—reusing chunks across windows, sealing and verifying each snapshot
against the local `corpusd` daemon, and detaching superseded untagged local
snapshots. `--dry-run` fetches and parses without writing to `corpusd`.
