/** Mac polish, second pass (2026-10-27): 「3시」 = afternoon, no repeated lists, settings, empty states. */
import { afterEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { modelName, mountBlackhole, shortcutKey, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus, DeskStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { isSimpleCertain, parseDraft, parseRule } from "../src/calendar/rules";
import { seedState } from "../src/calendar/samples";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
const NOW = new Date(2026, 9, 27, 8, 10);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;

async function mount(adapter: BlackholeAdapter, seed = false): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW), seed });
  return root;
}

afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
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
    onPut: () => undefined,
    calls,
    ...extra
  } as BlackholeAdapter & { calls: string[] };
}

describe("「3시」 said alone is the afternoon", () => {
  it("drafts 1–6시 as 13–18시, keeps 7시~ and anything with 오전/오후/새벽", () => {
    expect(parseDraft("내일 3시 치과", NOW).time).toBe("15:00");
    expect(parseDraft("내일 3시 반 치과", NOW).time).toBe("15:30");
    expect(parseDraft("내일 오전 3시 출발", NOW).time).toBe("03:00");
    expect(parseDraft("내일 새벽 5시 기상", NOW).time).toBe("05:00");
    expect(parseDraft("내일 오후 4시 상담", NOW).time).toBe("16:00");
    expect(parseDraft("내일 9시 미용실", NOW).time).toBe("09:00");
    expect(parseDraft("내일 15시 회의", NOW).time).toBe("15:00");
    // The phone's parser (shared fixture with Java) is unchanged.
    expect(parseRule("내일 3시 치과", NOW).time).toBe("03:00");
  });

  it("with no day said, 「3시」 in the morning means today 15:00 (not tomorrow 03:00)", () => {
    const r = parseDraft("3시 치과", NOW);
    expect(r.date).toBe("2026-10-27");
    expect(r.time).toBe("15:00");
    const late = parseDraft("3시 치과", new Date(2026, 9, 27, 16, 0));
    expect(late.date).toBe("2026-10-28");
  });

  it("「6시」 alone goes to the AI; 「3시」 alone may skip it and goes in at 15:00", async () => {
    expect(isSimpleCertain("내일 6시 치과", parseDraft("내일 6시 치과", NOW))).toBe(false);
    const a = mac();
    await mount(a);
    await app!.submitText("내일 3시 치과");
    expect(a.calls).toEqual(["skip:rule"]);
    const ev = app!.state.events.find((e) => e.title === "치과")!;
    expect(ev.start).toBe("15:00");
    expect(ev.reminders).toEqual(["2026-10-28T14:30"]);
  });
});

describe("no repeated information", () => {
  it("provisional events wait once, in 「확인할 것」 (no second list)", async () => {
    const a = mac();
    localStorage.clear();
    const st = seedState(NOW);
    for (const e of st.events) e.sample = false;
    await a.save(st);
    const root = await mount({ ...a, load: async () => st });
    app!.setView("day", "2026-10-27");
    root.querySelector<HTMLButtonElement>("[data-checks]")!.click();
    const checks = root.querySelector(".checks")!.textContent!;
    expect(checks).toContain("학년 협의회");
    expect(checks.split("학년 협의회").length).toBe(2); // once
  });

  it("the line above the input says a new entry once (no toast copy)", async () => {
    const root = await mount(mac());
    await app!.submitText("내일 3시 치과");
    expect(root.querySelector("#bhLast")!.textContent).toContain("치과");
    expect(root.querySelector<HTMLElement>("#bhToast")!.hidden).toBe(true);
  });
});

describe("empty states and the input", () => {
  it("no to-dos: one line instead of three empty groups; the input says how to put things in", async () => {
    const root = await mount(mac());
    app!.setView("day", "2026-10-27");
    const box = root.querySelector(".box.grow")!.textContent!;
    expect(box).toContain("없음 · 「금요일까지 보고서」");
    expect(box).not.toContain("나중 0");
    expect(root.querySelector<HTMLInputElement>("#bhIn")!.placeholder).toContain("내일 3시 치과");
  });

  it("today's to-dos in full; 「이번 주 · 나중」 one folded line, drawn when opened", async () => {
    const st = seedState(NOW);
    for (let i = 0; i < 20; i++) st.tasks.push({ id: `x${i}`, kind: "task", title: `먼 일 ${i}`, area: "personal", source: "t", createdAt: "2026-10-01T00:00", due: "2026-12-20", dueTime: null, done: false, reminders: [], subs: [] });
    const root = await mount({ ...mac(), load: async () => st });
    app!.setView("day", "2026-10-27");
    const fold = root.querySelector(".box.grow details.fold")!;
    expect(fold.querySelector("summary")!.textContent).toMatch(/나중 22/);
    // An opened fold stays open after a re-render (a check, the minute tick).
    expect(fold.querySelectorAll(".trow").length).toBe(0); // rows drawn only when opened
    (fold as HTMLDetailsElement).open = true;
    fold.dispatchEvent(new Event("toggle"));
    const again = root.querySelector(".box.grow details.fold")!;
    expect(again.hasAttribute("open")).toBe(true);
    expect(again.querySelectorAll(".trow").length).toBe(25); // 3 this week + 22 later
    app!.render();
    expect(root.querySelector(".box.grow details.fold")!.hasAttribute("open")).toBe(true);
  });
});

