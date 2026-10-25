/**
 * Blackhole calendar state. Shared by the desktop app and (later) the phone WebView,
 * so nothing here may import Tauri. Everything is local until stage 4 connects the
 * provisional Google Calendar loop.
 *
 * Dates are local "YYYY-MM-DD", times local "HH:MM", reminders local "YYYY-MM-DDTHH:MM".
 */
export type Area = "school" | "personal";

interface Base {
  id: string;
  title: string;
  area: Area;
  /** Where it came from: 데스크톱, 사진, 음성, 인박스, 가짜 자료 ... */
  source: string;
  createdAt: string;
  /** Cancelled or undone. Kept, never deleted. */
  gone?: boolean;
  /** Seeded fake data (hidden when settings.showSamples is false). */
  sample?: boolean;
  details?: string;
  review?: string[];
}

/** A timed (or all-day) appointment. Provisional until 확정. */
export interface CalEvent extends Base {
  kind: "event";
  date: string;
  start: string | null;
  end: string | null;
  provisional: boolean;
  reminders: string[];
}

export interface SubTask {
  title: string;
  done: boolean;
}

/** To-do with optional deadline, reminders and a sub-checklist. */
export interface Task extends Base {
  kind: "task";
  due: string;
  dueTime: string | null;
  done: boolean;
  reminders: string[];
  subs: SubTask[];
}

/** Several whole days, inclusive. */
export interface Period extends Base {
  kind: "period";
  from: string;
  to: string;
}

/** 기억: information without a date. */
export interface Memo extends Base {
  kind: "note";
}

export type Entry = CalEvent | Task | Period | Memo;

export type ChatKind = "text" | "photo" | "voice" | "file";

export interface ChatMessage {
  id: string;
  at: string;
  who: "me" | "ai";
  text: string;
  kind?: ChatKind;
  src?: string;
  refs?: string[];
  fileName?: string;
  /** Analysis failed (shown, can be retried by sending again). */
  error?: boolean;
}

export interface LogEntry {
  at: string;
  label: string;
  msg: string;
  src?: string;
  ref?: string;
}

export type InboxState = "완료" | "분석 중" | "검토 필요" | "실패";

export interface InboxEntry {
  at: string;
  title: string;
  src: string;
  state: InboxState;
  out: string;
}

export type ThemeName = "glass" | "doc";

export interface Settings {
  theme: ThemeName;
  mode: "dark" | "light";
  showSamples: boolean;
  inboxEnabled: boolean;
  /** Test folder for the worker inbox. null = adapter default. */
  inboxRoot: string | null;
}

export interface CalendarState {
  schemaVersion: 1;
  events: CalEvent[];
  tasks: Task[];
  periods: Period[];
  notes: Memo[];
  chat: ChatMessage[];
  log: LogEntry[];
  inbox: InboxEntry[];
  /** Alarm keys (`id@YYYY-MM-DDTHH:MM`) already rung or acknowledged. */
  firedAlarms: string[];
  /** Inbox job IDs already turned into calendar entries. */
  ingestedJobs: string[];
  settings: Settings;
  nextId: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "glass",
  mode: "dark",
  showSamples: true,
  inboxEnabled: false,
  inboxRoot: null
};

export function emptyState(): CalendarState {
  return {
    schemaVersion: 1,
    events: [],
    tasks: [],
    periods: [],
    notes: [],
    chat: [],
    log: [],
    inbox: [],
    firedAlarms: [],
    ingestedJobs: [],
    settings: { ...DEFAULT_SETTINGS },
    nextId: 1
  };
}

/** Accept a stored state, filling fields added later. Rejects anything else. */
export function normalizeState(value: unknown): CalendarState | null {
  const v = value as Partial<CalendarState> | null;
  if (!v || typeof v !== "object" || v.schemaVersion !== 1) return null;
  const base = emptyState();
  const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    ...base,
    events: list<CalEvent>(v.events),
    tasks: list<Task>(v.tasks),
    periods: list<Period>(v.periods),
    notes: list<Memo>(v.notes),
    chat: list<ChatMessage>(v.chat),
    log: list<LogEntry>(v.log),
    inbox: list<InboxEntry>(v.inbox),
    firedAlarms: list<string>(v.firedAlarms),
    ingestedJobs: list<string>(v.ingestedJobs),
    settings: { ...DEFAULT_SETTINGS, ...(v.settings ?? {}) },
    nextId: typeof v.nextId === "number" && v.nextId > 0 ? v.nextId : 1
  };
}
