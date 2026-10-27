import { holiday } from "../holidays";
/** 공문서 테마 and the A4 print sheet. Markup follows design/calendar-glass/prototype-doc.html. */
import { addDays, diffDays, fdDoc, fdDocLong, mins, parseDay, weekDays, ymd } from "../dates";
import type { CalEvent, ChatMessage, Period, Task } from "../model";
import { alarmsOn, dueOn, eventsOn, findEntry, liveEvents, livePeriods, liveTasks, pending, periodsOn, taskGroups, type Alarm } from "../store";
import { aiOffer, dday, draftTag, dueBadge, dueMarks, esc, hourSegments, ICON, KIND_WORD, chatCards, checksBar, inputHint, lazyFold, needsReview, nextReminder, pct, todayResults, type Ctx, type ThemeView } from "./common";

const fd = fdDoc;
const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ"];
const sec = (n: number, title: string, right = "") => `<div class="sec"><span class="no">${ROMAN[n]}</span><span class="st">${title}<small>${right}</small></span></div>`;

function taskHTML(ctx: Ctx, t: Task, subAdd = true): string {
  const sd = t.subs.filter((x) => x.done).length;
  const nr = nextReminder(ctx, t);
  const n = diffDays(ctx.today, t.due);
  const meta = [
    t.dueTime || n > 0 ? `${n === 0 ? "" : fd(t.due) + " "}${t.dueTime ?? ""}까지`.replace(" 까지", "까지") : "",
    nr ? `알림 ${nr.slice(0, 10) === ctx.today ? "" : fd(nr.slice(0, 10)) + " "}${nr.slice(11)}` : "",
    t.subs.length ? `하위 ${sd}/${t.subs.length}` : ""
  ].filter(Boolean).join(", ");
  return `<div class="task ${t.done ? "done" : ""}">
    <div class="li l1 ${t.done ? "done" : ""}"><span class="mk" data-tdone="${t.id}" role="checkbox" aria-checked="${t.done}" tabindex="0" aria-label="${esc(t.title)} 완료">${t.done ? "■" : "□"}</span><span class="tx">${esc(t.title)}${draftTag(t)}</span>${t.noDue ? "" : dday(ctx.today, t)}</div>
    ${t.subs.map((x, i) => `<div class="li l2 ${x.done ? "done" : ""}"><span class="mk" data-sub="${t.id}:${i}" role="checkbox" aria-checked="${x.done}" tabindex="0">${x.done ? "●" : "○"}</span><span class="tx">${esc(x.title)}</span></div>`).join("")}
    ${(meta || t.suggest?.length) && !t.done ? `<div class="li l3">- ${esc(meta)}${aiOffer(t, fd)}</div>` : ""}
    ${subAdd && !t.done ? `<input class="subadd" data-subadd="${t.id}" placeholder="○ 하위 할 일 추가" aria-label="${esc(t.title)} 하위 할 일 추가">` : ""}
  </div>`;
}

function evTable(ctx: Ctx, list: CalEvent[], { act = true, date = false } = {}): string {
  if (!list.length) return '<table class="tb"><tr><td class="muted center">해당 없음</td></tr></table>';
  return `<table class="tb"><thead><tr><th style="width:${date ? 92 : 82}px">${date ? "일시" : "시간"}</th><th>내용</th><th style="width:${act ? 110 : 70}px">비고</th></tr></thead><tbody>${list.map((e) => `<tr class="${e.date === ctx.today && e.end && mins(e.end) <= ctx.nowM ? "past" : ""}" data-ev="${e.id}"><td class="c">${date ? fd(e.date) + " " : ""}${e.start ?? "종일"}${date || !e.end ? "" : "~" + e.end}</td><td>${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}${draftTag(e)}${aiOffer(e, fd)}</td><td class="c">${e.provisional && act ? `<button class="mini" data-ok="${e.id}">확정</button><button class="mini" data-no="${e.id}">취소</button>` : e.reminders.length ? `알림 ${e.reminders.map((r) => r.slice(11)).join(", ")}` : ""}</td></tr>`).join("")}</tbody></table>`;
}

function perTable(ps: Period[], k: string): string {
  if (!ps.length) return "";
  const noDow = (s: string) => fd(s).replace(/\(.\)/, "");
  return `<table class="tb"><thead><tr><th>기간명</th><th style="width:120px">기간</th><th style="width:60px">경과</th></tr></thead><tbody>${ps.map((p) => `<tr><td>${esc(p.title)}</td><td class="c">${noDow(p.from)} ~ ${noDow(p.to)}</td><td class="c">${diffDays(p.from, k) + 1}/${diffDays(p.from, p.to) + 1}일</td></tr>`).join("")}</tbody></table>`;
}

