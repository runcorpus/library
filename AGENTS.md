# AGENTS

## Package layout

Each collection lives in `<org>/<name>/` as a Bun workspace with `README.md`,
`BUILD.md` (`Ingest` and `Source / Dataset`), `build.ts`, `tsconfig.json`,
and `package.json` exposing `build`, `push`, `typecheck` (`bun check`), and
`test` (`bun test`). Use TypeScript, Bun, and `@corpusd/api` against the
local `corpusd` daemon.

## Documents and README

- Use a stable canonical `url` as document identity, a lean allowlisted
  `meta` object, a transient `body` for indexing, and clean discovery
  `labels` (`name`, `description`, and optional `region` / `language`).
- Corpus V0 indexes all metadata values recursively, including values in nested
  objects and arrays, numbers, and booleans. Keys and `null` are ignored.
  Do not copy metadata into `body` solely to make it searchable; use the body
  for independent source text, and omit it when no such text remains.
- Publish a `latest` tag (directly or as an alias) so default `corpus add`
  and `_/index` discovery work unambiguously.
- Keep `README.md` factual and concise: explain coverage, search usage, and
  result fields without build commands, snapshot counts or hashes,
  "in the Corpus Library" self-references, or unapproved legal or licensing
  claims.

## Testing

Do not write tests by default. Add a focused unit test only when a bug could
slip past `bun run typecheck` silently:

- **Public data contracts:** validating human-edited inputs (such as
  `feeds.yaml`) or allowlisted document `meta` and corpus `labels`.
- **Non-trivial pure or stateful logic:** parsing, normalization,
  deduplication, window cutoffs, or cursor and file preservation.
- **Bug regressions:** reproducing a concrete failure before fixing it.

Do not write fake-daemon mocks, CLI flag-parsing tests, or tests for thin
wrappers—verify those with `bun run typecheck` and a real run.
