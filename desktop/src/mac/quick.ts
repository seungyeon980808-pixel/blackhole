/**
 * Quick-input window (⌥⌘K anywhere): one line, Enter puts it in. A pasted picture (⌘V) or a
 * dropped file goes in as is; 캡처 picks part of the screen. Everything lands in the main page
 * through the Rust side (same path as the clipboard and the Dock).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export function mountQuick(root: HTMLElement): void {
  document.documentElement.classList.add("bhw-quick");
  root.innerHTML = `<form class="q" autocomplete="off">
    <input id="q" aria-label="블랙홀에 넣을 말" placeholder="블랙홀에 넣기 — 「내일 3시 치과」, 링크, ⌘V로 사진">
    <div class="qbar"><span class="qmsg" id="qmsg">Enter 넣기 · Esc 닫기 · 파일은 끌어 놓기</span><button type="button" data-a="capture">화면 캡처</button><button type="button" data-a="clipboard">클립보드</button></div>
  </form>`;
  const input = root.querySelector<HTMLInputElement>("#q")!;
  const msg = root.querySelector<HTMLElement>("#qmsg")!;
  const say = (t: string) => (msg.textContent = t);
  const focus = () => {
    input.focus();
    input.select();
  };
  focus();
  void listen("bh-quick-open", () => {
    say("Enter 넣기 · Esc 닫기 · 파일은 끌어 놓기");
    focus();
  });
  window.addEventListener("focus", focus);

  root.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void invoke("quick_put_text", { text, via: "빠른 입력" });
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void invoke("quick_hide");
  });
  root.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a) void invoke("quick_action", { action: a });
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    say("넣는 중…");
    for (const f of files) {
      const name = f.name && f.name !== "image.png" ? f.name : `붙여넣기.${(f.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
      void f.arrayBuffer().then((buf) =>
        invoke("quick_put_bytes", new Uint8Array(buf), { headers: { "x-file-name": encodeURIComponent(name), "x-via": encodeURIComponent("빠른 입력") } })
      ).catch((err: unknown) => say(String(err)));
    }
  });
  void getCurrentWebviewWindow().onDragDropEvent((e) => {
    if (e.payload.type !== "drop") return;
    for (const path of e.payload.paths) void invoke("quick_put_path", { path, via: "빠른 입력" });
    void invoke("quick_hide");
  });
}
