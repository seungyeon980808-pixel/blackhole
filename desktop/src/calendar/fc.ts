import { holiday } from "./holidays";
/**
 * Month (both themes) and glass week on FullCalendar (MIT: core, daygrid, timegrid,
 * interaction). Premium plugins are not used.
 */
import { Calendar, type CalendarOptions, type EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { addDays, DOW, mins, parseDay, ymd } from "./dates";
import type { CalendarState, Task, ThemeName } from "./model";
import { liveEvents, livePeriods, liveTasks } from "./store";
import { dueBadge, type Ctx, type ThemeView } from "./views/common";

/** Week 「업무 08–17」: these hours fill the window; things before/after fold into a 20-minute row. */
const WORK_S = 8 * 60;
const WORK_E = 17 * 60;
const FOLD = 20;

export type WeekRange = "work" | "all";

interface Built {
  events: EventInput[];
  /** Work week: something starts before 08:00 / ends after 17:00 (the fold rows show). */
  top: boolean;
  bottom: boolean;
}

const hmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function build(s: CalendarState, week: boolean, around: Date | undefined, work: boolean): Built {
  const out: EventInput[] = [];
  const st = s.settings;
  // Work week: only the shown week decides the fold rows.
  const w0 = around ? ymd(addDays(around, -around.getDay())) : "";
  const w6 = around ? ymd(addDays(around, 6 - around.getDay())) : "";
  const shown = (k: string) => !around || (k >= w0 && k <= w6);
  const folds = new Map<string, { at: string; title: string }[]>();
  let top = false;
  let bottom = false;
  /** Work week: a timed thing wholly outside 08–17 goes into its day's fold row (true = taken). */
  const fold = (day: string, a: number, b: number, title: string): boolean => {
    if (!work || !shown(day)) return false;
    if (a < WORK_S) top = true;
    if (b > WORK_E) bottom = true;
    const side = b <= WORK_S ? "top" : a >= WORK_E ? "bot" : "";
    if (!side) return false;
    const k = `${day}|${side}`;
    folds.set(k, [...(folds.get(k) ?? []), { at: hmOf(a), title }]);
    return true;
  };
  // (Week: no school-period bands — on the glass they read as stripes; only faint period numbers.)
  for (const p of livePeriods(s)) {
    out.push({ id: p.id, title: p.title, start: p.from, end: ymd(addDays(parseDay(p.to), 1)), allDay: true, classNames: ["bh-per", p.area], extendedProps: { kind: "period", order: 0 }, editable: false });
  }
  for (const e of liveEvents(s)) {
    if (e.start) {
      const a = mins(e.start);
      if (fold(e.date, a, e.end ? Math.max(a + 1, mins(e.end)) : a + 1, e.title)) continue;
    }
    out.push(e.start
      ? { id: e.id, title: e.title, start: `${e.date}T${e.start}`, end: e.end ? `${e.date}T${e.end}` : undefined, allDay: false, classNames: ["bh-ev", e.area, e.provisional ? "prov" : ""], extendedProps: { kind: "event", order: 1 } }
      : { id: e.id, title: e.title, start: e.date, allDay: true, classNames: ["bh-ev", e.area, e.provisional ? "prov" : ""], extendedProps: { kind: "event", order: 1 } });
  }
  // Deadlines (not to-dos without one). In the week grid a timed deadline sits at its time.
  // Finished ones are not drawn in the week or month: the day says 「완료 n」.
  for (const t of liveTasks(s)) {
    if (t.noDue || t.done) continue;
    if (week && t.dueTime) {
      const m = mins(t.dueTime);
      if (fold(t.due, m, m + 1, `${t.title} (마감)`)) continue;
      const at = new Date(`${t.due}T${t.dueTime}`);
      // 40 minutes: a deadline next to an appointment sits beside it instead of under its words.
      out.push({ id: t.id, title: t.title, start: at, end: new Date(at.getTime() + 40 * 60e3), allDay: false, classNames: ["bh-due"], extendedProps: { kind: "task", order: 2 } });
      continue;
    }
    out.push({ id: t.id, title: t.title, start: t.due, allDay: true, classNames: ["bh-task"], extendedProps: { kind: "task", order: 2 } });
  }
  for (const [k, list] of folds) {
    const [day, side] = k.split("|");
    list.sort((p, q) => p.at.localeCompare(q.at));
    const [a, b] = side === "top" ? [WORK_S - FOLD, WORK_S] : [WORK_E, WORK_E + FOLD];
    out.push({ id: `fold-${k}`, title: list.map((x) => `${x.at} ${x.title}`).join("\n"), start: `${day}T${hmOf(a)}`, end: `${day}T${hmOf(b)}`, allDay: false, editable: false, classNames: ["bh-fold", side], extendedProps: { kind: "fold", side, list } });
  }
  // Work week: the period numbers, faint, down the Monday column only (설정 「학교 시간」 · 「교시 구간 옅게」).
  if (work && around && st.showPeriods) {
    const day = ymd(addDays(around, 1 - around.getDay()));
    st.periods.forEach((p, n) => {
      const [a, b] = p.split("-");
      if (a && b) out.push({ start: `${day}T${a}`, end: `${day}T${b}`, display: "background", classNames: ["bh-pn"], extendedProps: { kind: "pn", n: n + 1 } });
    });
  }
  // No reminder lines with 「알림 HH:MM」 in the week (정리안): the event's card shows its reminders.
  return { events: out, top, bottom };
}

export function fcEvents(s: CalendarState, withBells: boolean, around?: Date, work = false): EventInput[] {
  return build(s, withBells, around, work).events;
}

/** Finished deadlines per day (week header · month cell say 「완료 n」). */
function doneByDay(s: CalendarState): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of liveTasks(s)) if (t.done && !t.noDue) m.set(t.due, (m.get(t.due) ?? 0) + 1);
  return m;
}

