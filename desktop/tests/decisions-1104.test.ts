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
