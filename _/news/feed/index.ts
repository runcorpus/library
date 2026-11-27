import { resolve } from "node:path";
import { parseFeed, type AtomFeed, type RssFeed } from "feedsmith";
import type { IngestDocument } from "@corpusd/api";

export const FEED_CATEGORIES = [
  "general",
  "local",
  "business",
  "tech",
  "science",
  "health",
  "sports",
  "gaming",
  "entertainment",
  "travel",
  "automotive",
  "education",
  "lifestyle",
] as const;

export type FeedCategory = (typeof FEED_CATEGORIES)[number];

export interface FeedSource {
  id: string;
  name: string;
  category: FeedCategory;
  url: string;
}

export interface FeedItem {
  url: string;
  guid: string;
  feedId: string;
  source: string;
  publisher: string | null;
  category: FeedSource["category"];
  title: string;
  summary: string;
  content: string;
  caption: string;
  authors: string[];
  tags: string[];
  publishedAt: string | null;
  updatedAt: string | null;
  firstSeenAt: string;
}

export interface FetchFeedOptions {
  etag?: string | null;
  lastModified?: string | null;
  now?: Date;
}

export type FetchFeedResult =
  | {
      status: "not_modified";
      source: FeedSource;
      etag: string | null;
      lastModified: string | null;
      ms: number;
    }
  | {
      status: "ok";
      source: FeedSource;
      format: "rss" | "atom" | "sitemap";
      etag: string | null;
      lastModified: string | null;
      ms: number;
      items: FeedItem[];
    };

export const DEFAULT_FEEDS_PATH = resolve(import.meta.dir, "../feeds.yaml");

const FEED_ENTRY_KEYS = ["category", "id", "name", "url"] as const;
const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FEED_CATEGORY_SET = new Set<string>(FEED_CATEGORIES);

function isFeedCategory(value: string): value is FeedCategory {
  return FEED_CATEGORY_SET.has(value);
}

/**
 * Parse and strictly validate a YAML feed registry list.
 */
export function parseFeedsYaml(raw: string): FeedSource[] {
  const parsed = Bun.YAML.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("feeds.yaml must contain a non-empty YAML list");
  }

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const feeds: FeedSource[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Feed entry ${i} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== FEED_ENTRY_KEYS.length ||
      keys.some((key, index) => key !== FEED_ENTRY_KEYS[index])
    ) {
      throw new Error(`Feed entry ${i} must have exact keys: ${FEED_ENTRY_KEYS.join(", ")}`);
    }

    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!FEED_ID_PATTERN.test(id)) {
      throw new Error(`Feed entry ${i} has invalid id: ${String(record.id)}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate feed id: ${id}`);
    }
    seenIds.add(id);

    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      throw new Error(`Feed ${id} must have a non-empty name`);
    }

    const category = typeof record.category === "string" ? record.category.trim() : "";
    if (!isFeedCategory(category)) {
      throw new Error(`Feed ${id} has invalid category: ${String(record.category)}`);
    }

    const rawUrl = typeof record.url === "string" ? record.url.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new Error(`Feed ${id} has invalid URL: ${String(record.url)}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Feed ${id} must use http or https URL: ${rawUrl}`);
    }
    if (seenUrls.has(parsedUrl.href)) {
      throw new Error(`Duplicate feed URL: ${parsedUrl.href}`);
    }
    seenUrls.add(parsedUrl.href);

    feeds.push({ id, name, category, url: parsedUrl.href });
  }

  return feeds;
}

export async function loadFeeds(path = DEFAULT_FEEDS_PATH): Promise<FeedSource[]> {
  return parseFeedsYaml(await Bun.file(path).text());
}

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source", "guccounter", "guce_referrer", "guce_referrer_sig",
]);

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

const SHOPPING_PATH_PATTERN =
  /^\/(?:cnn-underscored|select\/shopping|nbc-select|wirecutter|story\/shopping|shopping\/deals|vetted|forbes-vetted)(?:\/|$)|\/shopping\/deals(?:\/|$)/i;