/** Month: how many lines each of the six weeks needs (its busiest day). */
function weekLines(s: CalendarState, first: Date): number[] {
  const per = new Map<string, number>();
  const add = (k: string) => per.set(k, (per.get(k) ?? 0) + 1);
  const last = ymd(addDays(first, 41));
  const k0 = ymd(first);
  for (const e of liveEvents(s)) add(e.date);
  for (const t of liveTasks(s)) if (!t.noDue && !t.done) add(t.due);
  for (const p of livePeriods(s)) {
    if (p.to < k0 || p.from > last) continue;
    for (let d = parseDay(p.from > k0 ? p.from : k0); ymd(d) <= p.to && ymd(d) <= last; d = addDays(d, 1)) add(ymd(d));
  }
  return Array.from({ length: 6 }, (_, w) => Math.max(...Array.from({ length: 7 }, (_, i) => per.get(ymd(addDays(first, w * 7 + i))) ?? 0)));
}

export interface FcHandlers {
  openDay: (k: string) => void;
  /** An appointment, deadline or period was clicked: its 상세 편집 panel. */
  openEntry?: (id: string) => void;
  /** An appointment or deadline was dragged or resized (10-minute steps); null end = keep length. */
  onMove?: (id: string, start: Date, end: Date | null, allDay: boolean) => void;
}

export class FcHost {
  private fc: Calendar | null = null;
  private key = "";
  private el: HTMLElement | null = null;
  /** Month: lines per week and the row cap now in use (rows are sized to what they hold). */
  private lines: number[] = [];
  private rows = 0;
  private closeTimer = 0;

  /** The box changed size (chat panel opened, folded or resized): FullCalendar measures again. */
  resize(): void {
    this.fc?.updateSize();
    this.fit();
  }

