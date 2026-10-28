// 10-28 fixes the owner approved one by one: AI steps kept, 날짜 없음, dates counted from
// another appointment, past provisional ones asked, fake data gone.
import { describe, expect, it } from "vitest";
import { emptyState, normalizeState, type CalEvent, type Task } from "../src/calendar/model";
import { anchorRelativeDates, applyProposal, relativeOffset } from "../src/calendar/store";
import { orderedTasks } from "../src/calendar/views/today";
import { checksOf, PAST_PROVISIONAL, type Ctx } from "../src/calendar/views/common";
import type { Proposal } from "../src/worker/proposal";

const NOW = new Date(2026, 9, 28, 9, 0);
const TODAY = "2026-10-28";

const task = (id: string, title: string, x: Partial<Task> = {}): Task => ({
  id, kind: "task", title, area: "school", source: "데스크톱", createdAt: "2026-10-28T09:00", due: TODAY, dueTime: null, done: false, reminders: [], subs: [], ...x
});
const event = (id: string, title: string, date: string, x: Partial<CalEvent> = {}): CalEvent => ({
  id, kind: "event", title, area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", date, start: "15:10", end: "15:55", provisional: true, reminders: [], ...x
});
const ctx = (s = emptyState()): Ctx => ({ s, today: TODAY, now: NOW } as unknown as Ctx);

