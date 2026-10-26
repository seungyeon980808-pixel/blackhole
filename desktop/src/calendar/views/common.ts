import { diffDays, hm, mins } from "../dates";
import type { CalendarState, ChatMessage, Entry, Task } from "../model";
import { findEntry, type Alarm } from "../store";
import { KIND_LABEL, type AskHit } from "../ask";

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
  /** What the empty input says (the Mac adds drop · ⌘V; the phone keeps it short). */
  hint?: string;
  /** Folds the user opened (by key): their rows are drawn only then, so long lists stay light. */
  open?: Set<string>;
  /** The entry whose card shows the edit form (Mac). */
  editing?: string | null;
  /** Cards may offer 수정 (not on the phone: its changes travel as actions only). */
  canEdit?: boolean;
}

/** A fold whose rows are drawn only while open (data-fold: the app re-renders on toggle). */
export function lazyFold(ctx: Ctx, key: string, label: string, rows: () => string): string {
  const on = !!ctx.open?.has(key);
  return `<details class="fold" data-fold="${key}" ${on ? "open" : ""}><summary>${label}</summary>${on ? rows() : ""}</details>`;
}

/** Placeholder of the always-open input. While the AI refines, typing on is fine (drafts go in at once). */
export const inputHint = (ctx: Ctx, inSheet: boolean): string => (ctx.busy ? "다듬는 중… 계속 넣어도 됩니다" : inSheet ? "더 넣기 · 묻기" : ctx.hint ?? "");

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

