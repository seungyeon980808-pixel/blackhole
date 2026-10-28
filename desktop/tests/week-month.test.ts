/**
 * 2026-10-28 사용자 지시: 주 보기 「업무 08–17」이 창을 채우고 그 밖은 위·아래 접은 줄로,
 * 기간·마감 줄은 끝낸 할 일 대신 「완료 n」, 상자는 제목 먼저 · 시각은 뒤에 짧게(「5교시」).
 * 월 보기: 제목 먼저 · 시작 시각 오른쪽, 끝낸 할 일은 「완료 n」만.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { fcEvents } from "../src/calendar/fc";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, type CalEvent, type Task } from "../src/calendar/model";
import { shortWhen } from "../src/calendar/views/common";

const NOW = new Date("2026-10-28T10:40:00");
const ev = (id: string, title: string, date: string, start: string | null, end: string | null): CalEvent => ({ id, kind: "event", title, area: "school", source: "t", createdAt: "x", date, start, end, provisional: false, reminders: [] });
const tk = (id: string, title: string, due: string, dueTime: string | null, done = false): Task => ({ id, kind: "task", title, area: "school", source: "t", createdAt: "x", due, dueTime, done, reminders: [], subs: [] });

function state() {
  const s = emptyState();
  s.events.push(
    ev("e1", "등교 지도", "2026-10-26", "07:00", "07:40"),
    ev("e2", "수행평가 점수 확인", "2026-10-26", "13:20", "14:05"),
    ev("e3", "맨드살롱", "2026-10-26", "17:00", "18:00"),
    ev("e4", "아침 회의", "2026-10-27", "07:40", "08:30")
  );
  s.tasks.push(tk("t1", "출장 신청", "2026-10-26", null, true), tk("t2", "결재 올리기", "2026-10-26", null, true), tk("t3", "수행평가 채점", "2026-10-26", null));
  return s;
}

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});

describe("week 「업무 08–17」", () => {
  it("folds things wholly outside 08–17 into 이전/이후 rows; one crossing 08:00 stays a box", () => {
    const evs = fcEvents(state(), true, new Date("2026-10-28T00:00"), true);
    const fold = evs.filter((e) => e.extendedProps?.kind === "fold");
    expect(fold.map((e) => e.id).sort()).toEqual(["fold-2026-10-26|bot", "fold-2026-10-26|top"]);
    expect(fold.find((e) => e.id === "fold-2026-10-26|top")!.start).toBe("2026-10-26T07:40");
    expect(fold.find((e) => e.id === "fold-2026-10-26|bot")!.title).toBe("17:00 맨드살롱");
    expect(evs.some((e) => e.id === "e1" || e.id === "e3")).toBe(false);
    expect(evs.some((e) => e.id === "e4")).toBe(true);
    // 하루 전체: nothing folded.
    expect(fcEvents(state(), true, new Date("2026-10-28T00:00"), false).some((e) => e.extendedProps?.kind === "fold")).toBe(false);
  });

  it("finished deadlines are not drawn (week or month)", () => {
    for (const week of [true, false]) {
      const ids = fcEvents(state(), week, new Date("2026-10-28T00:00")).map((e) => e.id);
      expect(ids).toContain("t3");
      expect(ids).not.toContain("t1");
      expect(ids).not.toContain("t2");
    }
  });

  it("says a period start as 「n교시」 on school days, the time otherwise", () => {
    const s = emptyState();
    expect(shortWhen(s, "2026-10-26", "13:20")).toBe("5교시");
    expect(shortWhen(s, "2026-10-26", "13:40")).toBe("13:40");
    expect(shortWhen(s, "2026-10-25", "13:20")).toBe("13:20");
  });

  it("draws the week: 08–17 fills, fold rows, 「완료 2」 in the header, title before the time", async () => {
    document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    const adapter = memoryAdapter();
    const s = state();
    s.settings.theme = "glass";
    await adapter.save(s);
    app = await mountBlackhole(root, adapter, { now: () => new Date(NOW) });
    app.setView("week", "2026-10-28");
    const w = root.querySelector(".fc-timeGridWeek-view")!;
    expect(root.querySelector(".fchost.wk-work")).not.toBeNull();
    expect(w.querySelector(".bh-fold.top")!.textContent).toContain("이전 07:00 등교 지도");
    expect(w.querySelector(".bh-fold.bot")!.textContent).toContain("이후 17:00 맨드살롱");
    expect(w.querySelector(".fc-col-header-cell.fc-day-mon")!.textContent).toContain("완료 2");
    expect(w.textContent).not.toContain("출장 신청");
    expect(w.querySelector('[data-ev="e2"] .wbt')!.textContent).toBe("수행평가 점수 확인5교시");

    app.setView("month", "2026-10-28");
    const m = root.querySelector(".fc-rolling-view")!;
    expect(m.querySelector(".fc-day[data-date='2026-10-26']")!.textContent).toContain("완료 2");
    expect(m.textContent).not.toContain("결재 올리기");
    const chip = m.querySelector<HTMLElement>('[data-ev="e2"] .c')!;
    expect(chip.querySelector(".w1")!.textContent).toBe("수행평가 점수 확인");
    expect(chip.querySelector(".ct")!.textContent).toBe("5교시");
    expect(chip.title).toBe("13:20–14:05 수행평가 점수 확인");
  });
});
