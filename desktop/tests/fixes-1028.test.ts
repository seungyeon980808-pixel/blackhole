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
