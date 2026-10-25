/**
 * Desktop adapter: local state file, the Rust worker, the test-folder inbox, native alarm
 * scheduling (window forward + sound). The only module in the calendar path that imports Tauri.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnalyzeError, type BlackholeAdapter, type InboxResult, type InboxStatus } from "../calendar/adapter";
import { isoWithOffset } from "../calendar/dates";
import type { CalendarState } from "../calendar/model";
import type { Alarm } from "../calendar/store";
import { isProposal, type Proposal } from "../worker/proposal";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function workerError(e: unknown): AnalyzeError {
  const v = e as { code?: string; message?: string } | string;
  if (typeof v === "string") return new AnalyzeError("IO", v);
  return new AnalyzeError(v?.code ?? "IO", v?.message ?? String(e));
}

function checked(p: unknown): Proposal {
  if (!isProposal(p)) throw new AnalyzeError("INVALID_MODEL_OUTPUT", "작업기 결과 형식이 맞지 않습니다.");
  return p;
}

export function tauriAdapter(): BlackholeAdapter {
  let alarmHandler: ((a: Alarm) => void) | null = null;
  const scheduled = new Map<string, Alarm>();
  void listen<{ key: string }>("bh-alarm", (e) => {
    const a = scheduled.get(e.payload.key);
    if (a) alarmHandler?.(a);
  });
  return {
    origin: "데스크톱",
    connection: {
      label: "로컬·미연결",
      detail: "이 Mac의 앱 데이터 폴더에만 저장합니다. 구글 캘린더·드라이브에는 아직 연결하지 않았고 쓰지 않습니다(4단계에서 가승인 캘린더 연결)."
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
    async scheduleAlarms(alarms) {
      scheduled.clear();
      alarms.forEach((a) => scheduled.set(a.key, a));
      await invoke("alarms_schedule", { alarms: alarms.map((a) => ({ key: a.key, atMs: a.atMs, title: a.title })) });
    },
    onAlarm(h) {
      alarmHandler = h;
    },
    ring: (on) => invoke<boolean>("alarm_ring", { on }),
    print: () => invoke("print_page"),
    setLook: (theme, mode) => invoke("set_window_look", { theme, mode }),
    onFileDrop(handler) {
      void listen<{ paths: string[] }>("tauri://drag-drop", (e) => handler(e.payload.paths ?? []));
    }
  };
}
