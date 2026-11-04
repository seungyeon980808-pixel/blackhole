/**
 * 「오늘(일) 화면」 (user-approved plan, mockups today-v3 · today-priority, 2026-10-27):
 *   [vertical day table ≈1.35fr] [to-dos ≈1fr] [upcoming + 루틴 290px]  (+ the chat panel)
 * Colours: only the star's yellow and red; everything else is light-on-glass (or ink on paper).
 * Times are 24-hour. Shared by both themes (they paint the classes) and the phone (stacked).
 */
import { addDays, DOW, mins, parseDay, ymd } from "../dates";
import type { CalEvent, CalendarState, Entry, Routine, Task } from "../model";
import { dueOn, eventsOn, liveEvents, livePeriods, liveTasks } from "../store";
import { duplicates, esc, type Ctx } from "./common";

const STAR = ["☆", "★", "★"];

/* ---------- rules (pure) ---------- */

/** Minutes from now to the deadline (negative = passed). A day-only deadline ends at 퇴근. */
export function minsLeft(t: Task, now: Date, offWork = "16:20"): number {
  return Math.round((dueAt(t, offWork).getTime() - now.getTime()) / 60000);
}

const dueAt = (t: Task, offWork = "16:20"): Date => {
  const d = parseDay(t.due);
  const [h, m] = (t.dueTime ?? offWork).split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};

/** 걸리는 시간 (11-02 사용자 결정): six steps. */
export const EFFORTS: [number, string][] = [[10, "10분"], [30, "30분"], [60, "1시간"], [180, "3시간"], [480, "하루"], [1440, "여러 날"]];
export const effortName = (n: number): string => EFFORTS.find(([m]) => m === n)?.[1] ?? `${n}분`;

/** A first guess from the title (the user corrects it with one click): 공문 제출 10분 · 출제 하루. */
export function guessEffort(title: string): number {
  // 「출제 원안 제출」 「대의원회 기안 올리기」: what is done at the end decides it (a hand-in is short).
  if (/(?:제출|송금|보내기|보냄|확인|전화|연락|신청|출력|결재|올리기|답장|회신|예약|입금|이체|주문|반납)\s*(?:하기)?\s*$/.test(title)) return 10;
  if (/세특|생기부|생활기록부|교육과정\s*(?:편성|작성)|논문|연구\s*보고서/.test(title)) return 1440;
  if (/출제|시험\s*문제|문항\s*(?:제작|개발)|평가\s*계획|수업\s*(?:자료|준비)|강의안|발표\s*자료|연수\s*준비|교재/.test(title)) return 480;
  if (/채점|보고서|계획서|결과물|정리|자료\s*(?:제작|만들)|PPT|ppt|피피티|상담\s*준비|성적\s*처리/.test(title)) return 180;
  if (/기안|공문\s*작성|가정통신문\s*작성|회의록|협의록|작성|만들기|준비/.test(title)) return 60;
  if (/제출|송금|보내|보냄|확인|전화|연락|신청|출력|결재|올리기|답장|회신|예약|입금|이체|구매|주문/.test(title)) return 10;
  return 30;
}
export const effortOf = (t: Task): number => t.effort ?? guessEffort(t.title);

/** Work time (평일 출근–퇴근) between two instants, in minutes. */
export function workMinsBetween(from: Date, to: Date, onWork = "08:20", offWork = "16:20"): number {
  if (to <= from) return 0;
  const on = mins(onWork);
  const off = mins(offWork);
  let total = 0;
  for (let d = parseDay(ymd(from)); d <= to && total < 1e6; d = addDays(d, 1)) {
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    const a = Math.max(on, ymd(d) === ymd(from) ? from.getHours() * 60 + from.getMinutes() : 0);
    const b = Math.min(off, ymd(d) === ymd(to) ? to.getHours() * 60 + to.getMinutes() : 24 * 60);
    if (b > a) total += b - a;
  }
  return total;
}

/** The day's hours (설정) and, when known, the calendar (its 작업 시간 count as work already planned). */
export type UrgencyCtx = string | { settings: { onWork: string; offWork: string }; events?: CalEvent[] };

/**
 * 급함 단계 (11-02): what is left of 걸리는 시간 against the work time left until the deadline.
 * 0 여유 · 1 곧 (× 4 or less) · 2 급함 (× 2 or less, at least the last hour) · 3 늦음 (passed, or cannot be finished).
 */
export function urgency(t: Task, now: Date, c: UrgencyCtx = "16:20"): 0 | 1 | 2 | 3 {
  if (t.noDue || t.done) return 0;
  const [on, off] = typeof c === "string" ? ["08:20", c] : [c.settings.onWork, c.settings.offWork];
  const due = dueAt(t, off);
  if (due <= now) return 3;
  const need = needLeft(t, c);
  if (!need) return 0;
  const left = workMinsBetween(now, due, on, off);
  if (left < need) return 3;
  if (left <= Math.max(60, need * 2)) return 2;
  if (left <= need * 4) return 1;
  return 0;
}

/** 걸리는 시간 minus the 작업 시간 already set for it. */
function needLeft(t: Task, c: UrgencyCtx): number {
  const planned = typeof c === "string" ? 0 : (c.events ?? []).filter((e) => e.workFor === t.id && !e.gone && e.start && e.end).reduce((n, e) => n + mins(e.end!) - mins(e.start!), 0);
  return Math.max(0, effortOf(t) - planned);
}

/** 급함: 급함 단계 2 or more. Decided by the clock and 걸리는 시간, never by hand. */
export const isUrgent = (t: Task, now: Date, c?: UrgencyCtx): boolean => urgency(t, now, c) >= 2;

/** The one 「남은 시간」 word: 「D-3」 · 「5시간 남음」 · 「40분 남음」 · 「4일 지남」 · 「2시간 지남」. */
export function remainText(t: Task, now: Date, offWork?: string): string {
  if (t.noDue) return "";
  const due = dueAt(t, offWork);
  const m = Math.round((due.getTime() - now.getTime()) / 60000);
  if (m < 0) return -m >= 1440 ? `${Math.floor(-m / 1440)}일 지남` : -m >= 60 ? `${Math.floor(-m / 60)}시간 지남` : `${-m}분 지남`;
  const days = Math.round((parseDay(t.due).getTime() - parseDay(ymd(now)).getTime()) / 864e5);
  if (days > 0) return `D-${days}`;
  return m >= 60 ? `${Math.floor(m / 60)}시간 남음` : `${m}분 남음`;
}

