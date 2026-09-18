export type WikiMode = "fixture" | "connected-read-only";
export type WikiState = WikiMode | "cached" | "error";
export interface WikiArticle {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly provider: string;
}
export interface WikiSource {
  readonly provider: string;
  readonly mode: WikiMode;
  search(query: string): Promise<readonly WikiArticle[]>;
  getArticle(id: string): Promise<WikiArticle | null>;
}
export interface WikiCache {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly origin: WikiMode;
  readonly fetchedAt: number;
  readonly articles: readonly WikiArticle[];
}
export interface WikiCacheStore {
  load(): Promise<WikiCache | null>;
  save(cache: WikiCache): Promise<void>;
}
export interface WikiResult {
  readonly state: WikiState;
  readonly provider: string;
  readonly origin: WikiMode;
  readonly freshness: "fresh" | "stale" | "none";
  readonly fetchedAt: number | null;
  readonly articles: readonly WikiArticle[];
  readonly issue: "offline" | "provider-error" | "cache-error" | null;
}

export function safeWikiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export function parseWikiCache(value: unknown): WikiCache | null {
  if (value === null) return null;
  if (typeof value !== "object" || !value || !("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("provider" in value) || typeof value.provider !== "string" ||
      !("origin" in value) || (value.origin !== "fixture" && value.origin !== "connected-read-only") ||
      !("fetchedAt" in value) || typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) ||
      !("articles" in value) || !Array.isArray(value.articles)) throw new Error("Invalid Wiki cache");
  const articles: WikiArticle[] = value.articles.map((article: unknown) => {
    if (typeof article !== "object" || !article ||
        !("id" in article) || typeof article.id !== "string" ||
        !("title" in article) || typeof article.title !== "string" ||
        !("summary" in article) || typeof article.summary !== "string" ||
        !("url" in article) || typeof article.url !== "string" || !safeWikiUrl(article.url) ||
        !("provider" in article) || typeof article.provider !== "string" || article.provider !== value.provider) throw new Error("Invalid Wiki article");
    return { id: article.id, title: article.title, summary: article.summary, url: article.url, provider: article.provider };
  });
  return { schemaVersion: 1, provider: value.provider, origin: value.origin, fetchedAt: value.fetchedAt, articles };
}
