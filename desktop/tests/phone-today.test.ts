/** 휴대폰 「오늘」(시안 가): 지금·다음 → 할 일 → 오늘 일정 → 주요 일정, 같은 일정 두 번은 한 줄 ×2. */
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState } from "../src/calendar/model";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  document.documentElement.classList.remove("phone");
});

describe("phone 오늘", () => {
  it("cards in order; a duplicate shows once with ×2; the day table opens on request", async () => {
    document.documentElement.classList.add("phone");
    const s = emptyState();
    const b = { area: "school" as const, source: "t", createdAt: "2026-10-20T08:00" };
    s.events.push({ ...b, id: "e1", kind: "event", title: "초과근무", date: "2026-10-27", start: null, end: null, provisional: false, reminders: [] });
    s.events.push({ ...b, id: "e2", kind: "event", title: "초과근무", date: "2026-10-27", start: null, end: null, provisional: false, reminders: [] });
    s.events.push({ ...b, id: "e3", kind: "event", title: "학년 협의회", date: "2026-10-27", start: "11:00", end: "12:00", provisional: false, reminders: [] });
    s.tasks.push({ ...b, id: "t1", kind: "task", title: "출석부 정리", due: "2026-10-27", dueTime: "15:00", done: false, reminders: [], subs: [] });
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    app = await mountBlackhole(root, { ...memoryAdapter(), origin: "휴대폰", load: async () => s }, { now: () => new Date(2026, 9, 27, 10, 40), seed: false });
    app.setView("day", "2026-10-27");
    const titles = [...root.querySelectorAll(".phv .pch")].map((x) => x.textContent!.replace(/[☑▦★\d]|남음/g, "").trim());
    expect(titles).toEqual(["할 일", "오늘 일정"]);
    expect(root.querySelector(".phv .pnt")!.textContent).toContain("11:00 학년 협의회");
    const rows = [...root.querySelectorAll(".phv .pcard:nth-of-type(3) .prow .tn")].map((x) => x.textContent);
    expect(rows.filter((x) => x!.startsWith("초과근무"))).toEqual(["초과근무 ×2"]);
    expect(root.querySelector(".phv .tdv.phtable")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-fold="phtable"]')!.click();
    expect(root.querySelector(".phv .tdv.phtable .dtg")).not.toBeNull();
  });
});
