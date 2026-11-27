# Building GDELT News

## Ingest

Each deduplicated web-article row (`SourceCollectionIdentifier = 1`) with a
non-empty `<PAGE_TITLE>` in the trailing 24-hour GKG window becomes one document
identified by its canonical article URL. Illustrative shape:

```json
{
  "url": "https://timesofmalta.com/article/example",
  "meta": {
    "title": "Two accused of stealing car batteries from eCabs garage",
    "date": "2026-11-27T13:17:00.000Z",
    "source": "timesofmalta.com",
    "authors": ["Clara Farrugia"]
  },
  "body": {
    "media_type": "text/plain",
    "data": "Marion Camilleri, Clive Aquilina\nOffice Of The Attorney General\nMarsascala, Malta\nhealth promotion and disease prevention, public health"
  }
}
```

`url` is the stable document identity. `meta` retains only `title`, `date`
(`<PAGE_PRECISEPUBTIMESTAMP>` when present and plausible, else GDELT `DATE`),
`source`, and optional `authors`. `body` indexes extracted `V2Persons`,
`V2Organizations`, `V2Locations`, and cleaned `V2Themes` without storing
`Quotations`. Authors and source are indexed from metadata, without copying
them into the body. The body is omitted when no extracted entities remain.

## Source / Dataset

`gdelt.ts` reads `http://data.gdeltproject.org/gdeltv2/lastupdate.txt` to locate
the latest 15-minute `.gkg.csv.zip` slice and steps backward in 15-minute
increments across 96 slices (24 hours), fetching and unzipping archives
concurrently with `unzipSingleFile()` and deduplicating across slices by
canonical URL via `mergeGdeltItems()`.

`bun run build` (`build.ts`) ingests the deduplicated documents in batches of
1,000, seals and verifies the snapshot against the local `corpusd` daemon,
moves `gdelt/news:today` and `gdelt/news:latest`, and detaches superseded
untagged local snapshots. `--dry-run` (with optional `--slices N`) fetches and
parses without writing to `corpusd`.
