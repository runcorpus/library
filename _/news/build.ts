import { parseArgs } from "node:util";
import { SocketClient, type Client, type CorpusInfo } from "@corpusd/api";
import * as corpus from "@corpusd/api/corpus";
import { toDocument, type FeedItem } from "./feed";
import { itemTimestamp, pollIntoStore, readWindow, resolveStoreDir, type PollSummary } from "./feed/poll";

export const CORPUS_REPO = "_/news";
export const NEWS_DISPLAY_NAME = "News";
export const NEWS_DESCRIPTION =
  "Search recent news articles across major outlets by headline, summary, author, topic, and publisher.";
export const NEWS_LANGUAGE = "en";

export type WindowTagName = "today" | "thisweek" | "thismonth";

export const WINDOW_ORDER: readonly WindowTagName[] = ["today", "thisweek", "thismonth"];

export interface WindowTagConfig {
  name: WindowTagName;
  windowHours: number;
  windowLabel: "24h" | "7d" | "30d";
  tag: string;
  aliases: readonly string[];
}

export const WINDOW_TAGS: Record<WindowTagName, WindowTagConfig> = {
  today: {
    name: "today",
    windowHours: 24,
    windowLabel: "24h",
    tag: `${CORPUS_REPO}:today`,
    aliases: [],
  },
  thisweek: {
    name: "thisweek",
    windowHours: 24 * 7,
    windowLabel: "7d",
    tag: `${CORPUS_REPO}:thisweek`,
    aliases: [],
  },
  thismonth: {
    name: "thismonth",
    windowHours: 24 * 30,
    windowLabel: "30d",
    tag: `${CORPUS_REPO}:thismonth`,
    aliases: [`${CORPUS_REPO}:latest`],
  },
};

export const ALLOWED_LABEL_KEYS = ["description", "language", "name", "window"] as const;

export function windowLabels(config: Pick<WindowTagConfig, "windowLabel">): Record<string, string> {
  return {
    name: NEWS_DISPLAY_NAME,
    description: NEWS_DESCRIPTION,
    language: NEWS_LANGUAGE,
    window: config.windowLabel,
  };
}

export interface BuildWindowOptions {
  tagName: WindowTagName;
  storeDir?: string;
  now?: Date;
  /** Parent sealed snapshot to open and append delta items onto instead of creating from scratch. */
  baseCorpus?: string;
  /** Pre-selected items to ingest (required when baseCorpus is set; full window items otherwise). */
  items?: readonly FeedItem[];
  /** Destination tag override, or null for an untagged verification build. */
  tag?: string | null;
  /** Optional extra tags to point at the same sealed snapshot. */
  aliases?: string[];
  /** Detach superseded local snapshots that no longer carry any tag. Defaults to true. */
  detachSuperseded?: boolean;
  /** Permit sealing a 0-document snapshot. Defaults to false. */
  allowEmpty?: boolean;
  client?: Client;
  verifyClient?: Client;
}

export interface BuildWindowResult {
  tagName: WindowTagName;
  windowHours: number;
  windowLabel: WindowTagConfig["windowLabel"];
  storeDir: string;
  corpus: string;
  baseCorpus: string | null;
  ingestedDocuments: number;
  documents: number;
  tags: string[];
  previous: Record<string, string | null>;
  detached: string[];
  labels: Record<string, string>;
}

export interface BuildAllOptions {
  /** Specific rolling windows to rebuild. Defaults to all windows. */
  tags?: readonly WindowTagName[];
  storeDir?: string;
  now?: Date;
  /** Poll feeds into the store before rebuilding rolling windows. Defaults to true. */
  poll?: boolean;
  /** Leave built snapshots untagged instead of moving rolling window tags. */
  untagged?: boolean;
  /** Detach superseded local snapshots that no longer carry any tag. Defaults to true. */
  detachSuperseded?: boolean;
  /** Permit sealing 0-document snapshots. Defaults to false. */
  allowEmpty?: boolean;
  client?: Client;
  verifyClient?: Client;
}

export interface BuildAllResult {
  poll: PollSummary | null;
  windows: BuildWindowResult[];
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /^corpusd returned 404(?:\D|$)/.test(error.message);
}

