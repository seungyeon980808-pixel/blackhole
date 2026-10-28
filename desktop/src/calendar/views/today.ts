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
export function orderedTasks(s: CalendarState, today: string, now: Date): { today: Task[]; later: Task[]; undated: Task[]; done: Task[]; num: Map<string, number> } {
  const off = s.settings.offWork;
  const live = liveTasks(s);
  const open = live.filter((t) => !t.done);
  const isToday = (t: Task) => !t.noDue && t.due <= today;
  const byUrgency = (a: Task, b: Task) =>
    Number(isUrgent(b, now, off)) - Number(isUrgent(a, now, off)) || (b.star ?? 0) - (a.star ?? 0) || minsLeft(a, now, off) - minsLeft(b, now, off);
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

export function dayTable(ctx: Ctx, k: string, o: TodayOpts, num: Map<string, number>, fd: (k: string) => string): string {
  const st = ctx.s.settings;
  const [S, E] = o.range === "work" ? [8 * 60, 17 * 60] : [0, 24 * 60];
  const y = (m: number) => pct(Math.max(S, Math.min(E, m)), S, E);
  const evs = eventsOn(ctx.s, k);
  const allDay = evs.filter((e) => !e.start);
  const timed = evs.filter((e) => e.start);
  const step = o.range === "work" ? 1 : 2;
  let h = "";
  const nowM = k === ctx.today ? ctx.nowM : -1;
  // The hour next to 「now」 steps aside for it (the now time sits in the hour column).
  for (let H = S / 60; H <= E / 60; H += step) h += `<div class="hr" style="top:${y(H * 60)}">${nowM >= 0 && Math.abs(H * 60 - nowM) < (step === 1 ? 14 : 28) ? "" : `<span>${String(H).padStart(2, "0")}:00</span>`}</div>`;
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
  for (const { e, a, b, lane } of placed) {
    if (b <= S || a >= E) continue;
    const work = e.workFor ? num.get(e.workFor) : undefined;
    h += `<div class="ev ${e.provisional ? "prov" : ""} ${nowM >= 0 && b <= nowM ? "past" : ""} ${e.workFor ? "work" : ""} ${e.end ? "" : "noend"}" data-ev="${e.id}" data-evbox="${e.id}" draggable="false" style="top:${y(a)};height:max(20px, calc(${y(b)} - ${y(a)}));left:calc(${((lane / L) * 54).toFixed(2)}% + 4px);width:calc(${(54 / L).toFixed(2)}% - 6px)">
      <div class="t" title="${esc(`${e.start}${e.end ? "–" + e.end : ""} ${e.title}`)}">${work ? `<span class="no">${work}</span> 작업 · ` : ""}${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}</div>${e.end ? "" : '<div class="r">끝 미정</div>'}<i class="grip" title="끌어 늘이기"></i></div>`;
  }
  // Deadlines: a card in its own lane (one left edge for all), its bottom edge on the deadline time.
  // Close ones stack upward; ones outside the shown hours go to a row under the table.
  const outside: string[] = [];
  let stackAt = Infinity;
  let stack = 0;
  // On the axis the card's place says the time (사용자 지적): 「번호 · 제목」 only; the row under the
  // table (outside the hours) keeps the time.
  const card = (t: Task, n: number | undefined, urgent: boolean, style: string) =>
    `<div class="dl ${urgent ? "urg" : ""}" data-ev="${t.id}" data-num="${n ?? ""}" style="${style}" title="${esc(`${t.dueTime}까지 ${t.title}`)}"><span class="no ${urgent ? "urg" : ""}" data-num="${n ?? ""}">${n ?? ""}</span>${style ? "" : `<span class="tm">${t.dueTime}</span>`}<span class="nm">${esc(t.title)}</span></div>`;
  const dues = dueOn(ctx.s, k).filter((x) => x.dueTime && !x.done).sort((a, b) => b.dueTime!.localeCompare(a.dueTime!));
  for (const t of dues) {
    const m = mins(t.dueTime!);
    const n = num.get(t.id);
    const urgent = isUrgent(t, ctx.now, st.offWork);
    if (m > E || m < S) {
      outside.unshift(card(t, n, urgent, ""));
      continue;
    }
    // About one card high in minutes: closer than that, this one sits on top of the later one.
    stack = stackAt - m < 36 * ((E - S) / 540) ? stack + 1 : 0;
    stackAt = stack ? stackAt : m;
    h += card(t, n, urgent, `top:calc(${y(stack ? stackAt : m)} - ${24 + stack * 26}px)`);
  }
  // 루틴 (added in 설정 → 루틴): a dotted line at its time with its name; a click checks it for today.
  for (const r of ctx.s.routines.filter((x) => routineOn(x, k))) {
    const m = mins(r.at);
    if (m < S || m > E) continue;
    const dn = r.done.includes(k);
    h += `<div class="rt ${dn ? "dn" : ""}" style="top:${y(m)}"><button data-rt="${r.id}" role="checkbox" aria-checked="${dn}" title="루틴 ${r.at} · ${repeatLabel(r)}${streak(r, k) ? ` · ${streak(r, k)}일째` : ""} · 누르면 ${dn ? "안 함으로" : "오늘 함"}">${esc(r.title)}${dn ? " ✓" : ""}</button></div>`;
  }
  if (nowM >= S && nowM <= E) h += `<div class="nowl" style="top:${y(nowM)}"><span>${String(Math.floor(nowM / 60)).padStart(2, "0")}:${String(nowM % 60).padStart(2, "0")}</span></div>`;
  const dups = duplicates(ctx.s).filter((d) => d.x.kind === "event" && d.x.date === k);
  return `<div class="dt panel g">
    <div class="dta">${allDay.map((e) => `<span class="chip ${e.provisional ? "prov" : ""}" data-ev="${e.id}">종일 · ${esc(e.title)}</span>`).join("")}${dups.length ? `<button class="warnlink" data-checks>같은 일정 ${dups.length + 1}개 · 합치기</button>` : ""}<span class="mode"><button data-dr="work" class="${o.range === "work" ? "on" : ""}">업무 08–17</button><button data-dr="all" class="${o.range === "all" ? "on" : ""}">하루 전체</button></span></div>
    <div class="dtgw"><div class="dtg" data-dtg="${k}" data-s="${S}" data-e="${E}">${h}<div class="dtc" data-dtc title="위아래로 끌면 새 일정 · 할 일을 끌어 놓으면 작업 시간"></div></div></div>
    ${outside.length ? `<div class="after"><b>${E < 24 * 60 ? `${String(E / 60).padStart(2, "0")}:00 밖` : "밖"}</b><div class="afl">${outside.join("")}</div></div>` : ""}
  </div>`;
}

function stepRows(t: Task, n: number, open: boolean): string {
  if (!t.subs.length || !open) return "";
  const next = t.subs.findIndex((x) => !x.done);
  return `<div class="steps">${t.subs.map((x, j) => `<div class="step ${x.done ? "done" : ""} ${j === next ? "next" : ""}"><span class="n">${n}-${j + 1}</span><span class="ck ${x.done ? "on" : ""}" data-sub="${t.id}:${j}" role="checkbox" aria-checked="${x.done}" tabindex="0"></span><span class="s">${esc(x.title)}${x.ai ? '<span class="aisug" title="원문에 없던 단계 · AI가 제안">AI 제안</span>' : ""}</span>${j === next ? '<span class="tag">다음</span>' : "<span></span>"}</div>`).join("")}<input class="subadd on" data-subadd="${t.id}" placeholder="+ 단계 추가" aria-label="${esc(t.title)} 단계 추가"></div>`;
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
  const t3 = undated.filter(pass);
  const d = parseDay(k);
  return `<div class="tl panel g">
    <div class="ph"><b>할 일</b><span>번호 = 하루표의 번호${done.length ? ` · 완료 ${done.length}` : ""}</span></div>
    <div class="sum">${chip("all", "전체", all.length)}${chip("now", "지금 할 것", count("now"))}${chip("urgent", "급함", count("urgent"))}${chip("imp", "중요", count("imp"))}${chip("rest", "나머지", count("rest"))}</div>
    ${all.length === 0 ? '<div class="none">없음 · 「금요일까지 보고서」처럼 쓰면 들어갑니다</div>' : ""}
    ${t1.length ? `<div class="grp">오늘 ${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})<span>${t1.length}</span></div>${t1.map(row).join("")}` : ""}
    ${t2.length ? `<div class="grp later">나중<span>${t2.length}</span></div><div class="laterl">${t2.map(row).join("")}</div>` : ""}
    ${t3.length ? `<div class="grp later">날짜 없음<span>${t3.length}</span></div><div class="laterl">${t3.map(row).join("")}</div>` : ""}
    ${done.length ? `<details class="fold" data-fold="done" ${ctx.open?.has("done") ? "open" : ""}><summary>완료 ${done.length}</summary>${ctx.open?.has("done") ? done.map((t) => `<div class="task done" data-ev="${t.id}"><span></span><span class="ck on" data-tdone="${t.id}" role="checkbox" aria-checked="true" tabindex="0"></span><span></span><span class="tn">${esc(t.title)}</span><span class="due"></span></div>`).join("") : ""}</details>` : ""}
  </div>`;
}

