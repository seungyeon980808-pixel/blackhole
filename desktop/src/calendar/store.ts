/**
 * Pure state operations. The UI calls these, then asks the adapter to save.
 */
import type { Proposal, ProposalItem } from "../worker/proposal";
import { addDays, diffDays, fdShort, fromStamp, isoToStamp, mins, nowHM, parseDay, stamp, ymd } from "./dates";
import { type Area, type CalEvent, type CalendarState, type Entry, type LogEntry, type Memo, type Period, type Suggestion, type Task, type UserAction } from "./model";
import { memoDraft, parseDraft, parseRule, singleTime, timeRange, timeWords } from "./rules";

export const newId = (s: CalendarState, prefix: string): string => `${prefix}-${s.nextId++}`;

const visible = (s: CalendarState) => (x: Entry) => !x.gone && (s.settings.showSamples || !x.sample);

export function liveEvents(s: CalendarState): CalEvent[] {
  return s.events.filter(visible(s));
}
export function liveTasks(s: CalendarState): Task[] {
  return s.tasks.filter(visible(s));
}
export function livePeriods(s: CalendarState): Period[] {
  return s.periods.filter(visible(s));
}

const byStart = (a: CalEvent, b: CalEvent) => (a.start ?? "").localeCompare(b.start ?? "");

