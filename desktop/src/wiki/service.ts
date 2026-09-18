import type { WikiCacheStore, WikiResult, WikiSource } from "./source";
import { parseWikiCache } from "./source";

const MAX_AGE_MS = 86_400_000;
export async function searchWiki(
  source: WikiSource, cache: WikiCacheStore, query: string,
  options: { readonly online: boolean; readonly now: number }
): Promise<WikiResult> {
  let issue: WikiResult["issue"] = "offline";
  if (options.online) {
    try {
      const snapshot = parseWikiCache({ schemaVersion: 1, provider: source.provider, origin: source.mode,
        fetchedAt: options.now, articles: await source.search(query) });
      if (!snapshot) throw new Error("Missing Wiki snapshot");
      let cacheIssue: WikiResult["issue"] = null;
      try { await cache.save(snapshot); }
      catch (error: unknown) { if (!(error instanceof Error)) throw error; cacheIssue = "cache-error"; }
      return { state: source.mode, provider: source.provider, origin: source.mode,
        freshness: "fresh", fetchedAt: options.now, articles: snapshot.articles, issue: cacheIssue };
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      issue = "provider-error";
    }
  }
  try {
    const saved = parseWikiCache(await cache.load());
    if (saved && saved.provider === source.provider && saved.origin === source.mode) {
      const age = options.now - saved.fetchedAt;
      const term = query.trim().toLocaleLowerCase("ko-KR");
      return { state: "cached", provider: saved.provider, origin: saved.origin,
        freshness: age < 0 || age > MAX_AGE_MS ? "stale" : "fresh", fetchedAt: saved.fetchedAt,
        articles: saved.articles.filter((article) => `${article.title} ${article.summary}`.toLocaleLowerCase("ko-KR").includes(term)), issue };
    }
  } catch (error: unknown) { if (!(error instanceof Error)) throw error; issue = "cache-error"; }
  return { state: "error", provider: source.provider, origin: source.mode, freshness: "none", fetchedAt: null, articles: [], issue };
}
