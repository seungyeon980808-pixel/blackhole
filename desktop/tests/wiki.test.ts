import { describe, expect, it } from "vitest";
import { FixtureWikiSource } from "../src/wiki/fixture";
import { searchWiki } from "../src/wiki/service";
import type { WikiCache, WikiCacheStore, WikiSource } from "../src/wiki/source";

const now = Date.parse("2026-09-18T00:00:00Z");
function store(initial: WikiCache | null = null): WikiCacheStore {
  let value = initial;
  return { load: async () => value, save: async (cache) => { value = cache; } };
}
const failure: WikiSource = {
  provider: "fixture", mode: "fixture",
  search: async () => { throw new Error("provider unavailable"); },
  getArticle: async () => null
};

describe("read-only Wiki", () => {
  it("returns fixture articles and retrieves the same article without a provider write", async () => {
    const source = new FixtureWikiSource();
    const result = await searchWiki(source, store(), "", { online: true, now });
    expect(result.state).toBe("fixture");
    expect(result.articles.length).toBeGreaterThan(0);
    const article = result.articles[0];
    if (!article) throw new Error("missing article");
    expect(await source.getArticle(article.id)).toEqual(article);
  });
  it("uses saved articles offline and keeps fixture provenance", async () => {
    const cache = store();
    await searchWiki(new FixtureWikiSource(), cache, "", { online: true, now });
    const result = await searchWiki(failure, cache, "", { online: false, now });
    expect(result.state).toBe("cached");
    expect(result.origin).toBe("fixture");
    expect(result.freshness).toBe("fresh");
  });
  it("distinguishes an offline cache miss from empty search results", async () => {
    expect((await searchWiki(failure, store(), "", { online: false, now })).state).toBe("error");
    const result = await searchWiki(new FixtureWikiSource(), store(), "존재하지않는주제", { online: true, now });
    expect(result.state).toBe("fixture");
    expect(result.articles).toEqual([]);
  });
  it("marks old snapshots stale instead of live", async () => {
    const cache = store();
    await searchWiki(new FixtureWikiSource(), cache, "", { online: true, now });
    const result = await searchWiki(failure, cache, "", { online: false, now: now + 86_400_001 });
    expect(result.freshness).toBe("stale");
    expect(result.state).toBe("cached");
  });
  it("reports provider errors without manufacturing a connection", async () => {
    const result = await searchWiki(failure, store(), "", { online: true, now });
    expect(result.state).toBe("error");
    expect(result.issue).toBe("provider-error");
  });
  it("reports provider failure even when cached articles are available", async () => {
    const cache = store();
    await searchWiki(new FixtureWikiSource(), cache, "", { online: true, now });
    const result = await searchWiki(failure, cache, "", { online: true, now });
    expect(result.state).toBe("cached");
    expect(result.issue).toBe("provider-error");
  });
  it("reports cache failure without silently substituting fixture", async () => {
    const cache: WikiCacheStore = { load: async () => { throw new Error("corrupt"); }, save: async () => {} };
    const result = await searchWiki(failure, cache, "", { online: false, now });
    expect(result.state).toBe("error");
    expect(result.issue).toBe("cache-error");
  });
});
