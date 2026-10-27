/**
 * Phone adapter: the Android app hosts this page in a WebView and exposes `BlackholeAndroid`.
 * Inputs go to the Drive 「블랙홀/인박스/」 (the Mac analyzes them); the calendar itself is the
 * Mac's shared copy 「블랙홀/달력.json」, with the phone's own changes sent back as action files.
 */
import { AnalyzeError, type BlackholeAdapter, type GoogleCalendars, type InboxStatus } from "../calendar/adapter";
import { cleanEvents, cleanNotes, cleanPeriods, cleanTasks, isShared, type CalendarState, type Entry, type SharedCalendar, type UserAction } from "../calendar/model";

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
  googleCalendars?(): string;
  boardOptions?(): string;
  setBoardOptions?(lock: boolean, hideSchool: boolean): void;
  setBoardLook?(bright: number, opacity: number): void;
  setLockTasks?(show: boolean, hideTitles: boolean): void;
  pinWidget?(): boolean;
  openRecording?(): void;
  setGoogleCalendars?(enabled: boolean, provisional: string, main: string): void;
  /** Drafts made on the phone (this page or the native send screens), JSON list of entries. */
  localDrafts?(): string;
  keepDrafts?(json: string): void;
}

declare global {
  interface Window {
    BlackholeAndroid?: AndroidBridge;
    /** Called by the Android app when a newer shared copy was downloaded. */
    blackholeShared?: () => void;
    /** Called by the Android app after mirroring to the calendars. */
    blackholeCalendars?: () => void;
    /** Called by the Android app when it made a draft natively (send screen, lock screen, voice). */
    blackholeDrafts?: () => void;
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
    const r = parse<{ ok: boolean; message: string; job?: string }>(reply, { ok: false, message: "보내지 못했습니다." });
    if (!r.ok) throw new AnalyzeError("IO", r.message);
    throw new AnalyzeError("QUEUED", "보냈어요. Mac이 정리하면 이 달력에 들어옵니다.", r.job || undefined);
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
    board: bridge.boardOptions ? async () => parse(bridge.boardOptions!(), { lock: false, hideSchool: false, status: "" }) : undefined,
    setBoard: bridge.setBoardOptions ? async (lock, hideSchool) => bridge.setBoardOptions!(lock, hideSchool) : undefined,
    setBoardLook: bridge.setBoardLook ? async (bright, opacity) => bridge.setBoardLook!(bright, opacity) : undefined,
    setLockTasks: bridge.setLockTasks ? async (show, hideTitles) => bridge.setLockTasks!(show, hideTitles) : undefined,
    pinWidget: bridge.pinWidget ? async () => bridge.pinWidget!() : undefined,
    openRecording: bridge.openRecording ? async () => bridge.openRecording!() : undefined,
    googleCalendars: bridge.googleCalendars
      ? async () => parse<GoogleCalendars>(bridge.googleCalendars!(), { permission: false, enabled: false, provisional: "", main: "", status: "", calendars: [] })
      : undefined,
    setGoogleCalendars: bridge.setGoogleCalendars ? async (enabled, provisional, main) => bridge.setGoogleCalendars!(enabled, provisional, main) : undefined,
    localDrafts: bridge.localDrafts ? () => parse<Entry[]>(bridge.localDrafts!(), []) : undefined,
    keepDrafts: bridge.keepDrafts ? (entries) => bridge.keepDrafts!(JSON.stringify(entries)) : undefined,
    onShared(handler) {
      const empty: SharedCalendar = { kind: "blackhole-calendar", schemaVersion: 1, exportedAt: "", events: [], tasks: [], periods: [], notes: [], appliedActions: [] };
      // force: the copy is the same but the phone's own drafts changed (made natively).
      const take = (force = false) => {
        const text = bridge.sharedCopy();
        if (!force && (!text || text === lastShared)) return;
        const shared = text ? parse<SharedCalendar | null>(text, null) : empty;
        if (!isShared(shared)) {
          if (!force) return;
        }
        const copy = isShared(shared) ? { ...shared, events: cleanEvents(shared.events), tasks: cleanTasks(shared.tasks), periods: cleanPeriods(shared.periods), notes: cleanNotes(shared.notes), appliedActions: shared.appliedActions ?? [] } : empty;
        lastShared = text;
        const applied = new Set(copy.appliedActions);
        handler(copy, parse<UserAction[]>(bridge.pendingActions(), []).filter((a) => !applied.has(a.id)));
      };
      window.blackholeShared = () => take();
      window.blackholeDrafts = () => take(true);
      window.setTimeout(() => take(!!bridge.localDrafts), 0);
      bridge.refreshShared();
      // While the calendar is on screen, ask for the Mac's copy every 30 s (a small file).
      window.setInterval(() => {
        if (document.visibilityState === "visible") bridge.refreshShared();
      }, 30_000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") bridge.refreshShared();
      });
    }
  };
}
