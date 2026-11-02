/**
 * 상세 편집 패널 (2026-10-28 사용자 지적: 작은 카드의 단추가 글자를 덮고 고칠 수가 없음).
 * Hover = preview only (tipHTML). A click opens this panel where the chat panel sits (the
 * calendar and lists stay uncovered); every field saves when it changes, one ⌘Z each.
 */
import type { Entry } from "../model";
import { findEntry } from "../store";
import { tagsOf } from "../tags";
import { aiOffer, esc, ICON, type Ctx } from "./common";

const KIND = { event: "일정", task: "할 일", period: "기간", note: "기억" } as const;

/** Where it came from: the words the user put in (the chat line before the answer that made it). */
export function originText(ctx: Ctx, id: string): string {
  const i = ctx.s.chat.findIndex((m) => m.who === "ai" && m.refs?.includes(id));
  for (let j = i - 1; j >= 0 && i >= 0; j--) if (ctx.s.chat[j].who === "me") return ctx.s.chat[j].text;
  return "";
}

/** A reminder stamp said for the box: 「15:30」 on the entry's own day, else 「10/27 15:30」. */
function remLabel(r: string, day: string): string {
  return r.slice(0, 10) === day ? r.slice(11) : `${+r.slice(5, 7)}/${+r.slice(8, 10)} ${r.slice(11)}`;
}

/**
 * 「언제」 묶음 (11-02 시안 11: 「좀 깔끔하고 직관적으로」): 맨 위 한 줄 요약(날짜·시각 · D-n · 길이), 말로 고치기,
 * 오늘·내일·모레·다음 주 월 단추와 「날짜 고르기 ▾」(달력은 눌렀을 때만), 시각 칸 + 「교시 ▾」 하나, 길이 셋, 알림.
 */
