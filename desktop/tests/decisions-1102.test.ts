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
