/**
 * 2026-10-26 피드백: 초안 먼저(1초 안), AI는 나중에(같은 항목 갱신·중복 없음), 마감이 월·주·일에 보임.
 */
import { afterEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, takeShared, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, InboxDraft, InboxResult, InboxStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, normalizeState, sharedFrom, type Entry, type UserAction } from "../src/calendar/model";
import { applyAction, applyProposal, draftFromText, dueOn, refineDrafts } from "../src/calendar/store";
import { androidAdapter, type AndroidBridge } from "../src/phone/android-adapter";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
const NOW = new Date(proposal.referenceTime);
const SENTENCE = "내일 오후 3시에 학부모 상담 있고 금요일 6시까지 연수 보고서 제출: 자료 정리, 소감 작성, 결재";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function mount(adapter: BlackholeAdapter, seed = false) {
  document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW), seed });
  return root;
}

describe("draft first, AI later (Mac input)", () => {
  it("shows the rule draft within a second, before the AI answers, then refines the same entry", async () => {
    const ai = deferred<Proposal>();
    const root = await mount({ ...memoryAdapter(), origin: "데스크톱", analyze: () => ai.promise });
    const t0 = performance.now();
    const done = app!.submitText(SENTENCE);
    // The AI has not answered: the draft is already in the state and on screen.
    const draft = app!.state.events.find((e) => e.draft)!;
    expect(draft).toBeDefined();
    expect(draft.title).toContain("학부모 상담");
    expect(draft.provisional).toBe(true);
    app!.setView("day", draft.date);
    expect(root.querySelector(`[data-ev="${draft.id}"]`)).not.toBeNull();
    expect(root.textContent).toContain("초안");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(app!.lastDraftMs).not.toBeNull();
    expect(app!.lastDraftMs!).toBeLessThan(1000);

    ai.resolve(proposal);
    await done;
    const events = app!.state.events.filter((e) => !e.gone);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(draft.id);
    expect(events[0].draft).toBe(false);
    expect(events[0].title).toBe("학부모 상담");
    // The AI also found the to-do and the period: added once each, the draft task (none here) not duplicated.
    expect(app!.state.tasks.filter((t) => t.title === "연수 보고서 제출")).toHaveLength(1);
    expect(app!.state.periods).toHaveLength(1);
  });

  it("does not overwrite a draft changed by hand: it only offers the AI version", async () => {
    const ai = deferred<Proposal>();
    const root = await mount({ ...memoryAdapter(), origin: "데스크톱", analyze: () => ai.promise });
    const done = app!.submitText("내일 3시 학부모 상담");
    const draft = app!.state.events.find((e) => e.draft)!;
    app!.setView("day", draft.date);
    root.querySelector<HTMLButtonElement>(`[data-ok="${draft.id}"]`)!.click();
    await Promise.resolve();
    expect(draft.touched).toBe(true);
    ai.resolve(proposal);
    await done;
    const kept = app!.state.events.find((e) => e.id === draft.id)!;
    expect(kept.start).toBe("15:00"); // the user's (rule) version stays (「3시」 alone = afternoon)
    expect(kept.provisional).toBe(false);
    expect(kept.suggest?.length).toBe(3);
    // The AI's offer is in the entry's card (a click on its bar on the day band).
    root.querySelector<HTMLElement>(`.dtg [data-ev="${draft.id}"]`)!.click();
    expect(app!.state.events.filter((e) => !e.gone)).toHaveLength(1);
    app!.render();
    expect(root.textContent).toContain("AI 제안 있음");
    root.querySelector<HTMLButtonElement>(`[data-aiok="${draft.id}"]`)!.click();
    await Promise.resolve();
    const now = app!.state.events.find((e) => e.id === draft.id)!;
    expect(now.start).toBe("15:00");
    expect(now.suggest).toBeUndefined();
    expect(app!.state.tasks.some((t) => t.title === "연수 보고서 제출")).toBe(true);
  });

  it("refining twice (same job) never duplicates", () => {
    const s = emptyState();
    draftFromText(s, SENTENCE, "휴대폰", NOW, "job-0123456789abcdef");
    refineDrafts(s, "job-0123456789abcdef", proposal, "인박스", NOW);
    const count = s.events.length + s.tasks.length + s.periods.length;
    const again = refineDrafts(s, "job-0123456789abcdef", proposal, "인박스", NOW);
    expect(again.duplicate).toBe(true);
    expect(s.events.length + s.tasks.length + s.periods.length).toBe(count);
  });
});

