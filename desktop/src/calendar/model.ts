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
/** The old worker's note for a proposed step it threw away (restored as an 「AI 제안」 step). */
export const DROPPED_STEP = "원문에 없는 하위 할 일을 버림: ";

interface Base {
  id: string;
  title: string;
  area: Area;
  /** Where it came from: 데스크톱, 사진, 음성, 인박스, 가짜 자료 ... */
  source: string;
  createdAt: string;
  /** Cancelled or undone. Kept, never deleted. */
  gone?: boolean;
  /** It was a provisional event when cancelled (「되돌리기」 brings it back as provisional). */
  goneProvisional?: boolean;
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
  /** Importance the user set: 0 ☆, 1 yellow ★, 2 red ★ (Mac only for now; not in 달력.json). */
  star?: 0 | 1 | 2;
  /** The AI thinks this matters (출제·결재·평가·제출…): offered, never set by itself. */
  starHint?: 1 | 2;
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
  /** 「작업 시간」: time blocked on the day table for this to-do (its id). The to-do stays one. */
  workFor?: string;
}

/**
 * 루틴: something done again and again at a time (매일 · 평일 · chosen weekdays), checked per day.
 * Mac only for now (not in 달력.json until the phone knows it).
 */
export interface Routine {
  id: string;
  title: string;
  /** HH:MM */
  at: string;
  /** "daily" · "weekdays" · weekday numbers (0 = 일 … 6 = 토) */
  repeat: "daily" | "weekdays" | number[];
  /** Days it was done (YYYY-MM-DD). */
  done: string[];
  createdAt: string;
  gone?: boolean;
}

export interface SubTask {
  title: string;
  done: boolean;
  /** Proposed by the AI, not said in the source (「AI 제안」). */
  ai?: boolean;
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
  /** 「기다림」: what has to happen first (「병렬협조 마무리」 「한 선생님 연락」). */
  wait?: string;
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
  /** Tags the user set by hand (no 「#」); without them the local rules' tags show. Mac only, not in 달력.json. */
  tags?: string[];
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
  /** An answer: the records it found (entries, secret names, notes). */
  hits?: import("./ask").AskHit[];
  /** 「찾을까요, 넣을까요?」: the sentence waiting for one click. */
  choice?: string;
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
  /** Glass theme: card blur in px (26 = the approved look). */
  glassBlur: number;
  /** Glass theme: background and card brightness, -50 … 50 (0 = the approved look). */
  glassBright: number;
  /** 「출근 전」 「아침에」: when the work day starts (HH:MM). */
  onWork: string;
  /** 「퇴근 전」: when the work day ends (HH:MM). */
  offWork: string;
  /** 「점심 전/때」: lunch (HH:MM-HH:MM). */
  lunch: string;
  /** 「n교시 전/후/에」: the school periods, in order (HH:MM-HH:MM each). */
  periods: string[];
  /** An appointment without an end is drawn this many minutes long (marked 「끝 미정」). */
  eventMinutes: number;
  /** Faint school-period bands on the day band and the week (weekdays). */
  showPeriods: boolean;
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
  routines: Routine[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "glass",
  mode: "dark",
  showSamples: false,
  inboxEnabled: false,
  inboxRoot: null,
  sharePhone: false,
  messengerEnabled: false,
  glassBlur: 26,
  glassBright: 0,
  // The user's school (2026-10-27): 45-minute lessons, 10-minute breaks, lunch after 4교시.
  onWork: "08:20",
  offWork: "16:20",
  lunch: "12:20-13:20",
  periods: ["08:50-09:35", "09:45-10:30", "10:40-11:25", "11:35-12:20", "13:20-14:05", "14:15-15:00", "15:10-15:55"],
  eventMinutes: 60,
  showPeriods: true
};

/** The first build's placeholder school day (never shown in 설정): replaced by the real one. */
function schoolTimes(st: Settings): Settings {
  if (st.offWork === "16:40" && st.lunch === "12:10-13:00" && st.periods?.[0] === "09:00-09:40") {
    return { ...st, onWork: DEFAULT_SETTINGS.onWork, offWork: DEFAULT_SETTINGS.offWork, lunch: DEFAULT_SETTINGS.lunch, periods: DEFAULT_SETTINGS.periods.slice() };
  }
  return st;
}

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
    nextId: 1,
    routines: []
  };
}

