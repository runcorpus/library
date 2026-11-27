import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_LABEL_KEYS, WINDOW_TAGS, partitionWindowItems, windowLabels } from "../build";
import {
  canonicalizeUrl,
  extractGoogleTrendsItems,
  extractNewsSitemapItems,
  isGoogleTrendsFeed,
  isNewsSitemap,
  loadFeeds,
  parseFeedsYaml,
  toDocument,
  type FeedItem,
} from "./index";
import { mergeFeedItems, pruneOldDays, readFeedState, readWindow, upsertFeedItems, writeFeedState } from "./poll";

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

    const longSummary = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const truncated = toDocument(makeItem({ summary: longSummary, content: "" }));
    const desc = String(truncated.meta.description);
    expect(desc.length).toBeLessThanOrEqual(500);
    expect(desc.endsWith("…")).toBe(true);
    expect(desc).not.toMatch(/\s…$/);
    expect(truncated.body?.data).toContain(longSummary);

    const fallbackDoc = toDocument(
      makeItem({
        summary: "",
        content: "Content paragraph used when feed summary is empty.",
      }),
    );
    expect(fallbackDoc.meta.description).toBe("Content paragraph used when feed summary is empty.");

    const lobstersDoc = toDocument(makeItem({ summary: "Comments", content: "" }));
    expect(lobstersDoc.meta.description).toBeUndefined();
    expect(lobstersDoc.body?.data).toBe("Jane Doe\nEconomy, Markets\nThe New York Times");

    const hnDoc = toDocument(
      makeItem({
        summary: "Article URL: https://example.com/post Comments URL: https://news.ycombinator.com/item?id=1 Points: 42 # Comments: 10",
        content: "",
      }),
    );
    expect(hnDoc.meta.description).toBeUndefined();
    expect(hnDoc.body?.data).toBe("Jane Doe\nEconomy, Markets\nThe New York Times");
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

  test("extractGoogleTrendsItems extracts publisher articles and merges duplicate URLs", () => {
    const trendsXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0">
  <channel>
    <title>Daily Search Trends</title>
    <item>
      <title>topic alpha &amp; beta</title>
      <link>https://trends.google.com/trending/rss?geo=US</link>
      <pubDate>Thu, 26 Nov 2026 09:40:00 -0800</pubDate>
      <ht:news_item>
        <ht:news_item_title>Team&apos;s Star Out &amp; Injured</ht:news_item_title>
        <ht:news_item_snippet/>
        <ht:news_item_url>https://www.espn.com/story?id=1&amp;utm_source=trends</ht:news_item_url>
        <ht:news_item_source>ESPN</ht:news_item_source>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Second Angle</ht:news_item_title>
        <ht:news_item_snippet>Lead summary here.</ht:news_item_snippet>
        <ht:news_item_url>https://www.cbssports.com/story-2</ht:news_item_url>
        <ht:news_item_source>CBS Sports</ht:news_item_source>
      </ht:news_item>
    </item>
    <item>
      <title>topic gamma</title>
      <link>https://trends.google.com/trending/rss?geo=US</link>
      <pubDate>Thu, 26 Nov 2026 10:00:00 -0800</pubDate>
      <ht:news_item>
        <ht:news_item_title>Team&apos;s Star Out</ht:news_item_title>
        <ht:news_item_snippet>Filled snippet.</ht:news_item_snippet>
        <ht:news_item_url>https://www.espn.com/story?id=1</ht:news_item_url>
        <ht:news_item_source>ESPN</ht:news_item_source>
      </ht:news_item>
    </item>
  </channel>
</rss>`;

    expect(isGoogleTrendsFeed(trendsXml)).toBe(true);
    expect(isGoogleTrendsFeed("<rss version=\"2.0\"><channel></channel></rss>")).toBe(false);

    const items = extractGoogleTrendsItems(
      {
        id: "google-trends-us",
        name: "Google Trends US",
        category: "general",
        url: "https://trends.google.com/trending/rss?geo=US",
      },
      trendsXml,
      "2026-11-26T18:00:00.000Z",
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: "https://www.espn.com/story?id=1",
      title: "Team's Star Out & Injured",
      summary: "Filled snippet.",
      publisher: "ESPN",
      tags: ["topic alpha & beta", "topic gamma"],
      publishedAt: "2026-11-26T17:40:00.000Z",
    });

    const doc = toDocument(items[0]!);
    expect(Object.keys(doc.meta).sort()).toEqual([
      "category",
      "date",
      "description",
      "first_seen_at",
      "publisher",
      "source",
      "title",
    ]);
    expect(doc.body?.data).toContain("Filled snippet.");
    expect(doc.body?.data).toContain("topic alpha & beta, topic gamma");
    expect(doc.body?.data).toContain("Google Trends US, ESPN");
  });

  test("extractNewsSitemapItems handles standard and custom prefixes, filtering, and duplicate URLs", () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:n="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc><![CDATA[https://www.espn.com/nba/story?id=9&utm_source=sitemap]]></loc>
    <lastmod>2026-11-27T09:15:00Z</lastmod>
    <image:image>
      <image:title>Wrong Image Title</image:title>
      <image:caption>Arena warmups before tipoff.</image:caption>
    </image:image>
    <n:news>
      <n:publication>
        <n:name>ESPN</n:name>
        <n:language>en</n:language>
      </n:publication>
      <n:publication_date>2026-11-27T08:00:00Z</n:publication_date>
      <n:title><![CDATA[Star Guard Cleared &amp; Ready]]></n:title>
      <n:keywords>NBA, Playoffs</n:keywords>
      <n:stock_tickers>DIS</n:stock_tickers>
    </n:news>
  </url>
  <url>
    <loc>https://www.espn.com/nba/story?id=9</loc>
    <n:news>
      <n:publication>
        <n:name>ESPN</n:name>
        <n:language>en</n:language>
      </n:publication>
      <n:publication_date>2026-11-27T08:00:00Z</n:publication_date>
      <n:title>Star Guard Cleared &amp; Ready</n:title>
      <n:keywords>Basketball</n:keywords>
    </n:news>
  </url>
  <url>
    <loc>https://www.espn.com/deportes/nota</loc>
    <n:news>
      <n:publication>
        <n:name>ESPN Deportes</n:name>
        <n:language>es</n:language>
      </n:publication>
      <n:publication_date>2026-11-27T08:00:00Z</n:publication_date>
      <n:title>Nota en español</n:title>
    </n:news>
  </url>
</urlset>`;

    expect(isNewsSitemap(sitemapXml)).toBe(true);
    expect(isNewsSitemap("<rss version=\"2.0\"><channel></channel></rss>")).toBe(false);

    const items = extractNewsSitemapItems(
      {
        id: "espn-sitemap",
        name: "ESPN",
        category: "sports",
        url: "https://www.espn.com/googlenewssitemap",
      },
      sitemapXml,
      "2026-11-27T09:20:00.000Z",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      url: "https://www.espn.com/nba/story?id=9",
      title: "Star Guard Cleared & Ready",
      publisher: null,
      caption: "Arena warmups before tipoff.",
      tags: ["NBA", "Playoffs", "DIS", "Basketball"],
      publishedAt: "2026-11-27T08:00:00.000Z",
      updatedAt: "2026-11-27T09:15:00.000Z",
    });
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

  test("readWindow merges RSS summary/authors with newer sitemap tags and prefers direct publisher over Google Trends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "news-merge-"));
    try {
      const now = new Date("2026-11-27T12:00:00.000Z");
      await upsertFeedItems(dir, "nyt", [
        makeItem({
          feedId: "nyt",
          url: "https://www.nytimes.com/2026/11/27/business/story.html",
          source: "The New York Times",
          summary: "Detailed RSS summary from NYT.",
          content: "Full RSS content.",
          authors: ["Jane Doe"],
          tags: ["Economy"],
          publishedAt: "2026-11-27T08:00:00.000Z",
          firstSeenAt: "2026-11-27T08:05:00.000Z",
        }),
      ]);
      await upsertFeedItems(dir, "nyt-sitemap", [
        makeItem({
          feedId: "nyt-sitemap",
          url: "https://www.nytimes.com/2026/11/27/business/story.html",
          source: "The New York Times",
          summary: "",
          content: "",
          authors: [],
          tags: ["Markets", "economy"],
          publishedAt: "2026-11-27T08:00:00.000Z",
          updatedAt: "2026-11-27T09:00:00.000Z",
          firstSeenAt: "2026-11-27T09:05:00.000Z",
        }),
      ]);
      await upsertFeedItems(dir, "google-trends-us", [
        makeItem({
          feedId: "google-trends-us",
          url: "https://www.nytimes.com/2026/11/27/business/story.html",
          source: "Google Trends US",
          publisher: "The New York Times",
          summary: "",
          content: "",
          authors: [],
          tags: ["inflation report"],
          publishedAt: "2026-11-27T10:00:00.000Z",
          updatedAt: null,
          firstSeenAt: "2026-11-27T10:35:00.000Z",
        }),
      ]);

      const items = await readWindow(dir, 24, now);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        feedId: "nyt-sitemap",
        source: "The New York Times",
        publisher: null,
        summary: "Detailed RSS summary from NYT.",
        content: "Full RSS content.",
        authors: ["Jane Doe"],
        tags: ["Markets", "economy", "inflation report"],
        firstSeenAt: "2026-11-27T08:05:00.000Z",
        updatedAt: "2026-11-27T09:00:00.000Z",
      });

      const merged = mergeFeedItems(
        makeItem({ summary: "Comments", content: "" }),
        makeItem({ summary: "Real abstract.", updatedAt: "2026-11-24T13:00:00.000Z" }),
      );
      expect(merged.summary).toBe("Real abstract.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