describe("phone input on the Mac (inbox)", () => {
  it("drafts a phone transcript at once, then the AI result for the same job updates it in place", async () => {
    const job = "job-f2f305b83d494651";
    let drafts: InboxDraft[] = [];
    let results: InboxResult[] = [];
    const on: InboxStatus = { available: true, enabled: true, root: "/x", lastScanAt: null, lastError: null, running: false };
    const adapter: BlackholeAdapter = {
      ...memoryAdapter(),
      origin: "데스크톱",
      inboxStatus: async () => on,
      setInbox: async () => on,
      inboxDrafts: async () => drafts,
      inboxResults: async () => results
    };
    await mount(adapter);
    app!.state.settings.inboxEnabled = true;
    drafts = [{ jobId: job, fileName: "20261026-144200-폰-59ea29b6.wav", text: "내일 오후 3시에 학부모 상담", kind: "voice" }];
    await app!.poll();
    const draft = app!.state.events.find((e) => e.srcKey === job)!;
    expect(draft.draft).toBe(true);
    expect(draft.start).toBe("15:00");
    expect(app!.state.draftedJobs).toContain(job);
    await app!.poll(); // same file again: no second draft
    expect(app!.state.events.filter((e) => e.srcKey === job)).toHaveLength(1);

    results = [{ jobId: job, fileName: "x.wav", proposal, error: null }];
    await app!.poll();
    const ev = app!.state.events.filter((e) => e.srcKey === job && !e.gone);
    expect(ev).toHaveLength(1);
    expect(ev[0].id).toBe(draft.id);
    expect(ev[0].draft).toBe(false);
    // Shared with the phone: the job is listed, so the phone drops its own draft.
    expect(sharedFrom(app!.state, "x").sources).toContain(job);
  });
});

describe("phone drafts", () => {
  function bridge(shared: string) {
    const kept: Entry[][] = [];
    let local: Entry[] = [];
    const b: AndroidBridge = {
      loadState: () => "",
      saveState: () => undefined,
      sendText: () => JSON.stringify({ ok: true, message: "", job: "job-aaaaaaaaaaaaaaaa" }),
      sendFile: () => JSON.stringify({ ok: true, message: "" }),
      scheduleAlarms: () => undefined,
      sharedCopy: () => shared,
      refreshShared: () => undefined,
      recordAction: () => undefined,
      pendingActions: () => "[]",
      syncStatus: () => "",
      keepDrafts: (j: string) => {
        kept.push(JSON.parse(j));
        local = JSON.parse(j);
      },
      localDrafts: () => JSON.stringify(local)
    };
    return { b, kept };
  }

  it("shows a draft on the phone right after sending, keyed by the upload's job", async () => {
    const { b, kept } = bridge("");
    document.body.innerHTML = '<div id="app"></div>';
    app = await mountBlackhole(document.querySelector<HTMLElement>("#app")!, androidAdapter(b), { now: () => new Date(NOW), seed: false });
    await app.submitText("내일 3시 회의");
    const draft = app.state.events.find((e) => e.draft)!;
    expect(draft.srcKey).toBe("job-aaaaaaaaaaaaaaaa");
    expect(kept.at(-1)?.[0].id).toBe(draft.id);
    expect(app.state.chat.at(-1)!.text).toContain("초안");
  });

  it("keeps phone drafts over the Mac's copy until the Mac lists the job", () => {
    const s = emptyState();
    const local = draftFromText(emptyState(), "내일 3시 회의", "휴대폰", NOW, "job-aaaaaaaaaaaaaaaa");
    const mac = emptyState();
    takeShared(s, sharedFrom(mac, "x"), [local]);
    expect(s.events.map((e) => e.id)).toEqual([local.id]);
    mac.draftedJobs.push("job-aaaaaaaaaaaaaaaa");
    draftFromText(mac, "내일 3시 회의", "휴대폰", NOW, "job-aaaaaaaaaaaaaaaa");
    takeShared(s, sharedFrom(mac, "x"), [local]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].id).not.toBe(local.id);
  });

  it("a phone action on a Mac draft marks it touched there too", () => {
    const mac = emptyState();
    const d = draftFromText(mac, "내일 3시 회의", "휴대폰", NOW, "job-b");
    const a: UserAction = { id: "a1", at: "x", type: "confirm", ref: d.id };
    applyAction(mac, a, NOW);
    expect(d.touched).toBe(true);
    refineDrafts(mac, "job-b", proposal, "인박스", NOW);
    expect(mac.events.find((e) => e.id === d.id)!.suggest?.length).toBeGreaterThan(0);
  });
});