/**
 * Records as they are read back (stored state, the Mac's 달력.json on the phone): one broken record
 * (no reminders list, no date) used to stop the whole app at start. Fill what can be filled, drop the rest.
 */
const isDay = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d\d-\d\d$/.test(x);
/** The same list when nothing was dropped (callers may keep pushing to the list they passed). */
const kept = <T>(x: unknown, out: T[]): T[] => (Array.isArray(x) && x.length === out.length ? (x as T[]) : out);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []);
function base<T extends Base>(x: unknown, kind: T["kind" & keyof T]): T | null {
  const v = x as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id) return null;
  // Filled in place (the loaded objects stay the ones the caller holds).
  return Object.assign(v, {
    kind,
    title: typeof v.title === "string" ? v.title : String(v.title ?? ""),
    area: v.area === "personal" ? "personal" : "school",
    source: typeof v.source === "string" ? v.source : "",
    createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
    ...(v.review === undefined ? {} : { review: strs(v.review) })
  }) as unknown as T;
}
export function cleanEvents(x: unknown): CalEvent[] {
  return kept(x, (Array.isArray(x) ? x : []).flatMap((r) => {
    const e = base<CalEvent>(r, "event");
    if (!e || !isDay(e.date)) return [];
    const hm = (t: unknown) => (typeof t === "string" && /^\d\d:\d\d$/.test(t) ? t : null);
    return [Object.assign(e, { start: hm(e.start), end: hm(e.end), provisional: e.provisional === true, reminders: strs(e.reminders) })];
  }));
}
export function cleanTasks(x: unknown): Task[] {
  return kept(x, (Array.isArray(x) ? x : []).flatMap((r) => {
    const t = base<Task>(r, "task");
    if (!t || !isDay(t.due)) return [];
    const subs = (Array.isArray(t.subs) ? t.subs : []).filter((y) => y && typeof y === "object").map((y) => Object.assign(y, { title: String(y.title ?? ""), done: y.done === true, ai: y.ai === true ? true : undefined }));
    return [Object.assign(t, { dueTime: typeof t.dueTime === "string" && /^\d\d:\d\d$/.test(t.dueTime) ? t.dueTime : null, done: t.done === true, reminders: strs(t.reminders), subs })];
  }));
}
export function cleanPeriods(x: unknown): Period[] {
  return kept(x, (Array.isArray(x) ? x : []).flatMap((r) => {
    const p = base<Period>(r, "period");
    return p && isDay(p.from) && isDay(p.to) ? [p.to < p.from ? Object.assign(p, { from: p.to, to: p.from }) : p] : [];
  }));
}
export function cleanNotes(x: unknown): Memo[] {
  return kept(x, (Array.isArray(x) ? x : []).flatMap((r) => {
    const m = base<Memo>(r, "note");
    return m ? [m] : [];
  }));
}

