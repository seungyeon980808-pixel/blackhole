/** 유리 테마 (기본). Markup follows design/calendar-glass/prototype-glass.html. */
import { holiday } from "../holidays";
import { addDays, DOW, fdShort, mins, parseDay, ymd, diffDays } from "../dates";
import type { CalEvent, ChatMessage, Period, Task } from "../model";
import { alarmsOn, dueOn, eventsOn, findEntry, pending, periodsOn, taskGroups, type Alarm } from "../store";
import { aiOffer, dday, draftTag, dueBadge, dueMarks, esc, hourSegments, ICON, KIND_WORD, chatCards, checksBar, inputHint, lazyFold, needsReview, nextReminder, pct, todayResults, type Ctx, type ThemeView } from "./common";

const fd = fdShort;
const none = '<div class="none">없음</div>';
/** 「나중」 shows the nearest few; the rest fold (a long list pushes nothing useful into view). */
const LATER_SHOWN = 8;
const OVERDUE_SHOWN = 5;

export function timetable(ctx: Ctx, k: string, H0 = 7, H1 = 24, rowH = 28): string {
  const evs = eventsOn(ctx.s, k);
  const rems = alarmsOn(ctx.s, k, fd);
  const dues = dueOn(ctx.s, k);
  const allDayDue = dues.filter((t) => !t.dueTime);
  let h = `${allDayDue.length ? `<div class="dueday">마감 ${allDayDue.map((t) => { const b = dueBadge(ctx.today, t); return `<span class="${b?.hot ? "hot" : ""} ${t.done ? "done" : ""}" data-ev="${t.id}">${esc(t.title)}</span>`; }).join("")}</div>` : ""}<div class="mh0"></div>${[10, 20, 30, 40, 50, 60].map((x) => `<div class="mh">${x}</div>`).join("")}`;
  for (let H = H0; H < H1; H++) {
    const A = H * 60;
    const B = A + 60;
    let r = "<i></i><i></i><i></i><i></i><i></i><i></i>";
    for (const g of hourSegments(evs, H)) {
      r += `<div class="bk ${g.area} ${g.provisional ? "prov" : ""} ${g.half}" data-ev="${g.id}" style="left:${pct(g.s, A)};width:${pct(g.en + A - g.s, A)}" title="${esc(g.range + " " + g.title)}">${g.first ? esc(g.title) : ""}</div>`;
    }
    for (const x of rems) {
      const m = mins(x.at.slice(11));
      if (m >= A && m < B) r += `<div class="rm" style="left:${pct(m, A)}" title="${esc(`알림 ${x.at.slice(11)} ${x.title}`)}"></div>`;
    }
    r += dueMarks(ctx.today, dues, A, B);
    if (k === ctx.today && ctx.nowM >= A && ctx.nowM < B) r += `<div class="now" style="left:${pct(ctx.nowM, A)}"></div>`;
    h += `<div class="h" style="height:${rowH}px">${H}</div><div class="row ${k === ctx.today && B <= ctx.nowM ? "past" : ""}" style="height:${rowH}px">${r}</div>`;
  }
  return `<div class="tt">${h}</div>`;
}

function taskHTML(ctx: Ctx, t: Task, showSubAdd = true): string {
  const sd = t.subs.filter((x) => x.done).length;
  const nr = nextReminder(ctx, t);
  const dueDiff = diffDays(ctx.today, t.due);
  const meta = [
    t.dueTime ? `${dueDiff === 0 ? "" : `${parseDay(t.due).getMonth() + 1}/${parseDay(t.due).getDate()} `}${t.dueTime}까지` : "",
    nr ? `알림 ${nr.slice(0, 10) === ctx.today ? "" : `${+nr.slice(5, 7)}/${+nr.slice(8, 10)} `}${nr.slice(11)}` : "",
    t.subs.length ? `${sd}/${t.subs.length}` : ""
  ].filter(Boolean).join(" · ");
  const subs = t.subs.map((x, i) => `<div class="sub ${x.done ? "done" : ""}" data-sub="${t.id}:${i}" role="checkbox" aria-checked="${x.done}" tabindex="0"><span class="bx">${x.done ? "✓" : ""}</span><span>${esc(x.title)}</span></div>`).join("");
  return `<div class="task ${t.done ? "done" : ""}">
    <div class="th"><span class="bx" data-tdone="${t.id}" role="checkbox" aria-checked="${t.done}" tabindex="0" aria-label="${esc(t.title)} 완료">${t.done ? "✓" : ""}</span><span class="t">${esc(t.title)}${draftTag(t)}</span><span class="ml">${t.noDue ? "" : dday(ctx.today, t)}</span></div>
    ${meta || t.suggest?.length ? `<div class="tm2">${esc(meta)}${aiOffer(t, fd)}</div>` : ""}
    ${t.subs.length || showSubAdd ? `<div class="subs">${subs}${showSubAdd ? `<input class="subadd" data-subadd="${t.id}" placeholder="+ 하위 할 일" aria-label="${esc(t.title)} 하위 할 일 추가">` : ""}</div>` : ""}
  </div>`;
}

