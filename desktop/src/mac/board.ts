/**
 * The widget (user's choice, 2026-10-27): small (≈320×400) or large (≈720×560), on the desktop by
 * default (설정: 항상 위 / ⌃⌥⌘W로 잠깐 앞으로), following the app's theme.
 *  small — today's appointments (time ranges), open to-dos (check), deadlines soon, one input line
 *  large (2026-10-27 시안 H, ≈820 wide) — four labelled tiles: 지금 (clock, next) · 집중 타이머 (60 min)
 *          · 일정 (today, tomorrow, starred soon) · 할 일 (same order and numbers as the 오늘 화면); input below
 * Checks and new lines go to the main page (it applies, saves and shares them); the widget reads
 * the saved calendar again when the main page saves. Times are 24-hour.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addDays, DOW, fdShort, mins, nowHM, parseDay, ymd } from "../calendar/dates";
import { normalizeState, type CalendarState, type Task } from "../calendar/model";
import { dueOn, eventsOn, taskGroups } from "../calendar/store";
import { dueText, isUrgent, nextUp, orderedTasks, untilText as until, upcoming } from "../calendar/views/today";

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
  const input = `<input class="bin" placeholder="${size === "large" ? "「내일 3시 상담」·「금요일까지 보고서」처럼 쓰고 Enter" : "넣기 · Enter"}" aria-label="블랙홀에 넣기" autocomplete="off" spellcheck="false">`;
  const todo = `<div class="bl">할 일 ${open.length}${done ? ` · 완료 ${done}` : ""}</div>${open.map(taskRow).join("") || '<div class="bz">없음</div>'}`;
  if (size === "small") {
    return `<div class="bh-board">${head}<div class="bl">일정</div>${ev || '<div class="bz">없음</div>'}${todo}${soonRows ? `<div class="bl">마감 임박</div>${soonRows}` : ""}${input}</div>`;
  }
  // The date is in the 지금 tile: the top line keeps only ⤡ and ↗.
  return largeHTML(s, now, head.replace(/<span data-tauri-drag-region>[^<]*<\/span>/, '<span data-tauri-drag-region></span>'), input);
}

const p2 = (n: number) => String(n).padStart(2, "0");
const fdW = (k: string) => {
  const d = parseDay(k);
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
};

function largeHTML(s: CalendarState, now: Date, head: string, input: string): string {
  const k = ymd(now);
  const t = parseDay(k);
  const hm = nowHM(now);
  const wd = t.getDay() >= 1 && t.getDay() <= 5;
  const nx = nextUp(s, now);
  // 일정: same title and time twice shows once with ×2.
  const day = (d: string, dim: boolean) => {
    const seen = new Map<string, { e: ReturnType<typeof eventsOn>[number]; n: number }>();
    for (const e of eventsOn(s, d).filter((x) => !x.workFor)) {
      const key = `${e.title}|${e.start ?? ""}|${e.end ?? ""}`;
      const v = seen.get(key);
      if (v) v.n++;
      else seen.set(key, { e, n: 1 });
    }
    return [...seen.values()].map(({ e, n }) => {
      const past = dim && (e.end ? e.end <= hm : !!e.start && e.start < hm);
      return `<div class="hr ${past ? "past" : ""}" data-open="${e.id}" title="${esc(`${range(e.start, e.end)} ${e.title}`)}"><span class="tm">${e.start ?? "종일"}</span><span class="tt">${esc(e.title)}${n > 1 ? ` <i class="x">×${n}</i>` : ""}${e.provisional ? '<i class="ga">가</i>' : ""}</span><span class="x">${e.end && e.start ? `${e.end}까지` : ""}</span></div>`;
    }).join("");
  };
  const tom = ymd(addDays(t, 1));
  const today = day(k, true);
  const tomorrow = day(tom, false);
  const nToday = eventsOn(s, k).filter((x) => !x.workFor).length;
  const nTom = eventsOn(s, tom).filter((x) => !x.workFor).length;
  const ups = upcoming(s, k, fdW).slice(0, 3).map((u) => `<div class="hr" data-open="${u.id}"><span class="tm">${esc(u.when.split(/[ (]/)[0])}</span><span class="tt"><span class="${u.star === 2 ? "s2" : "s1"}">★</span> ${esc(u.title)}</span><span class="dd ${u.days <= 7 ? "soon" : ""}">D-${u.days}</span></div>`).join("");
  // 할 일: the 오늘 화면's order and numbers (urgent → ★ → earliest).
  const o = orderedTasks(s, k, now);
  const off = s.settings.offWork;
  const trow = (x: Task) => {
    const n = o.num.get(x.id);
    const urg = isUrgent(x, now, off);
    const due = dueText(x, now, k, fdW, off);
    const [left, right] = x.dueTime && x.due <= k ? [x.dueTime, due.split(" · ")[1] ?? ""] : [x.noDue ? "—" : x.due === k ? "오늘" : `${parseDay(x.due).getMonth() + 1}/${parseDay(x.due).getDate()}`, x.noDue ? "마감 없음" : ""];
    return `<div class="hr"><span class="tm ${urg ? "b" : ""}">${left}</span><span class="tt"><button class="ck" data-toggle="${x.id}" role="checkbox" aria-checked="false" aria-label="${esc(x.title)} 완료"></button><span class="no">${n ?? ""}</span>${x.star ? `<span class="${x.star === 2 ? "s2" : "s1"}">★</span> ` : ""}<span class="nm" data-open="${x.id}">${esc(x.title)}</span>${x.subs.length ? ` <i class="x">${x.subs.filter((y) => y.done).length}/${x.subs.length}</i>` : ""}</span><span class="x ${urg ? "b" : ""}">${right}</span></div>`;
  };
  const done = o.done.length;
  return `<div class="bh-board large h">${head}
    <div class="hgrid">
      <div class="hcol">
        <div class="card"><div class="ch"><i>◷</i>지금</div>
          <div class="clk" data-clk>${p2(now.getHours())}:${p2(now.getMinutes())}</div>
          <div class="dt">${t.getMonth() + 1}월 ${t.getDate()}일 ${"일월화수목금토"[t.getDay()]}요일${wd ? ` <span>· 퇴근 ${off}</span>` : ""}</div>
          ${nx ? `<div class="nx" title="${esc(nx.title)}"><div class="l">다음 · ${until(now, nx.at)}</div><b>${nx.label}</b> ${esc(nx.title)}</div>` : '<div class="nx"><div class="l">다음</div>일주일 안에 정해진 것 없음</div>'}</div>
        <div class="card"><div class="ch"><i>⏲</i>집중 타이머<span class="why">· 최대 60분</span></div>
          <div class="tmr"><div class="dial" data-dial title="돌려서 맞추면 바로 시작"><div class="face"></div><div class="hub"></div></div>
            <div><div class="rd" data-rd>00:00</div><div class="pre"><button data-m="10">10</button><button data-m="25">25</button><button data-m="45">45</button><button data-m="0" aria-label="멈춤">↺</button></div></div></div></div>
      </div>
      <div class="card"><div class="ch"><i>▦</i>일정<span class="c">오늘 ${nToday} · 내일 ${nTom}</span></div>
        ${today || '<div class="bz">오늘 일정 없음</div>'}
        <div class="sub">내일 ${fdW(tom)}</div>${tomorrow || '<div class="bz">없음</div>'}
        ${ups ? `<div class="sub">다가오는 주요 일정</div>${ups}` : ""}</div>
      <div class="card"><div class="ch"><i>☑</i>할 일<span class="c">${o.today.length + o.later.length} 남음${done ? ` · 완료 ${done}` : ""}</span></div>
        ${o.today.map(trow).join("") || '<div class="bz">오늘 할 일 없음</div>'}
        ${o.later.length ? `<div class="sub">나중</div><div class="later">${o.later.slice(0, 3).map(trow).join("")}</div>` : ""}</div>
    </div>
    <div class="hin"><b>＋ 넣기</b>${input}</div></div>`;
}

export function mountBoard(root: HTMLElement): void {
  document.documentElement.classList.add("bhw-board");
  let s: CalendarState | null = null;
  let size: "small" | "large" = "small";
  // 집중 타이머: when it ends (kept across redraws and restarts of the widget).
  let endAt = 0;
  let rang = true;
  let turning = false;
  try {
    endAt = Number(localStorage.getItem("bh-timer-end")) || 0;
    rang = endAt <= Date.now();
  } catch {
    /* none */
  }
  const setTimer = (m: number) => {
    endAt = m > 0 ? Date.now() + m * 60_000 : 0;
    rang = !endAt;
    try {
      localStorage.setItem("bh-timer-end", String(endAt));
    } catch {
      /* this run only */
    }
    tick();
  };
  // The clock and the timer move between redraws (every 1/4 s); the end rings once.
  const tick = () => {
    const now = new Date();
    root.querySelectorAll<HTMLElement>("[data-clk]").forEach((e) => (e.textContent = `${p2(now.getHours())}:${p2(now.getMinutes())}`));
    const left = Math.max(0, endAt - Date.now());
    root.querySelectorAll<HTMLElement>("[data-dial] .face").forEach((f) => f.style.setProperty("--a", `${(left / 3_600_000) * 360}deg`));
    const sec = Math.ceil(left / 1000);
    root.querySelectorAll<HTMLElement>("[data-rd]").forEach((e) => {
      e.textContent = endAt || !rang ? `${p2(Math.floor(sec / 60))}:${p2(sec % 60)}` : e.dataset.done ? "끝!" : "00:00";
    });
    if (endAt && !left && !rang) {
      rang = true;
      endAt = 0;
      root.querySelectorAll<HTMLElement>("[data-rd]").forEach((e) => ((e.dataset.done = "1"), (e.textContent = "끝!")));
      void invoke("board_timer_done").catch(() => undefined);
    }
  };
  window.setInterval(tick, 250);
  const draw = () => {
    if (!s || turning) return;
    document.documentElement.dataset.theme = s.settings.theme === "doc" ? "doc" : s.settings.mode;
    const typing = (document.activeElement as HTMLInputElement | null)?.classList.contains("bin") ? (document.activeElement as HTMLInputElement).value : null;
    root.innerHTML = boardHTML(s, new Date(), size);
    if (typing !== null) {
      const i = root.querySelector<HTMLInputElement>(".bin")!;
      i.value = typing;
      i.focus();
    }
    root.querySelectorAll<HTMLElement>("[data-dial]").forEach((d) => d.insertAdjacentHTML("beforeend", Array.from({ length: 12 }, (_, i) => `<span class="tick" style="transform:rotate(${i * 30}deg)"></span>`).join("")));
    tick();
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
  // Turning the dial sets the minutes (0–60, counter-clockwise from the top like a kitchen timer).
  const minutesAt = (dial: HTMLElement, e: PointerEvent) => {
    const r = dial.getBoundingClientRect();
    const deg = (Math.atan2(e.clientX - r.left - r.width / 2, -(e.clientY - r.top - r.height / 2)) * 180) / Math.PI;
    return Math.max(0, Math.min(60, Math.round(((360 - ((deg + 360) % 360)) % 360) / 6)));
  };
  root.addEventListener("pointerdown", (e) => {
    const dial = (e.target as HTMLElement).closest<HTMLElement>("[data-dial]");
    if (!dial) return;
    turning = true;
    dial.setPointerCapture(e.pointerId);
    setTimer(minutesAt(dial, e));
    const move = (ev: PointerEvent) => setTimer(minutesAt(dial, ev));
    // Also on a cancelled pointer (the window lost focus mid-turn): otherwise `turning` stayed on and the widget never redrew.
    const up = () => {
      turning = false;
      dial.removeEventListener("pointermove", move);
      for (const k of ["pointerup", "pointercancel", "lostpointercapture"] as const) dial.removeEventListener(k, up);
    };
    dial.addEventListener("pointermove", move);
    for (const k of ["pointerup", "pointercancel", "lostpointercapture"] as const) dial.addEventListener(k, up);
  });
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const pm = t.closest<HTMLElement>("[data-m]");
    if (pm) return setTimer(Number(pm.dataset.m));
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
