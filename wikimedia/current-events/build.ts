import { parseArgs } from "node:util";
import { SocketClient, type Client, type CorpusInfo } from "@corpusd/api";
import * as corpus from "@corpusd/api/corpus";
import { fetchCurrentEventsDays, toDocument, type CurrentEventItem } from "./wikipedia";

export const CORPUS_REPO = "wikimedia/current-events";
export const DISPLAY_NAME = "Wikimedia Current Events";
export const DESCRIPTION =
  "Search curated daily world event summaries and cited news sources from English Wikipedia's Portal:Current events.";
export const LANGUAGE = "en";

export type WindowTagName = "thisweek" | "thismonth" | "thisyear";

export const WINDOW_ORDER: readonly WindowTagName[] = ["thisweek", "thismonth", "thisyear"];

export interface WindowTagConfig {
  name: WindowTagName;
  windowDays: number;
  windowLabel: "7d" | "30d" | "365d";
  tag: string;
  aliases: readonly string[];
}

export const WINDOW_TAGS: Record<WindowTagName, WindowTagConfig> = {
  thisweek: {
    name: "thisweek",
    windowDays: 7,
    windowLabel: "7d",
    tag: `${CORPUS_REPO}:thisweek`,
    aliases: [],
  },
  thismonth: {
    name: "thismonth",
    windowDays: 30,
    windowLabel: "30d",
    tag: `${CORPUS_REPO}:thismonth`,
    aliases: [],
  },
  thisyear: {
    name: "thisyear",
    windowDays: 365,
    windowLabel: "365d",
    tag: `${CORPUS_REPO}:thisyear`,
    aliases: [`${CORPUS_REPO}:latest`],
  },
};

export const ALLOWED_LABEL_KEYS = ["description", "language", "name", "window"] as const;

export function windowLabels(config: Pick<WindowTagConfig, "windowLabel">): Record<string, string> {
  return {
    name: DISPLAY_NAME,
    description: DESCRIPTION,
    language: LANGUAGE,
    window: config.windowLabel,
  };
}

export interface BuildWindowOptions {
  tagName: WindowTagName;
  baseCorpus?: string;
  items: readonly CurrentEventItem[];
  tag?: string | null;
  aliases?: string[];
  detachSuperseded?: boolean;
  allowEmpty?: boolean;
  client?: Client;
  verifyClient?: Client;
}

export interface BuildWindowResult {
  tagName: WindowTagName;
  windowDays: number;
  windowLabel: WindowTagConfig["windowLabel"];
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
  tags?: readonly WindowTagName[];
  days?: number;
  now?: Date;
  untagged?: boolean;
  detachSuperseded?: boolean;
  allowEmpty?: boolean;
  dryRun?: boolean;
  client?: Client;
  verifyClient?: Client;
}

export interface BuildAllResult {
  daysFetched: number;
  totalItems: number;
  windows: BuildWindowResult[];
}

export interface DryRunResult {
  dryRun: true;
  daysFetched: number;
  totalItems: number;
  windows: {
    tagName: WindowTagName;
    windowLabel: WindowTagConfig["windowLabel"];
    deltaDocuments: number;
    cumulativeDocuments: number;
  }[];
  sampleDocuments: ReturnType<typeof toDocument>[];
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

function utcDayFloorMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Partition items into disjoint delta slices ordered narrowest-to-widest by event date.
 */
export function partitionWindowItems(
  items: readonly CurrentEventItem[],
  windowOrder: readonly WindowTagName[],
  now: Date,
): { orderedWindows: WindowTagName[]; slices: Record<WindowTagName, CurrentEventItem[]> } {
  const orderedWindows = [...new Set(windowOrder)].sort(
    (a, b) => WINDOW_TAGS[a].windowDays - WINDOW_TAGS[b].windowDays,
  );
  const slices: Record<WindowTagName, CurrentEventItem[]> = {
    thisweek: [],
    thismonth: [],
    thisyear: [],
  };
  const todayFloorMs = utcDayFloorMs(now);
  const cutoffs = orderedWindows.map((name) => ({
    name,
    cutoffMs: todayFloorMs - (WINDOW_TAGS[name].windowDays - 1) * 86_400_000,
  }));

  for (const item of items) {
    const tsMs = Date.parse(`${item.date}T00:00:00.000Z`);
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

export async function buildWindowTag(options: BuildWindowOptions): Promise<BuildWindowResult> {
  const config = WINDOW_TAGS[options.tagName];
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
    const baseInfo = await corpus.info(verifyClient, options.baseCorpus);
    if (baseInfo.open) {
      throw new Error(`Base corpus ${options.baseCorpus} is still open`);
    }
    const documents = options.items.map(toDocument);
    expectedDocuments = baseInfo.documents + documents.length;
    if (expectedDocuments === 0 && !options.allowEmpty) {
      throw new Error(`No current events found in ${config.windowLabel} window`);
    }
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
    expectedDocuments = options.items.length;
    if (!options.items.length && !options.allowEmpty) {
      throw new Error(`No current events found in ${config.windowLabel} window`);
    }

    const documents = options.items.map(toDocument);
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
    windowDays: config.windowDays,
    windowLabel: config.windowLabel,
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

export async function buildAllWindows(
  options: BuildAllOptions = {},
): Promise<BuildAllResult | DryRunResult> {
  const now = options.now ?? new Date();
  const requestedWindows = options.tags?.length ? options.tags : WINDOW_ORDER;
  const defaultDays = Math.max(...requestedWindows.map((name) => WINDOW_TAGS[name].windowDays));
  const daysFetched = options.days ?? defaultDays;

  const allItems = await fetchCurrentEventsDays(daysFetched, now);
  const { orderedWindows, slices } = partitionWindowItems(allItems, requestedWindows, now);

  if (options.dryRun) {
    let cumulative = 0;
    const windows = orderedWindows.map((tagName) => {
      const deltaDocuments = slices[tagName].length;
      cumulative += deltaDocuments;
      return {
        tagName,
        windowLabel: WINDOW_TAGS[tagName].windowLabel,
        deltaDocuments,
        cumulativeDocuments: cumulative,
      };
    });
    return {
      dryRun: true,
      daysFetched,
      totalItems: allItems.length,
      windows,
      sampleDocuments: allItems.slice(0, 3).map(toDocument),
    };
  }

  const windows: BuildWindowResult[] = [];
  let baseCorpus: string | undefined;
  for (const tagName of orderedWindows) {
    const built = await buildWindowTag({
      tagName,
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

  return {
    daysFetched,
    totalItems: allItems.length,
    windows,
  };
}

function parseNowOption(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid --now timestamp: ${raw}`);
  }
  return parsed;
}

function parseDaysOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --days count: ${raw}`);
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
      days: { type: "string" },
      untagged: { type: "boolean", default: false },
      "no-detach": { type: "boolean", default: false },
      "allow-empty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
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
  const days = parseDaysOption(values.days);

  return {
    ...(tags.length > 0 && { tags }),
    ...(days !== undefined && { days }),
    ...(now !== undefined && { now }),
    untagged: values.untagged,
    detachSuperseded: !values["no-detach"],
    allowEmpty: values["allow-empty"],
    dryRun: values["dry-run"],
  };
}

if (import.meta.main) {
  const result = await buildAllWindows(parseBuildArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
