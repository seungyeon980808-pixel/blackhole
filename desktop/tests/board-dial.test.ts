/**
 * 위젯 타이머 다이얼 (2026-10-28 밤샘): 돌리는 중에 입력이 취소되면(창이 초점을 잃음) 「돌리는 중」이 풀리지 않아
 * 위젯이 다시 그려지지 않았다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedState } from "../src/calendar/samples";

const NOW = new Date(2026, 9, 28, 9, 0);
let state: unknown = null;
const events: Record<string, () => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "load_calendar_state" ? state : cmd === "desk_status" ? { settings: { boardSize: "large" } } : null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, f: () => void) => ((events[name] = f), () => undefined)) }));

describe("board dial", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state = seedState(NOW);
    document.body.innerHTML = '<div id="b"></div>';
  });
  afterEach(() => vi.useRealTimers());

  it("redraws again after a cancelled turn", async () => {
    const { mountBoard } = await import("../src/mac/board");
    const root = document.getElementById("b")!;
    mountBoard(root);
    await vi.waitFor(() => expect(root.querySelector("[data-dial]")).not.toBeNull());
    const dial = root.querySelector<HTMLElement>("[data-dial]")!;
    dial.setPointerCapture = () => undefined;
    dial.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    dial.dispatchEvent(new Event("pointercancel"));
    // A new entry on the main page: the widget shows it.
    (state as { tasks: { title: string }[] }).tasks[0].title = "다시 그려졌는지 확인";
    events["bh-board-refresh"]();
    await vi.waitFor(() => expect(root.textContent).toContain("다시 그려졌는지 확인"));
  });
});
