import { beforeEach, describe, expect, it } from "vitest";
import { fixtureItems } from "../src/fixtures";
import { createApp } from "../src/ui";
import type { ConnectionStatus } from "../src/domain";

const connection: ConnectionStatus = {
  state: "unconfigured",
  label: "Google 미연결",
  detail: "테스트용 로컬 상태",
  configured: false,
  canWrite: false,
  lastSyncAt: null
};

function setup(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app")!;
  createApp(root, fixtureItems, connection);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Blackhole approval desk", () => {
  it("renders the local preview and all three artificial items", () => {
    const root = setup();
    expect(root.querySelector('[data-testid="preview-banner"]')?.textContent).toContain("로컬 미리보기");
    expect(root.querySelector('[data-testid="preview-banner"]')?.textContent).toContain("Google 미연결");
    expect(root.querySelectorAll("[data-item-id]")).toHaveLength(3);
    expect(root.textContent).toContain("[가상] 연구실 안전 교육");
  });

  it("renders the document-tray hierarchy without decorative dashboard copy", () => {
    const root = setup();
    expect(root.querySelector(".sidebar")).not.toBeNull();
    expect(root.querySelector(".inbox")).not.toBeNull();
    expect(root.querySelector(".detail")).not.toBeNull();
    expect(root.querySelector(".queue-item.is-selected")?.textContent).toContain("연구실 안전 교육");
    expect(root.textContent).not.toContain("VOICE APPROVAL DESK");
    expect(root.textContent).not.toContain("YA DESKTOP");
  });

  it("filters the list by status", () => {
    const root = setup();
    root.querySelector<HTMLButtonElement>('[data-filter="APPROVED"]')!.click();
    expect(root.querySelectorAll("[data-item-id]")).toHaveLength(1);
    expect(root.querySelector('[data-testid="item-list"]')?.textContent).toContain("승인됨");
    expect(root.querySelector('[data-testid="item-list"]')?.textContent).not.toContain("우산 수선");
  });

  it("changes the detail selection from the item list", () => {
    const root = setup();
    root.querySelector<HTMLButtonElement>('[data-item-id="fixture-task-002"]')!.click();
    expect(root.querySelector("#detail-title")?.textContent).toBe("[가상] 우산 수선 맡기기");
    expect(root.querySelector('[data-item-id="fixture-task-002"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps calendar and every write action disabled with a truthful reason", () => {
    const root = setup();
    const status = root.querySelector('[data-testid="write-disabled-status"]');
    expect(status?.textContent).toContain("Google 연결과 안전한 승인 동기화가 아직 구성되지 않아");
    expect(root.querySelector<HTMLSelectElement>('[data-testid="calendar-control"]')?.disabled).toBe(true);
    const actionButtons = Array.from(root.querySelectorAll<HTMLButtonElement>(".actions button"));
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect(actionButtons.every((button) => button.title.includes("아직 구성되지 않아"))).toBe(true);
  });
});
