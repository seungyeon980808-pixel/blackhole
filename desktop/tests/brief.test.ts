// 먼저 알려 주는 비서 (2026-10-31): 출근 때 오늘 할 일 한눈에, 퇴근 전 못 끝낸 할 일 → 한 번에 옮기기. AI 없음.
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, type CalEvent, type Task } from "../src/calendar/model";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});
const task = (id: string, title: string, due: string, dueTime: string | null = null): Task => ({ id, kind: "task", title, area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", due, dueTime, done: false, reminders: [], subs: [] });

async function mount(now: string) {
  const s = emptyState();
  s.events.push({ id: "e1", kind: "event", title: "7반 수업", area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", date: "2026-10-30", start: "09:45", end: "10:30", provisional: false, reminders: [] } as CalEvent);
  s.tasks.push(task("t1", "과학물품 엑셀 전달", "2026-10-30", "16:00"), task("t2", "대의원회 기안 올리기", "2026-10-29", "15:10"), task("t3", "생기부 점검", "2026-11-05"));
  const adapter = memoryAdapter();
  await adapter.save(s);
  document.body.innerHTML = '<div id="app" style="width:1300px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
  app = await mountBlackhole(root, adapter, { now: () => new Date(now) });
  return root;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("출근·퇴근 전 한눈에", () => {
  it("출근 때(금 08:30): 일정·마감·밀린 할 일 한 줄씩, 「밀린 1개 오늘로」 한 번에 (⌘Z 한 번)", async () => {
    const root = await mount("2026-10-30T08:30:00");
    const m = app!.state.chat.at(-1)!;
    expect(m.text.split("\n")).toEqual(["오늘 10/30(금)", "일정 1 — 09:45 7반 수업", "마감 1 — 16:00 과학물품 엑셀 전달", "밀린 할 일 1 — 대의원회 기안 올리기(10/29(목))"]);
    app!.render();
    root.querySelector<HTMLElement>("[data-brief]")!.click();
    await tick();
    const t2 = app!.state.tasks.find((t) => t.id === "t2")!;
    expect([t2.due, t2.dueTime]).toEqual(["2026-10-30", "15:10"]);
    // Once a day.
    expect(app!.state.chat.filter((x) => x.brief)).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await tick();
    expect(t2.due).toBe("2026-10-29");
  });

  it("퇴근 20분 전(금 16:05): 안 끝난 할 일 → 「모두 월요일로 옮기기」", async () => {
    const root = await mount("2026-10-30T16:05:00");
    const m = app!.state.chat.filter((x) => x.brief?.kind === "pm").at(-1)!;
    expect(m.text).toBe("퇴근 전 · 오늘까지인데 안 끝난 할 일 2\n대의원회 기안 올리기(10/29(목)) · 과학물품 엑셀 전달");
    app!.render();
    const btn = [...root.querySelectorAll<HTMLElement>("[data-brief]")].find((b) => b.textContent!.includes("월요일"))!;
    expect(btn.textContent).toBe("2개 모두 월요일로 옮기기");
    btn.click();
    await tick();
    expect(app!.state.tasks.filter((t) => t.id !== "t3").map((t) => t.due)).toEqual(["2026-11-02", "2026-11-02"]);
    expect(app!.state.tasks.find((t) => t.id === "t3")!.due).toBe("2026-11-05");
  });

  it("주말에는 없음", async () => {
    await mount("2026-10-31T08:30:00");
    expect(app!.state.chat.filter((x) => x.brief)).toHaveLength(0);
  });
});