/** 「늦어도 11/3(화) 08:20 시작」: walking back the work time still needed from the deadline. */
export function startBy(t: Task, c: UrgencyCtx, fd: (k: string) => string, today: string): string {
  if (t.noDue) return "";
  const [on, off] = typeof c === "string" ? ["08:20", c] : [c.settings.onWork, c.settings.offWork];
  let need = needLeft(t, c);
  if (!need) return "";
  let d = parseDay(t.due);
  let end = Math.min(mins(t.dueTime ?? off), mins(off));
  for (let i = 0; i < 60; i++) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) {
      const avail = Math.max(0, end - mins(on));
      if (avail >= need) {
        const at = end - need;
        const k = ymd(d);
        return `늦어도 ${k === today ? "" : fd(k) + " "}${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")} 시작`;
      }
      need -= avail;
    }
    d = addDays(d, -1);
    end = mins(off);
  }
  return "";
}

export type Bucket = "now" | "urgent" | "imp" | "rest";
export function bucketOf(t: Task, now: Date, c?: UrgencyCtx): Bucket {
  const u = isUrgent(t, now, c);
  const i = (t.star ?? 0) > 0;
  return u && i ? "now" : u ? "urgent" : i ? "imp" : "rest";
}

/**
 * The to-do list in order, with its numbers: 오늘 (due today or passed) by 급함 → ★ → deadline,
 * then 나중 by date. The number is the same in the list and on the day table.
 */
export function orderedTasks(s: CalendarState, today: string, now: Date): { today: Task[]; later: Task[]; undated: Task[]; done: Task[]; num: Map<string, number> } {
  const off = s.settings.offWork;
  const live = liveTasks(s);
  const open = live.filter((t) => !t.done);
  const isToday = (t: Task) => !t.noDue && t.due <= today;
  const byUrgency = (a: Task, b: Task) =>
    urgency(b, now, s) - urgency(a, now, s) || (b.star ?? 0) - (a.star ?? 0) || minsLeft(a, now, off) - minsLeft(b, now, off);
  const t = open.filter(isToday).sort(byUrgency);
  const later = open.filter((x) => !x.noDue && !isToday(x)).sort((a, b) => (a.due + (a.dueTime ?? "99")).localeCompare(b.due + (b.dueTime ?? "99")) || (b.star ?? 0) - (a.star ?? 0));
  // 「날짜 없음」: no deadline was given — never today, never urgent, off the day table.
  const undated = open.filter((x) => x.noDue).sort((a, b) => (b.star ?? 0) - (a.star ?? 0) || a.createdAt.localeCompare(b.createdAt));
  const num = new Map<string, number>();
  [...t, ...later, ...undated].forEach((x, i) => num.set(x.id, i + 1));
  const done = live.filter((x) => x.done && x.due === today);
  return { today: t, later, undated, done, num };
}

/** 「2시간 33분」 */
export function dur(n: number): string {
  const a = Math.abs(n);
  return a >= 60 ? `${Math.floor(a / 60)}시간${a % 60 ? ` ${a % 60}분` : ""}` : `${a}분`;
}

export function dueText(t: Task, now: Date, today: string, fd: (k: string) => string, offWork?: string): string {
  if (t.noDue) return "날짜 없음";
  if (t.due === today || t.due < today) {
    if (t.dueTime) {
      const d = minsLeft(t, now, offWork);
      return d < 0 ? `${t.due < today ? fd(t.due) + " " : ""}${t.dueTime} · ${dur(d)} 지남` : `${t.dueTime} · ${dur(d)}`;
    }
    return t.due < today ? `${fd(t.due)} · 지남` : "오늘 중";
  }
  return `${fd(t.due)}${t.dueTime ? " " + t.dueTime : ""}`;
}

/** Does this 루틴 come on day k? */
export function routineOn(r: Routine, k: string): boolean {
  if (r.gone) return false;
  const wd = parseDay(k).getDay();
  if (r.repeat === "daily") return true;
  if (r.repeat === "weekdays") return wd >= 1 && wd <= 5;
  return r.repeat.includes(wd);
}

export const repeatLabel = (r: Routine): string =>
  r.repeat === "daily" ? "매일" : r.repeat === "weekdays" ? "평일" : r.repeat.slice().sort().map((d) => DOW[d]).join("·");

/** 연속 일수: scheduled days in a row that were done, up to today (today counts once done). */
export function streak(r: Routine, today: string): number {
  let n = 0;
  let d = parseDay(today);
  if (!r.done.includes(today)) d = addDays(d, -1);
  for (let i = 0; i < 400; i++) {
    const k = ymd(d);
    if (k < r.createdAt.slice(0, 10)) break;
    if (routineOn(r, k)) {
      if (!r.done.includes(k)) break;
      n++;
    }
    d = addDays(d, -1);
  }
  return n;
}

export interface Upcoming {
  id: string;
  title: string;
  /** 짧은 이름 (띠에 씀), when set. */
  short?: string;
  /** The day (YYYY-MM-DD). */
  date: string;
  star: number;
  days: number;
  /** A period's last day, in days from today. */
  endDays?: number;
  when: string;
  steps?: [number, number];
}

/**
 * 다가오는 주요 일정: starred appointments and deadlines, and periods, by D-day — no day limit
 * (11-02 사용자: 날짜 창이 아니라 개수로, 화면에는 10개까지 `UPCOMING_MAX`).
 */
export const UPCOMING_MAX = 10;
export function upcoming(s: CalendarState, today: string, fd: (k: string) => string): Upcoming[] {
  const until = "9999-12-31";
  const out: Upcoming[] = [];
  const days = (k: string) => Math.round((parseDay(k).getTime() - parseDay(today).getTime()) / 864e5);
  for (const e of liveEvents(s)) {
    if (e.workFor || !(e.star ?? 0) || e.date <= today || e.date > until) continue;
    out.push({ id: e.id, title: e.title, short: e.short, date: e.date, star: e.star ?? 0, days: days(e.date), when: `${fd(e.date)}${e.start ? ` ${e.start}${e.end ? "–" + e.end : ""}` : ""}${e.details ? ` · ${e.details}` : ""}` });
  }
  for (const t of liveTasks(s)) {
    if (t.done || t.noDue || !(t.star ?? 0) || t.due <= today || t.due > until) continue;
    out.push({ id: t.id, title: t.title, short: t.short, date: t.due, star: t.star ?? 0, days: days(t.due), when: `${fd(t.due)}${t.dueTime ? " " + t.dueTime : ""}까지`, steps: t.subs.length ? [t.subs.filter((x) => x.done).length, t.subs.length] : undefined });
  }
  for (const p of livePeriods(s)) {
    if (p.from <= today) continue;
    out.push({ id: p.id, title: p.title, short: p.short, date: p.from, star: p.star ?? 0, days: days(p.from), endDays: days(p.to), when: `${fd(p.from)}–${fd(p.to)}` });
  }
  return out.sort((a, b) => a.days - b.days || b.star - a.star);
}

