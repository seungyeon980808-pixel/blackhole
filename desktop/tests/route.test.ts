// 넣기·질문·설정 나누기 in the whole app (mounted, as on the Mac), the AI answers stubbed: a mixed
// message puts its part in and answers its question; a setting order is done with 「되돌리기」;
// an answer keeps only lines with real grounds and says where it looked.
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, takeShared, type BlackholeApp } from "../src/calendar/app";
import { AnalyzeError, type BlackholeAdapter, type ClaudeStatus, type InboxDraft, type InboxStatus, type RoutePart } from "../src/calendar/adapter";
import { checkLines, gather, AskIndex, docsOf, WINDOWS, wantsRoute } from "../src/calendar/ask";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, sharedFrom, type CalEvent, type Memo } from "../src/calendar/model";
import type { Proposal } from "../src/worker/proposal";

const NOW = new Date("2026-10-29T08:50:00");
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

const part = (kind: RoutePart["kind"], text: string, x: Partial<RoutePart> = {}): RoutePart => ({ kind, text, question: "", terms: [], key: "", value: "", ...x });
const memo = (id: string, title: string, at: string): Memo => ({ id, kind: "note", title, area: "school", source: "데스크톱", createdAt: at });

const MORNING = "오늘 2교시 7반\n3교시 1반\n5교시 9반\n6교시 8반 수업 있음\n7반은 수행 점수 확인해야하고\n나머지 학급은 지금 진도가 다 끝났는지?";
const lessons: Proposal = {
  sourceText: "",
  needsReview: false,
  reviewReasons: [],
  items: ["7반 수업", "1반 수업"].map((title, i) => ({
    kind: "SCHEDULE", area: "SCHOOL", title, details: "", startAt: `2026-10-29T${String(9 + i).padStart(2, "0")}:00:00+09:00`, endAt: "", reminderAt: "", reminders: [`2026-10-29T${String(8 + i).padStart(2, "0")}:30:00+09:00`], subtasks: [],
    evidence: { sentence: title, dateText: "오늘", timeText: "", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: []
  })) as Proposal["items"]
} as unknown as Proposal;

async function mount(over: Partial<BlackholeAdapter>, setup?: (a: BlackholeApp) => void) {
  const calls = { route: [] as string[], answer: [] as { q: string; lines: string[] }[], analyze: [] as string[] };
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
  const adapter: BlackholeAdapter = {
    ...memoryAdapter(),
    origin: "데스크톱",
    claude: async () => claude,
    aiSkipped: () => undefined,
    writeMemo: async () => undefined,
    askAi: async () => ({ answer: "", ids: [] }),
    analyze: async (input: { text?: string }) => (calls.analyze.push(input.text ?? ""), lessons),
    ...over
  };
  const wrap = { ...adapter };
  if (adapter.routeText) wrap.routeText = (t) => (calls.route.push(t), adapter.routeText!(t));
  if (adapter.answerAi) wrap.answerAi = (q, l) => (calls.answer.push({ q, lines: l }), adapter.answerAi!(q, l));
  app = await mountBlackhole(root, wrap, { now: () => new Date(NOW), seed: false });
  setup?.(app);
  return { app, root, calls, s: app.state };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("when the words go to 나누기", () => {
  it("a question or a setting order goes; plain put-in and pasted messages do not", () => {
    expect(wantsRoute(MORNING)).toBe(true);
    expect(wantsRoute("알람은 수업 시작 2분 전에 울릴 수 있게 하십시오")).toBe(true);
    expect(wantsRoute("치과 언제야?")).toBe(true);
    expect(wantsRoute("내일 3시 치과")).toBe(false);
    expect(wantsRoute("오늘 2교시 7반\n3교시 1반 수업 있음")).toBe(false);
    expect(wantsRoute("[오전 8:02] 학년부장: 내일 회의 되시나요?\n[오전 8:03] 나: 네")).toBe(false);
    expect(wantsRoute("김부장: 내일 회의 참석 가능하신가요?")).toBe(false);
  });
});

describe("넣기·질문·설정 in the app", () => {
  it("the morning message: the lessons go in, the question gets an answer from the records", async () => {
    const { s, calls, root } = await mount(
      {
        routeText: async () => ({ parts: [part("put", MORNING.split("\n").slice(0, 5).join("\n")), part("ask", "나머지 학급은 지금 진도가 다 끝났는지?", { question: "1반·9반·8반 진도가 끝났는지?", terms: ["진도", "종료", "9반", "1반", "8반"] })] }),
        answerAi: async () => ({ enough: true, lines: [
          { text: "9반: 다음 시간에 성운부터", ids: ["n-9"], missing: false },
          { text: "1반·8반: 기록 없음", ids: [], missing: true },
          { text: "6반은 끝났을 거예요", ids: [], missing: false },
          { text: "3반: 끝남", ids: ["n-nope"], missing: false }
        ] })
      },
      (a) => a.state.notes.push(memo("n-9", "9반 다음 시간에 성운부터 설명해야함", "2026-10-28T10:00"), memo("n-6", "6반 진도 종료", "2026-10-28T11:00"))
    );
    await app!.submitText(MORNING);
    expect(calls.route).toEqual([MORNING]);
    // The put-in part only, as said, once.
    expect(calls.analyze).toEqual([MORNING.split("\n").slice(0, 5).join("\n")]);
    expect(s.events.filter((e) => !e.gone).map((e) => e.title)).toEqual(["7반 수업", "1반 수업"]);
    // The question: the 9반 record is among the lines sent (found by 「9반」, not 「진도」).
    expect(calls.answer).toHaveLength(1);
    expect(calls.answer[0].lines.some((l) => l.startsWith("[n-9]"))).toBe(true);
    const ans = s.chat.at(-1)!;
    // Grounded lines and a plain 「기록 없음」 stay; a guess and a made-up id go.
    expect(ans.text).toBe("9반: 다음 시간에 성운부터\n1반·8반: 기록 없음");
    expect(ans.hits?.map((h) => h.id)).toEqual(["n-9"]);
    // (The two lessons just put in are records too.)
    expect(ans.scope).toMatch(/기록 4개에서 찾음 · 근거 없는 줄 2개 뺌/);
    // The words once in the chat.
    expect(s.chat.filter((m) => m.who === "me").map((m) => m.text)).toEqual([MORNING]);
    render: {
      app!.render();
      expect(root.textContent).toContain("넣어 주세요");
      // 근거 is one folded line under the answer (not a card per record), opened only when asked.
      const fold = root.querySelector<HTMLDetailsElement>(".srcs")!;
      expect(fold.open).toBe(false);
      expect(fold.querySelector("summary")!.textContent).toMatch(/^근거 1개 · /);
      expect(fold.closest(".bub")!.querySelectorAll(".rc")).toHaveLength(0);
      expect(root.textContent).toContain("질문이었어요");
    }
  });

  it("「알람은 수업 시작 2분 전에」 changes the setting, moves the reminders still ahead, and undoes", async () => {
    const { s, root, calls } = await mount({ routeText: async () => ({ parts: [part("setting", "알람은 수업 시작 2분 전에 울릴 수 있게 하십시오", { key: "remindMinutes", value: "2" })] }) }, (a) => {
      a.state.events.push(
        { id: "e-a", kind: "event", title: "9반 수업", date: "2026-10-29", start: "13:20", end: "14:05", area: "school", source: "데스크톱", createdAt: "2026-10-29T08:00", provisional: false, reminders: ["2026-10-29T12:50"] } as CalEvent,
        { id: "e-b", kind: "event", title: "회의", date: "2026-10-29", start: "15:00", end: "16:00", area: "school", source: "데스크톱", createdAt: "2026-10-29T08:00", provisional: false, reminders: ["2026-10-29T14:50"] } as CalEvent
      );
    });
    await app!.submitText("알람은 수업 시작 2분 전에 울릴 수 있게 하십시오");
    expect(calls.analyze).toEqual([]);
    expect(s.settings.remindMinutes).toBe(2);
    expect(s.events.find((e) => e.id === "e-a")!.reminders).toEqual(["2026-10-29T13:18"]);
    // Said for itself (10분 전): stays.
    expect(s.events.find((e) => e.id === "e-b")!.reminders).toEqual(["2026-10-29T14:50"]);
    expect(s.chat.at(-1)!.text).toBe("알림 일정 30분 전 → 일정 2분 전 · 남은 일정 알림 1개도 옮김");
    app!.render();
    root.querySelector<HTMLElement>("[data-setundo]")!.click();
    await tick();
    expect(s.settings.remindMinutes).toBe(30);
    expect(s.events.find((e) => e.id === "e-a")!.reminders).toEqual(["2026-10-29T12:50"]);
    expect(s.chat.at(-1)!.text).toMatch(/되돌림$/);
  });

  it("new appointments then ring at the new lead (a reminder said for itself stays)", async () => {
    const { s } = await mount({}, (a) => (a.state.settings.remindMinutes = 2));
    await app!.submitText("오늘 2교시 7반 3교시 1반 수업");
    expect(s.events.filter((e) => !e.gone).map((e) => e.reminders)).toEqual([["2026-10-29T08:58"], ["2026-10-29T09:58"]]);
  });

  it("a setting the app does not have is said so", async () => {
    const { s } = await mount({ routeText: async () => ({ parts: [part("setting", "글씨 크게 해줘", { key: "unknown", value: "크게" })] }) });
    await app!.submitText("글씨 크게 해줘");
    expect(s.chat.at(-1)!.text).toMatch(/^그 설정은 앱에 없어요/);
  });

  it("「질문이었어요」 takes back what the words put in and asks instead", async () => {
    const { s, root, calls } = await mount({
      routeText: async (t) => ({ parts: [part(t.includes("진도") ? "ask" : "put", t, { terms: ["진도"] })] }),
      answerAi: async () => ({ enough: true, lines: [{ text: "6반: 끝남", ids: ["n-6"], missing: false }] })
    }, (a) => a.state.notes.push(memo("n-6", "6반 진도 종료", "2026-10-28T11:00")));
    // Taken as put-in by the router (wrongly): the 7반/1반 lessons.
    await app!.submitText("오늘 7반 1반 수업 다 했나?");
    expect(s.events.filter((e) => !e.gone)).toHaveLength(2);
    app!.render();
    root.querySelector<HTMLElement>("[data-redo]")!.click();
    for (let i = 0; i < 5; i++) await tick();
    expect(s.events.filter((e) => !e.gone)).toHaveLength(0);
    expect(calls.answer).toHaveLength(1);
    expect(s.chat.at(-1)!.text).toBe("6반: 끝남");
  });

  it("「? …」 is a question whatever it says; no AI → the local answer as before", async () => {
    const { s, calls } = await mount({ routeText: undefined, answerAi: undefined }, (a) => a.state.notes.push(memo("n-6", "6반 진도 종료", "2026-10-28T11:00")));
    await app!.submitText("?6반 진도");
    expect(calls.analyze).toEqual([]);
    expect(s.chat.at(-1)!.hits?.map((h) => h.id)).toEqual(["n-6"]);
  });

  it("not enough in ±3 months → the year is searched too", async () => {
    const { calls, s } = await mount({
      routeText: async (t) => ({ parts: [part("ask", t, { terms: ["체육대회"] })] }),
      answerAi: async (_q, lines) => (lines.some((l) => l.includes("n-old")) ? { enough: true, lines: [{ text: "4/15(수) 체육대회", ids: ["n-old"], missing: false }] } : { enough: false, lines: [] })
    }, (a) => a.state.notes.push(memo("n-old", "체육대회 4/15", "2026-04-15T09:00"), memo("n-new", "학급 회의", "2026-10-20T09:00")));
    await app!.submitText("작년 체육대회 언제였지?");
    expect(calls.answer).toHaveLength(2);
    expect(s.chat.at(-1)!.text).toBe("4/15(수) 체육대회");
    expect(s.chat.at(-1)!.scope).toMatch(/기록 2개에서 찾음/);
  });
});

describe("pasted chat", () => {
  it("the message times are not the meeting's time (the draft has the day only: 임시 09:00)", async () => {
    const { draftFromText } = await import("../src/calendar/store");
    const x = draftFromText(emptyState(), "[오전 8:02] 학년부장: 내일 회의 되시나요?\n[오전 8:03] 나: 네 됩니다", "t", NOW, "k") as CalEvent;
    expect([x.date, x.start]).toEqual(["2026-10-30", "09:00"]);
  });
});

describe("찾기 (RAG) and 근거 확인", () => {
  it("search words first, then the rest of the window nearest today; nothing outside the window", () => {
    const s = emptyState();
    s.notes.push(memo("a", "9반 다음 시간에 성운부터", "2026-10-28T10:00"), memo("b", "6반 진도 종료", "2026-10-20T10:00"), memo("c", "수학여행 숙소", "2026-10-29T08:00"), memo("old", "작년 진도표", "2025-09-01T08:00"));
    const g = gather(new AskIndex(docsOf(s, null)), ["진도"], NOW, WINDOWS[0]);
    expect(g.docs.map((d) => d.id)).toEqual(["b", "c", "a"]);
    expect(g.total).toBe(3);
  });
  it("a line stands only on records that were sent", () => {
    const sent = docsOf(Object.assign(emptyState(), { notes: [memo("a", "x", "2026-10-28T10:00")] }), null);
    expect(checkLines([{ text: "ok", ids: ["[a]"], missing: false }, { text: "guess", ids: [], missing: false }, { text: "없음", ids: [], missing: true }, { text: "made up", ids: ["z"], missing: false }], sent)).toEqual({
      lines: [{ text: "ok", ids: ["a"], missing: false }, { text: "없음", ids: [], missing: true }],
      dropped: 2
    });
  });
});

describe("a question from the phone", () => {
  it("the phone sends it to the Mac (no draft, no local guess)", async () => {
    const sent: string[] = [];
    const { s } = await mount({
      routeText: undefined,
      answerAi: undefined,
      onShared: () => undefined,
      analyze: async (input: { text?: string }) => {
        sent.push(input.text ?? "");
        throw new AnalyzeError("QUEUED", "올림", "job-q");
      }
    });
    await app!.submitText("9반 진도 어디까지 했지?");
    expect(sent).toEqual(["9반 진도 어디까지 했지?"]);
    expect([...s.events, ...s.tasks, ...s.notes]).toHaveLength(0);
    expect(s.chat.at(-1)!.text).toMatch(/^Mac에 물어봤어요/);
  });

  it("the Mac answers it (the worker never gets the job) and the answer reaches the phone once", async () => {
    const drafts: InboxDraft[] = [{ jobId: "job-q", fileName: "a.txt", text: "9반 진도 어디까지 했지?", kind: "text" }];
    const on: InboxStatus = { available: true, enabled: true, root: "/x", lastScanAt: null, lastError: null, running: false };
    const skipped: string[] = [];
    const { s, calls } = await mount({
      inboxStatus: async () => on,
      setInbox: async () => on,
      inboxDrafts: async () => drafts,
      inboxDrafted: async (x) => void skipped.push(...x),
      routeText: async (t) => ({ parts: [part("ask", t, { terms: ["9반", "진도"] })] }),
      answerAi: async () => ({ enough: true, lines: [{ text: "9반: 다음 시간에 성운부터", ids: ["n-9"], missing: false }] })
    }, (a) => {
      a.state.settings.inboxEnabled = true;
      a.state.notes.push(memo("n-9", "9반 다음 시간에 성운부터 설명해야함", "2026-10-28T10:00"));
    });
    await app!.poll();
    expect(skipped).toContain("job-q");
    expect(calls.analyze).toEqual([]);
    expect(s.notes.map((n) => n.id)).toEqual(["n-9"]);
    const shared = sharedFrom(s, "2026-10-29T08:51");
    expect(shared.answers?.map((a) => a.text)).toEqual(["9반: 다음 시간에 성운부터"]);
    // On the phone: shown once, however often the copy comes.
    const phone = emptyState();
    takeShared(phone, shared, []);
    takeShared(phone, shared, []);
    expect(phone.chat.map((m) => [m.who, m.text])).toEqual([["ai", "9반: 다음 시간에 성운부터"]]);
  });
});
