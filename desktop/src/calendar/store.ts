/**
 * Pure state operations. The UI calls these, then asks the adapter to save.
 */
import type { Proposal, ProposalItem } from "../worker/proposal";
import { addDays, diffDays, fdShort, fromStamp, isoToStamp, mins, nowHM, parseDay, stamp, ymd } from "./dates";
import { NO_DUE_NOTE, type Area, type CalEvent, type CalendarState, type Entry, type LogEntry, type Memo, type Period, type Suggestion, type Task, type UserAction } from "./model";
import { memoDraft, parseDraft } from "./rules";

export const newId = (s: CalendarState, prefix: string): string => `${prefix}-${s.nextId++}`;

const visible = (s: CalendarState) => (x: Entry) => !x.gone && (s.settings.showSamples || !x.sample);

export function liveEvents(s: CalendarState): CalEvent[] {
  return s.events.filter(visible(s));
}
export function liveTasks(s: CalendarState): Task[] {
  return s.tasks.filter(visible(s));
}
export function livePeriods(s: CalendarState): Period[] {
  return s.periods.filter(visible(s));
}

const byStart = (a: CalEvent, b: CalEvent) => (a.start ?? "").localeCompare(b.start ?? "");

export const eventsOn = (s: CalendarState, k: string): CalEvent[] => liveEvents(s).filter((e) => e.date === k).sort(byStart);
/** Deadlines on day k (to-dos given without a deadline stay in the checklist only). */
export const dueOn = (s: CalendarState, k: string): Task[] =>
  liveTasks(s).filter((t) => t.due === k && !t.noDue).sort((a, b) => (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"));
export const periodsOn = (s: CalendarState, k: string): Period[] => livePeriods(s).filter((p) => p.from <= k && k <= p.to);
export const pending = (s: CalendarState): CalEvent[] =>
  liveEvents(s).filter((e) => e.provisional).sort((a, b) => (a.date + (a.start ?? "")).localeCompare(b.date + (b.start ?? "")));

export function findEntry(s: CalendarState, id: string): Entry | undefined {
  return s.events.find((x) => x.id === id) ?? s.tasks.find((x) => x.id === id) ?? s.periods.find((x) => x.id === id) ?? s.notes.find((x) => x.id === id);
}

export interface TaskGroups {
  today: Task[];
  week: Task[];
  later: Task[];
}

/** 오늘까지(밀린 것 포함) / 7일 안 마감 / 나중. */
export function taskGroups(s: CalendarState, k: string): TaskGroups {
  const live = liveTasks(s);
  const limit = ymd(addDays(parseDay(k), 7));
  const byDue = (a: Task, b: Task) => a.due.localeCompare(b.due) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99");
  return {
    today: live.filter((t) => t.due <= k && (!t.done || t.due === k)).sort(byDue),
    week: live.filter((t) => t.due > k && t.due <= limit && !t.done).sort(byDue),
    later: live.filter((t) => t.due > limit && !t.done).sort(byDue)
  };
}

export function log(s: CalendarState, entry: Omit<LogEntry, "at">, now: Date): void {
  s.log.push({ at: stamp(now), ...entry });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

/* ---------- worker proposal → entries ---------- */

const areaOf = (a: string): Area => (a === "SCHOOL" ? "school" : "personal");

export interface Applied {
  /** IDs of entries created. */
  refs: string[];
  /** Items that had no usable date (kept as 기억 with a review note). */
  missing: string[];
}

function itemReview(item: ProposalItem): string[] | undefined {
  return item.needsReview && item.reviewReasons.length ? item.reviewReasons : undefined;
}

/**
 * Schedules go in as 가승인 (provisional). To-dos, periods and notes go in directly
 * (the UI offers 되돌리기).
 */
export function applyProposal(s: CalendarState, p: Proposal, source: string, now: Date, srcKey?: string): Applied {
  const out: Applied = { refs: [], missing: [] };
  const createdAt = stamp(now);
  for (const item of p.items) {
    const common = { title: item.title, area: areaOf(item.area), source, createdAt, details: item.details || undefined, review: itemReview(item), ...(srcKey ? { srcKey } : {}) };
    const reminders = item.reminders.map(isoToStamp);
    if (item.kind === "NOTE" || (item.kind !== "TODO" && !item.startAt)) {
      const note: Memo = { ...common, id: newId(s, "n"), kind: "note" };
      if (item.kind !== "NOTE") {
        note.review = [...(note.review ?? []), "날짜를 찾지 못해 기억으로 둠"];
        out.missing.push(item.title);
      }
      s.notes.push(note);
      out.refs.push(note.id);
      continue;
    }
    if (item.kind === "PERIOD") {
      const from = ymd(new Date(item.startAt));
      const endExclusive = item.endAt ? new Date(item.endAt) : addDays(new Date(item.startAt), 1);
      const to = ymd(addDays(endExclusive, -1));
      const period: Period = { ...common, id: newId(s, "p"), kind: "period", from, to: to < from ? from : to };
      s.periods.push(period);
      out.refs.push(period.id);
      continue;
    }
    const timed = item.evidence.timeText.trim() !== "";
    if (item.kind === "TODO") {
      const start = item.startAt ? new Date(item.startAt) : now;
      const task: Task = {
        ...common,
        id: newId(s, "t"),
        kind: "task",
        due: ymd(start),
        dueTime: item.startAt && timed ? nowHM(start) : null,
        done: false,
        reminders,
        subs: item.subtasks.map((title) => ({ title, done: false }))
      };
      if (!item.startAt) {
        task.review = [...(task.review ?? []), NO_DUE_NOTE];
        task.noDue = true;
      }
      s.tasks.push(task);
      out.refs.push(task.id);
      continue;
    }
    const start = new Date(item.startAt);
    let end: string | null = null;
    if (timed && item.endAt) {
      const e = new Date(item.endAt);
      end = ymd(e) === ymd(start) ? nowHM(e) : "23:59";
    } else if (timed) {
      end = nowHM(new Date(start.getTime() + 3600e3));
    }
    const ev: CalEvent = {
      ...common,
      id: newId(s, "e"),
      kind: "event",
      date: ymd(start),
      start: timed ? nowHM(start) : null,
      end,
      provisional: true,
      reminders
    };
    s.events.push(ev);
    out.refs.push(ev.id);
  }
  return out;
}

/* ---------- draft first, AI later ---------- */

/** Draft ids are unique across devices: a phone draft and a Mac entry never share an id. */
const draftId = (prefix: string): string => `${prefix}-d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const plusMinutes = (day: string, hhmm: string, n: number): string => stamp(new Date(fromStamp(`${day}T${hhmm}`).getTime() + n * 60e3));

/**
 * The rule-parser draft for a sentence, in the calendar at once. Same defaults as the worker:
 * schedules are 가승인, reminders 30 minutes before a time (a dated to-do: that day 09:00).
 */
export function draftFromText(s: CalendarState, text: string, source: string, now: Date, srcKey: string): Entry {
  // A note to remember is never forced into an appointment (「차 번호 12가 3456」, 「메모 …」).
  const m = memoDraft(text, now, s.settings);
  if (m) {
    const note: Memo = { id: draftId("n"), kind: "note", title: m.title || "기억", details: m.details, area: "personal", source, createdAt: stamp(now), draft: !m.final, srcKey };
    s.notes.push(note);
    return note;
  }
  const r = parseDraft(text, now, s.settings);
  const base = { title: r.title, area: "personal" as Area, source, createdAt: stamp(now), draft: true, srcKey, review: r.needsReview ? [r.explanation] : undefined };
  // 「11월 2일부터 6일까지 체험학습」: a span of days is a 기간.
  if (r.until && r.date) {
    const period: Period = { ...base, id: draftId("p"), kind: "period", from: r.date, to: r.until };
    s.periods.push(period);
    return period;
  }
  if (r.kind === "SCHEDULE" && r.date && r.time) {
    const endM = r.end ? mins(r.end) : Math.min(mins(r.time) + 60, 23 * 60 + 59);
    const ev: CalEvent = {
      ...base, id: draftId("e"), kind: "event", date: r.date, start: r.time,
      end: `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(endM % 60).padStart(2, "0")}`,
      provisional: true, reminders: [plusMinutes(r.date, r.time, -30)]
    };
    s.events.push(ev);
    return ev;
  }
  const task: Task = {
    ...base, id: draftId("t"), kind: "task", due: r.date ?? ymd(now), dueTime: r.hasTime ? r.time : null, done: false,
    reminders: r.date ? [r.hasTime && r.time ? plusMinutes(r.date, r.time, -30) : `${r.date}T09:00`] : [], subs: []
  };
  if (!r.date) task.noDue = true;
  s.tasks.push(task);
  return task;
}

const LISTS = ["events", "tasks", "periods", "notes"] as const;
type ListName = (typeof LISTS)[number];
const listOf = (kind: Entry["kind"]): ListName => (kind === "event" ? "events" : kind === "task" ? "tasks" : kind === "period" ? "periods" : "notes");

function allEntries(s: CalendarState): Entry[] {
  return [...s.events, ...s.tasks, ...s.periods, ...s.notes];
}

export const draftsOf = (s: CalendarState, key: string): Entry[] => allEntries(s).filter((x) => x.srcKey === key && x.draft);

/** Give drafts made under a temporary key the inbox job id the phone got for the upload. */
export function rekey(s: CalendarState, from: string, to: string): void {
  for (const x of allEntries(s)) if (x.srcKey === from) x.srcKey = to;
}

function removeEntry(s: CalendarState, x: Entry): void {
  const list = s[listOf(x.kind)] as Entry[];
  const i = list.indexOf(x);
  if (i >= 0) list.splice(i, 1);
}

function stripId<T extends Entry>(x: T): Suggestion {
  const { id: _id, suggest: _s, ...rest } = x;
  return rest as Suggestion;
}

export interface Refined extends Applied {
  /** Drafts the AI result replaced in place (same id). */
  updated: string[];
  /** Touched drafts that got an 「AI 제안」 instead. */
  suggested: string[];
  /** The result was already in (same job seen twice): nothing changed. */
  duplicate: boolean;
}

/**
 * The AI result for a draft group (same srcKey). Untouched drafts are replaced in place:
 * the first AI item of the same kind takes the draft's id, other items are added, drafts with
 * no counterpart are removed (they were machine-made). A draft changed by hand keeps the
 * user's version and only carries the AI version as a suggestion. No group: plain apply.
 */
export function refineDrafts(s: CalendarState, key: string, p: Proposal, source: string, now: Date): Refined {
  const out: Refined = { refs: [], missing: [], updated: [], suggested: [], duplicate: false };
  const group = draftsOf(s, key);
  if (!group.length) {
    if (allEntries(s).some((x) => x.srcKey === key)) return { ...out, duplicate: true };
    return { ...out, ...applyProposal(s, p, source, now, key) };
  }
  if (group.some((x) => x.touched)) {
    const scratch: CalendarState = { ...s, events: [], tasks: [], periods: [], notes: [], nextId: 1 };
    applyProposal(scratch, p, source, now, key);
    const suggest = allEntries(scratch).map(stripId);
    for (const d of group) {
      d.draft = false;
      if (suggest.length && !d.gone) {
        d.suggest = suggest;
        out.suggested.push(d.id);
      }
    }
    return out;
  }
  if (!p.items.length) {
    for (const d of group) {
      d.draft = false;
      // A 기억 the AI found nothing more in simply stays a 기억 (nothing to review).
      if (d.kind !== "note") d.review = [...(d.review ?? []), "AI가 따로 찾은 것이 없어 규칙 초안 그대로 둠"];
      out.updated.push(d.id);
    }
    out.refs = out.updated.slice();
    return out;
  }
  const applied = applyProposal(s, p, source, now, key);
  out.missing = applied.missing;
  const fresh = applied.refs.map((id) => findEntry(s, id)!).filter(Boolean);
  const left = group.slice();
  for (const n of fresh) {
    const i = left.findIndex((d) => d.kind === n.kind);
    if (i < 0) {
      out.refs.push(n.id);
      continue;
    }
    const d = left.splice(i, 1)[0];
    removeEntry(s, n);
    // The words said a clock time and the AI answer lost it (all-day, no deadline): keep it.
    if (d.kind === "event" && n.kind === "event" && d.start && !n.start && d.date === n.date) {
      n.start = d.start;
      n.end = d.end;
      if (!n.reminders.length) n.reminders = d.reminders;
    }
    if (d.kind === "task" && n.kind === "task" && d.dueTime && !n.dueTime && (n.noDue || n.due === d.due)) {
      n.due = d.due;
      n.dueTime = d.dueTime;
      delete n.noDue;
      if (!n.reminders.length) n.reminders = d.reminders;
      // Its notes about the time it could not read no longer apply.
      n.review = n.review?.filter((r) => !/시간|마감 날짜/.test(r));
      if (!n.review?.length) delete n.review;
    }
    const keep = { id: d.id, createdAt: d.createdAt };
    for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
    Object.assign(d, n, keep);
    d.draft = false;
    out.refs.push(d.id);
    out.updated.push(d.id);
  }
  for (const d of left) removeEntry(s, d);
  return out;
}

/** 「AI 제안 적용」: the touched draft becomes the AI's version (same id for the first match). */
export function acceptSuggestion(s: CalendarState, id: string, now: Date): string[] {
  const x = findEntry(s, id);
  if (!x?.suggest?.length) return [];
  const items = x.suggest;
  delete x.suggest;
  const refs: string[] = [];
  let reused = false;
  for (const g of items) {
    if (!reused && g.kind === x.kind && !x.gone) {
      reused = true;
      const keep = { id: x.id, createdAt: x.createdAt };
      for (const k of Object.keys(x)) delete (x as unknown as Record<string, unknown>)[k];
      Object.assign(x, structuredClone(g), keep, { touched: true });
      refs.push(x.id);
      continue;
    }
    const e = { ...structuredClone(g), id: newId(s, g.kind === "event" ? "e" : g.kind === "task" ? "t" : g.kind === "period" ? "p" : "n") } as Entry;
    (s[listOf(e.kind)] as Entry[]).push(e);
    refs.push(e.id);
  }
  if (!reused && !x.gone) x.gone = true;
  log(s, { label: "AI 제안 적용", msg: x.title, ref: refs[0] }, now);
  return refs;
}

/** One log line per created entry, in the prototype's wording. */
export function describe(s: CalendarState, id: string, fd: (k: string) => string = fdShort): { label: string; msg: string } {
  const x = findEntry(s, id);
  if (!x) return { label: "", msg: "" };
  const remText = (rs: string[], today: string) =>
    rs.map((r) => (r.slice(0, 10) === today ? "" : fd(r.slice(0, 10)) + " ") + r.slice(11)).join(", ");
  switch (x.kind) {
    case "event":
      return {
        label: "넣음",
        msg: `${fd(x.date)} ${x.start ?? "종일"} ${x.title}${x.reminders.length ? ` · 알림 ${remText(x.reminders, x.date)}` : ""}`
      };
    case "task":
      return {
        label: "할 일",
        msg: `${x.title} · ${fd(x.due)}${x.dueTime ? " " + x.dueTime : ""}까지${x.subs.length ? ` · 하위 ${x.subs.length}개` : ""}${x.reminders.length ? ` · 알림 ${remText(x.reminders, "")}` : ""}`
      };
    case "period":
      return { label: "기간", msg: `${x.title} · ${fd(x.from)}–${fd(x.to)}` };
    case "note":
      return { label: "기억", msg: x.title };
  }
}

/* ---------- actions ---------- */

export function confirmEvent(s: CalendarState, id: string, now: Date): void {
  const e = s.events.find((x) => x.id === id);
  if (!e || e.gone) return;
  e.provisional = false;
  log(s, { label: "확정", msg: e.title, ref: e.id }, now);
}

/** 취소 (provisional) or 되돌리기 (direct). Soft: the entry stays in the file. */
export function cancelEntry(s: CalendarState, id: string, now: Date): void {
  const x = findEntry(s, id);
  if (!x || x.gone) return;
  const label = x.kind === "event" && x.provisional ? "취소" : "되돌림";
  x.gone = true;
  if (x.kind === "event" && x.provisional) x.goneProvisional = true;
  if (x.kind === "event") x.provisional = false;
  log(s, { label, msg: x.title }, now);
}

/** 「되돌리기」 of a cancel: the entry comes back as it was (a provisional event stays provisional). */
export function restoreEntry(s: CalendarState, id: string, now: Date): void {
  const x = findEntry(s, id);
  if (!x || !x.gone) return;
  delete x.gone;
  if (x.kind === "event" && x.goneProvisional) x.provisional = true;
  delete x.goneProvisional;
  log(s, { label: "되살림", msg: x.title, ref: x.id }, now);
}

export function toggleTask(s: CalendarState, id: string): void {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  if (t.done) t.subs.forEach((x) => (x.done = true));
}

export function toggleSub(s: CalendarState, id: string, index: number): void {
  const t = s.tasks.find((x) => x.id === id);
  if (!t || !t.subs[index]) return;
  t.subs[index].done = !t.subs[index].done;
  t.done = t.subs.length > 0 && t.subs.every((x) => x.done);
}

export function addSub(s: CalendarState, id: string, title: string): void {
  const t = s.tasks.find((x) => x.id === id);
  const v = title.trim();
  if (!t || !v) return;
  t.subs.push({ title: v, done: false });
  t.done = false;
}

/* ---------- alarms ---------- */

export interface Alarm {
  key: string;
  ref: string;
  kind: "event" | "task";
  /** Local stamp YYYY-MM-DDTHH:MM. */
  at: string;
  atMs: number;
  title: string;
  body: string;
}

export function alarmsOn(s: CalendarState, k: string, fd: (k: string) => string = fdShort): Alarm[] {
  return allAlarms(s, fd).filter((a) => a.at.slice(0, 10) === k);
}

export function allAlarms(s: CalendarState, fd: (k: string) => string = fdShort): Alarm[] {
  const out: Alarm[] = [];
  for (const e of liveEvents(s)) {
    for (const at of e.reminders) {
      const lead = e.start && at.slice(0, 10) === e.date ? mins(e.start) - mins(at.slice(11)) : null;
      out.push({
        key: `${e.id}@${at}`,
        ref: e.id,
        kind: "event",
        at,
        atMs: fromStamp(at).getTime(),
        title: e.title,
        body: e.start ? `${e.start} 시작${lead !== null && lead > 0 ? ` · ${lead}분 전` : ""}` : `${fd(e.date)} 종일`
      });
    }
  }
  for (const t of liveTasks(s)) {
    if (t.done) continue;
    const sd = t.subs.filter((x) => x.done).length;
    for (const at of t.reminders) {
      out.push({
        key: `${t.id}@${at}`,
        ref: t.id,
        kind: "task",
        at,
        atMs: fromStamp(at).getTime(),
        title: t.title,
        body: `${fd(t.due)}${t.dueTime ? " " + t.dueTime : ""}까지${t.subs.length ? ` · 하위 ${sd}/${t.subs.length}` : ""}`
      });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** Alarms that have not rung yet and are due within (now - grace, ∞). */
export function upcomingAlarms(s: CalendarState, now: Date, graceMinutes = 10): Alarm[] {
  const from = now.getTime() - graceMinutes * 60e3;
  const fired = new Set(s.firedAlarms);
  return allAlarms(s).filter((a) => a.atMs > from && !fired.has(a.key));
}

/**
 * Alarms that passed while the app was not running (older than the ringing grace, newer than
 * `hours`), not rung or answered: shown once at start as 「놓친 알람」.
 */
export function missedAlarms(s: CalendarState, now: Date, hours = 24, graceMinutes = 10): Alarm[] {
  const to = now.getTime() - graceMinutes * 60e3;
  const from = now.getTime() - hours * 3600e3;
  const fired = new Set(s.firedAlarms);
  return allAlarms(s).filter((a) => a.atMs > from && a.atMs <= to && !fired.has(a.key));
}

export function markFired(s: CalendarState, key: string): void {
  if (!s.firedAlarms.includes(key)) s.firedAlarms.push(key);
  if (s.firedAlarms.length > 2000) s.firedAlarms.splice(0, s.firedAlarms.length - 2000);
}

/** 확인 / 완료 / 10분 뒤. */
export function answerAlarm(s: CalendarState, alarm: Alarm, action: "done" | "snooze", now: Date): string | null {
  markFired(s, alarm.key);
  const x = findEntry(s, alarm.ref);
  if (!x || (x.kind !== "event" && x.kind !== "task")) return null;
  if (action === "done" && x.kind === "task") {
    x.done = true;
    x.subs.forEach((y) => (y.done = true));
    log(s, { label: "완료", msg: x.title, ref: x.id }, now);
  }
  if (action === "snooze") {
    const at = stamp(new Date(now.getTime() + 10 * 60e3));
    x.reminders.push(at);
    x.reminders.sort();
    log(s, { label: "다시 알람", msg: `${at.slice(11)} ${x.title}`, src: "알람", ref: x.id }, now);
    return at;
  }
  return null;
}

export const ddayDays = (today: string, due: string): number => diffDays(today, due);

/* ---------- replaying a hand-made change ---------- */

/** Apply a user action once (by id). Returns false when it was applied before or its entry is gone. */
export function applyAction(s: CalendarState, a: UserAction, now: Date): boolean {
  if (s.appliedActions.includes(a.id)) return false;
  // A phone draft's id is not known here: use this device's entry for the same job.
  const bySrc = a.src ? allEntries(s).find((x) => x.srcKey === a.src && (a.type === "restore" ? !!x.gone : !x.gone)) : undefined;
  const target = findEntry(s, a.ref) ?? bySrc;
  // The job is not here yet (its file comes after the action): try again on a later pull.
  if (!target && a.src && !s.draftedJobs.includes(a.src) && !s.ingestedJobs.includes(a.src) && !a.src.startsWith("local-")) return false;
  s.appliedActions.push(a.id);
  if (s.appliedActions.length > 2000) s.appliedActions.splice(0, s.appliedActions.length - 2000);
  if (!target) return false;
  if (target.id !== a.ref) a = { ...a, ref: target.id } as UserAction;
  if (target.draft && a.type !== "aiAccept" && a.type !== "aiDismiss") target.touched = true;
  switch (a.type) {
    case "aiAccept": acceptSuggestion(s, a.ref, now); break;
    case "aiDismiss": delete target.suggest; break;
    case "confirm": confirmEvent(s, a.ref, now); break;
    case "cancel": cancelEntry(s, a.ref, now); break;
    case "restore": restoreEntry(s, a.ref, now); break;
    case "toggleTask": toggleTask(s, a.ref); break;
    case "toggleSub": toggleSub(s, a.ref, a.index); break;
    case "addSub": addSub(s, a.ref, a.title); break;
    case "alarm": {
      // 「확인」(phone alarm) only ends the ringing; 완료 finishes a to-do; 10분 뒤 adds a reminder.
      const alarm = allAlarms(s).find((x) => x.key === a.key);
      if (alarm && a.answer !== "ack") answerAlarm(s, alarm, a.answer, now);
      else markFired(s, a.key);
      break;
    }
  }
  return true;
}
