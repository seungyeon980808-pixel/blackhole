/**
 * 「오늘(일) 화면」 (user-approved plan, mockups today-v3 · today-priority, 2026-10-27):
 *   [vertical day table ≈1.35fr] [to-dos ≈1fr] [upcoming + 루틴 290px]  (+ the chat panel)
 * Colours: only the star's yellow and red; everything else is light-on-glass (or ink on paper).
 * Times are 24-hour. Shared by both themes (they paint the classes) and the phone (stacked).
 */
import { addDays, DOW, mins, parseDay, ymd } from "../dates";
import type { CalendarState, Entry, Routine, Task } from "../model";
import { dueOn, eventsOn, liveEvents, livePeriods, liveTasks } from "../store";
import { duplicates, esc, type Ctx } from "./common";

export const URGENT_MIN = 6 * 60;
const STAR = ["☆", "★", "★"];

/* ---------- rules (pure) ---------- */

/** Minutes from now to the deadline (negative = passed). A day-only deadline ends at 퇴근. */
export function minsLeft(t: Task, now: Date, offWork = "16:20"): number {
  const d = parseDay(t.due);
  const [h, m] = (t.dueTime ?? offWork).split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 60000);
}

/** 급함: the deadline is within 6 hours (or passed). Decided by the clock, never by hand. */
export const isUrgent = (t: Task, now: Date, offWork?: string): boolean => !t.noDue && minsLeft(t, now, offWork) <= URGENT_MIN;

export type Bucket = "now" | "urgent" | "imp" | "rest";
export function bucketOf(t: Task, now: Date, offWork?: string): Bucket {
  const u = isUrgent(t, now, offWork);
  const i = (t.star ?? 0) > 0;
  return u && i ? "now" : u ? "urgent" : i ? "imp" : "rest";
}

/**
 * The to-do list in order, with its numbers: 오늘 (due today or passed) by 급함 → ★ → deadline,
 * then 나중 by date. The number is the same in the list and on the day table.
 */
export function orderedTasks(s: CalendarState, today: string, now: Date): { today: Task[]; later: Task[]; done: Task[]; num: Map<string, number> } {
  const off = s.settings.offWork;
  const live = liveTasks(s);
  const open = live.filter((t) => !t.done);
  const isToday = (t: Task) => !t.noDue && t.due <= today;
  const byUrgency = (a: Task, b: Task) =>
    Number(isUrgent(b, now, off)) - Number(isUrgent(a, now, off)) || (b.star ?? 0) - (a.star ?? 0) || minsLeft(a, now, off) - minsLeft(b, now, off);
  const t = open.filter(isToday).sort(byUrgency);
  const later = open.filter((x) => !isToday(x)).sort((a, b) => (a.noDue ? "9" : a.due + (a.dueTime ?? "99")).localeCompare(b.noDue ? "9" : b.due + (b.dueTime ?? "99")) || (b.star ?? 0) - (a.star ?? 0));
  const num = new Map<string, number>();
  [...t, ...later].forEach((x, i) => num.set(x.id, i + 1));
  const done = live.filter((x) => x.done && x.due === today);
  return { today: t, later, done, num };
}

/** 「2시간 33분」 */
export function dur(n: number): string {
  const a = Math.abs(n);
  return a >= 60 ? `${Math.floor(a / 60)}시간${a % 60 ? ` ${a % 60}분` : ""}` : `${a}분`;
}

export function dueText(t: Task, now: Date, today: string, fd: (k: string) => string, offWork?: string): string {
  if (t.noDue) return "마감 없음";
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
  star: number;
  days: number;
  when: string;
  steps?: [number, number];
}

/** 다가오는 주요 일정 (30 days): starred appointments and deadlines, and periods, by D-day. */
export function upcoming(s: CalendarState, today: string, fd: (k: string) => string): Upcoming[] {
  const until = ymd(addDays(parseDay(today), 30));
  const out: Upcoming[] = [];
  const days = (k: string) => Math.round((parseDay(k).getTime() - parseDay(today).getTime()) / 864e5);
  for (const e of liveEvents(s)) {
    if (e.workFor || !(e.star ?? 0) || e.date <= today || e.date > until) continue;
    out.push({ id: e.id, title: e.title, star: e.star ?? 0, days: days(e.date), when: `${fd(e.date)}${e.start ? ` ${e.start}${e.end ? "–" + e.end : ""}` : ""}${e.details ? ` · ${e.details}` : ""}` });
  }
  for (const t of liveTasks(s)) {
    if (t.done || t.noDue || !(t.star ?? 0) || t.due <= today || t.due > until) continue;
    out.push({ id: t.id, title: t.title, star: t.star ?? 0, days: days(t.due), when: `${fd(t.due)}${t.dueTime ? " " + t.dueTime : ""}까지`, steps: t.subs.length ? [t.subs.filter((x) => x.done).length, t.subs.length] : undefined });
  }
  for (const p of livePeriods(s)) {
    if (p.from <= today || p.from > until) continue;
    out.push({ id: p.id, title: p.title, star: p.star ?? 0, days: days(p.from), when: `${fd(p.from)}–${fd(p.to)}` });
  }
  return out.sort((a, b) => a.days - b.days || b.star - a.star);
}

