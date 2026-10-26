import { describe, expect, it } from "vitest";
import golden from "./fixtures/rule-cases.json";
import { isSimpleCertain, parseRule } from "../src/calendar/rules";

describe("rule parser (same rules as the phone's KoreanCommandParser)", () => {
  const [d, t] = golden.referenceLocal.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const now = new Date(y, m - 1, day, hh, mm);

  it.each(golden.cases)("$text", (c) => {
    const r = parseRule(c.text, now);
    expect(r.kind).toBe(c.kind);
    expect(r.title).toBe(c.title);
    expect(r.date && r.time ? `${r.date}T${r.time}` : "").toBe(c.start);
    expect(r.needsReview).toBe(c.needsReview);
    expect(r.explanation).toBe(c.explanation);
  });

  it("answers well under a millisecond per sentence", () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) for (const c of golden.cases) parseRule(c.text, now);
    const per = (performance.now() - t0) / (200 * golden.cases.length);
    expect(per).toBeLessThan(1);
  });
});

describe("simple sentences skip the AI (「간단한 문장은 AI 생략」)", () => {
  const now = new Date(2026, 9, 21, 9, 0);
  const simple = (t: string) => isSimpleCertain(t, parseRule(t, now));
  it.each(["글피 오후 1시에 미용실 예약", "토요일 오후 6시 친구 결혼식", "모레 오후 3시 반에 안과 진료", "10.30 오후 4시 치과"])("%s → rule draft only", (t) => {
    expect(simple(t)).toBe(true);
  });
  it.each([
    "내일 오후 3시 치과 예약 있어", // conversational title: the AI cleans it
    "내일 3시 회의 있고 그 전에 자료 인쇄", // two things
    "금요일까지 보고서 제출", // a deadline, not an appointment
    "내일 오후 2시 학부모 상담", // school
    "내일 저녁에 친구 만나기", // no clock time
    "다음 주 월요일 오전 10시", // no title
    "내일 오후 3시 치과, 6시에 알려줘", // reminder + list
    "매주 화요일 오후 4시 피아노" // repeat
  ])("%s → AI", (t) => {
    expect(simple(t)).toBe(false);
  });
  it("is a minority of the shared sentences (most still go to the AI)", () => {
    const n = golden.cases.filter((c) => simple(c.text)).length;
    expect(n).toBeGreaterThan(3);
    expect(n).toBeLessThan(golden.cases.length / 4);
  });
});