/* ---------- view ---------- */

export interface TodayOpts {
  /** "work" 08–17 (fills the table) · "all" 00–24 */
  range: "work" | "all";
  /** to-do filter chip */
  filter: "all" | Bucket;
  /** 다가오는 주요 일정 띠: days ahead (30 · 60 · 120, default 60). */
  upRange?: 30 | 60 | 120;
  /** The band's width last measured (px), for fitting the names. */
  bandW?: number;
  /** Which ★ the band shows: 1 노랑 · 2 빨강 · "all" 둘 다. */
  upStars?: 1 | 2 | "all";
}

/** One stretch of time cut at the hour lines: the day table is one row per hour, 6 cells of 10 minutes. */
export function hourPieces(a: number, b: number, S: number, E: number): { row: number; x0: number; x1: number; first: boolean; last: boolean }[] {
  const out: { row: number; x0: number; x1: number; first: boolean; last: boolean }[] = [];
  const from = Math.max(a, S);
  const to = Math.min(b, E);
  for (let m = from; m < to; ) {
    const h = Math.floor(m / 60);
    const end = Math.min(to, (h + 1) * 60);
    out.push({ row: h - S / 60, x0: (m - h * 60) / 60, x1: (end - h * 60) / 60, first: m === a, last: end === b });
    m = end;
  }
  return out;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * 하루표 (11-02 사용자 시안 「10분 칸」): one row per hour, 6 cells of 10 minutes. Appointments are a light
 * fill (no edge stripe), 작업 시간 (a to-do dragged here) a mint fill with its number and 「남은 시간」.
 * Deadlines are not drawn here — they are the 「남은 시간」 word on the to-do and on its 작업 상자.
 */
export function dayTable(ctx: Ctx, k: string, o: TodayOpts, num: Map<string, number>, fd: (k: string) => string): string {
  const st = ctx.s.settings;
  // 11-02 사용자: 「07–18」(집에 도착할 때까지) · 「07–21」(야근하는 날).
  const [S, E] = o.range === "work" ? [7 * 60, 18 * 60] : [7 * 60, 21 * 60];
  const rows = (E - S) / 60;
  const evs = eventsOn(ctx.s, k);
  const allDay = evs.filter((e) => !e.start);
  const timed = evs.filter((e) => e.start);
  const nowM = k === ctx.today ? ctx.nowM : -1;
  // A piece of time as boxes, one per hour row (lane: which of `lanes` stacked rows it takes).
  const piece = (a: number, b: number, cls: string, attrs: (p: ReturnType<typeof hourPieces>[number]) => string, inner: (p: ReturnType<typeof hourPieces>[number]) => string, lane = 0, lanes = 1) =>
    hourPieces(a, b, S, E).map((p) => `<div class="sg ${cls}${p.first ? " f" : ""}${p.last ? " l" : ""}" ${attrs(p)} style="top:calc(${((p.row + lane / lanes) / rows) * 100}% + 2px);height:calc(${100 / rows / lanes}% - 4px);left:calc(${p.x0 * 100}% + 1px);width:calc(${(p.x1 - p.x0) * 100}% - 2px)">${inner(p)}</div>`).join("");
  let h = "";
  const wd = parseDay(k).getDay();
  const school = wd >= 1 && wd <= 5;
  // 고정 칸 (11-02 사용자: 「너무 연해서 뭘 하겠다는 건지 모르겠다」): 출근길 · 점심 · 퇴근길 on school days, named.
  const fixed: [string, string][] = school ? [["출근", st.commuteIn ?? "07:00-08:20"], ["점심", st.lunch], ["퇴근", st.commuteOut ?? "16:40-18:00"]] : [];
  // Appointments, 작업 시간 and 루틴 share rows: what overlaps takes a lane of its own (stacked in the row).
  type Item = { a: number; b: number; html: (lane: number, lanes: number) => string };
  const items: Item[] = [];
  for (const e of timed) {
    const a = mins(e.start!);
    const b = e.end && mins(e.end) > a ? mins(e.end) : a + (st.eventMinutes || 60);
    const n = e.workFor ? num.get(e.workFor) : undefined;
    const task = e.workFor ? ctx.s.tasks.find((t) => t.id === e.workFor) : undefined;
    const lv = task ? urgency(task, ctx.now, ctx.s) : 0;
    const rem = task && !task.done && !task.noDue ? `<button class="rem R${lv}" data-rem="${task.id}" title="${esc(`${fd(task.due)}${task.dueTime ? " " + task.dueTime : ""}까지 · 눌러서 기한 다시 정하기`)}">${remainText(task, ctx.now, st.offWork)}</button>` : "";
    // 작업 칸: a check that is the to-do's (or its small check's) own, so either one checks both (11-02).
    const sub = task && e.workSub !== undefined ? task.subs[e.workSub] : undefined;
    const wdone = task ? (sub ? sub.done : task.done) : false;
    const wck = task ? `<span class="ck wck ${wdone ? "on" : ""}" ${sub ? `data-sub="${task.id}:${e.workSub}"` : `data-tdone="${task.id}"`} role="checkbox" aria-checked="${wdone}" tabindex="0" title="${wdone ? "안 한 것으로" : "했음"}"></span>` : "";
    const cls = `ev ${e.workFor ? "work" : `k-${e.area}`} ${wdone ? "dn" : ""} ${e.provisional ? "prov" : ""} ${nowM >= 0 && b <= nowM ? "past" : ""} ${e.end ? "" : "noend"}`;
    items.push({ a, b, html: (lane, lanes) => piece(a, b, cls, () => `data-ev="${e.id}" data-evbox="${e.id}" tabindex="0" aria-label="${esc(e.title)} 열기" title="${esc(`${e.start}${e.end ? "–" + e.end : ""} ${e.title}`)}"`, (p) =>
      `${p.first ? `${wck}${n ? `<span class="no">${n}</span>` : ""}${e.periodSaid && !e.title.includes(e.periodSaid) ? `<span class="pd">${e.periodSaid}</span>` : ""}<span class="t">${esc(e.title)}</span>${e.provisional ? '<span class="ga">가</span>' : ""}${!e.end ? '<span class="r">끝 미정</span>' : ""}${rem}` : ""}${p.last ? '<i class="grip" title="끌어 늘이기"></i>' : ""}`, lane, lanes) });
  }
  // 고정 칸 share the rows too: an appointment at lunch takes half the row, no words on top of each other.
  for (const [name, span] of fixed) {
    const [x, y] = span.split("-");
    if (!x || !y || mins(y) <= mins(x)) continue;
    items.push({ a: mins(x), b: mins(y), html: (lane, lanes) => piece(mins(x), mins(y), "fix", () => `title="${name} ${x}–${y}"`, (p) => (p.first ? `<span class="t">${name}</span>` : ""), lane, lanes) });
  }
  for (const r of ctx.s.routines.filter((x) => routineOn(x, k))) {
    const a = mins(r.at);
    const b = r.end && mins(r.end) > a ? mins(r.end) : a + 10;
    const dn = r.done.includes(k);
    items.push({ a, b, html: (lane, lanes) => piece(a, b, `rt ${dn ? "dn" : ""}`, () => `data-rt="${r.id}" role="checkbox" aria-checked="${dn}" title="${esc(`루틴 ${r.at}${r.end ? `–${r.end}` : ""} · ${repeatLabel(r)}${streak(r, k) ? ` · ${streak(r, k)}일째` : ""} · 누르면 ${dn ? "안 함으로" : "오늘 함"}`)}"`, (p) => (p.first ? `<span class="t">${esc(r.title)}${dn ? " ✓" : ""}</span>` : ""), lane, lanes) });
  }
  // Lanes per cluster of overlapping items (a lone item keeps the whole row).
  items.sort((x, y) => x.a - y.a);
  let ci = 0;
  while (ci < items.length) {
    let end = items[ci].b;
    let cj = ci + 1;
    while (cj < items.length && items[cj].a < end) end = Math.max(end, items[cj++].b);
    const lanes: number[] = [];
    const lane = items.slice(ci, cj).map((it) => {
      let l = lanes.findIndex((b) => b <= it.a);
      if (l < 0) l = lanes.push(0) - 1;
      lanes[l] = it.b;
      return l;
    });
    items.slice(ci, cj).forEach((it, i) => (h += it.html(lane[i], lanes.length)));
    ci = cj;
  }
  if (nowM >= S && nowM < E) h += `<div class="nowl" style="top:${((Math.floor(nowM / 60) - S / 60) / rows) * 100}%;height:${100 / rows}%;left:${((nowM % 60) / 60) * 100}%"><span>${hhmm(nowM)}</span></div>`;
  let grid = "";
  for (let H = S / 60; H < E / 60; H++) grid += `<div class="hrow"><span class="hl">${String(H).padStart(2, "0")}:00</span>${"<i></i>".repeat(6)}</div>`;
  const dups = duplicates(ctx.s).filter((d) => d.x.kind === "event" && d.x.date === k);
  return `<div class="dt panel g">
    <div class="dta">${allDay.map((e) => `<span class="chip ${e.provisional ? "prov" : ""}" data-ev="${e.id}">종일 · ${esc(e.title)}</span>`).join("")}${dups.length ? `<button class="warnlink" data-checks>같은 일정 ${dups.length + 1}개 · 합치기</button>` : ""}<span class="mode"><button data-dr="work" class="${o.range === "work" ? "on" : ""}" title="07:00–18:00">07–18</button><button data-dr="all" class="${o.range === "all" ? "on" : ""}" title="07:00–21:00 · 야근하는 날">07–21 야근</button></span></div>
    <div class="dtgw"><div class="dhd"><span></span><span>:00</span><span>:10</span><span>:20</span><span>:30</span><span>:40</span><span>:50</span></div>
      <div class="dtg" data-dtg="${k}" data-s="${S}" data-e="${E}" style="--rows:${rows}">${grid}<div class="dly" data-dtc title="끌면 새 일정 · 할 일을 끌어 놓으면 작업 시간 (5분 단위)">${h}</div></div></div>
  </div>`;
}

function stepRows(t: Task, n: number, open: boolean): string {
  if (!t.subs.length || !open) return "";
  const next = t.subs.findIndex((x) => !x.done);
  return `<div class="steps">${t.subs.map((x, j) => `<div class="step ${x.done ? "done" : ""} ${j === next ? "next" : ""}"><span class="n">${n}-${j + 1}</span><span class="ck ${x.done ? "on" : ""}" data-sub="${t.id}:${j}" role="checkbox" aria-checked="${x.done}" tabindex="0"></span><span class="s">${esc(x.title)}${x.ai ? '<span class="aisug" title="원문에 없던 단계 · AI가 제안">AI 제안</span>' : ""}<button class="subout" data-subout="${t.id}:${j}" title="따로 떼어 할 일 하나로">따로 떼기</button></span>${j === next ? '<span class="tag">다음</span>' : "<span></span>"}</div>`).join("")}<input class="subadd on" data-subadd="${t.id}" placeholder="+ 단계 추가" aria-label="${esc(t.title)} 단계 추가"></div>`;
}

export function starBtn(x: Entry): string {
  const v = x.star ?? 0;
  const hint = !v && x.starHint ? ` hint` : "";
  return `<button class="star s${v}${hint}" data-star="${x.id}" title="${v === 0 ? (x.starHint ? "AI 제안: 중요 · 누르면 ★" : "중요 표시(누를 때마다 ☆ → ★ → ★)") : v === 1 ? "중요 · 한 번 더 누르면 매우 중요" : "매우 중요 · 누르면 해제"}" aria-label="중요도 ${v}">${v === 0 && x.starHint ? "☆" : STAR[v]}</button>`;
}

export function taskList(ctx: Ctx, k: string, o: TodayOpts, fd: (k: string) => string): string {
  const off = ctx.s.settings.offWork;
  const { today, later, undated, done, num } = orderedTasks(ctx.s, k === ctx.today ? ctx.today : k, ctx.now);
  const all = [...today, ...later, ...undated];
  const count = (b: Bucket) => all.filter((t) => bucketOf(t, ctx.now, ctx.s) === b).length;
  const pass = (t: Task) => o.filter === "all" || bucketOf(t, ctx.now, ctx.s) === o.filter;
  const row = (t: Task) => {
    const n = num.get(t.id)!;
    const sd = t.subs.filter((x) => x.done).length;
    const open = !!ctx.open?.has(`subs:${t.id}`);
    // 작업 시간 already set for it (the first one still ahead).
    const work = liveEvents(ctx.s).filter((e) => e.workFor === t.id && e.start && `${e.date}T${e.end ?? e.start}` >= `${ctx.today}T${hhmm(ctx.nowM)}`).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))[0];
    const lv = urgency(t, ctx.now, ctx.s);
    const by = lv === 1 || lv === 2 ? startBy(t, ctx.s, fd, ctx.today) : "";
    const tip = t.noDue ? "기한 정하기" : `${fd(t.due)}${t.dueTime ? " " + t.dueTime : ""}까지 · 걸리는 시간 ${effortName(effortOf(t))}${by ? ` · ${by}` : ""} · 눌러서 기한 다시 정하기`;
    return `<div class="task ${ctx.sel?.has(t.id) ? "sel" : ""}" data-ev="${t.id}" data-task="${t.id}" data-num="${n}" tabindex="0" aria-label="${esc(t.title)} 열기" title="⌘+클릭으로 여러 개 고르기 · 다른 할 일 위에 끌어 놓으면 묶기">
      <span class="no" data-num="${n}">${n}</span><span class="ck" data-tdone="${t.id}" role="checkbox" aria-checked="false" tabindex="0" aria-label="${esc(t.title)} 완료"></span>${starBtn(t)}
      <span class="tn ${t.star === 2 ? "s2b" : ""}">${esc(t.title)}${t.draft ? '<span class="dr">초안</span>' : ""}${t.wait ? `<span class="wait" title="먼저 있어야 할 일">기다림 · ${esc(t.wait)}</span>` : ""}${t.subs.length ? `<button class="pg" data-subs="${t.id}" aria-expanded="${open}">${sd}/${t.subs.length} ${open ? "▾" : "▸"}</button>` : `<button class="pg add" data-subs="${t.id}" title="단계 추가">+</button>`}</span>
      <span class="wk">${work ? `<span title="작업 시간 ${esc(`${fd(work.date)} ${work.start}–${work.end ?? ""}`)}">⏱ ${work.date === ctx.today ? "" : fd(work.date) + " "}${work.start}</span>` : ""}</span><button class="rem R${lv} ${t.noDue ? "none" : ""}" data-rem="${t.id}" title="${esc(tip)}">${t.noDue ? "+ 기한" : remainText(t, ctx.now, off)}</button></div>${stepRows(t, n, open)}`;
  };
  const chip = (key: TodayOpts["filter"], name: string, c: number) => `<button class="${o.filter === key ? "on" : ""}" data-tf="${key}">${name}<b>${c}</b></button>`;
  const t1 = today.filter(pass);
  const t2 = later.filter(pass);
  const t3 = undated.filter(pass);
  const d = parseDay(k);
  return `<div class="tl panel g">
    <div class="ph"><b>할 일</b><span>번호 = 하루표의 번호${done.length ? ` · 완료 ${done.length}` : ""}</span></div>
    <div class="sum">${chip("all", "전체", all.length)}${chip("now", "지금 할 것", count("now"))}${chip("urgent", "급함", count("urgent"))}${chip("imp", "중요", count("imp"))}${chip("rest", "나머지", count("rest"))}</div>
    ${all.length === 0 ? '<div class="none">없음 · 「금요일까지 보고서」처럼 쓰면 들어갑니다</div>' : ""}
    ${t1.length ? `<div class="grp">오늘 ${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})<span>${t1.length}</span></div>${t1.map(row).join("")}` : ""}
    ${t2.length ? `<div class="grp later">나중<span>${t2.length}</span></div><div class="laterl">${t2.map(row).join("")}</div>` : ""}
    ${t3.length ? `<div class="grp later">날짜 없는 할 일<span>${t3.length}</span></div><div class="laterl">${t3.map(row).join("")}</div>` : ""}
    ${(ctx.sel?.size ?? 0) >= 2 ? `<div class="mbar"><b>${ctx.sel!.size}개 고름</b><button data-selclear>취소</button><button class="pri" data-mergeopen>하나로 묶기</button></div>` : (ctx.sel?.size ?? 0) === 1 ? '<div class="mbar hint">⌘+클릭으로 묶을 할 일을 더 고르세요<button data-selclear>취소</button></div>' : ""}
    ${done.length ? `<details class="fold" data-fold="done" ${ctx.open?.has("done") ? "open" : ""}><summary>완료 ${done.length}</summary>${ctx.open?.has("done") ? done.map((t) => `<div class="task done" data-ev="${t.id}"><span></span><span class="ck on" data-tdone="${t.id}" role="checkbox" aria-checked="true" tabindex="0"></span><span></span><span class="tn">${esc(t.title)}</span><span class="due"></span></div>`).join("") : ""}</details>` : ""}
  </div>`;
}

