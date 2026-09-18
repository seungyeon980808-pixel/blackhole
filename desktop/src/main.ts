import "./styles.css";
import { createApp } from "./ui";
import { getConnectionStatus, loadInitialCache } from "./bridge";
import { captureInboxMessage, getInboxStatus } from "./bridge";
import { fixtureCache, unconfiguredConnection } from "./fixtures";
import { defaultWikiPanel } from "./wiki/panel";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("앱 루트가 없습니다.");

Promise.all([loadInitialCache(), getConnectionStatus(), getInboxStatus()])
  .then(([cache, connection, inbox]) => createApp(
    root,
    cache.items,
    connection,
    defaultWikiPanel(),
    { status: inbox, capture: captureInboxMessage }
  ))
  .catch((error: unknown) => {
    console.error("Ya Desktop bootstrap failed", error);
    createApp(root, fixtureCache.items, {
      ...unconfiguredConnection,
      detail: "로컬 캐시를 불러오지 못해 안전한 인공 미리보기를 표시합니다."
    });
  });
