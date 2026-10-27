/** Parent session's batch A·B (2026-10-27): 24-hour times, ranges, easy re-timing, hover cards, duplicates. */
import { afterEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { DEFAULT_SETTINGS, emptyState, type CalendarState } from "../src/calendar/model";
import { fixNumbers, parseDraft, timeWords } from "../src/calendar/rules";
import { duplicates, tipHTML } from "../src/calendar/views/common";
import { dayStrip } from "../src/calendar/views/glass";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
const NOW = new Date(2026, 9, 27, 9, 0);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

function base(): CalendarState {
  const s = emptyState();
  const b = { area: "personal" as const, source: "데스크톱", createdAt: "2026-10-27T08:00" };
  s.events.push({ ...b, id: "e1", kind: "event", title: "초과근무", date: "2026-10-27", start: "16:20", end: "21:20", provisional: false, reminders: ["2026-10-27T15:50"] });
  s.events.push({ ...b, id: "e2", kind: "event", title: "통화", date: "2026-10-27", start: "10:00", end: null, provisional: false, reminders: [] });
  s.tasks.push({ ...b, id: "t1", kind: "task", title: "보고서", details: "결재까지", due: "2026-10-27", dueTime: "17:00", done: false, reminders: ["2026-10-27T16:30"], subs: [{ title: "자료", done: true }, { title: "초안", done: false }] });
  s.tasks.push({ ...b, id: "t2", kind: "task", title: "택배", due: "2026-10-27", dueTime: null, done: true, reminders: [], subs: [] });
  return s;
}

async function mount(st: CalendarState, extra: Partial<BlackholeAdapter> = {}): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, { ...memoryAdapter(), origin: "데스크톱", load: async () => st, claude: async () => claude, analyze: async () => proposal, aiSkipped: () => undefined, onPut: () => undefined, ...extra }, { now: () => new Date(NOW), seed: false });
  return root;
}

describe("time words (B-7, B-8)", () => {
  it("the user's school day (출근 08:20 · 퇴근 16:20 · 점심 12:20–13:20 · 45-minute periods); 오반 → 5반", () => {
    const d = DEFAULT_SETTINGS;
    expect(timeWords("퇴근 전에 서류 내기", d)).toBe("16:20까지 서류 내기");
    expect(timeWords("출근 전 복사", d)).toBe("08:20까지 복사");
    expect(timeWords("점심 전 출석부", d)).toBe("12:20까지 출석부");
    expect(timeWords("점심시간에 상담", d)).toContain("12:20~13:20");
    expect(timeWords("1320까지 안내", d)).toBe("13:20까지 안내");
    expect(fixNumbers("오반도 같이 가요")).toBe("5반도 같이 가요");
    expect(fixNumbers("삼학년 회의")).toBe("3학년 회의");
    expect(fixNumbers("이반 입니다")).toBe("2반 입니다");
    // 「3교시에 ○○」 → 10:40–11:25 · 「3교시 전」 → 10:40 deadline · 「6교시 끝나고」 → from 15:00
    const a = parseDraft("내일 3교시에 공개수업", NOW, d);
    expect([a.kind, a.time, a.end]).toEqual(["SCHEDULE", "10:40", "11:25"]);
    const b = parseDraft("내일 3교시 전 학습지 인쇄", NOW, d);
    expect([b.kind, b.time]).toEqual(["TODO", "10:40"]);
    const c = parseDraft("내일 6교시 끝나고 학부모 상담", NOW, d);
    expect([c.kind, c.time]).toEqual(["SCHEDULE", "15:00"]);
    const r = parseDraft("오늘 퇴근 전에 공문 회신", NOW, d);
    expect([r.kind, r.date, r.time]).toEqual(["TODO", "2026-10-27", "16:20"]);
  });

  it("old placeholder school times saved by the first build are replaced", async () => {
    const { normalizeState } = await import("../src/calendar/model");
    const st = normalizeState({ schemaVersion: 1, settings: { offWork: "16:40", lunch: "12:10-13:00", periods: ["09:00-09:40"] } })!;
    expect([st.settings.offWork, st.settings.lunch, st.settings.periods[2]]).toEqual(["16:20", "12:20-13:20", "10:40-11:25"]);
    const mine = normalizeState({ schemaVersion: 1, settings: { offWork: "17:00", lunch: "12:00-13:00", periods: ["09:00-09:40"] } })!;
    expect(mine.settings.offWork).toBe("17:00"); // the user's own change stays
  });
});