export const eventsOn = (s: CalendarState, k: string): CalEvent[] => liveEvents(s).filter((e) => e.date === k).sort(byStart);
/** Deadlines on day k (to-dos given without a deadline stay in the checklist only). */
export const dueOn = (s: CalendarState, k: string): Task[] =>
  liveTasks(s).filter((t) => t.due === k && !t.noDue).sort((a, b) => (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"));
export const periodsOn = (s: CalendarState, k: string): Period[] => livePeriods(s).filter((p) => p.from <= k && k <= p.to);
export const pending = (s: CalendarState): CalEvent[] =>
  liveEvents(s).filter((e) => e.provisional).sort((a, b) => (a.date + (a.start ?? "")).localeCompare(b.date + (b.start ?? "")));

export function findEntry(s: CalendarState, id: string): Entry | undefined {
  return s.events.find((x) => x.id === id) ?? s.tasks.find((x) => x.id === id) ?? s.periods.find((x) => x.id === id) ?? s.notes.find((x) => x.id === id);
}

export interface TaskGroups {
  today: Task[];
  week: Task[];
  later: Task[];
}

/** 오늘까지(밀린 것 포함) / 7일 안 마감 / 나중. */
export function taskGroups(s: CalendarState, k: string): TaskGroups {
  const live = liveTasks(s);
  const limit = ymd(addDays(parseDay(k), 7));
  const byDue = (a: Task, b: Task) => a.due.localeCompare(b.due) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99");
  return {
    today: live.filter((t) => t.due <= k && (!t.done || t.due === k)).sort(byDue),
    week: live.filter((t) => t.due > k && t.due <= limit && !t.done).sort(byDue),
    later: live.filter((t) => t.due > limit && !t.done).sort(byDue)
  };
}

export function log(s: CalendarState, entry: Omit<LogEntry, "at">, now: Date): void {
  s.log.push({ at: stamp(now), ...entry });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

/* ---------- worker proposal → entries ---------- */

const areaOf = (a: string): Area => (a === "SCHOOL" ? "school" : "personal");

export interface Applied {
  /** IDs of entries created. */
  refs: string[];
  /** Items that had no usable date (kept as 기억 with a review note). */
  missing: string[];
  /** Open to-dos the sentence said were finished (「3반 수행평가 점수 확인함」), now checked. */
  done?: string[];
  /** Entries a 「취소됨」 「4시로 바뀜」 changed: how they were (for ⌘Z) and what was done. */
  changed?: { id: string; before: Entry; what: string }[];
  /** A 「취소」 「변경」 that named nothing in the calendar. */
  unmatched?: string[];
}

export const MANY_TARGETS = "바꿀 일정이 여럿이라 확인 필요: ";
export const NEW_TIME_UNSAID = "바뀐 날짜·시각이 없어 일정은 그대로 둠";
/** 「취소됨」 「취소했음」 「없어졌대」 at the end: news that something is off (「취소 신청서 내기」 is not). */
const CANCEL_DONE = /(?:취소\s*(?:됨|됐|되었|했|함|래|라고|요|임)|없어졌|없어짐|무산)[가-힣]*[.!~\s]*$/;
const CANCEL_SAID = /취소|안\s*하|안\s*함|없어|없던|무산|안\s*열|빠지|빠짐|빠졌/;
const MOVE_SAID = /바뀌|바뀜|바꿈|변경|미뤄|미룸|미뤘|연기|앞당|당겨|당김|당겼|연장|늘어|늘렸|늘림|옮|아니고|아니라|말고|(?:으로|로)(?:\s|$|까지)/;

/**
 * 「치과 금요일 3시에서 4시로 바뀜」 「학년 협의회 취소됨」: the one live appointment or open to-do
 * the words name (the old day/time said narrows it down). Several: none (asked in 확인할 것).
 */
export function changeTargets(s: CalendarState, item: ProposalItem, now: Date): (CalEvent | Task)[] {
  const squash = (x: string) => x.replace(/\s+/g, "");
  const name = squash(item.title);
  if (name.length < 2) return [];
  const today = ymd(now);
  const named = (x: { title: string }) => squash(x.title).includes(name) || (squash(x.title).length >= 2 && name.includes(squash(x.title)));
  // Drafts are what is being said right now (「치과 4시로 바뀜」 is a 치과 draft too): never the target.
  let list: (CalEvent | Task)[] = [...liveEvents(s).filter((e) => e.date >= today && !e.workFor && !e.draft && named(e)), ...liveTasks(s).filter((t) => !t.done && !t.draft && named(t))];
  // 「교과협의회 다음주 금요일 걸로 취소」: a cancel's day says which one.
  const from = (item.changeFrom || (item.change === "CANCEL" ? `${item.evidence.dateText} ${item.evidence.timeText}` : "")).trim();
  // 「다음주 교과협의회 취소」: only a week said.
  const week = /다다음\s*주/.test(from) ? 2 : /다음\s*주|담주/.test(from) ? 1 : /이번\s*주/.test(from) ? 0 : null;
  if (list.length > 1 && week !== null) {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + 7 * week);
    const a = ymd(monday);
    const b = ymd(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6));
    const inWeek = list.filter((x) => {
      const day = x.kind === "event" ? x.date : x.due;
      return day >= a && day <= b;
    });
    if (inWeek.length) list = inWeek;
  }
  if (list.length > 1 && from) {
    const r = parseRule(`${from} 일정`, now);
    const dated = /\d+\s*월|\d+\s*일|[월화수목금토일]요일|오늘|내일|모레|\d+\/\d+/.test(from);
    const narrowed = list.filter((x) => {
      const day = x.kind === "event" ? x.date : x.due;
      const hm = x.kind === "event" ? x.start : x.dueTime;
      return (!dated || !r.date || day === r.date) && (!r.hasTime || hm === r.time);
    });
    if (narrowed.length) list = narrowed;
  }
  return list;
}

/** The change itself (one target): gone, or moved to the day/time said (the rest kept, reminders moved along). Null: a move that says no new day or time (nothing changed). */
function applyChange(x: CalEvent | Task, item: ProposalItem): string | null {
  if (item.change === "CANCEL") {
    x.gone = true;
    return `취소: 「${x.title}」`;
  }
  const at = item.startAt && !Number.isNaN(new Date(item.startAt).getTime()) ? new Date(item.startAt) : null;
  const newDay = at && item.evidence.dateText ? ymd(at) : null;
  const newTime = at && item.evidence.timeText ? nowHM(at) : null;
  if (!newDay && !newTime) return null;
  const dayOf = (k: string) => fromStamp(`${k}T00:00`).getTime();
  if (x.kind === "event") {
    const was = `${fdShort(x.date)}${x.start ? ` ${x.start}` : ""}`;
    const oldAt = fromStamp(`${x.date}T${x.start ?? "00:00"}`).getTime();
    const length = x.start && x.end ? mins(x.end) - mins(x.start) : null;
    if (newDay) x.date = newDay;
    if (newTime) {
      x.start = newTime;
      const end = item.endAt && item.evidence.timeText.match(/[~\-–]|부터/) ? nowHM(new Date(item.endAt)) : length !== null ? hmOf(mins(newTime) + length) : hmOf(mins(newTime) + 60);
      x.end = end;
    }
    const shift = fromStamp(`${x.date}T${x.start ?? "00:00"}`).getTime() - oldAt;
    x.reminders = x.reminders.map((r) => stamp(new Date(fromStamp(r).getTime() + shift)));
    return `바꿈: 「${x.title}」 ${was} → ${fdShort(x.date)}${x.start ? ` ${x.start}` : ""}`;
  }
  const was = `${x.noDue ? "날짜 없음" : fdShort(x.due)}${x.dueTime ? ` ${x.dueTime}` : ""}`;
  const oldAt = dayOf(x.due) + (x.dueTime ? mins(x.dueTime) * 60e3 : 0);
  if (newDay) {
    x.due = newDay;
    delete x.noDue;
  }
  if (newTime) x.dueTime = newTime;
  const shift = dayOf(x.due) + (x.dueTime ? mins(x.dueTime) * 60e3 : 0) - oldAt;
  x.reminders = x.reminders.map((r) => stamp(new Date(fromStamp(r).getTime() + shift)));
  return `바꿈: 「${x.title}」 ${was} → ${fdShort(x.due)}${x.dueTime ? ` ${x.dueTime}` : ""}`;
}

const hmOf = (m: number): string => {
  const c = Math.min(Math.max(m, 0), 23 * 60 + 59);
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
};

/* ---------- how the owner writes (tests/fixtures/style-cases.json) ---------- */

/** 「확인함」 「제출했음」 「진도 종료」 「끝」: a report of something finished, not a to-do (「해야함」 is not). */
export function doneReport(text: string): boolean {
  const t = text.trim().replace(/[.!~\s]+$/, "");
  if (/(?:해야|야)\s*함$|할\s*것$|하기$/.test(t)) return false;
  return /(?:함|했음|했어요?|했다|했습니다|완료|끝|끝남|끝났(?:어|음|다|습니다)?|종료|마침|마쳤(?:음|어|다)?)$/.test(t);
}

/** Words that make an item school work whatever the model said (「행정실 가서 카드 제출」 「2학년 9반 …」). */
const SCHOOL_WORDS = /초과근무|벌점|지각|교육청|장학사|체험학습|교직원|교과|보강|시간표|나이스|학급|종례|조회|(?<!수영|피아노|요가|미술|영어|태권도|발레|필라테스|골프|테니스)\s*수업|\d+\s*반(?![가-힣])|\d+\s*반(?:도|은|는|에|의|부터|까지)|\d\s*학년|\d\s*교시|행정실|교무실|교원|교사|기안|공문|결재|수행평가|생기부|세특|방과후|학생|학부모|담임|쿨메신저|협의회|협의록|출장|급식지도|진도|교학공|대의원회|학생회/;

/** The class numbers a text names: 「2학년 3반 … 6반」 → ["3반", "6반"]. */
const classesIn = (text: string): string[] => [...new Set([...text.matchAll(/(\d{1,2})\s*반(?=$|[^가-힣]|도|은|는|에|의|부터|까지|이|가)/g)].map((m) => `${m[1]}반`))];

const PARTICLE = /(?:께서|에게|께|에서|에|을|를|은|는|이|가|도|과|와|및|랑|으로|로)$/;

/**
 * 「오늘 6반 진도종료, 수행평가 점수도 확인함」: the one open to-do it finishes (「6반 수행평가 점수 확인」).
 * Most of the to-do's words and its last word (the action) are in the sentence, and a class it
 * names is the sentence's. Two equally good candidates: none (it never guesses between them).
 */
export function finishedBy(s: CalendarState, sentence: string): Task[] {
  const said = sentence.replace(/\s+/g, "");
  const saidClasses = classesIn(sentence);
  const scored = liveTasks(s).filter((t) => !t.done && !t.draft).flatMap((t) => {
    const words = t.title.split(/\s+/).map((w) => w.replace(PARTICLE, "")).filter(Boolean);
    if (words.length < 2) return [];
    const own = classesIn(t.title);
    if (own.some((c) => !saidClasses.includes(c))) return [];
    if (!said.includes(words[words.length - 1])) return [];
    const hit = words.filter((w) => said.includes(w)).length;
    return hit >= 2 && hit * 3 >= words.length * 2 ? [{ t, score: hit / words.length + (own.length ? 1 : 0) }] : [];
  });
  if (!scored.length) return [];
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  return top.length === 1 ? [top[0].t] : [];
}

const RELATIVE_SAID = /(일주일|한\s*주|\d+\s*주|하루|이틀|사흘|나흘|\d+\s*일)\s*전|전날|당일|다음\s*날/;

function itemReview(item: ProposalItem): string[] | undefined {
  return item.needsReview && item.reviewReasons.length ? item.reviewReasons : undefined;
}

/**
 * Schedules go in as 가승인 (provisional). To-dos, periods and notes go in directly
 * (the UI offers 되돌리기).
 */
export function applyProposal(s: CalendarState, p: Proposal, source: string, now: Date, srcKey?: string): Applied {
  const out: Applied = { refs: [], missing: [], done: [], changed: [], unmatched: [] };
  const createdAt = stamp(now);
  const today = ymd(now);
  const said = new Map<string, string>();
  const queue = p.items.slice();
  for (let i = 0; i < queue.length; i++) {
    let item = queue[i];
    // The model once took 「출장 신청 다 했어요」 for a cancel: a change counts only when its words are said.
    const words = item.evidence.sentence || p.sourceText || "";
    if (item.change === "CANCEL" && !CANCEL_SAID.test(words)) item = { ...item, change: undefined };
    if (item.change === "MOVE" && !MOVE_SAID.test(words)) item = { ...item, change: undefined };
    // 「가정통신문 발송은 다음주 월요일에 하기로」 「3반 수행평가 점수 확인은 내일 할게」: a new day for the one open
    // to-do (or appointment) of exactly that name, said as its topic — a move, not a second copy.
    if (!item.change && (item.kind === "TODO" || item.kind === "SCHEDULE") && item.startAt && item.evidence.dateText) {
      const name = item.title.replace(/\s+/g, "");
      const spoken = words.replace(/\s+/g, "");
      const same = [...liveTasks(s).filter((t) => !t.done && !t.draft), ...liveEvents(s).filter((e) => e.date >= today && !e.workFor && !e.draft)].filter((x) => x.title.replace(/\s+/g, "") === name);
      if (name.length >= 2 && same.length === 1 && (spoken.includes(`${name}은`) || spoken.includes(`${name}는`))) item = { ...item, change: "MOVE" };
    }
    // 「치과 예약 취소했음」 put down as a record: it is the 치과 in the calendar that is off.
    if (!item.change && (item.kind === "NOTE" || (item.kind === "SCHEDULE" && !item.startAt)) && CANCEL_DONE.test(words)) {
      const off = { ...item, change: "CANCEL" as const, title: item.title.replace(/\s*(?:예약\s*)?취소.*$/, "").trim() || item.title };
      if (changeTargets(s, off, now).length === 1) item = off;
    }
    // 「취소됨」 「4시로 바뀜」: the entry already in the calendar, not a new one.
    if (item.change) {
      const targets = changeTargets(s, item, now);
      if (targets.length === 1) {
        const x = targets[0];
        const before = JSON.parse(JSON.stringify(x)) as Entry;
        const what = applyChange(x, item);
        if (what) {
          out.changed!.push({ id: x.id, before, what });
          continue;
        }
        // 「치과 시간 바뀜」 without the new time: kept as 기억, asked in 확인할 것; the 치과 stays as it was.
        const note: Memo = { id: newId(s, "n"), kind: "note", title: `${item.title} 변경`, details: item.evidence.sentence || undefined, area: areaOf(item.area), source, createdAt, review: [NEW_TIME_UNSAID], ...(srcKey ? { srcKey } : {}) };
        s.notes.push(note);
        out.refs.push(note.id);
        continue;
      }
      if (targets.length > 1) {
        const note: Memo = { id: newId(s, "n"), kind: "note", title: `${item.title} ${item.change === "CANCEL" ? "취소" : "변경"}`, details: item.evidence.sentence || undefined, area: areaOf(item.area), source, createdAt, review: [`${MANY_TARGETS}${targets.map((t) => `「${t.title}」 ${t.kind === "event" ? fdShort(t.date) : fdShort(t.due)}`).join(", ")}`], ...(srcKey ? { srcKey } : {}) };
        s.notes.push(note);
        out.refs.push(note.id);
        continue;
      }
      out.unmatched!.push(item.title);
      // 「치과 4시로 바뀜」 with no 치과 in the calendar: nothing to change; a move still says when, so it goes in as new.
      if (item.change === "CANCEL") continue;
      item = { ...item, change: undefined };
    }
    const sentence = item.evidence.sentence || (p.items.length === 1 ? p.sourceText ?? "" : "");
    const finished = doneReport(sentence) || doneReport(item.title);
    // 「5반 수행평가 점수 확인 끝」: a record of what was done, and the open to-do it finishes.
    if (finished && item.kind === "TODO") item = { ...item, kind: "NOTE" };
    if (finished && item.kind === "NOTE") {
      for (const t of finishedBy(s, `${item.title} ${sentence}`)) {
        t.done = true;
        t.subs.forEach((y) => (y.done = true));
        out.done!.push(t.id);
      }
    }
    // 「11/20 재량휴업일」: a day still ahead is an appointment (all day), not a 기억.
    if (item.kind === "NOTE" && item.startAt && !finished && ymd(new Date(item.startAt)) >= today) item = { ...item, kind: "SCHEDULE" };
    // 「오늘 3반 수행평가 점수 확인함」 → 「3반 …」: the class the sentence names stays in the title.
    const classes = sentence.length <= 160 ? classesIn(sentence) : [];
    // 「금요일까지 2반 6반 수행평가 채점」 made one to-do: one per class, as the owner checks them.
    // The title naming them all (「2반 6반 수행평가 채점」) is split the same way.
    const titled = classesIn(item.title);
    if (classes.length > 1 && (item.kind === "TODO" || item.kind === "SCHEDULE") && (titled.length > 1 ? titled.length === classes.length : !titled.length && !p.items.some((y) => classesIn(y.title).length))) {
      const [first, ...rest] = classes;
      const base = titled.length > 1 ? { ...item, title: item.title.replace(/\d{1,2}\s*반(?:\s*(?:이랑|랑|과|와|하고|및|,|·))?\s*/g, "").trim() } : item;
      queue.splice(i + 1, 0, ...rest.map((c) => ({ ...base, title: `${c} ${base.title}` })));
      item = { ...item, title: `${first} ${base.title}` };
    }
    if (classes.length === 1 && !classesIn(item.title).length) item = { ...item, title: `${classes[0]} ${item.title}` };
    if (item.area !== "SCHOOL" && SCHOOL_WORDS.test(`${item.title} ${sentence}`)) item = { ...item, area: "SCHOOL" };
    // 「다음주 수욜 6교시 공개수업 참관하고 협의록 쓰기」 split in two: the to-do after 「…하고」 is that day's.
    const prev = i > 0 ? queue[i - 1] : undefined;
    if (!item.startAt && item.kind === "TODO" && prev?.kind === "SCHEDULE" && prev.startAt && /(?:하고|한\s*뒤|한\s*후|끝나고|마치고)$/.test(prev.evidence.sentence.trim()) && (p.sourceText ?? "").replace(/\s+/g, "").includes(`${prev.evidence.sentence}${item.evidence.sentence}`.replace(/\s+/g, ""))) {
      const d = new Date(prev.startAt);
      d.setHours(9, 0, 0, 0);
      item = { ...item, startAt: d.toISOString(), evidence: { ...item.evidence, dateText: prev.evidence.dateText } };
    }
    // 「퇴근 전에 공문 회신」 with the time words left out by the model: today, at this school's time.
    if (!item.startAt && (item.kind === "TODO" || item.kind === "SCHEDULE") && !item.change && /\d\s*교시|점심|출근|퇴근/.test(sentence)) {
      const d = new Date(now);
      d.setHours(9, 0, 0, 0);
      item = { ...item, startAt: d.toISOString(), endAt: "", evidence: { ...item.evidence, timeText: sentence } };
    }
    // 「내일 1교시 3반 수업」 with the day kept but the 교시 left out of the time: the 교시 is the time.
    const lesson = !item.evidence.timeText.trim() && item.startAt && (item.kind === "TODO" || item.kind === "SCHEDULE") ? sentence.match(/\d\s*교시(?:\s*(?:끝나고|끝나면|후|전|부터|까지))?|점심\s*시간|퇴근\s*(?:전|후|하기\s*전)/) : null;
    if (lesson) item = { ...item, evidence: { ...item.evidence, timeText: lesson[0] } };
    // 「3교시」 「점심시간」 「퇴근 전」: school words the worker does not know — this school's own times.
    const school = item.startAt && /교시|점심|출근|퇴근/.test(item.evidence.timeText) ? timeWords(item.evidence.timeText, s.settings) : "";
    const span = school ? timeRange(school) : null;
    const one = school && !span ? singleTime(school) : null;
    const at = (hm: string) => {
      const d = new Date(item.startAt);
      d.setHours(Number(hm.slice(0, 2)), Number(hm.slice(3, 5)), 0, 0);
      return d;
    };
    if (span || one) {
      const reviewReasons = item.reviewReasons.filter((r) => !r.includes("오전 9시로 임시"));
      const moved = at(span?.start ?? one!.time);
      // Reminders said against the start (「10분 전」, the default 30) move with it.
      const shift = moved.getTime() - new Date(item.startAt).getTime();
      const reminders = item.reminders.map((r) => new Date(new Date(r).getTime() + shift).toISOString());
      item = { ...item, startAt: moved.toISOString(), endAt: span ? at(span.end).toISOString() : "", reminders, reviewReasons, needsReview: reviewReasons.length > 0 };
    }
    const common = { title: item.title, area: areaOf(item.area), source, createdAt, details: item.details || undefined, review: itemReview(item), ...(srcKey ? { srcKey } : {}) };
    const reminders = item.reminders.map(isoToStamp);
    if (item.kind === "NOTE" || (item.kind !== "TODO" && !item.startAt)) {
      const note: Memo = { ...common, id: newId(s, "n"), kind: "note" };
      if (item.kind !== "NOTE") {
        note.review = [...(note.review ?? []), "날짜를 찾지 못해 기억으로 둠"];
        out.missing.push(item.title);
      }
      s.notes.push(note);
      out.refs.push(note.id);
      continue;
    }
    if (item.kind === "PERIOD") {
      const from = ymd(new Date(item.startAt));
      const endExclusive = item.endAt ? new Date(item.endAt) : addDays(new Date(item.startAt), 1);
      const to = ymd(addDays(endExclusive, -1));
      const period: Period = { ...common, id: newId(s, "p"), kind: "period", from, to: to < from ? from : to };
      s.periods.push(period);
      out.refs.push(period.id);
      continue;
    }
    // 「상담 전에 성적표 출력」: the worker set it due when the appointment starts — keep that time.
    // 「하루 종일」 is said but is no time (the worker leaves it at 09:00 with no note: an all-day entry here).
    const timed = (item.evidence.timeText.trim() !== "" && !/종일|하루\s*내내/.test(item.evidence.timeText)) || item.reviewReasons.some((r) => r.endsWith("전까지로 둠"));
    if (item.kind === "TODO") {
      const start = item.startAt ? new Date(item.startAt) : now;
      const task: Task = {
        ...common,
        id: newId(s, "t"),
        kind: "task",
        due: ymd(start),
        dueTime: item.startAt && timed ? nowHM(start) : null,
        done: false,
        reminders,
        subs: [...item.subtasks.map((title) => ({ title, done: false })), ...(item.suggestedSubtasks ?? []).slice(0, 5).map((title) => ({ title, done: false, ai: true as const }))]
      };
      if (item.waitFor) task.wait = item.waitFor;
      // No deadline: 「날짜 없음」, not today (and nothing to ask about).
      // 「이따가 코디 선생님께 전달할 때 …」: later today.
      if (!item.startAt && /이따가?|있다가/.test(sentence)) task.due = today;
      else if (!item.startAt) {
        task.noDue = true;
        // 「대의원회 전날 회의 자료 출력」: counted from an appointment (anchorRelativeDates below).
        const rel = RELATIVE_SAID.exec(sentence)?.[0];
        if (rel && !task.review?.some((r) => r.startsWith(UNREAD))) task.review = [...(task.review ?? []), `${UNREAD}「${rel}」`];
        if (sentence) said.set(task.id, sentence);
      }
      s.tasks.push(task);
      out.refs.push(task.id);
      continue;
    }
    const start = new Date(item.startAt);
    let end: string | null = null;
    if (timed && item.endAt) {
      const e = new Date(item.endAt);
      end = ymd(e) === ymd(start) ? nowHM(e) : "23:59";
    } else if (timed) {
      // An hour, but never past midnight (「밤 11시 반」 ended 00:30, before it began).
      const e = new Date(start.getTime() + 3600e3);
      end = ymd(e) === ymd(start) ? nowHM(e) : "23:59";
    }
    const ev: CalEvent = {
      ...common,
      id: newId(s, "e"),
      kind: "event",
      date: ymd(start),
      start: timed ? nowHM(start) : null,
      end,
      provisional: true,
      reminders
    };
    s.events.push(ev);
    out.refs.push(ev.id);
  }
  anchorRelativeDates(s, now, { prefer: new Set(out.refs), said });
  return out;
}

/* ---------- 「대의원회 일주일 전」: a date counted from another appointment ---------- */

const RELATIVE = /^(?:(일주일|한\s*주|(\d+)\s*주)|(하루|이틀|사흘|나흘|(\d+)\s*일))\s*전$|^(전날|당일|다음\s*날|다음날|그날)$/;
const KO_DAYS: Record<string, number> = { 하루: 1, 이틀: 2, 사흘: 3, 나흘: 4 };

/** Days from the anchor appointment for 「일주일 전」 「3일 전」 「전날」 「당일」 「다음 날」; null if not such a phrase. */
export function relativeOffset(phrase: string): number | null {
  const m = RELATIVE.exec(phrase.replace(/까지$/, "").trim());
  if (!m) return null;
  if (m[1]) return -7 * (m[2] ? Number(m[2]) : 1);
  if (m[3]) return -(m[4] ? Number(m[4]) : KO_DAYS[m[3]]);
  return m[5] === "전날" ? -1 : /다음/.test(m[5]) ? 1 : 0;
}

const UNREAD = "날짜 표현을 해석하지 못함: ";
const NO_ANCHOR = "기준 일정을 찾지 못함: ";
const MANY_ANCHORS = "기준 일정이 여럿이라 날짜를 정하지 못함: ";

/**
 * A to-do 「대의원회 일주일 전까지 준비」 has no date of its own: count it from the one
 * appointment (or period) whose title it names. None or several: it stays 날짜 없음 and
 * 확인할 것 says why. Returns the to-dos that got a date.
 */
export function anchorRelativeDates(s: CalendarState, now: Date, hint: { prefer?: Set<string>; said?: Map<string, string> } = {}): string[] {
  const done: string[] = [];
  const today = ymd(now);
  const squash = (x: string) => x.replace(/\s+/g, "");
  for (const t of liveTasks(s)) {
    if (t.done || !t.noDue || !t.review?.length) continue;
    const note = t.review.find((r) => r.startsWith(UNREAD) || r.startsWith(NO_ANCHOR) || r.startsWith(MANY_ANCHORS));
    if (!note) continue;
    const phrase = note.slice(note.indexOf("「") + 1, note.lastIndexOf("」"));
    // 「대의원회 전날」 quoted whole: the relative part counts, the name is the anchor.
    const offset = relativeOffset(phrase) ?? relativeOffset(RELATIVE_SAID.exec(phrase)?.[0] ?? "");
    if (offset === null) continue;
    const text = squash(`${t.title} ${t.details ?? ""} ${hint.said?.get(t.id) ?? ""} ${phrase}`);
    let anchors = [
      ...liveEvents(s).filter((e) => !e.workFor).map((e) => ({ id: e.id, title: e.title, date: e.date })),
      ...livePeriods(s).map((p) => ({ id: p.id, title: p.title, date: p.from }))
    ].filter((a) => a.date >= today && squash(a.title).length >= 2 && text.includes(squash(a.title)));
    // 「11. 6. 대의원회 … 일주일 전부터 기안」: the appointment said in the same words comes first.
    const same = anchors.filter((a) => hint.prefer?.has(a.id));
    if (same.length) anchors = same;
    const days = [...new Set(anchors.map((a) => a.date))];
    let next: string;
    if (days.length === 1) {
      const d = new Date(`${days[0]}T00:00`);
      d.setDate(d.getDate() + offset);
      t.due = ymd(d);
      delete t.noDue;
      next = "";
      done.push(t.id);
    } else next = `${days.length ? MANY_ANCHORS : NO_ANCHOR}「${phrase}」`;
    t.review = t.review.map((r) => (r === note ? next : r)).filter(Boolean);
    if (!t.review.length) delete t.review;
  }
  return done;
}

/* ---------- draft first, AI later ---------- */

/** Draft ids are unique across devices: a phone draft and a Mac entry never share an id. */
const draftId = (prefix: string): string => `${prefix}-d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const plusMinutes = (day: string, hhmm: string, n: number): string => stamp(new Date(fromStamp(`${day}T${hhmm}`).getTime() + n * 60e3));

/**
 * The rule-parser draft for a sentence, in the calendar at once. Same defaults as the worker:
 * schedules are 가승인, reminders 30 minutes before a time (a dated to-do: that day 09:00).
 */
export function draftFromText(s: CalendarState, text: string, source: string, now: Date, srcKey: string): Entry {
  // A note to remember is never forced into an appointment (「차 번호 12가 3456」, 「메모 …」).
  const m = memoDraft(text, now, s.settings);
  if (m) {
    const note: Memo = { id: draftId("n"), kind: "note", title: m.title || "기억", details: m.details, area: SCHOOL_WORDS.test(text) ? "school" : "personal", source, createdAt: stamp(now), draft: !m.final, srcKey };
    s.notes.push(note);
    return note;
  }
  const r = parseDraft(text, now, s.settings);
  const base = { title: r.title, area: (SCHOOL_WORDS.test(text) ? "school" : "personal") as Area, source, createdAt: stamp(now), draft: true, srcKey, review: r.needsReview ? [r.explanation] : undefined };
  // 「11월 2일부터 6일까지 체험학습」: a span of days is a 기간.
  if (r.until && r.date) {
    const period: Period = { ...base, id: draftId("p"), kind: "period", from: r.date, to: r.until };
    s.periods.push(period);
    return period;
  }
  if (r.kind === "SCHEDULE" && r.date && r.time) {
    const endM = r.end ? mins(r.end) : Math.min(mins(r.time) + 60, 23 * 60 + 59);
    const ev: CalEvent = {
      ...base, id: draftId("e"), kind: "event", date: r.date, start: r.time,
      end: `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(endM % 60).padStart(2, "0")}`,
      provisional: true, reminders: [plusMinutes(r.date, r.time, -(r.remindBefore ?? 30))]
    };
    s.events.push(ev);
    return ev;
  }
  const task: Task = {
    ...base, id: draftId("t"), kind: "task", due: r.date ?? ymd(now), dueTime: r.hasTime ? r.time : null, done: false,
    reminders: r.date ? [r.hasTime && r.time ? plusMinutes(r.date, r.time, -(r.remindBefore ?? 30)) : r.remindBefore ? plusMinutes(r.date, "09:00", -r.remindBefore) : `${r.date}T09:00`] : [], subs: []
  };
  if (!r.date) task.noDue = true;
  s.tasks.push(task);
  return task;
}

const LISTS = ["events", "tasks", "periods", "notes"] as const;
type ListName = (typeof LISTS)[number];
const listOf = (kind: Entry["kind"]): ListName => (kind === "event" ? "events" : kind === "task" ? "tasks" : kind === "period" ? "periods" : "notes");

function allEntries(s: CalendarState): Entry[] {
  return [...s.events, ...s.tasks, ...s.periods, ...s.notes];
}

export const draftsOf = (s: CalendarState, key: string): Entry[] => allEntries(s).filter((x) => x.srcKey === key && x.draft);

/** Give drafts made under a temporary key the inbox job id the phone got for the upload. */
export function rekey(s: CalendarState, from: string, to: string): void {
  for (const x of allEntries(s)) if (x.srcKey === from) x.srcKey = to;
}

function removeEntry(s: CalendarState, x: Entry): void {
  const list = s[listOf(x.kind)] as Entry[];
  const i = list.indexOf(x);
  if (i >= 0) list.splice(i, 1);
}

function stripId<T extends Entry>(x: T): Suggestion {
  const { id: _id, suggest: _s, ...rest } = x;
  return rest as Suggestion;
}

export interface Refined extends Applied {
  /** Drafts the AI result replaced in place (same id). */
  updated: string[];
  /** Touched drafts that got an 「AI 제안」 instead. */
  suggested: string[];
  /** The result was already in (same job seen twice): nothing changed. */
  duplicate: boolean;
}

/**
 * The AI result for a draft group (same srcKey). Untouched drafts are replaced in place:
 * the first AI item of the same kind takes the draft's id, other items are added, drafts with
 * no counterpart are removed (they were machine-made). A draft changed by hand keeps the
 * user's version and only carries the AI version as a suggestion. No group: plain apply.
 */
export function refineDrafts(s: CalendarState, key: string, p: Proposal, source: string, now: Date): Refined {
  const out: Refined = { refs: [], missing: [], updated: [], suggested: [], duplicate: false };
  const group = draftsOf(s, key);
  if (!group.length) {
    if (allEntries(s).some((x) => x.srcKey === key)) return { ...out, duplicate: true };
    return { ...out, ...applyProposal(s, p, source, now, key) };
  }
  if (group.some((x) => x.touched)) {
    const scratch: CalendarState = { ...s, events: [], tasks: [], periods: [], notes: [], nextId: 1 };
    applyProposal(scratch, p, source, now, key);
    const suggest = allEntries(scratch).map(stripId);
    for (const d of group) {
      d.draft = false;
      if (suggest.length && !d.gone) {
        d.suggest = suggest;
        out.suggested.push(d.id);
      }
    }
    return out;
  }
  if (!p.items.length) {
    for (const d of group) {
      d.draft = false;
      // A 기억 the AI found nothing more in simply stays a 기억 (nothing to review).
      if (d.kind !== "note") d.review = [...(d.review ?? []), "AI가 따로 찾은 것이 없어 규칙 초안 그대로 둠"];
      out.updated.push(d.id);
    }
    out.refs = out.updated.slice();
    return out;
  }
  const applied = applyProposal(s, p, source, now, key);
  out.missing = applied.missing;
  out.done = applied.done;
  out.changed = applied.changed;
  out.unmatched = applied.unmatched;
  const fresh = applied.refs.map((id) => findEntry(s, id)!).filter(Boolean);
  const left = group.slice();
  for (const n of fresh) {
    const i = left.findIndex((d) => d.kind === n.kind);
    if (i < 0) {
      out.refs.push(n.id);
      continue;
    }
    const d = left.splice(i, 1)[0];
    removeEntry(s, n);
    // The words said a clock time and the AI answer lost it (all-day, no deadline): keep it.
    // (A draft's own 「오전 9시로 임시」 was never said: the AI's all-day answer stands.)
    if (d.kind === "event" && n.kind === "event" && d.start && !n.start && d.date === n.date && !d.review?.some((r) => r.includes("임시"))) {
      n.start = d.start;
      n.end = d.end;
      if (!n.reminders.length) n.reminders = d.reminders;
    }
    if (d.kind === "task" && n.kind === "task" && d.dueTime && !n.dueTime && (n.noDue || n.due === d.due)) {
      n.due = d.due;
      n.dueTime = d.dueTime;
      delete n.noDue;
      if (!n.reminders.length) n.reminders = d.reminders;
      // Its notes about the time it could not read no longer apply.
      n.review = n.review?.filter((r) => !/시간|마감 날짜/.test(r));
      if (!n.review?.length) delete n.review;
    }
    const keep = { id: d.id, createdAt: d.createdAt };
    for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
    Object.assign(d, n, keep);
    d.draft = false;
    out.refs.push(d.id);
    out.updated.push(d.id);
  }
  for (const d of left) removeEntry(s, d);
  anchorRelativeDates(s, now);
  return out;
}

/** 「AI 제안 적용」: the touched draft becomes the AI's version (same id for the first match). */
export function acceptSuggestion(s: CalendarState, id: string, now: Date): string[] {
  const x = findEntry(s, id);
  if (!x?.suggest?.length) return [];
  const items = x.suggest;
  delete x.suggest;
  const refs: string[] = [];
  let reused = false;
  for (const g of items) {
    if (!reused && g.kind === x.kind && !x.gone) {
      reused = true;
      const keep = { id: x.id, createdAt: x.createdAt };
      for (const k of Object.keys(x)) delete (x as unknown as Record<string, unknown>)[k];
      Object.assign(x, structuredClone(g), keep, { touched: true });
      refs.push(x.id);
      continue;
    }
    const e = { ...structuredClone(g), id: newId(s, g.kind === "event" ? "e" : g.kind === "task" ? "t" : g.kind === "period" ? "p" : "n") } as Entry;
    (s[listOf(e.kind)] as Entry[]).push(e);
    refs.push(e.id);
  }
  if (!reused && !x.gone) x.gone = true;
  log(s, { label: "AI 제안 적용", msg: x.title, ref: refs[0] }, now);
  return refs;
}

/** One log line per created entry, in the prototype's wording. */
export function describe(s: CalendarState, id: string, fd: (k: string) => string = fdShort): { label: string; msg: string } {
  const x = findEntry(s, id);
  if (!x) return { label: "", msg: "" };
  const remText = (rs: string[], today: string) =>
    rs.map((r) => (r.slice(0, 10) === today ? "" : fd(r.slice(0, 10)) + " ") + r.slice(11)).join(", ");
  switch (x.kind) {
    case "event":
      return {
        label: "넣음",
        msg: `${fd(x.date)} ${x.start ?? "종일"} ${x.title}${x.reminders.length ? ` · 알림 ${remText(x.reminders, x.date)}` : ""}`
      };
    case "task":
      return {
        label: "할 일",
        msg: `${x.title} · ${fd(x.due)}${x.dueTime ? " " + x.dueTime : ""}까지${x.subs.length ? ` · 하위 ${x.subs.length}개` : ""}${x.reminders.length ? ` · 알림 ${remText(x.reminders, "")}` : ""}`
      };
    case "period":
      return { label: "기간", msg: `${x.title} · ${fd(x.from)}–${fd(x.to)}` };
    case "note":
      return { label: "기억", msg: x.title };
  }
}

/* ---------- actions ---------- */

export function confirmEvent(s: CalendarState, id: string, now: Date): void {
  const e = s.events.find((x) => x.id === id);
  if (!e || e.gone) return;
  e.provisional = false;
  log(s, { label: "확정", msg: e.title, ref: e.id }, now);
}

/** 취소 (provisional) or 되돌리기 (direct). Soft: the entry stays in the file. */
export function cancelEntry(s: CalendarState, id: string, now: Date): void {
  const x = findEntry(s, id);
  if (!x || x.gone) return;
  const label = x.kind === "event" && x.provisional ? "취소" : "되돌림";
  x.gone = true;
  if (x.kind === "event" && x.provisional) x.goneProvisional = true;
  if (x.kind === "event") x.provisional = false;
  log(s, { label, msg: x.title }, now);
}

/** 「되돌리기」 of a cancel: the entry comes back as it was (a provisional event stays provisional). */
export function restoreEntry(s: CalendarState, id: string, now: Date): void {
  const x = findEntry(s, id);
  if (!x || !x.gone) return;
  delete x.gone;
  if (x.kind === "event" && x.goneProvisional) x.provisional = true;
  delete x.goneProvisional;
  log(s, { label: "되살림", msg: x.title, ref: x.id }, now);
}

export function toggleTask(s: CalendarState, id: string): void {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  if (t.done) t.subs.forEach((x) => (x.done = true));
}

export function toggleSub(s: CalendarState, id: string, index: number): void {
  const t = s.tasks.find((x) => x.id === id);
  if (!t || !t.subs[index]) return;
  t.subs[index].done = !t.subs[index].done;
  // Checking an 「AI 제안」 step accepts it: the label goes.
  if (t.subs[index].done) delete t.subs[index].ai;
  t.done = t.subs.length > 0 && t.subs.every((x) => x.done);
}

export function addSub(s: CalendarState, id: string, title: string): void {
  const t = s.tasks.find((x) => x.id === id);
  const v = title.trim();
  if (!t || !v) return;
  t.subs.push({ title: v, done: false });
  t.done = false;
}

/* ---------- alarms ---------- */

export interface Alarm {
  key: string;
  ref: string;
  kind: "event" | "task";
  /** Local stamp YYYY-MM-DDTHH:MM. */
  at: string;
  atMs: number;
  title: string;
  body: string;
}

export function alarmsOn(s: CalendarState, k: string, fd: (k: string) => string = fdShort): Alarm[] {
  return allAlarms(s, fd).filter((a) => a.at.slice(0, 10) === k);
}

export function allAlarms(s: CalendarState, fd: (k: string) => string = fdShort): Alarm[] {
  const out: Alarm[] = [];
  for (const e of liveEvents(s)) {
    for (const at of e.reminders) {
      const lead = e.start && at.slice(0, 10) === e.date ? mins(e.start) - mins(at.slice(11)) : null;
      out.push({
        key: `${e.id}@${at}`,
        ref: e.id,
        kind: "event",
        at,
        atMs: fromStamp(at).getTime(),
        title: e.title,
        body: e.start ? `${e.start} 시작${lead !== null && lead > 0 ? ` · ${lead}분 전` : ""}` : `${fd(e.date)} 종일`
      });
    }
  }
  for (const t of liveTasks(s)) {
    if (t.done) continue;
    const sd = t.subs.filter((x) => x.done).length;
    for (const at of t.reminders) {
      out.push({
        key: `${t.id}@${at}`,
        ref: t.id,
        kind: "task",
        at,
        atMs: fromStamp(at).getTime(),
        title: t.title,
        body: `${fd(t.due)}${t.dueTime ? " " + t.dueTime : ""}까지${t.subs.length ? ` · 하위 ${sd}/${t.subs.length}` : ""}`
      });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** Alarms that have not rung yet and are due within (now - grace, ∞). */
export function upcomingAlarms(s: CalendarState, now: Date, graceMinutes = 10): Alarm[] {
  const from = now.getTime() - graceMinutes * 60e3;
  const fired = new Set(s.firedAlarms);
  return allAlarms(s).filter((a) => a.atMs > from && !fired.has(a.key));
}

/**
 * Alarms that passed while the app was not running (older than the ringing grace, newer than
 * `hours`), not rung or answered: shown once at start as 「놓친 알람」.
 */
export function missedAlarms(s: CalendarState, now: Date, hours = 24, graceMinutes = 10): Alarm[] {
  const to = now.getTime() - graceMinutes * 60e3;
  const from = now.getTime() - hours * 3600e3;
  const fired = new Set(s.firedAlarms);
  return allAlarms(s).filter((a) => a.atMs > from && a.atMs <= to && !fired.has(a.key));
}

export function markFired(s: CalendarState, key: string): void {
  if (!s.firedAlarms.includes(key)) s.firedAlarms.push(key);
  if (s.firedAlarms.length > 2000) s.firedAlarms.splice(0, s.firedAlarms.length - 2000);
}

/** 확인 / 완료 / 10분 뒤. */
export function answerAlarm(s: CalendarState, alarm: Alarm, action: "done" | "snooze", now: Date): string | null {
  markFired(s, alarm.key);
  const x = findEntry(s, alarm.ref);
  if (!x || (x.kind !== "event" && x.kind !== "task")) return null;
  if (action === "done" && x.kind === "task") {
    x.done = true;
    x.subs.forEach((y) => (y.done = true));
    log(s, { label: "완료", msg: x.title, ref: x.id }, now);
  }
  if (action === "snooze") {
    const at = stamp(new Date(now.getTime() + 10 * 60e3));
    x.reminders.push(at);
    x.reminders.sort();
    log(s, { label: "다시 알람", msg: `${at.slice(11)} ${x.title}`, src: "알람", ref: x.id }, now);
    return at;
  }
  return null;
}

export const ddayDays = (today: string, due: string): number => diffDays(today, due);

/* ---------- replaying a hand-made change ---------- */

/** Apply a user action once (by id). Returns false when it was applied before or its entry is gone. */
export function applyAction(s: CalendarState, a: UserAction, now: Date): boolean {
  if (s.appliedActions.includes(a.id)) return false;
  // A phone draft's id is not known here: use this device's entry for the same job.
  const bySrc = a.src ? allEntries(s).find((x) => x.srcKey === a.src && (a.type === "restore" ? !!x.gone : !x.gone)) : undefined;
  const target = findEntry(s, a.ref) ?? bySrc;
  // The job is not here yet (its file comes after the action): try again on a later pull.
  if (!target && a.src && !s.draftedJobs.includes(a.src) && !s.ingestedJobs.includes(a.src) && !a.src.startsWith("local-")) return false;
  s.appliedActions.push(a.id);
  if (s.appliedActions.length > 2000) s.appliedActions.splice(0, s.appliedActions.length - 2000);
  if (!target) return false;
  if (target.id !== a.ref) a = { ...a, ref: target.id } as UserAction;
  if (target.draft && a.type !== "aiAccept" && a.type !== "aiDismiss") target.touched = true;
  switch (a.type) {
    case "aiAccept": acceptSuggestion(s, a.ref, now); break;
    case "aiDismiss": delete target.suggest; break;
    case "confirm": confirmEvent(s, a.ref, now); break;
    case "cancel": cancelEntry(s, a.ref, now); break;
    case "restore": restoreEntry(s, a.ref, now); break;
    case "toggleTask": toggleTask(s, a.ref); break;
    case "toggleSub": toggleSub(s, a.ref, a.index); break;
    case "addSub": addSub(s, a.ref, a.title); break;
    case "alarm": {
      // 「확인」(phone alarm) only ends the ringing; 완료 finishes a to-do; 10분 뒤 adds a reminder.
      const alarm = allAlarms(s).find((x) => x.key === a.key);
      if (alarm && a.answer !== "ack") answerAlarm(s, alarm, a.answer, now);
      else markFired(s, a.key);
      break;
    }
  }
  return true;
}
