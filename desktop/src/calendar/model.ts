/**
 * Blackhole calendar state. Shared by the desktop app and (later) the phone WebView,
 * so nothing here may import Tauri. Everything is local until stage 4 connects the
 * provisional Google Calendar loop.
 *
 * Dates are local "YYYY-MM-DD", times local "HH:MM", reminders local "YYYY-MM-DDTHH:MM".
 */
export type Area = "school" | "personal";

/** Review note on a to-do without a deadline (its `due` is the day it came in). */
export const NO_DUE_NOTE = "마감 날짜가 없어 오늘로 둠";

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
  /** Rule-parser draft: put in at once, the local AI has not refined it yet. */
  draft?: boolean;
  /** Links a draft to its AI result: inbox job id ("job-" + SHA-256 prefix of the original) or a local key. */
  srcKey?: string;
  /** Changed by hand (확정·체크·하위…) while it was a draft: the AI no longer overwrites it. */
  touched?: boolean;
  /** What the AI would have made, kept when the entry was touched (「AI 제안 있음」). */
  suggest?: Suggestion[];
}

/** An AI version of an entry, offered instead of applied. */
export type Suggestion =
  | Omit<CalEvent, "id" | "suggest">
  | Omit<Task, "id" | "suggest">
  | Omit<Period, "id" | "suggest">
  | Omit<Memo, "id" | "suggest">;

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
  /** No deadline was given ("due" is only the day it came in): kept off the calendar. */
  noDue?: boolean;
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
  /** Mac: write a calendar copy for the phone into the Drive 「블랙홀/달력.json」. */
  sharePhone: boolean;
  /** Mac: take Discord·Slack messages into the inbox. */
  messengerEnabled: boolean;
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
  /** Inbox job IDs that already have a rule-parser draft (before the AI result). */
  draftedJobs: string[];
  /** Phone actions (확정·취소·체크…) already applied, by action id. */
  appliedActions: string[];
  settings: Settings;
  nextId: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "glass",
  mode: "dark",
  showSamples: true,
  inboxEnabled: false,
  inboxRoot: null,
  sharePhone: false,
  messengerEnabled: false
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
    draftedJobs: [],
    appliedActions: [],
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
    // Tasks stored before `noDue` existed: the worker's 「오늘로 둠」 note marks a missing deadline.
    tasks: list<Task>(v.tasks).map((t) => (t.noDue === undefined && t.review?.includes(NO_DUE_NOTE) ? { ...t, noDue: true } : t)),
    periods: list<Period>(v.periods),
    notes: list<Memo>(v.notes),
    chat: list<ChatMessage>(v.chat),
    log: list<LogEntry>(v.log),
    inbox: list<InboxEntry>(v.inbox),
    firedAlarms: list<string>(v.firedAlarms),
    ingestedJobs: list<string>(v.ingestedJobs),
    draftedJobs: list<string>(v.draftedJobs),
    appliedActions: list<string>(v.appliedActions),
    settings: { ...DEFAULT_SETTINGS, ...(v.settings ?? {}) },
    nextId: typeof v.nextId === "number" && v.nextId > 0 ? v.nextId : 1
  };
}

/**
 * A change made by hand on one device, replayed on the other (phone → Mac). `src` is the
 * entry's srcKey: a phone draft has its own id, so the Mac finds its entry for the same job.
 */
export type UserAction = { src?: string } & (
  | { id: string; at: string; type: "confirm" | "cancel" | "toggleTask" | "aiAccept" | "aiDismiss"; ref: string }
  | { id: string; at: string; type: "toggleSub"; ref: string; index: number }
  | { id: string; at: string; type: "addSub"; ref: string; title: string }
  | { id: string; at: string; type: "alarm"; ref: string; key: string; answer: "done" | "snooze" | "ack" });

/** What the Mac shares with the phone (Drive 「블랙홀/달력.json」). */
export interface SharedCalendar {
  kind: "blackhole-calendar";
  schemaVersion: 1;
  exportedAt: string;
  events: CalEvent[];
  tasks: Task[];
  periods: Period[];
  notes: Memo[];
  appliedActions: string[];
  /** Inbox jobs the Mac has drafted or analyzed: the phone drops its own drafts for these. */
  sources?: string[];
}

export function sharedFrom(s: CalendarState, now: string): SharedCalendar {
  // Fake sample data stays on the Mac: it is never sent to Drive or the phone.
  const real = <T extends { sample?: boolean }>(list: T[]) => list.filter((x) => !x.sample);
  return { kind: "blackhole-calendar", schemaVersion: 1, exportedAt: now, events: real(s.events), tasks: real(s.tasks), periods: real(s.periods), notes: real(s.notes), appliedActions: s.appliedActions.slice(-500), sources: [...new Set([...s.ingestedJobs, ...s.draftedJobs])].slice(-500) };
}

export function isShared(v: unknown): v is SharedCalendar {
  const x = v as SharedCalendar;
  return !!x && x.kind === "blackhole-calendar" && x.schemaVersion === 1 && [x.events, x.tasks, x.periods, x.notes].every(Array.isArray);
}
