import "../calendar/styles/base.css";
import "../calendar/styles/glass.css";
import "../calendar/styles/doc.css";
import { mountBlackhole } from "../calendar/app";
import { memoryAdapter } from "../calendar/memory-adapter";
import { androidAdapter } from "./android-adapter";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("앱 루트가 없습니다.");
document.documentElement.classList.add("phone");

// No fake data on the phone: it shows the Mac's copy (or nothing yet).
const bridge = window.BlackholeAndroid;
mountBlackhole(root, bridge ? androidAdapter(bridge) : memoryAdapter(), { seed: !bridge }).catch((error: unknown) => {
  root.textContent = `블랙홀 달력을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
});
