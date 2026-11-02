// 11-02 사용자 결정: 직접 쓴 일정은 확정 · 반복은 「루틴」 「반복」이라고 말할 때만 · 조회 08:40~08:50.
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { DEFAULT_SETTINGS } from "../src/calendar/model";
import { timeWords } from "../src/calendar/rules";
import { draftFromText } from "../src/calendar/store";
import { emptyState, normalizeState } from "../src/calendar/model";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});

async function mount() {
  document.body.innerHTML = '<div id="app" style="width:1300px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
  // No AI (analyze fails): the rule draft is what stays.
  app = await mountBlackhole(root, { ...memoryAdapter(), origin: "데스크톱", analyze: () => Promise.reject(new Error("없음")) }, { now: () => new Date("2026-11-02T10:00:00") });
  return root;
}

describe("직접 쓴 일정은 확정", () => {
  it("입력칸에 쓴 일정은 처음부터 확정", async () => {
    await mount();
    await app!.submitText("내일 3시 학부모 상담");
    const ev = app!.state.events.find((e) => e.title.includes("학부모 상담"))!;
    expect(ev.provisional).toBe(false);
  });

  it("클립보드·붙여 넣은 공지·사진에서 온 일정은 가승인 그대로", async () => {
    await mount();
    await app!.submitText("내일 4시 교직원 회의", "클립보드");
    expect(app!.state.events.find((e) => e.title.includes("교직원 회의"))!.provisional).toBe(true);
    const s = emptyState();
    expect((draftFromText(s, "내일 3시 상담", "사진", new Date("2026-11-02T10:00:00"), "k") as { provisional?: boolean }).provisional).toBe(true);
    expect((draftFromText(s, "내일 3시 상담", "데스크톱", new Date("2026-11-02T10:00:00"), "k2", true) as { provisional?: boolean }).provisional).toBe(false);
  });

  it("입력칸에 붙여 넣은 글은 직접 쓴 것으로 보지 않음", async () => {
    const root = await mount();
    const box = root.querySelector<HTMLInputElement>("#bhIn")!;
    const notice = "11월 5일(수) 15시 30분 교직원 연수가 시청각실에서 있습니다";
    const e = new Event("paste", { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, "clipboardData", { value: { files: [], getData: () => notice } });
    box.dispatchEvent(e);
    await app!.submitText(notice);
    const ev = app!.state.events.find((x) => x.title.includes("연수"));
    expect(ev?.provisional).toBe(true);
  });
});

describe("반복은 명시적으로 말할 때만", () => {
  it("「화목 5시 학원 픽업」은 루틴이 아님", async () => {
    await mount();
    await app!.submitText("아이 학원 픽업은 화목 5시");
    expect(app!.state.routines).toHaveLength(0);
    await app!.submitText("매일 8시 20분 메일 확인");
    expect(app!.state.routines).toHaveLength(0);
  });

  it("「루틴」 「반복」이라고 하면 루틴, 끝 시각도 받음", async () => {
    await mount();
    await app!.submitText("매주 월금 0820~0830 교문지도 루틴");
    const r = app!.state.routines[0];
    expect(r).toMatchObject({ title: "교문지도", at: "08:20", end: "08:30", repeat: [1, 5] });
    await app!.submitText("평일 16시 10분 업무일지 반복");
    expect(app!.state.routines[1]).toMatchObject({ title: "업무일지", at: "16:10", repeat: "weekdays" });
  });
});

describe("조회 08:40~08:50", () => {
  it("조회 때·전·끝나고를 학교 조회 시각으로", () => {
    const day = { ...DEFAULT_SETTINGS };
    expect(DEFAULT_SETTINGS.assembly).toBe("08:40-08:50");
    expect(timeWords("내일 조회 때 가정통신문 배부", day)).toContain("08:40~08:50");
    expect(timeWords("조회 전에 출석부 확인", day)).toContain("08:40까지");
    expect(timeWords("조회 끝나고 상담", day)).toContain("08:50");
    // 「성적 조회」 is not the meeting.
    expect(timeWords("성적 조회 전에 확인", day)).not.toContain("08:40");
  });

  it("「내일 조회 때 가정통신문 배부」 → 내일 08:40", async () => {
    await mount();
    await app!.submitText("내일 조회 때 가정통신문 배부");
    const x = [...app!.state.events, ...app!.state.tasks].find((e) => e.title.includes("가정통신문"))!;
    expect(x).toBeDefined();
    expect((x as { start?: string; dueTime?: string }).start ?? (x as { dueTime?: string }).dueTime).toBe("08:40");
  });
});

describe("급함 = 걸리는 시간 대비 남은 근무 시간 (11-02, 2배)", () => {
  const MON = new Date("2026-11-02T10:00:00");
  const task = (title: string, due: string, dueTime: string | null, effort?: number) => ({ id: "t", kind: "task" as const, title, area: "school" as const, source: "t", createdAt: "2026-11-01T08:00", due, dueTime, done: false, reminders: [], subs: [], ...(effort ? { effort } : {}) });
  const st = { settings: { onWork: "08:20", offWork: "16:20" }, events: [] };

  it("걸리는 시간 짐작 · 6단계", async () => {
    const { guessEffort } = await import("../src/calendar/views/today");
    expect(guessEffort("공문 제출")).toBe(10);
    expect(guessEffort("출제 원안 제출")).toBe(10);
    expect(guessEffort("기말 문제 출제")).toBe(480);
    expect(guessEffort("수행평가 채점")).toBe(180);
    expect(guessEffort("2학년 세특 입력")).toBe(1440);
  });

  it("문서 한 장은 1시간 남아야 급함, 출제는 이틀 가까이 남아도 급함", async () => {
    const { urgency } = await import("../src/calendar/views/today");
    expect(urgency(task("공문 제출", "2026-11-02", "15:00"), MON, st)).toBe(0);
    expect(urgency(task("공문 제출", "2026-11-02", "10:50"), MON, st)).toBe(2);
    expect(urgency(task("수행평가 채점", "2026-11-02", "16:00"), MON, st)).toBe(2); // 3시간, 6시간 남음
    expect(urgency(task("수행평가 채점", "2026-11-02", "16:20"), MON, st)).toBe(1); // 6시간 20분 남음: 곧
    expect(urgency(task("기말 문제 출제", "2026-11-03", null), MON, st)).toBe(2); // 하루, 근무 14시간 20분 남음
    expect(urgency(task("기말 문제 출제", "2026-11-05", null), MON, st)).toBe(1); // 곧: 4배 이하
    expect(urgency(task("2학년 세특 입력", "2026-11-20", null), MON, st)).toBe(0);
    expect(urgency(task("송금", "2026-10-27", null), MON, st)).toBe(3);
    // 작업 시간을 잡아 두면 그만큼 덜 급함.
    const planned = { ...st, events: [{ workFor: "t", start: "13:00", end: "16:00" } as never] };
    expect(urgency(task("수행평가 채점", "2026-11-02", "16:00"), MON, planned)).toBe(0);
  });

  it("남은 시간 한 칸: D-n · n시간 남음 · n일 지남", async () => {
    const { remainText } = await import("../src/calendar/views/today");
    expect(remainText(task("a", "2026-11-03", null), MON)).toBe("D-1");
    expect(remainText(task("a", "2026-11-02", "15:15"), MON)).toBe("5시간 남음");
    expect(remainText(task("a", "2026-11-02", "10:40"), MON)).toBe("40분 남음");
    expect(remainText(task("a", "2026-10-29", "15:10"), MON)).toBe("3일 지남");
  });

  it("남은 시간 칸을 누르면 기한 다시 정하기 · ⌘Z", async () => {
    const root = await mount();
    await app!.submitText("오늘 4시까지 보고서 제출");
    const t = app!.state.tasks.find((x) => x.title.includes("보고서"))!;
    root.querySelector<HTMLElement>(`.tl .rem[data-rem="${t.id}"]`)!.click();
    root.querySelector<HTMLElement>(".rempop [data-remset]:nth-child(2)")!.click(); // 내일
    expect([t.due, t.dueTime, t.reminders]).toEqual(["2026-11-03", "16:20", ["2026-11-03T15:50"]]); // 기한 30분 전
    root.querySelector<HTMLElement>(`.tl .rem[data-rem="${t.id}"]`)!.click();
    root.querySelector<HTMLElement>('.rempop [data-effort="180"]')!.click();
    expect(app!.state.tasks.find((x) => x.id === t.id)!.effort).toBe(180);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(app!.state.tasks.find((x) => x.id === t.id)!.due).toBe("2026-11-02");
  });
});

describe("월간 ★ · 교시 표시 (11-02)", () => {
  it("「교시」라고 말한 수업은 그 교시가 하루표에 보임 (「3교시 전」은 아님)", async () => {
    const { periodSaid } = await import("../src/calendar/store");
    expect(periodSaid("내일 3교시 2-3 과학")).toBe("3교시");
    expect(periodSaid("수요일 5,6교시 과학실 예약")).toBe("5~6교시");
    expect(periodSaid("3교시 전에 출석부")).toBeUndefined();
    const root = await mount();
    await app!.submitText("내일 3교시 2-3 과학 수업");
    const ev = app!.state.events.find((e) => e.title.includes("과학"))!;
    expect([ev.start, ev.periodSaid]).toEqual(["10:40", "3교시"]);
    app!.setView("day", ev.date);
    expect(root.querySelector(`.dtg [data-ev="${ev.id}"] .pd`)!.textContent).toBe("3교시");
  });

  it("월간 보기에서 일정을 눌러도 월간 그대로 상세 창이 열리고, ★가 칸에 보임", async () => {
    const root = await mount();
    await app!.submitText("11월 10일 3시 학부모 상담");
    const ev = app!.state.events.find((e) => e.title.includes("상담"))!;
    app!.setView("month", "2026-11-10");
    const chip = () => root.querySelector<HTMLElement>(`.fc [data-ev="${ev.id}"]`)!;
    chip().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector(".fc-rolling-view, .fc-dayGridMonth-view")).not.toBeNull();
    root.querySelector<HTMLElement>('#bhDetail [data-dstar="2"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ev.star).toBe(2);
    expect(chip().querySelector(".mst.s2")).not.toBeNull();
  });
});

describe("다가오는 주요 일정 · 할 일 묶기 (11-02)", () => {
  it("날짜 창 없이 D-day 순, 화면에는 10개까지 (37일 뒤 ★ 기말고사가 빠지던 것)", async () => {
    const { upcoming } = await import("../src/calendar/views/today");
    const s = emptyState();
    s.periods.push({ id: "p1", kind: "period", title: "기말고사", from: "2026-12-09", to: "2026-12-10", star: 2, area: "school", source: "t", createdAt: "2026-11-01T08:00" } as never);
    s.periods.push({ id: "p2", kind: "period", title: "겨울 연수", from: "2026-12-20", to: "2026-12-22", area: "school", source: "t", createdAt: "2026-11-01T08:00" } as never);
    s.events.push({ id: "e1", kind: "event", title: "수능", date: "2026-11-19", start: null, end: null, star: 2, provisional: false, reminders: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" } as never);
    expect(upcoming(s, "2026-11-02", (k) => k).map((u) => u.title)).toEqual(["수능", "기말고사", "겨울 연수"]);
    for (let i = 0; i < 12; i++) s.events.push({ id: `x${i}`, kind: "event", title: `행사${i}`, date: `2027-01-${String(i + 10).padStart(2, "0")}`, start: null, end: null, star: 1, provisional: false, reminders: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" } as never);
    const { rightStack, UPCOMING_MAX } = await import("../src/calendar/views/today");
    const html = rightStack({ s, today: "2026-11-02" } as never, "2026-11-02", (k: string) => k, { upRange: 120 });
    expect((html.match(/class="blb/g) ?? []).length).toBe(UPCOMING_MAX);
    // 기본 60일: 그 안의 것만, 나머지는 「그 뒤 n개」. 이름은 6글자까지.
    const h60 = rightStack({ s, today: "2026-11-02" } as never, "2026-11-02", (k: string) => k);
    expect((h60.match(/class="blb/g) ?? []).length).toBe(3);
    expect(h60).toContain("그 뒤 12개");
  });

  it("⌘+클릭으로 둘 고르고 새 이름으로 묶으면 나머지는 하위 체크, ⌘Z로 원래대로, 따로 떼기", async () => {
    const root = await mount();
    await app!.submitText("내일까지 방한용품 품의하기");
    await app!.submitText("금요일까지 지마켓 아이디 전달하기");
    const [a, b] = ["방한용품", "지마켓"].map((w) => app!.state.tasks.find((t) => t.title.includes(w))!);
    app!.setView("day", "2026-11-02"); // the month test before leaves the view remembered
    const row = (id: string) => root.querySelector<HTMLElement>(`.tl .task[data-task="${id}"] .tn`)!;
    row(a.id).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    row(b.id).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    root.querySelector<HTMLElement>("[data-mergeopen]")!.click();
    const pop = root.querySelector<HTMLElement>(".mergepop")!;
    const name = pop.querySelector<HTMLInputElement>("[data-mnew]")!;
    name.value = "방한용품 구매";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    pop.querySelector<HTMLElement>("[data-mok]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const live = app!.state.tasks.filter((t) => !t.gone && !t.done);
    const m = live.find((t) => t.title === "방한용품 구매")!;
    expect(m.subs.map((x) => x.title)).toEqual(["방한용품 품의하기", "지마켓 아이디 전달하기"]);
    expect(m.due).toBe("2026-11-03"); // 가장 이른 기한
    expect(live.some((t) => t.title.includes("지마켓"))).toBe(false);
    // 따로 떼기
    root.querySelector<HTMLElement>(`[data-subout="${m.id}:1"]`)!.click();
    expect(app!.state.tasks.some((t) => !t.gone && t.title === "지마켓 아이디 전달하기")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(app!.state.tasks.filter((t) => !t.gone && !t.done).map((t) => t.title).sort()).toEqual(["방한용품 품의하기", "지마켓 아이디 전달하기"]);
  });
});

describe("주요 일정 띠: 겹칠 때만 위로 · ★ 고르기 (11-02)", () => {
  it("멀리 떨어진 두 일정은 둘 다 맨 아래 줄 · 노랑만 / 빨강만 / 둘 다", async () => {
    const { upcomingBand } = await import("../src/calendar/views/today");
    const s = emptyState();
    const ev = (id: string, title: string, date: string, star: number) => ({ id, kind: "event", title, date, start: null, end: null, star, provisional: false, reminders: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" }) as never;
    s.events.push(ev("a", "수능", "2026-11-19", 2), ev("b", "기말고사", "2026-12-09", 2), ev("c", "종업식", "2026-12-20", 1));
    const c = { s, today: "2026-11-02" } as never;
    const tops = (html: string) => [...html.matchAll(/class="blb[^"]*"[^>]*top:(\d+)px/g)].map((m) => Number(m[1]));
    const both = upcomingBand(c, "2026-11-02", (k) => k, 60, 560, 2);
    expect(both.shown).toBe(2);
    expect(new Set(tops(both.html)).size).toBe(1); // one row: they do not touch
    expect(upcomingBand(c, "2026-11-02", (k) => k, 60, 560, 1).shown).toBe(1);
    expect(upcomingBand(c, "2026-11-02", (k) => k, 60, 560, "all").shown).toBe(3);
  });
});

describe("월요일 시작 · D-day는 진짜 오늘 기준 · 띠 이름 (11-02)", () => {
  it("다른 날을 보고 있어도 D-day는 오늘부터, 띠 이름이 있으면 그 이름", async () => {
    const { rightStack } = await import("../src/calendar/views/today");
    const s = emptyState();
    s.events.push({ id: "a", kind: "event", title: "수능응시자 모의고사", short: "수능모의", date: "2026-11-08", start: "07:30", end: "16:30", star: 2, provisional: false, reminders: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" } as never);
    const html = rightStack({ s, today: "2026-11-02" } as never, "2026-11-07", (k: string) => k);
    expect(html).toContain("D-6");
    expect(html).toContain("수능모의");
    expect(html).toContain("11/8");
  });
});

describe("11-02 시안 15: 학교 · 외부 · 개인 색", () => {
  it("외부 영역이 저장·불러오기에서 살아 있고, 하루표 칸에 종류 표시가 붙고, 상세 창에서 고를 수 있음", async () => {
    const root = await mount();
    await app!.submitText("오늘 오후 2시 학부모 상담");
    const ev = app!.state.events.find((e) => e.title.includes("학부모 상담"))!;
    expect(root.querySelector(`.dtg [data-ev="${ev.id}"]`)!.classList.contains(`k-${ev.area}`)).toBe(true);
    root.querySelector<HTMLElement>(`.dtg [data-ev="${ev.id}"]`)!.click();
    root.querySelector<HTMLElement>('#bhDetail [data-darea="outside"]')!.click();
    expect(ev.area).toBe("outside");
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector(`.dtg [data-ev="${ev.id}"]`)!.classList.contains("k-outside")).toBe(true);
    expect(normalizeState(JSON.parse(JSON.stringify(app!.state)))!.events.find((e) => e.id === ev.id)!.area).toBe("outside");
  });
});

describe("11-02 외부 = 학교 밖에서 하는 일", () => {
  it("출장·모의고사 감독·임용 감독은 규칙 초안부터 외부, 학교 안의 일은 학교", () => {
    const s = emptyState();
    const at = new Date("2026-11-02T10:00:00");
    expect(draftFromText(s, "11월 8일 수능응시자 모의고사 7시 30분", "데스크톱", at, "a").area).toBe("outside");
    expect(draftFromText(s, "목요일 오후 2시 출장", "데스크톱", at, "b").area).toBe("outside");
    expect(draftFromText(s, "내일 3시 교직원 회의", "데스크톱", at, "c").area).toBe("school");
  });
});
