import { invoke } from "@tauri-apps/api/core";
import type { WikiCache, WikiCacheStore } from "./source";
import { parseWikiCache } from "./source";

export class WikiCacheError extends Error {
  constructor() { super("Wiki local cache operation failed"); this.name = "WikiCacheError"; }
}

async function cacheInvoke(command: string, args?: { readonly cache: WikiCache }): Promise<unknown> {
  try { return await invoke<unknown>(command, args); }
  catch (error: unknown) {
    if (error instanceof Error || typeof error === "string") throw new WikiCacheError();
    throw error;
  }
}

export class LocalWikiCache implements WikiCacheStore {
  // Browser preview holds synthetic results in memory only; no personal browser storage.
  private preview: WikiCache | null = null;
  private native(): boolean { return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window; }
  async load(): Promise<WikiCache | null> {
    return this.native() ? parseWikiCache(await cacheInvoke("load_wiki_cache")) : this.preview;
  }
  async save(cache: WikiCache): Promise<void> {
    if (this.native()) await cacheInvoke("store_wiki_cache", { cache });
    else this.preview = cache;
  }
}
