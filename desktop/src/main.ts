import "./calendar/styles/fonts.css";
import "./calendar/styles/base.css";
import "./calendar/styles/glass.css";
import "./calendar/styles/doc.css";
import { mountBlackhole } from "./calendar/app";
import { memoryAdapter } from "./calendar/memory-adapter";
import { isTauri, tauriAdapter } from "./adapters/tauri";
import "./mac/windows.css";
import { mountAlarm } from "./mac/alarm";
import { mountQuick } from "./mac/quick";
import { mountBoard } from "./mac/board";

// macOS window glass: the window is transparent and the desktop shows through, blurred.
if (isTauri() && /Mac/.test(navigator.userAgent)) document.documentElement.classList.add("native-glass");

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("앱 루트가 없습니다.");

// The Mac's extra windows load the same page; Rust marks which one this is.
const kind = (window as unknown as { __BH_WINDOW?: string }).__BH_WINDOW;
if (kind === "quick") mountQuick(root);
else if (kind === "alarm") mountAlarm(root);
else if (kind === "board") mountBoard(root);
else mountBlackhole(root, isTauri() ? tauriAdapter() : memoryAdapter({ persist: true })).catch((error: unknown) => {
  console.error("블랙홀 시작 실패", error);
  root.textContent = `블랙홀을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
});
