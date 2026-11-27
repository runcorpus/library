import { inflateRawSync } from "node:zlib";
import type { IngestDocument } from "@corpusd/api";

export const USER_AGENT = "Corpus/0.1 (+https://runcorpus.com/library/gdelt/news)";
const LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";
const GDELT_V2_BASE = "http://data.gdeltproject.org/gdeltv2";

export const MAX_PERSONS = 25;
export const MAX_ORGANIZATIONS = 25;
export const MAX_LOCATIONS = 20;
export const MAX_THEMES = 20;

export interface GdeltArticleItem {
  url: string;
  title: string;
  date: string;
  hasPreciseDate: boolean;
  source: string;
  authors: string[];
  persons: string[];
  organizations: string[];
  locations: string[];
  themes: string[];
}

export interface FetchGdeltSlicesOptions {
  slices: number;
  latestTimestamp?: string;
  concurrency?: number;
}

export interface FetchGdeltSlicesResult {
  latestTimestamp: string;
  slicesRequested: number;
  slicesFetched: number;
  slicesMissing: number;
  slicesFailed: number;
  items: GdeltArticleItem[];
}

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

const THEME_PREFIX_PATTERN =
  /^(?:WB_\d+_|TAX_[A-Z0-9]+_|CRISISLEX_[A-Z0-9]+_|UNGP_|USPEC_|EPU_[A-Z0-9]+_|SOC_|ENV_|ECON_|MED_|LEADER_|GENERAL_|MANMADE_DISASTER_|NATURAL_DISASTER_)/;

/**
 * Extract the single entry from a standard ZIP archive using EOCD and Central Directory headers.
 */
