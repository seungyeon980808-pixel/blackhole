/**
 * Browser preview adapter: keeps state in this browser only, has no worker and no
 * inbox. Used by `npm run dev` outside Tauri and by tests.
 */
import { AnalyzeError, type BlackholeAdapter, type InboxStatus } from "./adapter";
import type { CalendarState } from "./model";
import type { Alarm } from "./store";

const KEY = "blackhole-calendar-v1";

export function memoryAdapter(opts: { persist?: boolean } = {}): BlackholeAdapter {
  let mem: CalendarState | null = null;
  let timers: number[] = [];
  let handler: ((a: Alarm) => void) | null = null;
  const off: InboxStatus = { available: false, enabled: false, root: "", lastScanAt: null, lastError: null, running: false };
  return {
    origin: "브라우저",
    connection: { label: "미리보기·미연결", detail: "브라우저 미리보기입니다. 작업기·인박스가 없고, 이 브라우저에만 저장하며 구글에는 쓰지 않습니다." },
    async load() {
      if (!opts.persist) return mem;
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    async save(state) {
      mem = structuredClone(state);
      if (!opts.persist) return;
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        /* private window: keep in memory */
      }
    },
    async analyze() {
      throw new AnalyzeError("RUNNER_UNAVAILABLE", "브라우저 미리보기에는 작업기가 없습니다. 데스크톱 앱에서 넣어 주세요.");
    },
    inboxStatus: async () => off,
    setInbox: async () => off,
    inboxResults: async () => [],
    async scheduleAlarms(alarms) {
      timers.forEach((t) => window.clearTimeout(t));
      const now = Date.now();
      timers = alarms
        .filter((a) => a.atMs - now < 2 ** 31 - 1)
        .map((a) => window.setTimeout(() => handler?.(a), Math.max(0, a.atMs - now)));
    },
    onAlarm(h) {
      handler = h;
    },
    ring: async () => false,
    print: async () => window.print()
  };
}
