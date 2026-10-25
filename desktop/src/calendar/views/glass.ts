/** 유리 테마 (기본). Markup follows design/calendar-glass/prototype-glass.html. */
import { addDays, DOW, fdShort, mins, parseDay, ymd, diffDays } from "../dates";
import type { CalEvent, ChatMessage, Period, Task } from "../model";
import { alarmsOn, eventsOn, findEntry, pending, periodsOn, taskGroups, type Alarm } from "../store";
import { dday, esc, hourSegments, ICON, nextReminder, pct, subCount, type Ctx, type ThemeView } from "./common";

const fd = fdShort;
const none = '<div class="none">없음</div>';

export function timetable(ctx: Ctx, k: string, H0 = 7, H1 = 24, rowH = 28): string {
  const evs = eventsOn(ctx.s, k);
  const rems = alarmsOn(ctx.s, k, fd);
  let h = `<div class="mh0"></div>${[10, 20, 30, 40, 50, 60].map((x) => `<div class="mh">${x}</div>`).join("")}`;
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
    <div class="th"><span class="bx" data-tdone="${t.id}" role="checkbox" aria-checked="${t.done}" tabindex="0" aria-label="${esc(t.title)} 완료">${t.done ? "✓" : ""}</span><span class="t">${esc(t.title)}</span><span class="ml">${dday(ctx.today, t)}</span></div>
    ${meta ? `<div class="tm2">${esc(meta)}</div>` : ""}
    ${t.subs.length || showSubAdd ? `<div class="subs">${subs}${showSubAdd ? `<input class="subadd" data-subadd="${t.id}" placeholder="+ 하위 할 일" aria-label="${esc(t.title)} 하위 할 일 추가">` : ""}</div>` : ""}
  </div>`;
}

function okNo(id: string): string {
  return `<span class="act"><button class="mini" data-ok="${id}">확정</button><button class="mini" data-no="${id}">취소</button></span>`;
}

function evRow(e: CalEvent): string {
  return `<div class="ev" data-ev="${e.id}"><span class="dot d-${e.area}"></span><span class="tm">${e.start ? `${e.start}–${e.end}` : "종일"}</span><span class="evt">${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}${e.reminders.length ? ` <span class="rem">알림 ${esc(e.reminders.map((r) => r.slice(11)).join(", "))}</span>` : ""}</span>${e.provisional ? okNo(e.id) : ""}</div>`;
}

function perRow(p: Period, k: string): string {
  const total = diffDays(p.from, p.to) + 1;
  const nth = diffDays(p.from, k) + 1;
  return `<div class="prow"><div class="prow-h"><span>${esc(p.title)}</span><span class="sm">~${fd(p.to)} · ${nth}/${total}일</span></div><div class="pbar"><i style="width:${((nth / total) * 100).toFixed(1)}%"></i></div></div>`;
}

function refCard(ctx: Ctx, id: string): string {
  const x = findEntry(ctx.s, id);
  if (!x) return "";
  const kind = { event: "일정", task: "할 일", period: "기간", note: "기억" }[x.kind];
  const when =
    x.kind === "event" ? `${fd(x.date)} ${x.start ?? "종일"}` :
    x.kind === "task" ? `${fd(x.due)}${x.dueTime ? " " + x.dueTime : ""}까지${x.subs.length ? ` · 하위 ${x.subs.length}` : ""}` :
    x.kind === "period" ? `${fd(x.from)} ~ ${fd(x.to)}` : (x.details ?? "");
  const review = x.review?.length ? `<div class="rm2 warn">※ ${esc(x.review.join(" · "))}</div>` : "";
  const act = x.gone ? '<div class="rm2">취소됨</div>' :
    x.kind === "event" && x.provisional ? `<div class="ra"><button class="mini" data-ok="${x.id}">확정</button><button class="mini" data-no="${x.id}">취소</button></div>` :
    `<div class="ra"><button class="mini" data-no="${x.id}">되돌리기</button></div>`;
  return `<div class="rc ${x.gone ? "gone" : ""}"><b>${esc(x.title)}</b><div class="rm2">${kind}${when ? " · " + esc(when) : ""}</div>${review}${act}</div>`;
}

export const glass: ThemeView = {
  fd,
  shell: (ctx) => `
    <header class="bar" data-tauri-drag-region>
      <div class="title" id="bhTitle"></div>
      <button class="nb" data-nav="-1" aria-label="이전">‹</button><button class="nb" data-nav="1" aria-label="다음">›</button><button class="nb" data-nav="0">오늘</button>
      <span class="sp"></span>
      <span class="conn" title="${esc(ctx.connection.detail)}" data-testid="connection">${esc(ctx.connection.label)}</span>
      <div class="seg" role="group" aria-label="보기"><button data-v="month">월</button><button data-v="week">주</button><button data-v="day">일</button></div>
      <button class="nb" data-print>출력</button><button class="nb" data-settings aria-haspopup="dialog">설정</button>
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
    return { title: `${c.getMonth() + 1}월 ${c.getDate()}일 (${DOW[c.getDay()]})` };
  },
  day: (ctx) => {
    const k = ymd(ctx.cur);
    const G = taskGroups(ctx.s, k);
    const ps = periodsOn(ctx.s, k);
    const tom = ymd(addDays(ctx.cur, 1));
    const pend = pending(ctx.s).filter((e) => e.date !== k);
    const inbox = ctx.s.inbox.filter((x) => x.at.slice(0, 10) === ctx.today);
    return `<div class="day">
      <div class="ttwrap">${timetable(ctx, k)}</div>
      <div class="col2"><div class="box g grow">
        <h4>할 일</h4>
        <div class="grp">오늘까지 ${G.today.length}</div>${G.today.map((t) => taskHTML(ctx, t)).join("") || none}
        <div class="grp">7일 안 마감 ${G.week.length}</div>${G.week.map((t) => taskHTML(ctx, t)).join("") || none}
        <div class="grp">나중 ${G.later.length}</div>${G.later.map((t) => taskHTML(ctx, t, false)).join("")}
      </div></div>
      <div class="col2">
        ${ps.length ? `<div class="box g"><h4>기간</h4>${ps.map((p) => perRow(p, k)).join("")}</div>` : ""}
        <div class="box g"><h4>일정</h4>${eventsOn(ctx.s, k).map(evRow).join("") || none}
          <h4 class="mt">내일 · ${fd(tom)}</h4>${eventsOn(ctx.s, tom).map(evRow).join("") || none}</div>
        <div class="box g"><h4>확인 대기 ${pending(ctx.s).length}</h4>${pend.map((e) => `<div class="ev" data-ev="${e.id}"><span class="tm w96">${fd(e.date)} ${e.start ?? "종일"}</span><span class="evt">${esc(e.title)}</span>${okNo(e.id)}</div>`).join("") || none}
          ${k === ctx.today ? `<h4 class="mt">오늘 들어온 것 ${inbox.length} <small>${esc(ctx.inboxLine)}</small></h4>${inbox.slice().reverse().map((x) => `<div class="inb"><span class="tm">${x.at.slice(11)}</span><span>${esc(x.title)} <span class="s ${x.state === "실패" || x.state === "검토 필요" ? "warn" : ""}">${x.state === "완료" ? esc(x.out) : x.state}</span></span></div>`).join("")}` : ""}</div>
      </div></div>`;
  },
  week: () => null,
  composer: (ctx, id, inSheet) => `${inSheet ? "" : `<div class="grab" data-drag="open" title="끌어 올리면 대화 기록" role="button" tabindex="0" aria-label="대화 기록 열기"><i></i></div><div class="last" id="bhLast"></div>`}<div class="inp g"><input id="${id}" autocomplete="off" aria-label="입력" placeholder="${ctx.busy ? "분석 중…" : ""}"><button class="ic" data-photo title="사진·파일" aria-label="사진·파일">${ICON.cam}</button><button class="ic ${ctx.recording ? "rec" : ""}" data-voice title="${ctx.recording ? "말하기 끝" : "말하기"}" aria-label="${ctx.recording ? "말하기 끝" : "말하기"}" aria-pressed="${ctx.recording}">${ICON.mic}</button><button class="ic go" data-go="${id}" title="넣기" aria-label="넣기">${ICON.send}</button></div>`,
  bubble: (ctx, m: ChatMessage) => {
    if (m.who === "me") {
      const body = m.kind === "photo" || m.kind === "file" ? `<div class="photo">${esc(m.fileName ?? "파일")}</div>${m.text ? `<div>${esc(m.text)}</div>` : ""}` : m.kind === "voice" ? `<div class="voice">▶ 음성 메모</div>${m.text ? `<div>${esc(m.text)}</div>` : ""}` : esc(m.text);
      return `<div class="bub me">${body}</div>${m.src ? `<div class="bsrc me">${esc(m.src)} · ${m.at.slice(11)}</div>` : ""}`;
    }
    return `<div class="bub ai ${m.error ? "err" : ""}">${esc(m.text)}${(m.refs ?? []).map((r) => refCard(ctx, r)).join("")}</div>`;
  },
  alarm: (a: Alarm) => `<div class="al-in" role="alertdialog" aria-labelledby="alTitle"><div class="al-kind">${a.kind === "event" ? "일정" : "할 일"} 알람 · ${a.at.slice(11)}</div><div class="al-ring">${ICON.logo}</div><div class="al-title" id="alTitle">${esc(a.title)}</div><div class="al-body">${esc(a.body)}</div><div class="al-btns"><div><button class="al-b" data-alarm="snooze" aria-label="10분 뒤">${ICON.snooze}</button><span>10분 뒤</span></div><div><button class="al-b ok" data-alarm="done" aria-label="${a.kind === "task" ? "완료" : "확인"}">${ICON.check}</button><span>${a.kind === "task" ? "완료" : "확인"}</span></div></div><div class="al-hint">누를 때까지 소리가 계속됩니다</div></div>`,
  more: (n) => `+${n}`,
  monthChip: (ctx, kind, x) => {
    if (kind === "event") {
      const e = x as unknown as CalEvent;
      return `<span class="c ${e.area} ${e.provisional ? "prov" : ""}">${e.start ? `<span class="ct">${e.start.replace(/^0/, "")} </span>` : ""}${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}</span>`;
    }
    if (kind === "task") {
      const t = x as unknown as Task;
      return `<span class="c task ${t.done ? "done" : ""}">☐ ${esc(t.title)}${t.subs.length ? " " + subCount(t) : ""}</span>`;
    }
    const p = x as unknown as Period;
    return `<span class="pb ${p.area}" title="${esc(`${p.title} ${fd(p.from)}–${fd(p.to)}`)}">${esc(p.title)}</span>`;
  }
};
