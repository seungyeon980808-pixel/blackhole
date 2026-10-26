/**
 * Quick window (right ⌘ twice, ⌃⌥⌘Space, the menu-bar icon): one line to put in, search and ask.
 *
 * - typing searches this Mac's entries and secret names at once (no API, no cost)
 * - Enter: put it in (rule draft, then the AI if needed) · with a result chosen: open it
 * - ⌘Enter: keep as 기억 as typed · ⇧Enter: ask about my own records (one small AI call)
 * - ⌘C on a result: copy (a secret asks for Touch ID and leaves the clipboard after 30 s)
 * - ⌘V a picture, drop a file, 화면 캡처 · 클립보드 buttons
 * A sentence that looks like a password is asked about first and then kept in the keychain only.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

interface Hit {
  id: string;
  kind: string;
  title: string;
  sub: string;
}

type Intake = "put" | "secret" | "ask";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const HINT = "Enter 넣기 · ⌘Enter 기억 · ⇧Enter 묻기 · ↑↓ 고르기 · Esc 닫기";

export function mountQuick(root: HTMLElement): void {
  document.documentElement.classList.add("bhw-quick");
  root.innerHTML = `<form class="q" autocomplete="off">
    <input id="q" aria-label="넣기·찾기·묻기" placeholder="넣기·찾기 — 「내일 3시 치과」, 「지마켓」, 링크, ⌘V 사진">
    <div class="qlist" id="qlist" role="listbox" aria-label="결과"></div>
    <div class="qbar"><span class="qmsg" id="qmsg" role="status">${HINT}</span><button type="button" data-a="capture">화면 캡처</button><button type="button" data-a="clipboard">클립보드</button></div>
  </form>`;
  const input = root.querySelector<HTMLInputElement>("#q")!;
  const list = root.querySelector<HTMLElement>("#qlist")!;
  const msg = root.querySelector<HTMLElement>("#qmsg")!;
  let hits: Hit[] = [];
  let sel = -1;
  let heading = "";
  let pending: { text: string; memo: boolean } | null = null;
  let seq = 0;

  const say = (t: string, warn = false) => {
    msg.textContent = t;
    msg.classList.toggle("warn", warn);
  };
  const draw = () => {
    if (pending) {
      list.innerHTML = `<div class="qask">비밀번호 같아요. 이 Mac 키체인에만 둘까요? (드라이브·AI로 보내지 않음)<div><button type="button" data-secret="yes">비밀로 저장</button><button type="button" data-secret="no">그냥 넣기</button></div></div>`;
      return;
    }
    list.innerHTML = (heading ? `<div class="qh">${esc(heading)}</div>` : "") + hits.map((h, i) =>
      `<div class="qi ${i === sel ? "on" : ""} ${h.kind === "비밀" ? "secret" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}"><span class="qk">${esc(h.kind)}</span><span class="qt">${esc(h.title)}</span><span class="qs">${esc(h.sub)}</span></div>`
    ).join("");
  };
  const showToday = async () => {
    hits = await invoke<Hit[]>("quick_today").catch(() => []);
    heading = hits.length ? "오늘" : "";
    sel = -1;
    draw();
  };
  const search = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) return showToday();
    const found = await invoke<Hit[]>("quick_search", { query: q }).catch(() => []);
    if (mine !== seq) return;
    hits = found;
    heading = found.length ? "찾음" : "";
    sel = -1;
    draw();
  };
  const reset = () => {
    pending = null;
    input.value = "";
    say(HINT);
    void showToday();
  };
  const focus = () => {
    input.focus();
    input.select();
  };

  void listen<string>("bh-quick-open", (e) => {
    pending = null;
    say(HINT);
    if (e.payload) {
      input.value = e.payload;
      void search();
    } else if (!input.value) void showToday();
    focus();
  });
  window.addEventListener("focus", focus);
  void invoke<string>("quick_query_take").then((q) => {
    if (q) input.value = q;
    void search();
  });
  focus();
  input.addEventListener("input", () => void search());

  const put = async (memo: boolean, secret?: boolean) => {
    const text = (pending?.text ?? input.value).trim();
    if (!text) return;
    say("넣는 중…");
    try {
      const r = await invoke<Intake>(memo ? "quick_memo" : "quick_put_text", { text, via: "빠른 입력", secret });
      if (r === "ask") {
        pending = { text, memo };
        say("비밀로 저장할까요?");
        draw();
        return;
      }
      reset();
    } catch (err) {
      say(`넣지 못했어요: ${String(err)}`, true);
    }
  };
  const ask = async () => {
    const question = input.value.trim();
    if (!question) return;
    say("내 기록에서 찾는 중… (AI 한 번)");
    try {
      const a = await invoke<{ answer: string; hits: Hit[] }>("quick_ask", { question });
      hits = a.hits;
      heading = a.answer;
      sel = -1;
      draw();
      say("답은 내 기록에서만 찾았어요 · 항목을 고르면 열립니다");
    } catch (err) {
      say(`묻지 못했어요: ${String(err)}`, true);
    }
  };
  const openHit = async (h: Hit) => {
    if (h.kind === "비밀") return copyHit(h);
    await invoke("quick_open", { id: h.id });
  };
  const copyHit = async (h: Hit) => {
    if (h.kind === "비밀") {
      say("Touch ID로 확인해 주세요…");
      try {
        await invoke("secret_copy", { name: h.id.replace(/^secret:/, "") });
        say("복사했어요 · 30초 뒤 클립보드에서 지웁니다");
      } catch (err) {
        say(String(err), true);
      }
      return;
    }
    await navigator.clipboard.writeText(h.sub ? `${h.title} (${h.sub})` : h.title).then(() => say("복사했어요"), () => say("복사하지 못했어요", true));
  };

  root.querySelector("form")!.addEventListener("submit", (e) => e.preventDefault());
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!hits.length) return;
      sel = e.key === "ArrowDown" ? (sel + 1) % hits.length : (sel <= 0 ? hits.length : sel) - 1;
      draw();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) return void ask();
      if (e.metaKey) return void put(true);
      if (sel >= 0 && hits[sel]) return void openHit(hits[sel]);
      return void put(false);
    }
    // ⌘C with a result chosen and no text selected in the box: copy the result.
    if (e.metaKey && e.code === "KeyC" && sel >= 0 && hits[sel] && input.selectionStart === input.selectionEnd) {
      e.preventDefault();
      void copyHit(hits[sel]);
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (pending) {
      pending = null;
      say(HINT);
      draw();
      return;
    }
    void invoke("quick_hide");
  });
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a) return void invoke("quick_action", { action: a });
    const s = t.closest<HTMLElement>("[data-secret]")?.dataset.secret;
    if (s && pending) return void put(pending.memo, s === "yes");
    const i = t.closest<HTMLElement>("[data-i]")?.dataset.i;
    if (i !== undefined && hits[Number(i)]) void openHit(hits[Number(i)]);
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
      ).then(reset, (err: unknown) => say(`넣지 못했어요: ${String(err)}`, true));
    }
  });
  void getCurrentWebviewWindow().onDragDropEvent((e) => {
    if (e.payload.type !== "drop") return;
    for (const path of e.payload.paths) void invoke("quick_put_path", { path, via: "빠른 입력" });
    void invoke("quick_hide");
  });
}
