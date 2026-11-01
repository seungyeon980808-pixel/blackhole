// 밤샘 대량 시험(2026-11-01, 실제 하이쿠 210문장)에서 규칙만으로 틀리게 끝난 말들.
import { describe, expect, it } from "vitest";
import { memoDraft, parseDraft } from "../src/calendar/rules";

const NOW = new Date("2026-11-02T08:30:00");

describe("규칙이 끝내지 않고 AI에 넘기는 말", () => {
  it("「목 점심에」 「지금 바로」: 날·때를 말했으니 확실한 기억이 아님", () => {
    expect(memoDraft("목 점심에 부장 회의", NOW)?.final ?? false).toBe(false);
    expect(memoDraft("지금 바로 체험학습 결과보고서 결재", NOW)?.final).toBe(false);
    expect(memoDraft("퇴근 전에 교무실 프린터 끄기", NOW)?.final ?? false).toBe(false);
    expect(memoDraft("3반 민수 땅콩 알레르기 있음", NOW)?.final).toBe(true);
  });

  it("「오늘 6교시 보강 2-3」: 날 말이 있으면 「2-3」은 2학년 3반", () => {
    expect(parseDraft("오늘 6교시 보강 들어감 2-3", NOW).date).toBe("2026-11-02");
    expect(parseDraft("11-20 체육대회", NOW).date).toBe("2026-11-20");
  });
});

describe("학교 점심 (밤샘)", () => {
  it("「목 점심에 부장 회의」의 점심은 학교 점심시간", async () => {
    const { timeWords } = await import("../src/calendar/rules");
    expect(timeWords("목 점심에 부장 회의", {})).toContain("12:20~13:20");
    expect(timeWords("점심 약속", {})).toBe("점심 약속");
  });
});
