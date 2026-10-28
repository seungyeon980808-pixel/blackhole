// The owner's sentences typed into the whole app (mounted, as on the Mac): every shortcut it takes
// (move by rules, 기억 at once, AI skipped, AI refine) must end where the owner meant. Recorded AI
// answers stand in for the API (scripts/style-record.mjs).
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { ClaudeStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import type { CalEvent, Task } from "../src/calendar/model";
import type { Proposal } from "../src/worker/proposal";

const dir = join(__dirname, "fixtures");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const set = read("style-cases-2.json");
const rec = read("style-proposals-2.json") as Record<string, { proposal: Proposal }>;
const NOW = new Date(set.now);
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 3, skipSimple: true };
let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

async function typed(id: string) {
  const c = set.cases.find((x: { id: string }) => x.id === id);
  let asked = 0;
  let sent = "";
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
  const adapter = { ...memoryAdapter(), origin: "데스크톱", claude: async () => claude, analyze: async (input: { text?: string }) => (asked++, (sent = input.text ?? ""), rec[id].proposal), aiSkipped: () => undefined, writeMemo: async () => undefined };
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW), seed: false });
  const s = app.state;
  for (const e of set.fixture.events) s.events.push({ area: "school", ...e, kind: "event", source: "데스크톱", createdAt: "2026-10-27T09:00", provisional: false, reminders: [] } as CalEvent);
  for (const t of set.fixture.tasks) s.tasks.push({ ...t, kind: "task", area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", dueTime: null, done: false, reminders: [], subs: [] } as Task);
  await app.submitText(c.text);
  const live = [...s.events, ...s.tasks, ...s.periods, ...s.notes].filter((x) => !x.gone);
  // The AI reads the words as said (not 「15:00~16:00로 바뀜」).
  if (asked) expect(sent).toBe(c.text);
  return { s, asked, made: live.filter((x) => !String(x.id).includes("fx")), get: (id: string) => [...s.events, ...s.tasks].find((x) => x.id === id)! };
}

describe("typed into the app", () => {
  it("「치과 금요일 3시에서 4시로 바뀜」 moves the 치과, nothing new", async () => {
    const r = await typed("x2");
    expect((r.get("e-fx3") as CalEvent).start).toBe("16:00");
    expect(r.made).toEqual([]);
  });
  it("「학부모 상담 5시로 변경」 moves it", async () => {
    const r = await typed("x3");
    expect((r.get("e-fx6") as CalEvent).start).toBe("17:00");
    expect(r.made).toEqual([]);
  });
  it("「내일 학부모 상담 안 하기로 함」 cancels it", async () => {
    const r = await typed("x7");
    expect(r.get("e-fx6").gone).toBe(true);
    expect(r.made).toEqual([]);
  });
  it("「출장 신청 완료」 checks the to-do", async () => {
    const r = await typed("f1");
    expect((r.get("t-fx7") as Task).done).toBe(true);
  });
  it("「교장선생님 결재 나면 체험학습 안내문 발송」 is a to-do waiting, not a 기억", async () => {
    const r = await typed("c1");
    expect(r.asked).toBe(1);
    expect(r.made.map((x) => [x.kind, (x as Task).wait ?? ""])).toEqual([["task", expect.stringContaining("교장")]]);
  });
  it("「3반 반장 김도현 부반장 이서윤」 stays a 기억 without the AI", async () => {
    const r = await typed("i1");
    expect(r.asked).toBe(0);
    expect(r.made.map((x) => x.kind)).toEqual(["note"]);
  });
  it("「ㅋㅋㅋ」 makes nothing", async () => {
    const r = await typed("g2");
    expect(r.asked).toBe(0);
    expect(r.made).toEqual([]);
  });
});