/* ---------- view ---------- */

export interface TodayOpts {
  /** "work" 08–17 (fills the table) · "all" 00–24 */
  range: "work" | "all";
  /** to-do filter chip */
  filter: "all" | Bucket;
}

const pct = (m: number, S: number, E: number) => `${(((m - S) / (E - S)) * 100).toFixed(3)}%`;

/** 이번 주 날짜 줄: Mon–Sun with how many things; drop targets for moving to another day. */
export function weekStrip(ctx: Ctx, k: string): string {
  const d = parseDay(k);
  const mon = addDays(d, -((d.getDay() + 6) % 7));
  return `<div class="wkd" role="list">${Array.from({ length: 7 }, (_, i) => {
    const x = ymd(addDays(mon, i));
    const n = eventsOn(ctx.s, x).filter((e) => !e.workFor).length + dueOn(ctx.s, x).filter((t) => !t.done).length;
    const dd = parseDay(x);
    return `<button class="wd ${x === k ? "on" : ""} ${x === ctx.today ? "td" : ""}" data-wd="${x}" role="listitem" title="${dd.getMonth() + 1}/${dd.getDate()} · ${n}건 · 끌어 놓으면 이날로">${DOW[dd.getDay()]} ${dd.getDate()}${n ? `<small>${n}</small>` : ""}</button>`;
  }).join("")}</div>`;
}