/** Text width at 12px (canvas when there is one; otherwise Hangul 1em, digits and Latin about .6em). */
let measure: CanvasRenderingContext2D | null | undefined;
function textW(s: string): number {
  if (measure === undefined) {
    try {
      measure = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
      if (measure) measure.font = '600 12px -apple-system, "Apple SD Gothic Neo", sans-serif';
    } catch {
      measure = null;
    }
  }
  if (measure) return measure.measureText(s).width;
  return [...s].reduce((n, c) => n + (/[ㄱ-힝]/.test(c) ? 12 : c === " " ? 3.5 : 7), 0);
}

/**
 * 다가오는 주요 일정 띠 (11-02 사용자 시안 10 「가. 계단」, 고침): today → 30 · 60 · 120 days on one line,
 * each entry at its day. A name goes on the bottom row; only when it would touch the one before it does
 * it go a row up (3 rows at most). A name is at most 6 letters (+…); with no room on any row the D-day
 * goes first, then letters (3 at least). Full name and date on hover.
 * `stars`: which ★ to show — 1 노랑만 · 2 빨강만 · "all" 둘 다 (and the periods without a ★).
 */
export type StarPick = 1 | 2 | "all";
export function upcomingBand(ctx: Ctx, k: string, fd: (k: string) => string, range: 30 | 60 | 120 = 60, W = 560, stars: StarPick = "all"): { html: string; shown: number; later: number } {
  const all = upcoming(ctx.s, k, fd).filter((u) => stars === "all" || u.star === stars);
  const items = all.filter((u) => u.days <= range).slice(0, UPCOMING_MAX);
  const later = all.length - items.length;
  const LH = 18;
  const px = (d: number) => (Math.min(d, range) / range) * W;
  const pct = (d: number) => `${((Math.min(d, range) / range) * 100).toFixed(3)}%`;
  // Names above the line (★ + 짧은 이름 or the first 6 letters); D-day and date under it (11-02 사용자).
  // Each goes on the lowest row where it does not touch the one before it (3 rows above, 2 under).
  type Placed = { u: Upcoming; lane: number; name: string; flip: boolean; under: number; hide?: boolean };
  const free = (r: [number, number][], [a, b]: [number, number]) => r.every(([p, q]) => b + 4 <= p || a >= q + 4);
  const above: [number, number][][] = [[], [], []];
  const below: [number, number][][] = [[], []];
  const placed: Placed[] = [];
  const md = (k: string) => `${+k.slice(5, 7)}/${+k.slice(8, 10)}`;
  for (const u of items) {
    const x = px(u.days);
    const star = u.star ? 14 : 0;
    const base = u.short?.trim() || u.title;
    let name = base.length > 6 ? `${base.slice(0, 6)}…` : base;
    const w = textW(name) + star + 10;
    const flip = x + w > W && x > W / 2;
    const span = (n: number): [number, number] => (flip ? [x - n, x] : [x, x + n]);
    let lane = above.findIndex((r) => free(r, span(w)));
    if (lane < 0) {
      // No row has room: the row with the most room, then fewer letters (3 at least).
      // A name already over this spot leaves no room in that row (11-04: they were counted as room, names piled up).
      const roomIn = (r: [number, number][]) => (r.some(([p, q]) => p - 4 < x && x < q + 4) ? 0 : flip ? x - Math.max(0, ...r.filter(([, q]) => q <= x).map(([, q]) => q + 6)) : Math.min(W, ...r.filter(([p]) => p >= x).map(([p]) => p - 6)) - x);
      lane = [0, 1, 2].reduce((best, l) => (roomIn(above[l]) > roomIn(above[best]) ? l : best), 0);
      const room = roomIn(above[lane]);
      while (name.replace("…", "").length > 3 && textW(name) + star + 10 > room) name = `${name.replace("…", "").slice(0, -1)}…`;
      // Still no room even with 3 letters: the name hides; it goes into a 「+n」 with its neighbours (11-04).
      if (textW(name) + star + 10 > room) {
        placed.push({ u, lane: 0, name, flip, under: -1, hide: true });
        continue;
      }
    }
    above[lane].push(span(textW(name) + star + 10));
    const uw = textW(`D-${u.days} ${md(u.date)}`) * 0.85 + 6;
    const us: [number, number] = [x - uw / 2, x + uw / 2];
    // D-day under the line only where it fits (else on hover, as the hidden names).
    const under = below.findIndex((r) => free(r, us));
    if (under >= 0) below[under].push(us);
    placed.push({ u, lane, name, flip, under });
  }
  // Hidden names close together: one 「+n」 on the lowest row with room (its hover lists them).
  const groups: Placed[][] = [];
  for (const p of placed.filter((q) => q.hide)) {
    const g = groups[groups.length - 1];
    if (g && px(p.u.days) - px(g[0].u.days) < 40) g.push(p);
    else groups.push([p]);
  }
  const plus = groups.map((g) => {
    const w = textW(`+${g.length}`) + 12;
    // Right after the name already there, on the row that frees up first (never on top of a name).
    const at = (r: [number, number][]) => Math.max(px(g[0].u.days), ...r.filter(([p]) => p <= px(g[0].u.days) + w).map(([, q]) => q + 6));
    const lane = [0, 1, 2].reduce((best, l) => (at(above[l]) < at(above[best]) ? l : best), 0);
    const x = Math.min(at(above[lane]), W - w);
    above[lane].push([x, x + w]);
    return { g, x, lane };
  });
  const lanes = Math.max(1, ...placed.filter((p) => !p.hide).map((p) => p.lane + 1), ...plus.map((p) => p.lane + 1));
  const unders = Math.max(1, ...placed.map((p) => p.under + 1));
  const axY = lanes * LH + 8;
  // 「오늘」 on the line's start (under it are the D-days).
  let h = `<div class="bax" style="top:${axY}px"></div><span class="btk m td" style="left:0;top:${axY - 7}px">오늘</span>`;
  const t0 = parseDay(k);
  // Months sit on the line itself (the space under it is the D-days').
  for (let d = 1; d < range; d++) {
    const dt = addDays(t0, d);
    if (dt.getDate() === 1 && px(d) > 24 && px(d) < W - 24) h += `<span class="btk m" style="left:${pct(d)};top:${axY - 7}px">${dt.getMonth() + 1}월</span>`;
  }
  for (const { u, lane, name, flip, under, hide } of placed) {
    const tip = esc(`${u.title} · ${u.when} · D-${u.days}`);
    h += u.endDays !== undefined && u.endDays > u.days
      ? `<i class="bpr" data-ev="${u.id}" title="${tip}" style="left:${pct(u.days)};width:max(5px, ${(((Math.min(u.endDays, range) - u.days) / range) * 100).toFixed(3)}%);top:${axY}px"></i>`
      : `<i class="bdot" data-ev="${u.id}" title="${tip}" style="left:${pct(u.days)};top:${axY}px"></i>`;
    if (hide) continue;
    const top = (lanes - 1 - lane) * LH;
    h += `<i class="bstem" style="left:${pct(u.days)};top:${top + LH}px;height:${axY - top - LH}px"></i>`;
    h += `<span class="blb ${flip ? "fl" : ""}" data-ev="${u.id}" title="${tip}" style="${flip ? `right:${(100 - (px(u.days) / W) * 100).toFixed(3)}%` : `left:${pct(u.days)}`};top:${top}px">${u.star ? `<span class="star s${u.star}">★</span>` : ""}<b>${esc(name)}</b></span>`;
    if (under >= 0) h += `<span class="bdd ${u.days <= 7 ? "soon" : ""}" data-ev="${u.id}" title="${tip}" style="left:${pct(u.days)};top:${axY + 6 + under * 14}px"><b>D-${u.days}</b> ${md(u.date)}</span>`;
  }
  for (const { g, x, lane } of plus) {
    const top = (lanes - 1 - lane) * LH;
    const tip = esc(g.map((p) => `${p.u.star ? "★ " : ""}${p.u.title} · D-${p.u.days} ${md(p.u.date)}`).join("\n"));
    h += `<span class="blb bplus" data-ev="${g[0].u.id}" title="${tip}" style="left:${((x / W) * 100).toFixed(3)}%;top:${top}px"><b>+${g.length}</b></span>`;
  }
  return { html: `<div class="band" style="height:${axY + 8 + unders * 14 + 6}px">${h}</div>`, shown: items.length, later };

}