  show(el: HTMLElement, ctx: Ctx, theme: ThemeName, view: ThemeView, handlers: FcHandlers, compact: boolean, range: WeekRange = "work"): void {
    // Month: six weeks with the shown day's week always the second row (the week before on top).
    const fcView = ctx.view === "month" ? "rolling" : "timeGridWeek";
    const month = fcView === "rolling";
    const at = month ? addDays(ctx.cur, -ctx.cur.getDay() - 7) : ctx.cur;
    const work = !month && range === "work";
    const b = build(ctx.s, !month, ctx.cur, work);
    const key = `${fcView}|${theme}|${compact}|${month ? "" : `${range}|${b.top}|${b.bottom}`}`;
    const done = doneByDay(ctx.s);
    this.lines = month ? weekLines(ctx.s, at) : [];
    // 「완료 n」 next to the date (finished to-dos are not drawn as lines).
    const doneTag = (d: Date) => {
      const n = done.get(ymd(d));
      return n ? `<span class="dn" title="끝낸 할 일 ${n}개">완료 ${n}</span>` : "";
    };
    const dayHeaderContent: CalendarOptions["dayHeaderContent"] = (arg) => (month ? DOW[arg.date.getDay()] : { html: `${DOW[arg.date.getDay()]} <b>${arg.date.getDate()}</b>${doneTag(arg.date)}` });
    // Month: the date, and a public holiday's name in red.
    const dayCellContent: CalendarOptions["dayCellContent"] = (arg) => {
      if (!month) return "";
      const h = holiday(ymd(arg.date));
      // The 1st says its month (the six weeks cross months).
      const n = arg.date.getDate() === 1 ? `${arg.date.getMonth() + 1}월 1` : String(arg.date.getDate());
      return { html: `${h ? `<span class="hol">${n} ${h}</span>` : n}${doneTag(arg.date)}` };
    };
    el.classList.toggle("wk-work", work);
    if (this.fc && this.key === key && this.el === el) {
      this.fc.batchRendering(() => {
        this.fc!.removeAllEvents();
        this.fc!.addEventSource(b.events);
        this.fc!.gotoDate(at);
        this.fc!.setOption("now", ctx.now);
        this.fc!.setOption("dayHeaderContent", dayHeaderContent);
        this.fc!.setOption("dayCellContent", dayCellContent);
      });
      this.fit();
      return;
    }
    this.destroy();
    this.el = el;
    this.key = key;
    el.classList.toggle("wk-work", work);
    const st = ctx.s.settings;
    const [on, off] = [mins(st.onWork), mins(st.offWork)];
    /** Work hours (출근–퇴근) bright, the rest darker; the fold rows darkest. */
    const slotClass = (d: Date | undefined): string[] => {
      if (!d) return [];
      const m = d.getHours() * 60 + d.getMinutes();
      return [m % 60 === 0 ? "hr" : "", work && (m < WORK_S || m >= WORK_E) ? "fold" : m >= on && m < off ? "inday" : "outday"];
    };
    const byId = (id: string) => ctx.s.events.find((x) => x.id === id) ?? ctx.s.tasks.find((x) => x.id === id) ?? ctx.s.periods.find((x) => x.id === id);
    this.rows = 4;
    this.fc = new Calendar(el, {
      plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
      initialView: fcView,
      initialDate: at,
      views: { rolling: { type: "dayGrid", duration: { weeks: 6 }, dateAlignment: "week" } },
      // Month rows are sized to what they hold (fit), the cap worked out from the window;
      // the week's 기간·마감 row: three lines at most and 「+n」.
      dayMaxEvents: false,
      dayMaxEventRows: month ? this.rows : 4,
      now: ctx.now,
      headerToolbar: false,
      height: "100%",
      firstDay: 0,
      fixedWeekCount: !month,
      eventDisplay: "block",
      displayEventTime: false,
      nowIndicator: true,
      // The week's hours: 「업무 08–17」 (fills the window) or 「하루 전체」 (scrolls), the day view's choice.
      allDayContent: () => ({ html: `<button class="wrng" data-dr="${work ? "all" : "work"}" title="${work ? "업무 08–17 보기 · 누르면 하루 전체" : "하루 전체 보기 · 누르면 업무 08–17"}">${work ? "08–17" : "전체"}</button>` }),
      ...(work
        ? { slotMinTime: hmOf(b.top ? WORK_S - FOLD : WORK_S), slotMaxTime: hmOf(b.bottom ? WORK_E + FOLD : WORK_E), slotDuration: "00:20:00", slotLabelInterval: "00:20:00", expandRows: true, scrollTime: "08:00:00" }
        : { slotMinTime: "00:00:00", slotMaxTime: "24:00:00", slotDuration: "01:00:00", expandRows: false, scrollTime: "07:00:00" }),
      slotLabelContent: (arg) => {
        const m = arg.date.getHours() * 60 + arg.date.getMinutes();
        return m % 60 || (work && (m < WORK_S || m >= WORK_E)) ? "" : String(arg.date.getHours());
      },
      slotLabelClassNames: (arg) => slotClass(arg.date),
      slotLaneClassNames: (arg) => slotClass(arg.date),
      dayHeaderContent,
      dayCellContent,
      moreLinkContent: (arg) => view.more(arg.num),
      // 「+n」: resting the pointer on it opens the day's list (a click does too).
      moreLinkDidMount: (arg) => this.hoverOpen(arg.el),
      // The 「+N」 list's title in Korean (it said 「October 28, 2026」).
      dayPopoverFormat: (arg) => `${arg.date.month + 1}월 ${arg.date.day}일 ${DOW[arg.date.marker.getUTCDay()]}요일`,
      eventOrder: "order,start,title",
      // Things at the same time sit side by side, never on top of each other's words.
      slotEventOverlap: false,
      eventContent: (arg) => {
        const kind = arg.event.extendedProps.kind as string;
        if (kind === "bell" || kind === "band") return { html: "" };
        if (kind === "pn") return { html: `<span class="pn">${arg.event.extendedProps.n}</span>` };
        if (kind === "fold") {
          const list = arg.event.extendedProps.list as { at: string; title: string }[];
          const more = list.length > 1 ? `<span class="w2">외 ${list.length - 1}</span>` : "";
          return { html: `<div class="wbt fold" title="${escapeText(arg.event.title)}"><span class="w1">${arg.event.extendedProps.side === "top" ? "이전" : "이후"} ${list[0].at} ${escapeText(list[0].title)}</span>${more}</div>` };
        }
        const x = byId(arg.event.id);
        if (!x) return true;
        // Week boxes on the time axis: the place says the time (사용자 지적), so the title only — the
        // exact time on hover. (The fold rows outside the hours keep theirs.)
        if (!month && kind === "event" && !arg.event.allDay) {
          const e = x as { date: string; start: string | null; end?: string | null; title: string; draft?: boolean };
          return { html: `<div class="wbt" title="${escapeText(`${e.start ?? ""}${e.end ? "–" + e.end : ""} ${e.title}`)}"><span class="w1">${escapeText(e.title)}${e.draft ? '<span class="dr">초안</span>' : ""}</span></div>` };
        }
        if (!month && kind === "task" && !arg.event.allDay) {
          const t = x as unknown as Task;
          const bd = dueBadge(ctx.today, t);
          return { html: `<div class="wbt due ${bd?.hot ? "hot" : ""}" title="${escapeText(`마감 ${t.dueTime ?? ""} ${t.title}`)}"><span class="w1">${escapeText(t.title)}</span>${bd ? `<span class="w2">${bd.text}</span>` : ""}</div>` };
        }
        if (!month && kind === "period") {
          const p = x as { title: string; from: string; to: string };
          return { html: `<span class="pbw">${escapeText(p.title)} · ${view.fd(p.from)}–${view.fd(p.to)}</span>` };
        }
        return { html: view.monthChip(ctx, kind, x as unknown as Record<string, unknown>) };
      },
      // Drag to another time or day, pull the end to make it longer/shorter (10-minute steps).
      editable: !!handlers.onMove,
      eventDurationEditable: true,
      snapDuration: "00:10:00",
      eventDrop: (arg) => handlers.onMove?.(arg.event.id, arg.event.start!, arg.event.end, arg.event.allDay),
      eventResize: (arg) => handlers.onMove?.(arg.event.id, arg.event.start!, arg.event.end, arg.event.allDay),
      // Hover cards find the entry by this.
      eventDidMount: (arg) => {
        if (arg.event.id && arg.event.extendedProps.kind !== "fold") arg.el.setAttribute("data-ev", arg.event.id);
      },
      dateClick: (arg) => handlers.openDay(ymd(arg.date)),
      navLinks: false,
      eventClick: (arg) => {
        arg.jsEvent.preventDefault();
        const kind = arg.event.extendedProps.kind as string;
        if (handlers.openEntry && (kind === "event" || kind === "task" || kind === "period")) return handlers.openEntry(arg.event.id);
        const start = arg.event.start;
        if (start) handlers.openDay(ymd(start));
      },
      dayHeaderDidMount: (arg) => {
        if (!month) {
          arg.el.style.cursor = "pointer";
          arg.el.addEventListener("click", () => handlers.openDay(ymd(arg.date)));
        }
      },
      events: b.events
    });
    this.fc.render();
    this.fit();
    // The 기간·마감 row settles its height after the first measure: measure again so the work
    // hours fill exactly what is left (they ran past the bottom by a row's worth).
    if (work) requestAnimationFrame(() => this.fc?.updateSize());
    document.addEventListener("mousemove", this.leave);
  }