/**
 * 오늘까지: today's to-dos and the recent overdue ones in full; overdue ones older than the last
 * few fold away (a pile of old misses would push today's out of view).
 */
function todayTasks(ctx: Ctx, list: Task[], k: string): string {
  const old = list.filter((t) => t.due < k);
  const keep = old.slice(-OVERDUE_SHOWN);
  const hidden = old.slice(0, Math.max(0, old.length - OVERDUE_SHOWN));
  return (hidden.length ? lazyFold(ctx, "overdue", `오래 지난 것 ${hidden.length}개`, () => hidden.map((t) => taskHTML(ctx, t, false)).join("")) : "") +
    [...keep, ...list.filter((t) => t.due >= k)].map((t) => taskHTML(ctx, t)).join("");
}

function okNo(id: string): string {
  return `<span class="act"><button class="mini" data-ok="${id}">확정</button><button class="mini" data-no="${id}">취소</button></span>`;
}

function evRow(e: CalEvent): string {
  return `<div class="ev" data-ev="${e.id}"><span class="dot d-${e.area}"></span><span class="tm">${e.start ? `${e.start}–${e.end}` : "종일"}</span><span class="evt">${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}${draftTag(e)}${aiOffer(e, fd)}${e.reminders.length ? ` <span class="rem">알림 ${esc(e.reminders.map((r) => r.slice(11)).join(", "))}</span>` : ""}</span>${e.provisional ? okNo(e.id) : ""}</div>`;
}

function perRow(p: Period, k: string): string {
  const total = diffDays(p.from, p.to) + 1;
  const nth = diffDays(p.from, k) + 1;
  return `<div class="prow"><div class="prow-h"><span>${esc(p.title)}</span><span class="sm">~${fd(p.to)} · ${nth}/${total}일</span></div><div class="pbar"><i style="width:${((nth / total) * 100).toFixed(1)}%"></i></div></div>`;
}


/**
 * Results first: 「검토 필요」 stands out, what was organised today is folded to titles, file names
 * and times only behind 「자세히」. Nothing to show → no box at all.
 */
function inboxBox(ctx: Ctx, pend: CalEvent[]): string {
  const review = needsReview(ctx);
  const failed = ctx.s.inbox.filter((x) => x.at.slice(0, 10) === ctx.today && x.state === "실패");
  const done = todayResults(ctx);
  const raw = ctx.s.inbox.filter((x) => x.at.slice(0, 10) === ctx.today);
  if (!review.length && !failed.length && !pend.length && !done.length) return "";
  const row = (x: { id: string; kind: CalEvent["kind"] | Task["kind"] | Period["kind"] | "note"; title: string }) => `<div class="inb" data-ev="${x.id}"><span class="k">${KIND_WORD[x.kind]}</span><span class="evt">${esc(x.title)}</span></div>`;
  return `<div class="box g inbox">
    ${review.length || failed.length ? `<h4 class="warn">검토 필요 ${review.length + failed.length}</h4>${review.map((x) => `<div class="inb rv" data-ev="${x.id}"><span class="k">${KIND_WORD[x.kind]}</span><span class="evt">${esc(x.title)} <span class="s">${esc(x.review!.join(" · "))}</span></span>${x.kind === "event" && x.provisional ? okNo(x.id) : `<span class="act"><button class="mini" data-no="${x.id}">되돌리기</button></span>`}</div>`).join("")}${failed.map((x) => `<div class="inb rv"><span class="k">실패</span><span class="evt">${esc(x.out || x.title)}</span></div>`).join("")}` : ""}
    ${pend.length ? `<h4 class="${review.length || failed.length ? "mt" : ""}">확정 대기 ${pend.length}</h4>${pend.map((e) => `<div class="ev" data-ev="${e.id}"><span class="tm w96">${fd(e.date)} ${e.start ?? "종일"}</span><span class="evt">${esc(e.title)}</span>${okNo(e.id)}</div>`).join("")}` : ""}
    ${done.length ? `<details class="fold"><summary>오늘 정리한 것 ${done.length}</summary>${done.map(row).join("")}
      ${raw.length ? `<details class="fold tech"><summary>자세히</summary>${raw.slice().reverse().map((x) => `<div class="inb"><span class="tm">${x.at.slice(11)}</span><span>${esc(x.title)} <span class="s">${esc(x.src)} · ${x.state === "완료" ? esc(x.out) : x.state}</span></span></div>`).join("")}</details>` : ""}</details>` : ""}
  </div>`;
}

