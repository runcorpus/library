import type { IngestDocument } from "@corpusd/api";

export interface CurrentEventItem {
  url: string;
  title: string;
  summary: string;
  date: string;
  updatedAt: string | null;
  category: string;
  topics: string[];
  sources: string[];
  wikipediaPath: string;
  revisionId: number | null;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
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

export const MAX_TITLE_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 500;
const API_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = "Corpus/0.1 (+https://runcorpus.com/library/wikimedia/current-events)";
const QUERY_BATCH_SIZE = 50;

export function formatUtcDateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatPortalDayTitle(date: Date): string {
  const year = date.getUTCFullYear();
  const month = MONTH_NAMES[date.getUTCMonth()]!;
  const day = date.getUTCDate();
  return `Portal:Current events/${year} ${month} ${day}`;
}

export function portalDayPath(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  return `/wiki/${formatPortalDayTitle(date).replace(/ /g, "_")}`;
}

export function canonicalizeUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
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

function decodeEntities(text: string): string {
  return text
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/**
 * Strip MediaWiki formatting, inline templates, wikilinks, and HTML comments into plain text.
 */
export function cleanWikitext(raw: string): string {
  let text = raw.replace(/<!--[\s\S]*?-->/g, " ");
  text = text
    .replace(/\{\{(?:cvt|convert)\|([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}\}/gi, "$1 $2")
    .replace(/\{\{(?:small|nowrap)\|([^{}]*)\}\}/gi, "$1")
    .replace(/\{\{lang\|[^|}]+\|([^{}]*)\}\}/gi, "$1");
  for (let i = 0; i < 2; i++) {
    text = text.replace(/\{\{[^{}]*\}\}/g, " ");
  }
  text = text
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'''+/g, "")
    .replace(/''/g, "");
  text = decodeEntities(text);
  return text.replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  let cut = trimmed.slice(0, maxChars - 1);
  const boundary = cut.lastIndexOf(" ");
  if (boundary >= Math.floor(maxChars / 2)) {
    cut = cut.slice(0, boundary);
  }
  return `${cut.replace(/[\s,.;:!?-]+$/, "")}…`;
}

function deriveTitle(summary: string, topics: readonly string[] = []): string {
  const leafTopic = topics.length ? topics[topics.length - 1]!.trim() : "";
  if (leafTopic) {
    return truncateText(leafTopic, MAX_TITLE_CHARS);
  }
  const trimmed = summary.trim();
  if (trimmed.length <= MAX_TITLE_CHARS) return trimmed;
  const sentenceEnd = trimmed.search(/[.!?](?:\s|$)/);
  if (sentenceEnd >= 25 && sentenceEnd < MAX_TITLE_CHARS) {
    return trimmed.slice(0, sentenceEnd + 1).trim();
  }
  return truncateText(trimmed, MAX_TITLE_CHARS);
}

function mergeStringLists(primary: readonly string[], secondary: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...primary, ...secondary]) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function cleanSourceLabel(rawLabel: string | undefined): string {
  if (!rawLabel) return "";
  let cleaned = cleanWikitext(rawLabel);
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

/**
 * Merge two observations sharing a canonical cited article URL.
 */
export function mergeEventItems(prior: CurrentEventItem, incoming: CurrentEventItem): CurrentEventItem {
  const keepPriorPrimary = prior.date <= incoming.date;
  const primary = keepPriorPrimary ? prior : incoming;
  const secondary = keepPriorPrimary ? incoming : prior;

  let summary = primary.summary;
  if (secondary.summary && !primary.summary.includes(secondary.summary)) {
    summary = primary.summary ? `${primary.summary} ${secondary.summary}` : secondary.summary;
  }

  const updatedAt =
    prior.updatedAt && incoming.updatedAt
      ? prior.updatedAt >= incoming.updatedAt
        ? prior.updatedAt
        : incoming.updatedAt
      : (prior.updatedAt ?? incoming.updatedAt);

  const topics = mergeStringLists(primary.topics, secondary.topics);

  return {
    ...primary,
    title: deriveTitle(summary, topics),
    summary,
    updatedAt,
    topics,
    sources: mergeStringLists(primary.sources, secondary.sources),
  };
}

interface BulletLine {
  depth: number;
  body: string;
  category: string;
}

/**
 * Parse one Portal:Current events daily page wikitext into per-citation event documents.
 */
export function parseDayWikitext(
  dateIso: string,
  wikipediaPath: string,
  revisionId: number | null,
  updatedAt: string | null,
  wikitext: string,
): CurrentEventItem[] {
  const lines = wikitext.replace(/\r\n?/g, "\n").split("\n");
  let currentCategory = "General";
  const entries: BulletLine[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;

    const boldCategory = line.match(/^'''([^']+)'''\s*$/);
    if (boldCategory) {
      const cleaned = cleanWikitext(boldCategory[1]!);
      if (cleaned) currentCategory = cleaned;
      continue;
    }

    const defCategory = line.match(/^;\s*(.+)$/);
    if (defCategory) {
      const cleaned = cleanWikitext(defCategory[1]!);
      if (cleaned) currentCategory = cleaned;
      continue;
    }

    const bullet = line.match(/^(\*+)\s*(.*)$/);
    if (bullet) {
      entries.push({
        depth: bullet[1]!.length,
        body: bullet[2]!,
        category: currentCategory,
      });
    }
  }

  const byUrl = new Map<string, CurrentEventItem>();
  const topicStack: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    topicStack.length = Math.max(0, entry.depth - 1);

    const citations: { url: string; source: string }[] = [];
    const bodyWithoutLinks = entry.body.replace(
      /\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g,
      (_, rawUrl: string, rawLabel?: string) => {
        const canonical = canonicalizeUrl(rawUrl);
        if (canonical) {
          citations.push({ url: canonical, source: cleanSourceLabel(rawLabel) });
        }
        return " ";
      },
    );

    const nextEntry = entries[i + 1];
    const hasChildBullets =
      nextEntry !== undefined &&
      nextEntry.category === entry.category &&
      nextEntry.depth > entry.depth;

    const cleanedText = cleanWikitext(bodyWithoutLinks);
    if (hasChildBullets && citations.length === 0) {
      if (cleanedText) {
        topicStack[entry.depth - 1] = cleanedText;
      }
      continue;
    }

    if (citations.length === 0 || !cleanedText) continue;

    const primaryUrl = citations[0]!.url;
    const sources = mergeStringLists(
      citations.map((c) => c.source),
      [],
    );
    const topics = mergeStringLists(
      topicStack.filter((topic): topic is string => Boolean(topic)),
      [],
    );

    const item: CurrentEventItem = {
      url: primaryUrl,
      title: deriveTitle(cleanedText, topics),
      summary: cleanedText,
      date: dateIso,
      updatedAt,
      category: entry.category,
      topics,
      sources,
      wikipediaPath,
      revisionId,
    };

    const existing = byUrl.get(primaryUrl);
    byUrl.set(primaryUrl, existing ? mergeEventItems(existing, item) : item);
  }

  return [...byUrl.values()];
}

interface MediaWikiRevision {
  revid?: number;
  timestamp?: string;
  slots?: {
    main?: {
      content?: string;
    };
  };
}

interface MediaWikiPage {
  title: string;
  missing?: boolean;
  revisions?: MediaWikiRevision[];
}

interface MediaWikiQueryResponse {
  query?: {
    pages?: MediaWikiPage[];
  };
}

export function buildDayTargets(days: number, now = new Date()): { dateIso: string; title: string; path: string }[] {
  const count = Math.max(1, Math.floor(days));
  const out: { dateIso: string; title: string; path: string }[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const day = new Date(now.getTime() - offset * 86_400_000);
    const dateIso = formatUtcDateIso(day);
    const title = formatPortalDayTitle(day);
    out.push({
      dateIso,
      title,
      path: portalDayPath(dateIso),
    });
  }
  return out;
}

/**
 * Fetch and parse the requested number of trailing UTC days from Wikipedia Portal:Current events.
 */
export async function fetchCurrentEventsDays(days: number, now = new Date()): Promise<CurrentEventItem[]> {
  const targets = buildDayTargets(days, now);
  const byTitle = new Map(targets.map((target) => [target.title, target]));
  const deduped = new Map<string, CurrentEventItem>();

  for (let i = 0; i < targets.length; i += QUERY_BATCH_SIZE) {
    const batch = targets.slice(i, i + QUERY_BATCH_SIZE);
    const params = new URLSearchParams({
      action: "query",
      prop: "revisions",
      rvprop: "ids|timestamp|content",
      rvslots: "main",
      titles: batch.map((target) => target.title).join("|"),
      format: "json",
      formatversion: "2",
    });

    const response = await fetch(`${API_ENDPOINT}?${params.toString()}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Wikipedia API HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as MediaWikiQueryResponse;
    for (const page of payload.query?.pages ?? []) {
      if (page.missing) continue;
      const target = byTitle.get(page.title);
      const rev = page.revisions?.[0];
      const wikitext = rev?.slots?.main?.content;
      if (!target || !wikitext) continue;

      const parsed = parseDayWikitext(
        target.dateIso,
        target.path,
        rev.revid ?? null,
        rev.timestamp ?? null,
        wikitext,
      );
      for (const item of parsed) {
        const prior = deduped.get(item.url);
        deduped.set(item.url, prior ? mergeEventItems(prior, item) : item);
      }
    }
  }

  return [...deduped.values()].sort((a, b) => a.url.localeCompare(b.url));
}

export function toDocument(item: CurrentEventItem): IngestDocument {
  const candidateDescription = truncateText(item.summary, MAX_DESCRIPTION_CHARS);
  const description = candidateDescription && candidateDescription !== item.title ? candidateDescription : "";
  const meta: IngestDocument["meta"] = {
    title: item.title,
    ...(description && { description }),
    date: item.date,
    ...(item.updatedAt && { updated_at: item.updatedAt }),
    category: item.category,
    ...(item.topics.length && { topics: item.topics }),
    ...(item.sources.length && { sources: item.sources }),
    wikipedia_path: item.wikipediaPath,
  };

  // The summary and structured descriptors are already indexed from meta.
  // Preserve the complete source summary when its retained description is truncated.
  const fullTruncatedSummary = candidateDescription !== item.summary.trim() ? item.summary : "";

  return {
    url: item.url,
    meta,
    ...(fullTruncatedSummary && { body: { media_type: "text/plain", data: fullTruncatedSummary } }),
  };
}
