import { parseArgs } from "node:util";
import { SocketClient, type Client, type CorpusInfo } from "@corpusd/api";
import * as corpus from "@corpusd/api/corpus";
import { fetchGdeltSlices, toDocument, type GdeltArticleItem } from "./gdelt";

export const CORPUS_REPO = "gdelt/news";
export const DISPLAY_NAME = "GDELT News";
export const DESCRIPTION =
  "Search recent global web news articles from GDELT 2.0 GKG by headline, people, organizations, locations, themes, and publisher.";
export const LANGUAGE = "en";

export const DEFAULT_HOURS = 24;
export const SLICES_PER_HOUR = 4;
export const TODAY_TAG = `${CORPUS_REPO}:today`;
export const LATEST_ALIAS = `${CORPUS_REPO}:latest`;
export const ALLOWED_LABEL_KEYS = ["description", "language", "name", "window"] as const;
const INGEST_BATCH_SIZE = 1000;

export function windowLabels(windowLabel = "24h"): Record<string, string> {
  return {
    name: DISPLAY_NAME,
    description: DESCRIPTION,
    language: LANGUAGE,
    window: windowLabel,
  };
}

export interface BuildOptions {
  hours?: number;
  slices?: number;
  concurrency?: number;
  untagged?: boolean;
  detachSuperseded?: boolean;
  allowEmpty?: boolean;
  dryRun?: boolean;
  client?: Client;
  verifyClient?: Client;
}

export interface BuildResult {
  latestTimestamp: string;
  slicesRequested: number;
  slicesFetched: number;
  slicesMissing: number;
  slicesFailed: number;
  corpus: string;
  documents: number;
  tags: string[];
  previous: Record<string, string | null>;
  detached: string[];
  labels: Record<string, string>;
}

export interface DryRunResult {
  dryRun: true;
  latestTimestamp: string;
  slicesRequested: number;
  slicesFetched: number;
  slicesMissing: number;
  slicesFailed: number;
  documents: number;
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

async function ingestInBatches(
  client: Client,
  writer: string,
  items: readonly GdeltArticleItem[],
): Promise<number> {
  let totalInserted = 0;
  for (let i = 0; i < items.length; i += INGEST_BATCH_SIZE) {
    const chunk = items.slice(i, i + INGEST_BATCH_SIZE).map(toDocument);
    const { inserted } = await corpus.ingest(client, writer, chunk);
    if (inserted !== chunk.length) {
      throw new Error(`Expected ${chunk.length} documents in batch, ingested ${inserted}`);
    }
    totalInserted += inserted;
  }
  return totalInserted;
}

export async function buildGdeltToday(options: BuildOptions = {}): Promise<BuildResult | DryRunResult> {
  const hours = options.hours ?? DEFAULT_HOURS;
  const slices = options.slices ?? hours * SLICES_PER_HOUR;
  const fetched = await fetchGdeltSlices({
    slices,
    concurrency: options.concurrency,
  });

  if (options.dryRun) {
    return {
      dryRun: true,
      latestTimestamp: fetched.latestTimestamp,
      slicesRequested: fetched.slicesRequested,
      slicesFetched: fetched.slicesFetched,
      slicesMissing: fetched.slicesMissing,
      slicesFailed: fetched.slicesFailed,
      documents: fetched.items.length,
      sampleDocuments: fetched.items.slice(0, 3).map(toDocument),
    };
  }

  if (fetched.items.length === 0 && !options.allowEmpty) {
    throw new Error("No GDELT articles parsed in requested window");
  }

  const windowLabel = `${hours}h`;
  const labels = windowLabels(windowLabel);
  const client = options.client ?? new SocketClient();
  const verifyClient = options.verifyClient ?? new SocketClient();
  const targetTags = options.untagged ? [] : [TODAY_TAG, LATEST_ALIAS];
  const detachSuperseded = options.detachSuperseded ?? true;

  const previous: Record<string, string | null> = {};
  for (const tag of targetTags) {
    previous[tag] = (await lookupInfo(verifyClient, tag))?.id ?? null;
  }

  const attachedBefore = new Set(await corpus.ls(client));
  const created = await corpus.create(client, { labels });
  const createdOwned = !attachedBefore.has(created.id);

  let sealedCorpus = created.id;
  let sealedDocuments = 0;
  let ownedEmptyId: string | null = null;

  if (fetched.items.length > 0) {
    const { writer } = await corpus.open(client, created.id);
    try {
      await ingestInBatches(client, writer, fetched.items);
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

  const verified = await corpus.info(verifyClient, sealedCorpus);
  if (
    verified.open ||
    sealedDocuments !== fetched.items.length ||
    verified.documents !== fetched.items.length ||
    !labelsMatch(verified.labels, labels)
  ) {
    throw new Error(`Could not verify sealed GDELT snapshot ${sealedCorpus}`);
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
    latestTimestamp: fetched.latestTimestamp,
    slicesRequested: fetched.slicesRequested,
    slicesFetched: fetched.slicesFetched,
    slicesMissing: fetched.slicesMissing,
    slicesFailed: fetched.slicesFailed,
    corpus: sealedCorpus,
    documents: verified.documents,
    tags: targetTags,
    previous,
    detached,
    labels,
  };
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return value;
}

export function parseBuildArgs(argv: string[]): Omit<BuildOptions, "client" | "verifyClient"> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      hours: { type: "string" },
      slices: { type: "string" },
      concurrency: { type: "string" },
      untagged: { type: "boolean", default: false },
      "no-detach": { type: "boolean", default: false },
      "allow-empty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (positionals.length > 0) {
    throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
  }

  const hours = parsePositiveInt(values.hours, "--hours");
  const slices = parsePositiveInt(values.slices, "--slices");
  const concurrency = parsePositiveInt(values.concurrency, "--concurrency");

  return {
    ...(hours !== undefined && { hours }),
    ...(slices !== undefined && { slices }),
    ...(concurrency !== undefined && { concurrency }),
    untagged: values.untagged,
    detachSuperseded: !values["no-detach"],
    allowEmpty: values["allow-empty"],
    dryRun: values["dry-run"],
  };
}

if (import.meta.main) {
  const result = await buildGdeltToday(parseBuildArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}
