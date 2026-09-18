import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LocalWikiCache } from "../src/wiki/cache";
import { FixtureWikiSource } from "../src/wiki/fixture";
import { searchWiki } from "../src/wiki/service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.mocked(invoke).mockReset(); });
function native(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
}

describe("native Wiki cache boundary", () => {
  it("preserves usable fixture results when native save rejects a Rust string", async () => {
    native();
    vi.mocked(invoke).mockRejectedValue("Wiki cache 저장 오류");
    const result = await searchWiki(new FixtureWikiSource(), new LocalWikiCache(), "", { online: true, now: 1000 });
    expect(result.state).toBe("fixture");
    expect(result.issue).toBe("cache-error");
    expect(result.articles).toHaveLength(2);
    expect(vi.mocked(invoke).mock.calls[0]?.[0]).toBe("store_wiki_cache");
  });
  it("classifies native load string failure as cache-error offline", async () => {
    native();
    vi.mocked(invoke).mockRejectedValue("Wiki cache 읽기 오류");
    const result = await searchWiki(new FixtureWikiSource(), new LocalWikiCache(), "", { online: false, now: 1000 });
    expect(result.state).toBe("error");
    expect(result.issue).toBe("cache-error");
    expect(vi.mocked(invoke).mock.calls).toEqual([["load_wiki_cache", undefined]]);
  });
  it("keeps browser preview in memory without native invocation", async () => {
    const cache = new LocalWikiCache();
    await searchWiki(new FixtureWikiSource(), cache, "", { online: true, now: 1000 });
    const result = await searchWiki(new FixtureWikiSource(), cache, "", { online: false, now: 1000 });
    expect(result.state).toBe("cached");
    expect(result.origin).toBe("fixture");
    expect(invoke).not.toHaveBeenCalled();
  });
});
