import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IngestDocument } from "@corpusd/api";
import TurndownService from "@joplin/turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { load } from "cheerio";

interface Source {
  name: string;
  url: string;
}

interface CachedPage {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  html: string;
}

const cacheDirectory = fileURLToPath(new URL("./.cache/", import.meta.url));
const maxBytes = 4 * 1024 * 1024;
const maxDescriptionChars = 200;
const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
converter.use(gfm);

function truncateDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxDescriptionChars) return trimmed;
  let cut = trimmed.slice(0, maxDescriptionChars - 1);
  const boundary = cut.lastIndexOf(" ");
  if (boundary >= Math.floor(maxDescriptionChars / 2)) cut = cut.slice(0, boundary);
  return `${cut.replace(/[\s,.;:!?-]+$/, "")}…`;
}

async function loadSources(): Promise<Source[]> {
  const raw = await Bun.file(new URL("./sources.yaml", import.meta.url)).text();
  const sources: unknown = Bun.YAML.parse(raw);
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error("Expected a non-empty list of homepages in sources.yaml.");
  }
  const seen = new Set<string>();
  for (const entry of sources) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join() !== "name,url") {
      throw new Error("Each homepage must contain only a name and URL.");
    }
    const { name, url: rawUrl } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || typeof rawUrl !== "string") {
      throw new Error("Each homepage must contain only a name and URL.");
    }
    const url = new URL(rawUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash
      || url.href !== rawUrl || seen.has(rawUrl)) {
      throw new Error(`Invalid or duplicate homepage: ${rawUrl}`);
    }
    seen.add(rawUrl);
  }
  return sources as Source[];
}

function toDocument(source: Source, html: string, finalUrl = source.url): IngestDocument {
  if (Buffer.byteLength(html) > maxBytes || !/<(?:!doctype\s+html|html|head|body|title|p|div)(?:\s|>)/i.test(html)) {
    throw new Error(`Invalid or oversized HTML: ${source.url}`);
  }
  const $ = load(html);
  const title = $("head title").first().text().replace(/\s+/g, " ").trim()
    || $("title").first().text().replace(/\s+/g, " ").trim()
    || source.name;
  if (/^(?:just a moment|access denied|attention required|request rejected|human verification|pardon our interruption|making sure you(?:['’]re| are) not a bot)/i.test(title)) {
    throw new Error(`Challenge or error page: ${source.url}`);
  }
  const rawDescription = $('meta[name="description" i]').attr("content")
    || $('meta[property="og:description" i]').attr("content")
    || $('meta[name="twitter:description" i]').attr("content")
    || "";
  const description = truncateDescription(rawDescription.replace(/\s+/g, " "));
  $("script,style,noscript,template,svg").remove();
  $('img[src^="data:" i]').removeAttr("src");
  $('a[href^="javascript:" i]').removeAttr("href");
  const text = $("body").text().replace(/\s+/g, " ").trim();
  if (text.length < 4000
    && /verify (?:that )?you(?:['’]re| are) not a robot|verify you are human|javascript is disabled.*(?:robot|verification)|enable javascript.*(?:robot|verification)/i.test(text)) {
    throw new Error(`Empty or challenged homepage: ${source.url}`);
  }
  if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 80) {
    throw new Error(`Empty or challenged homepage: ${source.url}`);
  }
  $("[href], [src]").each((_, element) => {
    for (const attribute of ["href", "src"]) {
      const value = $(element).attr(attribute);
      if (!value) continue;
      try { $(element).attr(attribute, new URL(value, finalUrl).href); } catch { /* Preserve unparseable source attributes. */ }
    }
  });
  const markdown = converter.turndown($("body").html() ?? "").trim();
  if (!markdown) throw new Error(`Empty Markdown: ${source.url}`);
  return {
    url: source.url,
    meta: { title, ...(description && { description }) },
    body: { media_type: "text/markdown", data: markdown },
  };
}

async function loadDocument(source: Source, refresh = false): Promise<IngestDocument> {
  const key = createHash("sha256").update(source.url).digest("hex");
  const path = join(cacheDirectory, `${key}.json`);
  if (!refresh) {
    let cached: string | undefined;
    try { cached = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cached !== undefined) {
      let page: Partial<CachedPage>;
      try { page = JSON.parse(cached) as Partial<CachedPage>; }
      catch { throw new Error(`Invalid cache entry: ${path}. Run with --refresh to fetch it again.`); }
      if (page.url !== source.url || typeof page.html !== "string" || typeof page.finalUrl !== "string"
        || typeof page.fetchedAt !== "string" || !Number.isFinite(Date.parse(page.fetchedAt))) {
        throw new Error(`Invalid cache entry: ${path}. Run with --refresh to fetch it again.`);
      }
      return toDocument(source, page.html, page.finalUrl);
    }
  }
  const response = await fetch(source.url, {
    headers: { "User-Agent": "CorpusHelloWorld/0.1 (+https://runcorpus.com/library/_/helloworld)", Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}: ${source.url}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!["text/html", "application/xhtml+xml"].includes(contentType ?? "") || !response.body) {
    await response.body?.cancel();
    throw new Error(`Expected HTML: ${source.url}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`HTML exceeds 4 MiB: ${source.url}`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const html = Buffer.concat(chunks).toString("utf8");
  const document = toDocument(source, html, response.url);
  const page: CachedPage = { url: source.url, finalUrl: response.url, fetchedAt: new Date().toISOString(), html };
  await mkdir(cacheDirectory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(page));
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return document;
}

export async function loadDocuments(refresh = false): Promise<IngestDocument[]> {
  const sources = await loadSources();
  const documents = new Array<IngestDocument>(sources.length);
  const failures: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, sources.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= sources.length) return;
        const source = sources[index]!;
        console.error(`Preparing ${source.name}: ${source.url}`);
        try {
          documents[index] = await loadDocument(source, refresh);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${source.name} (${source.url}): ${message}`);
        }
      }
    }),
  );
  if (failures.length) {
    throw new Error(`Failed to prepare ${failures.length}/${sources.length} homepages:\n- ${failures.join("\n- ")}`);
  }
  return documents;
}
