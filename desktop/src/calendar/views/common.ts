import { diffDays, hm, mins } from "../dates";
import type { CalendarState, ChatMessage, Entry, Memo, Task } from "../model";
import { DATE_GROUPS, dateGroup, isClassTag, liveNotes, tagCostWon, untaggedLines, splitTagQuery, summaries, tagCounts, tagsOf } from "../tags";
import { findEntry, type Alarm } from "../store";
import { KIND_LABEL, type AskHit } from "../ask";
import { fixNumbers } from "../rules";

export type ViewName = "month" | "week" | "day" | "pri" | "memo";

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
  /** Records the user chose to keep as they are when asked about the dictation fix. */
  fixSkip?: Set<string>;
  /** The entry whose card shows the edit form (Mac). */
  editing?: string | null;
  /** Cards may offer 수정 (not on the phone: its changes travel as actions only). */
  canEdit?: boolean;
  /** The chat panel is on the right (확인할 것 lives there; otherwise on top of the day). */
  side?: boolean;
  /** 기억 보기: 날짜별/주제별, the tags chosen to filter, the tag being renamed. */
  memo?: { mode: "date" | "topic"; tags: string[]; edit?: string | null; ai?: boolean; busy?: boolean };
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
  move: svg('<rect x="3.5" y="5" width="13" height="14" rx="2"/><path d="M3.5 10h13M14 15h7M18 12l3 3-3 3"/>'),
  swap: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  merge: svg('<path d="M7 4v5a5 5 0 0 0 5 5h5M17 4v5"/><path d="M14 17l3-3-3-3"/>'),
  find: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  today: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><circle cx="12" cy="15" r="1.6" fill="currentColor"/>'),
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

/**
 * Week/month boxes: the start said short, after the title. On a school day a start within 5
 * minutes of a period's start says 「5교시」 (설정 「학교 시간」); otherwise the time.
 */