export function rightStack(ctx: Ctx, k: string, fd: (k: string) => string): string {
  const up = upcoming(ctx.s, k, fd);
  const find = (id: string) => [...ctx.s.events, ...ctx.s.tasks, ...ctx.s.periods].find((x) => x.id === id);
  return `<div class="rstack">
    <div class="panel g ups ${up.length ? "" : "empty"}"><div class="ph"><b>다가오는 주요 일정</b><span>30일</span></div>
      ${up.length ? up.map((u) => {
        const x = find(u.id);
        return `<div class="ms" data-ev="${u.id}">${x ? starBtn(x) : "<span></span>"}<div><div class="t ${u.star === 2 ? "s2b" : ""}">${esc(u.title)}</div><div class="w">${esc(u.when)}</div>${u.steps ? `<div class="prog"><i style="--p:${((u.steps[0] / u.steps[1]) * 100).toFixed(0)}%"></i>${u.steps[0]}/${u.steps[1]} 단계</div>` : ""}</div><span class="d ${u.days <= 7 ? "soon" : ""}">D-${u.days}</span></div>`;
      }).join("") : '<div class="none">★ 표시한 일정·할 일과 기간이 여기에 D-day 순으로</div>'}</div>
  </div>`;
}

export function todayView(ctx: Ctx, o: TodayOpts, fd: (k: string) => string, checks: string): string {
  const k = ymd(ctx.cur);
  const { num } = orderedTasks(ctx.s, k === ctx.today ? ctx.today : k, ctx.now);
  return `<div class="tdv">
    ${checks}
    <div class="tgrid">${dayTable(ctx, k, o, num, fd)}${taskList(ctx, k, o, fd)}${rightStack(ctx, k, fd)}</div>
  </div>`;
}

