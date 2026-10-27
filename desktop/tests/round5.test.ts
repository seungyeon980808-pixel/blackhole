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
  it("퇴근 전 · 점심 전/때 · n교시 전/후/에 · 1320까지 become clock times; 오반 → 5반", () => {
    const d = DEFAULT_SETTINGS;
    expect(timeWords("퇴근 전에 서류 내기", d)).toBe("16:40까지 서류 내기");
    expect(timeWords("점심 전 출석부", d)).toBe("12:10까지 출석부");
    expect(timeWords("3교시 후 상담", d)).toContain("11:20");
    expect(timeWords("5교시에 공개수업", d)).toContain("13:00~13:40");
    expect(timeWords("1320까지 안내", d)).toBe("13:20까지 안내");
    expect(fixNumbers("오반도 같이 가요")).toBe("5반도 같이 가요");
    expect(fixNumbers("삼학년 회의")).toBe("3학년 회의");
    expect(fixNumbers("이반 입니다")).toBe("2반 입니다");
    const r = parseDraft("오늘 퇴근 전에 공문 회신", NOW, d);
    expect([r.kind, r.date, r.time]).toEqual(["TODO", "2026-10-27", "16:40"]);
    const p = parseDraft("내일 5교시에 공개수업", NOW, d);
    expect([p.kind, p.time, p.end]).toEqual(["SCHEDULE", "13:00", "13:40"]);
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
