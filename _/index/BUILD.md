# Building Corpus Index

## Ingest

Each published corpus becomes one catalog document. `_/index` excludes itself.
Illustrative shape:

```json
{
  "url": "https://library.runcorpus.com/<org>/<name>",
  "meta": {
    "title": "Display name",
    "description": "Short description",
    "corpus": "<org>/<name>",
    "region": "SG",
    "language": "en"
  },
  "body": {
    "media_type": "text/markdown",
    "data": "...published README..."
  }
}
```

`url` is the stable document identity; `meta.corpus` is the reference used to add
the collection. `region` and `language` are omitted when absent or empty.

The body contains the published README. If missing or empty, it uses
`text/plain` with `<org>/<name>` and the description on separate lines.
Title and body are indexed; metadata is retained for search results.

## Source / Dataset

The dataset is the [public Corpus Library catalog](https://library.runcorpus.com/):
published corpus identifiers, names, descriptions, coverage labels, and READMEs.
Each record describes a collection so a search can identify which corpus to use.

Fetch the catalog and tag lists over HTTP in pages of 100, following the
pagination cursor until complete. Process corpus sequentially. For each corpus,
select `latest` or the sole available tag, then fetch its metadata, selected
snapshot manifest, and README in parallel.

Read each response fully and map it to the document shape above. Collect all
documents in memory before ingestion, then send them in batches to the local
Corpus daemon. Close the writer to save the resulting Corpus Index snapshot,
then tag it as `_/index:latest`. The workflow publishes it with the package's
push script.
