import "../calendar/styles/fonts.css";
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
/** 「#day=2026-10-27」(홈 위젯에서 그 줄을 누름): 그날 일 보기로 연다. */
const dayOf = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
mountBlackhole(root, bridge ? androidAdapter(bridge) : memoryAdapter(), { seed: !bridge }).then((app) => {
  const open = (day: string) => {
    if (dayOf(day)) app.setView("day", day);
  };
  (window as unknown as { blackholeOpenDay?: (day: string) => void }).blackholeOpenDay = open;
  open(new URLSearchParams(location.hash.slice(1)).get("day") ?? "");
}).catch((error: unknown) => {
  root.textContent = `블랙홀 달력을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
});
