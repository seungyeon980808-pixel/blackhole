/**
 * 깨진 기록 (2026-10-28 밤샘): 알림 목록이 없는 일정 하나 때문에 앱 전체가 「시작 실패」로 멈췄다.
 * 저장된 자료·휴대폰이 받는 달력.json에서 채울 수 있는 칸은 채우고, 날짜 없는 기록만 뺀다.
 */
import { describe, expect, it } from "vitest";
import { normalizeState } from "../src/calendar/model";

describe("broken records", () => {
  const s = normalizeState({
    schemaVersion: 1,
    events: [
      { id: "e1", kind: "event", title: "치과", date: "2026-10-28", start: "15:00", end: null, area: "personal", source: "데스크톱", createdAt: "2026-10-27T10:00" }, // reminders 없음
      { id: "e2", title: "날짜 없음", date: "언젠가" },
      { title: "아이디 없음", date: "2026-10-28" },
      null,
      "글자",
      { id: "e3", title: 42, date: "2026-10-29", start: "3시", reminders: "x", provisional: "yes" }
    ],
    tasks: [{ id: "t1", title: "보고서", due: "2026-10-30" }, { id: "t2", title: "마감 없음" }],
    periods: [{ id: "p1", title: "수학여행", from: "2026-11-15", to: "2026-11-14" }, { id: "p2", title: "끝 없음", from: "2026-11-01" }],
    notes: [{ id: "n1" }, { id: 5, title: "숫자 아이디" }]
  })!;

  it("fills what can be filled and drops records with no day", () => {
    expect(s.events.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(s.events[0].reminders).toEqual([]);
    expect(s.events[1]).toMatchObject({ title: "42", start: null, reminders: [], provisional: false, area: "school" });
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({ dueTime: null, done: false, reminders: [], subs: [] });
    expect(s.periods).toEqual([expect.objectContaining({ id: "p1", from: "2026-11-14", to: "2026-11-15" })]);
    expect(s.notes.map((n) => n.id)).toEqual(["n1"]);
  });
});
