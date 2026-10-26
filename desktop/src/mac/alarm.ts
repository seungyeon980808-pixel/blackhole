/**
 * Full-screen alarm window: above every Space and full-screen app, rings until answered.
 * 확인 · 완료(할 일) · 10분 뒤. Several alarms queue; missed ones (app was off) show once.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Spec {
  key: string;
  title: string;
  body: string;
  kind: string;
  at: string;
  missed: boolean;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function mountAlarm(root: HTMLElement): void {
  document.documentElement.classList.add("bhw-alarm");
  const draw = async () => {
    const list = await invoke<Spec[]>("alarm_current").catch(() => [] as Spec[]);
    const a = list[0];
    if (!a) {
      root.innerHTML = "";
      return;
    }
    const task = a.kind === "task";
    const more = list.length > 1 ? `<div class="am">알람 ${list.length - 1}개 더</div>` : "";
    root.innerHTML = `<div class="al" role="alertdialog" aria-labelledby="t">
      <div class="ak">${a.missed ? "놓친 알람" : task ? "할 일" : "일정"} · ${esc(a.at.slice(11, 16))}</div>
      <div class="at" id="t">${esc(a.title)}</div>
      ${a.body ? `<div class="ab">${esc(a.body)}</div>` : ""}
      <div class="abtn">
        <button data-x="snooze">10분 뒤</button>
        ${task ? '<button data-x="ok">확인</button><button class="go" data-x="done">완료</button>' : '<button class="go" data-x="done">확인</button>'}
      </div>${more}</div>`;
    root.querySelector<HTMLButtonElement>(".go")?.focus();
    root.querySelectorAll<HTMLButtonElement>("[data-x]").forEach((b) =>
      b.addEventListener("click", () => void invoke("alarm_answer", { key: a.key, answer: b.dataset.x }).then(draw))
    );
  };
  void listen("bh-alarm-update", () => void draw());
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") root.querySelector<HTMLButtonElement>("[data-x=snooze]")?.click();
  });
  void draw();
}
