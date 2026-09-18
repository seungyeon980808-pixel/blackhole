import { describe, expect, it, vi } from "vitest";
import { mountInboxCapture } from "../src/inbox";
import type { InboxCaptureDependencies } from "../src/inbox";

function connectedDependencies(): InboxCaptureDependencies {
  return {
    status: {
      state: "connected",
      path: "/Users/example/Inbox",
      detail: "Google Drive 동기화 Inbox에 저장합니다."
    },
    capture: vi.fn(async (message: string) => ({ filename: `ya-capture-${message.length}.md` }))
  };
}

function addMessage(host: HTMLElement, message: string): void {
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  const form = host.querySelector<HTMLFormElement>("form");
  if (!input || !form) throw new Error("capture form is missing");
  input.value = message;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("Ya Inbox capture", () => {
  it("queues chat-like memories and writes them only on sync", async () => {
    const dependencies = connectedDependencies();
    const host = document.createElement("section");
    mountInboxCapture(host, dependencies);

    addMessage(host, "첫 번째 기억");
    addMessage(host, "두 번째 기억");

    expect(dependencies.capture).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[data-message-status="pending"]')).toHaveLength(2);

    const sync = host.querySelector<HTMLButtonElement>('[data-action="sync"]');
    if (!sync) throw new Error("sync button is missing");
    sync.click();

    await vi.waitFor(() => expect(dependencies.capture).toHaveBeenCalledTimes(2));
    expect(dependencies.capture).toHaveBeenNthCalledWith(1, "첫 번째 기억");
    expect(dependencies.capture).toHaveBeenNthCalledWith(2, "두 번째 기억");
    expect(host.querySelectorAll('[data-message-status="synced"]')).toHaveLength(2);
    expect(sync.disabled).toBe(true);
  });

  it("keeps a failed memory available for a later sync", async () => {
    let attempts = 0;
    const dependencies: InboxCaptureDependencies = {
      status: {
        state: "connected",
        path: "/Users/example/Inbox",
        detail: "Google Drive 동기화 Inbox에 저장합니다."
      },
      capture: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Drive가 준비되지 않았습니다.");
        return { filename: "ya-capture-retry.md" };
      })
    };
    const host = document.createElement("section");
    mountInboxCapture(host, dependencies);
    addMessage(host, "나중에 다시 보낼 기억");

    const sync = host.querySelector<HTMLButtonElement>('[data-action="sync"]');
    if (!sync) throw new Error("sync button is missing");
    sync.click();
    await vi.waitFor(() => expect(host.querySelector('[data-message-status="error"]')).not.toBeNull());
    expect(sync.disabled).toBe(false);

    sync.click();
    await vi.waitFor(() => expect(host.querySelector('[data-message-status="synced"]')).not.toBeNull());
  });

  it("keeps capture controls disabled when the Inbox is unavailable", () => {
    const host = document.createElement("section");
    mountInboxCapture(host, {
      status: { state: "unavailable", path: null, detail: "Inbox를 찾을 수 없습니다." },
      capture: vi.fn()
    });
    expect(host.querySelector<HTMLButtonElement>('[data-action="add"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-action="sync"]')?.disabled).toBe(true);
    expect(host.textContent).toContain("Inbox를 찾을 수 없습니다.");
  });
});
