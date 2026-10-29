/**
 * 2026-10-28 사용자 지적: 작은 카드의 단추가 글자를 덮고 내용을 고칠 수 없음 →
 * 마우스 올리기 = 미리보기, 누르기 = 오른쪽 상세 편집 패널(바로 저장 · ⌘Z), 두 번 누르기 = 제목만 그 자리에서.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, type CalEvent, type Task } from "../src/calendar/model";

const NOW = new Date("2026-10-28T10:40:00");
let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});

async function mount() {
  const s = emptyState();
  s.settings.theme = "glass";
  s.events.push({ id: "e1", kind: "event", title: "학년 협의회", area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", date: "2026-10-28", start: "13:20", end: "14:05", provisional: true, reminders: [] } as CalEvent);
  s.tasks.push({ id: "t1", kind: "task", title: "방과후 코디 선정", area: "school", source: "음성", createdAt: "2026-10-27T09:00", due: "2026-10-28", dueTime: "16:00", done: false, reminders: [], subs: [{ title: "명단", done: false }, { title: "결재", done: false }] } as Task);
  const adapter = memoryAdapter();
  await adapter.save(s);
  document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW) });
  app.setView("day", "2026-10-28");
  return root;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const undo = () => document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));

describe("상세 편집 패널", () => {
  it("a click opens it (no small card), every field saves at once and ⌘Z puts it back; Esc closes", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('.dtg [data-ev="e1"]')!.click();
    const panel = root.querySelector<HTMLElement>("#bhDetail")!;
    expect(panel.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("#bhPop")!.hidden).toBe(true);
    // The buttons are on their own row under the fields.
    expect(panel.querySelector(".dacts [data-ok='e1']")).not.toBeNull();
    const title = panel.querySelector<HTMLTextAreaElement>('[data-df="title"]')!;
    title.value = "학년 협의회 (3층 회의실)";
    title.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    const e = app!.state.events.find((x) => x.id === "e1")!;
    expect(e.title).toBe("학년 협의회 (3층 회의실)");
    const rem = root.querySelector<HTMLInputElement>('#bhDetail [data-df="rem"]')!;
    rem.value = "30분 전";
    rem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(e.reminders).toEqual(["2026-10-28T12:50"]);
    root.querySelector<HTMLElement>('#bhDetail [data-dstar="2"]')!.click();
    expect(e.star).toBe(2);
    root.querySelector<HTMLElement>('#bhDetail [data-darea="personal"]')!.click();
    expect(e.area).toBe("personal");
    undo();
    undo();
    undo();
    expect([e.area, e.star ?? 0, e.reminders.length]).toEqual(["school", 0, 0]);
    expect(e.title).toBe("학년 협의회 (3층 회의실)");
    root.querySelector<HTMLElement>('#bhDetail [data-df="title"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector<HTMLElement>("#bhDetail")!.hidden).toBe(true);
  });

  it("a to-do: time, sub-steps (add · up · delete), kind 일정 ↔ 할 일 keeps the panel on the new entry; outside click closes", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('.dtg [data-ev="t1"]')!.click();
    const t = app!.state.tasks.find((x) => x.id === "t1")!;
    const time = root.querySelector<HTMLInputElement>('#bhDetail [data-df="time"]')!;
    time.value = "1620";
    time.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(t.dueTime).toBe("16:20");
    root.querySelector<HTMLElement>('#bhDetail [data-dsubup="1"]')!.click();
    expect(t.subs.map((x) => x.title)).toEqual(["결재", "명단"]);
    root.querySelector<HTMLElement>('#bhDetail [data-dsubdel="0"]')!.click();
    expect(t.subs.map((x) => x.title)).toEqual(["명단"]);
    root.querySelector<HTMLElement>('#bhDetail [data-dkind="event"]')!.click();
    await tick();
    const made = app!.state.events.find((x) => x.title === "방과후 코디 선정" && !x.gone)!;
    expect(made.start).toBe("16:20");
    expect(root.querySelector<HTMLElement>("#bhDetail")!.dataset.id).toBe(made.id);
    root.querySelector<HTMLElement>("#bhMain")!.click();
    expect(root.querySelector<HTMLElement>("#bhDetail")!.hidden).toBe(true);
  });

  it("double click: the title only, in place (Enter saves, Esc leaves it)", async () => {
    const root = await mount();
    const box = root.querySelector<HTMLElement>('.dtg [data-ev="e1"] .t')!;
    box.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    let inp = root.querySelector<HTMLInputElement>(".inlined")!;
    expect(inp.value).toBe("학년 협의회");
    inp.value = "학년 협의회 연기";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(app!.state.events[0].title).toBe("학년 협의회");
    root.querySelector<HTMLElement>('.dtg [data-ev="e1"] .t')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    inp = root.querySelector<HTMLInputElement>(".inlined")!;
    inp.value = "학년 협의회 연기";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(app!.state.events[0].title).toBe("학년 협의회 연기");
    expect(root.querySelector(".inlined")).toBeNull();
  });

  it("the week and month open the same panel", async () => {
    const root = await mount();
    for (const v of ["week", "month"] as const) {
      app!.setView(v, "2026-10-28");
      root.querySelector<HTMLElement>('.fc [data-ev="e1"]')!.click();
      expect(root.querySelector<HTMLElement>("#bhDetail")!.dataset.id).toBe("e1");
      root.querySelector<HTMLElement>("#bhDetail [data-dclose]")!.click();
      expect(root.querySelector<HTMLElement>("#bhDetail")!.hidden).toBe(true);
    }
  });

  it("날짜·시각 고르기: 오늘·내일 단추, 작은 달력, 교시, 길이, 말로 쓰기, 날짜 없음 (각각 바로 저장)", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('.dtg [data-ev="e1"]')!.click();
    const panel = root.querySelector<HTMLElement>("#bhDetail")!;
    const e = app!.state.events.find((x) => x.id === "e1")!;
    const click = (sel: string) => panel.querySelector<HTMLElement>(sel)!.click();
    expect(panel.querySelector(".pnow b")!.textContent).toContain("13:20–14:05");
    click('[data-dday="2026-10-29"]');
    expect(e.date).toBe("2026-10-29");
    // A 교시 for an appointment is the whole lesson (this school: 3교시 10:40–11:25).
    click('[data-dtime="10:40-11:25"]');
    expect([e.start, e.end]).toEqual(["10:40", "11:25"]);
    click('[data-dlen="90"]');
    expect(e.end).toBe("12:10");
    // The next month, then a day in it.
    click('[data-dmon="1"]');
    expect(panel.querySelector(".pch b")!.textContent).toBe("2026년 11월");
    click('[data-dday="2026-11-05"]');
    expect(e.date).toBe("2026-11-05");
    const when = panel.querySelector<HTMLInputElement>('[data-df="when"]')!;
    when.value = "내일 4시";
    when.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect([e.date, e.start]).toEqual(["2026-10-29", "16:00"]);
    click("[data-dnotime]");
    expect(e.start).toBeNull();
  });

  it("할 일: 교시는 그 시작 시각, 「날짜 없음」은 마감·알림을 비움", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>('.dtg [data-ev="t1"]')!.click();
    const panel = root.querySelector<HTMLElement>("#bhDetail")!;
    const t = app!.state.tasks.find((x) => x.id === "t1")!;
    expect(panel.querySelector(".pnow b")!.textContent).toContain("16:00까지");
    panel.querySelector<HTMLElement>('[data-dtime="13:20-14:05"]')!.click();
    expect(t.dueTime).toBe("13:20");
    panel.querySelector<HTMLElement>("[data-dnodue]")!.click();
    expect([t.noDue, t.dueTime]).toEqual([true, null]);
    await tick();
    expect(root.querySelector("#bhDetail .pnow b")!.textContent).toBe("날짜 없음");
    root.querySelector<HTMLElement>('#bhDetail [data-dday="2026-10-30"]')!.click();
    expect([t.noDue, t.due]).toEqual([false, "2026-10-30"]);
  });
});
