import { describe, expect, test } from "bun:test";
import { ALLOWED_LABEL_KEYS, WINDOW_TAGS, partitionWindowItems, windowLabels } from "./build";
import {
  canonicalizeUrl,
  cleanWikitext,
  mergeEventItems,
  parseDayWikitext,
  toDocument,
  type CurrentEventItem,
} from "./wikipedia";

function makeItem(overrides: Partial<CurrentEventItem> = {}): CurrentEventItem {
  return {
    url: "https://www.reuters.com/world/story-1",
    title: "Headline summary.",
    summary: "Headline summary.",
    date: "2026-11-26",
    updatedAt: "2026-11-26T22:00:00.000Z",
    category: "Armed conflicts and attacks",
    topics: ["Middle Eastern crisis"],
    sources: ["Reuters"],
    wikipediaPath: "/wiki/Portal:Current_events/2026_November_26",
    revisionId: 1388241307,
    ...overrides,
  };
}

describe("wikimedia/current-events parser", () => {
  test("cleanWikitext unwraps wikilinks, templates, and entities", () => {
    expect(
      cleanWikitext(
        "<!-- comment -->Two [[Italy|Italian]] forces in [[Saada Governorate]]s move {{cvt|17|km|mi}} {{small|(approx.)}} &amp; hold.",
      ),
    ).toBe("Two Italian forces in Saada Governorates move 17 km (approx.) & hold.");
  });

  test("parseDayWikitext resolves categories, topic stacks, multiple citations, and skips unsourced bullets", () => {
    const wikitext = `{{Current events|year=2026|month=11|day=26|top=yes}}
<!-- All news items below this line -->
'''Armed conflicts and attacks'''
*[[Middle Eastern crisis (2023–present)|Middle Eastern crisis]]
**[[2026 Iran war]]
***[[2026 Iranian strikes on Kuwait]]
****Two [[Italy|Italian]] technicians working for [[Rheinmetall]] are killed in [[Kuwait]]. [https://www.bbc.com/news/articles/c39w9y5dx4k5o/ (BBC News)]
**Unsourced background note without any link.
*[[Aftermath of the July Uprising]]
**A clash in [[Bangladesh]] leaves one dead. [https://www.thedailystar.net/news/1?utm_source=wiki (''The Daily Star'')] [https://www.reuters.com/world/asia/1 (Reuters)]

'''Business and economy'''
*[[Eurozone]]
**Pablo Hernández de Cos is elected [[ECB]] president. [https://www.ft.com/content/abc (Financial Times)]
**Same story duplicate reference. [https://www.ft.com/content/abc?ref=portal (FT)]`;

    const items = parseDayWikitext(
      "2026-11-26",
      "/wiki/Portal:Current_events/2026_November_26",
      1388241307,
      "2026-11-26T22:00:00.000Z",
      wikitext,
    );

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      url: "https://www.bbc.com/news/articles/c39w9y5dx4k5o",
      title: "2026 Iranian strikes on Kuwait",
      category: "Armed conflicts and attacks",
      topics: ["Middle Eastern crisis", "2026 Iran war", "2026 Iranian strikes on Kuwait"],
      sources: ["BBC News"],
      summary: "Two Italian technicians working for Rheinmetall are killed in Kuwait.",
    });
    expect(items[1]).toMatchObject({
      url: "https://www.thedailystar.net/news/1",
      title: "Aftermath of the July Uprising",
      category: "Armed conflicts and attacks",
      topics: ["Aftermath of the July Uprising"],
      sources: ["The Daily Star", "Reuters"],
      summary: "A clash in Bangladesh leaves one dead.",
    });
    expect(items[2]).toMatchObject({
      url: "https://www.ft.com/content/abc",
      title: "Eurozone",
      category: "Business and economy",
      topics: ["Eurozone"],
      sources: ["Financial Times", "FT"],
    });
    expect(items[2]!.summary).toContain("Pablo Hernández de Cos is elected ECB president.");
    expect(items[2]!.summary).toContain("Same story duplicate reference.");
  });

  test("canonicalizeUrl strips tracking parameters, fragments, and trailing slashes", () => {
    expect(canonicalizeUrl("https://www.reuters.com/world/a/?utm_source=x#top")).toBe(
      "https://www.reuters.com/world/a",
    );
  });

  test("mergeEventItems keeps earliest date and unions topics and sources", () => {
    const merged = mergeEventItems(
      makeItem({
        date: "2026-11-25",
        updatedAt: "2026-11-25T10:00:00.000Z",
        topics: ["Topic A"],
        sources: ["Reuters"],
      }),
      makeItem({
        date: "2026-11-26",
        updatedAt: "2026-11-26T12:00:00.000Z",
        summary: "Follow-up detail.",
        topics: ["topic a", "Topic B"],
        sources: ["BBC News"],
      }),
    );

    expect(merged.date).toBe("2026-11-25");
    expect(merged.updatedAt).toBe("2026-11-26T12:00:00.000Z");
    expect(merged.topics).toEqual(["Topic A", "Topic B"]);
    expect(merged.sources).toEqual(["Reuters", "BBC News"]);
    expect(merged.summary).toBe("Headline summary. Follow-up detail.");
  });
});

