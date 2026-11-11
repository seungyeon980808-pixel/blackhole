// 11-04 사용자 「제안대로 쫙 다 해」: 주요 일정 띠 「+n」(시안 16), 말로 묶기 + AI 이름 제안(시안 17).
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, type CalendarState } from "../src/calendar/model";
import { upcomingBand } from "../src/calendar/views/today";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("주요 일정 띠: 자리 없는 이름은 「+n」 (시안 16)", () => {
  it("몰려 있는 ★ 10개 — 이름은 겹치지 않고, 들어가지 못한 것은 「+n」 하나로, 마우스를 올리면 목록", () => {
    const s = emptyState();
    const ev = (i: number, title: string, d: number) => ({ id: `e${i}`, kind: "event", title, date: `2026-11-${String(4 + d).padStart(2, "0")}`, start: null, end: null, star: 2, provisional: false, reminders: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" }) as never;
    ["농어촌공사 시험감독", "학부모 상담주간 안내", "교육청 컨설팅", "과학의 날 행사", "학년말 성적 처리", "수행평가 마감", "수능", "방과후 신청", "학생부 점검", "교과협의회"].forEach((t, i) => s.events.push(ev(i, t, [3, 9, 10, 11, 12, 13, 15, 17, 18, 19][i])));
    const b = upcomingBand({ s, today: "2026-11-04" } as never, "2026-11-04", (k) => k, 120, 400, "all");
    const plus = b.html.match(/class="blb bplus"[^>]*title="([^"]*)"[^>]*><b>\+(\d+)<\/b>/);
    expect(plus).not.toBeNull();
    const shownNames = [...b.html.matchAll(/class="blb (?!bplus)[^"]*"/g)].length;
    expect(shownNames + Number(plus![2])).toBe(10);
    expect(plus![1]).toContain("D-");
  });

  it("넓게 퍼진 일정은 지금과 같음(「+n」 없음)", () => {
    const s = emptyState();
    const ev = (id: string, title: string, date: string) => ({ id, kind: "event", title, date, start: null, end: null, star: 2, provisional: false, reminders: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" }) as never;
    s.events.push(ev("a", "수능", "2026-11-19"), ev("b", "기말고사", "2026-12-09"));
    const b = upcomingBand({ s, today: "2026-11-04" } as never, "2026-11-04", (k) => k, 120, 560, "all");
    expect(b.html).not.toContain("bplus");
    expect(b.html.match(/class="bdd/g)?.length).toBe(2);
  });
});

function tasks(): CalendarState {
  const s = emptyState();
  const t = (id: string, title: string, due: string) => ({ id, kind: "task", title, due, dueTime: null, done: false, reminders: [], subs: [], area: "school", source: "t", createdAt: "2026-11-01T08:00" }) as never;
  s.tasks.push(t("t1", "대의원회 사전 안내", "2026-11-05"), t("t2", "대의원회 기안 올리기", "2026-11-06"), t("t3", "대의원회 준비", "2026-11-05"), t("t4", "여권 신청 준비", "2026-11-07"));
  return s;
}

async function mount(extra: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="app" style="width:1300px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
  const st = tasks();
  app = await mountBlackhole(root, { ...memoryAdapter(), origin: "데스크톱", load: async () => st, analyze: () => Promise.reject(new Error("없음")), ...extra } as never, { now: () => new Date("2026-11-04T10:00:00"), seed: false });
  return root;
}

describe("말로 묶기 + AI 이름 제안 (시안 17)", () => {
  it("「…랑 …, … 하나로 묶어」: 할 일을 찾아 묶기 창을 엶(바로 묶지 않음), 대화에 남김", async () => {
    await mount();
    await app!.submitText("대의원회 사전 안내랑 기안 올리기, 대의원회 준비 하나로 묶어");
    const pop = document.querySelector<HTMLElement>(".mergepop")!;
    expect(pop).not.toBeNull();
    expect(pop.dataset.ids!.split(",").sort()).toEqual(["t1", "t2", "t3"]);
    expect(app!.state.tasks.filter((t) => !t.gone).length).toBe(4); // nothing merged yet
    expect(app!.state.chat.at(-1)!.text).toContain("할 일 3개를 찾아");
    // 하나 빼고 묶기
    const off = pop.querySelector<HTMLInputElement>('[data-mpick][value="t2"]')!;
    off.checked = false;
    off.dispatchEvent(new Event("change", { bubbles: true }));
    pop.querySelector<HTMLElement>("[data-mok]")!.click();
    await tick();
    expect(app!.state.tasks.find((t) => t.id === "t1")!.subs.map((x) => x.title)).toContain("대의원회 준비");
    expect(app!.state.tasks.find((t) => t.id === "t2")!.gone).toBeFalsy();
  });

  it("할 일을 둘 이상 못 찾으면 묶기 말이 아님(보통 넣기로)", async () => {
    await mount();
    await app!.submitText("내일 자료 묶어서 제출하기");
    expect(document.querySelector(".mergepop")).toBeNull();
  });

  it("Mac: AI가 지은 이름이 맨 위 후보로 와서 골라져 있음, 그 이름으로 묶임", async () => {
    let asked: string[] = [];
    await mount({ nameTasks: async (t: string[]) => ((asked = t), "대의원회 준비·안내") });
    await app!.submitText("대의원회 사전 안내랑 대의원회 준비 묶어");
    await tick();
    const pop = document.querySelector<HTMLElement>(".mergepop")!;
    expect(asked.sort()).toEqual(["대의원회 사전 안내", "대의원회 준비"]);
    expect(pop.querySelector(".aiq .an")!.textContent).toBe("대의원회 준비·안내");
    expect(pop.querySelector<HTMLInputElement>('.aiq input')!.checked).toBe(true);
    pop.querySelector<HTMLElement>("[data-mok]")!.click();
    await tick();
    expect(app!.state.tasks.filter((t) => !t.gone && !t.done).map((t) => t.title)).toContain("대의원회 준비·안내");
  });

  it("AI가 안 되면 그 줄만 빠짐", async () => {
    await mount({ nameTasks: async () => Promise.reject(new Error("키 없음")) });
    await app!.submitText("대의원회 사전 안내랑 대의원회 준비 묶어");
    await tick();
    await tick();
    expect(document.querySelector(".mergepop .aiq")).toBeNull();
    expect(document.querySelector(".mergepop")).not.toBeNull();
  });
});

describe("11-11: 시작만 말한 일정은 30분", () => {
  it("「0920 학생회 사진촬영」 — AI가 끝을 1시간 뒤로 붙여 와도 30분, 「9시~10시」·「3교시」는 말한 대로", async () => {
    const { applyProposal } = await import("../src/calendar/store");
    const s = emptyState();
    const item = (title: string, timeText: string, a: string, b: string) => ({ kind: "SCHEDULE", area: "SCHOOL", title, details: "", startAt: `2026-11-11T${a}:00+09:00`, endAt: `2026-11-11T${b}:00+09:00`, reminderAt: "", reminders: [], subtasks: [], evidence: { sentence: title, dateText: "", timeText, endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: [] });
    applyProposal(s, { sourceText: "x", needsReview: false, reviewReasons: [], items: [item("학생회 사진촬영", "0920", "09:20", "10:20"), item("회의", "9시~10시", "09:00", "10:00"), item("수업", "3교시", "10:40", "11:25")] } as never, "t", new Date("2026-11-10T20:00:00"));
    expect(s.events.map((e) => [e.title, e.start, e.end])).toEqual([["학생회 사진촬영", "09:20", "09:50"], ["회의", "09:00", "10:00"], ["수업", "10:40", "11:25"]]);
  });
});

describe("11-11: 날짜가 바뀌면 오늘로", () => {
  it("어제를 보던 하루 화면은 날이 바뀌면 오늘로, 손으로 옮겨 간 다른 날은 그대로", async () => {
    let now = new Date("2026-11-10T23:58:00");
    document.body.innerHTML = '<div id="app" style="width:1300px;height:800px"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
    app = await mountBlackhole(root, { ...memoryAdapter(), origin: "데스크톱", load: async () => emptyState() } as never, { now: () => now, seed: false });
    app.setView("day", "2026-11-10");
    now = new Date("2026-11-11T07:30:00");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.querySelector("#bhTitle")!.textContent).toContain("11월 11일");
    app.setView("day", "2026-11-20");
    now = new Date("2026-11-12T07:30:00");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.querySelector("#bhTitle")!.textContent).toContain("11월 20일");
  });
});

describe("11-11: 「4,5,6,7교시 … 9 6 3 5반」", () => {
  it("작업기가 교시를 살려 보내면 앱이 학교 교시표로 시각을 정함(4교시 11:35 … 7교시 15:10)", async () => {
    const { applyProposal } = await import("../src/calendar/store");
    const s = emptyState();
    const it = (title: string, p: string) => ({ kind: "SCHEDULE", area: "SCHOOL", title, details: "", startAt: "2026-11-11T09:00:00+09:00", endAt: "2026-11-11T10:00:00+09:00", reminderAt: "", reminders: [], subtasks: [], evidence: { sentence: "오늘 4,5,6,7교시 수업 순서대로 9 6 3 5반임", dateText: "오늘", timeText: p, endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: true, reviewReasons: ["날짜만 있어 오전 9시로 임시 지정"] });
    applyProposal(s, { sourceText: "오늘 4,5,6,7교시 수업 순서대로 9 6 3 5반임", needsReview: false, reviewReasons: [], items: [it("9반 수업", "4교시"), it("6반 수업", "5교시"), it("3반 수업", "6교시"), it("5반 수업", "7교시")] } as never, "t", new Date("2026-11-11T08:49:00"), "k", true);
    expect(s.events.map((e) => `${e.title} ${e.start}-${e.end}`)).toEqual(["9반 수업 11:35-12:20", "6반 수업 13:20-14:05", "3반 수업 14:15-15:00", "5반 수업 15:10-15:55"]);
  });
});

describe("11-11 시안 19: 링크·파일", () => {
  it("상세 창에 링크를 붙이면 할 일 줄에 고리, 하나면 바로 열고, 둘이면 목록, ×로 떼고 ⌘Z", async () => {
    const opened: string[] = [];
    const root = await mount({ openTarget: async (t: string) => void opened.push(t) });
    app!.setView("day", "2026-11-04");
    root.querySelector<HTMLElement>('.tl .task[data-ev="t1"] .tn')!.click();
    const input = () => root.querySelector<HTMLInputElement>('#bhDetail [data-df="link"]')!;
    input().value = "https://neis.go.kr/x";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    const t1 = () => app!.state.tasks.find((t) => t.id === "t1")!;
    expect(t1().links).toEqual([{ href: "https://neis.go.kr/x" }]);
    expect(root.querySelector("#bhDetail .dlo")!.textContent).toBe("neis.go.kr");
    root.querySelector<HTMLElement>('.tl .task[data-ev="t1"] .lk')!.click();
    expect(opened).toEqual(["https://neis.go.kr/x"]);
    input().value = "/Users/me/2학년 채점표.xlsx";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    root.querySelector<HTMLElement>('.tl .task[data-ev="t1"] .lk')!.click();
    const items = [...root.querySelectorAll(".lkmenu button")].map((b) => b.textContent);
    expect(items).toEqual(["neis.go.kr", "2학년 채점표.xlsx"]);
    root.querySelector<HTMLElement>('.lkmenu [data-lkopen="t1|1"]')!.click();
    expect(opened.at(-1)).toBe("/Users/me/2학년 채점표.xlsx");
    root.querySelector<HTMLElement>('#bhDetail [data-ldel="0"]')!.click();
    expect(t1().links!.map((l) => l.href)).toEqual(["/Users/me/2학년 채점표.xlsx"]);
  });
});

describe("11-11: 상세 창 없이 링크·파일", () => {
  it("할 일 줄에 파일을 끌어 놓으면 그 할 일에 붙음(빈 곳이면 인박스), 오른쪽 클릭 메뉴에서 열기·폴더·복사한 링크", async () => {
    let drop: ((p: string[], at?: { x: number; y: number }) => void) | null = null;
    const put: string[] = [];
    const opened: string[] = [];
    const root = await mount({ onFileDrop: (h: typeof drop) => void (drop = h), putPath: async (p: string) => void put.push(p), openTarget: async (t: string) => void opened.push(t), pickFile: async (folder?: boolean) => (folder ? "/Users/me/대의원회" : null), clipboardText: async () => "https://docs.google.com/x" });
    app!.setView("day", "2026-11-04");
    const row = root.querySelector<HTMLElement>('.tl .task[data-task="t3"] .tn')!;
    const was = document.elementFromPoint;
    document.elementFromPoint = (x: number) => (x === 10 ? row : document.body) as Element;
    drop!(["/Users/me/회의록.hwp"], { x: 10, y: 10 });
    drop!(["/Users/me/공지.pdf"], { x: 99, y: 10 });
    document.elementFromPoint = was;
    await tick();
    const t3 = () => app!.state.tasks.find((t) => t.id === "t3")!;
    expect(t3().links).toEqual([{ href: "/Users/me/회의록.hwp" }]);
    expect(put).toEqual(["/Users/me/공지.pdf"]);
    // 오른쪽 클릭: 링크 열기 · 폴더 붙이기 · 복사한 링크 붙이기
    const menu = () => root.querySelector<HTMLElement>("#bhCtx")!;
    const right = () => root.querySelector<HTMLElement>('.tl .task[data-task="t3"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    right();
    expect([...menu().querySelectorAll(".cm-lk")].map((b) => b.textContent)).toEqual(["회의록.hwp"]);
    menu().querySelector<HTMLElement>(".cm-lk")!.click();
    expect(opened).toEqual(["/Users/me/회의록.hwp"]);
    right();
    menu().querySelector<HTMLElement>('[data-cmlink="folder"]')!.click();
    await tick();
    right();
    menu().querySelector<HTMLElement>('[data-cmlink="paste"]')!.click();
    await tick();
    await tick();
    expect(t3().links!.map((l) => l.href)).toEqual(["/Users/me/회의록.hwp", "/Users/me/대의원회", "https://docs.google.com/x"]);
  });
});