describe("the day (A-2, A-5, B-10, B-11)", () => {
  it("bars say their time range; no end is drawn the default length and marked; done to-dos fold at the bottom", async () => {
    const root = await mount(base());
    app!.setView("day", "2026-10-27");
    const bar = root.querySelector<HTMLElement>('.strip [data-ev="e1"]')!;
    expect(bar.textContent).toContain("16:20–21:20 초과근무");
    const open = root.querySelector<HTMLElement>('.strip [data-ev="e2"]')!;
    expect(open.classList.contains("noend")).toBe(true);
    expect(open.textContent).toContain("끝 미정");
    expect(root.querySelector(".box.grow h4")!.textContent).toContain("완료 1");
    expect([...root.querySelectorAll(".box.grow > .trow .t")].map((x) => x.textContent)).toEqual(["보고서"]);
    expect(root.querySelector(".box.grow details.fold summary")!.textContent).toBe("완료 1");
    expect(root.querySelector('.trow[data-ev="t1"] .lft')!.textContent).toBe("8시간 남음");
  });

  it("the strip is 24-hour only", () => {
    const s = base();
    const html = dayStrip({ s, cur: NOW, view: "day", today: "2026-10-27", now: NOW, nowM: 540, connection: { label: "", detail: "" }, inboxLine: "", recording: false, busy: false }, "2026-10-27");
    expect(html).not.toMatch(/오전|오후|AM|PM/);
    expect(html).toContain("16:20–21:20");
  });
});

describe("changing the time (A-3)", () => {
  it("the card's time box takes 1620~1730 and ↑↓ moves by 10 minutes; ⌘Z puts it back", async () => {
    const root = await mount(base());
    root.querySelector<HTMLElement>('.strip [data-ev="e1"]')!.click();
    root.querySelector<HTMLButtonElement>("#bhPop [data-edit]")!.click();
    const box = root.querySelector<HTMLInputElement>("#bhPop .ed-h, [data-editing] .ed-h")!;
    expect(box.value).toBe("16:20~21:20");
    box.value = "1600~1730";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(box.value).toBe("16:10~17:40");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const ev = app!.state.events.find((e) => e.id === "e1")!;
    expect([ev.start, ev.end, ev.reminders[0]]).toEqual(["16:10", "17:40", "2026-10-27T15:40"]);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    expect([ev.start, ev.end]).toEqual(["16:20", "21:20"]);
  });
});

describe("hover card (A-4)", () => {
  it("has the whole title, time range, sub-tasks, reminders, details and source", () => {
    const s = base();
    const html = tipHTML({ s, cur: NOW, view: "day", today: "2026-10-27", now: NOW, nowM: 540, connection: { label: "", detail: "" }, inboxLine: "", recording: false, busy: false }, "t1", (k) => k);
    for (const w of ["보고서", "17:00까지", "☑ 자료", "☐ 초안", "알림 16:30", "결재까지", "데스크톱"]) expect(html).toContain(w);
  });
});

describe("duplicates (B-6)", () => {
  it("the same appointment twice is offered 「합치기」 (the later one is marked gone, ⌘Z brings it back)", async () => {
    const s = base();
    s.events.push({ ...s.events[0], id: "e9", createdAt: "2026-10-27T08:05" });
    expect(duplicates(s).map((d) => [d.x.id, d.of.id])).toEqual([["e9", "e1"]]);
    const root = await mount(s);
    root.querySelector<HTMLButtonElement>("[data-checks]")!.click();
    root.querySelector<HTMLButtonElement>('[data-merge="e9"]')!.click();
    expect(s.events.find((e) => e.id === "e9")!.gone).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    expect(s.events.find((e) => e.id === "e9")!.gone).toBeFalsy();
  });
});

describe("widget sizes (C, user's choice)", () => {
  it("small: today's ranges, open to-dos, deadlines soon, an input; large adds the day bar, tomorrow, this week and recent chat", async () => {
    const { boardHTML } = await import("../src/mac/board");
    const s = base();
    s.tasks.push({ id: "t3", kind: "task", title: "선물 주문", area: "personal", source: "t", createdAt: "2026-10-20T08:00", due: "2026-10-28", dueTime: null, done: false, reminders: [], subs: [] });
    s.chat.push({ id: "c1", at: "2026-10-27T08:00", who: "me", text: "오늘 16202120 초과근무" });
    document.body.innerHTML = boardHTML(s, NOW, "small");
    expect(document.body.textContent).toContain("16:20–21:20");
    expect(document.body.textContent).toContain("마감 임박");
    expect(document.querySelector(".bin")).not.toBeNull();
    expect(document.querySelector('[data-size="large"]')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/오전|오후|AM|PM/);
    document.body.innerHTML = boardHTML(s, NOW, "large");
    expect(document.querySelector(".sline .sbar")!.textContent).toContain("10:00");
    expect(document.body.textContent).toContain("이번 주 마감");
    expect(document.querySelector(".bb.me")!.textContent).toBe("오늘 16202120 초과근무");
    expect(document.querySelector('[data-size="small"]')).not.toBeNull();
  });
});
