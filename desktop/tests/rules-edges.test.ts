/**
 * 날짜 경계 (2026-10-28 밤샘): 자정 넘김 · 해 넘김 · 월말 · 윤년 · 일요일/토요일 기준 주.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/calendar/model";
import { parseDraft } from "../src/calendar/rules";

const at = (y: number, m: number, d: number, h = 10, min = 0) => new Date(y, m - 1, d, h, min);
const p = (v: string, now: Date) => parseDraft(v, now, DEFAULT_SETTINGS);

describe("date edges", () => {
  it.each([
    // [문장, 지금, 날짜, 시각]
    ["30분 뒤 전화", at(2026, 12, 31, 23, 50), "2027-01-01", "00:20"],
    ["2시간 후 약 먹기", at(2026, 10, 28, 23, 0), "2026-10-29", "01:00"],
    ["내일 회의", at(2026, 12, 31), "2027-01-01", null],
    ["모레 회의", at(2026, 12, 31), "2027-01-02", null],
    ["다음 달 3일 회의", at(2026, 12, 15), "2027-01-03", null],
    ["다음 달 말까지 보고서", at(2027, 1, 31), "2027-02-28", null],
    ["다음 달 말까지 보고서", at(2028, 1, 31), "2028-02-29", null],
    ["월말까지 성적 입력", at(2028, 2, 3), "2028-02-29", null],
    ["다음 달 31일 회의", at(2026, 10, 5), null, null], // 11월 31일은 없음: 이번 달 31일로 바꾸지 않고 날짜 없음(확인)
    ["오늘 밤 12시 제출", at(2026, 10, 5, 22), "2026-10-05", "23:59"], // 밤 12시 = 자정(낮 12시 아님)
    ["밤 12시까지 과제 제출", at(2026, 10, 5, 22), "2026-10-05", "23:59"],
    ["3일 회식", at(2026, 12, 20), "2027-01-03", null],
    ["일주일 뒤 상담", at(2026, 12, 28), "2027-01-04", null],
    ["다음 주 월요일 조회", at(2026, 11, 1), "2026-11-02", null], // 일요일에 「다음 주」
    ["이번 주말 대청소", at(2026, 10, 31), "2026-10-31", null], // 토요일이면 오늘
    ["어제 회의 정리", at(2027, 1, 1), "2026-12-31", null]
  ])("「%s」 @%s", (v, now, date, time) => {
    const r = p(v, now);
    expect(r.date ?? null).toBe(date);
    if (time) {
      expect(r.hasTime).toBe(true);
      expect(r.time).toBe(time);
    }
  });
});
