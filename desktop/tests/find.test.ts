/** 찾기 칸 (머리줄) · 대화는 넣기와 AI 질문 · 받아쓰기 교정 묻기 (2026-10-27 사용자 지적). */
import { afterEach, describe, expect, it } from "vitest";
import { AskIndex, answer, docsOf } from "../src/calendar/ask";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, type CalendarState } from "../src/calendar/model";

const NOW = new Date(2026, 9, 27, 10, 40);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 200, monthUsd: 0.07, budgetUsd: 3, skipSimple: true };
const tick = () => new Promise((r) => setTimeout(r, 0));
let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

const b = { area: "school" as const, source: "데스크톱", createdAt: "2026-10-20T08:00" };
function base(): CalendarState {
  const s = emptyState();
  s.notes.push({ ...b, id: "n1", kind: "note", title: "2학년 4반 진도 종료", details: "" });
  s.notes.push({ ...b, id: "n2", kind: "note", title: "오반도 진도 종료", details: "" });
  s.tasks.push({ ...b, id: "t1", kind: "task", title: "생기부 점검", due: "2026-10-30", dueTime: "17:00", done: false, reminders: [], subs: [] });
  s.events.push({ ...b, id: "e1", kind: "event", title: "학년 협의회", date: "2026-10-28", start: "15:00", end: "16:00", provisional: false, reminders: [] });
  s.chat.push({ id: "c1", at: "2026-10-26T09:00", who: "ai", text: "「반품」 기록을 찾지 못했어요" });
  s.chat.push({ id: "c2", at: "2026-10-26T09:01", who: "ai", text: "초안 1건을 AI가 다듬었어요.", refs: ["t1"] });
  return s;
}

async function mount(st: CalendarState, extra: Partial<BlackholeAdapter> = {}) {
  document.body.innerHTML = '<div id="app" style="width:1400px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1400 });
  const calls: string[] = [];
  app = await mountBlackhole(root, {
    ...memoryAdapter(), origin: "데스크톱", load: async () => st, claude: async () => claude, onPut: () => undefined,
    askSources: async () => ({ secrets: [{ name: "학교 와이파이", at: "2026-10-01T08:00" }], notes: [] }),
    askAi: async (_q, lines) => {
      calls.push(lines.join("\n"));
      return { answer: "2학년 4반이에요.", ids: ["n1"] };
    },
    ...extra
  }, { now: () => new Date(NOW), seed: false });
  return { root, calls };
}

describe("forgiving search", () => {
  it("「지금 진도가 다 끝난 반이 몇반이지?」 finds 「2학년 4반 진도 종료」 (different words, spaces, endings)", () => {
    const idx = new AskIndex(docsOf(base(), null));
    expect(idx.find("지금 진도가 다 끝난 반이 몇반이지?")[0].doc.id).toBe("n1");
    // 「반」 alone (one letter) does not pull in everything with 반 in it.
    const s = base();
    s.tasks.push({ ...b, id: "t9", kind: "task", title: "도서 반납", due: "2026-11-01", dueTime: null, done: false, reminders: [], subs: [] });
    expect(new AskIndex(docsOf(s, null)).find("지금 진도가 다 끝난 반이 몇반이지?").map((x) => x.doc.id)).not.toContain("t9");
    expect(idx.find("진도끝난반").map((x) => x.doc.id)).toContain("n1");
    expect(idx.find("협의 회").map((x) => x.doc.id)).toEqual(["e1"]);
    // The chat's answer engine no longer gives up on it: the record goes to the AI as grounds.
    const a = answer(idx, "지금 진도가 다 끝난 반이 몇반이지?", NOW);
    expect(a.hits.map((h) => h.id)).toContain("n1");
  });
});

