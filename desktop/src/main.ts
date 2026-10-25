import "./styles.css";
import { createApp } from "./ui";
import { getConnectionStatus, loadInitialCache } from "./bridge";
import { fixtureCache, unconfiguredConnection } from "./fixtures";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("앱 루트가 없습니다.");

Promise.all([loadInitialCache(), getConnectionStatus()])
  .then(([cache, connection]) => createApp(root, cache.items, connection))
  .catch((error: unknown) => {
    console.error("Blackhole Desktop bootstrap failed", error);
    createApp(root, fixtureCache.items, {
      ...unconfiguredConnection,
      detail: "로컬 캐시를 불러오지 못해 안전한 인공 미리보기를 표시합니다."
    });
  });
