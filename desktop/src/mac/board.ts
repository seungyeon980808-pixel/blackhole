/**
 * The 「오늘」 board pinned to the desktop (below every window, on all Spaces): today's
 * appointments, what is due today (and late), the next three days. Checks go to the main page
 * (it applies and shares them); the board reloads the saved calendar when the main page saves.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addDays, DOW, fdShort, nowHM, parseDay, ymd } from "../calendar/dates";
import { normalizeState, type CalendarState } from "../calendar/model";
import { eventsOn, taskGroups } from "../calendar/store";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function boardHTML(s: CalendarState, now: Date): string {
  const k = ymd(now);
  const t = parseDay(k);
  const hm = nowHM(now);
  const evs = eventsOn(s, k);
  const g = taskGroups(s, k);
  const late = g.today.filter((x) => x.due < k && !x.done);
  const due = g.today.filter((x) => x.due === k);
  const ev = evs.map((e) => {
    const past = e.end ? e.end <= hm : !!e.start && e.start < hm;
    return `<div class="br ${past ? "past" : ""}" data-open="${e.id}"><span class="bt">${e.start ?? "종일"}</span><span class="bn">${esc(e.title)}${e.provisional ? '<i class="ga">가</i>' : ""}</span></div>`;
  }).join("");
  const task = (x: (typeof due)[number], hot: boolean) =>
    `<div class="br ${x.done ? "done" : ""}"><button class="bx" data-toggle="${x.id}" role="checkbox" aria-checked="${x.done}" aria-label="${esc(x.title)} 완료">${x.done ? "✓" : ""}</button><span class="bn" data-open="${x.id}">${esc(x.title)}</span><span class="bd ${hot && !x.done ? "hot" : ""}">${x.due < k ? `${Math.round((t.getTime() - parseDay(x.due).getTime()) / 864e5)}일 지남` : x.dueTime ?? ""}</span></div>`;
  const next = [1, 2, 3].map((n) => {
    const d = ymd(addDays(t, n));
    const items = [...eventsOn(s, d).map((e) => `${e.start ?? ""} ${e.title}`.trim()), ...taskGroups(s, d).today.filter((x) => x.due === d && !x.done).map((x) => `마감 ${x.title}`)];
    return items.length ? `<div class="bnx"><b>${fdShort(d)}</b> ${esc(items.slice(0, 3).join(" · "))}${items.length > 3 ? ` 외 ${items.length - 3}` : ""}</div>` : "";
  }).join("");
  return `<div class="bh-board">
    <div class="bhd" data-tauri-drag-region><span data-tauri-drag-region>${t.getMonth() + 1}/${t.getDate()}(${DOW[t.getDay()]})</span><button class="bo" data-open="" title="블랙홀 열기">열기</button></div>
    <div class="bs"><div class="bl">일정</div>${ev || '<div class="bz">없음</div>'}</div>
    <div class="bs"><div class="bl">할 일</div>${late.map((x) => task(x, true)).join("")}${due.map((x) => task(x, true)).join("")}${late.length + due.length ? "" : '<div class="bz">없음</div>'}</div>
    ${next ? `<div class="bs"><div class="bl">다가오는</div>${next}</div>` : ""}
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
    requestAnimationFrame(() => void invoke("board_fit", { height: Math.ceil(document.documentElement.scrollHeight) }).catch(() => undefined));
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
