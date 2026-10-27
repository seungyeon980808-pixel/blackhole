/** 문서·사진에서 온 「3교시」 「6교시 전」 「점심시간」: 이 학교의 교시 시각으로 채운다(2026-10-27 밤 안정화). */
import { expect, it } from "vitest";
import { emptyState } from "../src/calendar/model";
import { applyProposal } from "../src/calendar/store";
import type { Proposal, ProposalItem } from "../src/worker/proposal";

const item = (kind: string, title: string, startAt: string, timeText: string): ProposalItem => ({
  area: "SCHOOL", confidence: 0.9, details: "", endAt: "", evidence: { dateText: "", endDateText: "", reminderText: "", sentence: title, timeText }, kind, needsReview: false,
  reminderAt: "", reminders: [], reviewReasons: [], startAt, subtasks: [], title
} as unknown as ProposalItem);

it("periods, lunch and 퇴근 from a document get this school's times", () => {
  const s = emptyState();
  const p = { items: [
    item("SCHEDULE", "공개수업", "2026-11-11T09:00:00+09:00", "3교시"),
    item("SCHEDULE", "사전 안전교육", "2026-11-16T09:00:00+09:00", "6교시"),
    item("TODO", "학습지 인쇄", "2026-11-16T09:00:00+09:00", "6교시 전"),
    item("SCHEDULE", "수행평가", "2026-11-12T09:00:00+09:00", "3~5교시"),
    item("SCHEDULE", "학부모 상담", "2026-11-12T15:00:00+09:00", "오후 3시")
  ] } as unknown as Proposal;
  applyProposal(s, p, "인박스", new Date(2026, 9, 27, 10, 40));
  const ev = (t: string) => s.events.find((e) => e.title === t)!;
  expect([ev("공개수업").start, ev("공개수업").end]).toEqual(["10:40", "11:25"]);
  expect([ev("사전 안전교육").date, ev("사전 안전교육").start, ev("사전 안전교육").end]).toEqual(["2026-11-16", "14:15", "15:00"]);
  expect(s.tasks[0].dueTime).toBe("14:15");
  expect([ev("수행평가").start, ev("수행평가").end]).toEqual(["10:40", "14:05"]);
  expect(ev("학부모 상담").start).toBe("15:00"); // a clock time is left as it is
  expect(ev("공개수업").review).toBeUndefined();
});

it("the worker's 「9시로 임시」 note goes when the period's time is set", () => {
  const s = emptyState();
  const it0 = { ...item("SCHEDULE", "공개수업", "2026-11-11T09:00:00+09:00", "3교시"), needsReview: true, reviewReasons: ["날짜만 있어 오전 9시로 임시 지정"] } as ProposalItem;
  applyProposal(s, { items: [it0] } as unknown as Proposal, "인박스", new Date(2026, 9, 27, 10, 40));
  expect([s.events[0].start, s.events[0].review]).toEqual(["10:40", undefined]);
});

it("a to-do the worker set due before an appointment keeps that time", () => {
  const s = emptyState();
  const it0 = { ...item("TODO", "성적표 출력", "2026-10-28T16:00:00+09:00", ""), needsReview: true, reviewReasons: ["「학부모 상담」 전까지로 둠"] } as ProposalItem;
  applyProposal(s, { items: [it0] } as unknown as Proposal, "인박스", new Date(2026, 9, 27, 10, 40));
  expect([s.tasks[0].due, s.tasks[0].dueTime]).toEqual(["2026-10-28", "16:00"]);
});

it("「내일 하루 종일 출장」 from the worker is an all-day entry, not 09:00 (2026-10-28)", () => {
  const s = emptyState();
  applyProposal(s, { items: [item("SCHEDULE", "출장", "2026-10-28T09:00:00+09:00", "하루 종일")] } as unknown as Proposal, "문장", new Date(2026, 9, 27, 10, 40));
  expect([s.events[0].date, s.events[0].start]).toEqual(["2026-10-28", null]);
});