describe("1. AI 제안 steps are kept, not dropped", () => {
  it("a worker item's suggested steps come in marked ai, after the source's own", () => {
    const s = emptyState();
    const p = {
      items: [{ kind: "TODO", area: "SCHOOL", title: "시행 기안 올리기", details: "", startAt: "", endAt: "", reminderAt: "", reminders: [], subtasks: ["결재 요청"], suggestedSubtasks: ["신구대조표 작성", "시행 기안 작성"],
        evidence: { sentence: "", dateText: "", timeText: "", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: [] }]
    } as unknown as Proposal;
    applyProposal(s, p, "데스크톱", NOW);
    expect(s.tasks[0].subs).toEqual([{ title: "결재 요청", done: false }, { title: "신구대조표 작성", done: false, ai: true }, { title: "시행 기안 작성", done: false, ai: true }]);
    expect(s.tasks[0].review).toBeUndefined();
  });

  it("steps the old worker threw away come back as 「AI 제안」 steps, the note goes", () => {
    const s = normalizeState({ schemaVersion: 1, tasks: [task("t1", "대의원회 준비", { review: ["원문에 없는 하위 할 일을 버림: 「진행 방식 정하기」", "원문에 없는 하위 할 일을 버림: 「기안 올리기」", "날짜 표현을 해석하지 못함: 「일주일 전」"] })] })!;
    expect(s.tasks[0].subs.map((x) => [x.title, x.ai])).toEqual([["진행 방식 정하기", true], ["기안 올리기", true]]);
    expect(s.tasks[0].review).toEqual(["날짜 표현을 해석하지 못함: 「일주일 전」"]);
  });
});

describe("2. 날짜 없음", () => {
  it("a to-do without a deadline is its own group, not today, and asks nothing", () => {
    const s = normalizeState({ schemaVersion: 1, tasks: [task("t1", "학급 참석 대상 논의", { review: ["마감 날짜가 없어 오늘로 둠"] }), task("t2", "오늘 할 일")] })!;
    expect(s.tasks[0].noDue).toBe(true);
    expect(s.tasks[0].review).toBeUndefined();
    const o = orderedTasks(s, TODAY, NOW);
    expect(o.today.map((t) => t.id)).toEqual(["t2"]);
    expect(o.undated.map((t) => t.id)).toEqual(["t1"]);
    expect(o.num.get("t1")).toBe(2);
  });
});

describe("3. 「대의원회 일주일 전」", () => {
  it("reads relative phrases", () => {
    expect(relativeOffset("일주일 전")).toBe(-7);
    expect(relativeOffset("2주 전")).toBe(-14);
    expect(relativeOffset("3일 전")).toBe(-3);
    expect(relativeOffset("이틀 전")).toBe(-2);
    expect(relativeOffset("전날")).toBe(-1);
    expect(relativeOffset("당일")).toBe(0);
    expect(relativeOffset("다음 날")).toBe(1);
    expect(relativeOffset("내일")).toBeNull();
  });

  const pending = () => task("t1", "대의원회 준비", { noDue: true, review: ["날짜 표현을 해석하지 못함: 「일주일 전」"] });

  it("counts from the one appointment the to-do names", () => {
    const s = emptyState();
    s.events.push(event("e1", "대의원회", "2026-11-16"));
    s.tasks.push(pending());
    expect(anchorRelativeDates(s, NOW)).toEqual(["t1"]);
    expect(s.tasks[0].due).toBe("2026-11-09");
    expect(s.tasks[0].noDue).toBeUndefined();
    expect(s.tasks[0].review).toBeUndefined();
  });

  it("two appointments of that name: no date, 확인할 것 asks", () => {
    const s = emptyState();
    s.events.push(event("e1", "대의원회", "2026-11-16"), event("e2", "대의원회", "2026-11-06"));
    s.tasks.push(pending());
    expect(anchorRelativeDates(s, NOW)).toEqual([]);
    expect(s.tasks[0].noDue).toBe(true);
    expect(checksOf(ctx(s)).map((c) => c.why)).toContain("기준 일정이 여럿 · 날짜를 정해 주세요");
    // Once one of them goes, the next pass dates it.
    s.events[1].gone = true;
    expect(anchorRelativeDates(s, NOW)).toEqual(["t1"]);
    expect(s.tasks[0].due).toBe("2026-11-09");
  });

  it("no such appointment: stays 날짜 없음 and is asked", () => {
    const s = emptyState();
    s.tasks.push(pending());
    anchorRelativeDates(s, NOW);
    expect(s.tasks[0].noDue).toBe(true);
    expect(checksOf(ctx(s)).map((c) => c.why)).toContain("기준 일정을 못 찾음 · 날짜를 정해 주세요");
  });
});

describe("4. 날짜가 지난 가승인", () => {
  it("comes first in 확인할 것 and is never changed by itself", () => {
    const s = emptyState();
    s.events.push(event("e1", "학년 협의회", "2026-10-27"), event("e2", "안과 진료", "2026-10-25", { area: "personal" }));
    const list = checksOf(ctx(s));
    expect(list.map((c) => [c.x.id, c.why])).toEqual([["e2", PAST_PROVISIONAL], ["e1", PAST_PROVISIONAL]]);
    expect(s.events.every((e) => e.provisional && !e.gone)).toBe(true);
  });
});

describe("6. fake data is gone", () => {
  it("real data drops sample entries on load; a seeded preview keeps them", () => {
    const real = normalizeState({ schemaVersion: 1, tasks: [task("s-1", "관리비 납부", { sample: true }), task("t1", "진짜")], settings: { showSamples: false } })!;
    expect(real.tasks.map((t) => t.id)).toEqual(["t1"]);
    const preview = normalizeState({ schemaVersion: 1, tasks: [task("s-1", "관리비 납부", { sample: true })], settings: { showSamples: true } })!;
    expect(preview.tasks).toHaveLength(1);
  });
});

describe("오래 써도 가벼움", () => {
  it("old chat and inbox lines are dropped on load, the rest is kept", async () => {
    const { KEEP_CHAT, KEEP_INBOX } = await import("../src/calendar/model");
    const chat = Array.from({ length: KEEP_CHAT + 50 }, (_, i) => ({ id: `c${i}`, at: "2026-10-28T09:00", who: "me", text: `${i}` }));
    const inbox = Array.from({ length: KEEP_INBOX + 5 }, (_, i) => ({ at: "2026-10-28T09:00", title: `${i}`, src: "인박스", state: "완료", out: "" }));
    const s = normalizeState({ schemaVersion: 1, chat, inbox, ingestedJobs: Array.from({ length: 5000 }, (_, i) => `job-${i}`) })!;
    expect(s.chat).toHaveLength(KEEP_CHAT);
    expect(s.chat[0].id).toBe("c50");
    expect(s.inbox).toHaveLength(KEEP_INBOX);
    // Job ids are what stop a file from being taken twice: never trimmed.
    expect(s.ingestedJobs).toHaveLength(5000);
  });
});

describe("취소·변경", () => {
  const item = (x: Record<string, unknown>) => ({ kind: "SCHEDULE", area: "PERSONAL", title: "치과", details: "", startAt: "", endAt: "", reminderAt: "", reminders: [], subtasks: [], suggestedSubtasks: [],
    evidence: { sentence: "", dateText: "", timeText: "", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: [], ...x });
  const withDentist = () => {
    const s = emptyState();
    s.events.push(event("e1", "치과", "2026-10-30", { start: "15:00", end: "16:00", area: "personal", reminders: ["2026-10-30T14:30"] }));
    return s;
  };

  it("「치과 4시로 바뀜」 moves the one 치과, its reminder along", () => {
    const s = withDentist();
    const p = { items: [item({ change: "MOVE", startAt: "2026-10-30T16:00:00+09:00", evidence: { sentence: "치과 4시로 바뀜", dateText: "", timeText: "4시", endDateText: "", reminderText: "" } })] } as unknown as Proposal;
    const a = applyProposal(s, p, "데스크톱", NOW);
    expect(a.changed!.map((c) => c.id)).toEqual(["e1"]);
    expect([s.events[0].start, s.events[0].end, s.events[0].reminders[0]]).toEqual(["16:00", "17:00", "2026-10-30T15:30"]);
  });

  it("「치과 시간 바뀜」 without the new time leaves 치과 alone and asks", () => {
    const s = withDentist();
    const p = { items: [item({ change: "MOVE", evidence: { sentence: "치과 시간 바뀜", dateText: "", timeText: "", endDateText: "", reminderText: "" } })] } as unknown as Proposal;
    const a = applyProposal(s, p, "데스크톱", NOW);
    expect(a.changed).toEqual([]);
    expect(s.events[0].start).toBe("15:00");
    expect(checksOf(ctx(s)).map((c) => c.why)).toContain("바뀐 날짜·시각을 못 들음 · 일정에서 고쳐 주세요");
  });

  it("a late appointment moved later never ends past midnight", () => {
    const s = withDentist();
    s.events[0].start = "22:00";
    s.events[0].end = "23:30";
    const p = { items: [item({ change: "MOVE", startAt: "2026-10-30T23:00:00+09:00", evidence: { sentence: "치과 11시로 바뀜", dateText: "", timeText: "11시", endDateText: "", reminderText: "" } })] } as unknown as Proposal;
    applyProposal(s, p, "데스크톱", NOW);
    expect([s.events[0].start, s.events[0].end]).toEqual(["23:00", "23:59"]);
  });
});

describe("새 문장 54개에서 나온 고침", () => {
  const ev = (x: Partial<Record<string, string>>) => ({ sentence: "", dateText: "", timeText: "", endDateText: "", reminderText: "", ...x });
  const it_ = (x: Record<string, unknown>) => ({ kind: "TODO", area: "SCHOOL", title: "", details: "", startAt: "", endAt: "", reminderAt: "", reminders: [], subtasks: [], suggestedSubtasks: [], evidence: ev({}), confidence: 0.9, needsReview: false, reviewReasons: [], ...x });
  const run = (s: ReturnType<typeof emptyState>, items: unknown[], sourceText = "") => applyProposal(s, { items, sourceText } as unknown as Proposal, "데스크톱", NOW);

  it("「다음주 교과협의회 취소」 picks next week's of two", () => {
    const s = emptyState();
    s.events.push(event("a", "교과협의회", "2026-10-30"), event("b", "교과협의회", "2026-11-06"));
    run(s, [it_({ kind: "SCHEDULE", title: "교과협의회", change: "CANCEL", changeFrom: "다음주", evidence: ev({ sentence: "다음주 교과협의회 취소" }) })]);
    expect(s.events.map((e) => !!e.gone)).toEqual([false, true]);
  });

  it("「가정통신문 발송은 다음주 월요일에 하기로」 moves the one open to-do, no second copy", () => {
    const s = emptyState();
    s.tasks.push(task("t", "가정통신문 발송", { due: "2026-10-29" }));
    const a = run(s, [it_({ title: "가정통신문 발송", startAt: "2026-11-02T09:00:00+09:00", evidence: ev({ sentence: "가정통신문 발송은 다음주 월요일에 하기로", dateText: "다음주 월요일" }) })]);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].due).toBe("2026-11-02");
    expect(a.changed).toHaveLength(1);
  });

  it("「치과 예약 취소했음」 written down as a record cancels the 치과", () => {
    const s = emptyState();
    s.events.push(event("d", "치과", "2026-10-30", { area: "personal" }));
    run(s, [it_({ kind: "NOTE", area: "PERSONAL", title: "치과 예약 취소", evidence: ev({ sentence: "치과 예약 취소했음" }) })]);
    expect(s.events[0].gone).toBe(true);
    expect(s.notes).toHaveLength(0);
  });

  it("「출장 취소 신청서 내기」 is a to-do, nothing is cancelled", () => {
    const s = emptyState();
    s.tasks.push(task("t", "출장 신청", { due: "2026-10-30" }));
    run(s, [it_({ title: "출장 취소 신청서 내기", startAt: "2026-10-29T09:00:00+09:00", evidence: ev({ sentence: "내일까지 출장 취소 신청서 내기", dateText: "내일까지" }) })]);
    expect(s.tasks[0].gone).toBeFalsy();
    expect(s.tasks).toHaveLength(2);
  });

  it("「2반 6반 수행평가 채점」 in the title: one to-do per class", () => {
    const s = emptyState();
    run(s, [it_({ title: "2반 6반 수행평가 채점", startAt: "2026-10-30T09:00:00+09:00", evidence: ev({ sentence: "금요일까지 2반 6반 수행평가 채점", dateText: "금요일까지" }) })]);
    expect(s.tasks.map((t) => t.title)).toEqual(["2반 수행평가 채점", "6반 수행평가 채점"]);
  });

  it("「내일 1교시 3반 수업」 with the 교시 left out of the time gets the 교시's time", () => {
    const s = emptyState();
    run(s, [it_({ kind: "SCHEDULE", title: "3반 수업", startAt: "2026-10-29T09:00:00+09:00", reminders: ["2026-10-29T08:50:00+09:00"], reviewReasons: ["날짜만 있어 오전 9시로 임시 지정"], needsReview: true, evidence: ev({ sentence: "내일 1교시 3반 수업", dateText: "내일" }) })]);
    expect([s.events[0].start, s.events[0].end, s.events[0].reminders[0]]).toEqual(["08:50", "09:35", "2026-10-29T08:40"]);
  });

  it("「…참관하고 협의록 쓰기」: the to-do split off after 「하고」 is that day's", () => {
    const s = emptyState();
    run(s, [
      it_({ kind: "SCHEDULE", title: "공개수업 참관", startAt: "2026-11-04T09:00:00+09:00", evidence: ev({ sentence: "다음주 수욜 6교시 공개수업 참관하고", dateText: "다음주 수요일", timeText: "6교시" }) }),
      it_({ title: "협의록 쓰기", evidence: ev({ sentence: "협의록 쓰기" }) })
    ], "다음주 수욜 6교시 공개수업 참관하고 협의록 쓰기");
    expect(s.tasks[0].due).toBe("2026-11-04");
    expect(s.tasks[0].noDue).toBeUndefined();
  });
});

describe("붙여 넣은 메시지는 넣기", () => {
  it("a pasted chat that ends in a question is put in, a plain question is still asked", async () => {
    const { classify } = await import("../src/calendar/ask");
    expect(classify("2026년 10월 28일 수요일\n[오전 8:01] 학년부장: 오늘 4교시 학년 회의\n[오전 8:02] 학년부장: 다들 시간 되시나요?", NOW)).toBe("put");
    expect(classify("[오전 9:12] 행정실: 서류 언제까지 내시나요?", NOW)).toBe("put");
    expect(classify("치과 언제야?", NOW)).toBe("ask");
    expect(classify("2026년 10월 일정 뭐 있어?", NOW)).toBe("ask");
  });
});
