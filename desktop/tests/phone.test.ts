import { afterEach, describe, expect, it } from "vitest";
import sample from "./fixtures/proposal-sample.json";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { emptyState, sharedFrom, type UserAction } from "../src/calendar/model";
import { applyAction, applyProposal } from "../src/calendar/store";
import { androidAdapter, type AndroidBridge } from "../src/phone/android-adapter";
import type { Proposal } from "../src/worker/proposal";

const NOW = new Date((sample as unknown as Proposal).referenceTime);

/** The Mac's state, shared as 「달력.json」. */
function macCopy() {
  const s = emptyState();
  applyProposal(s, sample as unknown as Proposal, "데스크톱", NOW);
  return { s, json: JSON.stringify(sharedFrom(s, "2026-10-21T09:00")) };
}

function fakeBridge(shared: string) {
  const calls = { texts: [] as string[], actions: [] as UserAction[], alarms: "", saved: "", gcal: [] as { enabled: boolean; provisional: string; main: string }[] };
  const bridge: AndroidBridge = {
    loadState: () => calls.saved,
    saveState: (j) => void (calls.saved = j),
    sendText: (t) => {
      calls.texts.push(t);
      return JSON.stringify({ ok: true, message: "" });
    },
    sendFile: () => JSON.stringify({ ok: false, message: "200MB보다 큰 파일은 보낼 수 없습니다" }),
    scheduleAlarms: (j) => void (calls.alarms = j),
    sharedCopy: () => shared,
    refreshShared: () => undefined,
    recordAction: (j) => void calls.actions.push(JSON.parse(j)),
    pendingActions: () => JSON.stringify(calls.actions),
    syncStatus: () => "마지막 받음 09:00",
    // Like the Android side: the choice is stored and read back.
    googleCalendars: () => JSON.stringify({ permission: true, ...(calls.gcal.at(-1) ?? { enabled: false, provisional: "", main: "" }), status: "", calendars: [{ id: "7", name: "블랙홀 가승인" }, { id: "9", name: "내 캘린더" }] }),
    setGoogleCalendars: (enabled, provisional, main) => void calls.gcal.push({ enabled, provisional, main })
  };
  return { bridge, calls };
}

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});

async function mountPhone(shared: string) {
  document.body.innerHTML = '<div id="app"></div>';
  const fake = fakeBridge(shared);
  app = await mountBlackhole(document.querySelector<HTMLElement>("#app")!, androidAdapter(fake.bridge), { now: () => new Date(NOW), seed: false });
  await new Promise((r) => setTimeout(r, 0));
  return fake;
}

