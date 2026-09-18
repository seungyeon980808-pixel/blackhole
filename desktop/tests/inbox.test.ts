import { describe, expect, it, vi } from "vitest";
import { mountInboxCapture } from "../src/inbox";
import type { InboxCaptureDependencies } from "../src/inbox";

const connected: InboxCaptureDependencies = {
  status: {
    state: "connected",
    path: "/Users/example/Inbox",
    detail: "Google Drive 동기화 Inbox에 저장합니다."
  },
  capture: vi.fn(async () => ({ filename: "ya-capture-test.md" }))
};

describe("Ya Inbox capture", () => {
  it("stores a chat-like message through the configured Inbox", async () => {
    const host = document.createElement("section");
    mountInboxCapture(host, connected);
    const input = host.querySelector<HTMLTextAreaElement>("textarea");
    const form = host.querySelector("form");
    if (!input || !form) throw new Error("capture form is missing");
    input.value = "오늘 회의에서 다음 주까지 초안을 만들기로 했다.";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(connected.capture).toHaveBeenCalledWith(input.value));
    expect(host.textContent).toContain("ya-capture-test.md");
  });

  it("keeps capture disabled when the Inbox is unavailable", () => {
    const host = document.createElement("section");
    mountInboxCapture(host, {
      status: { state: "unavailable", path: null, detail: "Inbox를 찾을 수 없습니다." },
      capture: vi.fn()
    });
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(host.textContent).toContain("Inbox를 찾을 수 없습니다.");
  });
});
