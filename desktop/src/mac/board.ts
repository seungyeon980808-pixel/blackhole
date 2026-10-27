/**
 * The 「오늘」 board pinned to the desktop (below every window, on all Spaces): today's
 * appointments, what is due today (and late), the next three days. Checks go to the main page
 * (it applies and shares them); the board reloads the saved calendar when the main page saves.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DOW, nowHM, parseDay, ymd } from "../calendar/dates";
import { normalizeState, type CalendarState } from "../calendar/model";
import { eventsOn, taskGroups } from "../calendar/store";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * 안 A (user's choice): today only, small and light — appointments, then what is late or due today
 * (not done). The next days are not shown.
 */
export function boardHTML(s: CalendarState, now: Date): string {
  const k = ymd(now);
  const t = parseDay(k);
  const hm = nowHM(now);
  const g = taskGroups(s, k);
  const todo = g.today.filter((x) => !x.done);
  const ev = eventsOn(s, k).map((e) => {
    const past = e.end ? e.end <= hm : !!e.start && e.start < hm;
    return `<div class="br ${past ? "past" : ""}" data-open="${e.id}" title="${esc(`${e.start ?? "종일"}${e.end ? "–" + e.end : ""} ${e.title}`)}"><span class="bt">${e.start ?? "종일"}</span><span class="bn">${esc(e.title)}${e.provisional ? '<i class="ga">가</i>' : ""}</span></div>`;
  }).join("");
  const task = todo.map((x) => {
    const late = x.due < k;
    return `<div class="br"><button class="bx" data-toggle="${x.id}" role="checkbox" aria-checked="false" aria-label="${esc(x.title)} 완료"></button><span class="bn" data-open="${x.id}" title="${esc(x.title)}">${esc(x.title)}</span><span class="bd ${late || x.dueTime ? "hot" : ""}">${late ? `${Math.round((t.getTime() - parseDay(x.due).getTime()) / 864e5)}일 지남` : x.dueTime ?? ""}</span></div>`;
  }).join("");
  return `<div class="bh-board">
    <div class="bhd" data-tauri-drag-region><span data-tauri-drag-region>${t.getMonth() + 1}/${t.getDate()}(${DOW[t.getDay()]})</span><button class="bo" data-open="" title="블랙홀 열기" aria-label="블랙홀 열기">↗</button></div>
    ${ev}${task ? `<div class="bsep"></div>${task}` : ""}${ev || task ? "" : '<div class="bz">오늘 일정·할 일 없음</div>'}
  </div>`;
}

export function mountBoard(root: HTMLElement): void {
  document.documentElement.classList.add("bhw-board");
  let s: CalendarState | null = null;
  const draw = () => {
    if (!s) return;
    document.documentElement.dataset.theme = s.settings.theme === "doc" ? "doc" : s.settings.mode;
    root.innerHTML = boardHTML(s, new Date());
    // The window takes the height of what it shows (no empty half board).
    // (a timer, not requestAnimationFrame: a covered desktop window gets no frames)
    window.setTimeout(() => void invoke("board_fit", { height: Math.ceil(document.querySelector(".bh-board")!.getBoundingClientRect().height + 12) }).catch(() => undefined), 50);
  };
  const load = async () => {
    s = normalizeState(await invoke("load_calendar_state").catch(() => null)) ?? s;
    draw();
  };
  void load();
  // The main page saved (a check, a new entry): read again. And every minute for the clock.
  void listen("bh-board-refresh", () => void load());
  window.setInterval(() => void load(), 60_000);
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tg = t.closest<HTMLElement>("[data-toggle]");
    if (tg) {
      // Show it at once; the main page's save brings the real state back.
      tg.textContent = tg.textContent ? "" : "✓";
      tg.closest(".br")?.classList.toggle("done");
      return void invoke("board_toggle", { id: tg.dataset.toggle });
    }
    const op = t.closest<HTMLElement>("[data-open]");
    if (op) void invoke("board_open", { id: op.dataset.open || null });
  });
}
