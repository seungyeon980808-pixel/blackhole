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

describe("이미 있는 기록 바꾸기 (밤샘 2차 45문장)", async () => {
  const { finishedBy, changeTargets, doneReport } = await import("../src/calendar/store");
  const { emptyState } = await import("../src/calendar/model");
  const now = new Date("2026-11-02T08:30:00");
  const s = emptyState();
  const task = (id: string, title: string, due: string) => ({ id, kind: "task" as const, title, area: "school" as const, source: "t", createdAt: "2026-10-27T09:00", due, dueTime: null, done: false, reminders: [], subs: [] });
  const ev = (id: string, title: string, date: string) => ({ id, kind: "event" as const, title, area: "school" as const, source: "t", createdAt: "2026-10-27T09:00", date, start: "15:10", end: null, provisional: false, reminders: [] });
  s.tasks.push(task("t1", "진석이에게 10만원 송금", "2026-10-27"), task("t2", "대의원회 기안 올리기", "2026-10-29"), task("t3", "가정통신문 작성·발송할지 확인", "2026-10-29"), task("t4", "대의원회 준비", "2026-10-28"));
  s.events.push(ev("e1", "대의원회", "2026-11-06") as never, ev("e2", "대의원회", "2026-11-16") as never, ev("e3", "1년 모임 돌아보며, 수업 나눔 및 친목(20명 이내)", "2026-11-06") as never);
  const item = (title: string, change: "MOVE" | "CANCEL", changeFrom = "") => ({ kind: "SCHEDULE", title, change, changeFrom, evidence: { sentence: title, dateText: "", timeText: "" } }) as never;

  it("「보냄」 「올렸음」 「올림」은 끝냄, 「있음」 「보냈었나」는 아님", () => {
    for (const t of ["진석이한테 10만원 보냄", "대의원회 기안 올렸음", "기안 올림", "시행 기안 다 올렸어"]) expect(doneReport(t), t).toBe(true);
    for (const t of ["3반 민수 땅콩 알레르기 있음", "진석이한테 돈 보냈었나", "금요일까지 기안 올리기"]) expect(doneReport(t), t).toBe(false);
  });

  it("같은 뜻 낱말로 할 일을 찾음: 보냄=송금, 올렸음=올리기", () => {
    expect(finishedBy(s, "진석이한테 10만원 보냄").map((t) => t.id)).toEqual(["t1"]);
    expect(finishedBy(s, "대의원회 기안 올렸음").map((t) => t.id)).toEqual(["t2"]);
  });

  it("제목이 조금 달라도 낱말이 다 들어 있으면, 이름이 똑같은 일정이 먼저, 「16일」로 좁힘", () => {
    expect(changeTargets(s, item("가정통신문 확인", "MOVE"), now).map((x) => x.id)).toEqual(["t3"]);
    expect(changeTargets(s, item("수업 나눔 모임", "CANCEL"), now).map((x) => x.id)).toEqual(["e3"]);
    expect(changeTargets(s, item("대의원회", "MOVE", "16일"), now).map((x) => x.id)).toEqual(["e2"]);
  });
});

describe("여러 줄 중 한 줄이 할 일 (실제 10/30)", () => {
  it("「학습지제작레포 실사용해보기,\\n시간은 약 30분 예상」은 확실한 기억이 아님", () => {
    expect(memoDraft("학습지제작레포 실사용해보기,\n시간은 약 30분 예상", NOW)?.final ?? false).toBe(false);
    expect(memoDraft("3반 민수 땅콩 알레르기 있음\n엄마 연락처는 기록부", NOW)?.final).toBe(true);
  });
});

describe("문장 가운데 「…하기」 (실제 10/30)", () => {
  it("「풍선 사서 은하 팽창 보여주기 서유경 티」는 할 일 후보, 「메모 …」는 그대로 기억", () => {
    expect(memoDraft("풍선 사서 은하 팽창 보여주기 서유경 티", NOW)?.final ?? false).toBe(false);
    expect(memoDraft("메모 다음엔 보여주기 실험", NOW)?.final).toBe(true);
  });
});

