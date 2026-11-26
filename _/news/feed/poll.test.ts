import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_LABEL_KEYS, WINDOW_TAGS, partitionWindowItems, windowLabels } from "../build";
import { canonicalizeUrl, loadFeeds, parseFeedsYaml, toDocument, type FeedItem } from "./index";
import { pruneOldDays, readFeedState, readWindow, upsertFeedItems, writeFeedState } from "./poll";

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    url: "https://example.com/story-1",
    guid: "guid-1",
    feedId: "nyt",
    source: "The New York Times",
    publisher: null,
    category: "general",
    title: "Headline",
    summary: "Lead paragraph.",
    content: "",
    caption: "",
    authors: ["Jane Doe"],
    tags: ["Economy", "Markets"],
    publishedAt: "2026-11-24T12:00:00.000Z",
    updatedAt: null,
    firstSeenAt: "2026-11-24T12:05:00.000Z",
    ...overrides,
  };
}

describe("feeds mapping", () => {
  test("loadFeeds validates feeds.yaml", async () => {
    const feeds = await loadFeeds();
    expect(feeds.length).toBeGreaterThan(0);
  });

  test("parseFeedsYaml rejects invalid feed entries", () => {
    expect(() =>
      parseFeedsYaml(`
- id: nyt
  name: NYT
  category: general
  url: https://example.com/a.xml
- id: nyt
  name: NYT Duplicate
  category: general
  url: https://example.com/b.xml
`),
    ).toThrow("Duplicate feed id");

    expect(() =>
      parseFeedsYaml(`
- id: a
  name: Feed A
  category: unknown
  url: https://example.com/a.xml
`),
    ).toThrow("invalid category");

    expect(() =>
      parseFeedsYaml(`
- id: a
  name: Feed A
  category: general
  url: https://example.com/a.xml
  extra: nope
`),
    ).toThrow("exact keys");
  });

  test("canonicalizeUrl strips tracking parameters and fragments", () => {
    expect(
      canonicalizeUrl(
        "https://apnews.com/article/test?utm_source=flipboard&utm_content=Top&id=42#top",
      ),
    ).toBe("https://apnews.com/article/test?id=42");
  });

  test("toDocument keeps allowlisted meta and avoids duplicating summary inside content", () => {
    const doc = toDocument(
      makeItem({
        summary: "Lead paragraph.",
        content: "Lead paragraph. Full article body continues here.",
        publisher: "Associated Press",
      }),
    );
    expect(Object.keys(doc.meta).sort()).toEqual([
      "authors",
      "category",
      "date",
      "description",
      "first_seen_at",
      "publisher",
      "source",
      "title",
    ]);
    expect(doc.body?.media_type).toBe("text/plain");
    expect(doc.body?.data).toBe(
      [
        "Lead paragraph. Full article body continues here.",
        "Jane Doe",
        "Economy, Markets",
        "The New York Times, Associated Press",
      ].join("\n"),
    );

    const longSummary = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const truncated = toDocument(makeItem({ summary: longSummary, content: "" }));
    const desc = String(truncated.meta.description);
    expect(desc.length).toBeLessThanOrEqual(200);
    expect(desc.endsWith("…")).toBe(true);
    expect(desc).not.toMatch(/\s…$/);
    expect(truncated.body?.data).toContain(longSummary);
  });

  test("windowLabels keeps only allowlisted public corpus labels", () => {
    for (const config of Object.values(WINDOW_TAGS)) {
      const labels = windowLabels(config);
      expect(Object.keys(labels).sort()).toEqual([...ALLOWED_LABEL_KEYS]);
      expect(labels.window).toBe(config.windowLabel);
    }
  });

  test("partitionWindowItems builds disjoint delta slices ordered narrowest-first", () => {
    const now = new Date("2026-11-24T15:00:00.000Z");
    const items = [
      makeItem({ url: "https://example.com/in-24h", publishedAt: "2026-11-24T10:00:00.000Z" }),
      makeItem({ url: "https://example.com/in-7d", publishedAt: "2026-11-21T15:00:00.000Z" }),
      makeItem({ url: "https://example.com/in-30d", publishedAt: "2026-11-01T15:00:00.000Z" }),
      makeItem({ url: "https://example.com/too-old", publishedAt: "2026-10-20T15:00:00.000Z" }),
    ];

    const full = partitionWindowItems(items, ["today", "thisweek", "thismonth"], now);
    expect(full.orderedWindows).toEqual(["today", "thisweek", "thismonth"]);
    expect(full.slices.today.map((item) => item.url)).toEqual(["https://example.com/in-24h"]);
    expect(full.slices.thisweek.map((item) => item.url)).toEqual(["https://example.com/in-7d"]);
    expect(full.slices.thismonth.map((item) => item.url)).toEqual(["https://example.com/in-30d"]);

    const subset = partitionWindowItems(items, ["thismonth", "today", "today"], now);
    expect(subset.orderedWindows).toEqual(["today", "thismonth"]);
    expect(subset.slices.today.map((item) => item.url)).toEqual(["https://example.com/in-24h"]);
    expect(subset.slices.thisweek).toEqual([]);
    expect(subset.slices.thismonth.map((item) => item.url)).toEqual([
      "https://example.com/in-7d",
      "https://example.com/in-30d",
    ]);
  });
});

