/**
 * mountBlackhole: the calendar app (month · week · day, composer, chat, alarms, print).
 * Platform work goes through the adapter, so this module runs unchanged in the desktop
 * window, a browser and the phone WebView.
 */
import { AnalyzeError, type AnalyzeInput, type BlackholeAdapter, type GoogleCalendars, type InboxStatus, type MessengerStatus } from "./adapter";
import { addDays, parseDay, stamp, ymd } from "./dates";
import { FcHost } from "./fc";
import { normalizeState, sharedFrom, type CalendarState, type ChatKind, type ChatMessage, type ThemeName, type UserAction } from "./model";
import { startRecording, type Recording } from "./recorder";
import { seedState } from "./samples";
import {
  applyAction, applyProposal, describe, findEntry, log, markFired, newId, upcomingAlarms, type Alarm
} from "./store";
import type { Ctx, ThemeView, ViewName } from "./views/common";
import { doc, printSheet } from "./views/doc";
import { glass } from "./views/glass";

export interface MountOptions {
  now?: () => Date;
  /** Seed fake data when nothing is stored (default true). */
  seed?: boolean;
}

export interface BlackholeApp {
  readonly state: CalendarState;
  submitText(text: string, src?: string): Promise<void>;
  submitFile(name: string, bytes: Uint8Array, kind?: ChatKind): Promise<void>;
  setView(view: ViewName, day?: string): void;
  setTheme(theme: ThemeName, mode?: "dark" | "light"): void;
  fireAlarm(alarm: Alarm): void;
  render(): void;
  destroy(): void;
}

const THEMES: Record<ThemeName, ThemeView> = { glass, doc };
const COMPACT = 760;