describe("the find box", () => {
  it("results as you type, grouped by kind with day and source; Enter opens; the AI button sends only those", async () => {
    const { root, calls } = await mount(base());
    const box = root.querySelector<HTMLInputElement>("#bhFind")!;
    box.value = "진도";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const res = root.querySelector<HTMLElement>("#bhFindRes")!;
    expect(res.hidden).toBe(false);
    expect(res.querySelector(".fg")!.textContent).toContain("기억");
    expect([...res.querySelectorAll<HTMLElement>(".fr")].map((x) => x.dataset.fopen)).toEqual(expect.arrayContaining(["n1", "n2"]));
    expect(res.querySelector(".fw")!.textContent).toContain("데스크톱");
    expect(res.querySelector(".fask")!.textContent).toContain("약 0.5원");
    expect(calls).toEqual([]); // typing is local, 0원
    res.querySelector<HTMLButtonElement>("[data-fask]")!.click();
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("진도 종료");
    expect(app!.state.chat.at(-1)!.text).toBe("2학년 4반이에요.");
    expect(app!.state.chat.at(-1)!.hits!.map((h) => h.id)).toEqual(["n1"]);
  });

  it("a to-do can be done or moved right from the result; Enter opens its day", async () => {
    const { root } = await mount(base());
    const box = root.querySelector<HTMLInputElement>("#bhFind")!;
    box.value = "생기부";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector('[data-fmove="t1"]')).not.toBeNull();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.querySelector<HTMLElement>("#bhFindRes")!.hidden).toBe(true);
    expect(root.querySelector('#bhMain [data-ev="t1"]')).not.toBeNull();
    box.value = "생기부";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-fdone="t1"]')!.click();
    expect(app!.state.tasks[0].done).toBe(true);
  });
});

describe("the chat is for putting in and asking the AI", () => {
  it("old 「기록을 찾지 못했어요」 lines are hidden; 「초안 N건을 AI가 다듬었어요」 is gone, the card stays", async () => {
    const { root } = await mount(base());
    const thread = root.querySelector("#bhThread")!.textContent!;
    expect(thread).not.toContain("찾지 못했어요");
    expect(thread).not.toContain("다듬었어요");
    expect(thread).toContain("생기부 점검");
  });
});

describe("dictation fix on old records", () => {
  it("asked once in 확인할 것; nothing changes by itself; 고치기 fixes, 그대로 is remembered", async () => {
    const { root } = await mount(base());
    app!.setView("day", "2026-10-27");
    expect(app!.state.notes[1].title).toBe("오반도 진도 종료");
    root.querySelector<HTMLButtonElement>("[data-checks]")!.click();
    expect(root.querySelector(".fixq")!.textContent).toContain("「오반도 진도 종료」 → 「5반도 진도 종료」");
    root.querySelector<HTMLButtonElement>("[data-fixskip]")!.click();
    expect(root.querySelector(".fixq")).toBeNull();
    expect(app!.state.notes[1].title).toBe("오반도 진도 종료");
    localStorage.removeItem("bh-fixskip");
    app!.destroy();
    const again = await mount(base());
    app!.setView("day", "2026-10-27");
    again.root.querySelector<HTMLButtonElement>("[data-checks]")!.click();
    again.root.querySelector<HTMLButtonElement>("[data-fixall]")!.click();
    await tick();
    expect(app!.state.notes[1].title).toBe("5반도 진도 종료");
  });
});

describe("the chat input", () => {
  it("a multi-line box: ⇧Enter is a new line, Enter puts it in; my words keep time·source once per minute", async () => {
    const { root } = await mount(base());
    const box = root.querySelector<HTMLTextAreaElement>("#bhIn")!;
    expect(box.tagName).toBe("TEXTAREA");
    box.value = "메모 첫 줄";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(box.value).toBe("메모 첫 줄");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(box.value).toBe("");
    await tick();
    expect(app!.state.chat.some((m) => m.who === "me" && m.text === "메모 첫 줄")).toBe(true);
    // My words sit in their own row class (not the 기억 list's 「.mrow」, whose no-wrap rule broke long lines).
    expect(root.querySelector("#bhThread .brow .bub.me")).not.toBeNull();
    expect(root.querySelector("#bhThread .mrow")).toBeNull();
  });
});