export function shortWhen(s: CalendarState, day: string, start: string): string {
  const wd = new Date(`${day}T00:00`).getDay();
  if (wd >= 1 && wd <= 5) {
    const m = mins(start);
    const i = s.settings.periods.findIndex((p) => Math.abs(mins(p.split("-")[0] ?? "") - m) <= 5);
    if (i >= 0) return `${i + 1}교시`;
  }
  return start;
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
    const time = x.kind === "event" ? (x.start ? `${x.start}${x.end ? "~" + x.end : ""}` : "") : x.kind === "task" ? x.dueTime ?? "" : "";
    return `<div class="rc edit" data-editing="${esc(key)}"><input class="ed-t" value="${esc(x.title)}" aria-label="제목">
      ${day ? `<div class="ed-row"><input type="date" class="ed-d" value="${day}" aria-label="날짜">${x.kind === "event" || x.kind === "task" ? `<input class="ed-h" value="${time}" placeholder="${x.kind === "event" ? "16:20~17:30 · 비우면 종일" : "17:00 · 비우면 시각 없음"}" title="1620, 16:20~17:30처럼 · ↑↓ 10분" aria-label="시각(24시간, ↑↓ 10분, 비우면 ${x.kind === "event" ? "종일" : "시각 없음"})" autocomplete="off" spellcheck="false">` : ""}</div>` : ""}
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
    if (ctx.canEdit && x.kind !== "note") acts.push(b(`data-moveto="${x.id}"`, "날짜 옮기기", ICON.move));
    if (ctx.canEdit && (x.kind === "event" || x.kind === "task") && !(x.kind === "event" && x.workFor)) acts.push(b(`data-swap="${esc(key)}"`, x.kind === "event" ? "할 일로 바꾸기" : "일정으로 바꾸기", ICON.swap));
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
 * 「기억」 (정리안): a find box and one line per note — title · start of the text · day, newest
 * first, the whole width. A click opens that line into its card (수정 · 일정으로 · 할 일로 · ✕).
 */
/**
 * 기억 보기 (2026-10-28): 「날짜별 | 주제별」, the tags with their counts on top (a click filters,
 * several narrow it down), 「#진도」 in the box filters too. 주제별: one fold per tag, most used
 * first; like records in one line (「진도 종료: 2-3, 2-4」).
 */
export function memoList(ctx: Ctx, fd: (k: string) => string, query = ""): string {
  const m = ctx.memo ?? { mode: "date", tags: [] };
  const counts = tagCounts(ctx.s);
  const bar = counts.length
    ? `<div class="mtagbar" role="group" aria-label="태그로 거르기">${counts.map(([t, n]) => `<button class="mtag ${m.tags.includes(t) ? "on" : ""}" data-memotag="${esc(t)}" aria-pressed="${m.tags.includes(t)}">#${esc(t)} <small>${n}</small></button>`).join("")}</div>`
    : "";
  return `<div class="memov"><div class="mtop"><label class="msearch">${ICON.find}<input data-memoq value="${esc(query)}" placeholder="기억에서 찾기 · #진도" aria-label="기억에서 찾기" autocomplete="off" spellcheck="false"></label><span class="mseg" role="group" aria-label="묶기"><button data-memomode="date" class="${m.mode === "date" ? "on" : ""}">날짜별</button><button data-memomode="topic" class="${m.mode === "topic" ? "on" : ""}">주제별</button></span></div>${bar}<div class="memol">${memoRows(ctx, fd, query)}</div></div>`;
}

export function memoRows(ctx: Ctx, fd: (k: string) => string, query = ""): string {
  const m = ctx.memo ?? { mode: "date", tags: [] };
  const { tags: qTags, words } = splitTagQuery(query);
  const want = [...new Set([...m.tags, ...qTags])];
  const q = words.toLowerCase();
  const notes = liveNotes(ctx.s)
    .filter((n) => !q || `${n.title} ${n.details ?? ""}`.toLowerCase().includes(q))
    .filter((n) => !want.length || want.every((t) => tagsOf(n).includes(t)))
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!notes.length) return `<div class="none">${q || want.length ? `${want.map((t) => `#${esc(t)} `).join("")}${esc(words)} 기억 없음` : "아직 기억이 없어요 · 날짜·시간 없이 쓰거나 「메모 …」로 시작하면 여기에 모입니다."}</div>`;
  const row = (n: Memo) => {
    if (ctx.open?.has(`memo:${n.id}`)) return `<div class="mopen">${resultCard(ctx, n.id, fd, false, "memo")}<button class="ib mclose" data-mopen="${n.id}" title="접기" aria-label="접기">${ICON.x}</button></div>`;
    const d = n.createdAt.slice(0, 10);
    const full = `${n.title}${n.details ? ` — ${n.details}` : ""}`;
    return `<div class="mrow" data-mopen="${n.id}" data-ev="${n.id}" role="button" tabindex="0" title="${esc(full)}"><b class="t">${esc(n.title)}</b>${n.details ? `<span class="d">${esc(n.details.replace(/\s+/g, " "))}</span>` : '<span class="d"></span>'}<span class="mts">${tagsOf(n).map((t) => `<span class="mt">#${esc(t)}</span>`).join("")}</span><span class="dt">${d === ctx.today ? "오늘" : fd(d)}</span></div>`;
  };
  if (m.mode === "date") {
    const groups = new Map<string, Memo[]>();
    for (const n of notes) {
      const g = dateGroup(n.createdAt.slice(0, 10), ctx.today);
      groups.set(g, [...(groups.get(g) ?? []), n]);
    }
    return DATE_GROUPS.filter((g) => groups.has(g)).map((g) => `<div class="mgh">${g} <small>${groups.get(g)!.length}</small></div>${groups.get(g)!.map(row).join("")}`).join("");
  }
  // Topics only (the 학반 filter from the bar and sit in the summary lines).
  const counts = tagCounts(ctx.s, notes).filter(([t]) => !isClassTag(t));
  const untagged = notes.filter((n) => !tagsOf(n).some((t) => !isClassTag(t)));
  const fold = (t: string, list: Memo[], label: string, tools: string) => {
    const sums = summaries(list);
    const sumLine = sums.map((x) => `${x.key}: ${x.classes.join(", ")}`).join(" · ");
    const open = !!ctx.open?.has(`mtag:${t}`) || want.includes(t);
    return `<details class="mgrp" data-fold="mtag:${esc(t)}" ${open ? "open" : ""}><summary><b>${label}</b> <small>${list.length}</small><span class="msum" title="${esc(sumLine)}">${open ? "" : esc(sumLine)}</span>${tools}</summary>${open ? `${sums.map((x) => `<div class="msumrow">${esc(x.key)}: ${esc(x.classes.join(", "))} <small>${x.ids.length}건</small></div>`).join("")}${list.map(row).join("")}` : ""}</details>`;
  };
  const tools = (t: string) => ctx.canEdit ? `<span class="mtools">${ctx.memo?.edit === t ? `<input class="mtren" data-tagrename="${esc(t)}" value="${esc(t)}" aria-label="태그 이름 (있는 이름이면 합침)" spellcheck="false">` : `<button class="ib" data-tagren="${esc(t)}" title="이름 바꾸기 · 있는 이름으로 바꾸면 합침" aria-label="태그 이름 바꾸기">${ICON.edit}</button><button class="ib" data-tagdel="${esc(t)}" title="이 태그 지우기 (기억은 그대로)" aria-label="태그 지우기">${ICON.x}</button>`}</span>` : "";
  // 규칙으로 주제를 못 단 기억: 한 번에 AI로(예상 비용을 먼저 보여 줌).
  const left = m.ai ? untaggedLines(ctx.s) : null;
  const aiRow = left && left.lines.length
    ? `<div class="mai">${m.busy ? "태그 다는 중…" : `<button class="mtag" data-memoai>규칙으로 못 단 ${left.lines.length}개 · AI로 태그 달기 (약 ${(() => { const w = tagCostWon(left.lines, counts.map(([t]) => t)); return w < 1 ? w.toFixed(1) : Math.round(w); })()}원)</button>`}</div>`
    : "";
  return aiRow + counts.map(([t]) => fold(t, notes.filter((n) => tagsOf(n).includes(t)), `#${esc(t)}`, tools(t))).join("") + (untagged.length ? fold("", untagged, "기타", "") : "");
}

/**
 * 확인할 것 (안 A, user's choice): only what really needs the user — a time the words did not
 * settle, appointments that overlap (one of them provisional or a draft), provisional ones whose day
 * has passed. The AI's small notes stay inside the cards.
 */
const TIME_UNSURE = /날짜만|시각|시간|임시|정해/;
/** A provisional appointment whose day has passed: 「있었음(확정)」 or 「없던 일(지우기)」. */
export const PAST_PROVISIONAL = "날짜가 지난 가승인 · 있었나요?";
export function checksOf(ctx: Ctx): { x: Entry; why: string }[] {
  const out: { x: Entry; why: string }[] = [];
  const seen = new Set<string>();
  const add = (x: Entry, why: string) => {
    if (!seen.has(x.id)) {
      seen.add(x.id);
      out.push({ x, why });
    }
  };
  const live = ctx.s.events.filter((e) => !e.gone && !e.sample);
  // First: provisional appointments whose day has passed — did it happen or not?
  for (const e of live.filter((e) => e.provisional && e.date < ctx.today).sort((a, b) => a.date.localeCompare(b.date))) add(e, PAST_PROVISIONAL);
  for (const x of needsReview(ctx)) if (x.review!.some((r) => r.startsWith("바뀐 날짜·시각이 없어"))) add(x, "바뀐 날짜·시각을 못 들음 · 일정에서 고쳐 주세요");
  for (const x of needsReview(ctx)) if (x.review!.some((r) => TIME_UNSURE.test(r))) add(x, "시각을 정해 주세요");
  for (const x of needsReview(ctx)) {
    const r = x.review!.find((r) => r.startsWith("기준 일정"));
    if (r) add(x, r.startsWith("기준 일정이 여럿") ? "기준 일정이 여럿 · 날짜를 정해 주세요" : "기준 일정을 못 찾음 · 날짜를 정해 주세요");
  }
  for (const x of needsReview(ctx)) if (x.review!.some((r) => r.startsWith("바꿀 일정이 여럿"))) add(x, "바꿀 일정이 여럿 · 어느 것인지 골라 주세요");
  for (const d of duplicates(ctx.s)) add(d.x, `같은 ${KIND_WORD[d.x.kind]}이 두 번 · 합치면 하나만 남김`);
  const timed = live.filter((e) => e.start && e.end && e.date >= ctx.today);
  for (const a of timed) {
    for (const b of timed) {
      if (a === b || a.date !== b.date || !(a.provisional || a.draft || b.provisional || b.draft)) continue;
      if (a.start! < b.end! && b.start! < a.end!) add(a, `「${b.title}」와 시간이 겹침`);
    }
  }
  return out;
}

/** Records put in before the dictation fix (「오반도」 → 「5반도」): asked once in 확인할 것, never changed by itself. */
export function dictationFixes(s: CalendarState, skip: Set<string> = new Set()): { x: Entry; to: string }[] {
  return [...s.events, ...s.tasks, ...s.periods, ...s.notes]
    .filter((x) => !x.gone && !x.sample && !skip.has(x.id))
    .map((x) => ({ x: x as Entry, to: fixNumbers(x.title) }))
    .filter((f) => f.to !== f.x.title);
}

export function checksBar(ctx: Ctx, fd: (k: string) => string): string {
  const list = checksOf(ctx);
  const fixes = dictationFixes(ctx.s, ctx.fixSkip);
  if (!list.length && !fixes.length) return "";
  const open = !!ctx.open?.has("checks");
  const card = ({ x, why }: { x: Entry; why: string }) =>
    resultCard(ctx, x.id, fd, false, "chk")
      .replace(/<button class="ib" data-(?:ok|tdone)="[^"]*"[^>]*>.*?<\/button>/, "")
      .replace(/<div class="rm2 warn">[\s\S]*?<\/div>/, "")
      .replace('<div class="ra">', `<div class="rm2 warn">${esc(why)}</div><div class="ra">${why === PAST_PROVISIONAL
        ? `<button class="chkbtn" data-accept="${x.id}" title="있었던 일로 확정" aria-label="있었음, 확정">있었음</button><button class="chkbtn" data-no="${x.id}" title="없던 일로 지우기 (되돌리기 가능)" aria-label="없던 일, 지우기">없던 일</button>`
        : why.startsWith("같은") ? `<button class="ib" data-merge="${x.id}" title="합치기(이것을 지우고 하나만 남김)" aria-label="합치기">${ICON.merge}</button>` : `<button class="ib" data-accept="${x.id}" title="맞아요" aria-label="맞아요">${ICON.ok}</button>`}`);
  const fixCard = fixes.length
    ? `<div class="rc chk fixq"><div class="rt">받아쓰기 교정을 이미 있는 기록에도 할까요?</div>${fixes.slice(0, 3).map((f) => `<div class="rm2">「${esc(f.x.title)}」 → 「${esc(f.to)}」</div>`).join("")}${fixes.length > 3 ? `<div class="rm2">외 ${fixes.length - 3}건</div>` : ""}<div class="ra on"><button class="ib" data-fixall title="모두 고치기 (⌘Z로 되돌림)" aria-label="모두 고치기">${ICON.ok}</button><button class="ib" data-fixskip title="그대로 두기 (다시 묻지 않음)" aria-label="그대로 두기">${ICON.x}</button></div></div>`
    : "";
  const n = list.length + (fixes.length ? 1 : 0);
  return `<div class="checks"><button class="chkbar" data-checks aria-expanded="${open}"><span class="cdot"></span><span>확인할 것 ${n}</span><span class="chev">${open ? "▴" : "▾"}</span></button>${open ? fixCard + list.map(card).join("") : ""}</div>`;
}

/** Same thing twice (same kind, title, day and time): the later one, to offer 「합치기」. */
export function duplicates(s: CalendarState): { x: Entry; of: Entry }[] {
  const seen = new Map<string, Entry>();
  const out: { x: Entry; of: Entry }[] = [];
  const keyOf = (x: Entry) =>
    x.kind === "event" ? `e|${x.title.trim()}|${x.date}|${x.start ?? ""}` : x.kind === "task" ? `t|${x.title.trim()}|${x.due}|${x.dueTime ?? ""}|${x.noDue ? 1 : 0}` : "";
  const live = [...s.events, ...s.tasks].filter((x) => !x.gone && !x.sample).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const x of live) {
    const k = keyOf(x);
    const first = seen.get(k);
    if (first) out.push({ x, of: first });
    else seen.set(k, x);
  }
  return out;
}