function whenHTML(ctx: Ctx, x: Entry & { kind: "event" | "task" }, month: string, today: string, fd: (k: string) => string, calOpen: boolean, alarm: string): string {
  const day = x.kind === "event" ? x.date : x.noDue ? "" : x.due;
  const time = x.kind === "event" ? x.start : x.dueTime;
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const at = (k: string) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
  const add = (k: string, n: number) => ymd(new Date(at(k).getFullYear(), at(k).getMonth(), at(k).getDate() + n));
  const dow = at(today).getDay();
  const quick: [string, string][] = [[today, "오늘"], [add(today, 1), "내일"], [add(today, 2), "모레"], [add(today, ((8 - dow) % 7) || 7), "다음 주 월"]];
  const chip = (attr: string, label: string, on: boolean, title = "") => `<button type="button" class="pk ${on ? "on" : ""}" ${attr}${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
  const quickRow = quick.map(([d, t]) => chip(`data-dday="${d}"`, t, d === day)).join("") + (x.kind === "task" ? chip("data-dnodue", "날짜 없음", !day) : "") + `<button type="button" class="pk ghost" data-dcal aria-expanded="${calOpen}">날짜 고르기 ${calOpen ? "▴" : "▾"}</button>`;
  let cal = "";
  if (calOpen) {
    // The month: Monday first like the 월 view (11-02), the days of the other months faint; a dot count = entries already that day.
    const y = +month.slice(0, 4);
    const m = +month.slice(5, 7) - 1;
    const first = new Date(y, m, 1);
    const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7));
    const busy = new Map<string, number>();
    for (const e of ctx.s.events) if (!e.gone && e.id !== x.id) busy.set(e.date, (busy.get(e.date) ?? 0) + 1);
    for (const t of ctx.s.tasks) if (!t.gone && !t.done && !t.noDue && t.id !== x.id) busy.set(t.due, (busy.get(t.due) ?? 0) + 1);
    const cells: string[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i === 35 && d.getMonth() !== m) break;
      const k = ymd(d);
      const n = busy.get(k) ?? 0;
      cells.push(`<button type="button" class="pd ${d.getMonth() !== m ? "out" : ""} ${k === today ? "now" : ""} ${k === day ? "on" : ""} ${d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : ""}" data-dday="${k}" title="${n ? `${n}개 있음` : "비어 있음"}">${d.getDate()}${n ? `<i>${n > 3 ? "•••" : "•".repeat(n)}</i>` : ""}</button>`);
    }
    cal = `<div class="pcal"><div class="pch"><button type="button" class="ib" data-dmon="-1" aria-label="이전 달">‹</button><b>${y}년 ${m + 1}월</b><button type="button" class="ib" data-dmon="1" aria-label="다음 달">›</button></div><div class="pgw">${"월화수목금토일".split("").map((c) => `<span>${c}</span>`).join("")}</div><div class="pgd">${cells.join("")}</div></div>`;
  }
  // This school's periods (설정), lunch and the end of the day: one 「교시 ▾」.
  const st = ctx.s.settings;
  const opts: [string, string][] = [...st.periods.map((p, i): [string, string] => [p, `${i + 1}교시 ${p.slice(0, 5)}`]), [st.lunch, "점심"], [st.offWork, "퇴근 전"]];
  const sel = `<select class="dper" data-dtimesel aria-label="교시"><option value="">교시 ▾</option>${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`;
  const timeIn = x.kind === "event"
    ? `<input class="ed-h" data-df="time" value="${x.start ? `${x.start}${x.end ? "~" + x.end : ""}` : ""}" placeholder="1320~1405 · 비우면 종일" title="1620, 16:20~17:30처럼 · ↑↓ 10분" autocomplete="off" spellcheck="false">`
    : `<input class="ed-h" data-df="time" value="${x.dueTime ?? ""}" placeholder="1620 · 비우면 시각 없음" title="1620처럼 · ↑↓ 10분" autocomplete="off" spellcheck="false">`;
  const lens = x.kind === "event" && x.start ? [[30, "30분"], [60, "1시간"], [120, "2시간"]].map(([n, t]) => chip(`data-dlen="${n}"`, String(t), !!x.end && mins(x.end) - mins(x.start!) === n)).join("") : "";
  const lenRow = `<span class="dl2"></span><span class="prow">${lens}${chip("data-dnotime", x.kind === "event" ? "종일" : "시각 없음", !time).replace('class="pk', 'class="pk ghost')}</span>`;
  // The line on top: what and when first (「11/8(일) 07:30–16:30 · D-6 · 9시간」).
  const dd = day ? Math.round((at(day).getTime() - at(today).getTime()) / 864e5) : null;
  const dtext = dd === null ? "" : dd === 0 ? "오늘" : dd > 0 ? `D-${dd}` : `${-dd}일 지남`;
  const len = x.kind === "event" && x.start && x.end ? mins(x.end) - mins(x.start) : 0;
  const ltext = len > 0 ? (len % 60 ? (len > 60 ? `${Math.floor(len / 60)}시간 ${len % 60}분` : `${len}분`) : `${len / 60}시간`) : "";
  const now = !day ? "날짜 없음" : `${fd(day)} ${x.kind === "event" ? (x.start ? `${x.start}${x.end ? "–" + x.end : ""}` : "종일") : x.dueTime ? `${x.dueTime}까지` : "까지"}`;
  const small = [dtext, ltext].filter(Boolean).join(" · ");
  return `<div class="dsec dpick"><h4>언제</h4>
    <div class="pnow"><b>${esc(now)}</b>${small ? `<small>${esc(small)}</small>` : ""}</div>
    <input class="pwhen" data-df="when" placeholder="말로 고치기 — 내일 3교시 · 다음 주 화 4시 · 1105 1530" autocomplete="off" spellcheck="false" aria-label="날짜와 시각을 말로">
    <div class="prow">${quickRow}</div>
    ${cal}
    <div class="dgrid"><span class="dl2">${x.kind === "event" ? "시각" : "마감"}</span><span class="drow">${timeIn}${sel}</span>${lenRow}<span class="dl2">알림</span>${alarm}</div>
  </div>`;
}
const mins = (hm: string) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);

export function detailHTML(ctx: Ctx, id: string, fd: (k: string) => string, month?: string, today?: string, side = false): string {
  const x = findEntry(ctx.s, id) as Entry | undefined;
  if (!x || x.gone) return "";
  const field = (label: string, body: string) => `<label class="df"><span class="dl2">${label}</span>${body}</label>`;
  const seg = (attr: string, opts: [string, string][], on: string) => `<span class="dseg" role="group">${opts.map(([v, t]) => `<button type="button" ${attr}="${v}" class="${v === on ? "on" : ""}" aria-pressed="${v === on}">${t}</button>`).join("")}</span>`;
  const rows: string[] = [];
  // 끝냄 is the box by the title (Todoist, Apple 미리 알림): never mistaken for closing the panel (2026-10-29).
  const box = x.kind === "task" ? `<button type="button" class="dchk ${x.done ? "on" : ""}" data-tdone="${x.id}" role="checkbox" aria-checked="${x.done}" title="${x.done ? "끝냄 취소" : "끝냄으로 체크"}" aria-label="끝냄">${x.done ? "✓" : ""}</button>` : "";
  rows.push(`<div class="dtitle">${box}<textarea class="d-title" data-df="title" rows="2" aria-label="제목" spellcheck="false">${esc(x.title)}</textarea></div>`);
  // 띠 이름: what the 주요 일정 띠 writes (6 letters; 11-02 사용자), right under the title. Not for 기억.
  if (x.kind !== "note") rows.push(`<label class="dshort"><span>띠 이름</span><input class="d-short" data-df="short" value="${esc(x.short ?? "")}" maxlength="10" placeholder="비우면 제목 앞 6글자" aria-label="띠 이름" spellcheck="false"></label>`);
  if (x.review?.length) rows.push(`<div class="dwarn">※ ${esc(x.review.join(" · "))}</div>`);
  if (x.suggest?.length) rows.push(`<div class="doffer">${aiOffer(x, fd)}</div>`);
  if (x.kind === "event" || x.kind === "task") {
    const day = x.kind === "event" ? x.date : x.due;
    const alarm = `<span class="drem">${x.reminders.map((r, i) => `<span class="dchip">${esc(remLabel(r, day))}<button type="button" data-drem="${i}" title="이 알림 지우기" aria-label="알림 지우기">×</button></span>`).join("")}<input data-df="rem" placeholder="+ 15:30 · 30분 전 · 하루 전" autocomplete="off" spellcheck="false" aria-label="알림 더하기"></span>`;
    const t = today ?? day;
    rows.push(whenHTML(ctx, x, month ?? (x.kind === "task" && x.noDue ? t : day).slice(0, 7), t, fd, !!ctx.open?.has("dcal"), alarm));
  } else if (x.kind === "period") {
    rows.push(`<div class="dsec"><h4>언제</h4>${field("기간", `<span class="drow"><input type="date" data-df="from" value="${x.from}"><span>~</span><input type="date" data-df="to" value="${x.to}"></span>`)}</div>`);
  }
  const tidy: string[] = [];
  if (x.kind === "note") {
    const tags = tagsOf(x);
    tidy.push(field("태그", `<span class="drem">${tags.map((t) => `<span class="dchip">#${esc(t)}<button type="button" data-dtagdel="${esc(t)}" title="태그 지우기" aria-label="태그 지우기">×</button></span>`).join("")}<input data-df="tag" placeholder="+ 태그" autocomplete="off" spellcheck="false" aria-label="태그 더하기"></span>`));
  }
  const star = x.star ?? 0;
  tidy.push(field("중요", `<span class="dseg dstar" role="group">${[0, 1, 2].map((n) => `<button type="button" data-dstar="${n}" class="${n === star ? "on" : ""} s${n}" aria-pressed="${n === star}" title="${["보통", "중요(노랑)", "아주 중요(빨강)"][n]}">${n ? "★" : "☆"}</button>`).join("")}</span>`));
  tidy.push(field("영역", seg("data-darea", [["school", "학교"], ["personal", "개인"]], x.area)));
  if (x.kind === "task") tidy.push(field("기다림", `<input data-df="wait" value="${esc(x.wait ?? "")}" placeholder="먼저 있어야 할 일 · 비우면 없음" autocomplete="off" spellcheck="false">`));
  if (x.kind === "task") {
    tidy.push(`<div class="df col"><span class="dl2">하위 단계 ${x.subs.length ? `${x.subs.filter((t) => t.done).length}/${x.subs.length}` : ""}</span><div class="dsubs">${x.subs.map((t, i) => `<div class="dsub ${t.done ? "done" : ""}"><span class="bx" data-sub="${x.id}:${i}" role="checkbox" aria-checked="${t.done}" tabindex="0">${t.done ? "✓" : ""}</span><span class="st">${esc(t.title)}${t.ai ? '<span class="aisug">AI 제안</span>' : ""}</span>${i ? `<button type="button" data-dsubup="${i}" title="위로" aria-label="위로">↑</button>` : ""}<button type="button" data-dsubdel="${i}" title="지우기" aria-label="하위 단계 지우기">×</button></div>`).join("")}<input class="subadd on" data-subadd="${x.id}" placeholder="+ 하위 단계" aria-label="하위 단계 추가">${x.subs.some((t) => t.ai) ? '<button type="button" class="mini" data-dsubai>제안 단계 모두 지우기</button>' : ""}</div></div>`);
  }
  tidy.push(field("메모", `<textarea data-df="details" rows="3" placeholder="자세한 내용" spellcheck="false">${esc(x.details ?? "")}</textarea>`));
  rows.push(`<div class="dsec"><h4>정리</h4>${tidy.join("")}</div>`);
  // 출처: folded to one line (the words said open under it).
  const said = originText(ctx, x.id);
  const from = `출처 · ${esc(x.source)} · ${esc(fd(x.createdAt.slice(0, 10)))} ${esc(x.createdAt.slice(11, 16))}`;
  rows.push(said && said !== x.title ? `<details class="dsrc"><summary>${from}</summary><div class="dsaid">「${esc(said)}」</div></details>` : `<div class="dsrc">${from}</div>`);
  const b = (attr: string, label: string, icon: string) => `<button type="button" class="ib" ${attr} title="${label}" aria-label="${label}">${icon}<span>${label}</span></button>`;
  const acts = [
    x.kind === "event" && x.provisional ? b(`data-ok="${x.id}"`, "확정", ICON.ok) : "",
    x.kind !== "note" ? b(`data-moveto="${x.id}"`, "날짜 옮기기", ICON.move) : b(`data-convert="event|d|${x.id}"`, "일정으로", ICON.cal) + b(`data-convert="task|d|${x.id}"`, "할 일로", ICON.todo),
    (x.kind === "event" && x.start) || (x.kind === "task" && x.dueTime) ? b(`data-droutine="${x.id}"`, "루틴으로", ICON.swap) : "",
    b(`data-ddup="${x.id}"`, "복제", ICON.copy),
    b(`data-no="${x.id}"`, "지우기", ICON.x)
  ].filter(Boolean);
  // 종류 (일정 · 할 일) sits in the top line; 기간 · 기억 just say what they are.
  const kind = x.kind === "event" || x.kind === "task" ? seg("data-dkind", [["event", "일정"], ["task", "할 일"]], x.kind) : `<b>${KIND[x.kind]}</b>`;
  // Over the chat panel, closing it brings the chat back (11-02 사용자: 「어떻게 해야 다시 대화창으로」).
  return `<div class="dph">${kind}${x.draft ? '<span class="dr">초안</span>' : ""}<span class="dhint">✓ 자동 저장 · ⌘Z</span><button type="button" class="ib" data-dclose title="닫기 (Esc)" aria-label="닫기">${ICON.x}</button></div>
    <div class="dbody">${rows.join("")}</div>
    <div class="dacts">${acts.join("")}<button type="button" class="dclose2" data-dclose title="닫기 (Esc)">${side ? "← 대화로" : "닫기"}</button></div>`;
}
