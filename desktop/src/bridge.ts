import { invoke } from "@tauri-apps/api/core";
import type { CacheEnvelope, CacheLoadResult, ConnectionStatus } from "./domain";
import { fixtureCache, unconfiguredConnection } from "./fixtures";
import type { InboxCaptureResult, InboxStatus } from "./inbox";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  return isTauri()
    ? invoke<ConnectionStatus>("get_connection_status")
    : structuredClone(unconfiguredConnection);
}

export async function loadInitialCache(): Promise<CacheEnvelope> {
  if (!isTauri()) return structuredClone(fixtureCache);
  const loaded = await invoke<CacheLoadResult>("load_local_cache");
  if (loaded.cache.items.length > 0) return loaded.cache;
  return invoke<CacheEnvelope>("bootstrap_fixture");
}

export async function storeLocalCache(cache: CacheEnvelope): Promise<void> {
  if (!isTauri()) throw new Error("브라우저 미리보기에서는 로컬 캐시를 저장하지 않습니다.");
  await invoke("store_local_cache", { cache });
}

export async function getInboxStatus(): Promise<InboxStatus> {
  if (!isTauri()) {
    return {
      state: "unavailable",
      path: null,
      detail: "브라우저 미리보기에서는 Google Drive Inbox를 쓰지 않습니다."
    };
  }
  return invoke<InboxStatus>("get_inbox_status");
}

export async function captureInboxMessage(message: string): Promise<InboxCaptureResult> {
  if (!isTauri()) throw new Error("브라우저 미리보기에서는 Inbox에 저장하지 않습니다.");
  return invoke<InboxCaptureResult>("capture_inbox_message", { message });
}