describe("phone calendar (Android WebView adapter)", () => {
  it("never shares the Mac's fake sample data", async () => {
    const { seedState } = await import("../src/calendar/samples");
    const shared = sharedFrom(seedState(new Date(2026, 9, 25)), "x");
    expect(shared.events.length + shared.tasks.length + shared.periods.length).toBe(0);
  });

  it("shows the Mac's shared copy, no fake data", async () => {
    const { s } = macCopy();
    await mountPhone(macCopy().json);
    expect(app!.state.events.map((e) => e.title)).toEqual(s.events.map((e) => e.title));
    expect(app!.state.events.some((e) => e.sample)).toBe(false);
    expect(document.querySelector('[data-testid="connection"]')?.textContent).toBe("Mac 사본");
  });

  it("sends input to the Mac instead of analyzing, without an error", async () => {
    const fake = await mountPhone("");
    await app!.submitText("내일 3시 회의");
    expect(fake.calls.texts).toEqual(["내일 3시 회의"]);
    const last = app!.state.chat[app!.state.chat.length - 1];
    expect(last.error).toBeUndefined();
    expect(last.text).toContain("Mac이 정리하면");
    await app!.submitFile("큰파일.pdf", new Uint8Array([1]));
    expect(app!.state.chat[app!.state.chat.length - 1].error).toBe(true);
  });

  it("records hand-made changes for the Mac and replays them on a newer copy", async () => {
    const fake = await mountPhone(macCopy().json);
    const ev = app!.state.events[0];
    app!.setView("day", ev.date);
    document.querySelector<HTMLButtonElement>("[data-checks]")!.click();
    document.querySelector<HTMLButtonElement>(`[data-accept="${ev.id}"]`)!.click();
    expect(fake.calls.actions.map((a) => a.type)).toEqual(["confirm"]);
    expect(app!.state.events[0].provisional).toBe(false);
    // The Mac applies the phone's action from its inbox file, once.
    const mac = macCopy().s;
    expect(applyAction(mac, fake.calls.actions[0], NOW)).toBe(true);
    expect(applyAction(mac, fake.calls.actions[0], NOW)).toBe(false);
    expect(mac.events[0].provisional).toBe(false);
  });

  it("완료·지우기 show 「되돌리기」, and undoing sends the opposite change to the Mac", async () => {
    const { s: mac, json } = macCopy();
    const fake = await mountPhone(json);
    const task = app!.state.tasks.find((t) => !t.gone && !t.done)!;
    app!.setView("day", task.due);
    document.querySelector<HTMLElement>(`[data-tdone="${task.id}"]`)!.click();
    await new Promise((r) => setTimeout(r, 0));
    const toast = document.querySelector<HTMLElement>("#bhToast")!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe(`완료: 「${task.title}」되돌리기`);
    toast.querySelector<HTMLElement>("[data-undo]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app!.state.tasks.find((t) => t.id === task.id)!.done).toBe(false);
    expect(fake.calls.actions.map((a) => a.type)).toEqual(["toggleTask", "toggleTask"]);

    const ev = app!.state.events.find((e) => e.provisional && !e.gone)!;
    app!.setView("day", ev.date);
    if (!document.querySelector(".checks .rc")) document.querySelector<HTMLButtonElement>("[data-checks]")!.click();
    document.querySelector<HTMLElement>(`.checks [data-no="${ev.id}"]`)!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app!.state.events.find((e) => e.id === ev.id)!.gone).toBe(true);
    expect(toast.textContent).toContain("취소했어요");
    toast.querySelector<HTMLElement>("[data-undo]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const back = app!.state.events.find((e) => e.id === ev.id)!;
    expect(back.gone).toBeUndefined();
    expect(back.provisional).toBe(true);
    expect(fake.calls.actions.map((a) => a.type)).toEqual(["toggleTask", "toggleTask", "cancel", "restore"]);
    // The Mac replays the same four: nothing changed in the end.
    for (const a of fake.calls.actions) applyAction(mac, a, NOW);
    expect(mac.tasks.find((t) => t.id === task.id)!.done).toBe(false);
    const macEv = mac.events.find((e) => e.id === ev.id)!;
    expect(macEv.gone).toBeUndefined();
    expect(macEv.provisional).toBe(true);
  });

  it("hands alarms to the native phone-call alarm", async () => {
    const fake = await mountPhone(macCopy().json);
    const list = JSON.parse(fake.calls.alarms) as { key: string; atMs: number }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((a) => typeof a.atMs === "number" && a.key.includes("@"))).toBe(true);
  });
});

describe("stage 4 on the phone", () => {
  it("never turns on mirroring without two different calendars", async () => {
    const fake = await mountPhone(macCopy().json);
    document.querySelector<HTMLButtonElement>("[data-settings]")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const set = (name: string, value: string | boolean) => {
      const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-gcal="${name}"]`)!;
      if (typeof value === "boolean") (el as HTMLInputElement).checked = value;
      else el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return new Promise((r) => setTimeout(r, 0));
    };
    await set("enabled", true);
    expect(fake.calls.gcal.at(-1)).toEqual({ enabled: false, provisional: "", main: "" });
    await set("provisional", "7");
    await set("main", "9");
    await set("enabled", true);
    expect(fake.calls.gcal.at(-1)).toEqual({ enabled: true, provisional: "7", main: "9" });
  });
});