describe("AI가 시각을 「점심」 한 낱말로 줄 때 (밤샘 1차 재검)", () => {
  it("학교 점심시간(12:20–13:20)으로", async () => {
    const { applyProposal } = await import("../src/calendar/store");
    const { emptyState } = await import("../src/calendar/model");
    const s = emptyState();
    const item = { kind: "SCHEDULE", area: "SCHOOL", title: "부장 회의", details: "", startAt: "2026-11-05T12:00:00+09:00", endAt: "2026-11-05T13:00:00+09:00", reminderAt: "", reminders: [], subtasks: [], evidence: { sentence: "목 점심에 부장 회의", dateText: "목", timeText: "점심", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: [] };
    applyProposal(s, { sourceText: "목 점심에 부장 회의", needsReview: false, reviewReasons: [], items: [item] } as never, "t", NOW);
    expect([s.events[0].start, s.events[0].end]).toEqual(["12:20", "13:20"]);
  });
});

describe("「전날까지」의 기준 (공지 붙여넣기 시험)", () => {
  it("이름 없이 「전날까지」: 같은 글로 들어온 일정 하나가 기준", async () => {
    const { applyProposal } = await import("../src/calendar/store");
    const { emptyState } = await import("../src/calendar/model");
    const s = emptyState();
    const ev = { kind: "SCHEDULE", area: "SCHOOL", title: "축제", details: "", startAt: "2026-11-27T09:00:00+09:00", endAt: "", reminderAt: "", reminders: [], subtasks: [], evidence: { sentence: "27일 축제", dateText: "27일", timeText: "", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: true, reviewReasons: ["날짜만 있어 오전 9시로 임시 지정"] };
    const todo = { kind: "TODO", area: "SCHOOL", title: "반 부스 신청서 제출", details: "", startAt: "", endAt: "", reminderAt: "", reminders: [], subtasks: [], evidence: { sentence: "전날까지 반 부스 신청서 제출", dateText: "전날", timeText: "", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: true, reviewReasons: ["날짜 표현을 해석하지 못함: 「전날」"] };
    applyProposal(s, { sourceText: "27일 축제\n전날까지 반 부스 신청서 제출", needsReview: true, reviewReasons: [], items: [ev, todo] } as never, "t", NOW);
    expect(s.tasks[0].due).toBe("2026-11-26");
    expect(s.tasks[0].noDue).toBeUndefined();
  });
});

describe("예약은 했지만 쓰는 날은 앞으로", () => {
  it("AI가 「과학실 사용 예약」을 날짜 있는 기억으로 줘도 일정", async () => {
    const { applyProposal } = await import("../src/calendar/store");
    const { emptyState } = await import("../src/calendar/model");
    const s = emptyState();
    const note = { kind: "NOTE", area: "SCHOOL", title: "과학실 사용 예약", details: "", startAt: "2026-11-04T09:00:00+09:00", endAt: "", reminderAt: "", reminders: [], subtasks: [], evidence: { sentence: "수요일 5,6교시 과학실 사용 예약함", dateText: "수요일", timeText: "5,6교시", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: [] };
    applyProposal(s, { sourceText: note.evidence.sentence, needsReview: false, reviewReasons: [], items: [note] } as never, "t", NOW);
    expect(s.events.map((e) => [e.date, e.start, e.end])).toEqual([["2026-11-04", "13:20", "15:00"]]);
  });
});

describe("오타·줄임말 날짜 (4차 시험)", () => {
  it("「내알」 「tmr」 「모래 3시」 「목 6교시」 「이달 말」은 읽고, 「모래 놀이」 「목 아파서」 「1일」은 그대로", async () => {
    const { spokenDays } = await import("../src/calendar/rules");
    expect(spokenDays("내알 저녁 7시 엄마랑 저녁")).toBe("내일 저녁 7시 엄마랑 저녁");
    expect(spokenDays("tmr 점심 식사")).toBe("내일 점심 식사");
    expect(spokenDays("모래 3시 치과")).toBe("모레 3시 치과");
    expect(spokenDays("목 6교시 진로 상담")).toBe("목요일 6교시 진로 상담");
    expect(spokenDays("이달 말까지 연말정산")).toBe("이번 달 말까지 연말정산");
    for (const t of ["모래 놀이 준비물", "목 아파서 병원", "1일 10시 회의"]) expect(spokenDays(t)).toBe(t);
    expect(parseDraft("수 12시 30분 점심 약속", NOW).date).toBe("2026-11-04");
  });
});
