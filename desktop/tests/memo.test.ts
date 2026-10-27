/** A note to remember is never forced into an appointment (user's answers, 2026-10-27). */
import { afterEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus, InboxDraft, InboxStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { memoDraft } from "../src/calendar/rules";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
const NOW = new Date(2026, 9, 27, 9, 0);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;

async function mount(adapter: BlackholeAdapter): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
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
  return {
    ...memoryAdapter(),
    origin: "데스크톱",
    claude: async () => claude,
    analyze: async () => {
      calls.push("analyze");
      return proposal;
    },
    aiSkipped: (r) => calls.push(`skip:${r}`),
    writeMemo: async (t, via) => void calls.push(`note:${via}:${t}`),
    onPut: () => undefined,
    calls,
    ...extra
  } as BlackholeAdapter & { calls: string[] };
}

describe("memo or calendar", () => {
  it("rules: no day/time → 기억 (final); 「메모 …」 → 기억; a date with no appointment words → 기억 draft for the AI", () => {
    expect(memoDraft("차 번호 12가 3456", NOW)).toEqual({ title: "차 번호 12가 3456", details: undefined, final: true });
    expect(memoDraft("행정실 내선 1234", NOW)?.final).toBe(true);
    expect(memoDraft("메모 내일 3시 치과는 김 원장님", NOW)).toMatchObject({ title: "내일 3시 치과는 김 원장님", final: true });
    expect(memoDraft("기억: 우산은 차 트렁크", NOW)?.title).toBe("우산은 차 트렁크");
    expect(memoDraft("11월 3일에 엄마가 김치 보내준대", NOW)?.final).toBe(false);
    expect(memoDraft("내일 3시 치과", NOW)).toBeNull();
    expect(memoDraft("금요일까지 보고서 제출", NOW)).toBeNull();
    expect(memoDraft("오늘 1620~2120 초과근무 일정", NOW)).toBeNull();
    expect(memoDraft("내일 학년 회의", NOW)).toBeNull();
  });

  it("a note goes in as 기억 at once: no AI, not on the calendar, also an Obsidian note", async () => {
    const a = mac();
    const root = await mount(a);
    await app!.submitText("차 번호 12가 3456");
    expect(app!.state.notes.map((n) => [n.title, n.draft])).toEqual([["차 번호 12가 3456", false]]);
    expect(app!.state.events.length + app!.state.tasks.length).toBe(0);
    expect(a.calls).toEqual(["skip:rule", "note:데스크톱:차 번호 12가 3456"]);
    expect(app!.state.chat.at(-1)!.text).toContain("달력에는 넣지 않았어요");
    expect(root.querySelector('#bhThread [data-convert^="event|"]')).not.toBeNull();
  });

  it("「일정으로」 makes it an appointment and opens its edit form; ⌘Z brings the note back", async () => {
    const root = await mount(mac());
    await app!.submitText("메모 엄마 생신 저녁 식당 예약 확인");
    const note = app!.state.notes[0];
    root.querySelector<HTMLButtonElement>('#bhThread [data-convert^="event|"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(note.gone).toBe(true);
    const ev = app!.state.events.find((e) => !e.gone)!;
    expect(ev.title).toContain("엄마 생신");
    expect(root.querySelector("#bhThread [data-editing] .ed-d")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(note.gone).toBeFalsy();
    expect(ev.gone).toBe(true);
  });

  it("a phone note (no day, no time) becomes a 기억 without the AI", async () => {
    const drafts: InboxDraft[] = [{ jobId: "job-1", fileName: "a.txt", text: "주차 B2 17번", kind: "text" }];
    const on: InboxStatus = { available: true, enabled: true, root: "/x", lastScanAt: null, lastError: null, running: false };
    let skipped: string[] = [];
    const a = mac({ inboxStatus: async () => on, setInbox: async () => on, inboxDrafts: async () => drafts, inboxDrafted: async (s) => void (skipped = s) });
    await mount(a);
    app!.state.settings.inboxEnabled = true;
    await app!.poll();
    expect(app!.state.notes.map((n) => n.title)).toEqual(["주차 B2 17번"]);
    expect(app!.state.tasks).toHaveLength(0);
    expect(skipped).toEqual(["job-1"]);
  });

  it("the 「기억」 view lists notes newest first", async () => {
    const root = await mount(mac());
    await app!.submitText("메모 첫째");
    await app!.submitText("메모 둘째");
    app!.setView("memo");
    expect(root.querySelector("#bhTitle")!.textContent).toBe("기억 2개");
    // One line each, newest first; the find box filters as you type; a click opens the card.
    expect([...root.querySelectorAll(".mrow .t")].map((b) => b.textContent)).toEqual(["둘째", "첫째"]);
    const box = root.querySelector<HTMLInputElement>("[data-memoq]")!;
    box.value = "첫";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...root.querySelectorAll(".mrow .t")].map((b) => b.textContent)).toEqual(["첫째"]);
    root.querySelector<HTMLElement>(".mrow")!.click();
    expect(root.querySelector(".mopen [data-convert]")).not.toBeNull();
  });
});