/**
 * The day as one horizontal band (안 2): hours across, appointments as bars in as few lanes as
 * needed, all-day ones as chips in front, timed deadlines as thin marks, the now line.
 */
export function dayStrip(ctx: Ctx, k: string): string {
  const evs = eventsOn(ctx.s, k);
  const timed = evs.filter((e) => e.start);
  const allDay = evs.filter((e) => !e.start);
  const dues = dueOn(ctx.s, k).filter((t) => t.dueTime);
  const H0 = Math.min(7, ...timed.map((e) => Math.floor(mins(e.start!) / 60)));
  const H1 = Math.max(23, ...timed.map((e) => Math.ceil(mins(e.end ?? e.start!) / 60)));
  const span = (H1 - H0) * 60;
  const x = (m: number) => `${(((m - H0 * 60) / span) * 100).toFixed(2)}%`;
  const lanes: number[] = [];
  // A bar is at least as wide as its words (about 1 minute ≈ 1px on a wide window), so short
  // appointments still read; lanes are given by that width so words never overlap.
  const len = ctx.s.settings.eventMinutes || 60;
  const bars = timed.map((e) => {
    const a = mins(e.start!);
    // No end: drawn the default length and marked 「끝 미정」.
    const b = e.end ? Math.max(a + 10, mins(e.end)) : Math.min(24 * 60, a + len);
    const label = `${e.start}${e.end ? "–" + e.end : "–?"} ${e.title}`;
    const words = Math.round(((label.length * 7.5 + 20) * span) / 1000);
    const vis = Math.min(H1 * 60, Math.max(b, a + words));
    let lane = lanes.findIndex((end) => end <= a);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = vis;
    return `<div class="sb ${e.area} ${e.provisional ? "prov" : ""} ${e.end ? "" : "noend"}" data-ev="${e.id}" style="left:${x(a)};width:calc(${x(vis)} - ${x(a)});top:${lane * 19}px"><i class="rs l"></i><span class="st">${e.start}${e.end ? "–" + e.end : ""}</span> ${esc(e.title)}${e.end ? "" : '<span class="ne">끝 미정</span>'}${draftTag(e)}<i class="rs r"></i></div>`;
  }).join("");
  const ticks = Array.from({ length: Math.floor((H1 - H0) / 2) + 1 }, (_, i) => H0 + i * 2).map((h) => `<span style="left:${x(h * 60)}">${h}</span>`).join("");
  const marks = dues.map((t) => `<div class="sd ${dueBadge(ctx.today, t)?.hot && !t.done ? "hot" : ""} ${t.done ? "done" : ""}" data-ev="${t.id}" style="left:${x(mins(t.dueTime!))}" title="${esc(`마감 ${t.dueTime} ${t.title}`)}"></div>`).join("");
  const now = k === ctx.today && ctx.nowM >= H0 * 60 && ctx.nowM <= H1 * 60 ? `<div class="snow" style="left:${x(ctx.nowM)}"></div>` : "";
  // School periods, faint, on weekdays (설정 「학교 시간」): 1…7 and 점심, to place school things.
  const wd = parseDay(k).getDay();
  const st = ctx.s.settings;
  const bands = st.showPeriods && wd >= 1 && wd <= 5
    ? [...st.periods.map((p, i) => [p, `${i + 1}`] as const), [st.lunch, "점심"] as const].map(([p, n]) => {
        const [a, b] = p.split("-");
        if (!a || !b) return "";
        return `<div class="spd" style="left:${x(mins(a))};width:calc(${x(mins(b))} - ${x(mins(a))})"></div>`;
      }).join("")
    : "";
  // Their names in one thin row under the hours (not on top of them).
  const bandNames = bands
    ? `<div class="spl">${[...st.periods.map((p, i) => [p, `${i + 1}교시`] as const), [st.lunch, "점심"] as const].map(([p, n]) => {
        const [a, b] = p.split("-");
        return a && b ? `<span style="left:${x((mins(a) + mins(b)) / 2)}" title="${n} ${a}–${b}">${n.replace("교시", "")}</span>` : "";
      }).join("")}</div>`
    : "";
  const h = Math.max(1, lanes.length) * 19;
  return `<div class="strip g">${allDay.length ? `<div class="sall">${allDay.map((e) => `<span class="${e.provisional ? "prov" : ""}" title="종일 ${esc(e.title)}">종일 ${esc(e.title)}</span>`).join("")}</div>` : ""}
    <div class="sh">${ticks}</div>${bandNames}<div class="sl" data-h0="${H0}" data-h1="${H1}" style="height:${h}px">${bands}${bars || (allDay.length ? "" : '<div class="none">일정 없음</div>')}${marks}${now}</div></div>`;
}

