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
  const calls = { texts: [] as string[], actions: [] as UserAction[], alarms: "", saved: "" };
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
    syncStatus: () => "마지막 받음 09:00"
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
    document.querySelector<HTMLButtonElement>(`[data-ok="${ev.id}"]`)!.click();
    expect(fake.calls.actions.map((a) => a.type)).toEqual(["confirm"]);
    expect(app!.state.events[0].provisional).toBe(false);
    // The Mac applies the phone's action from its inbox file, once.
    const mac = macCopy().s;
    expect(applyAction(mac, fake.calls.actions[0], NOW)).toBe(true);
    expect(applyAction(mac, fake.calls.actions[0], NOW)).toBe(false);
    expect(mac.events[0].provisional).toBe(false);
  });

  it("hands alarms to the native phone-call alarm", async () => {
    const fake = await mountPhone(macCopy().json);
    const list = JSON.parse(fake.calls.alarms) as { key: string; atMs: number }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((a) => typeof a.atMs === "number" && a.key.includes("@"))).toBe(true);
  });
});