export function docTimetable(ctx: Ctx, k: string, H0 = 7, H1 = 24, rowH = 24): string {
  const evs = eventsOn(ctx.s, k);
  const rems = alarmsOn(ctx.s, k, fd);
  const dues = dueOn(ctx.s, k);
  const allDayDue = dues.filter((t) => !t.dueTime);
  let h = `${allDayDue.length ? `<div class="dueday">마감 ${allDayDue.map((t) => `<span class="${dueBadge(ctx.today, t)?.hot ? "red" : ""} ${t.done ? "done" : ""}" data-ev="${t.id}">${esc(t.title)}</span>`).join(", ")}</div>` : ""}<div class="mh0">시</div>${[10, 20, 30, 40, 50, 60].map((x) => `<div class="mh">${x}</div>`).join("")}`;
  for (let H = H0; H < H1; H++) {
    const A = H * 60;
    const B = A + 60;
    let r = "<i></i><i></i><i></i><i></i><i></i><i></i>";
    for (const g of hourSegments(evs, H)) {
      r += `<div class="bk ${g.area} ${g.provisional ? "prov" : ""} ${g.half}" data-ev="${g.id}" style="left:${pct(g.s, A)};width:${(((g.en - g.s) / 60) * 100).toFixed(3)}%" title="${esc(g.range.replace("–", "~") + " " + g.title)}">${g.first ? esc(g.title) : ""}</div>`;
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

function weekTable(ctx: Ctx, days: string[]): string {
  return `<table class="tb week"><thead><tr><th style="width:84px">일자</th><th>일정</th><th style="width:30%">할 일(마감)</th><th style="width:22%">비고</th></tr></thead><tbody>${days.map((k) => {
    const evs = eventsOn(ctx.s, k);
    const ts = dueOn(ctx.s, k);
    const ps = periodsOn(ctx.s, k);
    const rs = alarmsOn(ctx.s, k, fd);
    return `<tr class="${k === ctx.today ? "today" : ""}" data-day="${k}"><td class="c b">${fd(k)}</td><td>${evs.map((e) => `<div data-ev="${e.id}"><span class="t">${e.start ?? "종일"}</span> ${esc(e.title)}${e.provisional ? '<span class="ga">가</span>' : ""}</div>`).join("") || '<span class="muted">-</span>'}</td><td>${ts.map((t) => { const b = dueBadge(ctx.today, t); return `<div class="${t.done ? "done" : ""}" data-ev="${t.id}"><span class="tx">${t.done ? "■" : "□"} ${t.dueTime ? `<span class="t">${t.dueTime}</span> ` : ""}${esc(t.title)}</span>${t.subs.length ? ` <span class="muted">(${t.subs.filter((x) => x.done).length}/${t.subs.length})</span>` : ""}${b?.hot ? ` <span class="red sm">${b.text}</span>` : ""}</div>`; }).join("") || '<span class="muted">-</span>'}</td><td class="sm">${ps.map((p) => `${esc(p.title)}(${diffDays(p.from, k) + 1}/${diffDays(p.from, p.to) + 1}일)`).join("<br>")}${rs.length ? `${ps.length ? "<br>" : ""}알림 ${rs.map((r) => r.at.slice(11)).join(", ")}` : ""}</td></tr>`;
  }).join("")}</tbody></table>`;
}

export function docSummary(ctx: Ctx, k: string): string {
  const G = taskGroups(ctx.s, k);
  const all = [...G.today, ...G.week];
  return `일정 ${eventsOn(ctx.s, k).length}건 · 할 일 ${all.length}건(완료 ${all.filter((t) => t.done).length}건)${pending(ctx.s).length ? ` · 확정 대기 ${pending(ctx.s).length}건` : ""}${periodsOn(ctx.s, k).length ? ` · 진행 중 기간 ${periodsOn(ctx.s, k).length}건` : ""}`;
}

/** 검토 필요(빨강) · 확정 대기 · 오늘 처리 결과(접힘). Nothing → no section. */
function docInbox(ctx: Ctx, k: string, n: number): string {
  const review = needsReview(ctx);
  const failed = ctx.s.inbox.filter((x) => x.at.slice(0, 10) === ctx.today && x.state === "실패");
  // Today's and tomorrow's provisional events already sit in their own tables with 확정/취소.
  const tom = ymd(addDays(parseDay(k), 1));
  const pend = pending(ctx.s).filter((e) => e.date !== k && e.date !== tom);
  const done = todayResults(ctx);
  const raw = ctx.s.inbox.filter((x) => x.at.slice(0, 10) === ctx.today);
  if (!review.length && !failed.length && !pend.length && !done.length) return "";
  return `<div class="blk">${sec(n, "접수 결과")}
    ${review.length || failed.length ? `<div class="grp red">검토 필요 ${review.length + failed.length}건</div>${review.map((x) => `<div class="li l2" data-ev="${x.id}">○ [${KIND_WORD[x.kind]}] ${esc(x.title)} <span class="muted sm">${esc(x.review!.join(" · "))}</span></div>`).join("")}${failed.map((x) => `<div class="li l2">○ [실패] ${esc(x.out || x.title)}</div>`).join("")}` : ""}
    ${pend.length ? `<div class="grp">확정 대기 ${pend.length}건</div>${evTable(ctx, pend, { date: true })}` : ""}
    ${done.length ? `<details class="fold"><summary>오늘 처리 ${done.length}건</summary>${done.map((x) => `<div class="li l2" data-ev="${x.id}">○ [${KIND_WORD[x.kind]}] ${esc(x.title)}</div>`).join("")}
      ${raw.length ? `<details class="fold tech"><summary>자세히</summary><table class="tb mt6"><thead><tr><th style="width:48px">시각</th><th>접수 자료</th><th style="width:70px">상태</th></tr></thead><tbody>${raw.slice().reverse().map((x) => `<tr><td class="c">${x.at.slice(11)}</td><td>${esc(x.title)} <span class="muted sm">(${esc(x.src)})</span></td><td class="c">${x.state}</td></tr>`).join("")}</tbody></table></details>` : ""}</details>` : ""}
  </div>`;
}


export const doc: ThemeView = {
  fd,
  shell: (ctx) => `
    <div class="tool" data-tauri-drag-region><button class="btn ibn" data-nav="-1" aria-label="이전" title="이전 (←)">‹</button><button class="btn ibn" data-nav="1" aria-label="다음" title="다음 (→)">›</button><button class="btn ibn today" data-nav="0" aria-label="오늘로" title="오늘로 (T)">${ICON.today}</button><span class="sp"></span>
      <label class="find" title="찾기 (⌘F) · 내 기록에서만, 0원">${ICON.find}<input id="bhFind" type="search" placeholder="찾기 · 기억·할 일·일정" autocomplete="off" spellcheck="false" aria-label="찾기" aria-controls="bhFindRes"><kbd>⌘F</kbd></label><span class="nowline" id="bhNowLine" aria-live="off"></span>
      <span class="conn" title="${esc(ctx.connection.detail)}" data-testid="connection">${esc(ctx.connection.label)}</span>
      <span class="seg" role="group" aria-label="보기"><button class="btn" data-v="month">월</button><button class="btn" data-v="week">주</button><button class="btn" data-v="day">일</button><button class="btn" data-v="pri">우선순위</button><button class="btn" data-v="memo">기억</button></span><button class="btn ibn" data-print title="출력 (⌘P)" aria-label="출력">${ICON.print}</button><button class="btn ibn" data-settings aria-haspopup="dialog" title="설정 (⌘,)" aria-label="설정">${ICON.gear}</button></div>
    <div class="head"><div class="dtitle" id="bhTitle" data-nav="0" title="눌러서 오늘로 (T)"></div><div class="summary" id="bhSum"></div></div>
    <main class="content" id="bhMain"></main>
    <footer class="composer" id="bhComp"></footer>`,
  head: (ctx) => {
    const c = ctx.cur;
    const k = ymd(c);
    if (ctx.view === "month") {
      const prefix = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}`;
      const inMonth = (d: string) => d.startsWith(prefix);
      return {
        title: `${c.getFullYear()}년 ${c.getMonth() + 1}월 일정`,
        summary: `일정 ${liveEvents(ctx.s).filter((e) => inMonth(e.date)).length}건 · 마감 ${liveTasks(ctx.s).filter((t) => inMonth(t.due)).length}건 · 기간 ${livePeriods(ctx.s).filter((p) => p.from.slice(0, 7) <= prefix && p.to.slice(0, 7) >= prefix).length}건`
      };
    }
    if (ctx.view === "week") {
      const w = weekDays(c);
      return {
        title: `주간 업무 계획 (${fd(w[0])} ~ ${fd(w[6])})`,
        summary: `일정 ${w.reduce((n, x) => n + eventsOn(ctx.s, x).length, 0)}건 · 마감 ${w.reduce((n, x) => n + dueOn(ctx.s, x).length, 0)}건${pending(ctx.s).length ? ` · 확정 대기 ${pending(ctx.s).length}건` : ""}`
      };
    }
    return { title: `${fdDocLong(k)}${holiday(k) ? `(${holiday(k)})` : ""} 일일 현황`, summary: docSummary(ctx, k) };
  },
  day: (ctx) => {
    // 안 A for 공문서 (recommended): today's appointments as one full-width table on top (time,
    // what, note — nothing cut, rows wrap), below 할 일 | 내일·기간. Rows open their card.
    const k = ymd(ctx.cur);
    const G = taskGroups(ctx.s, k);
    const ps = periodsOn(ctx.s, k);
    const tom = ymd(addDays(ctx.cur, 1));
    const none = '<div class="li l3">- 없음</div>';
    const rest = G.week.length + G.later.length;
    return `<div class="dday2">
      ${ctx.side ? "" : checksBar(ctx, fd)}
      <div class="blk dstrip">${sec(0, k === ctx.today ? "오늘 일정" : "일정", fd(k))}${evTable(ctx, eventsOn(ctx.s, k), { act: false })}</div>
      <div class="dcols">
        <div class="colx">${sec(1, "할 일", `${G.today.filter((t) => t.done).length}/${G.today.length} 완료`)}
          <div class="grp">가. 오늘까지</div>${[...G.today.filter((t) => !t.done), ...G.today.filter((t) => t.done)].map((t) => taskHTML(ctx, t)).join("") || none}
          ${rest ? lazyFold(ctx, "rest", [G.week.length ? `나. 7일 안 마감 ${G.week.length}` : "", G.later.length ? `다. 이후 ${G.later.length}` : ""].filter(Boolean).join(" · "), () => `${G.week.length ? `<div class="grp">나. 7일 안 마감</div>${G.week.map((t) => taskHTML(ctx, t)).join("")}` : ""}${G.later.length ? `<div class="grp">다. 이후</div>${G.later.map((t) => taskHTML(ctx, t, false)).join("")}` : ""}`) : ""}</div>
        <div class="colx">
          <div class="blk">${sec(2, "내일 일정", fd(tom))}${evTable(ctx, eventsOn(ctx.s, tom), { act: false })}</div>
          ${ps.length ? `<div class="blk">${sec(3, "진행 중 기간")}${perTable(ps, k)}</div>` : ""}
        </div>
      </div></div>`;
  },
  week: (ctx) => `<div class="colx full">${weekTable(ctx, weekDays(ctx.cur))}</div>`,
  composer: (ctx, id, inSheet) => `${inSheet ? "" : `<div class="grab" data-drag="open" title="끌어 올리면 대화 기록" role="button" tabindex="0" aria-label="대화 기록 열기"><i></i></div><div class="last" id="bhLast"></div>`}<div class="form tall"><textarea id="${id}" rows="1" autocomplete="off" spellcheck="false" aria-label="입력" placeholder="${esc(inputHint(ctx, id !== "bhIn"))}"></textarea><div class="inbar"><button class="ic sm" data-photo title="사진·파일" aria-label="사진·파일">${ICON.cam}</button><button class="ic sm ${ctx.recording ? "rec" : ""}" data-voice title="${ctx.recording ? "말하기 끝" : "말하기"}" aria-label="${ctx.recording ? "말하기 끝" : "말하기"}" aria-pressed="${ctx.recording}">${ICON.mic}</button><span class="ihint">Enter 넣기 · ⇧Enter 줄바꿈</span><button class="ic go sm" data-go="${id}" title="넣기 (Enter)" aria-label="넣기">${ICON.send}</button></div></div>`,
  bubble: (ctx, m: ChatMessage) => {
    if (m.who === "me") {
      const body = m.kind === "photo" || m.kind === "file" ? `<div class="photo">${esc(m.fileName ?? "파일")}</div>${m.text ? `<div>${esc(m.text)}</div>` : ""}` : m.kind === "voice" ? `<div class="voice">▶ 음성 메모</div>${m.text ? `<div>${esc(m.text)}</div>` : ""}` : esc(m.text);
      return `<div class="bub me">${body}</div>${m.src ? `<div class="bsrc me">${esc(m.src)} · ${m.at.slice(11)}</div>` : ""}`;
    }
    return `<div class="bub ai ${m.error ? "err" : ""}">${esc(m.text)}${chatCards(ctx, m, fd)}</div>`;
  },
  alarm: (a: Alarm) => `<div class="al-in" role="alertdialog" aria-labelledby="alTitle"><div class="al-head"><span>블랙홀 알람</span><span>${a.at.slice(11)}</span></div><div class="al-pad"><div class="al-kind">□ ${a.kind === "event" ? "일정" : "할 일"}</div><div class="al-title" id="alTitle">${esc(a.title)}</div><div class="al-body">- ${esc(a.body)}</div><div class="al-btns"><button class="al-b" data-alarm="snooze">10분 뒤</button><button class="al-b ok" data-alarm="done">${a.kind === "task" ? "완료" : "확인"}</button></div><div class="al-hint">※ 누를 때까지 소리가 계속됩니다</div></div></div>`,
  more: (n) => `외 ${n}건`,
  monthChip: (ctx, kind, x) => {
    if (kind === "event") {
      const e = x as unknown as CalEvent;
      return `<div class="e ${e.provisional ? "prov" : ""} ${e.draft ? "draft" : ""}"><span class="t">${e.start ?? "종일"}</span> ${esc(e.title)}</div>`;
    }
    if (kind === "task") {
      const t = x as unknown as Task;
      const b = dueBadge(ctx.today, t);
      return `<div class="e due ${t.done ? "done" : ""} ${b?.hot ? "red" : ""} ${t.draft ? "draft" : ""}">${t.done ? "■" : "□"} <span class="t">마감${t.dueTime ? " " + t.dueTime : ""}</span> ${esc(t.title)}${b ? ` <b>${b.text}</b>` : ""}</div>`;
    }
    const p = x as unknown as Period;
    return `<div class="pb" title="${esc(p.title)}">${esc(p.title)}</div>`;
  }
};

/* ---------- A4 print (공문서 양식, both themes) ---------- */

function printMonth(ctx: Ctx): string {
  const c = ctx.cur;
  const first = new Date(c.getFullYear(), c.getMonth(), 1);
  const s0 = addDays(first, -first.getDay());
  let h = `<table class="cal"><thead><tr>${[..."일월화수목금토"].map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>`;
  for (let w = 0; w < 6; w++) {
    h += "<tr>";
    for (let i = 0; i < 7; i++) {
      const d = addDays(s0, w * 7 + i);
      const k = ymd(d);
      const ps = periodsOn(ctx.s, k);
      const items = [
        ...eventsOn(ctx.s, k).map((e) => doc.monthChip(ctx, "event", e as unknown as Record<string, unknown>)),
        ...dueOn(ctx.s, k).map((t) => doc.monthChip(ctx, "task", t as unknown as Record<string, unknown>))
      ];
      h += `<td class="${d.getMonth() !== c.getMonth() ? "out" : ""} ${d.getDay() === 0 ? "sun" : ""}"><span class="n">${d.getDate()}</span>${ps.map((p) => `<div class="pb">${p.from === k || d.getDay() === 0 ? esc(p.title) : "&nbsp;"}</div>`).join("")}${items.slice(0, 8).join("")}${items.length > 8 ? `<div class="more">외 ${items.length - 8}건</div>` : ""}</td>`;
    }
    h += "</tr>";
  }
  return h + "</tbody></table>";
}

export function printSheet(ctx: Ctx): string {
  const c = ctx.cur;
  const k = ymd(c);
  if (ctx.view === "month") return `<div class="dtitle">${c.getFullYear()}년 ${c.getMonth() + 1}월 일정</div><div class="gap"></div><div class="pmonth">${printMonth(ctx)}</div><div class="foot">- 1 -</div>`;
  if (ctx.view === "week") {
    const w = weekDays(c);
    return `<div class="dtitle">주간 업무 계획 (${fd(w[0])} ~ ${fd(w[6])})</div><div class="gap"></div>${weekTable(ctx, w)}<div class="foot">- 1 -</div>`;
  }
  const G = taskGroups(ctx.s, k);
  return `<div class="dtitle">${fdDocLong(k)} 일일 현황</div><div class="summary">${docSummary(ctx, k)}</div><div class="gap"></div>
    <div class="cols"><div>${sec(0, "시간표", "10분 단위")}${docTimetable(ctx, k, 6, 24, 27)}</div><div>
      ${sec(1, "할 일")}<div class="grp">가. 오늘까지</div>${G.today.map((t) => taskHTML(ctx, t, false)).join("")}<div class="grp">나. 7일 안 마감</div>${G.week.map((t) => taskHTML(ctx, t, false)).join("")}
      <div class="gap"></div>${sec(2, "일정")}${evTable(ctx, eventsOn(ctx.s, k), { act: false })}
      <div class="gap"></div>${sec(3, "메모")}${Array.from({ length: 6 }, () => '<div class="line"></div>').join("")}
    </div></div><div class="foot">- 1 -</div>`;
}