/** Accept a stored state, filling fields added later. Rejects anything else. */
export function normalizeState(value: unknown): CalendarState | null {
  const v = value as Partial<CalendarState> | null;
  if (!v || typeof v !== "object" || v.schemaVersion !== 1) return null;
  const base = emptyState();
  const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  // A preview seeded with fake data keeps it (showSamples on); real data drops it for good.
  const real = (x: { sample?: boolean }) => v.settings?.showSamples === true || !x.sample;
  // Same list back when nothing is dropped (callers may hold on to it).
  const dropFake = <T extends { sample?: boolean }>(xs: T[]): T[] => (xs.every(real) ? xs : xs.filter(real));
  return {
    ...base,
    // Fake sample data (가짜 자료) is gone for good: dropped on load, never seeded on the Mac.
    events: dropFake(cleanEvents(v.events)),
    // The old 「오늘로 둠」 note: it marks a missing deadline (→ 날짜 없음) and is no longer a question.
    tasks: dropFake(cleanTasks(v.tasks)).map((t) => {
      if (!t.review?.some((r) => r === NO_DUE_NOTE || r.startsWith(DROPPED_STEP))) return t;
      // Steps the AI proposed but the old worker dropped come back as 「AI 제안」 steps.
      const back = t.review.filter((r) => r.startsWith(DROPPED_STEP)).map((r) => r.slice(DROPPED_STEP.length).replace(/^「|」$/g, "").trim()).filter((x) => x && !t.subs.some((y) => y.title === x));
      const review = t.review.filter((r) => r !== NO_DUE_NOTE && !r.startsWith(DROPPED_STEP));
      const noDue = t.review.includes(NO_DUE_NOTE) ? t.noDue ?? true : t.noDue;
      return { ...t, noDue, subs: [...t.subs, ...back.slice(0, 5).map((title) => ({ title, done: false, ai: true as const }))], review: review.length ? review : undefined };
    }),
    periods: dropFake(cleanPeriods(v.periods)),
    notes: dropFake(cleanNotes(v.notes)),
    // The whole state is written on every change: old chat and inbox lines go (only the last
    // CHAT_SHOWN are ever drawn), so a year of use stays a small file.
    chat: list<ChatMessage>(v.chat).slice(-KEEP_CHAT),
    log: list<LogEntry>(v.log),
    inbox: list<InboxEntry>(v.inbox).slice(-KEEP_INBOX),
    firedAlarms: list<string>(v.firedAlarms),
    ingestedJobs: list<string>(v.ingestedJobs),
    draftedJobs: list<string>(v.draftedJobs),
    appliedActions: list<string>(v.appliedActions),
    settings: schoolTimes({ ...DEFAULT_SETTINGS, ...(v.settings ?? {}) }),
    nextId: typeof v.nextId === "number" && v.nextId > 0 ? v.nextId : 1,
    routines: list<Routine>(v.routines)
  };
}

export const KEEP_CHAT = 2000;
export const KEEP_INBOX = 500;

/**
 * A change made by hand on one device, replayed on the other (phone → Mac). `src` is the
 * entry's srcKey: a phone draft has its own id, so the Mac finds its entry for the same job.
 */
export type UserAction = { src?: string } & (
  | { id: string; at: string; type: "confirm" | "cancel" | "restore" | "toggleTask" | "aiAccept" | "aiDismiss"; ref: string }
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
  // New Mac-only fields (★, 작업 시간 blocks, 루틴) stay out until the phone's reader knows them.
  const real = <T extends { sample?: boolean }>(list: T[]) => list.filter((x) => !x.sample);
  const plain = <T extends Entry>(x: T): T => {
    if (x.star === undefined && x.starHint === undefined && !("tags" in x)) return x;
    const { star: _s, starHint: _h, ...rest } = x as T & { tags?: string[] };
    delete rest.tags;
    return rest as T;
  };
  return { kind: "blackhole-calendar", schemaVersion: 1, exportedAt: now, events: real(s.events).filter((e) => !e.workFor).map(plain), tasks: real(s.tasks).map(plain), periods: real(s.periods).map(plain), notes: real(s.notes).map(plain), appliedActions: s.appliedActions.slice(-500), sources: [...new Set([...s.ingestedJobs, ...s.draftedJobs])].slice(-500) };
}

export function isShared(v: unknown): v is SharedCalendar {
  const x = v as SharedCalendar;
  return !!x && x.kind === "blackhole-calendar" && x.schemaVersion === 1 && [x.events, x.tasks, x.periods, x.notes].every(Array.isArray);
}
