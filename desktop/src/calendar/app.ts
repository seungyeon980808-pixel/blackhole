/**
 * mountBlackhole: the calendar app (month · week · day, composer, chat, alarms, print).
 * Platform work goes through the adapter, so this module runs unchanged in the desktop
 * window, a browser and the phone WebView.
 */
import { AnalyzeError, type AnalyzeInput, type BlackholeAdapter, type BoardOptions, type ClaudeStatus, type DeskStatus, type GoogleCalendars, type InboxStatus, type MessengerStatus, type PutItem } from "./adapter";
import { answer as answerQuestion, AskIndex, classify, docsOf, KIND_LABEL, lineOf, whenOf, type AskDoc, type AskHit, type AskSources } from "./ask";
import { addDays, fromStamp, hm, mins, nowHM, pad, parseDay, stamp, ymd } from "./dates";
import { FcHost } from "./fc";
import { normalizeState, sharedFrom, type CalEvent, type CalendarState, type Routine, type ChatKind, type ChatMessage, type Entry, type SharedCalendar, type ThemeName, type UserAction } from "./model";
import { startRecording, type Recording } from "./recorder";
import { clockText, isSimpleCertain, memoDraft, parseDraft, parseRule, singleTime, timeRange, timeWords } from "./rules";
import { seedState } from "./samples";
import {
  applyAction, describe, draftFromText, draftsOf, findEntry, log, markFired, missedAlarms, newId, refineDrafts, rekey, upcomingAlarms, type Alarm
} from "./store";
import { phoneToday, priorityView, todayView, type TodayOpts } from "./views/today";
import { checksBar, dictationFixes, duplicates, ICON, memoList, memoRows, resultCard, tipHTML, type Ctx, type ThemeView, type ViewName } from "./views/common";
import { doc, printSheet } from "./views/doc";
import { glass } from "./views/glass";

export interface MountOptions {
  now?: () => Date;
  /** Seed fake data when nothing is stored (default true). */
  seed?: boolean;
}

export interface BlackholeApp {
  readonly state: CalendarState;
  /** Milliseconds from the last 「넣기」 to its draft being on screen. */
  readonly lastDraftMs: number | null;
  submitText(text: string, src?: string): Promise<void>;
  submitFile(name: string, bytes: Uint8Array, kind?: ChatKind): Promise<void>;
  setView(view: ViewName, day?: string): void;
  setTheme(theme: ThemeName, mode?: "dark" | "light"): void;
  fireAlarm(alarm: Alarm): void;
  /** Run the inbox/draft/phone pulls now (they also run on timers). */
  poll(): Promise<void>;
  render(): void;
  destroy(): void;
}

const THEMES: Record<ThemeName, ThemeView> = { glass, doc };
const COMPACT = 760;
/** The calendar keeps at least this width beside the chat panel; narrower, the chat becomes a drawer from the right. */
export const CONTENT_MIN = 850;
const PANEL_MIN = 280;
const PANEL_MAX = 560;
const CHAT_NOISE = /^(?:초안 \d+건을 AI가 다듬었어요\.?\s*|\d+건 (?:더 )?넣었어요\.?\s*)+/;
/** Messages drawn in the chat (older ones stay saved). */
const CHAT_SHOWN = 200;
/** Worker codes that mean 「the analyzer is not available now」, not 「this input failed」. */
const WAITING_CODES = ["API_KEY_MISSING", "API_BILLING", "RUNNER_UNAVAILABLE", "MODEL_MISSING", "STT_UNAVAILABLE"];
/** Minimum time between two writes of the Drive 「달력.json」. */
export const SHARE_GAP_MS = 10_000;

/**
 * A failure shown to the user as one Korean line, 「원인 · 할 일」. Messages that are already Korean
 * stay; raw OS / network errors (English) are explained; anything else gets a short detail.
 */
export function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  if (/[가-힣]/.test(raw)) return raw;
  if (/permission denied|operation not permitted|not authorized|os error (1|13)\b/i.test(raw)) return "권한이 없음 · 시스템 설정 › 개인정보 보호 및 보안에서 블랙홀을 허용해 주세요";
  if (/no space left|os error 28\b/i.test(raw)) return "디스크 공간이 부족함 · 공간을 비우고 다시 해 주세요";
  if (/no such file|not found|os error 2\b/i.test(raw)) return "파일이나 폴더를 찾지 못함 · 설정에서 폴더를 다시 골라 주세요";
  if (/dns|resolve|network|offline|timed out|timeout|connection (refused|reset)|failed to fetch/i.test(raw)) return "인터넷 연결 없음 · 연결되면 자동으로 다시 합니다";
  const detail = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  return `처리하지 못함 · 다시 해 보고, 계속되면 블랙홀을 다시 열어 주세요${detail ? ` (${detail})` : ""}`;
}

const MOVE_RE = /^(.+?)\s*(?:을|를|은|는|도)?\s*((?:다음\s*주\s*)?[월화수목금토일]요일|내일|모레|글피|다음\s*주|\d{1,2}월\s*\d{1,2}일|\d{1,2}일|\d{1,2}\/\d{1,2})\s*(?:로|으로|에)\s*(?:옮겨|옮기기|옮겨\s*줘|미뤄|미뤄\s*줘|미루기|바꿔|변경|이동)/;