export function rightStack(ctx: Ctx, k: string, fd: (k: string) => string, o?: Pick<TodayOpts, "upRange" | "bandW" | "upStars">): string {
  const range = o?.upRange ?? 60;
  const stars = o?.upStars ?? "all";
  // D-day from the real today, whatever day is shown (11-02: 11/7을 보면 11/8이 D-1로 나오던 것).
  const b = upcomingBand(ctx, ctx.today ?? k, fd, range, o?.bandW ?? 560, stars);
  const pick = (v: StarPick, label: string, cls: string) => `<button class="${v === stars ? "on" : ""}" data-upstars="${v}" title="${label}"><span class="star ${cls}">★</span></button>`;
  return `<div class="rstack">
    <div class="panel g ups ${b.shown ? "" : "empty"}"><div class="ph"><b>다가오는 주요 일정</b><span class="useg stars">${pick(1, "노랑 ★만", "s1")}${pick(2, "빨강 ★만", "s2")}${pick("all", "노랑·빨강 둘 다", "half")}</span><span class="useg">${b.later ? `<button class="ulater" data-uprange="120" title="120일로 넓히기">그 뒤 ${b.later}개</button>` : ""}${([30, 60, 120] as const).map((v) => `<button class="${v === range ? "on" : ""}" data-uprange="${v}">${v}일</button>`).join("")}</span></div>
      ${b.shown ? b.html : `<div class="none">${range}일 안에 ${stars === 1 ? "노랑 ★" : stars === 2 ? "빨강 ★" : "★ 표시한"} 일정·할 일이 없어요</div>`}</div>
  </div>`;
}

