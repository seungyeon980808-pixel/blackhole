import { diffDays, hm, mins } from "../dates";
import type { CalendarState, ChatMessage, Entry, Task } from "../model";
import type { Alarm } from "../store";

export type ViewName = "month" | "week" | "day";

export interface Ctx {
  s: CalendarState;
  /** Day shown (any day inside the month/week for those views). */
  cur: Date;
  view: ViewName;
  today: string;
  now: Date;
  nowM: number;
  connection: { label: string; detail: string };
  inboxLine: string;
  recording: boolean;
  busy: boolean;
}

export interface ThemeView {
  fd: (k: string) => string;
  shell(ctx: Ctx): string;
  head(ctx: Ctx): { title: string; summary?: string };
  day(ctx: Ctx): string;
  /** null: FullCalendar renders this view. */
  week(ctx: Ctx): string | null;
  composer(ctx: Ctx, id: string, inSheet: boolean): string;
  bubble(ctx: Ctx, m: ChatMessage): string;
  alarm(a: Alarm): string;
  more(n: number): string;
  monthChip(ctx: Ctx, kind: string, x: Record<string, unknown>): string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const ICON = {
  cam: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
  snooze: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 4 2.5 6.5M19 4l2.5 2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>',
  logo: '<svg viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#0a0a0d"/><circle cx="50" cy="53" r="29" fill="#fff" opacity=".35"/><circle cx="50" cy="53" r="27" fill="#fff"/><circle cx="50" cy="49" r="25" fill="#0a0a0d"/></svg>'
};

export const subCount = (t: Task): string => (t.subs.length ? `${t.subs.filter((x) => x.done).length}/${t.subs.length}` : "");

/** D-day marker in the prototype's wording. */
export function dday(today: string, t: Task, soonClass = "soon"): string {
  if (t.done) return "";
  const n = diffDays(today, t.due);
  if (n < 0) return `<span class="dd hot">${-n}일 지남</span>`;
  if (n === 0) return `<span class="dd hot">오늘${t.dueTime ? " " + t.dueTime : ""}</span>`;
  return `<span class="dd ${n <= 2 ? soonClass : ""}">D-${n}</span>`;
}

/** Month/week chip: urgency only ("3일 지남", "오늘", "D-1", "D-2"); further away the date says it. */
export function dueBadge(today: string, t: Task): { text: string; hot: boolean } | null {
  if (t.done) return null;
  const n = diffDays(today, t.due);
  if (n < 0) return { text: `${-n}일 지남`, hot: true };
  if (n === 0) return { text: "오늘", hot: true };
  if (n <= 2) return { text: `D-${n}`, hot: false };
  return null;
}

/** Not refined by the AI yet. */
export const draftTag = (x: Entry): string => (x.draft ? '<span class="dr" title="규칙으로 바로 넣은 초안 · AI가 다듬는 중">초안</span>' : "");

/** A touched draft for which the AI made something else: offer it, never apply it silently. */
export function aiOffer(x: Entry, fd: (k: string) => string): string {
  if (!x.suggest?.length) return "";
  const what = x.suggest.map((g) =>
    g.kind === "event" ? `${fd(g.date)} ${g.start ?? "종일"} ${g.title}` :
    g.kind === "task" ? `${g.title} ${g.noDue ? "" : fd(g.due) + (g.dueTime ? " " + g.dueTime : "") + "까지"}` :
    g.kind === "period" ? `${g.title} ${fd(g.from)}–${fd(g.to)}` : g.title).join(" / ");
  return `<span class="aio" title="${esc("AI: " + what)}">AI 제안 있음 <button class="mini" data-aiok="${x.id}">적용</button><button class="mini" data-aino="${x.id}">무시</button></span>`;
}

/** Deadlines with a time on day k, as markers in the 10-minute timetable. */
export function dueMarks(today: string, tasks: Task[], A: number, B: number, dueClass = "du"): string {
  return tasks.filter((t) => t.dueTime && mins(t.dueTime) >= A && mins(t.dueTime) < B).map((t) => {
    const b = dueBadge(today, t);
    return `<div class="${dueClass} ${b?.hot ? "hot" : ""} ${t.done ? "done" : ""}" data-ev="${t.id}" style="left:${pct(mins(t.dueTime!), A)}" title="${esc(`마감 ${t.dueTime} ${t.title}`)}"><span>마감 ${esc(t.title)}</span></div>`;
  }).join("");
}

export function nextReminder(ctx: Ctx, t: Task): string | undefined {
  const nowStamp = `${ctx.today}T${hm(ctx.nowM)}`;
  return t.reminders.filter((x) => x >= nowStamp).sort()[0];
}

/** One hour row segments for the 10-minute timetable. */
export interface Seg {
  id: string;
  title: string;
  area: string;
  provisional: boolean;
  s: number;
  en: number;
  first: boolean;
  half: "" | "half" | "half2";
  range: string;
}

export function hourSegments(events: { id: string; title: string; area: string; provisional: boolean; start: string | null; end: string | null }[], H: number): Seg[] {
  const A = H * 60;
  const B = A + 60;
  const segs = events
    .filter((e) => e.start && e.end && mins(e.start) < B && mins(e.end) > A)
    .map((e) => ({
      id: e.id,
      title: e.title,
      area: e.area,
      provisional: e.provisional,
      s: Math.max(mins(e.start!), A),
      en: Math.min(mins(e.end!), B),
      first: mins(e.start!) >= A,
      half: "" as Seg["half"],
      range: `${e.start}–${e.end}`
    }));
  const overlap = segs.some((x, i) => segs.some((y, j) => i < j && x.s < y.en && y.s < x.en));
  if (overlap) segs.forEach((g, i) => (g.half = i % 2 ? "half2" : "half"));
  return segs;
}

export const pct = (m: number, A: number): string => `${(((m - A) / 60) * 100).toFixed(3)}%`;
