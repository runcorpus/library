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
      format: "rss" | "atom";
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

export function canonicalizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
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

export const MAX_DESCRIPTION_CHARS = 200;

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
  const description = item.summary ? truncateDescription(item.summary) : "";
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
  const primaryText = item.content && (!item.summary || item.content.includes(item.summary))
    ? item.content
    : item.summary;
  if (primaryText) sections.push(primaryText);
  if (item.content && item.content !== primaryText) sections.push(item.content);
  if (item.caption && !sections.some((section) => section.includes(item.caption))) {
    sections.push(item.caption);
  }
  if (item.authors.length) sections.push(item.authors.join(", "));
  if (item.tags.length) sections.push(item.tags.join(", "));
  sections.push(item.publisher ? `${item.source}, ${item.publisher}` : item.source);

  return {
    url: item.url,
    meta,
    body: { media_type: "text/plain", data: sections.join("\n") },
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
    "user-agent": "RunCorpusNewsBot/0.1 (+https://runcorpus.com)",
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
  const xml = await response.text();
  const parsed = parseFeed(xml);
  let items: FeedItem[];
  if (parsed.format === "rss") {
    items = extractRssItems(source, parsed.feed, seenAt);
  } else if (parsed.format === "atom") {
    items = extractAtomItems(source, parsed.feed, seenAt);
  } else {
    throw new Error(`Unsupported feed format: ${parsed.format}`);
  }
  return { status: "ok", source, format: parsed.format, etag, lastModified, ms, items };
}
