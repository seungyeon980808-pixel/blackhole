/**
 * Pure state operations. The UI calls these, then asks the adapter to save.
 */
import type { Proposal, ProposalItem } from "../worker/proposal";
import { addDays, diffDays, fdShort, fromStamp, isoToStamp, mins, nowHM, parseDay, stamp, ymd } from "./dates";
import type { Area, CalEvent, CalendarState, Entry, LogEntry, Memo, Period, Task, UserAction } from "./model";

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
export const dueOn = (s: CalendarState, k: string): Task[] => liveTasks(s).filter((t) => t.due === k);
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
export function applyProposal(s: CalendarState, p: Proposal, source: string, now: Date): Applied {
  const out: Applied = { refs: [], missing: [] };
  const createdAt = stamp(now);
  for (const item of p.items) {
    const common = { title: item.title, area: areaOf(item.area), source, createdAt, details: item.details || undefined, review: itemReview(item) };
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
      if (!item.startAt) task.review = [...(task.review ?? []), "마감 날짜가 없어 오늘로 둠"];
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
  if (x.kind === "event") x.provisional = false;
  log(s, { label, msg: x.title }, now);
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
  s.appliedActions.push(a.id);
  if (s.appliedActions.length > 2000) s.appliedActions.splice(0, s.appliedActions.length - 2000);
  if (!findEntry(s, a.ref)) return false;
  switch (a.type) {
    case "confirm": confirmEvent(s, a.ref, now); break;
    case "cancel": cancelEntry(s, a.ref, now); break;
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
