import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import { ALLOWED_LABEL_KEYS, windowLabels } from "./build";
import {
  buildSliceUrls,
  canonicalizeUrl,
  cleanTheme,
  mergeGdeltItems,
  parseGdeltTimestamp,
  parseGkgTsv,
  toDocument,
  unzipSingleFile,
  type GdeltArticleItem,
} from "./gdelt";

function buildTestZip(filename: string, content: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(filename);
  const rawBytes = new TextEncoder().encode(content);
  const compressed = deflateRawSync(rawBytes);

  const lfhLen = 30 + nameBytes.length;
  const cdLen = 46 + nameBytes.length;
  const totalLen = lfhLen + compressed.length + cdLen + 22;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  // Local file header
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, 8, true);
  view.setUint32(18, compressed.length, true);
  view.setUint32(22, rawBytes.length, true);
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(compressed, lfhLen);

  // Central directory header
  const cdOffset = lfhLen + compressed.length;
  view.setUint32(cdOffset, 0x02014b50, true);
  view.setUint16(cdOffset + 4, 20, true);
  view.setUint16(cdOffset + 6, 20, true);
  view.setUint16(cdOffset + 10, 8, true);
  view.setUint32(cdOffset + 20, compressed.length, true);
  view.setUint32(cdOffset + 24, rawBytes.length, true);
  view.setUint16(cdOffset + 28, nameBytes.length, true);
  view.setUint32(cdOffset + 42, 0, true);
  out.set(nameBytes, cdOffset + 46);

  // End of central directory
  const eocdOffset = cdOffset + cdLen;
  view.setUint32(eocdOffset, 0x06054b50, true);
  view.setUint16(eocdOffset + 8, 1, true);
  view.setUint16(eocdOffset + 10, 1, true);
  view.setUint32(eocdOffset + 12, cdLen, true);
  view.setUint32(eocdOffset + 16, cdOffset, true);

  return out;
}

function makeGkgRow(overrides: Partial<Record<number, string>> = {}): string {
  const cols = Array.from({ length: 27 }, () => "");
  cols[0] = "20261127141500-1";
  cols[1] = "20261127141500";
  cols[2] = "1";
  cols[3] = "timesofmalta.com";
  cols[4] = "https://timesofmalta.com/article/story-1/?utm_source=gdelt";
  cols[8] = "WB_635_PUBLIC_HEALTH,100;TAX_FNCACT_MINISTER,200;CRISISLEX_C07_SAFETY,300";
  cols[10] = "4#Marsascala, Malta#MT#MT32#19483#35.86#14.56#-18853#266;1#Malta#MT#MT##35.9#14.4#MT#224";
  cols[12] = "Clara Farrugia,100;Mario Rossi,250;Clara Farrugia,400";
  cols[14] = "Office Of The Attorney General,150;Ministry of Health,320";
  cols[21] = "100|30||Quote text that must never be stored";
  cols[26] =
    "<PAGE_AUTHORS>Clara Farrugia;John Borg</PAGE_AUTHORS><PAGE_PRECISEPUBTIMESTAMP>20261127131700</PAGE_PRECISEPUBTIMESTAMP><PAGE_TITLE>Two accused &amp; charged in Malta</PAGE_TITLE>";
  for (const [idx, val] of Object.entries(overrides)) {
    cols[Number(idx)] = val!;
  }
  return cols.join("\t");
}

function makeItem(overrides: Partial<GdeltArticleItem> = {}): GdeltArticleItem {
  return {
    url: "https://timesofmalta.com/article/story-1",
    title: "Two accused & charged in Malta",
    date: "2026-11-27T13:17:00.000Z",
    hasPreciseDate: true,
    source: "timesofmalta.com",
    authors: ["Clara Farrugia"],
    persons: ["Clara Farrugia", "Mario Rossi"],
    organizations: ["Office Of The Attorney General"],
    locations: ["Marsascala, Malta", "Malta"],
    themes: ["public health", "minister", "safety"],
    ...overrides,
  };
}