/** What came in today, as results: entries made today (not fake data), newest first. */
export function todayResults(ctx: Ctx): Entry[] {
  const all: Entry[] = [...ctx.s.events, ...ctx.s.tasks, ...ctx.s.periods, ...ctx.s.notes];
  return all.filter((x) => !x.sample && !x.gone && x.createdAt.slice(0, 10) === ctx.today).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Needs the user: entries of the last 7 days with a review note (not done, not cancelled). */
export function needsReview(ctx: Ctx): Entry[] {
  const all: Entry[] = [...ctx.s.events, ...ctx.s.tasks, ...ctx.s.periods, ...ctx.s.notes];
  return all.filter((x) => !x.sample && !x.gone && !(x.kind === "task" && x.done) && x.review?.length && diffDays(x.createdAt.slice(0, 10), ctx.today) <= 7 && !x.review.every((r) => r === "마감 날짜가 없어 오늘로 둠"));
}

export const KIND_WORD: Record<Entry["kind"], string> = { event: "일정", task: "할 일", period: "기간", note: "기억" };

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
/**
 * Deadline lines in one hour row. Labels would overlap, so only the earliest line carries one
 * (「마감 제목 외 N」); the others are lines with the title on hover / long press.
 */
export function dueMarks(today: string, tasks: Task[], A: number, B: number, dueClass = "du"): string {
  const here = tasks.filter((t) => t.dueTime && mins(t.dueTime) >= A && mins(t.dueTime) < B).sort((a, b) => a.dueTime!.localeCompare(b.dueTime!));
  return here.map((t, i) => {
    const b = dueBadge(today, t);
    const label = i === 0 ? `<span>마감 ${esc(t.title)}${here.length > 1 ? ` 외 ${here.length - 1}` : ""}</span>` : "";
    return `<div class="${dueClass} ${b?.hot ? "hot" : ""} ${t.done ? "done" : ""}" data-ev="${t.id}" style="left:${pct(mins(t.dueTime!), A)}" title="${esc(`마감 ${t.dueTime} ${t.title}`)}">${label}</div>`;
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

/**
 * A result card in the chat: what went in (or what an answer found), with the actions it needs.
 * `answer`: a found record — 열기 · 복사 · 완료 · 수정. Otherwise a put-in result — 확정/취소 or
 * 되돌리기, 수정, 열기. Both themes share it (they paint .rc/.rm2/.ra/.mini).
 */
export function resultCard(ctx: Ctx, id: string, fd: (k: string) => string, answer = false, where = "", compact = false): string {
  const x = findEntry(ctx.s, id);
  if (!x) return "";
  const kind = KIND_WORD[x.kind];
  const parts =
    x.kind === "event" ? [`${fd(x.date)} ${x.start ? `${x.start}${x.end ? "–" + x.end : ""}` : "종일"}`, x.provisional ? "가승인" : "", x.reminders.length ? `알림 ${x.reminders.map((r) => r.slice(11)).join(", ")}` : ""] :
    x.kind === "task" ? [x.noDue ? "마감 없음" : `${fd(x.due)}${x.dueTime ? " " + x.dueTime : ""}까지`, x.subs.length ? `하위 ${x.subs.filter((t) => t.done).length}/${x.subs.length}` : "", x.reminders.length ? `알림 ${x.reminders.map((r) => (r.slice(0, 10) === x.due ? r.slice(11) : `${+r.slice(5, 7)}/${+r.slice(8, 10)} ${r.slice(11)}`)).join(", ")}` : "", x.done ? "끝냄" : ""] :
    x.kind === "period" ? [`${fd(x.from)} ~ ${fd(x.to)}`] : [x.details ?? ""];
  const meta = [kind, ...parts].filter(Boolean).join(" · ");
  const review = x.review?.length ? `<div class="rm2 warn">※ ${esc(x.review.join(" · "))}</div>` : "";
  // The edit form opens in the one card that was clicked (the same entry may have several cards).
  const key = `${where}|${x.id}`;
  if (ctx.editing === key && ctx.canEdit) {
    const day = x.kind === "event" ? x.date : x.kind === "task" ? x.due : x.kind === "period" ? x.from : "";
    const time = x.kind === "event" ? x.start ?? "" : x.kind === "task" ? x.dueTime ?? "" : "";
    return `<div class="rc edit" data-editing="${esc(key)}"><input class="ed-t" value="${esc(x.title)}" aria-label="제목">
      ${day ? `<div class="ed-row"><input type="date" class="ed-d" value="${day}" aria-label="날짜">${x.kind === "event" || x.kind === "task" ? `<input type="time" class="ed-h" value="${time}" aria-label="시각(비우면 ${x.kind === "event" ? "종일" : "시각 없음"})">` : ""}</div>` : ""}
      <div class="ra"><button class="mini" data-editsave="${esc(key)}">저장</button><button class="mini" data-editcancel>그만</button></div></div>`;
  }
  const b = (attr: string, label: string) => `<button class="mini" ${attr}>${label}</button>`;
  const acts: string[] = [];
  if (x.gone) acts.push(b(`data-restore="${x.id}"`, "되살리기"));
  else {
    if (x.kind === "event" && x.provisional) acts.push(b(`data-ok="${x.id}"`, "확정"), b(`data-no="${x.id}"`, "취소"));
    if (x.kind === "task") acts.push(b(`data-tdone="${x.id}"`, x.done ? "완료 취소" : "완료"));
    if (ctx.canEdit) acts.push(b(`data-edit="${esc(key)}"`, "수정"));
    if (x.kind !== "note") acts.push(b(`data-open="${x.id}"`, "열기"));
    if (answer) acts.push(b(`data-copy="${x.id}"`, "복사"));
    else if (!(x.kind === "event" && x.provisional)) acts.push(b(`data-no="${x.id}"`, "되돌리기"));
  }
  return `<div class="rc ${x.gone ? "gone" : ""} ${compact ? "sm" : ""}"><b>${esc(x.title)}</b>${draftTag(x)}<div class="rm2">${esc(x.gone ? `${kind} · 지움` : meta)}</div>${review}<div class="ra">${acts.join("")}</div></div>`;
}

/** A found record that is not a calendar entry: a secret name, an Obsidian note, an inbox line. */
export function hitCard(h: AskHit): string {
  const act =
    h.kind === "secret" ? `<button class="mini" data-secretcopy="${esc(h.id.slice(7))}">복사(Touch ID)</button>` :
    h.kind === "obsidian" ? `<button class="mini" data-note="${esc(h.id.slice(9))}">열기</button><button class="mini" data-copytext="${esc(h.title)}">복사</button>` : "";
  return `<div class="rc"><b>${esc(h.title)}</b><div class="rm2">${KIND_LABEL[h.kind]} · ${esc(h.kind === "secret" ? "값은 이 Mac 키체인에만" : `${h.when} · ${h.where}`)}</div>${act ? `<div class="ra">${act}</div>` : ""}</div>`;
}

/** Cards under a chat message: answers (hits) or put-in results (refs), and the 「찾기/넣기」 choice. */
export function chatCards(ctx: Ctx, m: ChatMessage, fd: (k: string) => string): string {
  const cards = m.hits?.length
    ? m.hits.map((h) => (["event", "task", "period", "note"].includes(h.kind) ? resultCard(ctx, h.id, fd, true, m.id, m.hits!.length > 3) || hitCard(h) : hitCard(h))).join("")
    : (m.refs ?? []).map((r) => resultCard(ctx, r, fd, false, m.id)).join("");
  const choice = m.choice ? `<div class="ra"><button class="mini" data-choose="ask" data-cmsg="${m.id}">찾아보기</button><button class="mini" data-choose="put" data-cmsg="${m.id}">넣기</button></div>` : "";
  return cards + choice;
}