export function isShoppingSitemapUrl(url: string): boolean {
  try {
    return SHOPPING_PATH_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function canonicalizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    if (
      (host === "www.bbc.co.uk" || host === "bbc.co.uk" || host === "bbc.com") &&
      (parsed.pathname.startsWith("/news") || parsed.pathname.startsWith("/sport"))
    ) {
      parsed.hostname = "www.bbc.com";
    } else if (host === "abcnews.go.com") {
      parsed.hostname = "abcnews.com";
    }
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    }
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function toRfc3339(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function stripHtml(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = stripHtml(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function extractRssItems(source: FeedSource, feed: RssFeed.Feed<string>, seenAt: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const item of feed.items ?? []) {
    const rawLink = item.link ?? (item.guid?.isPermaLink !== false ? item.guid?.value : undefined);
    const url = rawLink ? canonicalizeUrl(rawLink) : null;
    const title = stripHtml(item.title);
    if (!url || !title) continue;
    const summary = stripHtml(item.description);
    const content = stripHtml(item.content?.encoded);
    const caption = stripHtml(item.media?.description?.value);
    const authors = uniqueStrings([
      ...(item.authors?.map((author) => author.name) ?? []),
      ...(item.dc?.creators ?? []),
    ]);
    const tags = uniqueStrings(item.categories?.map((cat) => cat.name) ?? []);
    const publisher = uniqueStrings(item.dc?.publishers ?? []).find(
      (name) => name.toLowerCase() !== source.name.toLowerCase(),
    ) ?? null;
    const modified = Array.isArray(item.dcterms?.modified) ? item.dcterms.modified[0] : item.dcterms?.modified;
    const publishedAt = toRfc3339(item.pubDate ?? item.dc?.dates?.[0] ?? item.atom?.published);
    const updatedAt = toRfc3339(item.atom?.updated ?? modified);
    out.push({
      url,
      guid: item.guid?.value?.trim() || url,
      feedId: source.id,
      source: source.name,
      publisher,
      category: source.category,
      title,
      summary,
      content,
      caption,
      authors,
      tags,
      publishedAt,
      updatedAt,
      firstSeenAt: seenAt,
    });
  }
  return out;
}

function extractAtomItems(source: FeedSource, feed: AtomFeed.Feed<string>, seenAt: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const entry of feed.entries ?? []) {
    const alt = entry.links?.find((link) => !link.rel || link.rel === "alternate") ?? entry.links?.[0];
    const url = alt?.href ? canonicalizeUrl(alt.href) : null;
    const title = stripHtml(entry.title?.value);
    if (!url || !title) continue;
    const summary = stripHtml(entry.summary?.value);
    const content = stripHtml(entry.content?.value);
    const caption = stripHtml(entry.media?.description?.value);
    const authors = uniqueStrings([
      ...(entry.authors?.map((author) => author.name) ?? []),
      ...(entry.dc?.creators ?? []),
    ]);
    const tags = uniqueStrings(entry.categories?.map((cat) => cat.label ?? cat.term) ?? []);
    const publisher = uniqueStrings(entry.dc?.publishers ?? []).find(
      (name) => name.toLowerCase() !== source.name.toLowerCase(),
    ) ?? null;
    const publishedAt = toRfc3339(entry.published);
    const updatedAt = toRfc3339(entry.updated);
    out.push({
      url,
      guid: entry.id?.trim() || url,
      feedId: source.id,
      source: source.name,
      publisher,
      category: source.category,
      title,
      summary,
      content,
      caption,
      authors,
      tags,
      publishedAt,
      updatedAt,
      firstSeenAt: seenAt,
    });
  }
  return out;
}

const GOOGLE_TRENDS_NS = "https://trends.google.com/trending/rss";

function unwrapXmlText(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const cdata = trimmed.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return cdata[1]!.trim();
  return trimmed
    .replace(
      /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi,
      (match, named?: string, dec?: string, hex?: string) => {
        if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? match;
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
        return match;
      },
    )
    .trim();
}

function readXmlTag(block: string, tagName: string): string | undefined {
  const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`));
  return match?.[1];
}

function readPrefixedXmlTag(block: string, localName: string): string | undefined {
  const match = block.match(
    new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${localName}>`),
  );
  return match?.[1];
}

export function isNewsSitemap(xml: string): boolean {
  return (
    xml.includes("<urlset") &&
    (xml.includes("sitemap-news") || /<(?:[A-Za-z0-9_-]+:)?news(?:\s[^>]*)?>/.test(xml))
  );
}

/**
 * Extract articles from a Google News Sitemap `<urlset>` XML payload.
 */