/** 「2시간 10분 남음」 before a deadline today (nothing once it has passed). */
function left(ctx: Ctx, hm: string): string {
  const d = mins(hm) - ctx.nowM;
  if (d <= 0) return "";
  return `<span class="lft">${d >= 60 ? `${Math.floor(d / 60)}시간${d % 60 ? ` ${d % 60}분` : ""}` : `${d}분`} 남음</span>`;
}

/** One line per to-do: box, title, sub count (opens the list), when. */
function taskRow(ctx: Ctx, t: Task): string {
  const sd = t.subs.filter((x) => x.done).length;
  const open = !!ctx.open?.has(`subs:${t.id}`);
  const subs = open ? `<div class="subs">${t.subs.map((x, i) => `<div class="sub ${x.done ? "done" : ""}" data-sub="${t.id}:${i}" role="checkbox" aria-checked="${x.done}" tabindex="0"><span class="bx">${x.done ? "✓" : ""}</span><span>${esc(x.title)}</span></div>`).join("")}<input class="subadd on" data-subadd="${t.id}" placeholder="+ 하위 할 일" aria-label="${esc(t.title)} 하위 할 일 추가"></div>` : "";
  return `<div class="trow ${t.done ? "done" : ""}" data-ev="${t.id}"><span class="bx" data-tdone="${t.id}" role="checkbox" aria-checked="${t.done}" tabindex="0" aria-label="${esc(t.title)} 완료">${t.done ? "✓" : ""}</span><span class="t" title="${esc(t.title)}">${esc(t.title)}${draftTag(t)}</span>${t.subs.length ? `<button class="subn" data-subs="${t.id}" aria-expanded="${open}" title="하위 할 일 ${open ? "접기" : "펼치기"}">${sd}/${t.subs.length}</button>` : `<button class="subn add" data-subs="${t.id}" title="하위 할 일 추가" aria-label="하위 할 일 추가">+</button>`}<span class="ml">${t.noDue ? "" : t.dueTime && t.due === ctx.today && !t.done ? `${left(ctx, t.dueTime)}<span class="dd ${dueBadge(ctx.today, t)?.hot ? "hot" : ""}">${t.dueTime}</span>` : dday(ctx.today, t)}</span></div>${subs}`;
}