export function dayTable(ctx: Ctx, k: string, o: TodayOpts, num: Map<string, number>, fd: (k: string) => string): string {
  const st = ctx.s.settings;
  const [S, E] = o.range === "work" ? [8 * 60, 17 * 60] : [0, 24 * 60];
  const y = (m: number) => pct(Math.max(S, Math.min(E, m)), S, E);
  const evs = eventsOn(ctx.s, k);
  const allDay = evs.filter((e) => !e.start);
  const timed = evs.filter((e) => e.start);
  const step = o.range === "work" ? 1 : 2;
  let h = "";
  for (let H = S / 60; H <= E / 60; H += step) h += `<div class="hr" style="top:${y(H * 60)}"><span>${String(H).padStart(2, "0")}:00</span></div>`;
  const wd = parseDay(k).getDay();
  const school = wd >= 1 && wd <= 5;
  if (school && st.showPeriods) {
    st.periods.forEach((p, i) => {
      const [a, b] = p.split("-");
      if (a && b && mins(b) > S && mins(a) < E) h += `<div class="per" style="top:${y(mins(a))};height:calc(${y(mins(b))} - ${y(mins(a))})" title="${i + 1}교시 ${a}–${b}"><b>${i + 1}</b></div>`;
    });
    const [l0, l1] = st.lunch.split("-");
    if (l0 && l1) h += `<div class="lunch" style="top:${y(mins(l0))};height:calc(${y(mins(l1))} - ${y(mins(l0))})"><b>점심</b></div>`;
  }
  if (mins(st.onWork) > S) h += `<div class="off" style="top:0;height:${y(mins(st.onWork))}"></div>`;
  if (mins(st.offWork) < E) h += `<div class="off" style="top:${y(mins(st.offWork))};bottom:0"></div>`;
  // Appointments: boxes in as few lanes as needed, in the left part (deadline marks on the right).
  const lanes: number[] = [];
  const placed = timed
    .map((e) => ({ e, a: mins(e.start!), b: e.end ? mins(e.end) : mins(e.start!) + (st.eventMinutes || 60) }))
    .sort((p, q) => p.a - q.a)
    .map((p) => {
      let lane = lanes.findIndex((end) => end <= p.a);
      if (lane < 0) lane = lanes.push(0) - 1;
      lanes[lane] = p.b;
      return { ...p, lane };
    });
  const L = Math.max(1, lanes.length);
  const nowM = k === ctx.today ? ctx.nowM : -1;
  for (const { e, a, b, lane } of placed) {
    if (b <= S || a >= E) continue;
    const work = e.workFor ? num.get(e.workFor) : undefined;
    h += `<div class="ev ${e.provisional ? "prov" : ""} ${nowM >= 0 && b <= nowM ? "past" : ""} ${e.workFor ? "work" : ""} ${e.end ? "" : "noend"}" data-ev="${e.id}" data-evbox="${e.id}" draggable="false" style="top:${y(a)};height:max(20px, calc(${y(b)} - ${y(a)}));left:calc(${((lane / L) * 54).toFixed(2)}% + 4px);width:calc(${(54 / L).toFixed(2)}% - 6px)">
      <div class="t">${work ? `<span class="no">${work}</span> 작업 · ` : ""}${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}</div><div class="r">${e.start}${e.end ? "–" + e.end : " · 끝 미정"}</div><i class="grip" title="끌어 늘이기"></i></div>`;
  }
  // Deadlines: a thin line at the deadline time with 「번호 · 15:00 · 제목」 (outside the range: at the edge).
  let lastTop = -99;
  for (const t of dueOn(ctx.s, k).filter((x) => x.dueTime && !x.done).sort((a, b) => a.dueTime!.localeCompare(b.dueTime!))) {
    const m = mins(t.dueTime!);
    const out = m > E ? "after" : m < S ? "before" : "";
    const n = num.get(t.id);
    const urgent = isUrgent(t, ctx.now, st.offWork);
    const top = (Math.max(S, Math.min(E, m)) - S) / (E - S);
    // Marks closer than a label's height step down a little.
    const nudge = top * 1000 - lastTop < 22 ? 18 : 0;
    lastTop = top * 1000 + nudge;
    h += `<div class="pin ${urgent ? "urg" : ""} ${out}" data-ev="${t.id}" data-num="${n ?? ""}" style="top:calc(${y(m)} + ${out === "after" ? -16 : nudge}px)"><span class="lb"><span class="no ${urgent ? "urg" : ""}" data-num="${n ?? ""}">${n ?? ""}</span><span class="tm">${out === "after" ? "이후 " : out === "before" ? "이전 " : ""}${t.dueTime}</span><span class="nm">${esc(t.title)}</span></span></div>`;
  }
  // 루틴: a small dot at its time (filled when done), the name on hover.
  for (const r of ctx.s.routines.filter((x) => routineOn(x, k))) {
    const m = mins(r.at);
    if (m < S || m > E) continue;
    h += `<div class="rtd ${r.done.includes(k) ? "dn" : ""}" style="top:${y(m)}" title="루틴 · ${esc(r.title)} · ${r.at} · ${repeatLabel(r)}${r.done.includes(k) ? " · 오늘 완료" : ""}"></div>`;
  }
  if (nowM >= S && nowM <= E) h += `<div class="nowl" style="top:${y(nowM)}"><span>지금 ${String(Math.floor(nowM / 60)).padStart(2, "0")}:${String(nowM % 60).padStart(2, "0")}</span></div>`;
  const dups = duplicates(ctx.s).filter((d) => d.x.kind === "event" && d.x.date === k);
  return `<div class="dt panel g">
    <div class="dta">${allDay.map((e) => `<span class="chip ${e.provisional ? "prov" : ""}" data-ev="${e.id}">종일 · ${esc(e.title)}</span>`).join("")}${dups.length ? `<button class="warnlink" data-checks>같은 일정 ${dups.length + 1}개 · 합치기</button>` : ""}<span class="mode"><button data-dr="work" class="${o.range === "work" ? "on" : ""}">업무 08–17</button><button data-dr="all" class="${o.range === "all" ? "on" : ""}">하루 전체</button></span></div>
    <div class="dtgw"><div class="dtg" data-dtg="${k}" data-s="${S}" data-e="${E}">${h}<div class="dtc" data-dtc title="위아래로 끌면 새 일정 · 할 일을 끌어 놓으면 작업 시간"></div></div></div>
  </div>`;
}

function stepRows(t: Task, n: number, open: boolean): string {
  if (!t.subs.length || !open) return "";
  const next = t.subs.findIndex((x) => !x.done);
  return `<div class="steps">${t.subs.map((x, j) => `<div class="step ${x.done ? "done" : ""} ${j === next ? "next" : ""}"><span class="n">${n}-${j + 1}</span><span class="ck ${x.done ? "on" : ""}" data-sub="${t.id}:${j}" role="checkbox" aria-checked="${x.done}" tabindex="0"></span><span class="s">${esc(x.title)}</span>${j === next ? '<span class="tag">다음</span>' : "<span></span>"}</div>`).join("")}<input class="subadd on" data-subadd="${t.id}" placeholder="+ 단계 추가" aria-label="${esc(t.title)} 단계 추가"></div>`;
}

