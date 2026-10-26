/** Mac polish (2026-10-26): AI-free simple sentences, quick put-in, native alarms, inbox results. */
import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus, InboxDraft, InboxStatus, PutItem } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState } from "../src/calendar/model";
import { missedAlarms, type Alarm } from "../src/calendar/store";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
const NOW = new Date(proposal.referenceTime);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;

async function mount(adapter: BlackholeAdapter): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW), seed: false });
  return root;
}

afterEach(() => {
  app?.destroy();
  app = null;
});

function mac(extra: Partial<BlackholeAdapter> = {}): BlackholeAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    ...memoryAdapter(),
    origin: "데스크톱",
    claude: async () => claude,
    analyze: async () => {
      calls.push("analyze");
      return proposal;
    },
    aiSkipped: (r) => calls.push(`skip:${r}`),
    calls,
    ...extra
  } as BlackholeAdapter & { calls: string[] };
}

describe("simple sentences skip the AI", () => {
  it("a clear appointment goes in at once, final, with no API call", async () => {
    const a = mac();
    await mount(a);
    await app!.submitText("글피 오후 1시에 미용실 예약");
    expect(a.calls).toEqual(["skip:rule"]);
    const ev = app!.state.events.find((e) => e.title === "미용실 예약")!;
    expect(ev.draft).toBe(false);
    expect(ev.start).toBe("13:00");
    expect(app!.state.chat.at(-1)!.text).toContain("AI 생략");
  });

  it("anything less simple still goes to the AI, and the setting turns skipping off", async () => {
    const a = mac();
    await mount(a);
    await app!.submitText("내일 3시 회의 있고 그 전에 자료 인쇄");
    expect(a.calls).toEqual(["analyze"]);
    const b = mac({ claude: async () => ({ ...claude, skipSimple: false }) });
    app!.destroy();
    await mount(b);
    await app!.submitText("글피 오후 1시에 미용실 예약");
    expect(b.calls).toEqual(["analyze"]);
  });

  it("phone sentences: simple jobs are told to the Mac scanner as 「no AI」, the others wake it", async () => {
    let drafts: InboxDraft[] = [];
    const told: string[][] = [];
    const on: InboxStatus = { available: true, enabled: true, root: "/x", lastScanAt: null, lastError: null, running: false };
    const a = mac({ inboxStatus: async () => on, setInbox: async () => on, inboxDrafts: async () => drafts, inboxResults: async () => [], inboxDrafted: async (skip) => void told.push(skip) });
    await mount(a);
    app!.state.settings.inboxEnabled = true;
    drafts = [
      { jobId: "job-aaaa", fileName: "a.txt", text: "토요일 오후 6시 친구 결혼식", kind: "text" },
      { jobId: "job-bbbb", fileName: "b.txt", text: "금요일까지 보고서 제출: 자료 정리, 결재", kind: "text" }
    ];
    await app!.poll();
    expect(told).toEqual([["job-aaaa"]]);
    expect(app!.state.events.find((e) => e.srcKey === "job-aaaa")!.draft).toBe(false);
    expect(app!.state.tasks.find((t) => t.srcKey === "job-bbbb")!.draft).toBe(true);
    await app!.poll();
    expect(told).toHaveLength(1);
  });
});

