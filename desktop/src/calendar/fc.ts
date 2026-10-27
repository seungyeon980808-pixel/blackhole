import { holiday } from "./holidays";
/**
 * Month (both themes) and glass week on FullCalendar (MIT: core, daygrid, timegrid,
 * interaction). Premium plugins are not used.
 */
import { Calendar, type EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { addDays, DOW, parseDay, ymd } from "./dates";
import type { CalendarState, Task, ThemeName } from "./model";
import { liveEvents, livePeriods, liveTasks } from "./store";
import { dueBadge, type Ctx, type ThemeView } from "./views/common";

export function fcEvents(s: CalendarState, withBells: boolean, around?: Date): EventInput[] {
  const out: EventInput[] = [];
  // (Week: no school-period bands any more — on the glass they read as stripes; the day table shows the periods.)
  void withBells;
  void around;
  for (const p of livePeriods(s)) {
    out.push({ id: p.id, title: p.title, start: p.from, end: ymd(addDays(parseDay(p.to), 1)), allDay: true, classNames: ["bh-per", p.area], extendedProps: { kind: "period", order: 0 }, editable: false });
  }
  for (const e of liveEvents(s)) {
    out.push(e.start
      ? { id: e.id, title: e.title, start: `${e.date}T${e.start}`, end: e.end ? `${e.date}T${e.end}` : undefined, allDay: false, classNames: ["bh-ev", e.area, e.provisional ? "prov" : ""], extendedProps: { kind: "event", order: 1 } }
      : { id: e.id, title: e.title, start: e.date, allDay: true, classNames: ["bh-ev", e.area, e.provisional ? "prov" : ""], extendedProps: { kind: "event", order: 1 } });
  }
  // Deadlines (not to-dos without one). In the week grid a timed deadline sits at its time.
  for (const t of liveTasks(s)) {
    if (t.noDue) continue;
    if (withBells && t.dueTime) {
      const at = new Date(`${t.due}T${t.dueTime}`);
      // 40 minutes: a deadline next to an appointment sits beside it instead of under its words.
      out.push({ id: t.id, title: t.title, start: at, end: new Date(at.getTime() + 40 * 60e3), allDay: false, classNames: ["bh-due", t.done ? "done" : ""], extendedProps: { kind: "task", order: 2 } });
      continue;
    }
    out.push({ id: t.id, title: t.title, start: t.due, allDay: true, classNames: ["bh-task", t.done ? "done" : ""], extendedProps: { kind: "task", order: 2 } });
  }
  // No reminder lines with 「알림 HH:MM」 in the week (정리안): the event's card shows its reminders.
  return out;
}

export interface FcHandlers {
  openDay: (k: string) => void;
  /** An appointment or deadline was dragged or resized (10-minute steps); null end = keep length. */
  onMove?: (id: string, start: Date, end: Date | null, allDay: boolean) => void;
}

export class FcHost {
  private fc: Calendar | null = null;
  private key = "";
  private el: HTMLElement | null = null;

  /** The box changed size (chat panel opened, folded or resized): FullCalendar measures again. */
  resize(): void {
    this.fc?.updateSize();
  }

  show(el: HTMLElement, ctx: Ctx, theme: ThemeName, view: ThemeView, handlers: FcHandlers, compact: boolean): void {
    // Month: six weeks with the shown day's week always the second row (the week before on top).
    const fcView = ctx.view === "month" ? "rolling" : "timeGridWeek";
    const at = fcView === "rolling" ? addDays(ctx.cur, -ctx.cur.getDay() - 7) : ctx.cur;
    const key = `${fcView}|${theme}|${compact}`;
    const events = fcEvents(ctx.s, fcView === "timeGridWeek", ctx.cur);
    if (this.fc && this.key === key && this.el === el) {
      this.fc.batchRendering(() => {
        this.fc!.removeAllEvents();
        this.fc!.addEventSource(events);
        this.fc!.gotoDate(at);
        this.fc!.setOption("now", ctx.now);
      });
      return;
    }
    this.destroy();
    this.el = el;
    this.key = key;
    const byId = (id: string) => ctx.s.events.find((x) => x.id === id) ?? ctx.s.tasks.find((x) => x.id === id) ?? ctx.s.periods.find((x) => x.id === id);
    this.fc = new Calendar(el, {
      plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
      initialView: fcView,
      initialDate: at,
      views: { rolling: { type: "dayGrid", duration: { weeks: 6 }, dateAlignment: "week" } },
      now: ctx.now,
      headerToolbar: false,
      height: "100%",
      firstDay: 0,
      fixedWeekCount: fcView !== "rolling",
      dayMaxEvents: true,
      eventDisplay: "block",
      displayEventTime: false,
      nowIndicator: true,
      allDayContent: () => "기간·마감",
      slotMinTime: "07:00:00",
      slotMaxTime: "23:00:00",
      slotDuration: "01:00:00",
      scrollTime: "08:00:00",
      expandRows: false,
      slotLabelContent: (arg) => String(arg.date.getHours()),
      dayHeaderContent: (arg) => (fcView === "rolling" ? DOW[arg.date.getDay()] : { html: `${DOW[arg.date.getDay()]} <b>${arg.date.getDate()}</b>` }),
      // Month: the date, and a public holiday's name in red.
      dayCellContent: (arg) => {
        if (fcView !== "rolling") return "";
        const h = holiday(ymd(arg.date));
        // The 1st says its month (the six weeks cross months).
        const n = arg.date.getDate() === 1 ? `${arg.date.getMonth() + 1}월 1` : String(arg.date.getDate());
        return h ? { html: `<span class="hol">${n} ${h}</span>` } : n;
      },
      moreLinkContent: (arg) => view.more(arg.num),
      // The 「+N」 list's title in Korean (it said 「October 28, 2026」).
      dayPopoverFormat: (arg) => `${arg.date.month + 1}월 ${arg.date.day}일 ${DOW[arg.date.marker.getUTCDay()]}요일`,
      eventOrder: "order,start,title",
      // Things at the same time sit side by side, never on top of each other's words.
      slotEventOverlap: false,
      eventContent: (arg) => {
        const kind = arg.event.extendedProps.kind as string;
        if (kind === "bell" || kind === "band") return { html: "" };
        const x = byId(arg.event.id);
        if (!x) return true;
        if (fcView === "timeGridWeek" && kind === "event" && !arg.event.allDay) {
          const e = x as { start: string | null; title: string; draft?: boolean };
          return { html: `<div class="wbt">${e.start ?? ""} ${escapeText(e.title)}${e.draft ? '<span class="dr">초안</span>' : ""}</div>` };
        }
        if (fcView === "timeGridWeek" && kind === "task" && !arg.event.allDay) {
          const t = x as unknown as Task;
          const b = dueBadge(ctx.today, t);
          return { html: `<div class="wbt due ${b?.hot ? "hot" : ""}">마감 ${t.dueTime ?? ""} ${escapeText(t.title)}${b ? ` <b>${b.text}</b>` : ""}</div>` };
        }
        if (fcView === "timeGridWeek" && kind === "period") {
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
      eventDidMount: (arg) => arg.el.setAttribute("data-ev", arg.event.id),
      dateClick: (arg) => handlers.openDay(ymd(arg.date)),
      navLinks: false,
      eventClick: (arg) => {
        arg.jsEvent.preventDefault();
        const start = arg.event.start;
        if (start) handlers.openDay(ymd(start));
      },
      dayHeaderDidMount: (arg) => {
        if (fcView === "timeGridWeek") {
          arg.el.style.cursor = "pointer";
          arg.el.addEventListener("click", () => handlers.openDay(ymd(arg.date)));
        }
      },
      events
    });
    this.fc.render();
  }

  destroy(): void {
    this.fc?.destroy();
    this.fc = null;
    this.el = null;
    this.key = "";
  }
}

function escapeText(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
