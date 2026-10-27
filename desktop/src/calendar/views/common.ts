import { diffDays, hm, mins } from "../dates";
import type { CalendarState, ChatMessage, Entry, Task } from "../model";
import { findEntry, type Alarm } from "../store";
import { KIND_LABEL, type AskHit } from "../ask";

export type ViewName = "month" | "week" | "day" | "memo";

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
  /** The chat panel is on the right (확인할 것 lives there; otherwise on top of the day). */
  side?: boolean;
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

/** A small line icon (functional only: each one is a button's whole label). */
function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const ICON = {
  cam: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13.2" r="3.4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
  snooze: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 4 2.5 6.5M19 4l2.5 2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>',
  ok: svg('<path d="M5 12.5 10 17.5 19 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  cal: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  todo: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12l2.5 2.5L15.5 9"/>'),
  open: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  print: svg('<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>'),
  chat: svg('<path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'),
  fold: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15M9 10l2 2-2 2"/>'),
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
      <div class="ra on"><button class="ib" data-editsave="${esc(key)}" title="저장 (Enter)" aria-label="저장">${ICON.ok}</button><button class="ib" data-editcancel title="그만 (Esc)" aria-label="그만">${ICON.x}</button></div></div>`;
  }
  // Icon buttons (their name on hover / for screen readers); the card itself opens its day.
  const b = (attr: string, label: string, icon: string) => `<button class="ib" ${attr} title="${label}" aria-label="${label}">${icon}</button>`;
  const acts: string[] = [];
  if (x.gone) acts.push(b(`data-restore="${x.id}"`, "되살리기", ICON.undo));
  else {
    if (x.kind === "event" && x.provisional) acts.push(b(`data-ok="${x.id}"`, "확정", ICON.ok));
    if (x.kind === "task") acts.push(b(`data-tdone="${x.id}"`, x.done ? "완료 취소" : "완료", x.done ? ICON.undo : ICON.ok));
    if (x.kind === "note" && ctx.canEdit) acts.push(b(`data-convert="event|${esc(key)}"`, "일정으로", ICON.cal), b(`data-convert="task|${esc(key)}"`, "할 일로", ICON.todo));
    if (ctx.canEdit) acts.push(b(`data-edit="${esc(key)}"`, "수정", ICON.edit));
    if (answer) acts.push(b(`data-copy="${x.id}"`, "복사", ICON.copy));
    if (x.kind === "event" && x.provisional) acts.push(b(`data-no="${x.id}"`, "취소", ICON.x));
    else if (!answer) acts.push(b(`data-no="${x.id}"`, "되돌리기(지우기)", ICON.x));
  }
  const opens = !x.gone && x.kind !== "note" ? ` data-open="${x.id}" title="눌러서 그날 보기"` : "";
  const offer = x.suggest?.length ? `<div class="rm2">${aiOffer(x, fd)}</div>` : "";
  return `<div class="rc ${x.gone ? "gone" : ""} ${compact ? "sm" : ""}"${opens}><b>${esc(x.title)}</b>${draftTag(x)}<div class="rm2">${esc(x.gone ? `${kind} · 지움` : meta)}</div>${review}${offer}<div class="ra">${acts.join("")}</div></div>`;
}

/** A found record that is not a calendar entry: a secret name, an Obsidian note, an inbox line. */
export function hitCard(h: AskHit): string {
  const act =
    h.kind === "secret" ? `<button class="ib" data-secretcopy="${esc(h.id.slice(7))}" title="복사(Touch ID)" aria-label="복사(Touch ID)">${ICON.copy}</button>` :
    h.kind === "obsidian" ? `<button class="ib" data-note="${esc(h.id.slice(9))}" title="노트 열기" aria-label="노트 열기">${ICON.open}</button><button class="ib" data-copytext="${esc(h.title)}" title="복사" aria-label="복사">${ICON.copy}</button>` : "";
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

/**
 * 「기억」: every note, newest first, as cards (수정 · 일정으로 · 할 일로 · 되돌리기). Notes are kept
 * forever and found by asking; there is no filing.
 */
export function memoList(ctx: Ctx, fd: (k: string) => string): string {
  // Newest first; the same minute keeps the order they came in (latest on top).
  const notes = ctx.s.notes.filter((n) => !n.gone && (ctx.s.settings.showSamples || !n.sample)).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!notes.length) return `<div class="memov"><div class="none">아직 기억이 없어요 · 날짜·시간 없이 쓰거나 「메모 …」로 시작하면 여기에 모입니다.</div></div>`;
  let day = "";
  let h = "";
  for (const n of notes) {
    const d = n.createdAt.slice(0, 10);
    if (d !== day) {
      day = d;
      h += `<div class="memod">${d === ctx.today ? "오늘" : fd(d)}</div>`;
    }
    h += resultCard(ctx, n.id, fd, false, "memo");
  }
  return `<div class="memov">${h}</div>`;
}

/**
 * 확인할 것: entries with a review note and provisional events waiting for 확정 — one quiet bar
 * (folded); open, each is a card with ✓ (맞아요 / 확정) · 수정 · ✕.
 */
export function checksOf(ctx: Ctx): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  const all: Entry[] = [...ctx.s.events, ...ctx.s.tasks, ...ctx.s.periods, ...ctx.s.notes];
  for (const x of [...needsReview(ctx), ...all.filter((e) => e.suggest?.length && !e.gone), ...ctx.s.events.filter((e) => e.provisional && !e.gone && !e.sample && e.date >= ctx.today)]) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

export function checksBar(ctx: Ctx, fd: (k: string) => string): string {
  const list = checksOf(ctx);
  if (!list.length) return "";
  const open = !!ctx.open?.has("checks");
  return `<div class="checks"><button class="chkbar" data-checks aria-expanded="${open}"><span class="cdot"></span><span>확인할 것 ${list.length}</span><span class="chev">${open ? "▴" : "▾"}</span></button>${open ? list.map((x) => resultCard(ctx, x.id, fd, false, "chk").replace(/<button class="ib" data-(?:ok|tdone)="[^"]*"[^>]*>.*?<\/button>/, "").replace('<div class="ra">', `<div class="ra"><button class="ib" data-accept="${x.id}" title="맞아요" aria-label="맞아요">${ICON.ok}</button>`)).join("") : ""}</div>`;
}