export function starBtn(x: Entry): string {
  const v = x.star ?? 0;
  const hint = !v && x.starHint ? ` hint` : "";
  return `<button class="star s${v}${hint}" data-star="${x.id}" title="${v === 0 ? (x.starHint ? "AI 제안: 중요 · 누르면 ★" : "중요 표시(누를 때마다 ☆ → ★ → ★)") : v === 1 ? "중요 · 한 번 더 누르면 매우 중요" : "매우 중요 · 누르면 해제"}" aria-label="중요도 ${v}">${v === 0 && x.starHint ? "☆" : STAR[v]}</button>`;
}

export function taskList(ctx: Ctx, k: string, o: TodayOpts, fd: (k: string) => string): string {
  const off = ctx.s.settings.offWork;
  const { today, later, done, num } = orderedTasks(ctx.s, k === ctx.today ? ctx.today : k, ctx.now);
  const all = [...today, ...later];
  const count = (b: Bucket) => all.filter((t) => bucketOf(t, ctx.now, off) === b).length;
  const pass = (t: Task) => o.filter === "all" || bucketOf(t, ctx.now, off) === o.filter;
  const row = (t: Task) => {
    const n = num.get(t.id)!;
    const urgent = isUrgent(t, ctx.now, off);
    const sd = t.subs.filter((x) => x.done).length;
    const open = !!ctx.open?.has(`subs:${t.id}`);
    return `<div class="task" data-ev="${t.id}" data-task="${t.id}" data-num="${n}" draggable="true">
      <span class="no ${urgent ? "urg" : ""}" data-num="${n}">${n}</span><span class="ck" data-tdone="${t.id}" role="checkbox" aria-checked="false" tabindex="0" aria-label="${esc(t.title)} 완료"></span>${starBtn(t)}
      <span class="tn ${t.star === 2 ? "s2b" : ""}">${esc(t.title)}${t.draft ? '<span class="dr">초안</span>' : ""}${t.subs.length ? `<button class="pg" data-subs="${t.id}" aria-expanded="${open}">${sd}/${t.subs.length} ${open ? "▾" : "▸"}</button>` : `<button class="pg add" data-subs="${t.id}" title="단계 추가">+</button>`}</span>
      <span class="due ${urgent ? "urg" : t.due <= ctx.today ? "today" : ""}">${dueText(t, ctx.now, ctx.today, fd, off)}</span></div>${stepRows(t, n, open)}`;
  };
  const chip = (key: TodayOpts["filter"], name: string, c: number) => `<button class="${o.filter === key ? "on" : ""}" data-tf="${key}">${name}<b>${c}</b></button>`;
  const t1 = today.filter(pass);
  const t2 = later.filter(pass);
  const d = parseDay(k);
  return `<div class="tl panel g">
    <div class="ph"><b>할 일</b><span>번호 = 하루표의 번호${done.length ? ` · 완료 ${done.length}` : ""}</span></div>
    <div class="sum">${chip("all", "전체", all.length)}${chip("now", "지금 할 것", count("now"))}${chip("urgent", "급함", count("urgent"))}${chip("imp", "중요", count("imp"))}${chip("rest", "나머지", count("rest"))}</div>
    ${all.length === 0 ? '<div class="none">없음 · 「금요일까지 보고서」처럼 쓰면 들어갑니다</div>' : ""}
    ${t1.length ? `<div class="grp">오늘 ${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})<span>${t1.length}</span></div>${t1.map(row).join("")}` : ""}
    ${t2.length ? `<div class="grp later">나중<span>${t2.length}</span></div><div class="laterl">${t2.map(row).join("")}</div>` : ""}
    ${done.length ? `<details class="fold" data-fold="done" ${ctx.open?.has("done") ? "open" : ""}><summary>완료 ${done.length}</summary>${ctx.open?.has("done") ? done.map((t) => `<div class="task done" data-ev="${t.id}"><span></span><span class="ck on" data-tdone="${t.id}" role="checkbox" aria-checked="true" tabindex="0"></span><span></span><span class="tn">${esc(t.title)}</span><span class="due"></span></div>`).join("") : ""}</details>` : ""}
  </div>`;
}

