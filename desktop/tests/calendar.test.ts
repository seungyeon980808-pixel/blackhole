import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { AnalyzeError, type BlackholeAdapter } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState, normalizeState } from "../src/calendar/model";
import { seedState } from "../src/calendar/samples";
import { answerAlarm, applyProposal, taskGroups, upcomingAlarms, type Alarm } from "../src/calendar/store";
import type { Proposal } from "../src/worker/proposal";

const proposal = sample as unknown as Proposal;
// 2026-10-21 (Wed) 09:00 KST, the sample's reference time; the test runs in the machine's zone,
// so build "now" from the sample's own instants.
const NOW = new Date(proposal.referenceTime);

describe("store", () => {
  it("maps worker items: schedule = 가승인, to-do with subtasks and reminder, period with inclusive end", () => {
    const s = emptyState();
    const out = applyProposal(s, proposal, "데스크톱", NOW);
    expect(out.refs).toHaveLength(proposal.items.length);
    const ev = s.events[0];
    expect(ev.provisional).toBe(true);
    expect(ev.title).toBe("학부모 상담");
    expect(ev.end).not.toBeNull();
    const task = s.tasks[0];
    expect(task.subs.map((x) => x.title)).toEqual(["자료 정리", "소감 작성", "결재"]);
    expect(task.reminders).toHaveLength(1);
    expect(task.dueTime).not.toBeNull();
    const period = s.periods[0];
    expect(period.to > period.from).toBe(true);
    // endAt is exclusive (day after the last), the stored "to" is the last day itself.
    const lastDay = new Date(new Date(proposal.items[2].endAt).getTime() - 864e5);
    expect(period.to.slice(8)).toBe(String(lastDay.getDate()).padStart(2, "0"));
  });

  it("keeps undated schedules as 기억 instead of dropping them", () => {
    const s = emptyState();
    const p = structuredClone(proposal);
    p.items = [{ ...p.items[0], startAt: "", endAt: "", reminders: [], reminderAt: "" }];
    const out = applyProposal(s, p, "데스크톱", NOW);
    expect(out.missing).toEqual(["학부모 상담"]);
    expect(s.notes[0].review?.join()).toContain("날짜를 찾지 못해");
  });

  it("schedules alarms once and supports 10분 뒤 and 완료", () => {
    const s = emptyState();
    applyProposal(s, proposal, "데스크톱", NOW);
    const alarms = upcomingAlarms(s, NOW);
    expect(alarms.length).toBe(2);
    const task = alarms.find((a) => a.kind === "task")!;
    const snoozedAt = answerAlarm(s, task, "snooze", NOW);
    expect(snoozedAt).not.toBeNull();
    expect(upcomingAlarms(s, NOW).some((a) => a.key === task.key)).toBe(false);
    expect(upcomingAlarms(s, NOW).some((a) => a.at === snoozedAt)).toBe(true);
    const again = upcomingAlarms(s, NOW).find((a) => a.at === snoozedAt)!;
    answerAlarm(s, again, "done", NOW);
    expect(s.tasks[0].done).toBe(true);
    expect(s.tasks[0].subs.every((x) => x.done)).toBe(true);
  });

  it("groups tasks like the prototype and hides fake data on request", () => {
    const today = new Date(2026, 9, 25);
    const s = seedState(today);
    const g = taskGroups(s, "2026-10-25");
    expect(g.today.map((t) => t.title)).toContain("관리비 납부");
    expect(g.week.map((t) => t.title)).toContain("공개수업 자료 인쇄");
    expect(g.later.map((t) => t.title)).toContain("자동차 보험 갱신");
    s.settings.showSamples = false;
    expect(taskGroups(s, "2026-10-25").today).toHaveLength(0);
  });

  it("rejects unknown stored state", () => {
    expect(normalizeState({ schemaVersion: 2 })).toBeNull();
    expect(normalizeState({ schemaVersion: 1 })?.settings.theme).toBe("glass");
  });
});