describe("desktop board", () => {
  it("shows today's appointments, late and due to-dos, the next days; checks go to the main page", async () => {
    const { boardHTML } = await import("../src/mac/board");
    const { emptyState } = await import("../src/calendar/model");
    const s = emptyState();
    const b = { area: "personal" as const, source: "t", createdAt: "2026-10-20T09:00" };
    s.events.push({ ...b, id: "e1", kind: "event", title: "초과근무", date: "2026-10-27", start: "16:20", end: "21:20", provisional: false, reminders: [] });
    s.events.push({ ...b, id: "e2", kind: "event", title: "조회", date: "2026-10-27", start: "08:00", end: "08:30", provisional: false, reminders: [] });
    s.tasks.push({ ...b, id: "t1", kind: "task", title: "관리비 납부", due: "2026-10-25", dueTime: null, done: false, reminders: [], subs: [] });
    s.tasks.push({ ...b, id: "t2", kind: "task", title: "출석부 정리", due: "2026-10-27", dueTime: "17:00", done: false, reminders: [], subs: [] });
    s.events.push({ ...b, id: "e3", kind: "event", title: "치과", date: "2026-10-28", start: "15:00", end: "16:00", provisional: false, reminders: [] });
    s.notes.push({ ...b, id: "n1", kind: "note", title: "차 번호" });
    const html = boardHTML(s, NOW);
    document.body.innerHTML = html;
    expect(document.querySelector(".bhd")!.textContent).toContain("10/27(화)");
    expect([...document.querySelectorAll("[data-open].br .bn")].map((x) => x.textContent)).toEqual(["조회", "초과근무"]);
    expect(document.querySelector('[data-open="e2"]')!.classList.contains("past")).toBe(true);
    expect(document.querySelector('[data-toggle="t1"]')!.closest(".br")!.textContent).toContain("2일 지남");
    expect(document.querySelector('[data-toggle="t2"]')).not.toBeNull();
    // 안 A: today only (no next days), no notes.
    expect(html).not.toContain("치과");
    expect(html).not.toContain("차 번호");
  });

  it("a check from the board reaches the main page", async () => {
    let put: ((p: import("../src/calendar/adapter").PutItem) => void) | null = null;
    await mount(mac({ onPut: (h) => (put = h) }));
    const t = { id: "t9", kind: "task" as const, title: "출석부 정리", area: "school" as const, source: "t", createdAt: "2026-10-27T08:00", due: "2026-10-27", dueTime: "17:00", done: false, reminders: [], subs: [] };
    app!.state.tasks.push(t);
    put!({ toggle: t.id, via: "바탕화면" });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.done).toBe(true);
  });
});