export function rightStack(ctx: Ctx, k: string, fd: (k: string) => string): string {
  const up = upcoming(ctx.s, k, fd);
  const rs = ctx.s.routines.filter((r) => routineOn(r, k)).sort((a, b) => a.at.localeCompare(b.at));
  const doneN = rs.filter((r) => r.done.includes(k)).length;
  const next = rs.find((r) => !r.done.includes(k));
  const find = (id: string) => [...ctx.s.events, ...ctx.s.tasks, ...ctx.s.periods].find((x) => x.id === id);
  return `<div class="rstack">
    <div class="panel g ups ${up.length ? "" : "empty"}"><div class="ph"><b>다가오는 주요 일정</b><span>30일</span></div>
      ${up.length ? up.map((u) => {
        const x = find(u.id);
        return `<div class="ms" data-ev="${u.id}">${x ? starBtn(x) : "<span></span>"}<div><div class="t ${u.star === 2 ? "s2b" : ""}">${esc(u.title)}</div><div class="w">${esc(u.when)}</div>${u.steps ? `<div class="prog"><i style="--p:${((u.steps[0] / u.steps[1]) * 100).toFixed(0)}%"></i>${u.steps[0]}/${u.steps[1]} 단계</div>` : ""}</div><span class="d ${u.days <= 7 ? "soon" : ""}">D-${u.days}</span></div>`;
      }).join("") : '<div class="none">★ 표시한 일정·할 일과 기간이 여기에 D-day 순으로</div>'}</div>
    <div class="panel g rts ${rs.length ? "" : "empty"}"><div class="ph"><b>루틴</b><span>${rs.length ? `오늘 ${doneN}/${rs.length}` : ""}</span></div>
      ${rs.length ? rs.map((r) => {
        const dn = r.done.includes(k);
        const s = streak(r, k);
        return `<div class="rrow ${dn ? "dn" : ""} ${r === next ? "nx" : ""}" title="${esc(r.title)} · ${repeatLabel(r)}"><span class="ck ${dn ? "on" : ""}" data-rt="${r.id}" role="checkbox" aria-checked="${dn}" tabindex="0" aria-label="${esc(r.title)} 오늘 함"></span><span class="tm">${r.at}</span><span class="nm">${esc(r.title)}</span><span class="rp">${repeatLabel(r)}${s ? ` · ${s}일째` : ""}</span></div>`;
      }).join("") : '<div class="none">「매일 8시 20분 메일 확인 루틴」처럼 쓰거나 설정 → 루틴에서 추가</div>'}</div>
  </div>`;
}

export function todayView(ctx: Ctx, o: TodayOpts, fd: (k: string) => string, checks: string): string {
  const k = ymd(ctx.cur);
  const { num } = orderedTasks(ctx.s, k === ctx.today ? ctx.today : k, ctx.now);
  return `<div class="tdv">
    ${weekStrip(ctx, k)}
    ${checks}
    <div class="tgrid">${dayTable(ctx, k, o, num, fd)}${taskList(ctx, k, o, fd)}${rightStack(ctx, k, fd)}</div>
  </div>`;
}

/** 우선순위 (2×2): ① 지금 할 것 ② 계획할 것 ③ 빨리 처리할 것 ④ 나중에; drag between them. */
export function priorityView(ctx: Ctx, fd: (k: string) => string): string {
  const off = ctx.s.settings.offWork;
  const { today, later } = orderedTasks(ctx.s, ctx.today, ctx.now);
  const open = [...today, ...later];
  const q: [Bucket, string, string][] = [["now", "① 지금 할 것", "중요 · 급함"], ["imp", "② 계획할 것", "중요 · 여유"], ["urgent", "③ 빨리 처리할 것", "보통 · 급함"], ["rest", "④ 나중에", "보통 · 여유"]];
  const item = (t: Task) => `<div class="mq" draggable="true" data-task="${t.id}" data-ev="${t.id}">${starBtn(t)}<span class="tn ${t.star === 2 ? "s2b" : ""}">${esc(t.title)}</span><span class="due ${isUrgent(t, ctx.now, off) ? "urg" : ""}">${dueText(t, ctx.now, ctx.today, fd, off)}</span></div>`;
  const quad = ([k, n, d]: [Bucket, string, string]) => {
    const rows = open.filter((t) => bucketOf(t, ctx.now, off) === k);
    return `<div class="panel g quad" data-quad="${k}"><h4>${n}<span>${d} · ${rows.length}</span></h4>${rows.map(item).join("") || '<div class="none">없음</div>'}</div>`;
  };
  return `<div class="matrix"><span></span><div class="mh">급함 · 6시간 안 (마감 따라 자동)</div><div class="mh">여유</div>
    <div class="mr">중요<br><span class="s1">★</span> <span class="s2">★</span></div>${quad(q[0])}${quad(q[1])}
    <div class="mr">보통<br><span class="s0">☆</span></div>${quad(q[2])}${quad(q[3])}</div>`;
}