function fakeAdapter(result: Proposal | Error): BlackholeAdapter {
  const base = memoryAdapter();
  return {
    ...base,
    origin: "데스크톱",
    connection: { label: "로컬·미연결", detail: "시험" },
    analyze: async () => {
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

let app: BlackholeApp | null = null;

async function mount(adapter: BlackholeAdapter): Promise<HTMLElement> {
  document.body.innerHTML = '<div id="app" style="width:1200px;height:800px"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  app = await mountBlackhole(root, adapter, { now: () => new Date(NOW) });
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  app?.destroy();
  app = null;
});

describe("calendar app", () => {
  it("shows the local, unconnected state and the day view of the prototype", async () => {
    const root = await mount(fakeAdapter(proposal));
    expect(root.querySelector('[data-testid="connection"]')?.textContent).toBe("로컬·미연결");
    expect(root.querySelector(".tt")).not.toBeNull();
    expect(root.querySelectorAll(".tt .h")).toHaveLength(17);
    expect(root.textContent).toContain("할 일");
    expect(root.textContent).toContain("확인 대기");
    expect(root.querySelector("#bhIn")).not.toBeNull();
  });

  it("puts a sentence through the worker into the calendar with 확정/취소", async () => {
    const root = await mount(fakeAdapter(proposal));
    await app!.submitText("내일 오후 3시에 학부모 상담 있고 금요일 6시까지 연수 보고서 제출: 자료 정리, 소감 작성, 결재");
    const ev = app!.state.events.find((e) => e.title === "학부모 상담" && !e.sample)!;
    expect(ev.provisional).toBe(true);
    expect(root.querySelector("#bhLast")?.textContent).toContain("기간");
    const chat = app!.state.chat.slice(-2);
    expect(chat[0].who).toBe("me");
    expect(chat[1].text).toBe("3건 넣었어요.");
    app!.setView("day", ev.date);
    root.querySelector<HTMLButtonElement>(`[data-ok="${ev.id}"]`)!.click();
    await Promise.resolve();
    expect(app!.state.events.find((e) => e.id === ev.id)!.provisional).toBe(false);
  });

  it("reports worker failures in the chat without adding anything", async () => {
    await mount(fakeAdapter(new AnalyzeError("RUNNER_UNAVAILABLE", "Ollama가 꺼져 있습니다.")));
    const before = app!.state.events.length;
    await app!.submitText("내일 회의");
    expect(app!.state.events.length).toBe(before);
    const last = app!.state.chat[app!.state.chat.length - 1];
    expect(last.error).toBe(true);
    expect(last.text).toContain("Ollama가 꺼져 있습니다.");
  });

  it("renders month on FullCalendar and the 공문서 week table", async () => {
    const root = await mount(fakeAdapter(proposal));
    app!.setView("month");
    expect(root.querySelector(".fc-dayGridMonth-view")).not.toBeNull();
    app!.setTheme("doc");
    app!.setView("week");
    expect(root.querySelector("table.tb.week")).not.toBeNull();
    expect(root.querySelector(".dtitle")?.textContent).toContain("주간 업무 계획");
    app!.setView("day");
    expect(root.querySelectorAll(".sec .no").length).toBeGreaterThanOrEqual(4);
  });

  it("shows the full-window alarm until 완료 or 10분 뒤", async () => {
    const root = await mount(fakeAdapter(proposal));
    await app!.submitText("문장");
    const task = app!.state.tasks.find((t) => !t.sample)!;
    const alarm: Alarm = upcomingAlarms(app!.state, NOW).find((a) => a.ref === task.id)!;
    app!.fireAlarm(alarm);
    const overlay = root.querySelector<HTMLElement>("#bhAlarm")!;
    expect(overlay.classList.contains("on")).toBe(true);
    expect(overlay.textContent).toContain(task.title);
    overlay.querySelector<HTMLButtonElement>('[data-alarm="done"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(overlay.classList.contains("on")).toBe(false);
    expect(app!.state.tasks.find((t) => t.id === task.id)!.done).toBe(true);
  });

  it("builds the A4 print sheet in the official-document format", async () => {
    const root = await mount(fakeAdapter(proposal));
    root.querySelector<HTMLButtonElement>("[data-print]")!.click();
    const sheet = document.querySelector<HTMLElement>("#bhPrint")!;
    expect(sheet.hidden).toBe(false);
    expect(sheet.textContent).toContain("일일 현황");
    expect(sheet.textContent).toContain("메모");
  });

  it("escapes text coming from the worker", async () => {
    const p = structuredClone(proposal);
    p.items = [{ ...p.items[0], title: '<img src=x onerror="alert(1)">' }];
    const root = await mount(fakeAdapter(p));
    await app!.submitText("x");
    app!.setView("day", app!.state.events.find((e) => !e.sample)!.date);
    expect(root.querySelector("img[src=x]")).toBeNull();
    expect(root.textContent).toContain("<img src=x");
  });
});
