import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  FeedHttpError,
  canonicalizeUrl,
  fetchFeed,
  loadFeeds,
  usableSummary,
  type FeedItem,
  type FeedSource,
} from "./index";

export interface FeedCursor {
  etag: string | null;
  lastModified: string | null;
  lastPollAt: string;
  lastOkAt: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  lastError: string | null;
}

export interface PollSummary {
  storeDir: string;
  fetched: number;
  notModified: number;
  skippedBackoff: number;
  failed: number;
  added: number;
  updated: number;
  unchanged: number;
}

const DEFAULT_STORE_DIR = resolve(import.meta.dir);
const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function resolveStoreDir(override?: string): string {
  return resolve(override ?? process.env.NEWS_STORE_DIR ?? DEFAULT_STORE_DIR);
}

export function itemTimestamp(item: Pick<FeedItem, "publishedAt" | "firstSeenAt">): string {
  return item.publishedAt ?? item.firstSeenAt;
}

export function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

function normalizeForCompare(item: FeedItem): string {
  const { firstSeenAt: _, ...rest } = item;
  return JSON.stringify(rest);
}

function sortItems(items: Iterable<FeedItem>): FeedItem[] {
  return [...items].sort((a, b) => a.url.localeCompare(b.url));
}

async function writeAtomicIfChanged(path: string, content: string): Promise<boolean> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const existing = await file.text();
    if (existing === content) return false;
  }
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
  return true;
}

export async function readFeedState(storeDir: string, feedId: string): Promise<FeedCursor | null> {
  const file = Bun.file(join(storeDir, feedId, "state.json"));
  if (!(await file.exists())) return null;
  return (await file.json()) as FeedCursor;
}

export async function writeFeedState(
  storeDir: string,
  feedId: string,
  cursor: FeedCursor,
): Promise<void> {
  const feedDir = join(storeDir, feedId);
  await mkdir(feedDir, { recursive: true });
  await writeAtomicIfChanged(join(feedDir, "state.json"), JSON.stringify(cursor, null, 2) + "\n");
}

async function readJsonl(path: string): Promise<FeedItem[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const items: FeedItem[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    items.push(JSON.parse(line) as FeedItem);
  }
  return items;
}