describe("deadlines on the calendar (month · week · day, both themes)", () => {
  function withDeadlines() {
    const s = emptyState();
    applyProposal(s, proposal, "데스크톱", NOW);
    const timed = s.tasks[0]; // 연수 보고서 제출, Friday 18:00
    s.tasks.push({ id: "t-today", kind: "task", title: "출석부 마감", area: "school", source: "x", createdAt: "x", due: "2026-10-21", dueTime: null, done: false, reminders: [], subs: [] });
    s.tasks.push({ id: "t-late", kind: "task", title: "지난 서류", area: "school", source: "x", createdAt: "x", due: "2026-10-19", dueTime: null, done: false, reminders: [], subs: [] });
    s.tasks.push({ id: "t-nodue", kind: "task", title: "언젠가 할 일", area: "personal", source: "x", createdAt: "x", due: "2026-10-21", dueTime: null, done: false, reminders: [], subs: [], noDue: true });
    return { s, timed };
  }

  async function mountWith(s: ReturnType<typeof emptyState>) {
    const adapter = memoryAdapter();
    await adapter.save(s);
    return mount(adapter);
  }

  it("glass: month chips say 마감 with urgency, the week grid puts a timed deadline at its time, the day timetable marks it", async () => {
    const { s, timed } = withDeadlines();
    const root = await mountWith(s);
    app!.setView("month", "2026-10-21");
    const month = root.querySelector(".fc-rolling-view")!;
    // 월 안 A: a dot + the title (red when today or late); 「마감」 and the urgency on hover.
    const hot = [...month.querySelectorAll<HTMLElement>(".c.due.mdot.hot")];
    expect(hot.some((x) => x.textContent === "출석부 마감" && x.title.includes("오늘"))).toBe(true);
    expect(hot.some((x) => x.title.includes("2일 지남"))).toBe(true);
    expect(month.textContent).toContain("연수 보고서 제출");
    expect(month.textContent).not.toContain("언젠가 할 일");

    app!.setView("week", timed.due);
    // 「업무 08–17」: an 18:00 deadline is folded into the row under the hours; 「하루 전체」 puts it at its time.
    expect(root.querySelector(".fc-timeGridWeek-view .bh-fold.bot")!.textContent).toContain(`이후 ${timed.dueTime} 연수 보고서 제출`);
    root.querySelector<HTMLElement>(".wrng")!.click();
    const week = root.querySelector(".fc-timeGridWeek-view")!;
    expect(week.querySelector(".bh-fold")).toBeNull();
    const due = week.querySelector<HTMLElement>(".fc-timegrid-event.bh-due .wbt")!;
    expect(due.textContent).toContain("연수 보고서 제출");
    expect(due.textContent).not.toContain(timed.dueTime!);
    expect(due.title).toContain(`마감 ${timed.dueTime} 연수 보고서 제출`);
    root.querySelector<HTMLElement>(".wrng")!.click();

    app!.setView("day", timed.due);
    // 오늘 화면: a timed deadline is a card on the day table with 「번호 · 시각 · 제목」 (or under it when outside the hours).
    const mark = root.querySelector<HTMLElement>(`.dt .dl[data-ev="${timed.id}"]`)!;
    expect(mark.textContent).toContain(`${timed.dueTime}연수 보고서 제출`);
    app!.setView("day", "2026-10-21");
    expect(root.querySelector(".tl")!.textContent).toContain("출석부 마감");
    expect(root.querySelector(".tl .due.urg")).not.toBeNull();
  });

  it("공문서: month chips, week table with time and urgency, day timetable", async () => {
    const { s, timed } = withDeadlines();
    s.settings.theme = "doc";
    const root = await mountWith(s);
    app!.setView("month", "2026-10-21");
    expect([...root.querySelectorAll(".fc-rolling-view .e.due.red")].map((x) => x.textContent).join()).toContain("□ 마감 출석부 마감 오늘");
    app!.setView("week", timed.due);
    const row = root.querySelector(`table.tb.week tr[data-day="${timed.due}"]`)!;
    expect(row.textContent).toContain(`${timed.dueTime} 연수 보고서 제출`);
    app!.setView("day", timed.due);
    expect(root.querySelector(".tl")!.textContent).toContain("연수 보고서 제출");
    expect(dueOn(app!.state, "2026-10-21").map((t) => t.title)).toEqual(["출석부 마감"]);
  });

  it("old tasks without a deadline are recognized when loading", () => {
    const st = normalizeState({ schemaVersion: 1, tasks: [{ id: "t-1", kind: "task", title: "a", due: "2026-10-26", dueTime: null, review: ["마감 날짜가 없어 오늘로 둠"] }] })!;
    expect(st.tasks[0].noDue).toBe(true);
  });
});

