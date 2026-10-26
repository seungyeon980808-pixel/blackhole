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
  it("확정 대기 does not list today's or tomorrow's provisional events (already under 일정 with 확정/취소)", async () => {
    const a = mac();
    localStorage.clear();
    const st = seedState(NOW);
    await a.save(st);
    const root = await mount({ ...a, load: async () => st });
    app!.setView("day", "2026-10-27");
    const pend = root.querySelector(".inbox")?.textContent ?? "";
    expect(pend).toContain("학년 협의회"); // day after tomorrow
    expect(pend).not.toContain("안과 진료"); // today, shown under 일정
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

  it("a long 나중 list shows 8 and folds the rest", async () => {
    const st = seedState(NOW);
    for (let i = 0; i < 20; i++) st.tasks.push({ id: `x${i}`, kind: "task", title: `먼 일 ${i}`, area: "personal", source: "t", createdAt: "2026-10-01T00:00", due: "2026-12-20", dueTime: null, done: false, reminders: [], subs: [] });
    const root = await mount({ ...mac(), load: async () => st });
    app!.setView("day", "2026-10-27");
    const fold = root.querySelector(".box.grow details.fold")!;
    expect(fold.querySelector("summary")!.textContent).toMatch(/\d+개 더/);
    // An opened fold stays open after a re-render (a check, the minute tick).
    expect(fold.querySelectorAll(".task").length).toBe(0); // rows drawn only when opened
    (fold as HTMLDetailsElement).open = true;
    fold.dispatchEvent(new Event("toggle"));
    const again = root.querySelector(".box.grow details.fold")!;
    expect(again.hasAttribute("open")).toBe(true);
    expect(again.querySelectorAll(".task").length).toBe(14); // 20 + the 2 seed ones, minus the 8 shown
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
    const field = panel.querySelector<HTMLInputElement>('[data-desk-sc="capture"]')!;
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
