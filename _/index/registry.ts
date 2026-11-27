import type { IngestDocument } from "@corpusd/api";

const origin = "https://library.runcorpus.com";
const indexId = "_/index";
const segment = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const resourceName = new RegExp(`^(?:_|${segment})/${segment}$`);

function validResource(value: string): boolean {
  return value.length <= 512 && resourceName.test(value);
}
const tagName = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function loadCatalog(): Promise<IngestDocument[]> {
  async function read(path: string, { allowMissing = false } = {}) {
    const response = await fetch(new URL(path, origin), {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok && !(allowMissing && response.status === 404)) {
      throw new Error(`Library returned HTTP ${response.status} for ${path}`);
    }
    return response;
  }

  async function list(
    path: string,
    field: "corpus" | "tags",
    key: (value: unknown) => unknown,
    valid: (value: string) => boolean,
  ) {
    const entries: string[] = [];
    let last = "";
    for (;;) {
      const query = new URLSearchParams({ n: "100" });
      if (last) query.set("last", last);
      const response = await read(`${path}?${query}`);
      const page = record(await response.json())?.[field];
      if (!Array.isArray(page)) throw new Error(`Invalid Library list at ${path}`);
      for (const item of page) {
        const value = key(item);
        if (typeof value !== "string" || !valid(value) || value <= last) {
          throw new Error(`Invalid or unordered Library list at ${path}`);
        }
        entries.push(value);
        last = value;
      }
      if (!response.headers.get("link")?.includes('rel="next"')) return entries;
      if (!page.length) throw new Error(`Library list at ${path} did not advance`);
    }
  }

  const ids = await list("/", "corpus", (item) => record(item)?.id, validResource);
  const documents: IngestDocument[] = [];
  for (const id of ids) {
    if (id === indexId) continue;
    const tags = await list(`/${id}/tags`, "tags", (tag) => tag, (tag) => tagName.test(tag));
    const tag = tags.includes("latest") ? "latest" : tags.length === 1 ? tags[0] : undefined;
    if (!tag) throw new Error(`No unambiguous default snapshot for ${id}`);

    const [metadata, snapshot, readme] = await Promise.all([
      read(`/${id}`).then(async (response) => record(await response.json())),
      read(`/${id}/tags/${tag}`).then((response) => response.arrayBuffer()),
      read(`/${id}/readme`, { allowMissing: true }).then((response) =>
        response.ok ? response.text() : "",
      ),
    ]);
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
    const manifest = record(JSON.parse(manifestText));
    if (!metadata || !record(manifest?.roots)) {
      throw new Error(`Invalid Library metadata or manifest for ${id}`);
    }
    const labels = record(manifest?.labels);
    const description = text(metadata.description) || text(labels?.description);
    const region = text(labels?.region);
    const language = text(labels?.language);
    documents.push({
      url: `${origin}/${id}`,
      meta: {
        title: text(labels?.name) || id,
        description,
        corpus: id,
        ...(region && { region }),
        ...(language && { language }),
      },
      ...(readme.trim() && { body: { media_type: "text/markdown", data: readme } }),
    });
  }
  if (!documents.length) throw new Error("The Library catalog contains no routing targets");
  return documents;
}