describe("hand-made changes on a phone draft reach the Mac's entry for the same job", () => {
  it("retargets by srcKey and waits when the job has not arrived yet", () => {
    const mac = emptyState();
    const phoneDraft = draftFromText(emptyState(), "내일 3시 회의", "휴대폰", NOW, "job-c0ffee0123456789");
    const a: UserAction = { id: "a9", at: "x", type: "confirm", ref: phoneDraft.id, src: "job-c0ffee0123456789" };
    expect(applyAction(mac, a, NOW)).toBe(false);
    expect(mac.appliedActions).not.toContain("a9"); // kept for a later pull
    mac.draftedJobs.push("job-c0ffee0123456789");
    const macDraft = draftFromText(mac, "내일 3시 회의", "휴대폰", NOW, "job-c0ffee0123456789") as import("../src/calendar/model").CalEvent;
    expect(applyAction(mac, a, NOW)).toBe(true);
    expect(macDraft.provisional).toBe(false);
    expect(macDraft.touched).toBe(true);
  });
});

describe("Drive 「달력.json」 is written only when it changes, at most every 10 s", () => {
  it("skips unchanged copies and inbox scans, spaces real changes", async () => {
    const { vi } = await import("vitest");
    const published: string[] = [];
    let scan = "2026-10-21T09:00:00";
    const on: InboxStatus = { available: true, enabled: true, root: "/x", lastScanAt: scan, lastError: null, running: false };
    const adapter: BlackholeAdapter = {
      ...memoryAdapter(),
      origin: "데스크톱",
      inboxStatus: async () => ({ ...on, lastScanAt: scan }),
      setInbox: async () => on,
      inboxResults: async () => [],
      analyze: async () => proposal,
      publishShared: async (s) => {
        published.push(s.exportedAt);
        return "ok";
      }
    };
    await mount(adapter);
    app!.state.settings.sharePhone = true;
    vi.useFakeTimers();
    try {
      // Scans finishing every few seconds change nothing: no write.
      for (let i = 0; i < 5; i++) {
        scan = `2026-10-21T09:00:0${i + 1}`;
        await app!.poll();
        await vi.advanceTimersByTimeAsync(5000);
      }
      expect(published).toHaveLength(0);
      await app!.submitText("내일 3시 회의");
      await vi.advanceTimersByTimeAsync(2000);
      expect(published).toHaveLength(1);
      // Another change right away waits for the 10 s gap, then one write for both.
      await app!.submitText("모레 4시 상담");
      await app!.submitText("글피 5시 면담");
      await vi.advanceTimersByTimeAsync(3000);
      expect(published).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(8000);
      expect(published).toHaveLength(2);
      // Saving with nothing new: no write.
      await app!.poll();
      await vi.advanceTimersByTimeAsync(20000);
      expect(published).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("glass look sliders (설정)", () => {
  it("defaults keep the approved look, sliders change blur and brightness and are saved, 공문서 is untouched", async () => {
    const adapter = memoryAdapter();
    const root = await mount(adapter, true);
    expect(app!.state.settings.glassBlur).toBe(26);
    expect(app!.state.settings.glassBright).toBe(0);
    expect(root.style.getPropertyValue("--bh-blur")).toBe("26px");
    root.querySelector<HTMLButtonElement>("[data-settings]")!.click();
    root.querySelector<HTMLButtonElement>('[data-setg="look"]')!.click(); // groups open one at a time
    const blur = root.querySelector<HTMLInputElement>('[data-set="glassBlur"]')!;
    blur.value = "10";
    blur.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.style.getPropertyValue("--bh-blur")).toBe("10px");
    blur.dispatchEvent(new Event("change", { bubbles: true }));
    const bright = root.querySelector<HTMLInputElement>('[data-set="glassBright"]')!;
    bright.value = "-25";
    bright.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(root.style.getPropertyValue("--bh-veil")).toContain("rgba(0,0,0,");
    const stored = normalizeState(await adapter.load())!;
    expect(stored.settings.glassBlur).toBe(10);
    expect(stored.settings.glassBright).toBe(-25);
    app!.setTheme("doc");
    expect(root.querySelector('[data-set="glassBlur"]')).toBeNull();
  });

  it("phone settings offer widget·lock-screen brightness/opacity and lock-screen to-dos", async () => {
    const calls: unknown[][] = [];
    const b: AndroidBridge = {
      loadState: () => "", saveState: () => undefined, sendText: () => "{}", sendFile: () => "{}", scheduleAlarms: () => undefined,
      sharedCopy: () => "", refreshShared: () => undefined, recordAction: () => undefined, pendingActions: () => "[]", syncStatus: () => "",
      boardOptions: () => JSON.stringify({ lock: false, hideSchool: false, status: "", bright: 0, opacity: 100, lockTasks: true, lockHideTitles: false }),
      setBoardOptions: () => undefined,
      setBoardLook: (x, y) => void calls.push(["look", x, y]),
      setLockTasks: (x, y) => void calls.push(["lock", x, y])
    };
    document.body.innerHTML = '<div id="app"></div>';
    app = await mountBlackhole(document.querySelector<HTMLElement>("#app")!, androidAdapter(b), { now: () => new Date(NOW), seed: false });
    document.querySelector<HTMLButtonElement>("[data-settings]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector<HTMLButtonElement>('[data-setg="inbox"]')!.click();
    const op = document.querySelector<HTMLInputElement>('[data-board="opacity"]')!;
    op.value = "60";
    op.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const hide = document.querySelector<HTMLInputElement>('[data-board="lockHideTitles"]')!;
    hide.checked = true;
    hide.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([["look", 0, 60], ["lock", true, true]]);
  });
});

describe("Claude API analyzer in 설정 and without a key", () => {
  it("keeps the draft and explains when there is no key; the key is pasted, never shown back", async () => {
    const { AnalyzeError } = await import("../src/calendar/adapter");
    let status = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: false, monthRequests: 0, monthUsd: 0 };
    const stored: string[] = [];
    const adapter: BlackholeAdapter = {
      ...memoryAdapter(),
      origin: "데스크톱",
      analyze: async () => {
        throw new AnalyzeError("API_KEY_MISSING", "Claude API 키가 없습니다.");
      },
      claude: async () => status,
      setClaudeKey: async (k) => {
        stored.push(k);
        status = { ...status, hasKey: true };
        return status;
      },
      clearClaudeKey: async () => (status = { ...status, hasKey: false }),
      checkClaude: async () => "연결됨"
    };
    const root = await mount(adapter);
    await app!.submitText("내일 3시 회의");
    const last = app!.state.chat.at(-1)!;
    expect(last.error).toBeUndefined();
    expect(last.text).toContain("초안으로 넣었어요");
    expect(app!.state.events.filter((e) => !e.gone)).toHaveLength(1);
    root.querySelector<HTMLButtonElement>("[data-settings]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    root.querySelector<HTMLButtonElement>('[data-setg="ai"]')!.click();
    const input = root.querySelector<HTMLInputElement>("[data-claude-key]")!;
    expect(input.type).toBe("password");
    input.value = "sk-ant-api03-test";
    root.querySelector<HTMLButtonElement>('[data-claude="save"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stored).toEqual(["sk-ant-api03-test"]);
    expect(root.textContent).toContain("키 저장됨");
    expect(root.innerHTML).not.toContain("sk-ant-api03-test");
    expect(root.textContent).toContain("이번 달 0회");
  });
});

describe("deadline labels in one hour row", () => {
  it("two deadlines at 12:00 get one label (「외 1」), not two overlapping ones", async () => {
    const { dueMarks } = await import("../src/calendar/views/common");
    const t = (id: string, title: string, dueTime: string) => ({ id, title, due: "2026-10-27", dueTime, done: false, subs: [], reminders: [], area: "personal", source: "x", createdAt: "x" }) as never;
    const html = dueMarks("2026-10-26", [t("a", "점심 메뉴 고민", "12:00"), t("b", "내PC지킴이 완료", "12:00")], 720, 780);
    expect(html.match(/<span>/g)).toHaveLength(1);
    expect(html).toContain("마감 점심 메뉴 고민 외 1");
    expect(html).toContain('title="마감 12:00 내PC지킴이 완료"');
  });
});