describe("wikimedia/current-events document and windowing", () => {
  test("toDocument keeps allowlisted meta and truncates long descriptions to 500 chars", () => {
    const longSummary = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const doc = toDocument(makeItem({ summary: longSummary }));

    expect(Object.keys(doc.meta).sort()).toEqual([
      "category",
      "date",
      "description",
      "sources",
      "title",
      "topics",
      "updated_at",
      "wikipedia_path",
    ]);
    expect(String(doc.meta.description).length).toBeLessThanOrEqual(500);
    expect(String(doc.meta.description).endsWith("…")).toBe(true);
    expect(doc.body?.media_type).toBe("text/plain");
    expect(doc.body?.data).toBeTruthy();
    expect(doc.body?.data).toContain(longSummary);
    expect(doc.body?.data).not.toContain("Wikipedia Current Events");
    const titleMatchesDescription = toDocument(makeItem({ summary: longSummary, title: String(doc.meta.description) }));
    expect(titleMatchesDescription.meta.description).toBeUndefined();
    expect(titleMatchesDescription.body?.data).toBe(longSummary);

    const shortTopLevel = toDocument(
      makeItem({
        title: "Short top-level bullet.",
        summary: "Short top-level bullet.",
        topics: [],
      }),
    );
    expect(shortTopLevel.meta.description).toBeUndefined();

    const shortWithTopic = toDocument(
      makeItem({
        title: "2026 Iranian strikes on Kuwait",
        summary: "Two technicians are killed in Kuwait.",
        topics: ["2026 Iranian strikes on Kuwait"],
      }),
    );
    expect(shortWithTopic.meta.title).toBe("2026 Iranian strikes on Kuwait");
    expect(shortWithTopic.meta.description).toBe("Two technicians are killed in Kuwait.");
    expect(shortWithTopic.body).toBeUndefined();
  });

  test("windowLabels and partitionWindowItems build disjoint narrowest-first slices", () => {
    for (const config of Object.values(WINDOW_TAGS)) {
      const labels = windowLabels(config);
      expect(Object.keys(labels).sort()).toEqual([...ALLOWED_LABEL_KEYS]);
      expect(labels.window).toBe(config.windowLabel);
    }

    const now = new Date("2026-11-27T12:00:00.000Z");
    const items = [
      makeItem({ url: "https://example.com/week", date: "2026-11-25" }),
      makeItem({ url: "https://example.com/month", date: "2026-11-10" }),
      makeItem({ url: "https://example.com/year", date: "2026-06-01" }),
      makeItem({ url: "https://example.com/too-old", date: "2025-11-20" }),
    ];

    const res = partitionWindowItems(items, ["thisyear", "thisweek", "thismonth"], now);
    expect(res.orderedWindows).toEqual(["thisweek", "thismonth", "thisyear"]);
    expect(res.slices.thisweek.map((i) => i.url)).toEqual(["https://example.com/week"]);
    expect(res.slices.thismonth.map((i) => i.url)).toEqual(["https://example.com/month"]);
    expect(res.slices.thisyear.map((i) => i.url)).toEqual(["https://example.com/year"]);
  });
});
