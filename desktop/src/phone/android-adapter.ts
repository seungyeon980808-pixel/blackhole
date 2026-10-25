/**
 * Phone adapter: the Android app hosts this page in a WebView and exposes `BlackholeAndroid`.
 * Inputs go to the Drive 「블랙홀/인박스/」 (the Mac analyzes them); the calendar itself is the
 * Mac's shared copy 「블랙홀/달력.json」, with the phone's own changes sent back as action files.
 */
import { AnalyzeError, type BlackholeAdapter, type InboxStatus } from "../calendar/adapter";
import { isShared, type CalendarState, type SharedCalendar, type UserAction } from "../calendar/model";

/** Methods the Android app adds with addJavascriptInterface (all synchronous strings). */
export interface AndroidBridge {
  loadState(): string;
  saveState(json: string): void;
  sendText(text: string): string;
  sendFile(name: string, mime: string, base64: string): string;
  scheduleAlarms(json: string): void;
  sharedCopy(): string;
  refreshShared(): void;
  recordAction(json: string): void;
  pendingActions(): string;
  syncStatus(): string;
}

declare global {
  interface Window {
    BlackholeAndroid?: AndroidBridge;
    /** Called by the Android app when a newer shared copy was downloaded. */
    blackholeShared?: () => void;
  }
}

const parse = <T>(text: string, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

const off: InboxStatus = { available: false, enabled: false, root: "", lastScanAt: null, lastError: null, running: false };

export function androidAdapter(bridge: AndroidBridge): BlackholeAdapter {
  let lastShared = "";
  const sent = (reply: string) => {
    const r = parse<{ ok: boolean; message: string }>(reply, { ok: false, message: "보내지 못했습니다." });
    if (!r.ok) throw new AnalyzeError("IO", r.message);
    throw new AnalyzeError("QUEUED", "보냈어요. Mac이 정리하면 이 달력에 들어옵니다.");
  };
  return {
    origin: "휴대폰",
    get connection() {
      return { label: "Mac 사본", detail: `Mac 블랙홀이 드라이브에 둔 달력 사본을 보여 줍니다. ${bridge.syncStatus()}` };
    },
    load: async () => parse<unknown>(bridge.loadState(), null),
    save: async (state: CalendarState) => bridge.saveState(JSON.stringify(state)),
    async analyze(input) {
      if (input.text !== undefined) sent(bridge.sendText(input.text));
      if (input.file) {
        const mime = /\.wav$/i.test(input.file.name) ? "audio/wav" : /\.(png|jpe?g|webp|heic)$/i.test(input.file.name) ? "image/*" : "";
        sent(bridge.sendFile(input.file.name, mime, base64(input.file.bytes)));
      }
      throw new AnalyzeError("UNSUPPORTED_INPUT", "보낼 내용이 없습니다.");
    },
    inboxStatus: async () => off,
    setInbox: async () => off,
    inboxResults: async () => [],
    async scheduleAlarms(alarms) {
      bridge.scheduleAlarms(JSON.stringify(alarms.map((a) => ({ key: a.key, atMs: a.atMs, title: a.title }))));
    },
    // Alarms ring natively (phone-call style); the page never shows its own overlay.
    onAlarm: () => undefined,
    ring: async () => true,
    print: async () => undefined,
    recordAction: (action: UserAction) => bridge.recordAction(JSON.stringify(action)),
    onShared(handler) {
      const take = () => {
        const text = bridge.sharedCopy();
        if (!text || text === lastShared) return;
        const shared = parse<SharedCalendar | null>(text, null);
        if (!isShared(shared)) return;
        lastShared = text;
        const applied = new Set(shared.appliedActions);
        handler(shared, parse<UserAction[]>(bridge.pendingActions(), []).filter((a) => !applied.has(a.id)));
      };
      window.blackholeShared = take;
      window.setTimeout(take, 0);
      bridge.refreshShared();
      window.setInterval(() => bridge.refreshShared(), 60_000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") bridge.refreshShared();
      });
    }
  };
}