describe("gdelt/news helpers", () => {
  test("unzipSingleFile extracts deflated single-entry ZIP archives", () => {
    const zip = buildTestZip("sample.gkg.csv", "col1\tcol2\nval1\tval2\n");
    const extracted = new TextDecoder().decode(unzipSingleFile(zip));
    expect(extracted).toBe("col1\tcol2\nval1\tval2\n");
  });

  test("parseGdeltTimestamp, cleanTheme, canonicalizeUrl, and buildSliceUrls", () => {
    expect(parseGdeltTimestamp("20261127141500")).toBe("2026-11-27T14:15:00.000Z");
    expect(parseGdeltTimestamp("bad")).toBeNull();
    expect(cleanTheme("WB_1458_HEALTH_PROMOTION")).toBe("health promotion");
    expect(cleanTheme("CRISISLEX_C07_SAFETY")).toBe("safety");
    expect(cleanTheme("TAX_FNCACT_PRESIDENT")).toBe("president");
    expect(canonicalizeUrl("https://www.bbc.co.uk/news/world-1/?utm_source=x#top")).toBe(
      "https://www.bbc.com/news/world-1",
    );
    expect(buildSliceUrls("20261127001500", 3)).toEqual([
      "http://data.gdeltproject.org/gdeltv2/20261127001500.gkg.csv.zip",
      "http://data.gdeltproject.org/gdeltv2/20261127000000.gkg.csv.zip",
      "http://data.gdeltproject.org/gdeltv2/20261126234500.gkg.csv.zip",
    ]);
  });

  test("parseGkgTsv parses web rows, filters invalid rows, ignores quotations, and merges duplicates", () => {
    const tsv = [
      makeGkgRow(),
      makeGkgRow({
        4: "https://timesofmalta.com/article/story-1",
        12: "New Witness,50",
        26: "<PAGE_TITLE>Duplicate title</PAGE_TITLE>",
      }),
      makeGkgRow({ 2: "2", 4: "https://example.com/non-web" }),
      makeGkgRow({ 4: "https://example.com/no-title", 26: "<PAGE_PRECISEPUBTIMESTAMP>20261127120000</PAGE_PRECISEPUBTIMESTAMP>" }),
    ].join("\n");

    const items = parseGkgTsv(tsv);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      url: "https://timesofmalta.com/article/story-1",
      title: "Two accused & charged in Malta",
      date: "2026-11-27T13:17:00.000Z",
      hasPreciseDate: true,
      source: "timesofmalta.com",
      authors: ["Clara Farrugia", "John Borg"],
      persons: ["Clara Farrugia", "Mario Rossi", "New Witness"],
      organizations: ["Office Of The Attorney General", "Ministry of Health"],
      locations: ["Marsascala, Malta", "Malta"],
      themes: ["public health", "minister", "safety"],
    });
  });

  test("mergeGdeltItems prefers precise timestamps over GKG slice timestamps", () => {
    const merged = mergeGdeltItems(
      makeItem({ date: "2026-11-27T14:15:00.000Z", hasPreciseDate: false }),
      makeItem({ date: "2026-11-27T13:17:00.000Z", hasPreciseDate: true }),
    );
    expect(merged.date).toBe("2026-11-27T13:17:00.000Z");
    expect(merged.hasPreciseDate).toBe(true);
  });

  test("toDocument keeps lean meta allowlist and indexes entities without quotations", () => {
    const doc = toDocument(makeItem());
    expect(Object.keys(doc.meta).sort()).toEqual(["authors", "date", "source", "title"]);
    expect(doc.body?.media_type).toBe("text/plain");
    expect(doc.body?.data).toContain("Clara Farrugia, Mario Rossi");
    expect(doc.body?.data).toContain("Office Of The Attorney General");
    expect(doc.body?.data).toContain("Marsascala, Malta, Malta");
    expect(doc.body?.data).toContain("public health, minister, safety");
    expect(doc.body?.data).not.toContain("Quote text");
    expect(doc.body?.data).not.toContain("timesofmalta.com");
    expect(toDocument(makeItem({ persons: [], organizations: [], locations: [], themes: [] })).body).toBeUndefined();
  });

  test("windowLabels keeps allowlisted labels", () => {
    const labels = windowLabels();
    expect(Object.keys(labels).sort()).toEqual([...ALLOWED_LABEL_KEYS]);
    expect(labels.window).toBe("24h");
  });
});