async function listFeedIds(storeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(storeDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
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

/**
 * Merge two observations of the same canonical URL while preserving the earliest firstSeenAt
 * and non-empty metadata fields from the sparser copy's counterpart.
 */
export function mergeFeedItems(prior: FeedItem, incoming: FeedItem): FeedItem {
  const firstSeenAt = prior.firstSeenAt <= incoming.firstSeenAt ? prior.firstSeenAt : incoming.firstSeenAt;
  const priorIsTrends = prior.feedId.startsWith("google-trends-");
  const incomingIsTrends = incoming.feedId.startsWith("google-trends-");

  let winner: FeedItem;
  let other: FeedItem;
  if (priorIsTrends !== incomingIsTrends) {
    winner = priorIsTrends ? incoming : prior;
    other = priorIsTrends ? prior : incoming;
  } else {
    const priorFreshness = prior.updatedAt ?? prior.firstSeenAt;
    const incomingFreshness = incoming.updatedAt ?? incoming.firstSeenAt;
    winner = incomingFreshness >= priorFreshness ? incoming : prior;
    other = winner === incoming ? prior : incoming;
  }

  const summary = usableSummary(winner.summary)
    ? winner.summary
    : usableSummary(other.summary)
      ? other.summary
      : winner.summary || other.summary;
  const candidatePublisher = winner.publisher ?? other.publisher;
  const publisher =
    candidatePublisher && candidatePublisher.toLowerCase() !== winner.source.toLowerCase()
      ? candidatePublisher
      : null;
  const updatedAt =
    prior.updatedAt && incoming.updatedAt
      ? prior.updatedAt >= incoming.updatedAt
        ? prior.updatedAt
        : incoming.updatedAt
      : (prior.updatedAt ?? incoming.updatedAt);

  return {
    ...winner,
    summary,
    content: winner.content || other.content,
    caption: winner.caption || other.caption,
    publisher,
    publishedAt: winner.publishedAt ?? other.publishedAt,
    updatedAt,
    authors: mergeStringLists(winner.authors, other.authors),
    tags: mergeStringLists(winner.tags, other.tags),
    firstSeenAt,
  };
}

/**
 * Upsert items for one feed into <storeDir>/<feedId>/YYYY-MM-DD.jsonl.
 * Preserves the earliest firstSeenAt for an already stored URL.
 */
export async function upsertFeedItems(
  storeDir: string,
  feedId: string,
  incoming: FeedItem[],
): Promise<{ added: number; updated: number; unchanged: number }> {
  const byDay = new Map<string, FeedItem[]>();
  for (const item of incoming) {
    const day = utcDayKey(itemTimestamp(item));
    const bucket = byDay.get(day) ?? [];
    bucket.push(item);
    byDay.set(day, bucket);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const feedDir = join(storeDir, feedId);

  for (const [day, items] of byDay) {
    const path = join(feedDir, `${day}.jsonl`);
    const existing = await readJsonl(path);
    const map = new Map<string, FeedItem>(existing.map((item) => [item.url, item]));

    for (const item of items) {
      const prior = map.get(item.url);
      if (!prior) {
        map.set(item.url, item);
        added++;
        continue;
      }
      const merged = mergeFeedItems(prior, item);
      if (normalizeForCompare(prior) === normalizeForCompare(merged)) {
        unchanged++;
      } else {
        map.set(item.url, merged);
        updated++;
      }
    }

    const serialized = sortItems(map.values())
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n";
    await mkdir(feedDir, { recursive: true });
    await writeAtomicIfChanged(path, serialized);
  }

  return { added, updated, unchanged };
}

function dayKeysCovering(windowHours: number, now: Date): string[] {
  const daysBack = Math.ceil(windowHours / 24) + 1;
  const keys: string[] = [];
  for (let offset = daysBack; offset >= 0; offset--) {
    const date = new Date(now.getTime() - offset * 86_400_000);
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Read all deduplicated items inside [now - windowHours, now].
 * When the same URL appears across days or feeds, keep the most recently updated copy
 * while preserving the earliest firstSeenAt.
 */
export async function readWindow(
  storeDir: string,
  windowHours: number,
  now = new Date(),
): Promise<FeedItem[]> {
  const cutoffMs = now.getTime() - windowHours * 3_600_000;
  const feedIds = await listFeedIds(storeDir);
  const days = dayKeysCovering(windowHours, now);
  const deduped = new Map<string, FeedItem>();

  for (const feedId of feedIds) {
    for (const day of days) {
      const path = join(storeDir, feedId, `${day}.jsonl`);
      for (const rawItem of await readJsonl(path)) {
        const tsMs = Date.parse(itemTimestamp(rawItem));
        if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
        const url = canonicalizeUrl(rawItem.url) ?? rawItem.url;
        const item = url === rawItem.url ? rawItem : { ...rawItem, url };
        const prior = deduped.get(item.url);
        if (!prior) {
          deduped.set(item.url, item);
          continue;
        }
        deduped.set(item.url, mergeFeedItems(prior, item));
      }
    }
  }

  return sortItems(deduped.values());
}

/** Delete per-feed UTC day JSONL files strictly older than keepDays while preserving state.json. */
export async function pruneOldDays(
  storeDir: string,
  keepDays: number,
  now = new Date(),
): Promise<string[]> {
  const cutoffDay = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
  const removed: string[] = [];

  for (const feedId of await listFeedIds(storeDir)) {
    const feedDir = join(storeDir, feedId);
    const entries = (await readdir(feedDir)).sort();
    for (const name of entries) {
      const match = name.match(DAY_FILE_PATTERN);
      if (!match) continue;
      if (match[1]! < cutoffDay) {
        await rm(join(feedDir, name), { force: true });
        removed.push(`${feedId}/${name}`);
      }
    }
  }

  return removed.sort();
}

function nextBackoffIso(failures: number, retryAfterSeconds: number | null, now: Date): string {
  const exponentialSeconds = Math.min(6 * 3600, 15 * 60 * 2 ** Math.max(0, failures - 1));
  const waitSeconds = Math.max(exponentialSeconds, retryAfterSeconds ?? 0);
  return new Date(now.getTime() + waitSeconds * 1000).toISOString();
}

const POLL_CONCURRENCY = 16;

export async function pollIntoStore(
  storeDir = resolveStoreDir(),
  feeds?: FeedSource[],
  now = new Date(),
): Promise<PollSummary> {
  const sources = feeds ?? (await loadFeeds());
  const summary: PollSummary = {
    storeDir,
    fetched: 0,
    notModified: 0,
    skippedBackoff: 0,
    failed: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
  };

  let nextIndex = 0;
  const workerCount = Math.min(POLL_CONCURRENCY, sources.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < sources.length) {
        const source = sources[nextIndex++]!;
        const prior = await readFeedState(storeDir, source.id);
        if (prior?.backoffUntil && Date.parse(prior.backoffUntil) > now.getTime()) {
          summary.skippedBackoff++;
          continue;
        }
        const pollIso = now.toISOString();
        try {
          const result = await fetchFeed(source, {
            etag: prior?.etag,
            lastModified: prior?.lastModified,
            now,
          });
          await writeFeedState(storeDir, source.id, {
            etag: result.etag,
            lastModified: result.lastModified,
            lastPollAt: pollIso,
            lastOkAt: pollIso,
            consecutiveFailures: 0,
            backoffUntil: null,
            lastError: null,
          });
          if (result.status === "not_modified") {
            summary.notModified++;
            continue;
          }
          summary.fetched++;
          const counts = await upsertFeedItems(storeDir, source.id, result.items);
          summary.added += counts.added;
          summary.updated += counts.updated;
          summary.unchanged += counts.unchanged;
        } catch (error) {
          summary.failed++;
          const failures = (prior?.consecutiveFailures ?? 0) + 1;
          const retryAfter = error instanceof FeedHttpError ? error.retryAfterSeconds : null;
          await writeFeedState(storeDir, source.id, {
            etag: prior?.etag ?? null,
            lastModified: prior?.lastModified ?? null,
            lastPollAt: pollIso,
            lastOkAt: prior?.lastOkAt ?? null,
            consecutiveFailures: failures,
            backoffUntil: nextBackoffIso(failures, retryAfter, now),
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );

  return summary;
}

if (import.meta.main) {
  const storeDir = resolveStoreDir(process.argv[2]);
  const summary = await pollIntoStore(storeDir);
  const todayCount = (await readWindow(storeDir, 24)).length;
  console.log(JSON.stringify({ ...summary, todayCount }, null, 2));
}
