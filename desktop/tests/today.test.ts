/** 오늘(일) 화면 (2026-10-27): shared numbers, 6-hour urgency, stars, 루틴, moving days, work blocks, work/all range. */
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, sharedFrom, type CalendarState, type Routine } from "../src/calendar/model";
import { isUrgent, orderedTasks, routineOn, streak, urgency } from "../src/calendar/views/today";

const NOW = new Date(2026, 9, 27, 10, 40); // 화요일
let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const b = { area: "school" as const, source: "데스크톱", createdAt: "2026-10-01T08:00" };
function base(): CalendarState {
  const s = emptyState();
  s.events.push({ ...b, id: "e1", kind: "event", title: "대의원회", date: "2026-10-27", start: "13:40", end: "14:30", provisional: false, reminders: ["2026-10-27T13:30"] });
  s.tasks.push({ ...b, id: "t1", kind: "task", title: "출석부 정리", due: "2026-10-27", dueTime: "10:30", done: false, reminders: [], subs: [] });
  s.tasks.push({ ...b, id: "t2", kind: "task", title: "출제 원안 제출", due: "2026-10-27", dueTime: "15:00", done: false, reminders: [], subs: [], star: 2 });
  s.tasks.push({ ...b, id: "t3", kind: "task", title: "가정통신문", due: "2026-10-27", dueTime: "18:00", done: false, reminders: [], subs: [], star: 1 });
  s.tasks.push({ ...b, id: "t4", kind: "task", title: "도서 반납", due: "2026-11-01", dueTime: null, done: false, reminders: [], subs: [] });
  return s;
}

async function mount(st: CalendarState, extra: Partial<BlackholeAdapter> = {}): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, { ...memoryAdapter(), origin: "데스크톱", load: async () => st, aiSkipped: () => undefined, ...extra }, { now: () => new Date(NOW), seed: false });
  app.setView("day", "2026-10-27");
  return root;
}