describe("settings", () => {
  const desk: DeskStatus = {
    settings: { shortcuts: { quick: "Ctrl+Alt+Super+Space", clipboard: "Ctrl+Alt+Super+V", capture: "" }, autostart: true, alarmSound: "Glass", onboarded: true, rightCmdTwice: false },
    autostartOn: true, pretty: { quick: "⌃⌥⌘Space", clipboard: "⌃⌥⌘V", capture: "" }, problems: [], sounds: ["Glass"], accessibility: true, raycastDir: ""
  };

  it("shows the model by name and records a shortcut from the keys pressed", async () => {
    let saved: DeskStatus["settings"] | null = null;
    const root = await mount(mac({ desk: async () => desk, setDesk: async (s) => ((saved = s), { ...desk, settings: s }) }));
    root.querySelector<HTMLButtonElement>("[data-settings]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const panel = root.querySelector("#bhSettings")!;
    expect(panel.textContent).toContain("Claude Haiku 5.5");
    expect(panel.textContent).not.toContain("Ctrl+Alt");
    root.querySelector<HTMLButtonElement>('[data-setg="mac"]')!.click();
    const field = root.querySelector<HTMLInputElement>('#bhSettings [data-desk-sc="capture"]')!;
    expect(field.value).toBe("끔");
    field.focus();
    expect(field.value).toBe("키를 누르세요");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, altKey: true, metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(saved!.shortcuts.capture).toBe("Ctrl+Alt+Super+S");
  });

  it("maps key codes and model ids", () => {
    expect(shortcutKey("KeyV")).toBe("V");
    expect(shortcutKey("Digit3")).toBe("3");
    expect(shortcutKey("Space")).toBe("Space");
    expect(shortcutKey("MetaLeft")).toBeNull();
    expect(modelName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
  });
});

describe("said time ranges (「오늘 1620~2120 초과근무 일정」 went in as all-day)", () => {
  it("reads 1620~2120, 16:20~21:20 and 4시~6시 as start and end", async () => {
    const { parseDraft, timeRange, clockText } = await import("../src/calendar/rules");
    const r = parseDraft("오늘 1620~2120 초과근무 일정", NOW);
    expect([r.kind, r.date, r.time, r.end, r.title]).toEqual(["SCHEDULE", "2026-10-27", "16:20", "21:20", "초과근무"]);
    expect(timeRange("내일 16:20~21:20 당직")).toMatchObject({ start: "16:20", end: "21:20" });
    expect(timeRange("모레 4시~6시 상담")).toMatchObject({ start: "16:00", end: "18:00" });
    expect(timeRange("오전 10시부터 12시까지 연수")).toMatchObject({ start: "10:00", end: "12:00" });
    expect(timeRange("택배 1620개")).toBeNull();
    expect(clockText("오늘 1620~2120 초과근무 일정")).toBe("오늘 16:20~21:20 초과근무 일정");
    expect(clockText("오늘 1320까지 안내 메세지 보내기")).toBe("오늘 13:20까지 안내 메세지 보내기");
  });

  it("goes in at once as 16:20–21:20 (no AI needed), alarm 30 min before", async () => {
    const a = mac();
    await mount(a);
    await app!.submitText("오늘 1620~2120 초과근무 일정");
    const ev = app!.state.events.find((e) => e.title === "초과근무")!;
    expect([ev.date, ev.start, ev.end, ev.draft]).toEqual(["2026-10-27", "16:20", "21:20", false]);
    expect(ev.reminders).toEqual(["2026-10-27T15:50"]);
    expect(a.calls).toEqual(["skip:rule"]);
  });

  it("a complaint is not put in as a new entry", async () => {
    const a = mac();
    await mount(a);
    await app!.submitText("초과근무 오늘 일정 추가하라고 했는데 왜 이상하게 들어가냐");
    expect(app!.state.events.filter((e) => !e.sample)).toHaveLength(0);
    expect(a.calls).toEqual([]);
  });

  it("when the AI loses a said time (all-day), the said time stays", async () => {
    const { emptyState } = await import("../src/calendar/model");
    const { draftFromText, refineDrafts } = await import("../src/calendar/store");
    const s = emptyState();
    const d = draftFromText(s, "오늘 1620~2120 초과근무 회의", "데스크톱", NOW, "k1");
    const p = structuredClone(proposal);
    p.items = [{ ...p.items.find((i) => i.kind === "SCHEDULE")!, title: "초과근무 회의", startAt: "2026-10-27T00:00:00+09:00", endAt: "", reminders: [], reminderAt: "" }];
    // What happened: the AI found no time words in 「1620~2120」 (timeText empty) → all-day.
    p.items[0].evidence = { ...p.items[0].evidence, timeText: "" };
    refineDrafts(s, "k1", p, "데스크톱", NOW);
    const ev = s.events.find((e) => e.id === d.id)!;
    expect([ev.start, ev.end]).toEqual(["16:20", "21:20"]);
  });
});

describe("times written the way people type them", () => {
  it.each([
    ["오늘 16202120 초과근무", "16:20", "21:20"],
    ["오늘 1620 2120 초과근무", "16:20", "21:20"],
    ["오늘 16시 20부터 21시 20까지 초과근무", "16:20", "21:20"],
    ["오늘 16시20분~21시20분 초과근무", "16:20", "21:20"],
    ["오늘 16:20부터 21:20까지 초과근무", "16:20", "21:20"],
    ["오늘 1620-2120 초과근무", "16:20", "21:20"],
    ["내일 오후 4시 반부터 6시까지 상담", "16:30", "18:00"]
  ])("%s → %s~%s", async (text, a, b) => {
    const { parseDraft } = await import("../src/calendar/rules");
    const r = parseDraft(text, NOW);
    expect([r.kind, r.time, r.end, r.title]).toEqual(["SCHEDULE", a, b, r.title]);
    expect(r.title).not.toMatch(/\d/);
  });

  it.each([
    ["오늘 16:20 회의", "2026-10-27", "16:20"],
    ["내일 16시 20 치과", "2026-10-28", "16:20"],
    ["3시 20에 치과", "2026-10-27", "15:20"],
    ["오늘 1620 회의", "2026-10-27", "16:20"]
  ])("%s → %s %s", async (text, day, time) => {
    const { parseDraft } = await import("../src/calendar/rules");
    const r = parseDraft(text, NOW);
    expect([r.date, r.time, r.hasTime]).toEqual([day, time, true]);
  });

  it("numbers that are not times stay numbers", async () => {
    const { timeRange, singleTime } = await import("../src/calendar/rules");
    expect(timeRange("20261027 회의록")).toBeNull();
    expect(singleTime("택배 1620개")).toBeNull();
    expect(singleTime("차 번호 1620")).toBeNull(); // no day word
    expect(singleTime("오늘 택배 1620원")).toBeNull();
    expect(timeRange("010 1234 5678")).toBeNull();
  });

  it("「오늘 16202120 초과근무」 goes in as 16:20–21:20 at once", async () => {
    const a = mac();
    await mount(a);
    await app!.submitText("오늘 16202120 초과근무");
    const ev = app!.state.events.find((e) => e.title === "초과근무")!;
    expect([ev.date, ev.start, ev.end]).toEqual(["2026-10-27", "16:20", "21:20"]);
    expect(a.calls).toEqual(["skip:rule"]);
  });
});

describe("「오늘 1320까지 …」 (a deadline time)", () => {
  it("is a to-do due today 13:20, and the AI losing the time does not undo it", async () => {
    const { parseDraft } = await import("../src/calendar/rules");
    const r = parseDraft("오늘 1320까지 학교폭력유공교원가산점대상자 안내 메세지 보내기", NOW);
    expect([r.kind, r.date, r.time]).toEqual(["TODO", "2026-10-27", "13:20"]);
    const { emptyState } = await import("../src/calendar/model");
    const { draftFromText, refineDrafts } = await import("../src/calendar/store");
    const s = emptyState();
    const d = draftFromText(s, "오늘 1320까지 안내 메세지 보내기", "데스크톱", NOW, "k2");
    const p = structuredClone(proposal);
    p.items = [{ ...p.items.find((i) => i.kind === "TODO")!, title: "안내 메세지 보내기", startAt: "", endAt: "", reminders: [], reminderAt: "", needsReview: true, reviewReasons: ["시간 표현을 해석하지 못함: 「1320」"] }];
    p.items[0].evidence = { ...p.items[0].evidence, timeText: "" };
    refineDrafts(s, "k2", p, "데스크톱", NOW);
    const t = s.tasks.find((x) => x.id === d.id)!;
    expect([t.due, t.dueTime, t.noDue]).toEqual(["2026-10-27", "13:20", undefined]);
    expect(t.review ?? []).toEqual([]);
  });
});