export function extractNewsSitemapItems(source: FeedSource, xml: string, seenAt: string): FeedItem[] {
  const byUrl = new Map<string, FeedItem>();
  for (const urlMatch of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/g)) {
    const urlXml = urlMatch[1]!;
    const rawUrl = unwrapXmlText(readXmlTag(urlXml, "loc"));
    const url = rawUrl ? canonicalizeUrl(rawUrl) : null;
    if (!url || isShoppingSitemapUrl(url)) continue;

    const newsBlock = urlXml.match(
      /<(?:[A-Za-z0-9_-]+:)?news(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?news>/,
    )?.[1];
    if (!newsBlock) continue;

    const language = stripHtml(unwrapXmlText(readPrefixedXmlTag(newsBlock, "language"))).toLowerCase();
    if (language && !language.startsWith("en")) continue;

    const title = stripHtml(unwrapXmlText(readPrefixedXmlTag(newsBlock, "title")));
    if (!title) continue;

    const publishedAt = toRfc3339(unwrapXmlText(readPrefixedXmlTag(newsBlock, "publication_date")));
    const lastmod = toRfc3339(unwrapXmlText(readXmlTag(urlXml, "lastmod")));
    const updatedAt = lastmod && lastmod !== publishedAt ? lastmod : null;

    const rawPublisher = stripHtml(unwrapXmlText(readPrefixedXmlTag(newsBlock, "name")));
    const publisher =
      rawPublisher && rawPublisher.toLowerCase() !== source.name.toLowerCase() ? rawPublisher : null;

    const keywords = unwrapXmlText(readPrefixedXmlTag(newsBlock, "keywords"));
    const stockTickers = unwrapXmlText(readPrefixedXmlTag(newsBlock, "stock_tickers"));
    const tags = uniqueStrings([
      ...(keywords ? keywords.split(",") : []),
      ...(stockTickers ? stockTickers.split(",") : []),
    ]);

    const imageBlock = urlXml.match(
      /<(?:[A-Za-z0-9_-]+:)?image(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?image>/,
    )?.[1];
    const rawCaption = imageBlock ? stripHtml(unwrapXmlText(readPrefixedXmlTag(imageBlock, "caption"))) : "";
    const caption = rawCaption && rawCaption.toLowerCase() !== title.toLowerCase() ? rawCaption : "";

    const existing = byUrl.get(url);
    if (existing) {
      existing.tags = uniqueStrings([...existing.tags, ...tags]);
      if (!existing.caption && caption) existing.caption = caption;
      if (!existing.updatedAt && updatedAt) existing.updatedAt = updatedAt;
      continue;
    }

    byUrl.set(url, {
      url,
      guid: url,
      feedId: source.id,
      source: source.name,
      publisher,
      category: source.category,
      title,
      summary: "",
      content: "",
      caption,
      authors: [],
      tags,
      publishedAt,
      updatedAt,
      firstSeenAt: seenAt,
    });
  }
  return [...byUrl.values()];
}

export function isGoogleTrendsFeed(xml: string): boolean {
  return (
    xml.includes(`xmlns:ht="${GOOGLE_TRENDS_NS}"`) ||
    xml.includes(`xmlns:ht='${GOOGLE_TRENDS_NS}'`)
  );
}

/**
 * Extract underlying publisher articles from Google Trends RSS `<ht:news_item>` entries.
 */
export function extractGoogleTrendsItems(source: FeedSource, xml: string, seenAt: string): FeedItem[] {
  const byUrl = new Map<string, FeedItem>();
  for (const itemMatch of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const itemXml = itemMatch[1]!;
    const topic = stripHtml(unwrapXmlText(readXmlTag(itemXml, "title")));
    const publishedAt = toRfc3339(unwrapXmlText(readXmlTag(itemXml, "pubDate")));

    for (const newsMatch of itemXml.matchAll(/<ht:news_item(?:\s[^>]*)?>([\s\S]*?)<\/ht:news_item>/g)) {
      const newsXml = newsMatch[1]!;
      const rawUrl = unwrapXmlText(readXmlTag(newsXml, "ht:news_item_url"));
      const url = rawUrl ? canonicalizeUrl(rawUrl) : null;
      const title = stripHtml(unwrapXmlText(readXmlTag(newsXml, "ht:news_item_title")));
      if (!url || !title) continue;

      const summary = stripHtml(unwrapXmlText(readXmlTag(newsXml, "ht:news_item_snippet")));
      const rawPublisher = stripHtml(unwrapXmlText(readXmlTag(newsXml, "ht:news_item_source")));
      const publisher =
        rawPublisher && rawPublisher.toLowerCase() !== source.name.toLowerCase() ? rawPublisher : null;

      const existing = byUrl.get(url);
      if (existing) {
        existing.tags = uniqueStrings([...existing.tags, topic]);
        if (!existing.summary && summary) existing.summary = summary;
        continue;
      }

      byUrl.set(url, {
        url,
        guid: url,
        feedId: source.id,
        source: source.name,
        publisher,
        category: source.category,
        title,
        summary,
        content: "",
        caption: "",
        authors: [],
        tags: uniqueStrings([topic]),
        publishedAt,
        updatedAt: null,
        firstSeenAt: seenAt,
      });
    }
  }
  return [...byUrl.values()];
}

export const MAX_DESCRIPTION_CHARS = 500;

const BOILERPLATE_SUMMARY_PATTERNS = [
  /^comments$/i,
  /^Article URL:\s*https?:\/\/\S+\s+Comments URL:\s*https?:\/\//i,
];

/**
 * Drop empty or non-abstract link boilerplate (e.g. Lobsters "Comments" and HN link stubs).
 */
export function usableSummary(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (BOILERPLATE_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed))) return "";
  return trimmed;
}