export function todayView(ctx: Ctx, o: TodayOpts, fd: (k: string) => string, checks: string): string {
  const k = ymd(ctx.cur);
  const { num } = orderedTasks(ctx.s, k === ctx.today ? ctx.today : k, ctx.now);
  return `<div class="tdv">
    ${checks}
    <div class="tgrid">${dayTable(ctx, k, o, num, fd)}${taskList(ctx, k, o, fd)}${rightStack(ctx, k, fd, o)}</div>
  </div>`;
}

/** 우선순위 (2×2): ① 지금 할 것 ② 계획할 것 ③ 빨리 처리할 것 ④ 나중에; drag between them. */
export function priorityView(ctx: Ctx, fd: (k: string) => string): string {
  const off = ctx.s.settings.offWork;
  const { today, later, undated } = orderedTasks(ctx.s, ctx.today, ctx.now);
  const open = [...today, ...later, ...undated];
  const q: [Bucket, string, string][] = [["now", "① 지금 할 것", "중요 · 급함"], ["imp", "② 계획할 것", "중요 · 여유"], ["urgent", "③ 빨리 처리할 것", "보통 · 급함"], ["rest", "④ 나중에", "보통 · 여유"]];
  const item = (t: Task) => `<div class="mq" draggable="true" data-task="${t.id}" data-ev="${t.id}">${starBtn(t)}<span class="tn ${t.star === 2 ? "s2b" : ""}">${esc(t.title)}</span><span class="due ${isUrgent(t, ctx.now, ctx.s) ? "urg" : ""}">${dueText(t, ctx.now, ctx.today, fd, off)}</span></div>`;
  const quad = ([k, n, d]: [Bucket, string, string]) => {
    const rows = open.filter((t) => bucketOf(t, ctx.now, ctx.s) === k);
    return `<div class="panel g quad" data-quad="${k}"><h4>${n}<span>${d} · ${rows.length}</span></h4>${rows.map(item).join("") || '<div class="none">없음</div>'}</div>`;
  };
  return `<div class="matrix"><span></span><div class="mh">급함 · 6시간 안 (마감 따라 자동)</div><div class="mh">여유</div>
    <div class="mr">중요<br><span class="s1">★</span> <span class="s2">★</span></div>${quad(q[0])}${quad(q[1])}
    <div class="mr">보통<br><span class="s0">☆</span></div>${quad(q[2])}${quad(q[3])}</div>`;
}