async function lookupInfo(client: Client, ref: string): Promise<CorpusInfo | null> {
  try {
    return await corpus.info(client, ref);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function labelsMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

function uniqueTags(tags: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw?.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Partition items into disjoint delta slices ordered narrowest-to-widest so each wider
 * window only ingests items older than all narrower windows in the stack.
 */
export function partitionWindowItems(
  items: readonly FeedItem[],
  windowOrder: readonly WindowTagName[],
  now: Date,
): { orderedWindows: WindowTagName[]; slices: Record<WindowTagName, FeedItem[]> } {
  const orderedWindows = [...new Set(windowOrder)].sort(
    (a, b) => WINDOW_TAGS[a].windowHours - WINDOW_TAGS[b].windowHours,
  );
  const slices: Record<WindowTagName, FeedItem[]> = {
    today: [],
    thisweek: [],
    thismonth: [],
  };
  const cutoffs = orderedWindows.map((name) => ({
    name,
    cutoffMs: now.getTime() - WINDOW_TAGS[name].windowHours * 3_600_000,
  }));

  for (const item of items) {
    const tsMs = Date.parse(itemTimestamp(item));
    if (!Number.isFinite(tsMs)) continue;
    for (const entry of cutoffs) {
      if (tsMs >= entry.cutoffMs) {
        slices[entry.name].push(item);
        break;
      }
    }
  }

  return { orderedWindows, slices };
}

/**
 * Rebuild a rolling news window cleanly from the daily JSONL store (or stack delta items onto
 * a parent snapshot), seal and verify it through the local daemon, move the requested tag(s),
 * and detach superseded untagged snapshots.
 */
export async function buildWindowTag(options: BuildWindowOptions): Promise<BuildWindowResult> {
  const config = WINDOW_TAGS[options.tagName];
  const storeDir = resolveStoreDir(options.storeDir);
  const now = options.now ?? new Date();
  const labels = windowLabels(config);
  const client = options.client ?? new SocketClient();
  const verifyClient = options.verifyClient ?? new SocketClient();
  const targetTags =
    options.tag === null
      ? []
      : options.tag !== undefined
        ? uniqueTags([options.tag, ...(options.aliases ?? [])])
        : uniqueTags([config.tag, ...(options.aliases ?? config.aliases)]);
  const detachSuperseded = options.detachSuperseded ?? true;

  const previous: Record<string, string | null> = {};
  for (const tag of targetTags) {
    previous[tag] = (await lookupInfo(verifyClient, tag))?.id ?? null;
  }

  let expectedDocuments: number;
  let ingestedDocuments: number;
  let sealedCorpus: string;
  let sealedDocuments: number;
  let ownedEmptyId: string | null = null;

  if (options.baseCorpus !== undefined) {
    if (options.items === undefined) {
      throw new Error("items must be provided when building onto baseCorpus");
    }
    const baseInfo = await corpus.info(verifyClient, options.baseCorpus);
    if (baseInfo.open) {
      throw new Error(`Base corpus ${options.baseCorpus} is still open`);
    }
    const deltaItems = options.items;
    expectedDocuments = baseInfo.documents + deltaItems.length;
    if (expectedDocuments === 0 && !options.allowEmpty) {
      throw new Error(`No news items found in ${config.windowLabel} window at ${storeDir}`);
    }
    const documents = deltaItems.map(toDocument);
    ingestedDocuments = documents.length;

    const { writer } = await corpus.open(client, options.baseCorpus);
    try {
      if (documents.length > 0) {
        const { inserted } = await corpus.ingest(client, writer, documents);
        if (inserted !== documents.length) {
          throw new Error(`Expected ${documents.length} documents, ingested ${inserted}`);
        }
      }
    } catch (error) {
      try {
        await corpus.close(client, writer);
      } catch (closeError) {
        throw new AggregateError([error, closeError], `Could not ingest or close writer ${writer}`);
      }
      throw error;
    }
    const sealed = await corpus.close(client, writer, { labels });
    sealedCorpus = sealed.corpus;
    sealedDocuments = sealed.documents;
  } else {
    const items = options.items ?? (await readWindow(storeDir, config.windowHours, now));
    expectedDocuments = items.length;
    if (!items.length && !options.allowEmpty) {
      throw new Error(`No news items found in ${config.windowLabel} window at ${storeDir}`);
    }

    const documents = items.map(toDocument);
    ingestedDocuments = documents.length;
    const attachedBefore = new Set(await corpus.ls(client));
    const created = await corpus.create(client, { labels });
    const createdOwned = !attachedBefore.has(created.id);

    sealedCorpus = created.id;
    sealedDocuments = 0;

    if (documents.length > 0) {
      const { writer } = await corpus.open(client, created.id);
      try {
        const { inserted } = await corpus.ingest(client, writer, documents);
        if (inserted !== documents.length) {
          throw new Error(`Expected ${documents.length} documents, ingested ${inserted}`);
        }
      } catch (error) {
        try {
          await corpus.close(client, writer);
        } catch (closeError) {
          throw new AggregateError([error, closeError], `Could not ingest or close writer ${writer}`);
        }
        throw error;
      }
      const sealed = await corpus.close(client, writer);
      sealedCorpus = sealed.corpus;
      sealedDocuments = sealed.documents;
    }

    if (createdOwned && created.id !== sealedCorpus) {
      ownedEmptyId = created.id;
    }
  }

  const verified = await corpus.info(verifyClient, sealedCorpus);
  if (
    verified.open ||
    sealedDocuments !== expectedDocuments ||
    verified.documents !== expectedDocuments ||
    !labelsMatch(verified.labels, labels)
  ) {
    throw new Error(`Could not verify sealed ${config.name} snapshot ${sealedCorpus}`);
  }

  for (const tag of targetTags) {
    if (previous[tag] !== sealedCorpus) {
      await corpus.tag(client, sealedCorpus, tag);
    }
    const tagged = await lookupInfo(verifyClient, tag);
    if (!tagged || tagged.id !== sealedCorpus) {
      throw new Error(`Tag ${tag} failed to resolve to ${sealedCorpus}`);
    }
  }

  const detached: string[] = [];
  const candidates = new Set<string>();
  if (ownedEmptyId) {
    candidates.add(ownedEmptyId);
  }
  if (detachSuperseded) {
    for (const priorId of Object.values(previous)) {
      if (priorId && priorId !== sealedCorpus) {
        candidates.add(priorId);
      }
    }
  }

  for (const candidate of candidates) {
    const info = await lookupInfo(verifyClient, candidate);
    if (!info || info.open || info.tags.length > 0) continue;
    await corpus.remove(client, candidate);
    if (await lookupInfo(verifyClient, candidate)) {
      throw new Error(`Superseded snapshot ${candidate} is still attached`);
    }
    detached.push(candidate);
  }

  return {
    tagName: config.name,
    windowHours: config.windowHours,
    windowLabel: config.windowLabel,
    storeDir,
    corpus: sealedCorpus,
    baseCorpus: options.baseCorpus ?? null,
    ingestedDocuments,
    documents: verified.documents,
    tags: targetTags,
    previous,
    detached,
    labels,
  };
}

/**
 * Optionally poll feeds into the durable store, then rebuild selected (or all) rolling news
 * window tags in a single stacked pass from narrowest to widest for chunk reuse.
 */
export async function buildAllWindows(options: BuildAllOptions = {}): Promise<BuildAllResult> {
  const storeDir = resolveStoreDir(options.storeDir);
  const now = options.now ?? new Date();
  const shouldPoll = options.poll ?? true;
  const poll = shouldPoll ? await pollIntoStore(storeDir, undefined, now) : null;
  const requestedWindows = options.tags?.length ? options.tags : WINDOW_ORDER;
  const maxWindowHours = Math.max(...requestedWindows.map((name) => WINDOW_TAGS[name].windowHours));
  const allItems = await readWindow(storeDir, maxWindowHours, now);
  const { orderedWindows, slices } = partitionWindowItems(allItems, requestedWindows, now);

  const windows: BuildWindowResult[] = [];
  let baseCorpus: string | undefined;
  for (const tagName of orderedWindows) {
    const built = await buildWindowTag({
      tagName,
      storeDir,
      now,
      baseCorpus,
      items: slices[tagName],
      tag: options.untagged ? null : undefined,
      detachSuperseded: options.detachSuperseded,
      allowEmpty: options.allowEmpty,
      client: options.client,
      verifyClient: options.verifyClient,
    });
    windows.push(built);
    baseCorpus = built.corpus;
  }

  return { poll, windows };
}

function parseNowOption(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid --now timestamp: ${raw}`);
  }
  return parsed;
}

function isWindowTagName(value: string): value is WindowTagName {
  return Object.hasOwn(WINDOW_TAGS, value);
}

export function parseBuildArgs(
  argv: string[],
): Omit<BuildAllOptions, "client" | "verifyClient"> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      tag: { type: "string", multiple: true },
      store: { type: "string" },
      "no-poll": { type: "boolean", default: false },
      untagged: { type: "boolean", default: false },
      "no-detach": { type: "boolean", default: false },
      "allow-empty": { type: "boolean", default: false },
      now: { type: "string" },
    },
  });

  if (positionals.length > 0) {
    throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
  }

  const tags: WindowTagName[] = [];
  for (const raw of values.tag ?? []) {
    if (!isWindowTagName(raw)) {
      throw new Error(`Unknown tag "${raw}". Expected one of: ${WINDOW_ORDER.join(", ")}`);
    }
    if (!tags.includes(raw)) {
      tags.push(raw);
    }
  }

  const now = parseNowOption(values.now);

  return {
    ...(tags.length > 0 && { tags }),
    ...(values.store !== undefined && { storeDir: values.store }),
    ...(now !== undefined && { now }),
    poll: !values["no-poll"],
    untagged: values.untagged,
    detachSuperseded: !values["no-detach"],
    allowEmpty: values["allow-empty"],
  };
}

if (import.meta.main) {
  const result = await buildAllWindows(parseBuildArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
