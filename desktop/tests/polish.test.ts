// 상용 수준 점검 (2026-10-31): 넣은 뒤에도 입력칸에 커서가 남고, 설정 시간 칸에 잘못 쓰면 원래 값과 예시 한 줄.
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});
const tick = () => new Promise((r) => setTimeout(r, 0));

async function mount() {
  document.body.innerHTML = '<div id="app" style="width:1300px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
  app = await mountBlackhole(root, memoryAdapter(), { now: () => new Date("2026-10-31T10:00:00") });
  return root;
}

describe("상용 수준 마감", () => {
  it("Enter로 넣은 뒤 입력칸에 커서가 그대로 있어 바로 이어 쓸 수 있다", async () => {
    const root = await mount();
    const box = root.querySelector<HTMLTextAreaElement>("#bhIn")!;
    box.focus();
    box.value = "금요일까지 생기부 점검";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (let i = 0; i < 5; i++) await tick();
    expect(app!.state.tasks.map((t) => t.title)).toContain("생기부 점검");
    expect(document.activeElement?.id).toBe("bhIn");
  });

  it("설정 출근 시각에 「abc」: 원래 값으로 돌아가고 「예: 08:20」 한 줄, 「8:10」은 08:10으로", async () => {
    const root = await mount();
    root.querySelector<HTMLElement>("[data-settings]")!.click();
    root.querySelector<HTMLElement>("[data-setg=school]")!.click();
    const on = () => root.querySelector<HTMLInputElement>('#bhSettings [data-time="onWork"]')!;
    const was = on().value;
    on().value = "abc";
    on().dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 5; i++) await tick();
    expect(on().value).toBe(was);
    expect(root.querySelector("#bhToast")!.textContent).toContain("예: 08:20");
    on().value = "8:10";
    on().dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 5; i++) await tick();
    expect(app!.state.settings.onWork).toBe("08:10");
    expect(on().value).toBe("08:10");
  });
});

describe("글자 크기 (Mac)", () => {
  it("⌘+ 한 단계씩 크게·끝에서는 멈춤, ⌘- 작게, 설정에 남음", async () => {
    document.body.innerHTML = '<div id="app" style="width:1300px;height:800px"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
    const zooms: number[] = [];
    app = await mountBlackhole(root, { ...memoryAdapter(), setZoom: async (z: number) => void zooms.push(z) }, { now: () => new Date("2026-10-31T10:00:00") });
    const key = (code: string) => document.dispatchEvent(new KeyboardEvent("keydown", { code, metaKey: true, bubbles: true }));
    for (let i = 0; i < 5; i++) key("Equal");
    for (let i = 0; i < 5; i++) await tick();
    expect(app.state.settings.textSize).toBe(150);
    expect(root.querySelector("#bhToast")!.textContent).toContain("이미 가장 큰 글자");
    key("Minus");
    await tick();
    expect(app.state.settings.textSize).toBe(130);
    expect(zooms.at(-1)).toBe(1.3);
  });
});

describe("자료 지키기", () => {
  it("읽기 실패: 빈 화면으로 열려도 원래 파일 위에 저장하지 않고, 대화에 한 줄", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    const saved: unknown[] = [];
    app = await mountBlackhole(root, { ...memoryAdapter(), load: async () => { throw new Error("Operation not permitted (os error 1)"); }, save: async (x) => void saved.push(x) }, { now: () => new Date("2026-11-01T10:00:00") });
    await app.submitText("내일 3시 치과");
    expect(saved).toHaveLength(0);
    expect(app.state.chat[0].text).toContain("저장하지 않아요");
  });

  it("깨진 파일을 백업으로 되살렸으면: 대화에 몇 월 며칠 백업인지, 되살린 자료는 저장", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    const saved: { restoredFrom?: string }[] = [];
    const raw = { schemaVersion: 1, restoredFrom: "달력-2026-10-31.json", tasks: [] };
    app = await mountBlackhole(root, { ...memoryAdapter(), load: async () => raw, save: async (x) => void saved.push(x as never) }, { now: () => new Date("2026-11-01T10:00:00") });
    await tick();
    expect(app.state.chat[0].text).toContain("10/31 백업으로 되살렸어요");
    expect(saved.length).toBeGreaterThan(0);
    expect(saved[0].restoredFrom).toBeUndefined();
  });

  it("저장 실패는 말없이 넘어가지 않음", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    app = await mountBlackhole(root, { ...memoryAdapter(), save: async () => { throw new Error("No space left on device (os error 28)"); } }, { now: () => new Date("2026-11-01T10:00:00") });
    await app.submitText("내일 3시 치과");
    expect(root.querySelector("#bhToast")!.textContent).toContain("디스크 공간이 부족함");
  });
});

