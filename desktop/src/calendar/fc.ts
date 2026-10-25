/**
 * Month (both themes) and glass week on FullCalendar (MIT: core, daygrid, timegrid,
 * interaction). Premium plugins are not used.
 */
import { Calendar, type EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { addDays, DOW, fromStamp, parseDay, ymd } from "./dates";
import type { CalendarState, ThemeName } from "./model";
import { allAlarms, liveEvents, livePeriods, liveTasks } from "./store";
import type { Ctx, ThemeView } from "./views/common";

export function fcEvents(s: CalendarState, withBells: boolean): EventInput[] {
  const out: EventInput[] = [];
  for (const p of livePeriods(s)) {
    out.push({ id: p.id, title: p.title, start: p.from, end: ymd(addDays(parseDay(p.to), 1)), allDay: true, classNames: ["bh-per", p.area], extendedProps: { kind: "period", order: 0 } });
  }
  for (const e of liveEvents(s)) {
    out.push(e.start
      ? { id: e.id, title: e.title, start: `${e.date}T${e.start}`, end: e.end ? `${e.date}T${e.end}` : undefined, allDay: false, classNames: ["bh-ev", e.area, e.provisional ? "prov" : ""], extendedProps: { kind: "event", order: 1 } }
      : { id: e.id, title: e.title, start: e.date, allDay: true, classNames: ["bh-ev", e.area, e.provisional ? "prov" : ""], extendedProps: { kind: "event", order: 1 } });
  }
  for (const t of liveTasks(s)) {
    out.push({ id: t.id, title: t.title, start: t.due, allDay: true, classNames: ["bh-task", t.done ? "done" : ""], extendedProps: { kind: "task", order: 2 } });
  }
  if (withBells) {
    for (const a of allAlarms(s)) {
      const at = fromStamp(a.at);
      out.push({ id: `bell-${a.key}`, title: `알림 ${a.at.slice(11)}`, start: at, end: new Date(at.getTime() + 60e3), display: "background", classNames: ["bh-bell"], extendedProps: { kind: "bell", order: 3 } });
    }
  }
  return out;
}

export interface FcHandlers {
  openDay: (k: string) => void;
}

export class FcHost {
  private fc: Calendar | null = null;
  private key = "";
  private el: HTMLElement | null = null;

  show(el: HTMLElement, ctx: Ctx, theme: ThemeName, view: ThemeView, handlers: FcHandlers, compact: boolean): void {
    const fcView = ctx.view === "month" ? "dayGridMonth" : "timeGridWeek";
    const key = `${fcView}|${theme}|${compact}`;
    const events = fcEvents(ctx.s, fcView === "timeGridWeek");
    if (this.fc && this.key === key && this.el === el) {
      this.fc.batchRendering(() => {
        this.fc!.removeAllEvents();
        this.fc!.addEventSource(events);
        this.fc!.gotoDate(ctx.cur);
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
      initialDate: ctx.cur,
      now: ctx.now,
      headerToolbar: false,
      height: "100%",
      firstDay: 0,
      fixedWeekCount: true,
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
      dayHeaderContent: (arg) => (fcView === "dayGridMonth" ? DOW[arg.date.getDay()] : { html: `${DOW[arg.date.getDay()]} <b>${arg.date.getDate()}</b>` }),
      dayCellContent: (arg) => (fcView === "dayGridMonth" ? String(arg.date.getDate()) : ""),
      moreLinkContent: (arg) => view.more(arg.num),
      eventOrder: "order,start,title",
      eventContent: (arg) => {
        const kind = arg.event.extendedProps.kind as string;
        if (kind === "bell") return { html: `<span>${arg.event.title}</span>` };
        const x = byId(arg.event.id);
        if (!x) return true;
        if (fcView === "timeGridWeek" && kind === "event" && !arg.event.allDay) {
          const e = x as { start: string | null; title: string };
          return { html: `<div class="wbt">${e.start ?? ""} ${escapeText(e.title)}</div>` };
        }
        if (fcView === "timeGridWeek" && kind === "period") {
          const p = x as { title: string; from: string; to: string };
          return { html: `<span class="pbw">${escapeText(p.title)} · ${view.fd(p.from)}–${view.fd(p.to)}</span>` };
        }
        return { html: view.monthChip(ctx, kind, x as unknown as Record<string, unknown>) };
      },
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