export async function mountBlackhole(root: HTMLElement, adapter: BlackholeAdapter, options: MountOptions = {}): Promise<BlackholeApp> {
  const clock = options.now ?? (() => new Date());
  const stored = normalizeState(await adapter.load().catch(() => null));
  const s: CalendarState = stored ?? (options.seed === false ? normalizeState({ schemaVersion: 1 })! : seedState(clock()));

  let view: ViewName = "day";
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
  let board: { lock: boolean; hideSchool: boolean; status: string } | null = null;
  let messenger: MessengerStatus | null = null;
  const loadCalendars = () =>
    Promise.all([adapter.googleCalendars?.(), adapter.board?.(), adapter.messenger?.()]).then(([g, b, m]) => {
      gcal = g ?? null;
      board = b ?? null;
      messenger = m ?? null;
      if (settingsOpen) renderSettings();
    });
  (window as unknown as { blackholeCalendars?: () => void }).blackholeCalendars = () => void loadCalendars();
  let shareTimer: number | undefined;
  const save = async () => {
    await adapter.save(s).catch((e: unknown) => console.error("저장 실패", e));
    if (adapter.publishShared && s.settings.sharePhone) {
      window.clearTimeout(shareTimer);
      shareTimer = window.setTimeout(() => {
        void adapter.publishShared!(sharedFrom(s, stamp(clock()))).then((line) => (shareLine = line), (e: unknown) => (shareLine = String(e)));
      }, 1500);
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
      busy: busy > 0
    };
  }

  /* ---------- shell ---------- */

  function buildShell(): void {
    fcHost.destroy();
    const c = ctx();
    root.className = `bh ${s.settings.theme}`;
    root.dataset.mode = s.settings.theme === "glass" ? s.settings.mode : "light";
    void adapter.setLook?.(s.settings.theme, s.settings.mode).catch(() => undefined);
    root.innerHTML = `${theme().shell(c)}
      <section class="chatsheet" id="bhChat" aria-label="대화 기록"><div class="grab" data-drag="close" role="button" tabindex="0" aria-label="대화 기록 닫기"><i></i></div><div class="sheethead">대화 기록</div><div class="thread" id="bhThread" aria-live="polite"></div><div class="sheetcomp" id="bhChatComp"></div></section>
      <div class="settings" id="bhSettings" role="dialog" aria-label="설정" hidden></div>
      <div class="alarm" id="bhAlarm" aria-live="assertive"></div>
      <input type="file" id="bhFile" hidden accept="image/*,.pdf,.hwp,.hwpx,.docx,.xlsx,.txt,.wav">`;
    renderComposer();
    render();
  }

  function renderComposer(): void {
    const c = ctx();
    const comp = root.querySelector<HTMLElement>("#bhComp");
    const chatComp = root.querySelector<HTMLElement>("#bhChatComp");
    const keep = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
    const v1 = keep("bhIn");
    const v2 = keep("bhChatIn");
    if (comp) comp.innerHTML = theme().composer(c, "bhIn", false);
    if (chatComp) chatComp.innerHTML = theme().composer(c, "bhChatIn", true);
    const i1 = root.querySelector<HTMLInputElement>("#bhIn");
    const i2 = root.querySelector<HTMLInputElement>("#bhChatIn");
    if (i1) i1.value = v1;
    if (i2) i2.value = v2;
    renderLast();
  }

  function renderLast(): void {
    const el = root.querySelector<HTMLElement>("#bhLast");
    if (!el) return;
    const l = s.log[s.log.length - 1];
    if (!l) {
      el.innerHTML = "";
      return;
    }
    const x = l.ref ? findEntry(s, l.ref) : undefined;
    const act = x && !x.gone ? (x.kind === "event" && x.provisional ? `<a data-ok="${x.id}" role="button" tabindex="0">확정</a><a data-no="${x.id}" role="button" tabindex="0">취소</a>` : `<a data-no="${x.id}" role="button" tabindex="0">되돌리기</a>`) : "";
    el.innerHTML = `<b>${escapeHtml(l.label)}</b> ${escapeHtml(l.msg)}${act}`;
  }

  function renderChat(): void {
    const el = root.querySelector<HTMLElement>("#bhThread");
    if (!el) return;
    const c = ctx();
    let day = "";
    let h = "";
    for (const m of s.chat) {
      const d = m.at.slice(0, 10);
      if (d !== day) {
        day = d;
        h += `<div class="daysep">${d === c.today ? "오늘" : theme().fd(d)}</div>`;
      }
      h += theme().bubble(c, m);
    }
    if (busy) h += '<div class="bub ai typing">분석 중…</div>';
    el.innerHTML = h;
    el.scrollTop = el.scrollHeight;
  }

  function render(): void {
    const c = ctx();
    const t = theme();
    const head = t.head(c);
    const title = root.querySelector<HTMLElement>("#bhTitle");
    if (title) title.textContent = head.title;
    const sum = root.querySelector<HTMLElement>("#bhSum");
    if (sum) sum.textContent = head.summary ?? "";
    root.querySelectorAll<HTMLButtonElement>("[data-v]").forEach((b) => {
      b.classList.toggle("on", b.dataset.v === view);
      b.setAttribute("aria-pressed", String(b.dataset.v === view));
    });
    const main = root.querySelector<HTMLElement>("#bhMain")!;
    const custom = view === "day" ? t.day(c) : view === "week" ? t.week(c) : null;
    if (custom === null) {
      let host = main.querySelector<HTMLElement>(":scope > .fchost");
      if (!host) {
        main.innerHTML = '<div class="fchost"></div>';
        host = main.querySelector<HTMLElement>(".fchost")!;
      }
      host.classList.toggle("g", s.settings.theme === "glass");
      fcHost.show(host, c, s.settings.theme, t, { openDay }, root.clientWidth > 0 && root.clientWidth < COMPACT);
    } else {
      fcHost.destroy();
      const scroll = main.querySelector<HTMLElement>(".ttwrap, .colx")?.scrollTop;
      main.innerHTML = custom;
      if (view === "day") {
        const tt = main.querySelector<HTMLElement>(".ttwrap, .colx");
        if (tt && scroll !== undefined) tt.scrollTop = scroll;
        else if (tt) scrollToNow(tt, c.nowM);
      }
    }
    root.classList.toggle("chat-open", chatOpen);
    root.querySelector("#bhChat")?.classList.toggle("open", chatOpen);
    renderLast();
    if (chatOpen) renderChat();
    if (settingsOpen) renderSettings();
  }

  function scrollToNow(el: HTMLElement, nowM: number): void {
    const row = el.querySelectorAll<HTMLElement>(".tt .h")[Math.max(0, Math.floor(nowM / 60) - 8)];
    if (row && el.scrollHeight > el.clientHeight) el.scrollTop = row.offsetTop - 4;
  }

  function openDay(k: string): void {
    cur = parseDay(k);
    view = "day";
    render();
  }

  /* ---------- settings ---------- */

  function renderSettings(): void {
    const el = root.querySelector<HTMLElement>("#bhSettings")!;
    const st = s.settings;
    el.innerHTML = `<div class="set-h">설정 <button class="mini" data-settings aria-label="설정 닫기">닫기</button></div>
      <label class="set-row">화면 <select data-set="theme"><option value="glass" ${st.theme === "glass" ? "selected" : ""}>유리</option><option value="doc" ${st.theme === "doc" ? "selected" : ""}>공문서</option></select></label>
      ${st.theme === "glass" ? `<label class="set-row">밝기 <select data-set="mode"><option value="dark" ${st.mode === "dark" ? "selected" : ""}>어둡게</option><option value="light" ${st.mode === "light" ? "selected" : ""}>밝게</option></select></label>` : ""}
      <label class="set-row"><input type="checkbox" data-set="samples" ${st.showSamples ? "checked" : ""}> 가짜 자료 보이기</label>
      <div class="set-sep"></div>
      <label class="set-row"><input type="checkbox" data-set="inbox" ${inbox.enabled ? "checked" : ""} ${inbox.available ? "" : "disabled"}> 인박스 처리 (작업기)</label>
      ${inbox.available ? `<label class="set-row">폴더 <select data-set="inboxRoot"><option value="" ${st.inboxRoot ? "" : "selected"}>시험 폴더</option>${inbox.driveRoot ? `<option value="drive" ${st.inboxRoot ? "selected" : ""}>드라이브 「블랙홀」</option>` : ""}</select></label>` : ""}
      <div class="set-note">${inbox.available ? `${st.inboxRoot ? "드라이브 폴더(인박스 원본은 지우지 않고 원본/·노트/만 씀)" : "시험 폴더"}: <code>${escapeHtml(inbox.root)}</code><br>${inbox.running ? "분석 중 · " : ""}${inbox.lastScanAt ? `마지막 확인 ${escapeHtml(inbox.lastScanAt.slice(11, 16))}` : "아직 확인 안 함"}${inbox.lastError ? `<br><span class="warn">${escapeHtml(inbox.lastError)}</span>` : ""}` : "이 화면에서는 인박스 처리를 쓸 수 없습니다."}</div>
      ${adapter.publishShared ? `<label class="set-row"><input type="checkbox" data-set="sharePhone" ${st.sharePhone ? "checked" : ""} ${inbox.driveRoot ? "" : "disabled"}> 휴대폰과 달력 공유</label>
      <div class="set-note">${inbox.driveRoot ? `드라이브 「블랙홀/달력.json」에 일정 사본을 쓰고, 휴대폰에서 바꾼 것을 받아 반영합니다.${shareLine ? `<br>${escapeHtml(shareLine)}` : ""}` : "드라이브 「블랙홀」 폴더가 없어 쓸 수 없습니다."}</div>` : ""}
      ${adapter.messenger && messenger ? `<div class="set-sep"></div>
      <label class="set-row"><input type="checkbox" data-set="messenger" ${st.messengerEnabled ? "checked" : ""} ${messenger.configured ? "" : "disabled"}> 디스코드·슬랙 입력</label>
      <div class="set-note">${messenger.configured ? `지정한 채널의 내 메시지를 30초마다 인박스로 가져옵니다(인박스 처리가 켜져 있어야 분석). 지금까지 ${messenger.written}개${messenger.lastPollAt ? ` · 마지막 ${escapeHtml(messenger.lastPollAt.slice(11, 16))}` : ""}` : `설정 파일을 만들면 켤 수 있습니다: <code>${escapeHtml(messenger.configPath)}</code>`}${messenger.lastError ? `<br><span class="warn">${escapeHtml(messenger.lastError)}</span>` : ""}</div>` : ""}
      ${adapter.googleCalendars ? gcalBlock() : ""}
      ${adapter.board && board ? `<div class="set-sep"></div>
      <label class="set-row"><input type="checkbox" data-board="lock" ${board.lock ? "checked" : ""}> 잠금화면 배경을 블랙홀 달력으로</label>
      <label class="set-row"><input type="checkbox" data-board="hideSchool" ${board.hideSchool ? "checked" : ""}> 위젯·잠금화면에서 학교 일정 제목 가리기</label>
      <div class="set-note">잠금화면 배경은 켜면 지금 배경을 바꿉니다(되돌리려면 휴대폰 배경 설정에서 다시 고름).${board.status ? `<br>${escapeHtml(board.status)}` : ""}</div>` : ""}
      <div class="set-sep"></div>
      <div class="set-row"><button class="mini" data-testalarm>알람 시험 (10초 뒤)</button></div>
      <div class="set-note">${escapeHtml(adapter.connection.detail)}</div>`;
    el.hidden = false;
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
    let changed = before !== inbox.lastScanAt;
    for (const r of results) {
      if (s.ingestedJobs.includes(r.jobId)) continue;
      s.ingestedJobs.push(r.jobId);
      const now = clock();
      if (r.proposal) {
        const applied = applyProposal(s, r.proposal, "인박스", now);
        afterApplied(applied.refs, applied.missing, "인박스", now);
        s.inbox.push({ at: stamp(now), title: r.fileName, src: "인박스", state: r.proposal.needsReview ? "검토 필요" : "완료", out: `${applied.refs.length}건` });
        s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", text: "", kind: "file", fileName: r.fileName, src: "인박스" });
        s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "ai", text: aiText(applied.refs.length, applied.missing.length, r.proposal.reviewReasons), refs: applied.refs });
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

  /* ---------- input ---------- */

  function aiText(n: number, miss: number, reasons: string[] = []): string {
    if (!n && reasons.length) return `넣은 것이 없어요. ※ ${reasons.join(" · ")}`;
    if (!n) return "찾은 것이 없어요. 언제인지 같이 보내 주세요.";
    return `${n}건 넣었어요.${miss ? ` ${miss}건은 날짜를 못 찾아 기억으로 두었어요.` : ""}`;
  }

  function afterApplied(refs: string[], missing: string[], src: string, now: Date): void {
    for (const id of refs) {
      const d = describe(s, id, theme().fd);
      log(s, { label: d.label, msg: d.msg, src, ref: id }, now);
    }
    for (const t of missing) log(s, { label: "확인 필요", msg: `「${t}」 날짜를 못 찾음`, src }, now);
  }

  async function analyze(input: AnalyzeInput, me: Omit<ChatMessage, "id" | "at" | "who">, src: string, inboxTitle: string): Promise<void> {
    const now = clock();
    s.chat.push({ id: newId(s, "c"), at: stamp(now), who: "me", ...me, src });
    busy++;
    renderComposer();
    render();
    try {
      const proposal = await adapter.analyze(input);
      const at = clock();
      const applied = applyProposal(s, proposal, src, at);
      afterApplied(applied.refs, applied.missing, src, at);
      if (me.kind === "voice" && proposal.sourceText) s.chat[s.chat.length - 1].text = proposal.sourceText;
      s.chat.push({ id: newId(s, "c"), at: stamp(at), who: "ai", text: aiText(applied.refs.length, applied.missing.length, proposal.reviewReasons), refs: applied.refs });
      s.inbox.push({ at: stamp(at), title: inboxTitle, src, state: proposal.needsReview ? "검토 필요" : "완료", out: `${applied.refs.length}건` });
    } catch (e) {
      const at = clock();
      if (e instanceof AnalyzeError && e.code === "QUEUED") {
        s.chat.push({ id: newId(s, "c"), at: stamp(at), who: "ai", text: e.message });
        s.inbox.push({ at: stamp(at), title: inboxTitle, src, state: "분석 중", out: "" });
        busy--;
        await save();
        renderComposer();
        render();
        return;
      }
      const msg = e instanceof AnalyzeError ? e.message : e instanceof Error ? e.message : String(e);
      s.chat.push({ id: newId(s, "c"), at: stamp(at), who: "ai", text: `분석하지 못했어요: ${msg}`, error: true });
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

  async function submitText(text: string, src = adapter.origin): Promise<void> {
    const v = text.trim();
    if (!v) return;
    await analyze({ text: v, now: clock() }, { text: v, kind: "text" }, src, "문장");
  }

  async function submitFile(name: string, bytes: Uint8Array, kind: ChatKind = /\.(png|jpe?g|webp|heic)$/i.test(name) ? "photo" : "file"): Promise<void> {
    const src = kind === "voice" ? "음성" : kind === "photo" ? "사진" : adapter.origin;
    await analyze({ file: { name, bytes }, now: clock() }, { text: "", kind, fileName: name }, src, kind === "voice" ? "음성 메모" : name);
  }

  async function submitPath(path: string): Promise<void> {
    const name = path.split(/[\\/]/).pop() ?? path;
    await analyze({ path, now: clock() }, { text: "", kind: "file", fileName: name }, "넣기", name);
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
      s.chat.push({ id: newId(s, "c"), at: stamp(clock()), who: "ai", text: `마이크를 열지 못했어요: ${e instanceof Error ? e.message : String(e)}`, error: true });
      chatOpen = true;
      render();
    }
    renderComposer();
  }

  /* ---------- alarms ---------- */

  function syncAlarms(): void {
    void adapter.scheduleAlarms(upcomingAlarms(s, clock()));
  }

  function fireAlarm(a: Alarm): void {
    if (alarmOn?.key === a.key || alarmQueue.some((x) => x.key === a.key)) return;
    markFired(s, a.key);
    void save();
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
  function userAction(a: Omit<UserAction, "id" | "at"> & Record<string, unknown>, refresh = true): void {
    const now = clock();
    const action = { ...a, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: stamp(now) } as UserAction;
    applyAction(s, action, now);
    adapter.recordAction?.(action);
    if (refresh) void act(() => undefined);
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
    if (q("[data-drag]")) return;
    if (q("[data-ok]")) return userAction({ type: "confirm", ref: q("[data-ok]")!.dataset.ok! });
    if (q("[data-no]")) return userAction({ type: "cancel", ref: q("[data-no]")!.dataset.no! });
    if (q("[data-tdone]")) return userAction({ type: "toggleTask", ref: q("[data-tdone]")!.dataset.tdone! });
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
    if (q("[data-testalarm]")) {
      const at = new Date(clock().getTime() + 10_000);
      const a: Alarm = { key: `test@${at.getTime()}`, ref: "", kind: "event", at: stamp(at), atMs: at.getTime(), title: "알람 시험", body: "10초 뒤 시험 알람입니다" };
      timers.push(window.setTimeout(() => fireAlarm(a), 10_000));
      return;
    }
    if (q("#bhSettings")) return;
    if (q("[data-v]")) {
      view = q("[data-v]")!.dataset.v as ViewName;
      return render();
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
    if (e.key === "Escape") {
      if (!printRoot.hidden) printRoot.hidden = true;
      else if (settingsOpen) {
        settingsOpen = false;
        root.querySelector<HTMLElement>("#bhSettings")!.hidden = true;
      } else if (chatOpen) setChat(false);
      return;
    }
    if (e.key !== "Enter" || e.isComposing) {
      if (e.key === " " && el.matches("[data-tdone],[data-sub],[data-drag]")) {
        e.preventDefault();
        el.click();
      }
      return;
    }
    if (el.matches("[data-tdone],[data-sub],[data-ok],[data-no]") && !(el instanceof HTMLButtonElement)) {
      el.click();
      return;
    }
    if (el.matches("[data-drag]")) {
      setChat(!chatOpen);
      return;
    }
    if (el instanceof HTMLInputElement && el.dataset.subadd) {
      const id = el.dataset.subadd;
      const v = el.value;
      if (v.trim()) userAction({ type: "addSub", ref: id, title: v.trim() }, false);
      void act(() => undefined).then(() => root.querySelector<HTMLInputElement>(`[data-subadd="${id}"]`)?.focus());
      return;
    }
    if (el instanceof HTMLInputElement && (el.id === "bhIn" || el.id === "bhChatIn")) {
      const v = el.value;
      el.value = "";
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
      if (el.dataset.board === "lock") board.lock = (el as HTMLInputElement).checked;
      if (el.dataset.board === "hideSchool") board.hideSchool = (el as HTMLInputElement).checked;
      await adapter.setBoard(board.lock, board.hideSchool);
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
    const key = el.dataset.set;
    if (!key) return;
    if (key === "theme") s.settings.theme = el.value as ThemeName;
    if (key === "mode") s.settings.mode = el.value as "dark" | "light";
    if (key === "samples") s.settings.showSamples = (el as HTMLInputElement).checked;
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
    chatOpen = open;
    const el = root.querySelector<HTMLElement>("#bhChat");
    el?.classList.toggle("open", open);
    root.classList.toggle("chat-open", open);
    if (open) {
      renderChat();
      root.querySelector<HTMLInputElement>("#bhChatIn")?.focus();
    }
  }
  const onDown = (e: PointerEvent) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>("[data-drag]");
    if (!g) return;
    drag = { y: e.clientY, open: g.dataset.drag === "close" };
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const el = root.querySelector<HTMLElement>("#bhChat")!;
    el.style.transition = "none";
    if (!drag.open && dy < 0) el.style.transform = `translateY(calc(105% + ${dy}px))`;
    else if (drag.open && dy > 0) el.style.transform = `translateY(${dy}px)`;
  };
  const onUp = (e: PointerEvent) => {
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
  root.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  adapter.onAlarm((a) => fireAlarm(a));
  adapter.onShared?.((shared, pendingActions) => {
    s.events = shared.events;
    s.tasks = shared.tasks;
    s.periods = shared.periods;
    s.notes = shared.notes;
    s.appliedActions = shared.appliedActions.slice();
    const now = clock();
    for (const a of pendingActions) applyAction(s, a, now);
    void adapter.save(s);
    syncAlarms();
    render();
  });
  adapter.onFileDrop?.((paths) => paths.forEach((p) => void submitPath(p)));

  let lastWidthCompact = false;
  const onResize = () => {
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

  return {
    state: s,
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
    render,
    destroy() {
      timers.forEach((x) => window.clearInterval(x));
      fcHost.destroy();
      printRoot.remove();
      stopBeep();
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", onFocus);
    }
  };
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