  /** Leaving the opened 「+n」 list (anywhere on the page) closes it again. */
  private leave = (e: MouseEvent): void => {
    const pop = this.el?.querySelector(".fc-popover");
    if (!pop) return;
    clearTimeout(this.closeTimer);
    if (!(e.target as HTMLElement).closest?.(".fc-popover, .fc-more-link")) this.closeTimer = window.setTimeout(() => this.el?.querySelector<HTMLElement>(".fc-popover-close")?.click(), 300);
  };

  /** 「+n」 opens its list after the pointer rests on it a moment. */
  private hoverOpen(link: HTMLElement): void {
    let t = 0;
    link.addEventListener("mouseenter", () => {
      t = window.setTimeout(() => {
        if (!this.el?.querySelector(".fc-popover")) link.click();
      }, 250);
    });
    link.addEventListener("mouseleave", () => clearTimeout(t));
  }

  /**
   * Month: each week as tall as it needs (busy weeks tall, empty ones thin, this week a little
   * more), together exactly the box's height. The line cap is the most that still fits.
   */
  private fit(again = 0): void {
    const el = this.el;
    if (!this.fc || !el || !this.key.startsWith("rolling")) return;
    const rows = () => [...el.querySelectorAll<HTMLElement>(".fc-daygrid-body tbody > tr")];
    const rs = rows();
    if (rs.length !== 6 || this.lines.length !== 6) return;
    const sc = rs[0].closest<HTMLElement>(".fc-scroller");
    const table = rs[0].closest("table");
    if (!sc || !table) return;
    const H = sc.clientHeight;
    if (H < 120) return;
    // Natural heights first: an empty week's is the thinnest a row can be.
    // (FullCalendar gives the table the box's height, which would share it out evenly.)
    const fixed = table.style.height;
    table.style.height = "auto";
    rs.forEach((r) => (r.style.height = ""));
    const nat = rs.map((r) => r.getBoundingClientRect().height);
    table.style.height = fixed;
    const LH = el.querySelector<HTMLElement>(".fc-daygrid-event-harness")?.getBoundingClientRect().height || 17;
    const empty = nat.filter((_, i) => this.lines[i] === 0);
    const BASE = Math.ceil(empty.length ? Math.min(...empty) : Math.min(...nat.map((x, i) => x - Math.min(this.lines[i], this.rows) * LH)));
    const need = (n: number) => this.lines.map((l) => BASE + Math.min(l, n) * LH);
    const sum = (a: number[]) => a.reduce((p, q) => p + q, 0);
    const most = Math.max(1, ...this.lines);
    let n = 1;
    while (n < most && sum(need(n + 1)) <= H) n++;
    if (again) n = Math.max(1, Math.min(n, this.rows - 1));
    const h = need(n).map(Math.floor);
    let left = H - sum(h);
    if (left > 0) {
      // This week a little more; the rest shared by the weeks that hold something (empty ones stay thin).
      const bonus = Math.min(left, Math.round(LH * 2));
      h[1] += bonus;
      left -= bonus;
      const busy = this.lines.map((l, i) => l > 0 || i === 1);
      const k = busy.filter(Boolean).length;
      for (let i = 0; i < 6; i++) if (busy[i]) h[i] += Math.floor(left / k);
    }
    h[5] += H - sum(h);
    if (n !== this.rows) {
      this.rows = n;
      this.fc.setOption("dayMaxEventRows", n);
    }
    // (After the cap changes the rows are drawn again: heights go on afterwards.)
    const now = rows();
    now.forEach((r, i) => (r.style.height = `${Math.max(0, h[i])}px`));
    // Borders add a pixel here and there: the last row gives back what the table ran over;
    // still too tall (a line taller than measured), one line fewer.
    const over = table.getBoundingClientRect().height - H;
    if (over >= 1) now[5].style.height = `${Math.max(0, h[5] - Math.ceil(over))}px`;
    if (table.getBoundingClientRect().height - H >= 1 && again < 3 && n > 1) this.fit(again + 1);
  }

  destroy(): void {
    document.removeEventListener("mousemove", this.leave);
    this.fc?.destroy();
    this.fc = null;
    this.el?.classList.remove("wk-work");
    this.el = null;
    this.key = "";
  }
}

function escapeText(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