/**
 * Truncate retained summary metadata to at most maxChars on a word boundary.
 */
export function truncateDescription(text: string, maxChars = MAX_DESCRIPTION_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  let cut = trimmed.slice(0, maxChars - 1);
  const boundary = cut.lastIndexOf(" ");
  if (boundary >= Math.floor(maxChars / 2)) {
    cut = cut.slice(0, boundary);
  }
  return `${cut.replace(/[\s,.;:!?-]+$/, "")}…`;
}

export function toDocument(item: FeedItem): IngestDocument {
  const summary = usableSummary(item.summary);
  const content = usableSummary(item.content);
  const rawDescription = summary || content;
  const description = rawDescription ? truncateDescription(rawDescription) : "";
  const meta: IngestDocument["meta"] = {
    title: item.title,
    ...(description && { description }),
    ...(item.publishedAt && { date: item.publishedAt }),
    ...(item.updatedAt && { updated_at: item.updatedAt }),
    first_seen_at: item.firstSeenAt,
    source: item.source,
    ...(item.publisher && { publisher: item.publisher }),
    category: item.category,
    ...(item.authors.length && { authors: item.authors }),
  };

  const sections: string[] = [];
  // Preserve the original summary when its retained metadata description was
  // truncated. Other body sections are independent source content.
  if (description !== rawDescription) {
    sections.push(rawDescription);
  }
  if (content && content !== description && content !== rawDescription) sections.push(content);
  if (item.caption && !sections.some((section) => section.includes(item.caption))) {
    sections.push(item.caption);
  }
  if (item.tags.length) sections.push(item.tags.join(", "));

  return {
    url: item.url,
    meta,
    ...(sections.length > 0 && { body: { media_type: "text/plain", data: sections.join("\n") } }),
  };
}

export class FeedHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds: number | null,
    message: string,
  ) {
    super(message);
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header?.trim()) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const ms = Date.parse(header.trim());
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
}

export async function fetchFeed(source: FeedSource, options: FetchFeedOptions = {}): Promise<FetchFeedResult> {
  const started = performance.now();
  const seenAt = (options.now ?? new Date()).toISOString();
  const headers: Record<string, string> = {
    "user-agent": "Corpus/0.1 (+https://runcorpus.com/library/_/news)",
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;

  const response = await fetch(source.url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const ms = Math.round(performance.now() - started);
  const etag = response.headers.get("etag") ?? options.etag ?? null;
  const lastModified = response.headers.get("last-modified") ?? options.lastModified ?? null;

  if (response.status === 304) {
    await response.body?.cancel();
    return { status: "not_modified", source, etag, lastModified, ms };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FeedHttpError(
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
      `HTTP ${response.status} ${response.statusText}`,
    );
  }
  const rawBytes = new Uint8Array(await response.arrayBuffer());
  const isGzip = rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;
  const xml = new TextDecoder().decode(isGzip ? Bun.gunzipSync(rawBytes) : rawBytes);
  if (isNewsSitemap(xml)) {
    return {
      status: "ok",
      source,
      format: "sitemap",
      etag,
      lastModified,
      ms,
      items: extractNewsSitemapItems(source, xml, seenAt),
    };
  }
  const parsed = parseFeed(xml);
  let items: FeedItem[];
  if (parsed.format === "rss") {
    items = isGoogleTrendsFeed(xml)
      ? extractGoogleTrendsItems(source, xml, seenAt)
      : extractRssItems(source, parsed.feed, seenAt);
  } else if (parsed.format === "atom") {
    items = extractAtomItems(source, parsed.feed, seenAt);
  } else {
    throw new Error(`Unsupported feed format: ${parsed.format}`);
  }
  return { status: "ok", source, format: parsed.format, etag, lastModified, ms, items };
}
