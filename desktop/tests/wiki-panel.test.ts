import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/ui";
import { fixtureItems, unconfiguredConnection } from "../src/fixtures";
import { FixtureWikiSource } from "../src/wiki/fixture";
import { mountWikiPanel } from "../src/wiki/panel";
import type { WikiCache, WikiCacheStore, WikiSource } from "../src/wiki/source";
import { parseWikiCache, safeWikiUrl } from "../src/wiki/source";

function host(): HTMLElement {
  const element = document.createElement("section");
  document.body.replaceChildren(element);
  return element;
}
function memory(initial: WikiCache | null = null): WikiCacheStore {
  let saved = initial;
  return { load: async () => saved, save: async (value) => { saved = value; } };
}
const now = 1_789_689_600_000;

describe("Wiki detail surface", () => {
  it("stays inside the detail surface and does not send selected item fields", async () => {
    const root = host();
    const source = new FixtureWikiSource();
    const search = vi.spyOn(source, "search");
    createApp(root, fixtureItems, unconfiguredConnection, { source, cache: memory(), online: () => true, now: () => now });
    await vi.waitFor(() => expect(root.querySelectorAll(".wiki-result")).toHaveLength(2));
    expect(root.querySelector(".detail .wiki-context")).not.toBeNull();
    expect(search.mock.calls).toEqual([[""]]);
    const input = root.querySelector<HTMLInputElement>('.wiki-search input');
    if (!input) throw new Error("missing search input");
    input.value = "프로젝트";
    root.querySelector(".wiki-search")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(root.querySelectorAll(".wiki-result")).toHaveLength(1));
    expect(search.mock.calls).toEqual([[""], ["프로젝트"]]);
    expect(root.querySelector(".wiki-result")?.textContent).toContain("fixture");
    expect(root.querySelector(".wiki-result a")?.getAttribute("href")).toBe("https://example.invalid/wiki/project");
  });
  it("labels cached fixture origin and stale freshness per result offline", async () => {
    const articles = await new FixtureWikiSource().search("");
    const element = host();
    mountWikiPanel(element, { source: new FixtureWikiSource(), cache: memory({ schemaVersion: 1, provider: "fixture", origin: "fixture", fetchedAt: 0, articles }), online: () => false, now: () => now });
    await vi.waitFor(() => expect(element.querySelectorAll(".wiki-result")).toHaveLength(2));
    for (const result of element.querySelectorAll(".wiki-result")) {
      expect(result.textContent).toContain("cached");
      expect(result.textContent).toContain("원출처: fixture");
      expect(result.textContent).toContain("오래된 cache");
    }
  });
  it("renders an explicit provider error without result links", async () => {
    const element = host();
    const source: WikiSource = { provider: "fixture", mode: "fixture", search: async () => { throw new Error("failure"); }, getArticle: async () => null };
    mountWikiPanel(element, { source, cache: memory(), online: () => true, now: () => now });
    await vi.waitFor(() => expect(element.textContent).toContain("provider-error"));
    expect(element.querySelectorAll(".wiki-result a")).toHaveLength(0);
  });
  it("distinguishes a read-only connected adapter in the contract", async () => {
    const element = host();
    const source: WikiSource = { provider: "test-provider", mode: "connected-read-only", search: async () => [{ id: "public-1", title: "Public example", summary: "Test only", url: "https://example.invalid/public/1", provider: "test-provider" }], getArticle: async () => null };
    mountWikiPanel(element, { source, cache: memory(), online: () => true, now: () => now });
    await vi.waitFor(() => expect(element.querySelector(".wiki-result")?.textContent).toContain("connected-read-only"));
  });
  it("rejects executable, credential-bearing, and token-bearing links", () => {
    for (const url of ["javascript:alert(1)", "file:///private/example", "https://user:pass@example.invalid/page", "https://example.invalid/page?token=example"]) expect(safeWikiUrl(url)).toBe(false);
    expect(() => parseWikiCache({ schemaVersion: 1, provider: "fixture", origin: "fixture", fetchedAt: 1, articles: [{ id: "1", title: "x", summary: "x", url: "javascript:alert(1)", provider: "fixture" }] })).toThrow();
  });
});
