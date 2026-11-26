# Building Hello, World!

## Ingest

Each selected homepage becomes one document:

```json
{
  "url": "https://example.com/",
  "meta": {
    "title": "Example Domain",
    "description": "Optional description from the page"
  },
  "body": {
    "media_type": "text/markdown",
    "data": "# Example Domain\n\n...homepage content..."
  }
}
```

The selected URL remains the document identity across redirects. `meta` contains
only the `<head><title>` text (falling back to the first `<title>` element or
the selected site name) and an optional description from HTML metadata
(`description`, `og:description`, or `twitter:description`), truncated on a word
boundary to at most 200 characters. Title and body are indexed; metadata is
retained for search results.

Convert HTML locally with `@joplin/turndown` and its GFM plugin. Remove `script`,
`style`, `noscript`, `template`, and `svg` elements, strip `data:` image
sources and `javascript:` links, and resolve remaining page links and image URLs
against the final response URL. Navigation and other homepage content remain.
Reject failed HTTP responses, recognized challenge pages, pages with fewer than
80 alphanumeric characters, and empty conversions. There is no browser rendering
or hosted extraction step.

From this directory, run `bun run build` with the local Corpus daemon running.
Prepare all documents before creating a corpus, ingest them, close the writer,
verify the saved document count, then update `_/helloworld:latest`. Failures
before verification leave the existing tag unchanged. Use
`bun run build --untagged` to build without moving it. `bun run push` publishes
the latest tag with this directory's README when publication is requested.

## Source / Dataset

`sources.yaml` is the approved, ordered selection of 100 website homepages,
retained from the original Hello, World! collection. It spans web infrastructure,
open knowledge, software, research, public information, and culture. This is an
editorial selection, not a traffic ranking. Each entry has only `name` and `url`.

Builds fetch missing pages with bounded concurrency over HTTP using a 20-second
timeout and a 4 MiB response limit, collecting and reporting all failures if any
page cannot be prepared. Successful HTML is stored in the gitignored
`_/helloworld/.cache/<sha256-of-url>.json` cache, alongside the requested URL,
final URL, and fetch time. No HTML or generated Markdown is committed. Cached
HTML is reused until `bun run build --refresh` fetches it again. A failed
refresh preserves the previous cache entry for that URL; successful pages are
cached immediately so an interrupted build can reuse them. Each build converts
the HTML again with the single configured converter.

A clean checkout downloads the selected pages; it does not depend on captures
or files from the original workspace.

The existing ten task-to-website cases are retained in
`evals/corpusqa/suite.yaml`. Their source selection is fixed, but homepage
content and live pages opened by an eval can change. The shared evaluation
runner is not a dependency of this importer; no hosted eval is run by build.