/** The hover card: everything about one entry, read-only (a click is for editing). */
export function tipHTML(ctx: Ctx, id: string, fd: (k: string) => string): string {
  const x = findEntry(ctx.s, id);
  if (!x) return "";
  const lines: string[] = [];
  if (x.kind === "event") lines.push(`${fd(x.date)} ${x.start ? `${x.start}${x.end ? "–" + x.end : " · 끝 미정"}` : "종일"}${x.provisional ? " · 가승인" : ""}`);
  if (x.kind === "task") lines.push(x.noDue ? "마감 없음" : `${fd(x.due)}${x.dueTime ? " " + x.dueTime : ""}까지${x.done ? " · 끝냄" : ""}`);
  if (x.kind === "period") lines.push(`${fd(x.from)} ~ ${fd(x.to)}`);
  const rem = "reminders" in x && x.reminders.length ? `알림 ${x.reminders.map((r) => (r.slice(0, 10) === ctx.today ? r.slice(11) : `${fd(r.slice(0, 10))} ${r.slice(11)}`)).join(", ")}` : "";
  const subs = x.kind === "task" && x.subs.length ? `<div class="tsub">${x.subs.map((t) => `<div>${t.done ? "☑" : "☐"} ${esc(t.title)}</div>`).join("")}</div>` : "";
  return `<b>${esc(x.title)}</b><div>${esc([KIND_WORD[x.kind], ...lines].join(" · "))}</div>${rem ? `<div>${esc(rem)}</div>` : ""}${subs}${x.details ? `<div class="tdet">${esc(x.details)}</div>` : ""}${x.review?.length ? `<div class="warn">※ ${esc(x.review.join(" · "))}</div>` : ""}<div class="tsrc">${esc(x.source)} · ${esc(x.createdAt.slice(5, 10).replace("-", "/"))} ${esc(x.createdAt.slice(11, 16))}</div>`;
}
