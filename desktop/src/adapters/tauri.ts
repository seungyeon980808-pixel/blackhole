/**
 * Desktop adapter: local state file, the Rust worker, the test-folder inbox, native alarm
 * scheduling (window forward + sound). The only module in the calendar path that imports Tauri.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AnalyzeError, type BlackholeAdapter, type ClaudeStatus, type DeskStatus, type InboxDraft, type InboxResult, type InboxStatus, type MessengerStatus, type PutItem } from "../calendar/adapter";
import { isoWithOffset } from "../calendar/dates";
import type { CalendarState, UserAction } from "../calendar/model";
import type { Alarm } from "../calendar/store";
import { isProposal, type Proposal } from "../worker/proposal";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function workerError(e: unknown): AnalyzeError {
  const v = e as { code?: string; message?: string } | string;
  if (typeof v === "string") return new AnalyzeError("IO", v);
  return new AnalyzeError(v?.code ?? "IO", v?.message ?? String(e));
}

function checked(p: unknown): Proposal {
  if (!isProposal(p)) throw new AnalyzeError("INVALID_MODEL_OUTPUT", "AI 결과 형식이 맞지 않습니다.");
  return p;
}

export function tauriAdapter(): BlackholeAdapter {
  let alarmHandler: ((a: Alarm) => void) | null = null;
  const scheduled = new Map<string, Alarm>();
  /** Alarms handed to the alarm window, by key (the answer comes back with the key). */
  const shown = new Map<string, Alarm>();
  void listen<{ key: string }>("bh-alarm", (e) => {
    const a = scheduled.get(e.payload.key);
    if (a) {
      shown.set(a.key, a);
      alarmHandler?.(a);
    }
  });
  const spec = (a: Alarm, missed = false) => ({ key: a.key, atMs: a.atMs, title: a.title, body: a.body, kind: a.kind, ref: a.ref, at: a.at, missed });
  return {
    origin: "데스크톱",
    connection: {
      label: "로컬·미연결",
      detail: "달력은 이 Mac의 앱 데이터 폴더에 저장하고 구글 캘린더에는 쓰지 않습니다. AI 다듬기는 Claude API(키를 넣은 경우)로 글·사진·PDF를 보내 정리합니다."
    },
    load: () => invoke("load_calendar_state"),
    save: (state: CalendarState) => invoke("save_calendar_state", { state }),
    async analyze(input) {
      const now = isoWithOffset(input.now);
      try {
        if (input.text !== undefined) return checked(await invoke("analyze_text", { text: input.text, now }));
        if (input.path) return checked(await invoke("analyze_path", { path: input.path, now }));
        if (input.file) {
          return checked(await invoke("analyze_bytes", input.file.bytes, {
            headers: { "x-file-name": encodeURIComponent(input.file.name), "x-now": now }
          }));
        }
      } catch (e) {
        if (e instanceof AnalyzeError) throw e;
        throw workerError(e);
      }
      throw new AnalyzeError("UNSUPPORTED_INPUT", "넣을 내용이 없습니다.");
    },
    inboxStatus: () => invoke<InboxStatus>("inbox_status"),
    setInbox: (enabled, root) => invoke<InboxStatus>("inbox_set", { enabled, root }),
    inboxResults: () => invoke<InboxResult[]>("inbox_results"),
    inboxDrafts: () => invoke<InboxDraft[]>("inbox_drafts"),
    async scheduleAlarms(alarms) {
      scheduled.clear();
      alarms.forEach((a) => scheduled.set(a.key, a));
      await invoke("alarms_schedule", { alarms: alarms.map((a) => spec(a)) });
    },
    nativeAlarms: true,
    onAlarmAnswer(h) {
      void listen<{ alarm: { key: string }; answer: "done" | "snooze" | "ok" }>("bh-alarm-answer", (e) => {
        const a = shown.get(e.payload.alarm.key) ?? scheduled.get(e.payload.alarm.key);
        if (a) h(a, e.payload.answer);
      });
    },
    async showMissed(alarms) {
      alarms.forEach((a) => shown.set(a.key, a));
      await invoke("alarm_missed", { alarms: alarms.map((a) => spec(a, true)) });
    },
    onPut(handler) {
      const take = () => void invoke<PutItem[]>("put_take").then((list) => list.forEach(handler), () => undefined);
      void listen("bh-put", take).then(take);
    },
    inboxPut: (path) => invoke<string>("inbox_put", { path }),
    putBytes: (name, bytes, via) => invoke("quick_put_bytes", bytes, { headers: { "x-file-name": encodeURIComponent(name), "x-via": encodeURIComponent(via) } }),
    putPath: (path, via) => invoke("quick_put_path", { path, via }),
    inboxDrafted: (skip) => invoke("inbox_drafted", { skip }),
    aiSkipped: (reason) => void invoke("ai_skipped", { reason }).catch(() => undefined),
    setClaudeOptions: (budgetUsd, skipSimple) => invoke<ClaudeStatus>("claude_set_options", { budgetUsd, skipSimple }),
    desk: () => invoke<DeskStatus>("desk_status"),
    setDesk: (settings) => invoke<DeskStatus>("desk_set", { settings }),
    trySound: (sound) => void invoke("alarm_sound_try", { sound }),
    speechPermission: () => invoke<string>("speech_permission"),
    openPrivacy: (pane) => void invoke("open_privacy", { pane }).catch(() => undefined),
    notifyTest: () => void invoke("notify_test"),
    onAlarm(h) {
      alarmHandler = h;
    },
    ring: (on) => invoke<boolean>("alarm_ring", { on }),
    print: () => invoke("print_page"),
    setLook: (theme, mode) => invoke("set_window_look", { theme, mode }),
    claude: () => invoke<ClaudeStatus>("claude_status"),
    setClaudeKey: (key) => invoke<ClaudeStatus>("claude_set_key", { key }),
    clearClaudeKey: () => invoke<ClaudeStatus>("claude_clear_key"),
    checkClaude: () => invoke<string>("claude_check"),
    messenger: () => invoke<MessengerStatus>("messenger_status"),
    setMessenger: (enabled) => invoke<MessengerStatus>("messenger_set", { enabled }),
    publishShared: (shared) => invoke<string>("share_calendar", { shared }),
    phoneActions: () => invoke<UserAction[]>("phone_actions"),
    onFileDrop(handler) {
      // This window only (the quick window handles its own drops).
      void getCurrentWebviewWindow().onDragDropEvent((e) => {
        if (e.payload.type === "drop") handler(e.payload.paths ?? []);
      });
    }
  };
}
