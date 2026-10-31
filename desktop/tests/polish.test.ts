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
