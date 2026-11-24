# Corpus Index

The Corpus Index (`_/index`) is the discovery catalog for the
[Corpus Library](https://runcorpus.com/library). Use it to find a published
corpus by topic, source type, name, region, or language so you or your
agent can add it and search it locally.

## What you can do

- **Discover collections by topic or source.** Search in everyday language—for
  example, “US federal regulations”, “SEC filings”, or “US court opinions”—and
  include a place, language, or source type when it helps narrow the results.
- **Inspect coverage before adding.** Each match describes what the corpus
  covers and returns its `org/name` reference in `meta.corpus`. When provided by
  the corpus manifest, results also include `meta.region` for geographic
  coverage and `meta.language` for content language.
- **Add a corpus to search locally.** Run `corpus add org/name` to add `latest`,
  or `corpus add org/name:tag` for a specific snapshot.
  [Install Corpus](https://runcorpus.com/install).

## Coverage

Search indexes each published corpus’s `meta: {}` and README from the public Library
catalog. `_/index` excludes itself, and newly published corpus appear after the index is
rebuilt.
