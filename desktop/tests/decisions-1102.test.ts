// 11-02 사용자 결정: 직접 쓴 일정은 확정 · 반복은 「루틴」 「반복」이라고 말할 때만 · 조회 08:40~08:50.
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { DEFAULT_SETTINGS } from "../src/calendar/model";
import { timeWords } from "../src/calendar/rules";
import { draftFromText } from "../src/calendar/store";
import { emptyState } from "../src/calendar/model";

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