/* ---------- 휴대폰 「오늘」 (시안 가, 2026-10-27): 지금·다음 → 할 일 → 오늘 일정 → 주요 일정, 하루표는 펼쳐서 ---------- */

/** The next appointment or deadline after now (a week ahead at most). Also the widget's 「다음」. */
export function nextUp(s: CalendarState, now: Date): { at: Date; label: string; title: string; id: string } | null {
  const list: { at: Date; title: string; id: string }[] = [];
  for (const e of liveEvents(s)) if (e.start && !e.workFor) list.push({ at: new Date(`${e.date}T${e.start}`), title: e.title, id: e.id });
  for (const x of liveTasks(s)) if (!x.done && !x.noDue && x.dueTime) list.push({ at: new Date(`${x.due}T${x.dueTime}`), title: x.title, id: x.id });
  const n = list.filter((x) => x.at > now && x.at.getTime() - now.getTime() < 7 * 864e5).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!n) return null;
  const k = ymd(n.at);
  const hm = `${String(n.at.getHours()).padStart(2, "0")}:${String(n.at.getMinutes()).padStart(2, "0")}`;
  const d = parseDay(k);
  return { ...n, label: k === ymd(now) ? hm : k === ymd(addDays(now, 1)) ? `내일 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}` };
}

/** 「20분 뒤」 「12시간 뒤」 「2일 뒤」 */
export function untilText(now: Date, at: Date): string {
  const m = Math.round((at.getTime() - now.getTime()) / 60000);
  return m >= 1440 ? `${Math.floor(m / 1440)}일 뒤` : m >= 60 ? `${Math.floor(m / 60)}시간 뒤` : `${Math.max(1, m)}분 뒤`;
}