export function unzipSingleFile(zipBytes: Uint8Array): Uint8Array {
  if (zipBytes.length < 22) {
    throw new Error("Invalid ZIP archive: payload too small");
  }
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const minOffset = Math.max(0, zipBytes.length - 65_557);
  let eocdOffset = -1;
  for (let i = zipBytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP archive: EOCD signature not found");
  }

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + 46 > zipBytes.length || view.getUint32(cdOffset, true) !== 0x02014b50) {
    throw new Error("Invalid ZIP archive: Central Directory header not found");
  }

  const compressionMethod = view.getUint16(cdOffset + 10, true);
  const compressedSize = view.getUint32(cdOffset + 20, true);
  const localHeaderOffset = view.getUint32(cdOffset + 42, true);

  if (
    localHeaderOffset + 30 > zipBytes.length ||
    view.getUint32(localHeaderOffset, true) !== 0x04034b50
  ) {
    throw new Error("Invalid ZIP archive: Local File Header not found");
  }

  const fileNameLen = view.getUint16(localHeaderOffset + 26, true);
  const extraLen = view.getUint16(localHeaderOffset + 28, true);
  const dataStart = localHeaderOffset + 30 + fileNameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > zipBytes.length) {
    throw new Error("Invalid ZIP archive: entry exceeds buffer length");
  }

  const payload = zipBytes.subarray(dataStart, dataEnd);
  if (compressionMethod === 0) {
    return payload;
  }
  if (compressionMethod === 8) {
    return inflateRawSync(payload);
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

export function parseGdeltTimestamp(raw: string): string | null {
  const match = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

export function formatGdeltTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
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

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => {
      const cp = Number(code);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function readExtraTag(extras: string, tagName: string): string {
  const match = extras.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXmlEntities(match[1]!) : "";
}

function uniqueLimited(values: Iterable<string>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function parseOffsetEntities(field: string, limit: number): string[] {
  if (!field) return [];
  const values: string[] = [];
  for (const entry of field.split(";")) {
    if (!entry) continue;
    const comma = entry.lastIndexOf(",");
    const name = comma >= 0 ? entry.slice(0, comma) : entry;
    if (name.trim()) values.push(name);
  }
  return uniqueLimited(values, limit);
}

function parseLocations(field: string, limit = MAX_LOCATIONS): string[] {
  if (!field) return [];
  const values: string[] = [];
  for (const entry of field.split(";")) {
    if (!entry) continue;
    const parts = entry.split("#");
    const fullName = parts[1]?.trim();
    if (fullName) values.push(fullName);
  }
  return uniqueLimited(values, limit);
}

export function cleanTheme(rawTheme: string): string {
  const trimmed = rawTheme.trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(THEME_PREFIX_PATTERN, "");
  return stripped.replace(/_/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseThemes(field: string, limit = MAX_THEMES): string[] {
  if (!field) return [];
  const values: string[] = [];
  for (const entry of field.split(";")) {
    if (!entry) continue;
    const comma = entry.indexOf(",");
    const rawCode = comma >= 0 ? entry.slice(0, comma) : entry;
    const cleaned = cleanTheme(rawCode);
    if (cleaned) values.push(cleaned);
  }
  return uniqueLimited(values, limit);
}

export function mergeGdeltItems(prior: GdeltArticleItem, incoming: GdeltArticleItem): GdeltArticleItem {
  let primary: GdeltArticleItem;
  let secondary: GdeltArticleItem;
  if (prior.hasPreciseDate !== incoming.hasPreciseDate) {
    primary = prior.hasPreciseDate ? prior : incoming;
    secondary = prior.hasPreciseDate ? incoming : prior;
  } else {
    primary = prior.date <= incoming.date ? prior : incoming;
    secondary = primary === prior ? incoming : prior;
  }

  return {
    url: primary.url,
    title: primary.title || secondary.title,
    date: primary.date,
    hasPreciseDate: primary.hasPreciseDate || secondary.hasPreciseDate,
    source: primary.source || secondary.source,
    authors: uniqueLimited([...primary.authors, ...secondary.authors], 20),
    persons: uniqueLimited([...primary.persons, ...secondary.persons], MAX_PERSONS),
    organizations: uniqueLimited([...primary.organizations, ...secondary.organizations], MAX_ORGANIZATIONS),
    locations: uniqueLimited([...primary.locations, ...secondary.locations], MAX_LOCATIONS),
    themes: uniqueLimited([...primary.themes, ...secondary.themes], MAX_THEMES),
  };
}

/**
 * Parse one GDELT 2.0 GKG 2.1 TSV payload into deduplicated web-article items.
 * Intentionally ignores Quotations (col 21) so publisher article excerpts are not stored.
 */
export function parseGkgTsv(tsv: string): GdeltArticleItem[] {
  const byUrl = new Map<string, GdeltArticleItem>();

  for (const line of tsv.split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 27 || cols[2] !== "1") continue;

    const url = canonicalizeUrl(cols[4]!);
    if (!url) continue;

    const extras = cols[26]!;
    const title = readExtraTag(extras, "PAGE_TITLE");
    if (!title) continue;

    const gkgDate = parseGdeltTimestamp(cols[1]!);
    if (!gkgDate) continue;

    const rawPrecise = readExtraTag(extras, "PAGE_PRECISEPUBTIMESTAMP");
    const preciseDate = rawPrecise ? parseGdeltTimestamp(rawPrecise) : null;
    const usePrecise =
      preciseDate !== null && Date.parse(preciseDate) <= Date.parse(gkgDate) + 86_400_000;

    const rawAuthors = readExtraTag(extras, "PAGE_AUTHORS");
    const authors = rawAuthors ? uniqueLimited(rawAuthors.split(";"), 20) : [];

    const source = cols[3]!.trim().toLowerCase() || new URL(url).hostname.toLowerCase();

    const item: GdeltArticleItem = {
      url,
      title,
      date: usePrecise ? preciseDate : gkgDate,
      hasPreciseDate: usePrecise,
      source,
      authors,
      persons: parseOffsetEntities(cols[12] ?? "", MAX_PERSONS),
      organizations: parseOffsetEntities(cols[14] ?? "", MAX_ORGANIZATIONS),
      locations: parseLocations(cols[10] ?? "", MAX_LOCATIONS),
      themes: parseThemes(cols[8] ?? "", MAX_THEMES),
    };

    const existing = byUrl.get(url);
    byUrl.set(url, existing ? mergeGdeltItems(existing, item) : item);
  }

  return [...byUrl.values()];
}

export function buildSliceUrls(latestTimestamp: string, sliceCount: number): string[] {
  const iso = parseGdeltTimestamp(latestTimestamp);
  if (!iso) {
    throw new Error(`Invalid GDELT timestamp: ${latestTimestamp}`);
  }
  const baseMs = Date.parse(iso);
  const count = Math.max(1, Math.floor(sliceCount));
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const ts = formatGdeltTimestamp(new Date(baseMs - i * 15 * 60_000));
    urls.push(`${GDELT_V2_BASE}/${ts}.gkg.csv.zip`);
  }
  return urls;
}

export async function fetchLatestGkgTimestamp(): Promise<string> {
  const response = await fetch(LASTUPDATE_URL, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GDELT lastupdate HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  const match = text.match(/(\d{14})\.gkg\.csv\.zip/);
  if (!match) {
    throw new Error("Could not find GKG slice URL in GDELT lastupdate.txt");
  }
  return match[1]!;
}

export async function fetchGdeltSlices(options: FetchGdeltSlicesOptions): Promise<FetchGdeltSlicesResult> {
  const latestTimestamp = options.latestTimestamp ?? (await fetchLatestGkgTimestamp());
  const urls = buildSliceUrls(latestTimestamp, options.slices);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const deduped = new Map<string, GdeltArticleItem>();

  let slicesFetched = 0;
  let slicesMissing = 0;
  let slicesFailed = 0;
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (nextIndex < urls.length) {
        const url = urls[nextIndex++]!;
        try {
          const response = await fetch(url, {
            headers: { "user-agent": USER_AGENT },
            signal: AbortSignal.timeout(30_000),
          });
          if (response.status === 404) {
            await response.body?.cancel();
            slicesMissing++;
            continue;
          }
          if (!response.ok) {
            await response.body?.cancel();
            slicesFailed++;
            continue;
          }
          const zipBytes = new Uint8Array(await response.arrayBuffer());
          const tsv = new TextDecoder().decode(unzipSingleFile(zipBytes));
          slicesFetched++;
          for (const item of parseGkgTsv(tsv)) {
            const prior = deduped.get(item.url);
            deduped.set(item.url, prior ? mergeGdeltItems(prior, item) : item);
          }
        } catch {
          slicesFailed++;
        }
      }
    }),
  );

  if (slicesFetched === 0) {
    throw new Error(
      `Failed to fetch any GDELT GKG slices (requested=${urls.length}, missing=${slicesMissing}, failed=${slicesFailed})`,
    );
  }

  return {
    latestTimestamp,
    slicesRequested: urls.length,
    slicesFetched,
    slicesMissing,
    slicesFailed,
    items: [...deduped.values()].sort((a, b) => a.url.localeCompare(b.url)),
  };
}

export function toDocument(item: GdeltArticleItem): IngestDocument {
  const meta: IngestDocument["meta"] = {
    title: item.title,
    date: item.date,
    source: item.source,
    ...(item.authors.length && { authors: item.authors }),
  };

  const sections: string[] = [];
  if (item.persons.length) sections.push(item.persons.join(", "));
  if (item.organizations.length) sections.push(item.organizations.join(", "));
  if (item.locations.length) sections.push(item.locations.join(", "));
  if (item.themes.length) sections.push(item.themes.join(", "));

  return {
    url: item.url,
    meta,
    ...(sections.length && { body: { media_type: "text/plain", data: sections.join("\n") } }),
  };
}
