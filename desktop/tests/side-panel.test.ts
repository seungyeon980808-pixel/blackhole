/** The chat panel on the right, result cards, and questions answered in the chat. */
import { afterEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, type CalendarState } from "../src/calendar/model";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
const NOW = new Date(2026, 9, 27, 9, 0);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;

function state(): CalendarState {
  const s = emptyState();
  s.tasks.push({ id: "t1", kind: "task", title: "지마켓 반품", details: "반품 기한 11월 2일", area: "personal", source: "데스크톱", createdAt: "2026-10-21T09:00", due: "2026-10-30", dueTime: null, done: false, reminders: [], subs: [] });
  s.tasks.push({ id: "t2", kind: "task", title: "연수 보고서 제출", area: "school", source: "데스크톱", createdAt: "2026-10-26T09:00", due: "2026-10-29", dueTime: "18:00", done: false, reminders: ["2026-10-29T09:00"], subs: [] });
  return s;
}

async function mount(adapter: BlackholeAdapter, width = 1300): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => width });
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW), seed: false });
  return root;
}

afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

function mac(extra: Partial<BlackholeAdapter> = {}): BlackholeAdapter & { calls: string[] } {
  const calls: string[] = [];
  const st = state();
  return {
    ...memoryAdapter(),
    origin: "데스크톱",
    load: async () => st,
    claude: async () => claude,
    analyze: async () => {
      calls.push("analyze");
      return proposal;
    },
    aiSkipped: (r) => calls.push(`skip:${r}`),
    onPut: () => undefined,
    askSources: async () => ({ secrets: [{ name: "학교 와이파이", at: "2026-10-01T08:00" }], notes: [] }),
    askAi: async (q, lines) => {
      calls.push(`ai:${lines.length}`);
      return { answer: "반품은 문 앞 수거로 하기로 했어요.", ids: ["t1"] };
    },
    calls,
    ...extra
  } as BlackholeAdapter & { calls: string[] };
}

describe("chat panel on the right", () => {
  it("wide window: the panel holds the one input; the bottom bar is empty", async () => {
    const root = await mount(mac());
    expect(root.classList.contains("side")).toBe(true);
    expect(root.querySelector("#bhChat #bhIn")).not.toBeNull();
    expect(root.querySelector("#bhComp")!.innerHTML).toBe("");
    expect(root.style.getPropertyValue("--panel-w")).toBe("290px"); // compact by default
  });

  it("folding is remembered; the header 「대화」 brings it back; width is remembered", async () => {
    localStorage.setItem("bh-panel-w", "420");
    let root = await mount(mac());
    expect(root.style.getPropertyValue("--panel-w")).toBe("420px");
    root.querySelector<HTMLButtonElement>('[data-panel="close"]')!.click();
    expect(root.classList.contains("side")).toBe(false);
    expect(localStorage.getItem("bh-panel")).toBe("closed");
    app!.destroy();
    root = await mount(mac());
    expect(root.classList.contains("side")).toBe(false);
    expect(root.classList.contains("panel-closed")).toBe(true);
    expect(root.querySelector("#bhComp #bhIn")).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-panel="open"]')!.click();
    expect(root.classList.contains("side")).toBe(true);
    expect(localStorage.getItem("bh-panel")).toBe("open");
  });

  it("a narrow window folds it by itself (the choice stays 「open」)", async () => {
    const root = await mount(mac(), 820);
    expect(root.classList.contains("side")).toBe(false);
    expect(localStorage.getItem("bh-panel")).toBeNull();
  });

  it("the phone keeps the bottom input", async () => {
    const root = await mount({ ...mac(), origin: "휴대폰" });
    expect(root.classList.contains("side")).toBe(false);
    expect(root.querySelector('[data-panel="open"]')).toBeNull();
  });
});

describe("results as cards in the chat", () => {
  it("a put-in is one card (draft, then refined in place) with 수정·열기; no toast copy", async () => {
    const root = await mount(mac());
    await app!.submitText("내일 3시 회의 있고 그 전에 자료 인쇄");
    const cards = app!.state.chat.filter((m) => m.who === "ai" && m.refs?.length);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).not.toContain("다듬는 중");
    const thread = root.querySelector("#bhThread")!;
    expect(thread.querySelector("[data-edit]")).not.toBeNull();
    expect(thread.querySelector("[data-open]")).not.toBeNull();
  });

  it("수정 changes title and time in place; ⌘Z puts it back", async () => {
    const root = await mount(mac());
    await app!.submitText("내일 3시 치과");
    const ev = app!.state.events.find((e) => e.title === "치과")!;
    root.querySelector<HTMLButtonElement>("#bhThread [data-edit]")!.click();
    const form = root.querySelector<HTMLElement>("#bhThread [data-editing]")!;
    form.querySelector<HTMLInputElement>(".ed-t")!.value = "치과 정기검진";
    form.querySelector<HTMLInputElement>(".ed-h")!.value = "16:30";
    form.querySelector<HTMLInputElement>(".ed-t")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ev.title).toBe("치과 정기검진");
    expect(ev.start).toBe("16:30");
    expect(ev.end).toBe("17:30");
    expect(ev.reminders).toEqual(["2026-10-28T16:00"]);
    expect(ev.touched).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    expect(ev.title).toBe("치과");
    expect(ev.start).toBe("15:00");
  });
});

describe("questions in the chat", () => {
  it("a clear question is answered here (no AI), with cards to open and copy", async () => {
    const a = mac();
    const root = await mount(a);
    await app!.submitText("이번 주 마감 뭐 있어?");
    const last = app!.state.chat.at(-1)!;
    expect(last.text).toBe("이번 주 마감 2개");
    expect(last.hits!.map((h) => h.id)).toEqual(["t2", "t1"]);
    expect(a.calls).toEqual([]);
    expect(root.querySelector("#bhThread [data-copy]")).not.toBeNull();
  });

  it("a secret is found by name; the card copies after Touch ID (the value never shows)", async () => {
    const root = await mount(mac());
    await app!.submitText("학교 와이파이 비번 뭐였지?");
    expect(app!.state.chat.at(-1)!.text).toBe("키체인에 있어요 · 복사는 Touch ID 뒤");
    expect(root.querySelector('#bhThread [data-secretcopy="학교 와이파이"]')).not.toBeNull();
  });

  it("a fuzzy question goes to the AI with only the lines found", async () => {
    const a = mac();
    await mount(a);
    await app!.submitText("반품 수거는 어떻게 하기로 했지?");
    expect(a.calls).toEqual(["ai:1"]);
    const last = app!.state.chat.at(-1)!;
    expect(last.text).toBe("반품은 문 앞 수거로 하기로 했어요.");
    expect(last.hits!.map((h) => h.id)).toEqual(["t1"]);
  });

  it("「내일 3시에 알려줘」 asks once: 찾아보기 or 넣기", async () => {
    const a = mac();
    const root = await mount(a);
    await app!.submitText("내일 3시에 알려줘");
    expect(app!.state.chat.at(-1)!.choice).toBe("내일 3시에 알려줘");
    root.querySelector<HTMLButtonElement>('#bhThread [data-choose="put"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app!.state.chat.some((m) => m.choice)).toBe(false);
    expect(app!.state.chat.some((m) => m.who === "me" && m.text === "내일 3시에 알려줘")).toBe(true);
  });
});
