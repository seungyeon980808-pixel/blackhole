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

export function detailHTML(ctx: Ctx, id: string, fd: (k: string) => string): string {
  const x = findEntry(ctx.s, id) as Entry | undefined;
  if (!x || x.gone) return "";
  const field = (label: string, body: string) => `<label class="df"><span class="dl2">${label}</span>${body}</label>`;
  const seg = (attr: string, opts: [string, string][], on: string) => `<span class="dseg" role="group">${opts.map(([v, t]) => `<button type="button" ${attr}="${v}" class="${v === on ? "on" : ""}" aria-pressed="${v === on}">${t}</button>`).join("")}</span>`;
  const rows: string[] = [];
  rows.push(`<textarea class="d-title" data-df="title" rows="2" aria-label="제목" spellcheck="false">${esc(x.title)}</textarea>`);
  if (x.review?.length) rows.push(`<div class="dwarn">※ ${esc(x.review.join(" · "))}</div>`);
  if (x.suggest?.length) rows.push(`<div class="doffer">${aiOffer(x, fd)}</div>`);
  if (x.kind === "event" || x.kind === "task") rows.push(field("종류", seg("data-dkind", [["event", "일정"], ["task", "할 일"]], x.kind)));
  if (x.kind === "event") {
    rows.push(field("날짜", `<input type="date" data-df="date" value="${x.date}">`));
    rows.push(field("시각", `<input class="ed-h" data-df="time" value="${x.start ? `${x.start}${x.end ? "~" + x.end : ""}` : ""}" placeholder="1320~1405 · 비우면 종일" title="1620, 16:20~17:30처럼 · ↑↓ 10분" autocomplete="off" spellcheck="false">`));
  } else if (x.kind === "task") {
    rows.push(field("마감", `<input type="date" data-df="date" value="${x.noDue ? "" : x.due}">`));
    rows.push(field("시각", `<input class="ed-h" data-df="time" value="${x.dueTime ?? ""}" placeholder="1620 · 비우면 시각 없음" title="1620처럼 · ↑↓ 10분" autocomplete="off" spellcheck="false">`));
  } else if (x.kind === "period") {
    rows.push(field("기간", `<span class="drow"><input type="date" data-df="from" value="${x.from}"><span>~</span><input type="date" data-df="to" value="${x.to}"></span>`));
  }
  if (x.kind === "event" || x.kind === "task") {
    const day = x.kind === "event" ? x.date : x.due;
    rows.push(field("알림", `<span class="drem">${x.reminders.map((r, i) => `<span class="dchip">${esc(remLabel(r, day))}<button type="button" data-drem="${i}" title="이 알림 지우기" aria-label="알림 지우기">×</button></span>`).join("")}<input data-df="rem" placeholder="+ 15:30 · 30분 전 · 하루 전" autocomplete="off" spellcheck="false" aria-label="알림 더하기"></span>`));
  }
  if (x.kind === "note") {
    const tags = tagsOf(x);
    rows.push(field("태그", `<span class="drem">${tags.map((t) => `<span class="dchip">#${esc(t)}<button type="button" data-dtagdel="${esc(t)}" title="태그 지우기" aria-label="태그 지우기">×</button></span>`).join("")}<input data-df="tag" placeholder="+ 태그" autocomplete="off" spellcheck="false" aria-label="태그 더하기"></span>`));
  }
  const star = x.star ?? 0;
  rows.push(field("중요", `<span class="dseg dstar" role="group">${[0, 1, 2].map((n) => `<button type="button" data-dstar="${n}" class="${n === star ? "on" : ""} s${n}" aria-pressed="${n === star}" title="${["보통", "중요(노랑)", "아주 중요(빨강)"][n]}">${n ? "★" : "☆"}</button>`).join("")}</span>`));
  rows.push(field("영역", seg("data-darea", [["school", "학교"], ["personal", "개인"]], x.area)));
  if (x.kind === "task") {
    rows.push(`<div class="df col"><span class="dl2">하위 단계 ${x.subs.length ? `${x.subs.filter((t) => t.done).length}/${x.subs.length}` : ""}</span><div class="dsubs">${x.subs.map((t, i) => `<div class="dsub ${t.done ? "done" : ""}"><span class="bx" data-sub="${x.id}:${i}" role="checkbox" aria-checked="${t.done}" tabindex="0">${t.done ? "✓" : ""}</span><span class="st">${esc(t.title)}${t.ai ? '<span class="aisug">AI 제안</span>' : ""}</span>${i ? `<button type="button" data-dsubup="${i}" title="위로" aria-label="위로">↑</button>` : ""}<button type="button" data-dsubdel="${i}" title="지우기" aria-label="하위 단계 지우기">×</button></div>`).join("")}<input class="subadd on" data-subadd="${x.id}" placeholder="+ 하위 단계" aria-label="하위 단계 추가">${x.subs.some((t) => t.ai) ? '<button type="button" class="mini" data-dsubai>제안 단계 모두 지우기</button>' : ""}</div></div>`);
  }
  rows.push(field("메모", `<textarea data-df="details" rows="3" placeholder="자세한 내용" spellcheck="false">${esc(x.details ?? "")}</textarea>`));
  const said = originText(ctx, x.id);
  rows.push(`<div class="df col"><span class="dl2">출처</span><div class="dsrc">${esc(x.source)} · ${esc(fd(x.createdAt.slice(0, 10)))} ${esc(x.createdAt.slice(11, 16))}${said && said !== x.title ? `<div class="dsaid">「${esc(said)}」</div>` : ""}</div></div>`);
  const b = (attr: string, label: string, icon: string) => `<button type="button" class="ib" ${attr} title="${label}" aria-label="${label}">${icon}<span>${label}</span></button>`;
  const acts = [
    x.kind === "task" ? b(`data-tdone="${x.id}"`, x.done ? "완료 취소" : "완료", x.done ? ICON.undo : ICON.ok) : x.kind === "event" && x.provisional ? b(`data-ok="${x.id}"`, "확정", ICON.ok) : "",
    x.kind !== "note" ? b(`data-moveto="${x.id}"`, "날짜 옮기기", ICON.move) : b(`data-convert="event|d|${x.id}"`, "일정으로", ICON.cal) + b(`data-convert="task|d|${x.id}"`, "할 일로", ICON.todo),
    (x.kind === "event" && x.start) || (x.kind === "task" && x.dueTime) ? b(`data-droutine="${x.id}"`, "루틴으로", ICON.swap) : "",
    b(`data-ddup="${x.id}"`, "복제", ICON.copy),
    b(`data-no="${x.id}"`, "지우기", ICON.x)
  ].filter(Boolean);
  return `<div class="dph"><b>${KIND[x.kind]}</b>${x.draft ? '<span class="dr">초안</span>' : ""}<span class="dhint">바꾸면 바로 저장 · ⌘Z 되돌리기</span><button type="button" class="ib" data-dclose title="닫기 (Esc)" aria-label="닫기">${ICON.x}</button></div>
    <div class="dbody">${rows.join("")}</div>
    <div class="dacts">${acts.join("")}</div>`;
}
