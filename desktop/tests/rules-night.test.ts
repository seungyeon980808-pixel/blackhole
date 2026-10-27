/**
 * 밤샘 안정화 (2026-10-27): 교사 일과 문장 — 규칙이 못 읽던 날짜·시간 말, 교시 범위, 제목 찌꺼기.
 * 공유 규칙(휴대폰 Java와 같은 정답표)은 그대로 두고, Mac·웹 쪽 앞처리(dateWords·timeWords)와 정리만 바꿨다.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/calendar/model";
import { memoDraft, parseDraft } from "../src/calendar/rules";

const NOW = new Date(2026, 9, 27, 10, 40); // 화요일 10:40
const d = (v: string) => parseDraft(v, NOW, DEFAULT_SETTINGS);
const row = (v: string) => {
  const r = d(v);
  return [r.kind, r.date, r.hasTime ? r.time : null, r.end ?? null, r.title];
};

describe("day words the shared parser did not know", () => {
  it.each([
    ["다음 달 3일 체육대회", "2026-11-03", "체육대회"],
    ["5일 회식", "2026-11-05", "회식"], // the 5th has passed this month → next month
    ["30일까지 생기부 마감", "2026-10-30", "생기부 마감"],
    ["월말까지 성적 입력", "2026-10-31", "성적 입력"],
    ["이번 주말 가족 여행", "2026-10-31", "가족 여행"],
    ["주말에 대청소", "2026-10-31", "대청소"],
    ["다다음 주 월요일 조회", "2026-11-09", "조회"],
    ["3일 뒤 마감", "2026-10-30", "마감"],
    ["일주일 뒤 상담", "2026-11-03", "상담"],
    ["이번 주 안에 회의록 작성", "2026-10-30", "회의록 작성"],
    ["다음 주 중에 학부모 면담", "2026-11-06", "학부모 면담"],
    ["이번 달 안에 연수 이수", "2026-10-31", "연수 이수"],
    ["어제 3시 회의 회의록 정리", "2026-10-26", "회의 회의록 정리"],
    ["지난 금요일 교육청 공문 회신", "2026-10-23", "교육청 공문 회신"],
    ["크리스마스에 가족 모임", "2026-12-25", "가족 모임"],
    ["내년 3월 2일 개학", "2027-03-02", "개학"],
    ["2026-11-05 연수", "2026-11-05", "연수"],
    ["11월 3일(화) 9시 교사개발자 모임", "2026-11-03", "교사개발자 모임"],
    // 2026-10-28: Nth weekday of a month and a month's last day (were this Friday / 11월 4일 / none).
    ["11월 셋째 주 수요일 연구수업", "2026-11-18", "연구수업"],
    ["12월 첫째 주 금요일 송년회", "2026-12-04", "송년회"],
    ["다음 달 첫 월요일 교직원 회의", "2026-11-02", "교직원 회의"],
    ["이번 달 마지막 금요일 회식", "2026-10-30", "회식"],
    ["1월 둘째 주 화요일 연수", "2027-01-12", "연수"],
    ["10월 마지막 날 할로윈 행사", "2026-10-31", "할로윈 행사"]
  ])("「%s」 → %s · %s", (v, date, title) => {
    const r = d(v);
    expect(r.date).toBe(date);
    expect(r.title).toBe(title);
  });

  it("relative clock times and the words for noon and midnight", () => {
    expect(row("2시간 후 회의")).toEqual(["SCHEDULE", "2026-10-27", "12:40", null, "회의"]);
    expect(row("30분 뒤 전화")).toEqual(["TODO", "2026-10-27", "11:10", null, "전화"]);
    expect(row("한 시간 뒤 회의")).toEqual(["SCHEDULE", "2026-10-27", "11:40", null, "회의"]);
    expect(row("정오에 점심 약속")).toEqual(["SCHEDULE", "2026-10-27", "12:00", null, "점심 약속"]);
    expect(row("자정까지 원서 접수")).toEqual(["TODO", "2026-10-27", "23:59", null, "원서 접수"]);
    expect(row("1530 회의")).toEqual(["SCHEDULE", "2026-10-27", "15:30", null, "회의"]);
  });
});

describe("periods and ranges", () => {
  it("a span of periods runs from the first start to the last end; a range is an appointment", () => {
    expect(row("3교시~5교시 수행평가")).toEqual(["SCHEDULE", "2026-10-27", "10:40", "14:05", "수행평가"]);
    expect(row("1~2교시 시험 감독")).toEqual(["SCHEDULE", "2026-10-27", "08:50", "10:30", "시험 감독"]);
    expect(row("4,5,6교시 수행평가")).toEqual(["SCHEDULE", "2026-10-27", "11:35", "15:00", "수행평가"]);
    expect(row("내일 3시~5시 연수")).toEqual(["SCHEDULE", "2026-10-28", "15:00", "17:00", "연수"]);
    expect(row("10월 30일 오후 2시부터 4시까지 교직원 연수")).toEqual(["SCHEDULE", "2026-10-30", "14:00", "16:00", "교직원 연수"]);
    expect(row("11월 16일 예향관에서 7교시 대의원회")[0]).toBe("SCHEDULE");
    expect(row("6교시 끝나고 학부모 상담")).toEqual(["SCHEDULE", "2026-10-27", "15:00", null, "학부모 상담"]);
  });
});

describe("기억 or not", () => {
  it("a day the rules could not read is never a sure 기억 (the AI decides)", () => {
    for (const v of ["방과후 보충수업", "모레 오전에 은행", "다음 주 중에 학부모 면담"]) expect(memoDraft(v, NOW, DEFAULT_SETTINGS)?.final ?? false).toBe(false);
    // Still sure 기억: no day at all, 「메모 …」, and hearsay.
    for (const v of ["차 번호 12가 3456", "메모 엄마 생신 선물 고민", "다음 주에 택배 온대", "아이디어: 학급 문고 정리법"]) expect(memoDraft(v, NOW, DEFAULT_SETTINGS)?.final).toBe(true);
    expect(memoDraft("다음 달 3일 체육대회", NOW, DEFAULT_SETTINGS)?.final ?? false).toBe(false);
    expect(memoDraft("1530 회의", NOW, DEFAULT_SETTINGS)).toBeNull();
  });
});

describe("spoken short forms, numbers in words, spans of days", () => {
  it("낼 · 담주 · 수욜 · 삼월 이일 · 십일월 오일 · 이십일", () => {
    expect(row("낼 3시 치과")).toEqual(["SCHEDULE", "2026-10-28", "15:00", null, "치과"]);
    expect(d("담주 화요일 회의").date).toBe("2026-11-03");
    expect(d("다음주 수욜 회의").date).toBe("2026-11-04");
    expect(d("목욜까지 제출").date).toBe("2026-10-29");
    expect(d("삼월 이일 개학").date).toBe("2027-03-02");
    expect(d("십일월 오일 연수").date).toBe("2026-11-05");
    expect(d("이십일 회식").date).toBe("2026-11-20");
    expect(d("엔진오일 교체").date).toBeNull(); // 「오일」 inside a word is oil
  });

  it("a span of days is a 기간 (until), never a 기억", () => {
    const span = (v: string) => { const r = d(v); return [r.date, r.until, r.title]; };
    expect(span("11월 2일부터 6일까지 체험학습")).toEqual(["2026-11-02", "2026-11-06", "체험학습"]);
    expect(span("10/28~10/30 출장")).toEqual(["2026-10-28", "2026-10-30", "출장"]);
    expect(span("다음 주 월요일부터 금요일까지 수행평가 기간")).toEqual(["2026-11-02", "2026-11-06", "수행평가 기간"]);
    expect(span("내일부터 사흘간 연수")).toEqual(["2026-10-28", "2026-10-30", "연수"]);
    expect(memoDraft("내일부터 사흘간 연수", NOW, DEFAULT_SETTINGS)).toBeNull();
    // A clock range on one day is not a span of days.
    expect(d("10/30 15:00~16:00 학부모 상담").until).toBeUndefined();
  });

  it("titles lose the asking and the leftovers", () => {
    expect(d("내일 3시에 알려줘").title).toBe("알림");
    expect(d("공문 회신(오늘 4시까지)").title).toBe("공문 회신");
    expect(d("2026.10.30 15시 상담").title).toBe("상담");
    expect(d("오늘 중으로 회신").title).toBe("회신");
    expect(d("내일 오전 중 제출").title).toBe("제출");
    expect(d("매달 1일 급식비 확인").title).toBe("급식비 확인");
    expect(d("평일마다 8시 교문지도 루틴").title).toBe("교문지도 루틴");
  });
});

describe("a span of days becomes a 기간 on the calendar", async () => {
  const { emptyState } = await import("../src/calendar/model");
  const { draftFromText } = await import("../src/calendar/store");
  it("draftFromText makes a period", () => {
    const s = emptyState();
    const x = draftFromText(s, "11월 2일부터 6일까지 체험학습", "데스크톱", NOW, "k1");
    expect(x.kind).toBe("period");
    expect(s.periods[0]).toMatchObject({ from: "2026-11-02", to: "2026-11-06", title: "체험학습", draft: true });
  });
});

describe("periods said by length or by week (2026-10-28)", () => {
  it.each([
    ["다음 주 내내 공개수업 주간", "2026-11-02", "2026-11-06", "공개수업 주간"],
    ["3일간 연수 11월 4일부터", "2026-11-04", "2026-11-06", "연수"],
    ["오늘부터 일주일 동안 독서 주간", "2026-10-27", "2026-11-02", "독서 주간"],
    ["17일 18일 이틀 출장", "2026-11-17", "2026-11-18", "출장"]
  ])("「%s」 → %s~%s", (v, from, to, title) => {
    const r = d(v);
    expect([r.date, r.until, r.title]).toEqual([from, to, title]);
  });
});

describe("everyday sentences (2026-10-28)", () => {
  it.each([
    ["병원 예약 11/12 오후 2:40 내과", "2026-11-12", "14:40"], // was 02:40
    ["저녁 7:30 동창회", "2026-10-27", "19:30"], // was 07:30
    ["금요일 퇴근하고 7시 영화", "2026-10-30", "19:00"], // was the 퇴근 time 16:20
    ["자동차 보험 갱신 11월 말까지", "2026-11-30", null],
    ["모레 오전 12:30 서버 점검", "2026-10-29", "00:30"]
  ])("「%s」 → %s %s", (v, date, time) => {
    const r = d(v);
    expect(r.date).toBe(date);
    if (time) expect(r.time).toBe(time);
  });
  it("「다음 주 토일 부산 여행」 is Saturday to Sunday", () => {
    const r = d("다음 주 토일 부산 여행");
    expect([r.date, r.until, r.title]).toEqual(["2026-11-07", "2026-11-08", "부산 여행"]);
  });
});