describe("order and numbers", () => {
  it("급함 = 걸리는 시간 대비 남은 근무 시간 (11-02) → star → earliest; 「나중」 after; deadlines are the 「남은 시간」 word, not marks on the table", async () => {
    const s = base();
    expect(urgency(s.tasks[0], NOW, s)).toBe(3); // 10분 지남
    expect(isUrgent(s.tasks[1], NOW, s)).toBe(false); // 제출 = 10분, 4시간 20분 남음
    expect(urgency(s.tasks[2], NOW, s)).toBe(0);
    // 하루 걸리는 출제, 내일 퇴근 때까지 (근무 시간 약 13시간 40분 < 하루 × 2): 급함.
    expect(urgency({ ...s.tasks[1], title: "기말 문제 출제", due: "2026-10-28", dueTime: null }, NOW, s)).toBe(2);
    const o = orderedTasks(s, "2026-10-27", NOW);
    expect(o.today.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(o.later.map((t) => t.id)).toEqual(["t4"]);
    const root = await mount(s);
    const list = [...root.querySelectorAll<HTMLElement>(".tl .task")].map((x) => `${x.dataset.num}:${x.dataset.task}`);
    expect(list).toEqual(["1:t1", "2:t2", "3:t3", "4:t4"]);
    const rem = (id: string) => root.querySelector<HTMLElement>(`.tl .task[data-ev="${id}"] .rem`)!;
    expect([rem("t1").textContent, rem("t1").classList.contains("R3")]).toEqual(["10분 지남", true]);
    expect(rem("t2").textContent).toBe("4시간 남음");
    expect(rem("t4").textContent).toBe("D-5");
    expect(root.querySelector('.dtg [data-ev="t2"]')).toBeNull();
  });

  it("filter chips: 급함 shows only the urgent ones", async () => {
    const s = base();
    s.tasks[1].effort = 180; // 3시간 걸리는데 4시간 20분 남음: 급함
    const root = await mount(s);
    root.querySelector<HTMLButtonElement>('[data-tf="urgent"]')!.click();
    expect([...root.querySelectorAll<HTMLElement>(".tl .task")].map((x) => x.dataset.task)).toEqual(["t1"]); // t2 is starred → 지금 할 것
    root.querySelector<HTMLButtonElement>('[data-tf="now"]')!.click();
    expect([...root.querySelectorAll<HTMLElement>(".tl .task")].map((x) => x.dataset.task)).toEqual(["t2"]);
  });
});

describe("stars", () => {
  it("☆ → yellow ★ → red ★ → ☆; the AI only suggests (starHint), never sets", async () => {
    const s = base();
    s.tasks[3].starHint = 1;
    const root = await mount(s);
    const click = () => root.querySelector<HTMLButtonElement>('[data-star="t4"]')!.click();
    expect(root.querySelector('[data-star="t4"]')!.classList.contains("hint")).toBe(true);
    expect(app!.state.tasks[3].star ?? 0).toBe(0);
    click();
    await Promise.resolve();
    expect(app!.state.tasks[3].star).toBe(1);
    click();
    await Promise.resolve();
    expect(app!.state.tasks[3].star).toBe(2);
    click();
    await Promise.resolve();
    expect(app!.state.tasks[3].star ?? 0).toBe(0);
  });

  it("stars and hints stay off the phone copy (달력.json unchanged)", () => {
    const s = base();
    s.tasks[3].starHint = 1;
    const out = JSON.stringify(sharedFrom(s, "2026-10-27T10:40"));
    expect(out).not.toContain('"star"');
    expect(out).not.toContain("starHint");
  });
});

describe("루틴", () => {
  const r = (repeat: Routine["repeat"], done: string[]): Routine => ({ id: "r1", title: "메일 확인", at: "08:20", repeat, done, createdAt: "2026-10-01T08:00" });

  it("repeats daily / weekdays / chosen days; the streak skips days it does not repeat on", () => {
    expect(routineOn(r("weekdays", []), "2026-10-25")).toBe(false); // 일
    expect(routineOn(r("weekdays", []), "2026-10-26")).toBe(true);
    expect(routineOn(r([1, 3, 5], []), "2026-10-27")).toBe(false); // 화
    // 평일: 금(23) 월(26) 화(27) done → 3, the weekend in between does not break it.
    expect(streak(r("weekdays", ["2026-10-23", "2026-10-26", "2026-10-27"]), "2026-10-27")).toBe(3);
    // Not checked yet today: counts up to yesterday.
    expect(streak(r("daily", ["2026-10-25", "2026-10-26"]), "2026-10-27")).toBe(2);
    expect(streak(r("daily", ["2026-10-25"]), "2026-10-27")).toBe(0);
  });

  it("a sentence makes one; today's check is a tap; it never goes to the phone copy", async () => {
    const root = await mount(base());
    await app!.submitText("평일 8시 20분 메일 확인 루틴");
    await tick();
    const made = app!.state.routines[0];
    expect([made.title, made.at, made.repeat]).toEqual(["메일 확인", "08:20", "weekdays"]);
    expect(app!.state.events).toHaveLength(1); // not an appointment
    root.querySelector<HTMLElement>(`[data-rt="${made.id}"]`)!.click();
    await tick();
    expect(made.done).toEqual(["2026-10-27"]);
    // On the day table: a small box in its 10-minute cell, checked.
    const rt = root.querySelector<HTMLElement>(`.dtg .sg.rt.dn[data-rt="${made.id}"]`)!;
    expect(rt.textContent).toBe("메일 확인 ✓"); // the cell's place says the time
    expect(rt.title).toContain("루틴 08:20");
    expect(JSON.stringify(sharedFrom(app!.state, "2026-10-27T10:40"))).not.toContain("메일 확인");
  });
});

describe("moving to another day", () => {
  it("「대의원회 18일로 옮겨」 moves it with its reminder; 되돌리기 puts it back", async () => {
    const root = await mount(base());
    await app!.submitText("대의원회 18일로 옮겨");
    const e = app!.state.events.find((x) => x.id === "e1")!;
    expect(e.date).toBe("2026-11-18"); // the 18th already passed this month → next month
    expect(e.reminders).toEqual(["2026-11-18T13:30"]);
    expect(root.textContent).toContain("대의원회 →");
    root.querySelector<HTMLElement>("[data-undo]")!.click();
    await Promise.resolve();
    expect(app!.state.events.find((x) => x.id === "e1")!.date).toBe("2026-10-27");
    expect(app!.state.events.find((x) => x.id === "e1")!.reminders).toEqual(["2026-10-27T13:30"]);
  });

  it("「대의원회 4시로 변경」 · 「대의원회 내일 3시 반으로 옮겨」 change the time (no second event); 되돌리기 puts it back", async () => {
    const root = await mount(base());
    const n = app!.state.events.length;
    await app!.submitText("대의원회 4시로 변경");
    const e = () => app!.state.events.find((x) => x.id === "e1")!;
    expect([e().date, e().start, e().end]).toEqual(["2026-10-27", "16:00", "16:50"]); // the same 50 minutes
    expect(e().reminders).toEqual(["2026-10-27T15:50"]);
    expect(app!.state.events).toHaveLength(n);
    await app!.submitText("대의원회 내일 3시 반으로 옮겨");
    expect([e().date, e().start]).toEqual(["2026-10-28", "15:30"]);
    root.querySelector<HTMLElement>("[data-undo]")!.click();
    await Promise.resolve();
    expect([e().date, e().start]).toEqual(["2026-10-27", "16:00"]);
  });

  it("⌥→ moves the picked entry one day; dropping on the header's › moves it to the next day", async () => {
    const root = await mount(base());
    root.querySelector<HTMLElement>('.tl .task[data-ev="t3"] .no')!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", key: "ArrowRight", altKey: true, bubbles: true }));
    await Promise.resolve();
    expect(app!.state.tasks.find((t) => t.id === "t3")!.due).toBe("2026-10-28");
    app!.setView("day", "2026-10-27");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { getData: () => "t1", types: ["text/bh-task"] } });
    root.querySelector('.dctl [data-nav="1"]')!.dispatchEvent(drop);
    await Promise.resolve();
    expect(app!.state.tasks.find((t) => t.id === "t1")!.due).toBe("2026-10-28");
  });
});