export function phoneToday(ctx: Ctx, o: TodayOpts, fd: (k: string) => string): string {
  const k = ymd(ctx.cur);
  const isToday = k === ctx.today;
  const off = ctx.s.settings.offWork;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const nx = isToday ? nextUp(ctx.s, ctx.now) : null;
  const ord0 = orderedTasks(ctx.s, k, ctx.now);
  // Phone: 날짜 없음 sits at the end of the folded 「나중」 list.
  const ord = { ...ord0, later: [...ord0.later, ...ord0.undated] };
  const open = (key: string) => !!ctx.open?.has(key);
  const trow = (t: Task) => {
    const n = ord.num.get(t.id);
    const urg = isUrgent(t, ctx.now, ctx.s);
    const due = dueText(t, ctx.now, ctx.today, fd, off);
    const [left, right] = t.dueTime && t.due <= k ? [t.dueTime, due.split(" · ")[1] ?? ""] : [t.noDue ? "—" : t.due === k ? "오늘" : `${parseDay(t.due).getMonth() + 1}/${parseDay(t.due).getDate()}`, t.noDue ? "날짜 없음" : ""];
    return `<div class="prow" data-ev="${t.id}"><span class="tm ${urg ? "b" : ""}">${left}</span><span class="tn"><span class="ck" data-tdone="${t.id}" role="checkbox" aria-checked="false" tabindex="0" aria-label="${esc(t.title)} 완료"></span><span class="no">${n ?? ""}</span>${t.star ? `<span class="star s${t.star}">★</span> ` : ""}${esc(t.title)}${t.wait ? ` <i class="x">기다림 · ${esc(t.wait)}</i>` : ""}${t.subs.length ? ` <i class="x">${t.subs.filter((x) => x.done).length}/${t.subs.length}</i>` : ""}</span><span class="x ${urg ? "b" : ""}">${right}</span></div>`;
  };
  // Today's appointments and 루틴 in time order (routines tap to check).
  const hm = `${p2(ctx.now.getHours())}:${p2(ctx.now.getMinutes())}`;
  // The same title at the same time twice (a duplicate) shows once with ×2.
  const seen = new Map<string, { e: CalEvent; n: number }>();
  for (const e of eventsOn(ctx.s, k).filter((x) => !x.workFor).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))) {
    const key = `${e.title}|${e.start ?? ""}|${e.end ?? ""}`;
    const v = seen.get(key);
    if (v) v.n++;
    else seen.set(key, { e, n: 1 });
  }
  const evs = [...seen.values()].map((x) => x.e);
  const times = (e: CalEvent) => seen.get(`${e.title}|${e.start ?? ""}|${e.end ?? ""}`)!.n;
  const rts = ctx.s.routines.filter((r) => routineOn(r, k));
  const items = [
    ...evs.map((e) => ({ at: e.start ?? "", html: `<div class="prow ${isToday && (e.end ? e.end <= hm : !!e.start && e.start < hm) ? "past" : ""}" data-ev="${e.id}"><span class="tm">${e.start ?? "종일"}</span><span class="tn">${esc(e.title)}${times(e) > 1 ? ` <i class="x">×${times(e)}</i>` : ""}${e.provisional ? '<span class="ga">가</span>' : ""}</span><span class="x">${e.end && e.start ? `~${e.end}` : ""}</span></div>` })),
    ...rts.map((r) => ({ at: r.at, html: `<div class="prow rt ${r.done.includes(k) ? "past" : ""}"><span class="tm">${r.at}</span><span class="tn"><button class="rtb" data-rt="${r.id}" role="checkbox" aria-checked="${r.done.includes(k)}">${esc(r.title)}${r.done.includes(k) ? " ✓" : ""}</button></span><span class="x">루틴</span></div>` }))
  ].sort((a, b) => a.at.localeCompare(b.at));
  const ups = upcoming(ctx.s, k, fd).slice(0, 4);
  const card = (icon: string, title: string, count: string, body: string) =>
    `<section class="pcard"><div class="pch"><i>${icon}</i>${title}${count ? `<span class="c">${count}</span>` : ""}</div>${body}</section>`;
  return `<div class="phv">
    ${isToday ? `<section class="pcard pnow"><div class="pnx"><span class="clk">${p2(ctx.now.getHours())}:${p2(ctx.now.getMinutes())}</span><span class="l">${nx ? `다음 · ${untilText(ctx.now, nx.at)}` : "일주일 안에 정해진 것 없음"}</span></div>${nx ? `<div class="pnt" data-ev="${nx.id}"><b>${nx.label}</b> ${esc(nx.title)}</div>` : ""}</section>` : ""}
    ${card("☑", "할 일", `${ord.today.length + ord.later.length} 남음`, `${ord.today.map(trow).join("") || '<div class="none">오늘 할 일 없음</div>'}
      ${ord.later.length || ord.done.length ? `<button class="pmore" data-fold="phlater" aria-expanded="${open("phlater")}">나중 ${ord.later.length}${ord.done.length ? ` · 완료 ${ord.done.length}` : ""} ${open("phlater") ? "▴" : "▾"}</button>` : ""}
      ${open("phlater") ? `<div class="plater">${ord.later.map(trow).join("")}</div>` : ""}`)}
    ${card("▦", isToday ? "오늘 일정" : `${fd(k)} 일정`, String(evs.length), `${items.map((x) => x.html).join("") || '<div class="none">일정 없음</div>'}
      <button class="pmore" data-fold="phtable" aria-expanded="${open("phtable")}">하루표로 보기 ${open("phtable") ? "▴" : "▾"}</button>`)}
    ${open("phtable") ? `<div class="tdv phtable">${dayTable(ctx, k, o, ord.num, fd)}</div>` : ""}
    ${ups.length ? card("★", "다가오는 주요 일정", "", ups.map((u) => `<div class="prow" data-ev="${u.id}"><span class="tm">${esc(u.when.split(/[ (]/)[0])}</span><span class="tn"><span class="star s${u.star || 1}">★</span> ${esc(u.title)}</span><span class="dd ${u.days <= 7 ? "soon" : ""}">D-${u.days}</span></div>`).join("")) : ""}
  </div>`;
}