export async function mountBlackhole(root: HTMLElement, adapter: BlackholeAdapter, options: MountOptions = {}): Promise<BlackholeApp> {
  const clock = options.now ?? (() => new Date());
  const stored = normalizeState(await adapter.load().catch(() => null));
  const s: CalendarState = stored ?? (options.seed === false ? normalizeState({ schemaVersion: 1 })! : seedState(clock()));

  let view: ViewName = "day";
  try {
    const v = localStorage.getItem("bh-view");
    if (v === "month" || v === "week" || v === "day" || v === "memo" || v === "pri") view = v;
  } catch {
    /* private storage: start on the day view */
  }
  let cur = parseDay(ymd(clock()));
  let chatOpen = false;
  let settingsOpen = false;
  let busy = 0;
  let recording: Recording | null = null;
  let inbox: InboxStatus = { available: false, enabled: false, root: "", lastScanAt: null, lastError: null, running: false };
  const alarmQueue: Alarm[] = [];
  let alarmOn: Alarm | null = null;
  let selfRing = false;
  let ringTimer: number | undefined;
  let audio: AudioContext | null = null;
  let lastNowMinute = -1;
  let lastDraftMs: number | null = null;
  /** The day view last drawn: lists keep their scroll only while it stays the same day. */
  let lastRendered = "";
  /** Right-hand chat panel (desktop): open unless the user folded it; width in px. Remembered. */
  const sideCapable = adapter.origin !== "휴대폰";
  let sidePref = true;
  let panelW = 290;
  try {
    sidePref = localStorage.getItem("bh-panel") !== "closed";
    panelW = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Number(localStorage.getItem("bh-panel-w")) || 290));
  } catch {
    /* defaults */
  }
  let side = false;
  let editing: string | null = null;
  let chatDrawn = -1;
  /** Local answer index: rebuilt when the calendar changed (dataVer) or the sources were re-read. */
  let dataVer = 0;
  let sources: AskSources | null = null;
  let sourcesAt = 0;
  let askCache: { ver: number; idx: AskIndex } | null = null;
  /** 「그대로 두기」 on the dictation-fix question (this device only). */
  const fixSkip = new Set<string>();
  try {
    for (const id of JSON.parse(localStorage.getItem("bh-fixskip") ?? "[]") as string[]) fixSkip.add(id);
  } catch {
    /* none kept */
  }
  /** Lazy folds the user opened (「N개 더」, 「오래 지난 것」); kept for this session. */
  const openFolds = new Set<string>();
  const fcHost = new FcHost();
  const timers: number[] = [];

  const theme = () => THEMES[s.settings.theme];

  // The A4 sheet lives outside the themed root so theme styles never leak into it.
  const printRoot = document.createElement("div");
  printRoot.className = "bh-print";
  printRoot.id = "bhPrint";
  printRoot.hidden = true;
  printRoot.innerHTML = '<div class="mwrap"><div class="mbar"><button class="pbtn" data-doprint>인쇄</button><button class="pbtn" data-closeprint>닫기</button></div><div class="sheet" id="bhSheet"></div></div>';
  document.body.appendChild(printRoot);
  printRoot.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("[data-doprint]")) void adapter.print();
    else if (t.closest("[data-closeprint]") || t === printRoot) printRoot.hidden = true;
  });

  let shareLine = "";
  let gcal: GoogleCalendars | null = null;
  let board: BoardOptions | null = null;
  let messenger: MessengerStatus | null = null;
  let claude: ClaudeStatus | null = null;
  let claudeLine = "";
  let desk: DeskStatus | null = null;
  let deskLine = "";
  let guideOpen = false;
  /** The open group in 설정 (only one at a time). */
  let setGroup: string | null = null;
  /** The card shown over the day band. */
  let popId: { id: string; x: number; y: number } | null = null;
  /** 오늘 화면: 업무 08–17 / 하루 전체, and the to-do filter chip (both remembered). */
  const today: TodayOpts = { range: "work", filter: "all" };
  try {
    if (localStorage.getItem("bh-dayrange") === "all") today.range = "all";
  } catch {
    /* default */
  }
  /** The entry last clicked or hovered (⌥←/⌥→ move it a day). */
  let picked: string | null = null;
  /** The 「기억」 find box. */
  let memoQuery = "";
  let guideLines: Record<string, string> = {};
  let toastTimer: number | undefined;
  /** ⌘Z: the last hand-made changes, newest last (check · uncheck · cancel · a new entry). */
  const undoStack: { label: string; run: () => void }[] = [];
  /** A sentence waiting for 「비밀로 저장할까요?」. */
  let secretAsk: string | null = null;
  /** 「알람 시험」 alarms, scheduled with the real ones. */
  const testAlarms: Alarm[] = [];
  const loadCalendars = () =>
    Promise.all([adapter.googleCalendars?.(), adapter.board?.(), adapter.messenger?.(), adapter.claude?.().catch(() => null), adapter.desk?.().catch(() => null)]).then(([g, b, m, c, d]) => {
      gcal = g ?? null;
      board = b ?? null;
      messenger = m ?? null;
      claude = c ?? null;
      desk = d ?? desk;
      if (settingsOpen) renderSettings();
      if (guideOpen) renderGuide();
    });
  (window as unknown as { blackholeCalendars?: () => void }).blackholeCalendars = () => void loadCalendars();
  let shareTimer: number | undefined;
  let lastShared = "";
  let lastSharedAt = 0;
  /**
   * The Drive copy is written only when its content (not exportedAt) changed, and at most once
   * per SHARE_GAP_MS: every write makes Google Drive re-sync the file (CPU on the Mac).
   */
  const publishNow = () => {
    shareTimer = undefined;
    const shared = sharedFrom(s, stamp(clock()));
    const body = JSON.stringify({ ...shared, exportedAt: "" });
    if (body === lastShared) return;
    lastShared = body;
    lastSharedAt = Date.now();
    void adapter.publishShared!(shared).then((line) => (shareLine = line), (e: unknown) => {
      shareLine = friendlyError(e);
      lastShared = "";
    });
  };
  const save = async () => {
    dataVer++;
    await adapter.save(s).catch((e: unknown) => console.error("저장 실패", e));
    if (adapter.publishShared && s.settings.sharePhone && shareTimer === undefined) {
      const wait = Math.max(1500, lastSharedAt + SHARE_GAP_MS - Date.now());
      shareTimer = window.setTimeout(publishNow, wait);
    }
  };

  function ctx(): Ctx {
    const now = clock();
    return {
      s, cur, view, now,
      today: ymd(now),
      nowM: now.getHours() * 60 + now.getMinutes(),
      connection: adapter.connection,
      inboxLine: inbox.available ? (inbox.enabled ? `인박스 처리 켜짐${inbox.lastError ? " · 오류" : ""}` : "인박스 처리 꺼짐") : "",
      recording: !!recording,
      busy: busy > 0,
      open: openFolds,
      fixSkip,
      editing,
      canEdit: !adapter.recordAction,
      side,
      hint: adapter.origin === "휴대폰" ? "쓰고 보내기 — 「내일 3시 치과」" : adapter.onPut ? (side ? "넣기·묻기 · Enter" : "넣기·묻기 — 「내일 3시 치과」, 「치과 언제야?」 · 파일은 끌어 놓기, 사진은 ⌘V") : "넣기·묻기 — 「내일 3시 치과」, 「치과 언제야?」"
    };
  }

  /* ---------- shell ---------- */

  function buildShell(): void {
    fcHost.destroy();
    const c = ctx();
    root.className = `bh ${s.settings.theme}`;
    root.dataset.mode = s.settings.theme === "glass" ? s.settings.mode : "light";
    applyLook();
    void adapter.setLook?.(s.settings.theme, s.settings.mode).catch(() => undefined);
    root.innerHTML = `${theme().shell(c)}
      <section class="chatsheet" id="bhChat" aria-label="대화 기록"><div class="resizer" data-resize role="separator" aria-orientation="vertical" aria-label="대화 패널 폭" tabindex="0"></div><div class="grab" data-drag="close" role="button" tabindex="0" aria-label="대화 기록 닫기"><i></i></div><div class="sheethead">대화 기록</div><div class="panelbar"><b>대화</b><span class="sp"></span><button class="ib" data-panel="close" title="대화 접기 (⌘L)" aria-label="대화 패널 접기">${ICON.fold}</button></div><div id="bhChecks"></div><div class="thread" id="bhThread" aria-live="polite"></div><div class="sheetcomp" id="bhChatComp"></div></section>
      <div class="settings" id="bhSettings" role="dialog" aria-label="설정" hidden></div>
      <div class="settings guide" id="bhGuide" role="dialog" aria-label="처음 쓰기" hidden></div>
      <div class="alarm" id="bhAlarm" aria-live="assertive"></div>
      <div class="toast" id="bhToast" role="status" aria-live="polite" hidden></div>
      <div class="pop" id="bhPop" role="dialog" aria-label="항목" hidden></div>
      <div class="tip" id="bhTip" role="tooltip" hidden></div>
      <div class="ctxm" id="bhCtx" role="menu" aria-label="날짜 옮기기" hidden></div>
      <div class="ctxm pick" id="bhPick" role="dialog" aria-label="날짜 고르기" hidden></div>
      <div class="findres" id="bhFindRes" role="listbox" aria-label="찾은 것" hidden></div>
      <input type="file" id="bhFile" hidden accept="image/*,.pdf,.hwp,.hwpx,.docx,.xlsx,.txt,.wav">`;
    if (sideCapable) {
      // 「대화」 in the header: shows the folded panel again (the panel has 「접기」 itself).
      const set = root.querySelector<HTMLElement>("[data-settings]");
      set?.insertAdjacentHTML("beforebegin", `<button class="${set.className}" data-panel="open" title="대화 펴기 (⌘L)" aria-label="대화 펴기">${set.classList.contains("ibn") ? ICON.chat : "대화"}</button>`);
    }
    side = sideOn();
    renderComposer();
    render();
    // The calendar box changes width with the panel (open, fold, drag): FullCalendar follows.
    mainObserver?.disconnect();
    const main = root.querySelector<HTMLElement>("#bhMain");
    if (main && typeof ResizeObserver !== "undefined") {
      mainObserver = new ResizeObserver(() => fcHost.resize());
      mainObserver.observe(main);
    }
  }
  let mainObserver: ResizeObserver | undefined;

  /** The chat panel is on the right when the window is wide enough and the user did not fold it. */
  /** Room for the panel beside a calendar of at least CONTENT_MIN. */
  function wideEnough(): boolean {
    return root.clientWidth - panelW >= CONTENT_MIN;
  }

  function sideOn(): boolean {
    return sideCapable && sidePref && wideEnough();
  }

  function setSidePref(open: boolean): void {
    sidePref = open;
    try {
      localStorage.setItem("bh-panel", open ? "open" : "closed");
    } catch {
      /* not kept */
    }
    relayout();
    if (side) root.querySelector<HTMLInputElement>("#bhIn")?.focus();
  }

  /** Side or bottom: the input moves with it (same id, same text). */
  function relayout(): void {
    const next = sideOn();
    if (next === side) return render();
    side = next;
    chatDrawn = -1;
    renderComposer();
    render();
  }

  /** Glass blur and brightness from 설정 (CSS variables; the 공문서 theme does not use them). */
  function applyLook(): void {
    const { glassBlur, glassBright } = s.settings;
    root.style.setProperty("--bh-blur", `${Math.max(0, Math.min(40, glassBlur))}px`);
    const b = Math.max(-50, Math.min(50, glassBright));
    root.style.setProperty("--bh-veil", b >= 0 ? `rgba(255,255,255,${((b / 50) * 0.35).toFixed(3)})` : `rgba(0,0,0,${((-b / 50) * 0.55).toFixed(3)})`);
  }

  /** The input box grows with what is typed: 1–6 lines, then it scrolls. */
  function growBox(el: HTMLElement): void {
    if (!(el instanceof HTMLTextAreaElement)) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight || line, line * 6 + 10)}px`;
  }

  function renderComposer(): void {
    const c = ctx();
    const comp = root.querySelector<HTMLElement>("#bhComp");
    const chatComp = root.querySelector<HTMLElement>("#bhChatComp");
    const keep = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
    const v1 = keep("bhIn");
    const v2 = keep("bhChatIn");
    if (side) {
      // The panel holds the one input; the bottom bar is empty (and hidden).
      if (comp) comp.innerHTML = "";
      if (chatComp) chatComp.innerHTML = theme().composer(c, "bhIn", true);
    } else {
      if (comp) comp.innerHTML = theme().composer(c, "bhIn", false);
      if (chatComp) chatComp.innerHTML = theme().composer(c, "bhChatIn", true);
    }
    const i1 = root.querySelector<HTMLInputElement>("#bhIn");
    const i2 = root.querySelector<HTMLInputElement>("#bhChatIn");
    if (i1) i1.value = v1;
    if (i2) i2.value = v2;
    if (i1) growBox(i1);
    if (i2) growBox(i2);
    renderLast();
  }

  /** Quiet but clear: offline, no key, budget used up, inbox trouble (no pop-ups). */
  function quietState(): string {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return adapter.origin === "휴대폰" ? "오프라인 · 연결되면 자동으로 보냄" : "오프라인 · 초안만";
    if (claude && claude.analyzer !== "local") {
      if (!claude.hasKey) return "AI 키 없음 · 초안만";
      if ((claude.budgetUsd ?? 0) > 0 && claude.monthUsd >= (claude.budgetUsd ?? 0)) return "AI 예산 다 씀 · 초안만";
    }
    if (inbox.enabled && inbox.lastError) return "인박스 오류(설정에서 보기)";
    return "";
  }

  function undo(): void {
    const u = undoStack.pop();
    if (!u) return toast("되돌릴 것이 없어요");
    u.run();
    toast(`되돌렸어요: ${u.label}`);
  }

  /**
   * The short note at the bottom (snackbar). With `canUndo` it carries 「되돌리기」 for the newest
   * entry on the undo stack; `undoRef` first puts 「넣기」 of that entry on the stack.
   */
  function toast(msg: string, undoRef?: string, canUndo = !!undoRef): void {
    if (undoRef) {
      const x = findEntry(s, undoRef);
      if (x) undoStack.push({ label: `「${x.title}」 넣기`, run: () => userAction({ type: "cancel", ref: undoRef }, true, false) });
      else canUndo = false;
      // The chat card (panel) or the line above the input already says it, with its buttons: no second copy.
      const inPanel = side && s.chat.slice(-3).some((m) => m.refs?.includes(undoRef));
      if (x && (inPanel || (!side && !chatOpen && s.log[s.log.length - 1]?.ref === undoRef && root.querySelector("#bhLast")))) {
        renderLast();
        return;
      }
    }
    const el = root.querySelector<HTMLElement>("#bhToast");
    if (!el) return;
    const key = adapter.origin === "휴대폰" ? "" : " ⌘Z";
    el.innerHTML = `<span>${escapeHtml(msg)}</span>${canUndo ? `<a data-undo role="button" tabindex="0">되돌리기${key}</a>` : ""}`;
    el.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (el.hidden = true), canUndo ? 6000 : 3500);
  }

  function renderLast(): void {
    const el = root.querySelector<HTMLElement>("#bhLast");
    if (!el) return;
    if (secretAsk !== null) {
      el.innerHTML = '<b>비밀번호 같아요</b> 키체인에만 둘까요? <a data-secret="yes" role="button" tabindex="0">비밀로 저장</a><a data-secret="no" role="button" tabindex="0">그냥 넣기</a>';
      return;
    }
    const l = s.log[s.log.length - 1];
    if (!l) {
      el.innerHTML = "";
      return;
    }
    const x = l.ref ? findEntry(s, l.ref) : undefined;
    const act = x && !x.gone ? (x.kind === "event" && x.provisional ? `<a data-ok="${x.id}" role="button" tabindex="0">확정</a><a data-no="${x.id}" role="button" tabindex="0">취소</a>` : `<a data-no="${x.id}" role="button" tabindex="0">되돌리기</a>`) : "";
    el.innerHTML = `<b>${escapeHtml(l.label)}</b> ${escapeHtml(l.msg)}${act}`;
  }

  /**
   * Lines the chat no longer says (older versions saved them): a local search that found
   * nothing, and 「초안 N건을 AI가 다듬었어요」 / 「N건 넣었어요」 over cards that already show it.
   */
  function shownMsg(m: ChatMessage): ChatMessage | null {
    if (m.who !== "ai") return m;
    if (!m.hits?.length && !m.refs?.length && /기록을 찾지 못했어요|기록이 없어요$|무엇을 찾을지/.test(m.text)) return null;
    const text = m.text.replace(CHAT_NOISE, "").trim();
    return text === m.text ? m : { ...m, text };
  }

  function renderChat(): void {
    const el = root.querySelector<HTMLElement>("#bhThread");
    if (!el) return;
    const c = ctx();
    let day = "";
    let h = "";
    const shown = s.chat.slice(-CHAT_SHOWN).map(shownMsg).filter((m): m is ChatMessage => !!m);
    // Same speaker in the same minute: one group (tighter, the time and source once under the last).
    const same = (a?: ChatMessage, b?: ChatMessage) => !!a && !!b && a.who === b.who && a.at.slice(0, 16) === b.at.slice(0, 16);
    shown.forEach((m, i) => {
      const d = m.at.slice(0, 10);
      if (d !== day) {
        day = d;
        h += `<div class="daysep">${d === c.today ? "오늘" : theme().fd(d)}</div>`;
      }
      let b = theme().bubble(c, m);
      // Same speaker, same minute: tighter, and the time only on the first of them.
      if (same(shown[i - 1], m) && shown[i - 1].at.slice(0, 10) === d) b = b.replace('class="bub ', 'class="bub cont ').replace(/<span class="btime"[^>]*>[^<]*<\/span>/, '<span class="btime"></span>');
      h += b;
    });
    // Nothing yet (안 A): three grey lines of what one can type.
    if (!s.chat.length) h = `<div class="chat-empty"><div>「내일 3시 치과」 → 일정</div><div>「치과 언제야?」 → 답</div><div>「메모 차 번호 …」 → 기억</div></div>`;
    // A draft card already says 「다듬는 중」; the typing line is only for what has no card yet.
    if (busy && s.chat[s.chat.length - 1]?.who !== "ai") h += '<div class="bub ai typing">찾는 중…</div>';
    // Keep the reader's place unless they were at the bottom or something new arrived.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const top = el.scrollTop;
    el.innerHTML = h;
    el.scrollTop = atBottom || chatDrawn !== s.chat.length ? el.scrollHeight : top;
    chatDrawn = s.chat.length;
  }

  /** 「지금 14:27 · 다음 15:00 시행 기안」: the next appointment or deadline today. */
  function nowLine(c: Ctx): string {
    const now = `${pad(c.now.getHours())}:${pad(c.now.getMinutes())}`;
    const next = [
      ...s.events.filter((e) => !e.gone && !e.workFor && e.date === c.today && e.start && e.start > now).map((e) => ({ at: e.start!, title: e.title })),
      ...s.tasks.filter((x) => !x.gone && !x.done && x.due === c.today && x.dueTime && x.dueTime > now).map((x) => ({ at: x.dueTime!, title: x.title }))
    ].sort((a, b) => a.at.localeCompare(b.at))[0];
    return next ? `지금 ${now} · 다음 ${next.at} ${next.title}` : `지금 ${now}`;
  }

  function render(): void {
    const c = ctx();
    const t = theme();
    const nNotes = s.notes.filter((n) => !n.gone && (s.settings.showSamples || !n.sample)).length;
    const head = view === "pri" ? { title: "우선순위", summary: "★ 중요도 × 마감까지 6시간(자동) · 끌어서 칸을 옮기면 ★·마감이 바뀜" } : view === "memo" ? { title: `기억 ${nNotes}개`, summary: "날짜·시간 없이 넣은 것과 「메모 …」 · 지우지 않고 계속 보관 · 대화창에 물으면 찾아 줌" } : t.head(c);
    const title = root.querySelector<HTMLElement>("#bhTitle");
    if (title) title.textContent = head.title;
    const nowEl = root.querySelector<HTMLElement>("#bhNowLine");
    if (nowEl) nowEl.textContent = nowLine(c);
    const sum = root.querySelector<HTMLElement>("#bhSum");
    if (sum) sum.textContent = head.summary ?? "";
    root.querySelectorAll<HTMLButtonElement>("[data-v]").forEach((b) => {
      b.classList.toggle("on", b.dataset.v === view);
      b.setAttribute("aria-pressed", String(b.dataset.v === view));
    });
    const main = root.querySelector<HTMLElement>("#bhMain")!;
    // The day is the 「오늘」 layout (user-approved plan) in both themes; the phone stacks it.
    // The phone: 시안 가 — one scrolling 「오늘」 (now·next → to-dos → today's list → upcoming; the table on request).
    const phone = document.documentElement.classList.contains("phone");
    const custom = view === "day" && phone ? checksBar(c, t.fd) + phoneToday(c, today, t.fd) : view === "day" ? todayView(c, today, t.fd, side ? "" : checksBar(c, t.fd)) : view === "pri" ? priorityView(c, t.fd) : view === "week" ? t.week(c) : view === "memo" ? memoList(c, t.fd, memoQuery) : null;
    if (custom === null) {
      let host = main.querySelector<HTMLElement>(":scope > .fchost");
      if (!host) {
        main.innerHTML = '<div class="fchost"></div>';
        host = main.querySelector<HTMLElement>(".fchost")!;
      }
      host.classList.toggle("g", s.settings.theme === "glass");
      fcHost.show(host, c, s.settings.theme, t, { openDay, onMove: fcMoved }, root.clientWidth > 0 && root.clientWidth < COMPACT);
    } else {
      fcHost.destroy();
      const scroll = main.querySelector<HTMLElement>(".ttwrap, .colx")?.scrollTop;
      // Folds the user opened (「N개 더」, 「오늘 정리한 것」) stay open across re-renders (checks, the minute tick).
      const opened = new Set([...main.querySelectorAll("details[open] > summary")].map((x) => x.textContent?.replace(/\d+/g, "#")));
      const colScroll = [...main.querySelectorAll<HTMLElement>(".box.grow, .col2")].map((x) => x.scrollTop);
      main.innerHTML = custom;
      main.querySelectorAll("details > summary").forEach((x) => {
        if (opened.has(x.textContent?.replace(/\d+/g, "#"))) x.parentElement!.setAttribute("open", "");
      });
      const here = `${view}|${ymd(cur)}|${s.settings.theme}`;
      if (here === lastRendered) main.querySelectorAll<HTMLElement>(".box.grow, .col2").forEach((x, i) => (x.scrollTop = colScroll[i] ?? 0));
      lastRendered = here;
      if (view === "day") {
        const tt = main.querySelector<HTMLElement>(".ttwrap, .colx");
        if (tt && scroll !== undefined) tt.scrollTop = scroll;
        else if (tt) scrollToNow(tt, c.nowM);
      }
    }
    root.classList.toggle("side", side);
    root.dataset.view = view;
    // 「오늘로」 shows only when today is not on screen.
    const showsToday = view === "memo" || (view === "day" ? ymd(cur) === c.today : view === "week" ? Math.abs(addDays(cur, -cur.getDay()).getTime() - addDays(parseDay(c.today), -parseDay(c.today).getDay()).getTime()) < 864e5 / 2 : cur.getMonth() === c.now.getMonth() && cur.getFullYear() === c.now.getFullYear());
    root.querySelectorAll<HTMLElement>(".today[data-nav]").forEach((b) => (b.hidden = showsToday));
    root.classList.toggle("panel-closed", sideCapable && !sidePref && wideEnough());
    // Desktop, too narrow for the panel: the chat slides in from the right (takes no width).
    root.classList.toggle("drawer", sideCapable && !side);
    root.style.setProperty("--panel-w", `${panelW}px`);
    root.classList.toggle("chat-open", chatOpen && !side);
    root.querySelector("#bhChat")?.classList.toggle("open", chatOpen || side);
    try {
      localStorage.setItem("bh-view", view);
    } catch {
      /* not kept */
    }
    const conn = root.querySelector<HTMLElement>("[data-testid=connection]");
    const state = quietState();
    if (conn) {
      conn.textContent = adapter.connection.label + (state ? ` · ${state}` : "");
      conn.classList.toggle("warn", !!state);
    }
    renderLast();
    if (chatOpen || side) renderChat();
    renderPop();
    const checks = root.querySelector<HTMLElement>("#bhChecks");
    if (checks) checks.innerHTML = side ? checksBar(c, t.fd) : "";
    if (settingsOpen) renderSettings();
  }

  const resultCardFor = (id: string) => resultCard(ctx(), id, theme().fd, false, "pop").replace('<div class="ra">', '<div class="ra on">');

  /** A bar on the day band (or a row in the 공문서 table) was clicked: its card, with all its buttons. */
  function renderPop(): void {
    const el = root.querySelector<HTMLElement>("#bhPop");
    if (!el) return;
    const x = popId ? findEntry(s, popId.id) : undefined;
    if (!x || x.gone) {
      popId = null;
      el.hidden = true;
      return;
    }
    el.innerHTML = resultCardFor(x.id);
    el.style.left = `${Math.max(8, Math.min(popId!.x, root.clientWidth - 300))}px`;
    el.style.top = `${popId!.y}px`;
    el.hidden = false;
  }

  function scrollToNow(el: HTMLElement, nowM: number): void {
    const row = el.querySelectorAll<HTMLElement>(".tt .h")[Math.max(0, Math.floor(nowM / 60) - 8)];
    if (row && el.scrollHeight > el.clientHeight) el.scrollTop = row.offsetTop - 4;
  }

  /** Week/month drag: a new day and time (or all day) for an appointment or a deadline. */
  function fcMoved(id: string, start: Date, end: Date | null, allDay: boolean): void {
    const x = findEntry(s, id);
    if (!x || (x.kind !== "event" && x.kind !== "task")) return;
    const t = allDay ? false : { start: nowHM(start), end: x.kind === "event" && end ? nowHM(end) : undefined };
    retime(id, ymd(start), t);
  }

  function openDay(k: string): void {
    cur = parseDay(k);
    view = "day";
    render();
  }

  /* ---------- settings ---------- */

  /**
   * 설정 (정리안, 사용자 선택): group names with a one-line summary; only the clicked group opens.
   * Explanations sit behind ⓘ (hover); warnings stay visible in the open group.
   */
  /** 설정 → 루틴: 이름 · 시간 · 반복(매일/평일/요일), 지우기; 맨 아래 한 줄로 추가. */
  function routineRows(): string {
    const DAYS = "일월화수목금토";
    const row = (r: Routine) => {
      const kind = r.repeat === "daily" ? "daily" : r.repeat === "weekdays" ? "weekdays" : "days";
      const days = Array.isArray(r.repeat) ? r.repeat : [];
      return `<div class="set-row rtset"><input class="tin w2" data-rtf="${r.id}|title" value="${escapeHtml(r.title)}" aria-label="루틴 이름"><input class="tin" data-rtf="${r.id}|at" value="${r.at}" aria-label="시간">
        <select data-rtf="${r.id}|repeat" aria-label="반복"><option value="daily" ${kind === "daily" ? "selected" : ""}>매일</option><option value="weekdays" ${kind === "weekdays" ? "selected" : ""}>평일</option><option value="days" ${kind === "days" ? "selected" : ""}>요일 고르기</option></select>
        ${kind === "days" ? `<span class="rtdays">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="${days.includes(d) ? "on" : ""}" data-rtday="${r.id}|${d}" aria-pressed="${days.includes(d)}">${DAYS[d]}</button>`).join("")}</span>` : ""}
        <button class="ib" data-rtdel="${r.id}" title="지우기" aria-label="${escapeHtml(r.title)} 지우기">${ICON.x}</button></div>`;
    };
    return `${s.routines.filter((r) => !r.gone).sort((a, b) => a.at.localeCompare(b.at)).map(row).join("")}
      <div class="set-row rtset"><input class="tin w2" data-rtnew placeholder="+ 「매일 8시 20분 메일 확인」 · Enter" aria-label="새 루틴"></div>
      <div class="set-note">대화창에 「평일 16시 10분 업무일지 루틴」처럼 써도 됩니다. 오늘 화면 오른쪽에서 체크하면 연속 일수가 쌓입니다.</div>`;
  }

  function renderSettings(): void {
    const el = root.querySelector<HTMLElement>("#bhSettings")!;
    const st = s.settings;
    const look = `<label class="set-row">테마 <select data-set="theme"><option value="glass" ${st.theme === "glass" ? "selected" : ""}>유리</option><option value="doc" ${st.theme === "doc" ? "selected" : ""}>공문서</option></select></label>
      ${st.theme === "glass" ? `<label class="set-row">밝기 <select data-set="mode"><option value="dark" ${st.mode === "dark" ? "selected" : ""}>어둡게</option><option value="light" ${st.mode === "light" ? "selected" : ""}>밝게</option></select></label>
      <label class="set-row">흐림 <input type="range" min="0" max="40" step="1" value="${st.glassBlur}" data-set="glassBlur" aria-label="유리 흐림 정도"><span class="set-v">${st.glassBlur}</span></label>
      <label class="set-row">배경 밝기 <input type="range" min="-50" max="50" step="5" value="${st.glassBright}" data-set="glassBright" aria-label="배경·카드 밝기"><span class="set-v">${st.glassBright > 0 ? "+" : ""}${st.glassBright}</span></label>
      ${st.glassBlur !== 26 || st.glassBright !== 0 ? '<div class="set-row"><button class="mini" data-lookreset>처음 모습으로</button></div>' : ""}` : ""}
      ${adapter.recordAction ? "" : `<label class="set-row"><input type="checkbox" data-set="samples" ${st.showSamples ? "checked" : ""}> 가짜 자료 보이기</label>`}`;
    const inboxPart = `${inbox.available ? `<label class="set-row"><input type="checkbox" data-set="inbox" ${inbox.enabled ? "checked" : ""}> 인박스 처리(휴대폰·드라이브에서 온 것 정리)</label>` : ""}
      ${inbox.available ? `<label class="set-row">폴더 <select data-set="inboxRoot"><option value="" ${st.inboxRoot ? "" : "selected"}>시험 폴더</option>${inbox.driveRoot ? `<option value="drive" ${st.inboxRoot ? "selected" : ""}>드라이브 「블랙홀」</option>` : ""}</select></label>` : ""}
      ${inbox.available ? `<div class="set-note">${st.inboxRoot ? "드라이브 「블랙홀」 폴더 · 넣은 원본은 지우지 않음" : "시험 폴더(이 Mac 안)"} · ${escapeHtml(inbox.root)}</div>${inbox.lastError ? `<div class="set-note"><span class="warn">${escapeHtml(inbox.lastError)}</span></div>` : ""}` : ""}
      ${adapter.publishShared ? `<label class="set-row"><input type="checkbox" data-set="sharePhone" ${st.sharePhone ? "checked" : ""} ${inbox.driveRoot ? "" : "disabled"}> 휴대폰과 달력 공유</label>
      <div class="set-note">${inbox.driveRoot ? `드라이브 「블랙홀/달력.json」에 일정 사본을 쓰고, 휴대폰에서 바꾼 것을 받아 반영합니다.${shareLine ? ` ${escapeHtml(shareLine)}` : ""}` : "드라이브 「블랙홀」 폴더가 없어 쓸 수 없습니다."}</div>` : ""}
      ${adapter.messenger && messenger?.configured ? `<label class="set-row"><input type="checkbox" data-set="messenger" ${st.messengerEnabled ? "checked" : ""}> 디스코드·슬랙 입력</label>
      <div class="set-note">지정한 채널의 내 메시지를 30초마다 인박스로 가져옵니다. 지금까지 ${messenger.written}개${messenger.lastError ? `</div><div class="set-note"><span class="warn">${escapeHtml(messenger.lastError)}</span>` : ""}</div>` : ""}
      ${adapter.googleCalendars ? gcalBlock() : ""}
      ${adapter.board && board ? `<label class="set-row"><input type="checkbox" data-board="lock" ${board.lock ? "checked" : ""}> 잠금화면 배경을 블랙홀 달력으로</label>
      <label class="set-row"><input type="checkbox" data-board="hideSchool" ${board.hideSchool ? "checked" : ""}> 위젯·잠금화면에서 학교 일정 제목 가리기</label>
      ${adapter.setBoardLook ? `<label class="set-row">위젯·잠금화면 밝기 <input type="range" min="-50" max="50" step="5" value="${board.bright ?? 0}" data-board="bright" aria-label="위젯·잠금화면 밝기"><span class="set-v">${board.bright ?? 0}</span></label>
      <label class="set-row">판 불투명도 <input type="range" min="0" max="150" step="10" value="${board.opacity ?? 100}" data-board="opacity" aria-label="위젯·잠금화면 판 불투명도"><span class="set-v">${board.opacity ?? 100}%</span></label>` : ""}
      ${adapter.setLockTasks ? `<label class="set-row"><input type="checkbox" data-board="lockTasks" ${board.lockTasks !== false ? "checked" : ""}> 잠금화면 알림에 오늘 할 일·마감(「완료」 체크)</label>
      <label class="set-row"><input type="checkbox" data-board="lockHideTitles" ${board.lockHideTitles ? "checked" : ""}> 잠금화면 알림에서 할 일 제목 가리기</label>` : ""}
      ${adapter.pinWidget ? '<div class="set-row"><button class="mini" data-pinwidget>홈 화면에 블랙홀 위젯 추가</button></div>' : ""}
      ${adapter.openRecording ? '<div class="set-g">휴대폰에서 넣기</div><div class="set-row">녹음 대기 · 녹음 기록 · Google 연결 <button class="mini" data-openrec>열기</button></div><div class="set-note">음량 단추·잠금 화면에서 바로 녹음하는 설정입니다(예전 첫 화면).</div>' : ""}
      <div class="set-note">잠금화면 배경은 켜면 지금 배경을 바꿉니다. 잠금 상태에서는 「완료」 체크와 「적기」까지만 됩니다.</div>${board.status ? `<div class="set-note"><span class="warn">${escapeHtml(board.status)}</span></div>` : ""}` : ""}`;
    const strip = (h: string) => h.replace(/<div class="set-sep"><\/div>/g, "").replace(/<div class="set-g">[^<]*<\/div>/g, "");
    const desk2 = adapter.desk ? strip(deskBlock()) : "";
    // The alarm sound row moves to 「알람」.
    const soundRow = /<label class="set-row">알람 소리[\s\S]*?<\/label>/.exec(desk2)?.[0] ?? "";
    const groups = [
      { id: "look", name: "화면", sum: st.theme === "glass" ? `유리 · ${st.mode === "dark" ? "어둡게" : "밝게"}` : "공문서", body: look },
      ...(adapter.claude ? [{ id: "ai", name: "AI", sum: claude ? (claude.analyzer === "local" ? "로컬 모델" : `${modelName(claude.model)} · ${claude.hasKey ? `이번 달 ${Math.round(claude.monthUsd * 1400).toLocaleString("ko-KR")}원` : "키 없음"}`) : "", body: strip(claudeBlock()) }] : []),
      ...(inbox.available || adapter.publishShared || adapter.board || adapter.googleCalendars ? [{ id: "inbox", name: adapter.board ? "휴대폰" : "인박스 · 휴대폰", sum: inbox.available ? `${inbox.enabled ? "켜짐" : "꺼짐"}${inbox.lastScanAt ? ` · ${inbox.lastScanAt.slice(11, 16)} 확인` : ""}${st.sharePhone ? " · 공유" : ""}` : "", body: inboxPart }] : []),
      ...(adapter.desk ? [{ id: "mac", name: "단축키 · 시작", sum: desk ? (desk.settings.shortcuts.quick ? desk.pretty.quick : "단축키 끔") : "", body: desk2.replace(soundRow, "") }] : []),
      ...(adapter.desk ? [{ id: "widget", name: "위젯", sum: desk ? `${desk.settings.board ? (desk.settings.boardSize === "large" ? "큰 위젯" : "작은 위젯") : "꺼짐"}${desk.settings.mainWidget ? " · 전체 창도" : ""} · ${{ desktop: "바탕화면에", top: "항상 위", peek: "단축키로 잠깐" }[desk.settings.boardMode ?? "desktop"]}` : "", body: desk ? `<label class="set-row"><input type="checkbox" data-desk="board" ${desk.settings.board ? "checked" : ""}> 위젯 켜기</label>
        <label class="set-row">크기 <select data-desk="boardSize"><option value="small" ${desk.settings.boardSize !== "large" ? "selected" : ""}>작게(320×400)</option><option value="large" ${desk.settings.boardSize === "large" ? "selected" : ""}>크게(820 · 칸 네 개 · 타이머)</option></select></label>
        <label class="set-row"><input type="checkbox" data-desk="mainWidget" ${desk.settings.mainWidget ? "checked" : ""}> 프로그램 큰 화면도 위젯처럼(바탕화면에 붙이기)</label>
        <label class="set-row">표시 방식 <select data-desk="boardMode"><option value="desktop" ${(desk.settings.boardMode ?? "desktop") === "desktop" ? "selected" : ""}>바탕화면에(다른 창 아래)</option><option value="top" ${desk.settings.boardMode === "top" ? "selected" : ""}>항상 위</option><option value="peek" ${desk.settings.boardMode === "peek" ? "selected" : ""}>단축키로 잠깐 앞으로</option></select></label>
        <div class="set-note">모든 데스크톱에 보입니다. 위치·크기는 기억합니다. ${escapeHtml(desk.pretty.widget || "⌃⌥⌘W")}를 누르면 위젯이 잠깐 맨 앞으로 옵니다(단축키는 「단축키 · 시작」에서 바꿈).</div>` : "" }] : []),
      { id: "school", name: "학교 시간", sum: `${st.onWork}–${st.offWork} · 점심 ${st.lunch.replace("-", "–")}`, body: `<div class="set-row">출근 <input class="tin" data-time="onWork" value="${st.onWork}"> 퇴근 <input class="tin" data-time="offWork" value="${st.offWork}"></div>
        <div class="set-row">점심 <input class="tin w2" data-time="lunch" value="${st.lunch}"></div>
        <div class="pgrid">${st.periods.map((p, i) => `<label>${i + 1}교시 <input class="tin w2" data-period="${i}" value="${p}"></label>`).join("")}</div>
        <div class="set-row">끝 없는 일정 기본 길이 <input class="tin" data-time="eventMinutes" value="${st.eventMinutes}" style="width:44px">분</div>
        <label class="set-row"><input type="checkbox" data-set="showPeriods" ${st.showPeriods ? "checked" : ""}> 하루표에 교시 구간 옅게</label>
        <div class="set-note">「퇴근 전」 「출근 전」 「점심시간에」 「3교시 전/에/끝나고」를 이 시간으로 읽습니다. 24시간(예: 08:50-09:35).</div>` },
      { id: "routine", name: "루틴", sum: `${s.routines.filter((r) => !r.gone).length}개`, body: routineRows() },
      { id: "alarm", name: "알람", sum: desk?.settings.alarmSound ?? "", body: `${soundRow}<div class="set-row"><button class="mini" data-testalarm>알람 시험 (1분 뒤)</button>${adapter.desk ? '<button class="mini" data-guide>처음 쓰기 안내</button>' : ""}</div>` }
    ];
    const info = (body: string) => {
      // Plain explanations go behind ⓘ; warnings stay in the body.
      const notes: string[] = [];
      const rest = body.replace(/<div class="set-note"[^>]*>([\s\S]*?)<\/div>/g, (m, inner: string) => {
        // Warnings and live numbers (이번 달 사용량, 연결 확인 결과) stay in sight.
        if (inner.includes('class="warn"') || /이번 달|확인 중|연결됨|저장했습니다|지웠습니다/.test(inner)) return m;
        const text = inner.replace(/<br>/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (text) notes.push(text.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
        return "";
      });
      return { rest, notes };
    };
    el.innerHTML = `<div class="set-h">설정 <span class="set-i" title="${escapeHtml(adapter.connection.detail)}" aria-label="${escapeHtml(adapter.connection.detail)}">ⓘ</span><span class="sp"></span><button class="ib" data-settings title="닫기 (Esc)" aria-label="설정 닫기">${ICON.x}</button></div>
      ${groups.map((g) => {
        const open = setGroup === g.id;
        const { rest, notes } = info(g.body);
        return `<div class="set-gr ${open ? "open" : ""}"><button class="set-gh" data-setg="${g.id}" aria-expanded="${open}"><span>${g.name}</span><span class="set-sum">${escapeHtml(g.sum)}</span><span class="chev">${open ? "▾" : "▸"}</span></button>${open ? `<div class="set-gb">${notes.length ? `<div class="set-row"><span class="set-i" title="${escapeHtml(notes.join("\n"))}" aria-label="${escapeHtml(notes.join(" "))}">ⓘ 설명</span></div>` : ""}${rest}</div>` : ""}</div>`;
      }).join("")}`;
    el.hidden = false;
  }

  /** Claude API key (stored in the macOS keychain; the page only knows whether one exists). */
  function claudeBlock(): string {
    if (!claude) return '<div class="set-sep"></div><div class="set-note">AI 설정을 읽는 중…</div>';
    const usd = claude.monthUsd;
    const won = Math.round(usd * 1400);
    const local = claude.analyzer === "local";
    return `<div class="set-sep"></div>
      <div class="set-g">AI 다듬기 · ${local ? "로컬 모델" : escapeHtml(modelName(claude.model))}</div>
      ${local ? "" : claude.hasKey
        ? `<div class="set-row">Claude API 키 저장됨(키체인) <button class="mini" data-claude="check">연결 확인</button><button class="mini" data-claude="clear">키 지우기</button></div>`
        : `<label class="set-row">Claude API 키 <input type="password" data-claude-key autocomplete="off" spellcheck="false" placeholder="sk-ant-…" aria-label="Claude API 키 붙여넣기"></label>
           <div class="set-row"><button class="mini" data-claude="save">키 저장</button></div>`}
      ${local || !adapter.setClaudeOptions ? "" : `<label class="set-row">월 예산 $<input type="number" min="0" max="100" step="0.5" value="${claude.budgetUsd ?? 3}" data-claude-opt="budget" aria-label="이번 달 AI 예산(달러)" style="width:64px"></label>
      <label class="set-row"><input type="checkbox" data-claude-opt="skip" ${claude.skipSimple !== false ? "checked" : ""}> 간단한 문장은 AI 생략(날짜·시각·제목이 분명한 약속 하나)</label>`}
      <div class="set-note">${local ? "worker-config.json의 analyzer를 \"claude\"로 두면 Claude로 돌아갑니다." : `키는 이 Mac의 키체인에만 둡니다. 예산을 넘으면 AI를 멈추고 초안만 넣습니다.<br>이번 달 ${claude.monthRequests}회 · 대략 $${usd.toFixed(usd < 1 ? 3 : 2)}(약 ${won.toLocaleString("ko-KR")}원)${claude.month && (claude.month.skippedCache + claude.month.skippedRule + claude.month.skippedShort + claude.month.skippedBudget) ? ` · 부르지 않음 ${claude.month.skippedRule + claude.month.skippedCache + claude.month.skippedShort + claude.month.skippedBudget}회` : ""}`}${claudeLine ? `<br>${escapeHtml(claudeLine)}` : ""}</div>`;
  }

  async function claudeAction(what: string): Promise<void> {
    try {
      if (what === "save") {
        const el = root.querySelector<HTMLInputElement>("[data-claude-key]");
        const key = el?.value.trim() ?? "";
        if (el) el.value = "";
        if (!key) return;
        claude = await adapter.setClaudeKey!(key);
        claudeLine = "키를 저장했습니다. 「연결 확인」으로 확인해 보세요.";
      } else if (what === "clear") {
        claude = await adapter.clearClaudeKey!();
        claudeLine = "키를 지웠습니다.";
      } else if (what === "check") {
        claudeLine = "확인 중…";
        renderSettings();
        claudeLine = await adapter.checkClaude!();
      }
    } catch (e) {
      claudeLine = friendlyError(e);
    }
    if (settingsOpen) renderSettings();
  }

  /** Mac: login item, shortcuts, alarm sound. */
  function deskBlock(): string {
    if (!desk) return '<div class="set-sep"></div><div class="set-note">Mac 설정을 읽는 중…</div>';
    const d = desk.settings;
    // A key field like System Settings: click it, press the new keys; Delete turns it off.
    const sc = (k: "quick" | "clipboard" | "capture" | "widget", label: string) =>
      `<label class="set-row">${label} <input class="kbd push" data-desk-sc="${k}" value="${escapeHtml(d.shortcuts[k] ? desk!.pretty[k] ?? "" : "끔")}" readonly aria-label="${label} 단축키. 누른 뒤 새 키를 누르면 바뀌고, Delete는 끄기" title="눌러서 새 단축키 누르기 · Delete 끄기"></label>`;
    return `<div class="set-sep"></div><div class="set-g">Mac</div>
      <label class="set-row"><input type="checkbox" data-desk="autostart" ${desk.autostartOn ? "checked" : ""}> 로그인하면 블랙홀 켜기(메뉴 막대에만)</label>
      <label class="set-row"><input type="checkbox" data-desk="rightCmd" ${d.rightCmdTwice ? "checked" : ""}> 오른쪽 ⌘ 두 번: 빠른 입력·찾기${d.rightCmdTwice && !desk.accessibility ? ' <button class="mini" data-perm="accessibility">손쉬운 사용 허용</button>' : ""}</label>
      ${sc("quick", "빠른 입력·찾기")}${sc("clipboard", "클립보드 보내기")}${sc("capture", "화면 캡처해 넣기")}${sc("widget", "위젯 잠깐 앞으로")}
      <label class="set-row">알람 소리 <select data-desk="sound">${desk.sounds.map((x) => `<option ${x === d.alarmSound ? "selected" : ""}>${x}</option>`).join("")}</select><button class="mini" data-desk-try>들어 보기</button></label>
      <div class="set-row">Raycast <button class="mini" data-raycast>스크립트 만들기</button></div>
      <div class="set-note">Raycast 설정 → Extensions → Script Commands → Add Directories에서 만든 폴더를 고르면 「블랙홀 넣기·찾기·기억·클립보드」가 생깁니다.<br>창을 닫아도 메뉴 막대의 블랙홀이 인박스·알람을 계속 돌립니다.${desk.problems.length || deskLine ? `<br><span class="warn">${escapeHtml([...desk.problems, deskLine].filter(Boolean).join(" · "))}</span>` : ""}</div>`;
  }

  /** The key field in 설정: the pressed combination becomes the shortcut (Tauri form, by key code). */
  function recordShortcut(e: KeyboardEvent, el: HTMLInputElement): void {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    const k = el.dataset.deskSc as "quick" | "clipboard" | "capture" | "widget";
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
    const glyph = [e.ctrlKey && "⌃", e.altKey && "⌥", e.shiftKey && "⇧", e.metaKey && "⌘"].filter(Boolean).join("");
    if (e.key === "Escape") return el.blur();
    if (!mods.length && (e.key === "Backspace" || e.key === "Delete")) {
      el.blur();
      return void saveDesk((d) => (d.shortcuts[k] = ""));
    }
    const key = shortcutKey(e.code);
    if (!key) {
      el.value = glyph ? `${glyph}…` : "키를 누르세요";
      return;
    }
    if (!mods.some((m) => m !== "Shift")) {
      el.value = "⌃·⌥·⌘ 중 하나와 함께";
      return;
    }
    el.blur();
    void saveDesk((d) => (d.shortcuts[k] = [...mods, key].join("+")));
  }

  async function saveDesk(change: (d: DeskStatus["settings"]) => void): Promise<void> {
    if (!desk || !adapter.setDesk) return;
    const next = structuredClone(desk.settings);
    change(next);
    try {
      desk = await adapter.setDesk(next);
      deskLine = "";
    } catch (e) {
      deskLine = friendlyError(e);
    }
    if (settingsOpen) renderSettings();
    if (guideOpen) renderGuide();
  }

  /** First start (Mac): everything that may stop the user, once, in one place. */
  function renderGuide(): void {
    const el = root.querySelector<HTMLElement>("#bhGuide");
    if (!el) return;
    if (!guideOpen) {
      el.hidden = true;
      return;
    }
    const p = desk?.pretty;
    const line = (k: string) => (guideLines[k] ? `<span class="set-v">${escapeHtml(guideLines[k])}</span>` : "");
    const keyOk = claude ? (claude.hasKey ? "Claude 키 있음" : "Claude 키 없음 — 설정에서 넣으면 AI 다듬기가 켜집니다(없어도 초안은 들어감)") : "";
    el.innerHTML = `<div class="set-h">처음 쓰기 <button class="mini" data-guide-close>다 봤어요</button></div>
      <div class="set-row"><b>넣는 법</b></div>
      <div class="set-note">입력칸에 쓰고 Enter · 파일을 창이나 Dock 아이콘에 끌어 놓기 · 사진은 입력칸에 ⌘V${p ? `<br>어디서든 오른쪽 ⌘ 두 번(또는 ${escapeHtml(p.quick)}) 빠른 입력·찾기 · ${escapeHtml(p.clipboard)} 클립보드 보내기 · ${escapeHtml(p.capture)} 화면 일부 캡처` : ""}<br>빠른 입력창: Enter 넣기 · ⌘Enter 기억으로 저장 · ⇧Enter 내 기록에 묻기 · 비밀번호는 키체인에만 저장됩니다.<br>메뉴 막대의 블랙홀 아이콘을 눌러도 열립니다.</div>
      <div class="set-sep"></div>
      <div class="set-row"><b>허용할 것</b></div>
      <div class="set-row">알림 <button class="mini" data-perm="notify">시험 알림 보내기</button><button class="mini" data-perm="notifications">설정 열기</button>${line("notify")}</div>
      <div class="set-row">마이크(말하기) <button class="mini" data-perm="mic">허용 묻기</button>${line("mic")}</div>
      <div class="set-row">음성 인식(녹음 받아쓰기) <button class="mini" data-perm="speech">허용 묻기</button>${line("speech")}</div>
      <div class="set-row">화면 기록(캡처해 넣기) <button class="mini" data-perm="screen">설정 열기</button></div>
      <div class="set-row">손쉬운 사용(오른쪽 ⌘ 두 번) ${desk?.accessibility ? '<span class="set-v">허용됨</span>' : '<button class="mini" data-perm="accessibility">설정 열기</button>'}</div>
      <div class="set-note">거절했거나 나중에 바꾸려면 시스템 설정 → 개인정보 보호 및 보안에서 블랙홀을 켜면 됩니다(이 안내는 설정 → 「처음 쓰기 안내」로 다시 열 수 있음). 손쉬운 사용은 오른쪽 ⌘ 두 번에만 필요하고, 다른 단축키는 권한 없이 동작합니다.</div>
      <div class="set-sep"></div>
      <label class="set-row"><input type="checkbox" data-desk="autostart" ${desk?.autostartOn ? "checked" : ""}> 로그인하면 블랙홀 켜기(메뉴 막대에만)</label>
      <div class="set-row"><button class="mini" data-testalarm>알람 시험 (1분 뒤)</button></div>
      <div class="set-note">${escapeHtml(keyOk)}${inbox.available && !inbox.enabled ? "<br>휴대폰에서 보낸 것을 받으려면 설정 → 인박스 처리를 켜고 폴더를 「드라이브 블랙홀」로 고르세요." : ""}</div>`;
    el.hidden = false;
  }

  async function permission(what: string): Promise<void> {
    try {
      if (what === "notify") {
        adapter.notifyTest?.();
        guideLines.notify = "알림이 안 보이면 「설정 열기」에서 블랙홀 알림을 켜 주세요";
      } else if (what === "mic") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        guideLines.mic = "허용됨";
      } else if (what === "speech") {
        guideLines.speech = "묻는 중…";
        renderGuide();
        guideLines.speech = (await adapter.speechPermission?.()) ?? "";
      } else if (what === "notifications" || what === "screen" || what === "accessibility") {
        adapter.openPrivacy?.(what);
      }
    } catch (e) {
      guideLines[what] = friendlyError(e);
      if (what === "mic") adapter.openPrivacy?.("microphone");
    }
    renderGuide();
  }

  /** Stage 4 on the phone: mirror into a provisional and a main Google calendar. */
  function gcalBlock(): string {
    if (!gcal) return '<div class="set-sep"></div><div class="set-note">캘린더 목록을 읽는 중…</div>';
    const opts = (sel: string) => `<option value="">고르기</option>${gcal!.calendars.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === sel ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}`;
    return `<div class="set-sep"></div>
      <label class="set-row"><input type="checkbox" data-gcal="enabled" ${gcal.enabled ? "checked" : ""}> 구글 캘린더에 반영</label>
      <label class="set-row">가승인 <select data-gcal="provisional">${opts(gcal.provisional)}</select></label>
      <label class="set-row">본 캘린더 <select data-gcal="main">${opts(gcal.main)}</select></label>
      <div class="set-note">가승인 일정은 가승인 캘린더에, 확정한 일정과 기간은 본 캘린더에 넣습니다. 블랙홀이 넣은 일정만 고치거나 지웁니다.${gcal.permission ? "" : "<br>켜면 캘린더 권한을 묻습니다."}${gcal.status ? `<br>${escapeHtml(gcal.status)}` : ""}</div>`;
  }

  async function refreshInbox(): Promise<void> {
    if (adapter.setMessenger && s.settings.messengerEnabled) void adapter.setMessenger(true).catch(() => undefined);
    inbox = await adapter.inboxStatus().catch(() => inbox);
    const wantRoot = s.settings.inboxRoot ?? inbox.testRoot ?? inbox.root;
    if (inbox.available && (inbox.enabled !== s.settings.inboxEnabled || inbox.root !== wantRoot) && !inbox.running) {
      inbox = await adapter.setInbox(s.settings.inboxEnabled, s.settings.inboxRoot).catch(() => inbox);
    }
  }

  async function pullPhoneActions(): Promise<void> {
    if (!adapter.phoneActions || !s.settings.sharePhone) return;
    const actions = await adapter.phoneActions().catch(() => []);
    const now = clock();
    let n = 0;
    for (const a of actions) if (applyAction(s, a, now)) n++;
    if (n) {
      log(s, { label: "휴대폰", msg: `휴대폰에서 바꾼 것 ${n}건 반영`, src: "휴대폰" }, now);
      await save();
      syncAlarms();
      render();
    }
  }

  async function pullInbox(): Promise<void> {
    if (!inbox.available) return;
    const before = inbox.lastScanAt;
    inbox = await adapter.inboxStatus().catch(() => inbox);
    const results = await adapter.inboxResults().catch(() => []);
    // A finished scan alone changes nothing to save (only the status line).
    if (before !== inbox.lastScanAt && settingsOpen) renderSettings();
    let changed = false;
    for (const r of results) {
      if (s.ingestedJobs.includes(r.jobId)) continue;
      s.ingestedJobs.push(r.jobId);
      const now = clock();
      if (r.proposal) {
        const drafted = s.draftedJobs.includes(r.jobId);
        const applied = refineDrafts(s, r.jobId, r.proposal, "인박스", now);
        if (applied.duplicate) {
          changed = true;
          continue;
        }
        afterApplied(applied.refs, applied.missing, "인박스", now, applied.updated, applied.suggested);
        s.inbox.push({ at: stamp(now), title: r.fileName, src: "인박스", state: r.proposal.needsReview ? "검토 필요" : "완료", out: `${applied.refs.length}건` });
        if (!drafted) s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: "", kind: "file", fileName: r.fileName, src: "인박스" });
        card(aiText(applied.refs.length, applied.missing.length, r.proposal.reviewReasons, applied), applied.refs.length ? applied.refs : applied.suggested);
      } else {
        s.inbox.push({ at: stamp(now), title: r.fileName, src: "인박스", state: "실패", out: r.error ?? "" });
      }
      changed = true;
    }
    if (changed) {
      await save();
      syncAlarms();
      render();
    }
  }

  /** Mac: inbox files whose words are known (phone text, phone transcript) become drafts at once. */
  async function pullDrafts(): Promise<void> {
    if (!adapter.inboxDrafts || !inbox.available || !s.settings.inboxEnabled) return;
    const list = await adapter.inboxDrafts().catch(() => []);
    let n = 0;
    const skip: string[] = [];
    for (const d of list) {
      if (s.draftedJobs.includes(d.jobId) || s.ingestedJobs.includes(d.jobId) || !d.text.trim()) continue;
      s.draftedJobs.push(d.jobId);
      if (s.draftedJobs.length > 2000) s.draftedJobs.splice(0, s.draftedJobs.length - 2000);
      const now = clock();
      const src = "휴대폰";
      const at = d.at ? new Date(d.at) : now;
      const x = draftFromText(s, d.text, src, at, d.jobId);
      const memo = x.kind === "note" && !x.draft;
      const simple = memo || skipsAi(d.text, at);
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: d.text, kind: d.kind === "voice" ? "voice" : "text", src });
      const line = describe(s, x.id, theme().fd);
      if (simple) {
        // The rule draft is final: the Mac never sends this job to the API.
        x.draft = false;
        skip.push(d.jobId);
        log(s, { label: line.label, msg: line.msg, src, ref: x.id }, now);
        s.inbox.push({ at: stamp(now), title: d.text.slice(0, 40), src, state: "완료", out: "1건" });
        card("", [x.id]);
        if (memo) void adapter.writeMemo?.(d.text, src).catch(() => undefined);
      } else {
        log(s, { label: "초안", msg: line.msg, src, ref: x.id }, now);
        card("다듬는 중…", [x.id]);
      }
      n++;
    }
    if (n) void adapter.inboxDrafted?.(skip).catch(() => undefined);
    if (n) {
      await save();
      syncAlarms();
      render();
    }
  }

  /* ---------- input ---------- */

  /**
   * B-6: a result identical to an entry already there (same kind, title, day, time) is not put in
   * twice — the new copy is marked gone and the existing one is shown. Returns the dropped ids.
   */
  function dropDuplicates(refs: string[]): { gone: string[]; kept: string[] } {
    const mine = new Set(refs);
    const gone: string[] = [];
    const kept: string[] = [];
    for (const d of duplicates(s)) {
      if (mine.has(d.x.id) && !mine.has(d.of.id)) {
        d.x.gone = true;
        gone.push(d.x.id);
        kept.push(d.of.id);
      }
    }
    return { gone, kept };
  }


  /**
   * The chat card for these entries: the draft's card is updated in place when the AI result (or
   * a failure) arrives, so one put-in is one card. Otherwise a new AI message.
   */
  function card(text: string, refs: string[], extra: Partial<ChatMessage> = {}): ChatMessage {
    for (let i = s.chat.length - 1; i >= Math.max(0, s.chat.length - 30) && refs.length; i--) {
      const m = s.chat[i];
      if (m.who === "ai" && !m.hits && m.refs?.some((r) => refs.includes(r))) {
        m.text = text;
        m.refs = [...new Set([...m.refs, ...refs])];
        Object.assign(m, extra);
        return m;
      }
    }
    const m: ChatMessage = { id: newId(s, "c"), at: stamp(clock()), who: "ai", text, refs, ...extra };
    s.chat.push(m);
    return m;
  }

  function aiText(n: number, miss: number, reasons: string[] = [], r?: { updated: string[]; suggested: string[] }): string {
    if (r?.suggested.length && !n) return "손댄 항목이라 그대로 두고 AI 제안만 붙였어요.";
    if (!n && reasons.length) return `넣은 것이 없어요. ※ ${reasons.join(" · ")}`;
    if (!n) return "찾은 것이 없어요. 언제인지 같이 보내 주세요.";
    // Results speak as cards; words only for what the cards cannot say.
    return miss ? `${miss}건은 날짜를 못 찾아 기억으로 두었어요.` : "";
  }

  function afterApplied(refs: string[], missing: string[], src: string, now: Date, updated: string[] = [], suggested: string[] = []): void {
    for (const id of refs) {
      const x = findEntry(s, id);
      // The AI only suggests a ★ (출제·결재·평가·제출 …); the user sets it.
      if (x && (x.kind === "task" || x.kind === "event") && x.star === undefined && /출제|결재|평가|제출|기안|마감|보고서|성적|생기부|생활기록부/.test(x.title)) x.starHint = 1;
      // Every 기억 is also an Obsidian note (all of them, wherever they came from).
      if (x?.kind === "note") void adapter.writeMemo?.(`${x.title}${x.details ? `\n${x.details}` : ""}`, src).catch(() => undefined);
      const d = describe(s, id, theme().fd);
      log(s, { label: updated.includes(id) ? "다듬음" : d.label, msg: d.msg, src, ref: id }, now);
    }
    for (const id of suggested) log(s, { label: "AI 제안", msg: findEntry(s, id)?.title ?? "", src, ref: id }, now);
    for (const t of missing) log(s, { label: "확인 필요", msg: `「${t}」 날짜를 못 찾음`, src }, now);
  }

  /**
   * Draft first, AI later: a sentence goes on the calendar at once from the rule parser, then
   * the AI result replaces that same entry (same id) when it arrives.
   */
  async function analyze(input: AnalyzeInput, me: Omit<ChatMessage, "id" | "at" | "who">, src: string, inboxTitle: string, opts: { noDraft?: boolean } = {}): Promise<void> {
    const t0 = performance.now();
    const now = clock();
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", ...me, src });
    const key = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const drafted = input.text !== undefined && !opts.noDraft;
    let draftMsg: ChatMessage | null = null;
    let draftWas = "";
    let draftId = "";
    if (drafted) {
      const x = draftFromText(s, input.text!, src, now, key);
      log(s, { label: "초안", msg: describe(s, x.id, theme().fd).msg, src, ref: x.id }, now);
      draftMsg = card("다듬는 중…", [x.id]);
      draftWas = JSON.stringify([x.kind, x.title, (x as { date?: string }).date, (x as { start?: string }).start, (x as { end?: string }).end, (x as { due?: string }).due, (x as { dueTime?: string }).dueTime]);
      draftId = x.id;
    }
    busy++;
    renderComposer();
    render();
    if (drafted) {
      lastDraftMs = performance.now() - t0;
      syncAlarms();
      void save();
    }
    try {
      const proposal = await adapter.analyze(input);
      const at = clock();
      const applied = refineDrafts(s, key, proposal, src, at);
      afterApplied(applied.refs, applied.missing, src, at, applied.updated, applied.suggested);
      if (me.kind === "voice" && proposal.sourceText) s.chat[s.chat.length - 1].text = proposal.sourceText;
      const dup = dropDuplicates(applied.refs);
      const shown = [...(applied.refs.length ? applied.refs : applied.suggested).filter((r) => !dup.gone.includes(r)), ...dup.kept];
      let text = dup.gone.length ? "이미 있어서 다시 넣지 않았어요" : aiText(applied.refs.length, applied.missing.length, proposal.reviewReasons, applied);
      // A small note only when the AI changed what the draft said.
      const y = draftId ? findEntry(s, draftId) : undefined;
      if (!text && y && draftWas !== JSON.stringify([y.kind, y.title, (y as { date?: string }).date, (y as { start?: string }).start, (y as { end?: string }).end, (y as { due?: string }).due, (y as { dueTime?: string }).dueTime])) text = "AI가 고침";
      if (draftMsg) Object.assign(draftMsg, { text, refs: [...new Set([...(draftMsg.refs ?? []).filter((r) => !dup.gone.includes(r)), ...shown])] });
      else card(text, shown);
      s.inbox.push({ at: stamp(at), title: inboxTitle, src, state: proposal.needsReview ? "검토 필요" : "완료", out: `${applied.refs.length}건` });
    } catch (e) {
      const at = clock();
      if (e instanceof AnalyzeError && e.code === "QUEUED") {
        // Phone: the Mac refines it later; the draft waits under the upload's job id.
        if (drafted && e.job) {
          rekey(s, key, e.job);
          adapter.keepDrafts?.(draftsOf(s, e.job));
        }
        if (drafted) card("초안으로 넣었어요. Mac이 정리하면 다듬어집니다.", draftsOf(s, e.job ?? key).map((x) => x.id));
        else s.chat.push({ id: newId(s, "c"), at: stamp(at), who: "ai", text: e.message });
        s.inbox.push({ at: stamp(at), title: inboxTitle, src, state: "분석 중", out: "" });
        busy--;
        await save();
        syncAlarms();
        renderComposer();
        render();
        return;
      }
      const msg = e instanceof AnalyzeError ? e.message : friendlyError(e);
      const kept = draftsOf(s, key);
      // No key, no balance, API busy: not a failure of the input. The draft stays as it is.
      const waiting = e instanceof AnalyzeError && WAITING_CODES.includes(e.code);
      for (const x of kept) {
        x.draft = false;
        x.review = [...(x.review ?? []), waiting ? "AI 다듬기 안 함 · 규칙 초안" : "AI 분석 실패 · 규칙으로만 넣음"];
      }
      if (waiting && kept.length) {
        card(`초안으로 넣었어요. AI 다듬기는 하지 못했어요: ${msg}`, kept.map((x) => x.id));
        s.inbox.push({ at: stamp(at), title: inboxTitle, src, state: "검토 필요", out: "초안" });
        busy--;
        await save();
        syncAlarms();
        renderComposer();
        render();
        return;
      }
      if (kept.length) card(`분석하지 못했어요: ${msg} 초안은 그대로 두었어요.`, kept.map((x) => x.id), { error: true });
      else s.chat.push({ id: newId(s, "c"), at: stamp(at), who: "ai", text: `분석하지 못했어요: ${msg}`, error: true });
      log(s, { label: "실패", msg, src }, at);
      s.inbox.push({ at: stamp(at), title: inboxTitle, src, state: "실패", out: msg });
    } finally {
      busy--;
    }
    await save();
    syncAlarms();
    renderComposer();
    render();
  }

  /** 「간단한 문장은 AI 생략」: only where the AI costs money (the Mac), and only when it is on. */
  function skipsAi(text: string, at: Date): boolean {
    return !!adapter.aiSkipped && claude?.skipSimple !== false && claude?.analyzer !== "local" && isSimpleCertain(timeWords(text, s.settings), parseDraft(text, at, s.settings));
  }

  async function submitText(text: string, src = adapter.origin, checked = false, mode?: "put"): Promise<void> {
    const v = text.trim();
    if (!v) return;
    // 「대의원회 18일로 옮겨」 moves; 「매일 8시 20분 메일 확인 루틴」 makes a 루틴 (no AI either way).
    // (Checked synchronously first: the rule draft must appear before the first await.)
    if (!checked && mode !== "put" && MOVE_RE.test(v) && (await moveBySentence(v, src))) return;
    if (!checked && mode !== "put" && addRoutineBySentence(v, src)) return;
    // A question gets an answer from the records; 「내일 3시에 알려줘」 (both) asks once with two buttons.
    if (!checked && mode !== "put") {
      const c = classify(v, clock());
      if (c === "ask") return askQuestion(v);
      if (c === "both") {
        s.chat.push({ id: newId(s, "c"), at: stamp(clock()), who: "ai", text: `「${v}」 — 찾아볼까요, 넣을까요?`, choice: v });
        if (!side) setChat(true);
        await save();
        render();
        return;
      }
    }
    // Secrets never reach the calendar, the chat or the AI (Mac: keychain only).
    if (!checked && adapter.secretIntake) {
      const r = await adapter.secretIntake(v).catch(() => "put" as const);
      if (r === "secret") return toast("비밀로 저장했어요(이 Mac 키체인에만). 빠른 입력창에서 이름으로 찾습니다.");
      if (r === "ask") {
        secretAsk = v;
        renderLast();
        return;
      }
    }
    // Nothing about a day or time (or 「메모 …」): a 기억 at once, no AI, never on the calendar.
    if (memoDraft(v, clock(), s.settings)?.final) return saveMemoText(v, src);
    if (skipsAi(v, clock())) {
      const now = clock();
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: v, kind: "text", src });
      const x = draftFromText(s, v, src, now, `local-${Date.now().toString(36)}`);
      x.draft = false;
      const line = describe(s, x.id, theme().fd);
      log(s, { label: line.label, msg: line.msg, src, ref: x.id }, now);
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: "", refs: [x.id] });
      s.inbox.push({ at: stamp(now), title: v.slice(0, 40), src, state: "완료", out: "1건" });
      adapter.aiSkipped?.("rule");
      toast(`${line.label} · ${line.msg}`, x.id);
      await save();
      syncAlarms();
      renderComposer();
      render();
      return;
    }
    // The AI gets said ranges as clock times (it misread 「1620~2120」 as a whole day).
    await analyze({ text: clockText(v, s.settings), now: clock() }, { text: v, kind: "text" }, src, "문장");
  }

  /** The local index over the records (+ secret names and notes from the Mac), rebuilt when stale. */
  async function askIndex(): Promise<AskIndex> {
    if (adapter.askSources && Date.now() - sourcesAt > 60_000) {
      sources = await adapter.askSources().catch(() => sources);
      sourcesAt = Date.now();
      askCache = null;
    }
    if (!askCache || askCache.ver !== dataVer) askCache = { ver: dataVer, idx: new AskIndex(docsOf(s, sources)) };
    return askCache.idx;
  }

  /**
   * 질문하면 답하기: the local index answers clear questions at once (no AI, 0원). Fuzzy ones or a
   * summary go to the AI with only the few lines found (secret names, never values).
   */
  const aiReady = () => !!adapter.askAi && !!claude?.hasKey && !((claude.budgetUsd ?? 0) > 0 && claude.monthUsd >= (claude.budgetUsd ?? 0));
  const hitOfDoc = (d: AskDoc): AskHit => ({ id: d.id, kind: d.kind, title: d.title, when: whenOf(d), where: d.where });

  /**
   * The chat is for putting in and asking the AI: a question goes to the AI with the closest
   * records as its only grounds (names of secrets, never values), and the answer links them.
   * Nothing close → a passing note, not a chat line. No key/budget → the local answer.
   */
  async function askQuestion(q: string, picked?: AskDoc[]): Promise<void> {
    const now = clock();
    const idx = await askIndex();
    const a = answerQuestion(idx, q, now);
    let docs = picked ?? [];
    if (!picked) {
      const ids = new Set(a.hits.map((h) => h.id));
      docs = idx.docs.filter((d) => ids.has(d.id));
      if (!docs.length) docs = idx.find(q, 8).map((x) => x.doc);
    }
    if (!docs.length) return toast(a.mode === "none" && a.text.startsWith("무엇을") ? a.text : "내 기록에서 가까운 것을 찾지 못했어요 · 다른 낱말로 위 찾기 칸에 써 보세요");
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: q, kind: "text", src: "질문" });
    if (!side) setChat(true);
    const hits = docs.slice(0, 12).map(hitOfDoc);
    // Secret names stay here: the AI could only repeat the name, and copying needs Touch ID anyway.
    if (aiReady() && !docs.every((d) => d.kind === "secret")) {
      const m: ChatMessage = { id: newId(s, "c"), at: stamp(now), who: "ai", text: "기록을 보고 정리하는 중…", hits };
      s.chat.push(m);
      busy++;
      render();
      try {
        const r = await adapter.askAi!(q, docs.slice(0, 12).map(lineOf));
        m.text = r.answer || "기록에 없어요.";
        const used = hits.filter((h) => r.ids.includes(h.id));
        m.hits = used.length ? used : hits.slice(0, 3);
      } catch (e) {
        m.text = `AI로 정리하지 못했어요(${friendlyError(e)}) · 가까운 기록입니다`;
      } finally {
        busy--;
      }
    } else {
      const text = a.mode === "local" || docs.every((d) => d.kind === "secret") ? a.text : `가까운 기록${adapter.askAi ? " · AI 키가 없거나 예산을 다 써서 AI 없이 찾은 것" : ""}`;
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text, hits });
    }
    await save();
    render();
  }

  /* ---------- 찾기 칸 (머리줄): 치는 대로, 내 기록에서만, 0원 ---------- */
  let findQ = "";
  let findSel = 0;
  let findDocs: AskDoc[] = [];
  const FIND_ORDER: [string, AskDoc["kind"][]][] = [["기억", ["note"]], ["할 일", ["task"]], ["일정", ["event", "period"]], ["노트", ["obsidian"]], ["비밀 이름", ["secret"]], ["인박스", ["inbox"]]];
  /** One AI question's rough cost in 원, from this month's average (₩1,400 per $, rough). */
  function askCost(): string {
    const n = claude?.monthRequests ?? 0;
    const won = n ? ((claude!.monthUsd ?? 0) / n) * 1400 : 0;
    return !won ? "" : won < 1 ? `약 ${won.toFixed(1)}원` : `약 ${Math.round(won)}원`;
  }
  function renderFind(): void {
    const el = root.querySelector<HTMLElement>("#bhFindRes");
    const box = root.querySelector<HTMLElement>(".find");
    if (!el) return;
    if (!findQ.trim()) {
      el.hidden = true;
      findDocs = [];
      return;
    }
    if (!askCache || askCache.ver !== dataVer) askCache = { ver: dataVer, idx: new AskIndex(docsOf(s, sources)) };
    const found = askCache.idx.find(findQ, 40).map((x) => x.doc);
    findDocs = FIND_ORDER.flatMap(([, kinds]) => found.filter((d) => kinds.includes(d.kind)));
    findSel = Math.max(0, Math.min(findSel, findDocs.length - 1));
    const fd = theme().fd;
    let i = 0;
    const row = (d: AskDoc) => {
      const n = i++;
      const x = findEntry(s, d.id);
      const acts = [
        d.kind === "task" && !d.done ? `<button class="ib" data-fdone="${escapeHtml(d.id)}" title="완료" aria-label="완료">${ICON.ok}</button>` : "",
        x && (d.kind === "event" || d.kind === "task" || d.kind === "period") ? `<button class="ib" data-fmove="${escapeHtml(d.id)}" title="날짜 옮기기" aria-label="날짜 옮기기">${ICON.move}</button>` : "",
        `<button class="ib" data-fcopy="${escapeHtml(d.id)}" title="${d.kind === "secret" ? "복사 (Touch ID)" : "복사"}" aria-label="복사">${ICON.copy}</button>`
      ].join("");
      const when = d.kind === "note" || d.kind === "obsidian" ? fd(d.date) : whenOf(d);
      return `<div class="fr ${n === findSel ? "on" : ""} ${d.done ? "done" : ""}" role="option" aria-selected="${n === findSel}" data-fopen="${escapeHtml(d.id)}" data-fi="${n}"><span class="ft">${escapeHtml(d.title)}</span><span class="fw">${escapeHtml(when)} · ${escapeHtml(d.where)}</span><span class="fa">${acts}</span></div>`;
    };
    const groups = FIND_ORDER.map(([name, kinds]) => {
      const g = findDocs.filter((d) => kinds.includes(d.kind));
      return g.length ? `<div class="fg">${name}<span>${g.length}</span></div>${g.map(row).join("")}` : "";
    }).join("");
    const cost = askCost();
    el.innerHTML = `${groups || '<div class="fnone">내 기록에서 찾지 못했어요</div>'}
      ${adapter.askAi ? `<button class="fask" data-fask ${claude?.hasKey ? "" : "disabled"}>${ICON.chat}<span>AI에게 묻기${findDocs.length ? ` · 위 ${Math.min(findDocs.length, 12)}개를 근거로` : ""}</span><small>${claude?.hasKey ? cost || "한 번" : "Claude 키 없음"}</small></button>` : ""}`;
    if (box) {
      const r = box.getBoundingClientRect();
      const base = root.getBoundingClientRect();
      el.style.top = `${r.bottom - base.top + 6}px`;
      el.style.left = `${Math.max(8, Math.min(r.left - base.left, base.width - 448))}px`;
    }
    el.hidden = false;
  }
  function closeFind(clear = false): void {
    if (clear) {
      findQ = "";
      const inp = root.querySelector<HTMLInputElement>("#bhFind");
      if (inp) inp.value = "";
    }
    root.querySelector<HTMLElement>("#bhFindRes")?.setAttribute("hidden", "");
  }
  async function findOpen(id: string): Promise<void> {
    const d = findDocs.find((x) => x.id === id);
    if (!d) return;
    if (d.kind === "secret") return findCopy(id);
    closeFind();
    if (d.kind === "obsidian") return void adapter.openNote?.(id.replace(/^obsidian:/, "")).catch((e: unknown) => toast(friendlyError(e)));
    if (d.kind === "note") {
      memoQuery = d.title;
      view = "memo";
      return render();
    }
    if (d.kind === "inbox") return;
    picked = id;
    view = "day";
    cur = parseDay(d.date);
    render();
    const el = root.querySelector<HTMLElement>(`#bhMain [data-ev="${id.replace(/["\\]/g, "\\$&")}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    const r = el.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    popId = { id, x: r.left - base.left, y: r.bottom - base.top + 4 };
    renderPop();
  }
  async function findCopy(id: string): Promise<void> {
    const d = findDocs.find((x) => x.id === id);
    if (!d) return;
    if (d.kind === "secret") {
      if (!adapter.secretCopy) return toast("비밀은 Mac 앱에서만 복사할 수 있어요");
      toast("Touch ID로 확인해 주세요…");
      return void adapter.secretCopy(id.replace(/^secret:/, "")).then(() => toast("복사했어요 · 30초 뒤 클립보드에서 지웁니다"), (e: unknown) => toast(friendlyError(e)));
    }
    const text = d.kind === "note" || d.kind === "obsidian" ? `${d.title}${d.text ? `\n${d.text}` : ""}` : `${d.title} (${whenOf(d)})`;
    await navigator.clipboard?.writeText(text).then(() => toast("복사했어요"), () => toast("복사하지 못했어요"));
  }

  /** 수정 on a card: title, day and time in place (Mac). One ⌘Z puts it back. */
  function saveEdit(key: string): void {
    const id = key.slice(key.indexOf("|") + 1);
    const x = findEntry(s, id);
    const el = [...root.querySelectorAll<HTMLElement>("[data-editing]")].find((e) => e.dataset.editing === key);
    if (!x || !el) return;
    const val = (sel: string) => el.querySelector<HTMLInputElement>(sel)?.value.trim() ?? "";
    const t = timeField(val(".ed-h"));
    if (t === undefined) return toast("시각을 알아보지 못했어요 · 예: 1620, 16:20~17:30");
    editing = null;
    retime(x.id, val(".ed-d") || null, t, val(".ed-t"), "수정");
  }

  /**
   * The time box in a card: 「1620」 「16:20」 「16:20~17:30」 「1620-1730」 「오후 3시」 → start/end
   * (24-hour). Empty → no time (all day / no deadline time). Not a time → undefined.
   */
  function timeField(v: string): { start: string; end?: string } | null | undefined {
    if (!v) return null;
    const w = timeWords(v, s.settings);
    const r = timeRange(w);
    if (r) return { start: r.start, end: r.end };
    const one = singleTime(w);
    if (one) return { start: one.time };
    const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(w.trim());
    if (m && +m[1] < 24 && +(m[2] ?? 0) < 60) return { start: `${pad(+m[1])}:${m[2] ?? "00"}` };
    const p = parseDraft(`오늘 ${w}`, clock(), s.settings);
    return p.hasTime && p.time ? { start: p.time, end: p.end } : undefined;
  }

  /**
   * One way to change when something is (card edit, a dragged bar, ↑↓): day and/or time, the
   * reminders follow by the same shift, the entry is 「touched」 (the AI never overwrites it).
   * Saved at once, one ⌘Z / 되돌리기 puts it back.
   */
  function retime(id: string, day: string | null, t: { start: string; end?: string } | null | false, title = "", label = "옮김"): void {
    const x = findEntry(s, id);
    if (!x) return;
    const before = structuredClone(x);
    if (title) x.title = title.slice(0, 80);
    const shift = (from: string, to: string) => {
      const delta = fromStamp(to).getTime() - fromStamp(from).getTime();
      return (r: string) => stamp(new Date(fromStamp(r).getTime() + delta));
    };
    if (x.kind === "event") {
      const d = day ?? x.date;
      const old = `${x.date}T${x.start ?? "09:00"}`;
      const dur = x.start && x.end ? mins(x.end) - mins(x.start) : s.settings.eventMinutes || 60;
      x.date = d;
      if (t !== false) {
        x.start = t ? t.start : null;
        x.end = t ? t.end ?? hm(Math.min(mins(t.start) + Math.max(dur, 10), 23 * 60 + 59)) : null;
      }
      x.reminders = x.start ? x.reminders.map(shift(old, `${d}T${x.start}`)) : [];
    } else if (x.kind === "task") {
      const d = day ?? x.due;
      const old = `${x.due}T${x.dueTime ?? "09:00"}`;
      x.due = d;
      if (t !== false) x.dueTime = t ? t.start : null;
      x.noDue = false;
      x.reminders = x.reminders.map(shift(old, `${d}T${x.dueTime ?? "09:00"}`));
    } else if (x.kind === "period" && day) {
      const len = Math.round((parseDay(x.to).getTime() - parseDay(x.from).getTime()) / 864e5);
      x.from = day;
      x.to = ymd(addDays(parseDay(day), len));
    }
    x.touched = true;
    x.draft = false;
    x.review = undefined;
    log(s, { label, msg: x.title, src: adapter.origin, ref: x.id }, clock());
    undoStack.push({ label: `「${before.title}」 ${label}`, run: () => {
      const y = findEntry(s, id);
      if (y) {
        for (const k of Object.keys(y)) delete (y as unknown as Record<string, unknown>)[k];
        Object.assign(y, before);
      }
      void act(() => undefined);
    } });
    const w = x.kind === "event" ? `${theme().fd(x.date)} ${x.start ? `${x.start}${x.end ? "–" + x.end : ""}` : "종일"}` : x.kind === "task" ? `${theme().fd(x.due)}${x.dueTime ? " " + x.dueTime : ""}까지` : "";
    toast(label === "옮김" ? `${x.title} → ${w}` : `고쳤어요: 「${x.title}」 ${w}`, undefined, true);
    void act(() => undefined);
  }

  /** ☆ → ★(노랑) → ★(빨강) → ☆, set by hand (the AI only suggests). One ⌘Z. */
  function cycleStar(id: string): void {
    const x = findEntry(s, id);
    if (!x) return;
    const before = x.star ?? 0;
    x.star = ((before + 1) % 3) as 0 | 1 | 2;
    delete x.starHint;
    undoStack.push({ label: `「${x.title}」 별`, run: () => {
      x.star = before as 0 | 1 | 2;
      void act(() => undefined);
    } });
    void act(() => undefined);
  }

  /** A 루틴 done (or not) today. */
  function toggleRoutine(id: string): void {
    const r = s.routines.find((x) => x.id === id);
    if (!r) return;
    const k = ymd(cur);
    r.done = r.done.includes(k) ? r.done.filter((d) => d !== k) : [...r.done, k];
    void act(() => undefined);
  }

  /** 작업 시간: a to-do dragged onto the day table blocks time for it (1 hour, resizable). */
  function blockWork(taskId: string, day: string, at: number): void {
    const t = findEntry(s, taskId);
    if (!t || t.kind !== "task") return;
    const a = Math.max(0, Math.min(Math.round(at / 10) * 10, 23 * 60));
    const ev: CalEvent = { id: newId(s, "e"), kind: "event", title: t.title, area: t.area, source: "하루표", createdAt: stamp(clock()), date: day, start: hm(a), end: hm(Math.min(a + 60, 23 * 60 + 59)), provisional: false, reminders: [], workFor: t.id, touched: true };
    s.events.push(ev);
    undoStack.push({ label: `「${t.title}」 작업 시간`, run: () => {
      ev.gone = true;
      void act(() => undefined);
    } });
    toast(`작업 시간: 「${t.title}」 ${hm(a)}–${ev.end}`, undefined, true);
    void act(() => undefined);
  }

  /** A new appointment drawn on the day table: asks for its title right there. */
  function askNewEvent(day: string, a: number, b: number): void {
    const grid = root.querySelector<HTMLElement>(".dtg");
    if (!grid) return;
    const S = Number(grid.dataset.s);
    const E = Number(grid.dataset.e);
    const top = ((a - S) / (E - S)) * 100;
    const h = ((b - a) / (E - S)) * 100;
    grid.querySelector(".newev")?.remove();
    grid.insertAdjacentHTML("beforeend", `<div class="newev" style="top:${top}%;height:max(26px, ${h}%)"><input placeholder="${hm(a)}–${hm(b)} 일정 이름 · Enter" aria-label="새 일정 이름" data-newev="${day}|${a}|${b}"></div>`);
    grid.querySelector<HTMLInputElement>(".newev input")?.focus();
  }

  function addEventAt(day: string, a: number, b: number, title: string): void {
    const ev: CalEvent = { id: newId(s, "e"), kind: "event", title: title.slice(0, 80), area: "personal", source: "하루표", createdAt: stamp(clock()), date: day, start: hm(a), end: hm(b), provisional: false, reminders: [stamp(new Date(fromStamp(`${day}T${hm(a)}`).getTime() - 30 * 60e3))], touched: true };
    s.events.push(ev);
    undoStack.push({ label: `「${ev.title}」 넣기`, run: () => {
      ev.gone = true;
      void act(() => undefined);
    } });
    log(s, { label: "넣음", msg: `${theme().fd(day)} ${ev.start}–${ev.end} ${ev.title}`, src: "하루표", ref: ev.id }, clock());
    toast(`넣었어요: 「${ev.title}」 ${ev.start}–${ev.end}`, undefined, true);
    void act(() => undefined);
  }

  /** 다른 날로: keeps the time, moves the reminders with it. */
  function moveTo(id: string, day: string): void {
    const x = findEntry(s, id);
    if (!x || (x.kind !== "event" && x.kind !== "task" && x.kind !== "period")) return;
    retime(id, day, false, "", "옮김");
  }

  /** The day a move menu choice means, from the entry's own day. */
  function moveTarget(id: string, how: string): string | null {
    const x = findEntry(s, id);
    if (!x) return null;
    const base = parseDay(x.kind === "event" ? x.date : x.kind === "task" ? x.due : x.kind === "period" ? x.from : ymd(clock()));
    const from = parseDay(ymd(clock())) > base ? parseDay(ymd(clock())) : base;
    if (how === "tomorrow") return ymd(addDays(from, 1));
    if (how === "weekday") {
      let d = addDays(from, 1);
      while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
      return ymd(d);
    }
    if (how === "nextweek") return ymd(addDays(base, 7));
    return /^\d{4}-\d{2}-\d{2}$/.test(how) ? how : null;
  }

  /** 「날짜 옮기기」 menu (right click, or the card's ↦): 내일 · 다음 평일 · 다음 주 같은 요일 · 달력. */
  let ctxMenu: { id: string; month: Date } | null = null;
  function renderCtx(x = 0, y = 0): void {
    const el = root.querySelector<HTMLElement>("#bhCtx");
    if (!el) return;
    if (!ctxMenu) {
      el.hidden = true;
      return;
    }
    const e = findEntry(s, ctxMenu.id);
    if (!e) return;
    const fd = theme().fd;
    const pick = (how: string, label: string) => {
      const d = moveTarget(ctxMenu!.id, how);
      return d ? `<button data-mv="${d}">${label}<span>${fd(d)}</span></button>` : "";
    };
    const m = ctxMenu.month;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i - first.getDay()));
    el.innerHTML = `<div class="cm-h">「${escapeHtml(e.title)}」 날짜 옮기기</div>${pick("tomorrow", "내일")}${pick("weekday", "다음 평일")}${pick("nextweek", "다음 주 같은 요일")}
      <div class="cm-cal"><div class="cm-mh"><button data-mvm="-1" aria-label="이전 달">‹</button><b>${m.getFullYear()}. ${m.getMonth() + 1}.</b><button data-mvm="1" aria-label="다음 달">›</button></div><div class="cm-g">${"일월화수목금토".split("").map((d) => `<i>${d}</i>`).join("")}${cells.map((d) => `<button data-mv="${ymd(d)}" class="${d.getMonth() === m.getMonth() ? "" : "out"} ${ymd(d) === ymd(clock()) ? "td" : ""}">${d.getDate()}</button>`).join("")}</div></div>`;
    el.hidden = false;
    if (x || y) {
      const base = root.getBoundingClientRect();
      el.style.left = `${Math.max(6, Math.min(x - base.left, base.width - 236))}px`;
      el.style.top = `${Math.max(6, Math.min(y - base.top, base.height - el.offsetHeight - 6))}px`;
    }
  }

  /** The date in the header opens a small month to jump to a day (오늘 on top). */
  let pickMonth: Date | null = null;
  function renderPick(): void {
    const el = root.querySelector<HTMLElement>("#bhPick");
    if (!el) return;
    if (!pickMonth) {
      el.hidden = true;
      return;
    }
    const m = pickMonth;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i - first.getDay()));
    const k = ymd(cur);
    el.innerHTML = `<button data-pickgo="${ymd(clock())}">오늘<span>${theme().fd(ymd(clock()))}</span></button>
      <div class="cm-cal"><div class="cm-mh"><button data-pickm="-1" aria-label="이전 달">‹</button><b>${m.getFullYear()}. ${m.getMonth() + 1}.</b><button data-pickm="1" aria-label="다음 달">›</button></div><div class="cm-g">${"일월화수목금토".split("").map((d) => `<i>${d}</i>`).join("")}${cells.map((d) => `<button data-pickgo="${ymd(d)}" class="${d.getMonth() === m.getMonth() ? "" : "out"} ${ymd(d) === ymd(clock()) ? "td" : ""} ${ymd(d) === k ? "sel" : ""}">${d.getDate()}</button>`).join("")}</div></div>`;
    const b = root.querySelector<HTMLElement>("[data-datepick]")?.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    if (b) {
      el.style.left = `${Math.max(6, b.left - base.left)}px`;
      el.style.top = `${b.bottom - base.top + 6}px`;
    }
    el.hidden = false;
  }

  /** 「일정 ↔ 할 일」 on a card: an appointment becomes a deadline (its start) and back. */
  function swapKind(key: string): void {
    const id = key.slice(key.indexOf("|") + 1);
    const x = findEntry(s, id);
    if (!x || (x.kind !== "event" && x.kind !== "task")) return;
    const common = { title: x.title, details: x.details, area: x.area, source: x.source, createdAt: stamp(clock()), touched: true, star: x.star };
    const made: Entry = x.kind === "event"
      ? { ...common, id: newId(s, "t"), kind: "task", due: x.date, dueTime: x.start, done: false, reminders: x.reminders.slice(), subs: [] }
      : { ...common, id: newId(s, "e"), kind: "event", date: x.due, start: x.dueTime, end: x.dueTime ? hm(Math.min(mins(x.dueTime) + (s.settings.eventMinutes || 60), 23 * 60 + 59)) : null, provisional: false, reminders: x.reminders.slice() };
    if (made.kind === "event") s.events.push(made);
    else s.tasks.push(made);
    x.gone = true;
    for (const m of s.chat) if (m.refs?.includes(x.id)) m.refs = m.refs.map((r) => (r === x.id ? made.id : r));
    undoStack.push({ label: `「${x.title}」 ${made.kind === "event" ? "일정으로" : "할 일로"}`, run: () => {
      made.gone = true;
      x.gone = false;
      void act(() => undefined);
    } });
    toast(`${made.kind === "event" ? "일정" : "할 일"}으로 바꿨어요: 「${x.title}」`, undefined, true);
    void act(() => undefined);
  }

  /** 「X 18일로 옮겨」 「X 내일로 미뤄」: the entry whose title matches goes to that day. */
  async function moveBySentence(v: string, src: string): Promise<boolean> {
    const m = MOVE_RE.exec(v.trim());
    if (!m) return false;
    const now = clock();
    const today = ymd(now);
    let day: string | null = null;
    const d1 = /^(\d{1,2})일$/.exec(m[2]);
    if (d1) {
      let d = new Date(now.getFullYear(), now.getMonth(), Number(d1[1]));
      if (ymd(d) < today) d = new Date(now.getFullYear(), now.getMonth() + 1, Number(d1[1]));
      day = ymd(d);
    } else if (m[2].replace(/\s/g, "") === "다음주") day = ymd(addDays(parseDay(today), 7));
    else day = parseRule(`${m[2]} 일정`, now).date;
    if (!day) return false;
    const name = m[1].trim();
    const hits = (await askIndex()).search(name).filter((h) => h.cover >= 0.6 && ["event", "task", "period"].includes(h.doc.kind));
    const x = hits.map((h) => findEntry(s, h.doc.id)).find((e) => e && !e.gone && !(e.kind === "task" && e.done));
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: v, kind: "text", src });
    if (!x) {
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: `「${name}」을(를) 찾지 못했어요` });
      await save();
      render();
      return true;
    }
    moveTo(x.id, day);
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: `→ ${theme().fd(day)}`, refs: [x.id] });
    await save();
    render();
    return true;
  }

  /** 「매일 8시 20분 메일 확인 루틴」 「평일 15:55 종례」 「화·목 12시 20분 급식 지도 루틴」 → 루틴. */
  function addRoutineBySentence(v: string, src: string): boolean {
    const rep = /(매일|평일|주중|(?:매주\s*)?([월화수목금토일](?:\s*[·,]?\s*[월화수목금토일])*)\s*(?:요일)?(?:마다)?)/.exec(v);
    if (!rep || !/루틴|마다|매일|평일/.test(v)) return false;
    const w = timeWords(v.replace(rep[0], " "), s.settings);
    const one = singleTime(w);
    const r0 = parseRule(w, clock());
    const at = one?.time ?? (r0.hasTime ? r0.time : null);
    if (!at) return false;
    const days = rep[2] ? [...new Set(rep[2].replace(/[\s·,]/g, "").split("").map((c) => "일월화수목금토".indexOf(c)).filter((n) => n >= 0))] : null;
    const repeat = rep[1].startsWith("매일") ? "daily" as const : /평일|주중/.test(rep[1]) ? "weekdays" as const : days ?? "daily";
    const title = (one ? one.rest : r0.title).replace(/루틴|마다|에\s|하기\s*$/g, " ").replace(/\d{1,2}시(\s*\d{1,2}분)?/g, " ").replace(/\s+/g, " ").trim() || "루틴";
    const now = clock();
    const r: Routine = { id: newId(s, "r"), title: title.slice(0, 60), at, repeat, done: [], createdAt: stamp(now) };
    s.routines.push(r);
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: v, kind: "text", src });
    const label = repeat === "daily" ? "매일" : repeat === "weekdays" ? "평일" : (repeat as number[]).map((d) => "일월화수목금토"[d]).join("·");
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: `루틴 · ${label} ${at} ${r.title}` });
    undoStack.push({ label: `루틴 「${r.title}」`, run: () => {
      r.gone = true;
      void act(() => undefined);
    } });
    toast(`루틴: ${label} ${at} ${r.title}`, undefined, true);
    void act(() => undefined);
    return true;
  }

  /** A sentence kept as a 기억 (rule: no day, no time, or 「메모 …」). Also an Obsidian note. */
  async function saveMemoText(v: string, src: string): Promise<void> {
    const now = clock();
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: v, kind: "text", src });
    const x = draftFromText(s, v, src, now, `local-${Date.now().toString(36)}`);
    log(s, { label: "기억", msg: x.title, src, ref: x.id }, now);
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: "", refs: [x.id] });
    adapter.aiSkipped?.("rule");
    void adapter.writeMemo?.(v.replace(/^\s*(메모|기억|노트)\s*[:：,]?\s+/, ""), src).catch(() => undefined);
    toast(`기억 · ${x.title}`, x.id);
    await save();
    renderComposer();
    render();
  }

  /** 「일정으로」·「할 일로」 on a 기억 card: the note goes, an entry comes, its edit form opens. */
  function convertMemo(to: "event" | "task", key: string): void {
    const msgId = key.slice(0, key.indexOf("|"));
    const id = key.slice(key.indexOf("|") + 1);
    const x = findEntry(s, id);
    if (!x || x.kind !== "note") return;
    const now = clock();
    const text = `${x.title}${x.details ? ` ${x.details}` : ""}`;
    const r = parseDraft(text, now, s.settings);
    const day = r.date ?? ymd(now);
    const common = { title: r.title && r.title !== "음성 메모" ? r.title : x.title, details: x.details, area: x.area, source: x.source, createdAt: stamp(now), touched: true };
    const made: Entry = to === "event"
      ? { ...common, id: newId(s, "e"), kind: "event", date: day, start: r.hasTime ? r.time : null, end: r.hasTime ? r.end ?? hm(Math.min(mins(r.time!) + 60, 23 * 60 + 59)) : null, provisional: false, reminders: r.hasTime ? [stamp(new Date(fromStamp(`${day}T${r.time}`).getTime() - 30 * 60e3))] : [] }
      : { ...common, id: newId(s, "t"), kind: "task", due: day, dueTime: r.hasTime ? r.time : null, done: false, reminders: [], subs: [], noDue: !r.date ? true : undefined };
    if (made.kind === "event") s.events.push(made);
    else s.tasks.push(made);
    userAction({ type: "cancel", ref: x.id }, false, false);
    undoStack.push({ label: `「${x.title}」 ${to === "event" ? "일정" : "할 일"}으로`, run: () => {
      made.gone = true;
      userAction({ type: "restore", ref: x.id }, false, false);
      void act(() => undefined);
    } });
    const m = s.chat.find((c) => c.id === msgId);
    if (m) m.refs = [...(m.refs ?? []).filter((r2) => r2 !== x.id), made.id];
    log(s, { label: to === "event" ? "일정으로" : "할 일로", msg: made.title, src: adapter.origin, ref: made.id }, now);
    editing = `${msgId}|${made.id}`;
    void act(() => undefined).then(() => [...root.querySelectorAll<HTMLElement>("[data-editing]")].find((e) => e.dataset.editing === editing)?.querySelector<HTMLInputElement>(".ed-d, .ed-t")?.focus());
  }

  /** ⌘Enter: a 기억 exactly as typed (no AI; also an Obsidian note under 노트/기억/). */
  async function addMemo(text: string, via: string): Promise<void> {
    const now = clock();
    const [first, ...rest] = text.trim().split("\n");
    const memo = { id: newId(s, "n"), kind: "note" as const, title: first.slice(0, 80), details: rest.join("\n").trim() || undefined, area: "personal" as const, source: via, createdAt: stamp(now) };
    s.notes.push(memo);
    log(s, { label: "기억", msg: memo.title, src: via, ref: memo.id }, now);
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: text.trim(), kind: "text", src: via });
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: "", refs: [memo.id] });
    toast(`기억으로 저장: ${memo.title}`, memo.id);
    await save();
    render();
  }

  /** A link: the page's title and text go to the AI (schedule candidates); the link itself is kept as 기억. */
  async function submitLink(link: NonNullable<PutItem["link"]>, via: string): Promise<void> {
    const now = clock();
    const title = link.title || link.url;
    const memo = { id: newId(s, "n"), kind: "note" as const, title: `링크 · ${title}`.slice(0, 80), details: link.url, area: "personal" as const, source: via, createdAt: stamp(now) };
    s.notes.push(memo);
    log(s, { label: "기억", msg: memo.title, src: via, ref: memo.id }, now);
    if (!link.text.trim()) {
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: link.url, kind: "text", src: via });
      s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: "페이지를 읽지 못해 링크만 기억으로 두었어요.", refs: [memo.id] });
      await save();
      render();
      return;
    }
    const body = `링크 정리: 이 페이지에서 일정·마감·할 일만 뽑아 주세요.\n제목: ${link.title}\n주소: ${link.url}\n\n${link.text}`;
    await analyze({ text: body, now }, { text: `${title}\n${link.url}`, kind: "text" }, "링크", title, { noDraft: true });
  }

  /** Quick window, clipboard, Dock, capture, drop: like typing here, files go to the inbox when it is on. */
  async function handlePut(p: PutItem): Promise<void> {
    if (p.link) return submitLink(p.link, p.via);
    if (p.text) return submitText(p.text, p.via, true);
    if (p.memo) return addMemo(p.memo, p.via);
    if (p.toggle) return userAction({ type: "toggleTask", ref: p.toggle });
    if (p.open) {
      const x = findEntry(s, p.open);
      if (x) {
        if (x.kind === "event" || x.kind === "task") openDay(x.kind === "event" ? x.date : x.due);
        else if (x.kind === "period") openDay(x.from);
        toast(`「${x.title}」`);
      }
      return;
    }
    if (!p.path) return;
    const name = p.path.split(/[\\/]/).pop() ?? p.path;
    if (adapter.inboxPut && inbox.enabled) {
      try {
        await adapter.inboxPut(p.path);
        log(s, { label: "넣음", msg: `${name} → 인박스(곧 정리)`, src: p.via }, clock());
        s.chat.push({ id: newId(s, "c"), at: stamp(clock()), who: "me", text: "", kind: /\.(png|jpe?g|heic|webp)$/i.test(name) ? "photo" : "file", fileName: name, src: p.via });
        s.chat.push({ id: newId(s, "c"), at: stamp(clock()), who: "ai", text: "받았어요 · 곧 정리해서 여기에 카드로 보여 드릴게요." });
        await save();
        renderLast();
        toast(`${name} 넣음 · 곧 정리됩니다`);
        return;
      } catch (e) {
        console.warn("인박스에 넣지 못해 바로 분석", e);
      }
    }
    await submitPath(p.path, p.via);
  }

  async function submitFile(name: string, bytes: Uint8Array, kind: ChatKind = /\.(png|jpe?g|webp|heic)$/i.test(name) ? "photo" : "file"): Promise<void> {
    const src = kind === "voice" ? "음성" : kind === "photo" ? "사진" : adapter.origin;
    await analyze({ file: { name, bytes }, now: clock() }, { text: "", kind, fileName: name }, src, kind === "voice" ? "음성 메모" : name);
  }

  async function submitPath(path: string, src = "넣기"): Promise<void> {
    const name = path.split(/[\\/]/).pop() ?? path;
    await analyze({ path, now: clock() }, { text: "", kind: "file", fileName: name }, src, name);
  }

  async function toggleVoice(): Promise<void> {
    if (recording) {
      const r = recording;
      recording = null;
      renderComposer();
      const wav = await r.stop();
      if (wav.length < 16_000) {
        s.chat.push({ id: newId(s, "c"), at: stamp(clock()), who: "ai", text: "녹음이 너무 짧아요.", error: true });
        render();
        return;
      }
      await submitFile(`음성-${stamp(clock()).replace(/[:T-]/g, "")}.wav`, wav, "voice");
      return;
    }
    try {
      recording = await startRecording();
    } catch (e) {
      s.chat.push({ id: newId(s, "c"), at: stamp(clock()), who: "ai", text: `마이크를 열지 못했어요 — ${/permission|notallowed|denied/i.test(String(e)) ? "마이크 권한이 꺼져 있음 · 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 블랙홀을 켜 주세요" : friendlyError(e)}`, error: true });
      chatOpen = true;
      render();
    }
    renderComposer();
  }

  /* ---------- alarms ---------- */

  function syncAlarms(): void {
    const now = clock().getTime();
    for (let i = testAlarms.length - 1; i >= 0; i--) if (testAlarms[i].atMs < now - 60_000 || s.firedAlarms.includes(testAlarms[i].key)) testAlarms.splice(i, 1);
    void adapter.scheduleAlarms([...upcomingAlarms(s, clock()), ...testAlarms]);
  }

  function fireAlarm(a: Alarm): void {
    if (alarmOn?.key === a.key || alarmQueue.some((x) => x.key === a.key)) return;
    markFired(s, a.key);
    void save();
    // Mac: the full-screen alarm window shows and rings it; the answer comes back by event.
    if (adapter.nativeAlarms) return;
    alarmQueue.push(a);
    if (!alarmOn) nextAlarm();
  }

  function nextAlarm(): void {
    alarmOn = alarmQueue.shift() ?? null;
    const el = root.querySelector<HTMLElement>("#bhAlarm")!;
    el.classList.toggle("on", !!alarmOn);
    el.innerHTML = alarmOn ? theme().alarm(alarmOn) : "";
    root.classList.toggle("buzz", !!alarmOn);
    if (alarmOn) {
      void adapter.ring(true).then((handled) => {
        selfRing = !handled;
        if (selfRing) startBeep();
      });
      el.querySelector<HTMLButtonElement>("[data-alarm=done]")?.focus();
    } else {
      void adapter.ring(false);
      stopBeep();
    }
  }

  function startBeep(): void {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audio = audio ?? new Ctor();
      void audio.resume();
    } catch {
      return;
    }
    const beep = () => {
      const a = audio!;
      const t0 = a.currentTime;
      for (const [t, f] of [[0, 880], [0.16, 1320], [0.32, 880], [0.48, 1320]]) {
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = "triangle";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + t);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.14);
        o.connect(g);
        g.connect(a.destination);
        o.start(t0 + t);
        o.stop(t0 + t + 0.15);
      }
    };
    beep();
    window.clearInterval(ringTimer);
    ringTimer = window.setInterval(beep, 1300);
  }

  function stopBeep(): void {
    window.clearInterval(ringTimer);
    ringTimer = undefined;
  }

  async function answerNative(a: Alarm, action: "done" | "snooze" | "ok"): Promise<void> {
    if (a.ref && action !== "ok") userAction({ type: "alarm", ref: a.ref, key: a.key, answer: action }, false);
    else markFired(s, a.key);
    await save();
    syncAlarms();
    render();
  }

  async function answer(action: "done" | "snooze"): Promise<void> {
    const a = alarmOn;
    if (!a) return;
    if (a.ref) userAction({ type: "alarm", ref: a.ref, key: a.key, answer: action }, false);
    else markFired(s, a.key);
    nextAlarm();
    await save();
    syncAlarms();
    render();
  }

  /* ---------- events ---------- */

  /** A hand-made change: applied here, and sent to the other device when the adapter shares. */
  /**
   * A hand-made change: applied here, and sent to the other device when the adapter shares.
   * Checks and cancels (`undoable`) go on the undo stack and show 「되돌리기」 at the bottom.
   * Undoing sends the opposite change (check again · 「restore」), so the other device follows.
   */
  function userAction(a: Omit<UserAction, "id" | "at"> & Record<string, unknown>, refresh = true, undoable = true): void {
    const now = clock();
    const target = findEntry(s, a.ref);
    let note = "";
    if (target && (a.type === "toggleTask" || a.type === "toggleSub")) {
      const again = { ...a };
      if (undoable) undoStack.push({ label: a.type === "toggleTask" ? `「${target.title}」 체크` : "하위 할 일 체크", run: () => userAction(again, true, false) });
    } else if (target && a.type === "cancel" && !target.gone) {
      const ref = target.id;
      const provisional = target.kind === "event" && !!target.provisional;
      if (undoable) undoStack.push({ label: `「${target.title}」 ${provisional ? "취소" : "지우기"}`, run: () => userAction({ type: "restore", ref }, true, false) });
      note = `${provisional ? "취소했어요" : "지웠어요"}: 「${target.title}」`;
    } else if (target && a.type === "confirm") note = `확정했어요: 「${target.title}」`;
    if (undoStack.length > 30) undoStack.shift();
    const src = findEntry(s, a.ref)?.srcKey;
    const action = { ...a, ...(src ? { src } : {}), id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: stamp(now) } as UserAction;
    applyAction(s, action, now);
    adapter.recordAction?.(action);
    if (target && a.type === "toggleTask" && target.kind === "task") note = target.done ? `완료: 「${target.title}」` : `완료 취소: 「${target.title}」`;
    else if (target && a.type === "toggleSub" && target.kind === "task") note = `하위 할 일 체크 · 「${target.title}」`;
    if (note && undoable) toast(note, undefined, a.type !== "confirm");
    if (refresh) void act(() => undefined);
  }

  function copyText(text: string): void {
    void navigator.clipboard?.writeText(text).then(() => toast("복사했어요"), () => toast("복사하지 못했어요"));
  }

  async function act(fn: () => void): Promise<void> {
    fn();
    await save();
    syncAlarms();
    render();
  }

  const onClick = (ev: MouseEvent) => {
    const t = ev.target as HTMLElement;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => t.closest<T>(sel);
    const now = clock();
    if (q("[data-alarm]")) return void answer(q("[data-alarm]")!.dataset.alarm as "done" | "snooze");
    if (q("[data-secret]")) {
      const v = secretAsk;
      secretAsk = null;
      renderLast();
      if (v === null) return;
      if (q("[data-secret]")!.dataset.secret === "yes") return void adapter.secretIntake?.(v, true).then(() => toast("비밀로 저장했어요(이 Mac 키체인에만)."));
      return void submitText(v, adapter.origin, true);
    }
    if (q("[data-raycast]")) {
      return void adapter.raycastInstall?.().then((dir) => {
        deskLine = `Raycast 스크립트를 만들었습니다: ${dir}`;
        renderSettings();
      }, (e: unknown) => {
        deskLine = friendlyError(e);
        renderSettings();
      });
    }
    if (q("[data-drag]")) return;
    if (q("[data-undo]")) return undo();
    if (q("[data-panel]")) {
      const open = q("[data-panel]")!.dataset.panel === "open";
      // Too narrow for the panel: the button slides the drawer in and out.
      if (sideCapable && !wideEnough()) return setChat(open);
      return setSidePref(open);
    }
    if (q("[data-choose]")) {
      const b = q("[data-choose]")!;
      const i = s.chat.findIndex((m) => m.id === b.dataset.cmsg);
      const v = i >= 0 ? s.chat[i].choice : undefined;
      if (v === undefined) return;
      s.chat.splice(i, 1);
      return void (b.dataset.choose === "ask" ? askQuestion(v) : submitText(v, adapter.origin, false, "put"));
    }
    if (q("[data-edit]")) {
      editing = q("[data-edit]")!.dataset.edit!;
      render();
      return [...root.querySelectorAll<HTMLElement>("[data-editing]")].find((e) => e.dataset.editing === editing)?.querySelector<HTMLInputElement>(".ed-t")?.focus();
    }
    if (q("[data-editsave]")) return saveEdit(q("[data-editsave]")!.dataset.editsave!);
    if (q("[data-convert]")) {
      const v = q("[data-convert]")!.dataset.convert!;
      return convertMemo(v.slice(0, v.indexOf("|")) as "event" | "task", v.slice(v.indexOf("|") + 1));
    }
    if (q("[data-editcancel]")) {
      editing = null;
      return render();
    }
    if (q("[data-restore]")) return userAction({ type: "restore", ref: q("[data-restore]")!.dataset.restore! });
    if (q("[data-mopen]") && !q("[data-editing]") && (!q("button") || q("button.mclose"))) {
      const key = `memo:${q("[data-mopen]")!.dataset.mopen}`;
      if (openFolds.has(key)) openFolds.delete(key);
      else openFolds.add(key);
      return render();
    }
    if (q("#bhCtx")) {
      const mv = q("[data-mv]");
      const mm = q("[data-mvm]");
      if (mm && ctxMenu) {
        ctxMenu.month = new Date(ctxMenu.month.getFullYear(), ctxMenu.month.getMonth() + Number(mm.dataset.mvm), 1);
        return renderCtx();
      }
      if (mv && ctxMenu) {
        const id = ctxMenu.id;
        ctxMenu = null;
        renderCtx();
        return moveTo(id, mv.dataset.mv!);
      }
      return;
    }
    if (ctxMenu) {
      ctxMenu = null;
      renderCtx();
    }
    if (q("[data-ev]")) picked = q("[data-ev]")!.dataset.ev!;
    if (q("[data-dr]")) {
      today.range = q("[data-dr]")!.dataset.dr === "all" ? "all" : "work";
      try {
        localStorage.setItem("bh-dayrange", today.range);
      } catch {
        /* not kept */
      }
      return render();
    }
    if (q("[data-tf]")) {
      today.filter = q("[data-tf]")!.dataset.tf as TodayOpts["filter"];
      return render();
    }
    if (q("[data-star]")) return cycleStar(q("[data-star]")!.dataset.star!);
    if (q("[data-rt]")) return toggleRoutine(q("[data-rt]")!.dataset.rt!);
    if (q("[data-swap]")) return swapKind(q("[data-swap]")!.dataset.swap!);
    if (q("[data-moveto]")) {
      const r = q("[data-moveto]")!.getBoundingClientRect();
      const id = q("[data-moveto]")!.dataset.moveto!;
      const x = findEntry(s, id);
      ctxMenu = { id, month: parseDay(x?.kind === "event" ? x.date : x?.kind === "task" ? x.due : ymd(clock())) };
      return renderCtx(r.left, r.bottom + 4);
    }
    if (barJustDragged) {
      // The click that ends a drag does not also open the card.
      barJustDragged = false;
      return;
    }
    const POP = ".strip [data-ev], .dstrip [data-ev], .dtg [data-ev], .tl .task[data-ev] .tn, .ups .ms[data-ev], .dta .chip[data-ev]";
    if ((view === "day" || view === "pri") && (q(POP) || q(".quad .mq[data-ev] .tn")) && !q("button, [role=checkbox], input")) {
      const hit = q<HTMLElement>(POP) ?? q<HTMLElement>(".quad .mq[data-ev] .tn")!;
      const t = hit.dataset.ev ? hit : hit.closest<HTMLElement>("[data-ev]")!;
      const r = t.getBoundingClientRect();
      const base = root.getBoundingClientRect();
      // Next to where it was clicked (a long 공문서 row would put it over the rows below).
      const x = t.tagName === "TR" ? ev.clientX - base.left + 12 : r.left - base.left;
      const y = t.tagName === "TR" ? r.top - base.top : r.bottom - base.top + 4;
      popId = popId?.id === t.dataset.ev ? null : { id: t.dataset.ev!, x, y };
      return renderPop();
    }
    if (popId && !q("#bhPop")) {
      popId = null;
      renderPop();
    }
    if (q("[data-checks]") || q("[data-subs]")) {
      const key = q("[data-checks]") ? "checks" : `subs:${q("[data-subs]")!.dataset.subs}`;
      if (openFolds.has(key)) openFolds.delete(key);
      else openFolds.add(key);
      render();
      if (key.startsWith("subs:")) root.querySelector<HTMLInputElement>(`[data-subadd="${key.slice(5)}"]`)?.focus();
      return;
    }
    if (q("[data-merge]")) {
      // 합치기: the later copy is marked gone (⌘Z brings it back); nothing is erased.
      return userAction({ type: "cancel", ref: q("[data-merge]")!.dataset.merge! });
    }
    if (q("[data-accept]")) {
      // 「맞아요」: a provisional event is confirmed; a review note is cleared.
      const x = findEntry(s, q("[data-accept]")!.dataset.accept!);
      if (!x) return;
      if (x.kind === "event" && x.provisional) userAction({ type: "confirm", ref: x.id }, false);
      x.review = undefined;
      return void act(() => undefined);
    }
    if (q("[data-open]") && !q("button, input")) {
      const x = findEntry(s, q("[data-open]")!.dataset.open!);
      if (x?.kind === "event") openDay(x.date);
      else if (x?.kind === "task") openDay(x.due);
      else if (x?.kind === "period") openDay(x.from);
      return;
    }
    if (q("[data-copy]")) {
      const id = q("[data-copy]")!.dataset.copy!;
      return findEntry(s, id) ? copyText(describe(s, id, theme().fd).msg) : undefined;
    }
    if (q("[data-copytext]")) return copyText(q("[data-copytext]")!.dataset.copytext!);
    if (q("[data-secretcopy]")) {
      const name = q("[data-secretcopy]")!.dataset.secretcopy!;
      return void adapter.secretCopy?.(name).then(() => toast("복사했어요 · 30초 뒤 클립보드에서 지웁니다"), (e: unknown) => toast(friendlyError(e)));
    }
    if (q("[data-note]")) return void adapter.openNote?.(q("[data-note]")!.dataset.note!).catch((e: unknown) => toast(friendlyError(e)));
    if (q("[data-ok]")) return userAction({ type: "confirm", ref: q("[data-ok]")!.dataset.ok! });
    if (q("[data-no]")) return userAction({ type: "cancel", ref: q("[data-no]")!.dataset.no! });
    if (q("[data-openrec]")) return void adapter.openRecording?.();
    if (q("button[data-fold]")) {
      const key = q("button[data-fold]")!.dataset.fold!;
      if (openFolds.has(key)) openFolds.delete(key);
      else openFolds.add(key);
      return render();
    }
    if (q("[data-phmonth]")) {
      view = view === "month" ? "day" : "month";
      return render();
    }
    if (q("[data-phfind]")) {
      root.classList.toggle("findon");
      return void root.querySelector<HTMLInputElement>("#bhFind")?.focus();
    }
    if (q("[data-fixall]")) {
      const fixes = dictationFixes(s, fixSkip);
      const was = fixes.map((f) => [f.x, f.x.title] as const);
      for (const f of fixes) f.x.title = f.to;
      undoStack.push({ label: `받아쓰기 교정 ${fixes.length}건`, run: () => {
        for (const [x, title] of was) x.title = title;
        void act(() => undefined);
      } });
      toast(`받아쓰기 교정 ${fixes.length}건 고침`, undefined, true);
      return void act(() => undefined);
    }
    if (q("[data-fixskip]")) {
      for (const f of dictationFixes(s, fixSkip)) fixSkip.add(f.x.id);
      try {
        localStorage.setItem("bh-fixskip", JSON.stringify([...fixSkip]));
      } catch {
        /* this time only */
      }
      return render();
    }
    if (q("[data-fdone]")) {
      userAction({ type: "toggleTask", ref: q("[data-fdone]")!.dataset.fdone! });
      return renderFind();
    }
    if (q("[data-fmove]")) {
      const r = q("[data-fmove]")!.getBoundingClientRect();
      ctxMenu = { id: q("[data-fmove]")!.dataset.fmove!, month: new Date(clock().getFullYear(), clock().getMonth(), 1) };
      closeFind();
      return renderCtx(r.left, r.bottom);
    }
    if (q("[data-fcopy]")) return void findCopy(q("[data-fcopy]")!.dataset.fcopy!);
    if (q("[data-fask]")) {
      const query = findQ.trim();
      const docs = findDocs.filter((d) => d.kind !== "inbox").slice(0, 12);
      closeFind(true);
      return void askQuestion(query, docs.length ? docs : undefined);
    }
    if (q("[data-fopen]")) return void findOpen(q("[data-fopen]")!.dataset.fopen!);
    if (!q(".find") && !q("#bhFindRes")) closeFind();
    if (q("[data-tdone]")) return userAction({ type: "toggleTask", ref: q("[data-tdone]")!.dataset.tdone! });
    if (q("[data-aiok]")) return userAction({ type: "aiAccept", ref: q("[data-aiok]")!.dataset.aiok! });
    if (q("[data-aino]")) return userAction({ type: "aiDismiss", ref: q("[data-aino]")!.dataset.aino! });
    if (q("[data-sub]")) {
      const [id, i] = q("[data-sub]")!.dataset.sub!.split(":");
      return userAction({ type: "toggleSub", ref: id, index: Number(i) });
    }
    if (q("[data-go]")) {
      const input = root.querySelector<HTMLInputElement>(`#${q("[data-go]")!.dataset.go}`);
      const v = input?.value ?? "";
      if (input) input.value = "";
      return void submitText(v);
    }
    if (q("[data-photo]")) return void root.querySelector<HTMLInputElement>("#bhFile")?.click();
    if (q("[data-voice]")) return void toggleVoice();
    if (q("[data-print]")) {
      printRoot.querySelector<HTMLElement>("#bhSheet")!.innerHTML = printSheet(ctx());
      printRoot.hidden = false;
      return;
    }
    if (q("[data-settings]")) {
      settingsOpen = !settingsOpen;
      if (settingsOpen) void loadCalendars();
      if (settingsOpen) renderSettings();
      else root.querySelector<HTMLElement>("#bhSettings")!.hidden = true;
      return;
    }
    if (q("[data-setg]")) {
      const g = q("[data-setg]")!.dataset.setg!;
      setGroup = setGroup === g ? null : g;
      return renderSettings();
    }
    if (q("[data-claude]")) return void claudeAction(q("[data-claude]")!.dataset.claude!);
    if (q("[data-pinwidget]")) {
      void adapter.pinWidget!().then((ok) => {
        if (board) board.status = ok ? "홈 화면에 놓을지 묻는 창이 뜹니다" : "이 휴대폰은 앱에서 위젯 추가를 지원하지 않습니다(홈 화면 길게 누르기 → 위젯 → 블랙홀)";
        renderSettings();
      });
      return;
    }
    if (q("[data-lookreset]")) {
      s.settings.glassBlur = 26;
      s.settings.glassBright = 0;
      applyLook();
      void save();
      renderSettings();
      return;
    }
    if (q("[data-rtday]")) {
      const [id, d] = q("[data-rtday]")!.dataset.rtday!.split("|");
      const r = s.routines.find((x) => x.id === id);
      if (r && Array.isArray(r.repeat)) {
        const n = Number(d);
        const next = r.repeat.includes(n) ? r.repeat.filter((x) => x !== n) : [...r.repeat, n].sort();
        if (next.length) r.repeat = next;
        return void act(() => undefined);
      }
      return;
    }
    if (q("[data-rtdel]")) {
      const r = s.routines.find((x) => x.id === q("[data-rtdel]")!.dataset.rtdel);
      if (!r) return;
      r.gone = true;
      undoStack.push({ label: `루틴 「${r.title}」 지움`, run: () => {
        r.gone = undefined;
        void act(() => undefined);
      } });
      toast(`루틴 「${r.title}」 지움`, undefined, true);
      return void act(() => undefined);
    }
    if (q("[data-testalarm]")) {
      const at = new Date(clock().getTime() + 60_000);
      const a: Alarm = { key: `test@${at.getTime()}`, ref: "", kind: "event", at: stamp(at), atMs: at.getTime(), title: "알람 시험", body: "1분 뒤 시험 알람입니다 · 확인을 누르면 꺼집니다" };
      testAlarms.push(a);
      syncAlarms();
      const b = q<HTMLButtonElement>("[data-testalarm]")!;
      b.textContent = `알람 시험 · ${stamp(at).slice(11)}에 울림`;
      return;
    }
    if (q("[data-guide]")) {
      guideOpen = true;
      settingsOpen = false;
      root.querySelector<HTMLElement>("#bhSettings")!.hidden = true;
      void loadCalendars();
      return renderGuide();
    }
    if (q("[data-guide-close]")) {
      guideOpen = false;
      renderGuide();
      return void saveDesk((d) => (d.onboarded = true));
    }
    if (q("[data-perm]")) return void permission(q("[data-perm]")!.dataset.perm!);
    if (q("[data-desk-try]")) return adapter.trySound?.(desk?.settings.alarmSound ?? "Glass");
    if (q("#bhGuide")) return;
    if (q("#bhSettings")) return;
    if (q("[data-v]")) {
      view = q("[data-v]")!.dataset.v as ViewName;
      return render();
    }
    if (q("[data-datepick]")) {
      pickMonth = pickMonth ? null : new Date(cur.getFullYear(), cur.getMonth(), 1);
      return renderPick();
    }
    if (q("[data-pickm]")) {
      pickMonth = new Date(pickMonth!.getFullYear(), pickMonth!.getMonth() + Number(q("[data-pickm]")!.dataset.pickm), 1);
      return renderPick();
    }
    if (q("[data-pickgo]")) {
      cur = parseDay(q("[data-pickgo]")!.dataset.pickgo!);
      pickMonth = null;
      renderPick();
      return render();
    }
    if (pickMonth && !q("#bhPick")) {
      pickMonth = null;
      renderPick();
    }
    if (q("[data-nav]")) {
      const n = Number(q("[data-nav]")!.dataset.nav);
      if (!n) cur = parseDay(ymd(clock()));
      else if (view === "month") cur = new Date(cur.getFullYear(), cur.getMonth() + n, 1);
      else cur = addDays(cur, n * (view === "week" ? 7 : 1));
      return render();
    }
    if (q("input, select, textarea")) return;
    if (view !== "day") {
      const day = q("[data-day]");
      if (day) return openDay(day.dataset.day!);
      const e = q("[data-ev]");
      if (e) {
        const x = findEntry(s, e.dataset.ev!);
        if (x && (x.kind === "event" || x.kind === "task")) return openDay(x.kind === "event" ? x.date : x.due);
      }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.matches("[data-desk-sc]")) return recordShortcut(e, el as HTMLInputElement);
    if (el.matches("[data-resize]") && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      return setPanelW(panelW + (e.key === "ArrowLeft" ? 20 : -20), true);
    }
    if (el.matches(".ed-h") && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      const t = timeField((el as HTMLInputElement).value);
      if (t) {
        const step = e.key === "ArrowUp" ? 10 : -10;
        const mv = (h: string) => hm(Math.max(0, Math.min(23 * 60 + 50, Math.round((mins(h) + step) / 10) * 10)));
        (el as HTMLInputElement).value = t.end ? `${mv(t.start)}~${mv(t.end)}` : mv(t.start);
      }
      return;
    }
    const ed = el.closest?.<HTMLElement>("[data-editing]");
    if (ed && !e.isComposing && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter") return saveEdit(ed.dataset.editing!);
      editing = null;
      render();
      return root.querySelector<HTMLInputElement>("#bhIn")?.focus();
    }
    if (e.key === "Escape") {
      if (pickMonth) {
        pickMonth = null;
        return renderPick();
      }
      if (ctxMenu) {
        ctxMenu = null;
        return renderCtx();
      }
      if (root.querySelector(".newev")) {
        root.querySelector(".newev")!.remove();
        return;
      }
      if (popId) {
        popId = null;
        return renderPop();
      }
      if (!printRoot.hidden) printRoot.hidden = true;
      else if (guideOpen) {
        guideOpen = false;
        renderGuide();
      } else if (settingsOpen) {
        settingsOpen = false;
        root.querySelector<HTMLElement>("#bhSettings")!.hidden = true;
      } else if (chatOpen) setChat(false);
      else return;
      // Back to the always-open input, like closing a sheet in a Mac app.
      root.querySelector<HTMLInputElement>("#bhIn")?.focus();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) {
      if (e.key === " " && el.matches("[data-tdone],[data-sub],[data-drag]")) {
        e.preventDefault();
        el.click();
      }
      return;
    }
    if (el.matches("[data-tdone],[data-sub],[data-ok],[data-no],[data-undo],[data-mopen]") && !(el instanceof HTMLButtonElement)) {
      el.click();
      return;
    }
    if (el.matches("[data-drag]")) {
      setChat(!chatOpen);
      return;
    }
    if (el instanceof HTMLInputElement && el.matches("[data-rtnew]")) {
      const v = el.value.trim();
      if (!v) return;
      if (!addRoutineBySentence(/매일|평일|주중|[월화수목금토일]요일|마다/.test(v) ? `${v} 루틴` : `매일 ${v} 루틴`, adapter.origin)) toast("시간을 함께 써 주세요 · 예: 「평일 8시 20분 메일 확인」");
      return;
    }
    if (el instanceof HTMLInputElement && el.dataset.newev) {
      const [day, a, b] = el.dataset.newev.split("|");
      const v = el.value.trim();
      el.closest(".newev")?.remove();
      if (v) addEventAt(day, Number(a), Number(b), v);
      return;
    }
    if (el instanceof HTMLInputElement && el.dataset.subadd) {
      const id = el.dataset.subadd;
      const v = el.value;
      if (v.trim()) userAction({ type: "addSub", ref: id, title: v.trim() }, false);
      void act(() => undefined).then(() => root.querySelector<HTMLInputElement>(`[data-subadd="${id}"]`)?.focus());
      return;
    }
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && (el.id === "bhIn" || el.id === "bhChatIn")) {
      // Enter puts it in; ⇧Enter is a new line in the box.
      if (e.shiftKey) return;
      e.preventDefault();
      const v = el.value;
      el.value = "";
      growBox(el);
      void submitText(v);
    }
  };

  const onChange = async (e: Event) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.id === "bhFile") {
      const f = (el as HTMLInputElement).files?.[0];
      (el as HTMLInputElement).value = "";
      if (f) await submitFile(f.name, new Uint8Array(await f.arrayBuffer()));
      return;
    }
    if (el.dataset.board && board && adapter.setBoard) {
      const k = el.dataset.board;
      const on = (el as HTMLInputElement).checked;
      if (k === "bright" || k === "opacity") {
        board[k] = Number(el.value);
        await adapter.setBoardLook?.(board.bright ?? 0, board.opacity ?? 100);
      } else if (k === "lockTasks" || k === "lockHideTitles") {
        board[k] = on;
        await adapter.setLockTasks?.(board.lockTasks !== false, !!board.lockHideTitles);
      } else {
        if (k === "lock") board.lock = on;
        if (k === "hideSchool") board.hideSchool = on;
        await adapter.setBoard(board.lock, board.hideSchool);
      }
      void loadCalendars();
      return;
    }
    if (el.dataset.gcal && gcal && adapter.setGoogleCalendars) {
      const g = gcal;
      if (el.dataset.gcal === "enabled") g.enabled = (el as HTMLInputElement).checked;
      if (el.dataset.gcal === "provisional") g.provisional = el.value;
      if (el.dataset.gcal === "main") g.main = el.value;
      // Never mirror without two different calendars (keeps provisional events out of the main one).
      if (g.enabled && (!g.provisional || !g.main || g.provisional === g.main)) {
        g.enabled = false;
        g.status = "가승인 캘린더와 본 캘린더를 서로 다르게 골라 주세요";
        renderSettings();
      }
      await adapter.setGoogleCalendars(g.enabled, g.provisional, g.main);
      void loadCalendars();
      return;
    }
    if (el.dataset.claudeOpt && claude && adapter.setClaudeOptions) {
      const budget = el.dataset.claudeOpt === "budget" ? Math.max(0, Number(el.value) || 0) : claude.budgetUsd ?? 3;
      const skip = el.dataset.claudeOpt === "skip" ? (el as HTMLInputElement).checked : claude.skipSimple !== false;
      claude = await adapter.setClaudeOptions(budget, skip).catch((err: unknown) => {
        claudeLine = String(err);
        return claude;
      });
      renderSettings();
      return;
    }
    if (el.dataset.desk === "autostart") return void saveDesk((d) => (d.autostart = (el as HTMLInputElement).checked));
    if (el.dataset.desk === "rightCmd") return void saveDesk((d) => (d.rightCmdTwice = (el as HTMLInputElement).checked));
    if (el.dataset.desk === "board") return void saveDesk((d) => (d.board = (el as HTMLInputElement).checked));
    if (el.dataset.desk === "boardSize") return void saveDesk((d) => (d.boardSize = el.value === "large" ? "large" : "small"));
    if (el.dataset.desk === "boardMode") return void saveDesk((d) => (d.boardMode = el.value as "desktop" | "top" | "peek"));
    if (el.dataset.desk === "mainWidget") return void saveDesk((d) => (d.mainWidget = (el as HTMLInputElement).checked));
    if (el.dataset.desk === "sound") {
      adapter.trySound?.(el.value);
      return void saveDesk((d) => (d.alarmSound = el.value));
    }
    if (el.dataset.rtf) {
      const [id, f] = el.dataset.rtf.split("|");
      const r = s.routines.find((x) => x.id === id);
      if (!r) return;
      if (f === "title") r.title = el.value.trim().slice(0, 60) || r.title;
      if (f === "at") {
        const m = /^(\d{1,2}):?(\d{2})$/.exec(el.value.trim());
        if (m && +m[1] < 24 && +m[2] < 60) r.at = `${pad(+m[1])}:${m[2]}`;
      }
      if (f === "repeat") r.repeat = el.value === "daily" ? "daily" : el.value === "weekdays" ? "weekdays" : Array.isArray(r.repeat) ? r.repeat : [new Date().getDay()];
      await save();
      render();
      return;
    }
    if (el.dataset.time || el.dataset.period) {
      // 학교 시간: 「0820」 「8:20」 「08:50-09:35」 「0850~0935」 are all fine; anything else is not taken.
      const one = (v: string) => {
        const m = /^(\d{1,2}):?(\d{2})$/.exec(v.trim());
        return m && +m[1] < 24 && +m[2] < 60 ? `${pad(+m[1])}:${m[2]}` : null;
      };
      const two = (v: string) => {
        const [a, b] = v.split(/\s*[-~–]\s*/);
        const x = a ? one(a) : null;
        const y = b ? one(b) : null;
        return x && y && y > x ? `${x}-${y}` : null;
      };
      const k = el.dataset.time;
      const st = s.settings;
      if (k === "eventMinutes") st.eventMinutes = Math.max(10, Math.min(600, Math.round(Number(el.value) || 60)));
      else if (k === "onWork" || k === "offWork") st[k] = one(el.value) ?? st[k];
      else if (k === "lunch") st.lunch = two(el.value) ?? st.lunch;
      else if (el.dataset.period) {
        const v = two(el.value);
        if (v) st.periods[Number(el.dataset.period)] = v;
      }
      await save();
      render();
      return;
    }
    const key = el.dataset.set;
    if (!key) return;
    if (key === "theme") s.settings.theme = el.value as ThemeName;
    if (key === "mode") s.settings.mode = el.value as "dark" | "light";
    if (key === "samples") s.settings.showSamples = (el as HTMLInputElement).checked;
    if (key === "showPeriods") s.settings.showPeriods = (el as HTMLInputElement).checked;
    if (key === "glassBlur" || key === "glassBright") {
      s.settings[key] = Number(el.value);
      applyLook();
    }
    if (key === "sharePhone") s.settings.sharePhone = (el as HTMLInputElement).checked;
    if (key === "messenger") {
      s.settings.messengerEnabled = (el as HTMLInputElement).checked;
      messenger = (await adapter.setMessenger?.(s.settings.messengerEnabled).catch(() => messenger)) ?? messenger;
    }
    if (key === "inboxRoot") {
      s.settings.inboxRoot = el.value === "drive" ? inbox.driveRoot ?? null : null;
      inbox = await adapter.setInbox(s.settings.inboxEnabled, s.settings.inboxRoot).catch((err: unknown) => ({ ...inbox, lastError: String(err) }));
    }
    if (key === "inbox") {
      s.settings.inboxEnabled = (el as HTMLInputElement).checked;
      inbox = await adapter.setInbox(s.settings.inboxEnabled, s.settings.inboxRoot).catch((err: unknown) => ({ ...inbox, lastError: String(err) }));
    }
    await save();
    syncAlarms();
    if (key === "theme" || key === "mode") buildShell();
    else render();
    if (settingsOpen) renderSettings();
  };

  /* chat sheet: pull the handle up to open, down to close; click toggles */
  let drag: { y: number; open: boolean } | null = null;
  function setChat(open: boolean): void {
    if (side || (sideCapable && !sidePref && wideEnough())) return setSidePref(open && !side);
    chatOpen = open;
    const el = root.querySelector<HTMLElement>("#bhChat");
    el?.classList.toggle("open", open);
    root.classList.toggle("chat-open", open);
    if (open) {
      renderChat();
      root.querySelector<HTMLInputElement>("#bhChatIn")?.focus();
    }
  }
  let resizing: { x: number; w: number } | null = null;
  const setPanelW = (w: number, keep: boolean) => {
    panelW = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(w), Math.max(PANEL_MIN, root.clientWidth - CONTENT_MIN)));
    root.style.setProperty("--panel-w", `${panelW}px`);
    if (keep) {
      try {
        localStorage.setItem("bh-panel-w", String(panelW));
      } catch {
        /* not kept */
      }
    }
  };
  /** Day band: drag a bar to move it, its edges to change start/end (10-minute steps). */
  let barDrag: { id: string; mode: "move" | "l" | "r"; x0: number; el: HTMLElement; left: number; width: number; px: number; a: number; b: number; moved: boolean } | null = null;
  let barJustDragged = false;
  const onDown = (e: PointerEvent) => {
    const bar = (e.target as HTMLElement).closest<HTMLElement>(".strip .sb");
    if (bar && e.button === 0) {
      const lane = bar.parentElement!;
      const x = findEntry(s, bar.dataset.ev!);
      if (x?.kind === "event" && x.start) {
        const span = (Number(lane.dataset.h1) - Number(lane.dataset.h0)) * 60;
        const a = mins(x.start);
        const b = x.end ? mins(x.end) : a + (s.settings.eventMinutes || 60);
        const edge = (e.target as HTMLElement).closest(".rs");
        barDrag = { id: x.id, mode: edge?.classList.contains("l") ? "l" : edge ? "r" : "move", x0: e.clientX, el: bar, left: bar.offsetLeft, width: bar.offsetWidth, px: lane.clientWidth / span, a, b, moved: false };
        return;
      }
    }
    if (side && (e.target as HTMLElement).closest("[data-resize]")) {
      resizing = { x: e.clientX, w: panelW };
      e.preventDefault();
      return;
    }
    const g = (e.target as HTMLElement).closest<HTMLElement>("[data-drag]");
    if (!g) return;
    drag = { y: e.clientY, open: g.dataset.drag === "close" };
    e.preventDefault();
  };
  const barDelta = (d: { x0: number; px: number }, clientX: number) => Math.round((clientX - d.x0) / d.px / 10) * 10;
  const onMove = (e: PointerEvent) => {
    if (barDrag) {
      const dx = e.clientX - barDrag.x0;
      if (!barDrag.moved && Math.abs(dx) < 4) return;
      barDrag.moved = true;
      const dm = barDelta(barDrag, e.clientX) * barDrag.px;
      const st = barDrag.el.style;
      if (barDrag.mode === "move") st.left = `${barDrag.left + dm}px`;
      else if (barDrag.mode === "l") {
        st.left = `${barDrag.left + dm}px`;
        st.width = `${Math.max(12, barDrag.width - dm)}px`;
      } else st.width = `${Math.max(12, barDrag.width + dm)}px`;
      const d = barDelta(barDrag, e.clientX);
      const a = barDrag.mode === "r" ? barDrag.a : barDrag.a + d;
      const b = barDrag.mode === "l" ? barDrag.b : barDrag.b + d;
      barDrag.el.querySelector(".st")!.textContent = `${hm(Math.max(0, a))}–${hm(Math.min(24 * 60 - 1, b))}`;
      return;
    }
    if (resizing) return setPanelW(resizing.w + resizing.x - e.clientX, false);
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const el = root.querySelector<HTMLElement>("#bhChat")!;
    el.style.transition = "none";
    if (!drag.open && dy < 0) el.style.transform = `translateY(calc(105% + ${dy}px))`;
    else if (drag.open && dy > 0) el.style.transform = `translateY(${dy}px)`;
  };
  const onUp = (e: PointerEvent) => {
    if (barDrag) {
      const d = barDrag;
      barDrag = null;
      if (!d.moved) return;
      barJustDragged = true;
      const dm = barDelta(d, e.clientX);
      let a = d.mode === "r" ? d.a : d.a + dm;
      let b = d.mode === "l" ? d.b : d.b + dm;
      a = Math.max(0, Math.min(a, 24 * 60 - 10));
      b = Math.max(a + 10, Math.min(b, 24 * 60 - 1));
      if (dm) retime(d.id, null, { start: hm(a), end: hm(b) });
      else render();
      return;
    }
    if (resizing) {
      setPanelW(panelW, true);
      resizing = null;
      if (view !== "day") render();
      return;
    }
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const el = root.querySelector<HTMLElement>("#bhChat")!;
    el.style.transition = "";
    el.style.transform = "";
    if (Math.abs(dy) < 6) setChat(!drag.open);
    else if (!drag.open && dy < -40) setChat(true);
    else if (drag.open && dy > 40) setChat(false);
    drag = null;
  };

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  root.addEventListener("change", (e) => void onChange(e));
  // Sliders: show the look while dragging; it is saved on 「change」.
  root.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el instanceof HTMLTextAreaElement && (el.id === "bhIn" || el.id === "bhChatIn")) return growBox(el);
    if (el.id === "bhFind") {
      findQ = el.value;
      findSel = 0;
      renderFind();
      // Secret names and notes come from the Mac (refreshed at most once a minute).
      void askIndex().then(() => findQ && renderFind());
      return;
    }
    if (el.matches("[data-memoq]")) {
      // Only the list is drawn again (the find box keeps the cursor and the 한글 being typed).
      memoQuery = el.value;
      const list = root.querySelector<HTMLElement>(".memol");
      if (list) list.innerHTML = memoRows(ctx(), theme().fd, memoQuery);
      return;
    }
    const key = el.dataset.set;
    if (el.type !== "range") return;
    const v = el.nextElementSibling;
    if (v?.classList.contains("set-v")) v.textContent = el.dataset.board === "opacity" ? `${el.value}%` : el.value;
    if (key === "glassBlur" || key === "glassBright") {
      s.settings[key] = Number(el.value);
      applyLook();
    }
  });
  // A lazy fold draws its rows when opened.
  root.addEventListener("toggle", (e) => {
    const d = e.target as HTMLDetailsElement;
    const key = d.dataset?.fold;
    if (!key || d.open === openFolds.has(key)) return;
    if (d.open) openFolds.add(key);
    else openFolds.delete(key);
    render();
  }, true);
  /*
   * The day table: drag a box to move it (10 min), its bottom edge to make it longer, an empty part
   * to draw a new appointment; drop a box on a day in the week line to move it there.
   */
  let dt: { mode: "move" | "end" | "new"; id?: string; y0: number; px: number; S: number; E: number; a: number; b: number; el?: HTMLElement; ghost?: HTMLElement; day: string; moved: boolean } | null = null;
  const dtMin = (d: NonNullable<typeof dt>, clientY: number) => Math.round((clientY - d.y0) / d.px / 10) * 10;
  root.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    const grid = t.closest<HTMLElement>(".dtg");
    if (!grid || e.button !== 0) return;
    const S = Number(grid.dataset.s);
    const E = Number(grid.dataset.e);
    const px = grid.clientHeight / (E - S);
    const box = t.closest<HTMLElement>("[data-evbox]");
    const day = grid.dataset.dtg!;
    if (box) {
      const x = findEntry(s, box.dataset.evbox!);
      if (x?.kind !== "event" || !x.start) return;
      const a = mins(x.start);
      dt = { mode: t.closest(".grip") ? "end" : "move", id: x.id, y0: e.clientY, px, S, E, a, b: x.end ? mins(x.end) : a + (s.settings.eventMinutes || 60), el: box, day, moved: false };
      return;
    }
    if (t.closest("[data-dtc]")) {
      const r = grid.getBoundingClientRect();
      const a = Math.round((S + (e.clientY - r.top) / px) / 10) * 10;
      dt = { mode: "new", y0: e.clientY, px, S, E, a, b: a + 30, day, moved: false };
      e.preventDefault();
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (!dt) return;
    if (!dt.moved && Math.abs(e.clientY - dt.y0) < 4) return;
    dt.moved = true;
    hideTip();
    const d = dtMin(dt, e.clientY);
    const grid = root.querySelector<HTMLElement>(".dtg");
    if (!grid) return;
    const top = (m: number) => `${(((m - dt!.S) / (dt!.E - dt!.S)) * 100).toFixed(3)}%`;
    if (dt.mode === "new") {
      if (!dt.ghost) {
        grid.insertAdjacentHTML("beforeend", '<div class="ev ghost"></div>');
        dt.ghost = grid.lastElementChild as HTMLElement;
      }
      const end = dt.a + Math.max(10, d);
      const [a, b] = d >= 0 ? [dt.a, end] : [dt.a + d, dt.a];
      dt.ghost.style.top = top(a);
      dt.ghost.style.height = `calc(${top(b)} - ${top(a)})`;
      dt.ghost.textContent = `${hm(Math.max(0, a))}–${hm(Math.min(1439, b))}`;
      return;
    }
    const el = dt.el!;
    const len = dt.b - dt.a;
    const a = dt.mode === "move" ? dt.a + d : dt.a;
    const b = dt.mode === "move" ? a + len : Math.max(dt.a + 10, dt.b + d);
    el.style.top = top(a);
    el.style.height = `max(20px, calc(${top(b)} - ${top(a)}))`;
    el.querySelector(".r")!.textContent = `${hm(Math.max(0, a))}–${hm(Math.min(1439, b))}`;
    // Over ‹ ›: dropping there moves it to the day before / after.
    root.querySelectorAll(".dctl .ar.drop").forEach((w) => w.classList.remove("drop"));
    (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(".dctl .ar")?.classList.add("drop");
  });
  window.addEventListener("pointerup", (e) => {
    const d0 = dt;
    dt = null;
    if (!d0 || !d0.moved) return;
    barJustDragged = true;
    root.querySelectorAll(".dctl .ar.drop").forEach((w) => w.classList.remove("drop"));
    const d = dtMin(d0, e.clientY);
    if (d0.mode === "new") {
      d0.ghost?.remove();
      const [a, b] = d >= 0 ? [d0.a, d0.a + Math.max(10, d)] : [d0.a + d, d0.a];
      return askNewEvent(d0.day, Math.max(0, a), Math.min(1439, b));
    }
    const ar = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".dctl .ar");
    if (ar && d0.mode === "move") return moveTo(d0.id!, ymd(addDays(parseDay(d0.day), Number(ar.dataset.nav))));
    const len = d0.b - d0.a;
    let a = d0.mode === "move" ? d0.a + d : d0.a;
    a = Math.max(0, Math.min(a, 24 * 60 - 10));
    const b = Math.min(24 * 60 - 1, d0.mode === "move" ? a + len : Math.max(d0.a + 10, d0.b + d));
    if (d) retime(d0.id!, null, { start: hm(a), end: hm(b) });
    else render();
  });
  // To-dos (and the 우선순위 rows) are dragged with the browser's drag and drop.
  root.addEventListener("dragstart", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-task]");
    if (!t || !e.dataTransfer) return;
    e.dataTransfer.setData("text/bh-task", t.dataset.task!);
    e.dataTransfer.effectAllowed = "move";
    hideTip();
  });
  const dropZone = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLElement>(".dtg, .quad, .dctl .ar");
  // Held over ‹ ›: one more day every 0.7 s (the arrow shows 「+2」…); dropping moves it that far.
  let flip: { el: HTMLElement; n: number; timer: ReturnType<typeof setInterval> } | null = null;
  const endFlip = () => {
    if (!flip) return;
    clearInterval(flip.timer);
    flip.el.removeAttribute("data-flip");
    flip = null;
  };
  root.addEventListener("dragover", (e) => {
    const z = dropZone(e.target);
    if (!z || !e.dataTransfer?.types.includes("text/bh-task")) return;
    e.preventDefault();
    if (z.classList.contains("ar") && flip?.el !== z) {
      endFlip();
      const f = { el: z, n: 1, timer: setInterval(() => {
        f.n++;
        z.setAttribute("data-flip", `${Number(z.dataset.nav) < 0 ? "−" : "+"}${f.n}`);
      }, 700) };
      flip = f;
      z.setAttribute("data-flip", `${Number(z.dataset.nav) < 0 ? "−" : "+"}1`);
    } else if (!z.classList.contains("ar")) endFlip();
    root.querySelectorAll(".drop").forEach((x) => x !== z && x.classList.remove("drop"));
    z.classList.add("drop");
  });
  root.addEventListener("dragleave", (e) => {
    const z = dropZone(e.target);
    z?.classList.remove("drop");
    if (z && flip?.el === z) endFlip();
  });
  root.addEventListener("dragend", endFlip);
  root.addEventListener("drop", (e) => {
    const z = dropZone(e.target);
    const id = e.dataTransfer?.getData("text/bh-task");
    root.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
    if (!z || !id) return;
    e.preventDefault();
    // Onto ‹ ›: the day before / after the one shown.
    if (z.classList.contains("ar")) {
      const n = flip?.el === z ? flip.n : 1;
      endFlip();
      return moveTo(id, ymd(addDays(cur, Number(z.dataset.nav) * n)));
    }
    if (z.classList.contains("dtg")) {
      const r = z.getBoundingClientRect();
      const S = Number(z.dataset.s);
      const E = Number(z.dataset.e);
      return blockWork(id, z.dataset.dtg!, S + ((e.clientY - r.top) / r.height) * (E - S));
    }
    // 우선순위: ①② = 중요(★ at least one), ③④ = 보통; ①③ = 급함 → the deadline becomes today.
    const x = findEntry(s, id);
    if (!x || x.kind !== "task") return;
    const q = z.dataset.quad;
    const before = structuredClone(x);
    if ((q === "now" || q === "imp") && !(x.star ?? 0)) x.star = 1;
    if (q === "urgent" || q === "rest") x.star = 0;
    if ((q === "now" || q === "urgent") && (x.noDue || x.due > ymd(clock()))) {
      x.due = ymd(clock());
      x.noDue = false;
      x.dueTime = x.dueTime ?? s.settings.offWork;
    }
    x.touched = true;
    undoStack.push({ label: `「${x.title}」 우선순위`, run: () => {
      Object.assign(x, before);
      void act(() => undefined);
    } });
    toast(`「${x.title}」 → ${z.querySelector("h4")?.firstChild?.textContent ?? ""}`, undefined, true);
    void act(() => undefined);
  });
  // The same number lights up in the list and on the day table.
  root.addEventListener("mouseover", (e) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>("[data-num]")?.dataset.num;
    root.querySelectorAll(".no.hl").forEach((x) => x.classList.remove("hl"));
    if (n) root.querySelectorAll(`.no[data-num="${n}"]`).forEach((x) => x.classList.add("hl"));
  });
  // Right click on anything with a day: 「날짜 옮기기」.
  root.addEventListener("contextmenu", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-ev]");
    if (!t || t.closest("#bhSettings")) return;
    const x = findEntry(s, t.dataset.ev!);
    if (!x || (x.kind !== "event" && x.kind !== "task" && x.kind !== "period")) return;
    e.preventDefault();
    picked = x.id;
    hideTip();
    ctxMenu = { id: x.id, month: parseDay(x.kind === "event" ? x.date : x.kind === "task" ? x.due : x.from) };
    renderCtx(e.clientX, e.clientY);
  });

  // Hover card (A-4): shows within 150 ms, stays inside the window, never in the way of a drag.
  let tipTimer: number | undefined;
  let tipFor = "";
  const hideTip = () => {
    window.clearTimeout(tipTimer);
    tipFor = "";
    const t = root.querySelector<HTMLElement>("#bhTip");
    if (t) t.hidden = true;
  };
  root.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ev]");
    if (!el || barDrag || el.closest("#bhPop, .rc")) return el ? undefined : hideTip();
    const id = el.dataset.ev!;
    if (id === tipFor) return;
    hideTip();
    tipFor = id;
    const mx = (e as MouseEvent).clientX;
    const my = (e as MouseEvent).clientY;
    tipTimer = window.setTimeout(() => {
      const tip = root.querySelector<HTMLElement>("#bhTip");
      const html = tipHTML(ctx(), id, theme().fd);
      if (!tip || !html || tipFor !== id) return;
      tip.innerHTML = html;
      tip.hidden = false;
      const base = root.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      tip.style.left = `${Math.max(6, Math.min(mx - base.left + 12, base.width - w - 6))}px`;
      tip.style.top = `${my - base.top + 16 + h > base.height ? Math.max(6, my - base.top - h - 10) : my - base.top + 16}px`;
    }, 150);
  });
  root.addEventListener("mouseout", (e) => {
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (!to?.closest?.(`[data-ev="${tipFor}"]`)) hideTip();
  });
  root.addEventListener("pointerdown", hideTip);
  root.addEventListener("focusin", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.matches?.("[data-desk-sc]")) {
      el.classList.add("rec");
      el.value = "키를 누르세요";
    }
  });
  root.addEventListener("focusout", (e) => {
    const el = e.target as HTMLInputElement;
    if (!el.matches?.("[data-desk-sc]")) return;
    el.classList.remove("rec");
    const k = el.dataset.deskSc as "quick" | "clipboard" | "capture" | "widget";
    if (desk) el.value = desk.settings.shortcuts[k] ? desk.pretty[k] ?? "" : "끔";
  });
  root.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  adapter.onAlarm((a) => fireAlarm(a));
  adapter.onShared?.((shared, pendingActions) => {
    takeShared(s, shared, adapter.localDrafts?.() ?? []);
    const now = clock();
    for (const a of pendingActions) applyAction(s, a, now);
    void adapter.save(s);
    syncAlarms();
    render();
  });
  adapter.onFileDrop?.((paths) => paths.forEach((p) => void (adapter.putPath ? adapter.putPath(p, "끌어 놓기") : submitPath(p))));
  adapter.onPut?.((p) => void handlePut(p));
  adapter.onAlarmAnswer?.((a, action) => void answerNative(a, action));
  // A picture pasted into the input (⌘V) goes in like a dropped file.
  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length || !(e.target as HTMLElement).closest?.("#bhIn, #bhChatIn")) return;
    e.preventDefault();
    for (const f of files) {
      void f.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        const name = f.name && f.name !== "image.png" ? f.name : `붙여넣기-${stamp(clock()).replace(/[:T-]/g, "")}.${(f.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
        return adapter.putBytes ? adapter.putBytes(name, bytes, "붙여넣기") : submitFile(name, bytes);
      });
    }
  };
  root.addEventListener("paste", onPaste);
  // Mac-standard keys: ⌘, 설정 · ⌘N 입력 · ⌘F 찾기 · ⌘Z 되돌리기 · ←/→ 날짜 · T 오늘 (by key code: works with 한글 input on).
  const onGlobalKey = (e: KeyboardEvent) => {
    if (alarmOn || e.isComposing || guideOpen) return;
    const t = e.target as HTMLElement;
    const typing = !!t.closest?.("input, textarea, select, [contenteditable=true]");
    const cmd = e.metaKey || e.ctrlKey;
    const go = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (cmd && e.code === "Comma") return go(() => root.querySelector<HTMLButtonElement>("[data-settings]")?.click());
    if (cmd && e.code === "KeyN") return go(() => root.querySelector<HTMLInputElement>("#bhIn")?.focus());
    if (cmd && e.code === "KeyF") return go(() => {
      const f = root.querySelector<HTMLInputElement>("#bhFind");
      if (f && f.offsetParent) return void (f.focus(), f.select());
      return adapter.openQuick ? adapter.openQuick() : root.querySelector<HTMLInputElement>("#bhIn")?.focus();
    });
    if (cmd && e.code === "KeyZ" && !e.shiftKey && !typing) return go(undo);
    if (cmd && e.code === "Digit4") return go(() => root.querySelector<HTMLButtonElement>('[data-v="memo"]')?.click());
    if (e.altKey && !typing && !cmd && picked && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      const x = findEntry(s, picked);
      const k = x?.kind === "event" ? x.date : x?.kind === "task" ? x.due : x?.kind === "period" ? x.from : null;
      if (k) return go(() => moveTo(picked!, ymd(addDays(parseDay(k), e.code === "ArrowLeft" ? -1 : 1))));
    }
    if (typing || cmd || e.altKey || settingsOpen) return;
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") return go(() => root.querySelector<HTMLButtonElement>(`[data-nav="${e.code === "ArrowLeft" ? -1 : 1}"]`)?.click());
    if (e.code === "KeyT") return go(() => {
      cur = parseDay(ymd(clock()));
      render();
    });
  };
  document.addEventListener("keydown", onGlobalKey);
  // Two fingers sideways on the trackpad: the previous / next day (week, month), like turning a page.
  let swipe = 0;
  let swipeAt = 0;
  root.addEventListener("wheel", (e) => {
    if (!(e.target as HTMLElement).closest?.("#bhMain") || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5 || view === "memo") return;
    const now = Date.now();
    if (now - swipeAt < 600) return;
    swipe += e.deltaX;
    if (Math.abs(swipe) < 120) return;
    const n = swipe > 0 ? 1 : -1;
    swipe = 0;
    swipeAt = now;
    root.querySelector<HTMLButtonElement>(`[data-nav="${n}"]`)?.click();
  }, { passive: true });
  root.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement;
    if (el.id !== "bhFind" || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeFind(true);
      return (el as HTMLInputElement).blur();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      findSel = Math.max(0, Math.min(findDocs.length - 1, findSel + (e.key === "ArrowDown" ? 1 : -1)));
      renderFind();
      return root.querySelector<HTMLElement>(`.fr[data-fi="${findSel}"]`)?.scrollIntoView?.({ block: "nearest" });
    }
    if (e.key === "Enter" && findDocs[findSel]) {
      e.preventDefault();
      void findOpen(findDocs[findSel].id);
    }
  });
  // Mac menu bar (its key equivalents reach the page only through here).
  adapter.onMenu?.((id) => {
    const click = (sel: string) => root.querySelector<HTMLElement>(sel)?.click();
    if (id === "settings") return click("[data-settings]");
    if (id === "new") return root.querySelector<HTMLInputElement>("#bhIn")?.focus();
    if (id === "print") return click("[data-print]");
    if (id === "month" || id === "week" || id === "day") return click(`[data-v="${id}"]`);
    if (id === "today") return click('[data-nav="0"]');
    if (id === "chat") return setChat(!chatOpen);
    if (id === "guide") {
      guideOpen = true;
      void loadCalendars();
      return renderGuide();
    }
    if (id === "undo") {
      // In a text box: the box's own undo. Otherwise: the last change on the calendar.
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches?.("input, textarea") && (active as HTMLInputElement).value) return void document.execCommand("undo");
      return undo();
    }
  });

  let lastWidthCompact = false;
  const onResize = () => {
    if (sideOn() !== side) relayout();
    const compact = root.clientWidth < COMPACT;
    if (compact !== lastWidthCompact) {
      lastWidthCompact = compact;
      render();
    }
  };
  window.addEventListener("resize", onResize);
  // The input is always open: a focused window puts the cursor there unless something else has it.
  const onFocus = () => {
    const active = document.activeElement;
    if (alarmOn || chatOpen || (active && active !== document.body && root.contains(active))) return;
    root.querySelector<HTMLInputElement>("#bhIn")?.focus();
  };
  window.addEventListener("focus", onFocus);

  buildShell();
  root.querySelector<HTMLInputElement>("#bhIn")?.focus();
  lastWidthCompact = root.clientWidth < COMPACT;
  if (!stored) await save();
  await refreshInbox();
  syncAlarms();
  render();
  await loadCalendars().catch(() => undefined);
  if (adapter.showMissed) {
    const missed = missedAlarms(s, clock());
    if (missed.length) {
      missed.forEach((a) => markFired(s, a.key));
      await save();
      void adapter.showMissed(missed).catch(() => undefined);
    }
  }
  if ((desk as DeskStatus | null)?.settings.onboarded === false) {
    guideOpen = true;
    renderGuide();
  }

  // Minute tick: move the now-line, keep alarms scheduled across midnight.
  timers.push(window.setInterval(() => {
    const n = clock();
    const m = n.getHours() * 60 + n.getMinutes();
    if (m !== lastNowMinute) {
      lastNowMinute = m;
      if (!alarmOn && !document.querySelector(".subadd:focus") && view === "day") render();
      if (m % 30 === 0) syncAlarms();
    }
  }, 15_000));
  timers.push(window.setInterval(() => {
    void pullInbox();
    void pullPhoneActions();
  }, 5_000));
  timers.push(window.setInterval(() => void pullDrafts(), 2_000));

  return {
    state: s,
    get lastDraftMs() {
      return lastDraftMs;
    },
    submitText,
    submitFile,
    setView(v, day) {
      view = v;
      if (day) cur = parseDay(day);
      render();
    },
    setTheme(t, mode) {
      s.settings.theme = t;
      if (mode) s.settings.mode = mode;
      buildShell();
    },
    fireAlarm,
    async poll() {
      await pullDrafts();
      await pullInbox();
      await pullPhoneActions();
    },
    render,
    destroy() {
      timers.forEach((x) => window.clearInterval(x));
      fcHost.destroy();
      printRoot.remove();
      stopBeep();
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onGlobalKey);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", onFocus);
      mainObserver?.disconnect();
    }
  };
}

/** 「claude-haiku-5-5」 → 「Claude Haiku 5.5」 (the id stays in the tooltip-free API config). */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : id;
}

/** KeyboardEvent.code → the key part of a Tauri shortcut (「KeyV」 → 「V」); null for modifiers. */
export function shortcutKey(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (m) return m[1] ?? m[2];
  if (/^F([1-9]|1[0-9]|20)$/.test(code) || /^(Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(code)) return code;
  return null;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Phone: the Mac's copy replaces the calendar, plus the phone's own drafts the Mac has not
 * answered yet (its copy neither lists the job in `sources` nor has an entry for it).
 */
export function takeShared(s: CalendarState, shared: SharedCalendar, local: Entry[]): void {
  s.events = shared.events;
  s.tasks = shared.tasks;
  s.periods = shared.periods;
  s.notes = shared.notes;
  s.appliedActions = shared.appliedActions.slice();
  const known = new Set(shared.sources ?? []);
  for (const x of [...shared.events, ...shared.tasks, ...shared.periods, ...shared.notes]) if (x.srcKey) known.add(x.srcKey);
  const lists = { event: s.events, task: s.tasks, period: s.periods, note: s.notes } as Record<Entry["kind"], Entry[]>;
  for (const d of local) {
    if (!d.srcKey || known.has(d.srcKey) || lists[d.kind].some((x) => x.id === d.id)) continue;
    lists[d.kind].push(d);
  }
}