describe("per-feed JSONL store", () => {
  test("upsertFeedItems preserves earliest firstSeenAt and writes feed/<feedId>/YYYY-MM-DD.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "news-store-"));
    try {
      const first = await upsertFeedItems(dir, "nyt", [
        makeItem({ url: "https://example.com/b", firstSeenAt: "2026-11-24T12:05:00.000Z" }),
        makeItem({ url: "https://example.com/a", firstSeenAt: "2026-11-24T12:05:00.000Z" }),
      ]);
      expect(first).toEqual({ added: 2, updated: 0, unchanged: 0 });

      const repeat = await upsertFeedItems(dir, "nyt", [
        makeItem({ url: "https://example.com/a", firstSeenAt: "2026-11-24T12:20:00.000Z" }),
      ]);
      expect(repeat).toEqual({ added: 0, updated: 0, unchanged: 1 });

      const updated = await upsertFeedItems(dir, "nyt", [
        makeItem({
          url: "https://example.com/a",
          title: "Updated Headline",
          updatedAt: "2026-11-24T12:30:00.000Z",
          firstSeenAt: "2026-11-24T12:35:00.000Z",
        }),
      ]);
      expect(updated).toEqual({ added: 0, updated: 1, unchanged: 0 });

      const lines = (await Bun.file(join(dir, "nyt/2026-11-24.jsonl")).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FeedItem);
      expect(lines.map((item) => item.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b",
      ]);
      expect(lines[0]!.title).toBe("Updated Headline");
      expect(lines[0]!.firstSeenAt).toBe("2026-11-24T12:05:00.000Z");

      const cursor = {
        etag: '"v1"',
        lastModified: null,
        lastPollAt: "2026-11-24T12:35:00.000Z",
        lastOkAt: "2026-11-24T12:35:00.000Z",
        consecutiveFailures: 0,
        backoffUntil: null,
        lastError: null,
      };
      await writeFeedState(dir, "nyt", cursor);
      expect(await readFeedState(dir, "nyt")).toEqual(cursor);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readWindow filters by exact rolling window, deduplicates across feeds, and pruneOldDays preserves state.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "news-store-"));
    try {
      const now = new Date("2026-11-24T15:00:00.000Z");
      await upsertFeedItems(dir, "nyt", [
        makeItem({
          url: "https://example.com/fresh",
          publishedAt: "2026-11-23T16:00:00.000Z",
          firstSeenAt: "2026-11-23T16:05:00.000Z",
        }),
        makeItem({
          url: "https://example.com/stale-for-today",
          publishedAt: "2026-11-23T14:00:00.000Z",
          firstSeenAt: "2026-11-23T14:05:00.000Z",
        }),
      ]);
      await upsertFeedItems(dir, "ap", [
        makeItem({
          feedId: "ap",
          url: "https://example.com/fresh",
          title: "Fresher copy",
          publishedAt: "2026-11-23T16:00:00.000Z",
          updatedAt: "2026-11-23T17:00:00.000Z",
          firstSeenAt: "2026-11-23T17:05:00.000Z",
        }),
      ]);
      await writeFeedState(dir, "nyt", {
        etag: null,
        lastModified: null,
        lastPollAt: "2026-11-24T15:00:00.000Z",
        lastOkAt: "2026-11-24T15:00:00.000Z",
        consecutiveFailures: 0,
        backoffUntil: null,
        lastError: null,
      });

      const today = await readWindow(dir, 24, now);
      expect(today.map((item) => item.url)).toEqual(["https://example.com/fresh"]);
      expect(today[0]!.title).toBe("Fresher copy");
      expect(today[0]!.firstSeenAt).toBe("2026-11-23T16:05:00.000Z");

      const week = await readWindow(dir, 24 * 7, now);
      expect(week.map((item) => item.url)).toEqual([
        "https://example.com/fresh",
        "https://example.com/stale-for-today",
      ]);

      const pruned = await pruneOldDays(dir, 0, new Date("2026-11-24T00:00:00.000Z"));
      expect(pruned).toEqual(["ap/2026-11-23.jsonl", "nyt/2026-11-23.jsonl"]);
      expect(await readdir(join(dir, "nyt"))).toEqual(["state.json"]);
      expect(await readdir(join(dir, "ap"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
