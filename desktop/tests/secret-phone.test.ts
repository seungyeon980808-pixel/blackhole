/** 휴대폰에는 키체인이 없다: 비밀 같은 문장은 보내지 않는다(Mac secret.rs와 같은 기준). */
import { afterEach, describe, expect, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { emptyState } from "../src/calendar/model";
import { looksSecret } from "../src/calendar/secret";

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
});

describe("secrets on the phone", () => {
  it("the same judgment as the Mac", () => {
    for (const v of ["현관 비밀번호 4821", "지마켓 비번 Abc!2345", "카드번호 1234-5678-9012-3456", "주민번호 900101-1234567", "계좌 110-123-456789", "와이파이 비밀번호는 qwer5678"]) expect(looksSecret(v), v).toBe(true);
    for (const v of ["내일 3시 치과", "지마켓 비번 바꾸기", "카드 결제일 25일", "010-1234-5678 학부모 연락처", "비번 바꾸기 12월 3일까지", "15:30 회의"]) expect(looksSecret(v), v).toBe(false);
  });

  it("is not sent: nothing in the chat, the calendar or the inbox; the text stays in the box", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    const sent: string[] = [];
    app = await mountBlackhole(root, { ...memoryAdapter(), origin: "휴대폰", load: async () => emptyState(), analyze: async (i) => { sent.push(i.text ?? ""); throw new Error("no"); } }, { now: () => new Date(2026, 9, 27, 10, 40), seed: false });
    await app.submitText("현관 비밀번호 4821");
    expect(sent).toEqual([]);
    expect(app.state.chat).toHaveLength(0);
    expect(app.state.notes.length + app.state.tasks.length + app.state.events.length).toBe(0);
    expect(root.querySelector<HTMLInputElement>("#bhIn")!.value).toBe("현관 비밀번호 4821");
  });
});