describe("키보드만으로", () => {
  it("할 일 줄은 Tab으로 갈 수 있고 Enter로 상세 창이 열리며 커서가 창 안으로", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
    app = await mountBlackhole(root, memoryAdapter(), { now: () => new Date("2026-11-02T10:00:00") });
    await app.submitText("금요일까지 생기부 점검");
    const row = root.querySelector<HTMLElement>(".tl .task[data-ev]")!;
    expect(row.tabIndex).toBe(0);
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(root.querySelector(".dpanel")!.textContent).toContain("생기부 점검");
    expect(document.activeElement?.closest(".dpanel")).not.toBeNull();
  });
});

describe("결과에 대한 지적 (실제 대화 10/30)", () => {
  it("「일원역 이동이 왜 저렇게 시간으로 들어가」: 질문이 아니라 고칠 목록, 그 카드를 다시 보여 줌", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
    let t = new Date("2026-10-30T09:44:00").getTime();
    app = await mountBlackhole(root, memoryAdapter(), { now: () => new Date(t) });
    await app.submitText("10시 40분에 조퇴라서 11시까지 일원역으로 가야함");
    t += 60_000;
    await app.submitText("일원역 이동이 왜 저렇게 시간으로 들어가");
    expect(app.state.reports).toHaveLength(1);
    expect(app.state.reports[0].want).toContain("왜 저렇게");
    expect(app.state.chat.at(-1)!.text).toMatch(/^고칠 목록에 넣었어요/);
    expect(app.state.chat.at(-1)!.refs!.length).toBeGreaterThan(0);
  });
});

describe("확인할 것: 지난 가승인 한 번에", () => {
  it("2개 이상이면 「모두 있었음」 한 번에 확정, ⌘Z 한 번에 되돌림", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
    const { emptyState } = await import("../src/calendar/model");
    const s = emptyState();
    const ev = (id: string, date: string) => ({ id, kind: "event", title: `수업 ${id}`, area: "school", source: "t", createdAt: "2026-10-27T09:00", date, start: "09:00", end: "09:45", provisional: true, reminders: [] });
    s.events.push(ev("e1", "2026-10-29") as never, ev("e2", "2026-10-30") as never, ev("e3", "2026-11-05") as never);
    const adapter = memoryAdapter();
    await adapter.save(s);
    app = await mountBlackhole(root, adapter, { now: () => new Date("2026-11-01T10:00:00") });
    root.querySelector<HTMLElement>("[data-checks]")!.click();
    await tick();
    root.querySelector<HTMLElement>("[data-acceptpast]")!.click();
    await tick();
    expect(app.state.events.map((e) => e.provisional)).toEqual([false, false, true]);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", key: "z", metaKey: true, bubbles: true }));
    await tick();
    expect(app.state.events.map((e) => e.provisional)).toEqual([true, true, true]);
  });
});

describe("작은 위젯 (밤샘)", () => {
  it("날짜 없는 할 일을 「5일 지남」으로 보여 주지 않음", async () => {
    const { boardHTML } = await import("../src/mac/board");
    const { emptyState } = await import("../src/calendar/model");
    const s = emptyState();
    const task = (id: string, title: string, due: string, x = {}) => ({ id, kind: "task" as const, title, area: "school" as const, source: "t", createdAt: "2026-10-27T09:00", due, dueTime: null, done: false, reminders: [], subs: [], ...x });
    s.tasks.push(task("t1", "진석이에게 10만원 송금", "2026-10-27"), task("t2", "대의원회 준비", "2026-10-28", { noDue: true }));
    const html = boardHTML(s, new Date("2026-11-02T08:30:00"));
    expect(html).toContain("진석이에게 10만원 송금");
    expect(html).not.toContain("대의원회 준비");
  });
});