export const glass: ThemeView = {
  fd,
  shell: (ctx) => `
    <header class="bar" data-tauri-drag-region>
      <div class="title" id="bhTitle" data-nav="0" title="눌러서 오늘로 (T)"></div>
      <button class="nb" data-nav="-1" aria-label="이전" title="이전 (←)">‹</button><button class="nb" data-nav="1" aria-label="다음" title="다음 (→)">›</button><button class="nb ibn today" data-nav="0" aria-label="오늘로" title="오늘로 (T)">${ICON.today}</button>
      <span class="sp"></span>
      <span class="conn" title="${esc(ctx.connection.detail)}" data-testid="connection">${esc(ctx.connection.label)}</span>
      <div class="seg" role="group" aria-label="보기"><button data-v="month">월</button><button data-v="week">주</button><button data-v="day">일</button><button data-v="pri">우선순위</button><button data-v="memo">기억</button></div>
      <button class="nb ibn" data-print title="출력 (⌘P)" aria-label="출력">${ICON.print}</button><button class="nb ibn" data-settings aria-haspopup="dialog" title="설정 (⌘,)" aria-label="설정">${ICON.gear}</button>
    </header>
    <main class="content" id="bhMain"></main>
    <footer class="composer" id="bhComp"></footer>`,
  head: (ctx) => {
    const c = ctx.cur;
    if (ctx.view === "month") return { title: `${c.getFullYear()}년 ${c.getMonth() + 1}월` };
    if (ctx.view === "week") {
      const a = addDays(c, -c.getDay());
      const b = addDays(a, 6);
      return { title: `${a.getMonth() + 1}월 ${a.getDate()}일 – ${a.getMonth() === b.getMonth() ? "" : `${b.getMonth() + 1}월 `}${b.getDate()}일` };
    }
    const h = holiday(ymd(c));
    return { title: `${c.getMonth() + 1}월 ${c.getDate()}일 (${DOW[c.getDay()]})${h ? ` · ${h}` : ""}` };
  },
  day: (ctx) => {
    const k = ymd(ctx.cur);
    const G = taskGroups(ctx.s, k);
    const ps = periodsOn(ctx.s, k);
    const tom = ymd(addDays(ctx.cur, 1));
    const open = G.today.filter((t) => !t.done);
    const done = G.today.filter((t) => t.done);
    const evRow = (e: CalEvent, day = false) => `<div class="srow" data-ev="${e.id}"><span class="tm">${day ? fd(e.date) + " " : ""}${e.start ? `${e.start}${e.end ? "–" + e.end : ""}` : "종일"}</span><span class="t">${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}</span></div>`;
    const dueRow = (t: Task, day = false) => `<div class="srow" data-ev="${t.id}"><span class="tm">${day ? fd(t.due) + " " : ""}${t.dueTime ? t.dueTime + "까지" : "마감"}</span><span class="t">${esc(t.title)}</span>${t.subs.length ? `<span class="tm">${t.subs.filter((x) => x.done).length}/${t.subs.length}</span>` : ""}</div>`;
    const tomEv = eventsOn(ctx.s, tom);
    const tomDue = dueOn(ctx.s, tom).filter((t) => !t.done);
    const week = [2, 3, 4, 5, 6].map((n) => ymd(addDays(ctx.cur, n)));
    const weekEv = week.flatMap((d) => eventsOn(ctx.s, d));
    const weekDue = week.flatMap((d) => dueOn(ctx.s, d).filter((t) => !t.done));
    return `<div class="day2">
      ${ctx.side ? "" : checksBar(ctx, fd)}
      ${dayStrip(ctx, k)}
      <div class="cols2">
        <div class="box g grow"><h4>할 일 <small>${k === ctx.today ? "오늘" : fd(k)} ${open.length}${done.length ? ` · 완료 ${done.length}` : ""}</small></h4>
          ${G.today.length + G.week.length + G.later.length === 0 ? '<div class="none">없음 · 「금요일까지 보고서」처럼 쓰면 들어갑니다</div>' : open.map((t) => taskRow(ctx, t)).join("") || none}
          ${G.week.length ? `<div class="grp">이번 주 ${G.week.length}</div>${G.week.map((t) => taskRow(ctx, t)).join("")}` : ""}
          ${G.later.length ? lazyFold(ctx, "rest", `나중 ${G.later.length}`, () => G.later.map((t) => taskRow(ctx, t)).join("")) : ""}
          ${done.length ? lazyFold(ctx, "done", `완료 ${done.length}`, () => done.map((t) => taskRow(ctx, t)).join("")) : ""}
        </div>
        <div class="box g side2"><h4>내일 <small>${fd(tom)}</small></h4>
          ${tomEv.map((e) => evRow(e)).join("")}${tomDue.map((t) => dueRow(t)).join("")}${tomEv.length + tomDue.length ? "" : none}
          ${weekEv.length + weekDue.length ? `<h4 class="mt">이번 주 <small>${fd(week[0])} ~ ${fd(week[4])}</small></h4>${[...weekEv.map((e) => ({ k: `${e.date}${e.start ?? ""}`, h: evRow(e, true) })), ...weekDue.map((t) => ({ k: `${t.due}${t.dueTime ?? "99"}`, h: dueRow(t, true) }))].sort((p, q) => p.k.localeCompare(q.k)).map((r) => r.h).join("")}` : ""}
          ${ps.length ? `<h4 class="mt">기간</h4>${ps.map((p) => `<div class="srow"><span class="t">${esc(p.title)}</span><span class="tm">${fd(p.to)}까지 · ${diffDays(p.from, k) + 1}/${diffDays(p.from, p.to) + 1}일</span></div>`).join("")}` : ""}
        </div>
      </div></div>`;
  },
  week: () => null,
  composer: (ctx, id, inSheet) => `${inSheet ? "" : `<div class="grab" data-drag="open" title="끌어 올리면 대화 기록" role="button" tabindex="0" aria-label="대화 기록 열기"><i></i></div><div class="last" id="bhLast"></div>`}<div class="inp g"><input id="${id}" autocomplete="off" aria-label="입력" placeholder="${esc(inputHint(ctx, id !== "bhIn"))}"><button class="ic" data-photo title="사진·파일" aria-label="사진·파일">${ICON.cam}</button><button class="ic ${ctx.recording ? "rec" : ""}" data-voice title="${ctx.recording ? "말하기 끝" : "말하기"}" aria-label="${ctx.recording ? "말하기 끝" : "말하기"}" aria-pressed="${ctx.recording}">${ICON.mic}</button><button class="ic go" data-go="${id}" title="넣기" aria-label="넣기">${ICON.send}</button></div>`,
  bubble: (ctx, m: ChatMessage) => {
    if (m.who === "me") {
      const body = m.kind === "photo" || m.kind === "file" ? `<div class="photo">${esc(m.fileName ?? "파일")}</div>${m.text ? `<div>${esc(m.text)}</div>` : ""}` : m.kind === "voice" ? `<div class="voice">▶ 음성 메모</div>${m.text ? `<div>${esc(m.text)}</div>` : ""}` : esc(m.text);
      return `<div class="bub me">${body}</div>${m.src ? `<div class="bsrc me">${esc(m.src)} · ${m.at.slice(11)}</div>` : ""}`;
    }
    return `<div class="bub ai ${m.error ? "err" : ""}">${esc(m.text)}${chatCards(ctx, m, fd)}</div>`;
  },
  alarm: (a: Alarm) => `<div class="al-in" role="alertdialog" aria-labelledby="alTitle"><div class="al-kind">${a.kind === "event" ? "일정" : "할 일"} 알람 · ${a.at.slice(11)}</div><div class="al-ring">${ICON.logo}</div><div class="al-title" id="alTitle">${esc(a.title)}</div><div class="al-body">${esc(a.body)}</div><div class="al-btns"><div><button class="al-b" data-alarm="snooze" aria-label="10분 뒤">${ICON.snooze}</button><span>10분 뒤</span></div><div><button class="al-b ok" data-alarm="done" aria-label="${a.kind === "task" ? "완료" : "확인"}">${ICON.check}</button><span>${a.kind === "task" ? "완료" : "확인"}</span></div></div><div class="al-hint">누를 때까지 소리가 계속됩니다</div></div>`,
  more: (n) => `+${n}`,
  monthChip: (ctx, kind, x) => {
    if (kind === "event") {
      const e = x as unknown as CalEvent;
      // 「15:00–17:00 제목」 (user's direct instruction): the time range in front.
      return `<span class="c ${e.area} ${e.provisional ? "prov" : ""} ${e.draft ? "draft" : ""}">${e.start ? `<span class="ct">${e.start}${e.end ? "–" + e.end : ""}</span> ` : ""}${esc(e.title)}</span>`;
    }
    if (kind === "task") {
      const t = x as unknown as Task;
      const b = dueBadge(ctx.today, t);
      // 안 A: a dot says 「deadline」 (red when today or late), the title, details on hover.
      return `<span class="c task due mdot ${b?.hot ? "hot" : ""} ${t.done ? "done" : ""} ${t.draft ? "draft" : ""}" title="${esc(`마감 ${t.dueTime ? t.dueTime + " " : ""}${t.title}${b ? ` · ${b.text}` : ""}`)}">${esc(t.title)}</span>`;
    }
    const p = x as unknown as Period;
    return `<span class="pb ${p.area}" title="${esc(`${p.title} ${fd(p.from)}–${fd(p.to)}`)}">${esc(p.title)}</span>`;
  }
};