describe("quick put-in (quick window, clipboard, Dock, capture)", () => {
  it("files go to the inbox folder when it is on, otherwise straight to the analyzer; text like typing", async () => {
    let put: ((p: PutItem) => void) | null = null;
    const inboxed: string[] = [];
    const on: InboxStatus = { available: true, enabled: true, root: "/x", lastScanAt: null, lastError: null, running: false };
    const a = mac({ inboxStatus: async () => on, setInbox: async () => on, onPut: (h) => (put = h), inboxPut: async (p) => (inboxed.push(p), "x") });
    await mount(a);
    put!({ path: "/Users/me/Desktop/가정통신문.pdf", via: "Dock" });
    await vi.waitFor(() => expect(inboxed).toEqual(["/Users/me/Desktop/가정통신문.pdf"]));
    expect(app!.state.log.at(-1)!.msg).toContain("가정통신문.pdf → 인박스");
    expect(a.calls).toEqual([]);
    put!({ text: "글피 오후 1시에 미용실 예약", via: "클립보드" });
    await vi.waitFor(() => expect(app!.state.events.some((e) => e.title === "미용실 예약" && e.source === "클립보드")).toBe(true));
  });

  it("a link is kept as 기억 and its page goes to the AI without a rule draft", async () => {
    let put: ((p: PutItem) => void) | null = null;
    const seen: string[] = [];
    const a = mac({ onPut: (h) => (put = h), analyze: async (i) => (seen.push(i.text ?? ""), proposal) });
    await mount(a);
    put!({ link: { url: "https://school.example/fest", title: "가을 축제 안내", text: "11월 3일 오후 2시 강당" }, via: "클립보드" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toContain("제목: 가을 축제 안내") ;
    expect(app!.state.notes.some((n) => n.title === "링크 · 가을 축제 안내" && n.details === "https://school.example/fest")).toBe(true);
    expect(app!.state.events.some((e) => e.draft)).toBe(false);
  });
});

describe("native alarms (Mac alarm window)", () => {
  it("the page only marks the alarm; the window's answer comes back and is applied", async () => {
    let answer: ((a: Alarm, x: "done" | "snooze" | "ok") => void) | null = null;
    let fire: ((a: Alarm) => void) | null = null;
    const a = mac({ nativeAlarms: true, onAlarm: (h) => (fire = h), onAlarmAnswer: (h) => (answer = h) });
    const root = await mount(a);
    await app!.submitText("금요일까지 보고서 제출: 자료 정리, 결재"); // AI → proposal with a to-do + reminder
    const task = app!.state.tasks.find((t) => t.reminders.length)!;
    const alarm: Alarm = { key: `${task.id}@${task.reminders[0]}`, ref: task.id, kind: "task", at: task.reminders[0], atMs: 0, title: task.title, body: "" };
    fire!(alarm);
    expect(app!.state.firedAlarms).toContain(alarm.key);
    expect(root.querySelector("#bhAlarm.on")).toBeNull(); // no in-window overlay
    answer!(alarm, "done");
    await vi.waitFor(() => expect(app!.state.tasks.find((t) => t.id === task.id)!.done).toBe(true));
  });

  it("finds alarms missed while the app was off (once)", () => {
    const s = emptyState();
    Object.assign(s, { tasks: [{ id: "t1", kind: "task", title: "약 먹기", area: "personal", source: "x", createdAt: "2026-10-21T08:00", due: "2026-10-21", dueTime: null, done: false, reminders: ["2026-10-21T08:00", "2026-10-20T07:00", "2026-10-21T08:55"], subs: [] }] });
    const missed = missedAlarms(s, NOW);
    expect(missed.map((m) => m.at)).toEqual(["2026-10-21T08:00"]); // 07:00 yesterday is over a day old (>24h), 08:55 still rings
  });
});

describe("inbox results on the day view", () => {
  it("nothing in → no box; results are titles, technical lines folded; 검토 필요 stands out", async () => {
    const root = await mount(mac());
    expect(root.querySelector(".box.inbox")).toBeNull();
    await app!.submitText("글피 오후 1시에 미용실 예약");
    app!.render();
    const box = root.querySelector(".box.inbox")!;
    expect(box.querySelector("details.fold > summary")!.textContent).toBe("오늘 정리한 것 1");
    expect(box.querySelector("details.fold")!.hasAttribute("open")).toBe(false);
    expect(box.querySelector("details.tech")).not.toBeNull();
    expect(box.querySelector("h4.warn")).toBeNull();
    app!.state.events[0].review = ["시각을 추정함"];
    app!.render();
    expect(root.querySelector(".box.inbox h4.warn")!.textContent).toBe("검토 필요 1");
  });
});

describe("secrets, 기억, undo", () => {
  it("a secret never reaches the calendar, the chat or the AI", async () => {
    const asked: string[] = [];
    const a = mac({ secretIntake: async (t) => (asked.push(t), t.includes("비번") ? "secret" : "put") });
    await mount(a);
    const chatBefore = app!.state.chat.length;
    await app!.submitText("지마켓 비번 Abc!2345");
    expect(asked).toEqual(["지마켓 비번 Abc!2345"]);
    expect(a.calls).toEqual([]);
    expect(app!.state.chat.length).toBe(chatBefore);
    expect(JSON.stringify(app!.state)).not.toContain("Abc!2345");
  });

  it("a doubtful one is asked first; 「그냥 넣기」 puts it in", async () => {
    const a = mac({ secretIntake: async (_t, secret) => (secret === undefined ? "ask" : secret ? "secret" : "put") });
    const root = await mount(a);
    await app!.submitText("넷플릭스 Qz8!mPw2x");
    expect(root.querySelector("#bhLast")!.textContent).toContain("비밀번호 같아요");
    expect(app!.state.chat).toHaveLength(0);
    root.querySelector<HTMLElement>('[data-secret="no"]')!.click();
    await vi.waitFor(() => expect(a.calls).toEqual(["analyze"]));
  });

  it("⌘Enter 기억 is kept as typed; a search result opens its day; ⌘Z undoes", async () => {
    let put: ((p: PutItem) => void) | null = null;
    const a = mac({ onPut: (h) => (put = h) });
    await mount(a);
    put!({ memo: "학교 행정실 내선 1234\n오후만 받음", via: "빠른 입력" });
    await vi.waitFor(() => expect(app!.state.notes.some((n) => n.title === "학교 행정실 내선 1234" && n.details === "오후만 받음")).toBe(true));
    expect(a.calls).toEqual([]);
    const memo = app!.state.notes.find((n) => n.title === "학교 행정실 내선 1234")!;
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await vi.waitFor(() => expect(memo.gone).toBe(true));
    // ⌘Z walks back (it does not redo what it just undid).
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("#bhToast")!.textContent).toBe("되돌릴 것이 없어요"));
    expect(memo.gone).toBe(true);
  });

  it("지우기 then 되돌리기 brings it back (the bottom note and ⌘Z)", async () => {
    let put: ((p: PutItem) => void) | null = null;
    const a = mac({ onPut: (h) => (put = h) });
    const root = await mount(a);
    put!({ memo: "되돌리기 시험 메모", via: "빠른 입력" });
    await vi.waitFor(() => expect(app!.state.notes.some((n) => n.title === "되돌리기 시험 메모")).toBe(true));
    const memo = app!.state.notes.find((n) => n.title === "되돌리기 시험 메모")!;
    root.querySelector<HTMLElement>("#bhToast [data-undo]")!.click();
    await vi.waitFor(() => expect(memo.gone).toBe(true));
    expect(root.querySelector("#bhToast")!.textContent).toContain("되돌렸어요");
  });
});

describe("Korean holidays and the Mac menu", () => {
  it("shows the holiday in the day title; menu items reach the page", async () => {
    let menu: ((id: string) => void) | null = null;
    const root = await mount(mac({ onMenu: (h) => (menu = h) }));
    app!.setView("day", "2026-10-09");
    expect(root.querySelector("#bhTitle")!.textContent).toBe("10월 9일 (금) · 한글날");
    menu!("month");
    expect(root.querySelector('[data-v="month"]')!.classList.contains("on")).toBe(true);
    menu!("settings");
    expect(root.querySelector<HTMLElement>("#bhSettings")!.hidden).toBe(false);
  });
});
