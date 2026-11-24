import { expect, spyOn, test } from "bun:test";
import { loadCatalog } from "./registry";

test("catalog results include region and language from the selected manifest", async () => {
  const responses = new Map([
    ["/", { corpus: [{ id: "example/current" }, { id: "example/older" }] }],
    ["/example/current/tags", { tags: ["latest"] }],
    ["/example/older/tags", { tags: ["first"] }],
    ["/example/current", { description: "Public description" }],
    ["/example/older", { description: "Older description" }],
    ["/example/current/tags/latest", {
      roots: {},
      labels: { name: "Current", region: "CA", language: "fr" },
    }],
    ["/example/older/tags/first", { roots: {}, labels: { name: "Older" } }],
  ]);
  const respond = async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const { pathname } = new URL(String(input));
    if (pathname === "/example/current/readme") return new Response("# Current");
    if (pathname === "/example/older/readme") return new Response(null, { status: 404 });
    if (!responses.has(pathname)) throw new Error(`Unexpected fixture request for ${pathname}`);
    return Response.json(responses.get(pathname));
  };
  const fakeFetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(respond, { preconnect: globalThis.fetch.preconnect }),
  );

  try {
    const [current, older] = await loadCatalog();
    expect(current).toMatchObject({
      meta: {
        title: "Current",
        description: "Public description",
        corpus: "example/current",
        region: "CA",
        language: "fr",
      },
      body: { media_type: "text/markdown", data: "# Current" },
    });
    expect(older?.meta).toEqual({
      title: "Older",
      description: "Older description",
      corpus: "example/older",
    });
  } finally {
    fakeFetch.mockRestore();
  }
});
