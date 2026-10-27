/**
 * The widget (user's choice, 2026-10-27): small (≈320×400) or large (≈720×560), on the desktop by
 * default (설정: 항상 위 / ⌃⌥⌘W로 잠깐 앞으로), following the app's theme.
 *  small — today's appointments (time ranges), open to-dos (check), deadlines soon, one input line
 *  large — the same + a named day bar + tomorrow·this week's deadlines + the last 3 chat lines
 * Checks and new lines go to the main page (it applies, saves and shares them); the widget reads
 * the saved calendar again when the main page saves. Times are 24-hour.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addDays, DOW, fdShort, mins, nowHM, parseDay, ymd } from "../calendar/dates";
import { normalizeState, type CalendarState, type Task } from "../calendar/model";
import { dueOn, eventsOn, taskGroups } from "../calendar/store";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const range = (a: string | null, b: string | null) => (a ? `${a}${b ? "–" + b : ""}` : "종일");

function left(now: Date, hm: string): string {
  const d = mins(hm) - (now.getHours() * 60 + now.getMinutes());
  if (d <= 0) return "";
  return `${d >= 60 ? `${Math.floor(d / 60)}시간${d % 60 ? ` ${d % 60}분` : ""}` : `${d}분`} 남음`;
}

export function boardHTML(s: CalendarState, now: Date, size: "small" | "large" = "small"): string {
  const k = ymd(now);
  const t = parseDay(k);
  const hm = nowHM(now);
  const g = taskGroups(s, k);
  const open = g.today.filter((x) => !x.done);
  const done = g.today.length - open.length;
  const evs = eventsOn(s, k);
  const ev = evs.map((e) => {
    const past = e.end ? e.end <= hm : !!e.start && e.start < hm;
    return `<div class="br ${past ? "past" : ""}" data-open="${e.id}" title="${esc(`${range(e.start, e.end)} ${e.title}`)}"><span class="bt">${range(e.start, e.end)}</span><span class="bn">${esc(e.title)}${e.provisional ? '<i class="ga">가</i>' : ""}</span></div>`;
  }).join("");
  const taskRow = (x: Task) => {
    const late = x.due < k;
    const when = late ? `<span class="bd hot">${Math.round((t.getTime() - parseDay(x.due).getTime()) / 864e5)}일 지남</span>` : x.dueTime ? `<span class="lf">${left(now, x.dueTime)}</span><span class="bd hot">${x.dueTime}</span>` : "";
    return `<div class="br"><button class="bx" data-toggle="${x.id}" role="checkbox" aria-checked="false" aria-label="${esc(x.title)} 완료"></button><span class="bn" data-open="${x.id}" title="${esc(x.title)}">${esc(x.title)}</span>${x.subs.length ? `<span class="lf">${x.subs.filter((y) => y.done).length}/${x.subs.length}</span>` : ""}${when}</div>`;
  };
  const soon = [1, 2].flatMap((n) => dueOn(s, ymd(addDays(t, n))).filter((x) => !x.done)).slice(0, 3);
  const soonRows = soon.map((x) => `<div class="br" data-open="${x.id}"><span class="bn">${esc(x.title)}</span><span class="bt r">${x.due === ymd(addDays(t, 1)) ? "내일" : fdShort(x.due)}${x.dueTime ? " " + x.dueTime : ""}</span></div>`).join("");
  const head = `<div class="bhd" data-tauri-drag-region><span data-tauri-drag-region>${size === "large" ? `${t.getMonth() + 1}월 ${t.getDate()}일 (${DOW[t.getDay()]})` : `${t.getMonth() + 1}/${t.getDate()}(${DOW[t.getDay()]})`}</span><span class="bic"><button class="bo" data-size="${size === "large" ? "small" : "large"}" title="${size === "large" ? "작게" : "크게"}" aria-label="${size === "large" ? "작게" : "크게"}">${size === "large" ? "⤡" : "⤢"}</button><button class="bo" data-open="" title="블랙홀 열기" aria-label="블랙홀 열기">↗</button></span></div>`;
  const input = `<input class="bin" placeholder="넣기 · Enter" aria-label="블랙홀에 넣기" autocomplete="off" spellcheck="false">`;
  const todo = `<div class="bl">할 일 ${open.length}${done ? ` · 완료 ${done}` : ""}</div>${open.map(taskRow).join("") || '<div class="bz">없음</div>'}`;
  if (size === "small") {
    return `<div class="bh-board">${head}<div class="bl">일정</div>${ev || '<div class="bz">없음</div>'}${todo}${soonRows ? `<div class="bl">마감 임박</div>${soonRows}` : ""}${input}</div>`;
  }
  // Large: a named day bar (7–23시, lanes so names never overlap), then three columns.
  const timed = evs.filter((e) => e.start);
  const H0 = Math.min(7, ...timed.map((e) => Math.floor(mins(e.start!) / 60)));
  const H1 = Math.max(23, ...timed.map((e) => Math.ceil(mins(e.end ?? e.start!) / 60)));
  const span = (H1 - H0) * 60;
  const lanes: number[] = [];
  const bars = timed.map((e) => {
    const a = mins(e.start!);
    const b = e.end ? mins(e.end) : a + (s.settings.eventMinutes || 60);
    const vis = Math.max(b, a + Math.round((`${range(e.start, e.end)} ${e.title}`.length * 6.5 + 16) * span / 690));
    let lane = lanes.findIndex((end) => end <= a);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = vis;
    return `<span class="sbar ${e.provisional ? "prov" : ""}" data-open="${e.id}" style="left:${((a - H0 * 60) / span * 100).toFixed(2)}%;width:${((vis - a) / span * 100).toFixed(2)}%;top:${lane * 16}px" title="${esc(`${range(e.start, e.end)} ${e.title}`)}">${range(e.start, e.end)} ${esc(e.title)}</span>`;
  }).join("");
  const nowM = now.getHours() * 60 + now.getMinutes();
  const nowLine = nowM >= H0 * 60 && nowM <= H1 * 60 ? `<i class="snow" style="left:${((nowM - H0 * 60) / span * 100).toFixed(2)}%"></i>` : "";
  const tom = ymd(addDays(t, 1));
  const week = [2, 3, 4, 5, 6].map((n) => ymd(addDays(t, n)));
  const tomRows = eventsOn(s, tom).map((e) => `<div class="br" data-open="${e.id}"><span class="bt">${range(e.start, e.end)}</span><span class="bn">${esc(e.title)}</span></div>`).join("");
  const weekDue = [tom, ...week].flatMap((d) => dueOn(s, d).filter((x) => !x.done)).map((x) => `<div class="br" data-open="${x.id}"><span class="bt">${x.due === tom ? "내일" : fdShort(x.due)}</span><span class="bn">${esc(x.title)}</span>${x.subs.length ? `<span class="lf">${x.subs.filter((y) => y.done).length}/${x.subs.length}</span>` : ""}</div>`).join("");
  const chat = s.chat.filter((m) => m.text || m.fileName).slice(-3).map((m) => `<div class="bb ${m.who}">${esc(m.text || m.fileName || "")}</div>`).join("");
  return `<div class="bh-board large">${head}
    <div class="sline" style="height:${Math.max(1, lanes.length) * 16 + 2}px">${bars || '<span class="bz">일정 없음</span>'}${nowLine}</div>
    <div class="bcols">
      <div>${todo}</div>
      <div><div class="bl">내일</div>${tomRows || '<div class="bz">없음</div>'}${weekDue ? `<div class="bl">이번 주 마감</div>${weekDue}` : ""}</div>
      <div><div class="bl">최근 대화</div>${chat || '<div class="bz">없음</div>'}</div>
    </div>${input}</div>`;
}

export function mountBoard(root: HTMLElement): void {
  document.documentElement.classList.add("bhw-board");
  let s: CalendarState | null = null;
  let size: "small" | "large" = "small";
  const draw = () => {
    if (!s) return;
    document.documentElement.dataset.theme = s.settings.theme === "doc" ? "doc" : s.settings.mode;
    const typing = (document.activeElement as HTMLInputElement | null)?.classList.contains("bin") ? (document.activeElement as HTMLInputElement).value : null;
    root.innerHTML = boardHTML(s, new Date(), size);
    if (typing !== null) {
      const i = root.querySelector<HTMLInputElement>(".bin")!;
      i.value = typing;
      i.focus();
    }
    // The window takes the height of what it shows (a timer: a covered desktop window gets no frames).
    window.setTimeout(() => void invoke("board_fit", { height: Math.ceil(document.querySelector(".bh-board")!.getBoundingClientRect().height + 12) }).catch(() => undefined), 50);
  };
  const load = async () => {
    const [raw, desk] = await Promise.all([invoke("load_calendar_state").catch(() => null), invoke<{ settings: { boardSize?: string } }>("desk_status").catch(() => null)]);
    s = normalizeState(raw) ?? s;
    size = desk?.settings.boardSize === "large" ? "large" : "small";
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
    const sz = t.closest<HTMLElement>("[data-size]");
    if (sz) {
      size = sz.dataset.size === "large" ? "large" : "small";
      draw();
      return void invoke("board_size", { size });
    }
    const op = t.closest<HTMLElement>("[data-open]");
    if (op) void invoke("board_open", { id: op.dataset.open || null });
  });
  root.addEventListener("keydown", (e) => {
    const i = e.target as HTMLInputElement;
    if (!i.classList.contains("bin") || e.key !== "Enter" || e.isComposing) return;
    const text = i.value.trim();
    if (!text) return;
    i.value = "";
    void invoke("quick_put_text", { text, via: "위젯" });
  });
}