describe("work blocks and the range", () => {
  it("a to-do dragged onto the table becomes a linked 30-minute 「작업 시간」 box (5-minute steps) with the same number", async () => {
    const root = await mount(base());
    const ly = root.querySelector<HTMLElement>(".dtg .dly")!;
    ly.getBoundingClientRect = () => ({ top: 0, height: 540, left: 0, width: 360, right: 360, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
    document.elementFromPoint = () => null;
    const pe = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    root.querySelector<HTMLElement>('.tl .task[data-ev="t3"] .tn')!.dispatchEvent(pe("pointerdown", 600, 300));
    window.dispatchEvent(pe("pointermove", 200, 206)); // 07–18: 11 rows of 49px, row 4 (11시), 200/360 of the hour = 33분 → 35분
    window.dispatchEvent(pe("pointerup", 200, 206));
    await tick();
    const w = app!.state.events.find((e) => e.workFor === "t3")!;
    expect([w.title, w.start, w.end, w.date]).toEqual(["가정통신문", "11:35", "12:05", "2026-10-27"]);
    expect(w.reminders).toEqual(["2026-10-27T11:35"]); // rings when it starts
    expect(root.querySelector(`.dtg .sg.work[data-ev="${w.id}"] .no`)!.textContent).toBe("3");
    expect(JSON.stringify(sharedFrom(app!.state, "2026-10-27T10:40"))).not.toContain(w.id); // the phone does not get it
  });

  it("업무 08–17 / 하루 전체: remembered", async () => {
    let root = await mount(base());
    expect(root.querySelector<HTMLElement>(".dtg")!.dataset.e).toBe(String(18 * 60));
    root.querySelector<HTMLButtonElement>('[data-dr="all"]')!.click();
    expect(root.querySelector<HTMLElement>(".dtg")!.dataset.e).toBe(String(21 * 60));
    app!.destroy();
    root = await mount(base());
    expect(root.querySelector<HTMLElement>(".dtg")!.dataset.e).toBe(String(21 * 60)); // remembered
  });
});

describe("month: this week always the second row", () => {
  it("six weeks from the week before; navigating keeps the shown day's week second", async () => {
    const root = await mount(base());
    app!.setView("month", "2026-10-27");
    const days = () => [...root.querySelectorAll<HTMLElement>(".fc-rolling-view .fc-daygrid-day[data-date]")].map((x) => x.dataset.date);
    expect(days()).toHaveLength(42);
    expect(days()[0]).toBe("2026-10-19"); // the week before (월요일 시작, 11-02)
    expect(days()[7]).toBe("2026-10-26"); // this week = second row
    // Six week rows (a days-long duration drew all 42 days on one line).
    expect(root.querySelectorAll(".fc-rolling-view .fc-daygrid-body tr[role=row]")).toHaveLength(6);
    // No school-period bands on the week grid any more.
    app!.setView("week", "2026-10-27");
    expect(root.querySelector(".fc .bh-pd")).toBeNull();
  });
});