/** 우선순위 (2×2): ① 지금 할 것 ② 계획할 것 ③ 빨리 처리할 것 ④ 나중에; drag between them. */
export function priorityView(ctx: Ctx, fd: (k: string) => string): string {
  const off = ctx.s.settings.offWork;
  const { today, later, undated } = orderedTasks(ctx.s, ctx.today, ctx.now);
  const open = [...today, ...later, ...undated];
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
    const urg = isUrgent(t, ctx.now, off);
    const due = dueText(t, ctx.now, ctx.today, fd, off);
    const [left, right] = t.dueTime && t.due <= k ? [t.dueTime, due.split(" · ")[1] ?? ""] : [t.noDue ? "—" : t.due === k ? "오늘" : `${parseDay(t.due).getMonth() + 1}/${parseDay(t.due).getDate()}`, t.noDue ? "날짜 없음" : ""];
    return `<div class="prow" data-ev="${t.id}"><span class="tm ${urg ? "b" : ""}">${left}</span><span class="tn"><span class="ck" data-tdone="${t.id}" role="checkbox" aria-checked="false" tabindex="0" aria-label="${esc(t.title)} 완료"></span><span class="no">${n ?? ""}</span>${t.star ? `<span class="star s${t.star}">★</span> ` : ""}${esc(t.title)}${t.subs.length ? ` <i class="x">${t.subs.filter((x) => x.done).length}/${t.subs.length}</i>` : ""}</span><span class="x ${urg ? "b" : ""}">${right}</span></div>`;
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
