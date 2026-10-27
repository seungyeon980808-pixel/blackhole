/**
 * The phone's rule parser (Android `KoreanCommandParser`), line for line, so a draft made on
 * the Mac and one made on the phone from the same words come out the same. It runs in well
 * under a millisecond: this is what puts an entry on the calendar before the local AI answers.
 * Shared cases: tests/fixtures/rule-cases.json (also run against the Java parser).
 */
import { addDays, pad, ymd } from "./dates";

export interface RuleResult {
  /** NOTE: Mac drafts only (parseDraft) — a 기억, never on the calendar. */
  kind: "SCHEDULE" | "TODO" | "NOTE";
  title: string;
  /** YYYY-MM-DD, null when no usable date. */
  date: string | null;
  /** HH:MM (09:00 for date-only entries, like the Java parser). */
  time: string | null;
  /** A clock time was actually said (not the 09:00 stand-in). */
  hasTime: boolean;
  needsReview: boolean;
  explanation: string;
  /** End time when a range was said (「16:20~21:20」, 「1620~2120」, 「4시~6시」). Mac drafts only. */
  end?: string;
}

const TITLE_POSTPOSITION = "(?:은|는|이|가|을|를|에|에서|까지|부터)?";
const TIME_TEXT = "(?:(오전|오후|아침|낮|저녁|밤|새벽)\\s*)?(\\d{1,2})시(?:\\s*(?:(\\d{1,2})분|(반)))?";
const ABSOLUTE_DATE = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/;
const SLASH_DATE = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?!\d)/;
const TIME = new RegExp(TIME_TEXT);
const TITLE_TIME = new RegExp(TIME_TEXT + TITLE_POSTPOSITION, "g");
const CONVERSATIONAL_EVENT_TIME = /(.+?)\s+(?:가는|만나는|시작하는|출발하는)\s+시간(?:은|이)?/;
const EVENT_WORDS = /회의|약속|미팅|수업|상담|면담|행사|출장|병원|진료|검사|식사|점심|저녁|만나|모임|예배|공연|영화|출발|도착/;
const TASK_WORDS = /할 일|해야|하기|사기|구매|제출|보내|전화|연락|확인|준비|챙기|예약하기|납부|결제|정리|작성|답장|신청/;

const HANGUL_HOURS: [string, string][] = [
  ["열두 시", "12시"], ["열한 시", "11시"], ["열 시", "10시"],
  ["아홉 시", "9시"], ["여덟 시", "8시"], ["일곱 시", "7시"],
  ["여섯 시", "6시"], ["다섯 시", "5시"], ["네 시", "4시"],
  ["세 시", "3시"], ["두 시", "2시"], ["한 시", "1시"],
  ["열두시", "12시"], ["열한시", "11시"], ["열시", "10시"],
  ["아홉시", "9시"], ["여덟시", "8시"], ["일곱시", "7시"],
  ["여섯시", "6시"], ["다섯시", "5시"], ["네시", "4시"],
  ["세시", "3시"], ["두시", "2시"], ["한시", "1시"]
];

const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

export function normalize(text: string): string {
  let v = (text ?? "").trim().replace(/\s+/g, " ");
  for (const [a, b] of HANGUL_HOURS) v = v.split(a).join(b);
  return v;
}

/** A real calendar date, or null (Java's LocalDate.of throws on 2/30). */
function makeDate(y: number, m: number, d: number): Date | null {
  const x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : null;
}

function plusYear(d: Date): Date {
  // Java plusYears: 2/29 → 2/28.
  const x = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
  return x.getMonth() === d.getMonth() ? x : new Date(d.getFullYear() + 1, d.getMonth() + 1, 0);
}

function parseDate(text: string, today: Date): Date | null {
  const abs = ABSOLUTE_DATE.exec(text);
  if (abs) {
    const year = abs[1] ? Number(abs[1]) : today.getFullYear();
    const r = makeDate(year, Number(abs[2]), Number(abs[3]));
    if (!r) return null;
    return !abs[1] && r < today ? plusYear(r) : r;
  }
  const slash = SLASH_DATE.exec(text);
  if (slash) {
    const r = makeDate(today.getFullYear(), Number(slash[1]), Number(slash[2]));
    if (!r) return null;
    return r < today ? plusYear(r) : r;
  }
  if (text.includes("글피")) return addDays(today, 3);
  if (text.includes("모레")) return addDays(today, 2);
  if (text.includes("내일")) return addDays(today, 1);
  if (text.includes("오늘")) return today;
  // Java checks 월요일 … 일요일 in that order.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const wd = order.find((i) => text.includes(WEEKDAYS[i]));
  if (wd === undefined) return null;
  if (text.includes("다음 주") || text.includes("다음주")) {
    const toMonday = ((8 - today.getDay()) % 7) || 7; // TemporalAdjusters.next(MONDAY)
    const monday = addDays(today, toMonday);
    return addDays(monday, (wd + 6) % 7);
  }
  const ahead = (wd - today.getDay() + 7) % 7; // nextOrSame
  if (ahead === 0 && !text.includes("이번")) return addDays(today, 7);
  return addDays(today, ahead);
}

function parseTime(text: string): string | null {
  const m = TIME.exec(text);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = m[3] === undefined ? (m[4] === undefined ? 0 : 30) : Number(m[3]);
  const period = m[1];
  if (period) {
    if ((period === "오후" || period === "낮" || period === "저녁" || period === "밤") && hour < 12) hour += 12;
    if ((period === "오전" || period === "아침" || period === "새벽") && hour === 12) hour = 0;
  }
  if (hour === 24) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

const DAY_WORDS = new RegExp(
  ["오늘", "내일", "모레", "글피", "이번\\s*주", "다음\\s*주"].map((w) => w + TITLE_POSTPOSITION).join("|"), "g");
const ABS_DATE_G = new RegExp("(?:(\\d{4})년\\s*)?\\d{1,2}월\\s*\\d{1,2}일" + TITLE_POSTPOSITION, "g");
const WEEKDAY_G = new RegExp("(?:이번\\s*)?(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일)" + TITLE_POSTPOSITION, "g");

function cleanTitle(text: string): string {
  const conv = CONVERSATIONAL_EVENT_TIME.exec(text);
  if (conv) {
    let t = conv[1].trim();
    t = t.replace(/^.*(?:마친\s+다음에|마치고|다음에|그리고|후에|(?:갈|올|할|만날)\s+거야)\s*[,.:;]?\s*/, "");
    t = t.replace(ABS_DATE_G, " ").replace(DAY_WORDS, " ").replace(WEEKDAY_G, " ");
    t = t.replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  let title = text;
  title = title.replace(ABS_DATE_G, " ");
  title = title.replace(new RegExp("(?<!\\d)\\d{1,2}[./-]\\d{1,2}(?!\\d)" + TITLE_POSTPOSITION, "g"), " ");
  title = title.replace(DAY_WORDS, " ");
  title = title.replace(WEEKDAY_G, " ");
  title = title.replace(TITLE_TIME, " ");
  title = title.replace(/(일정|스케줄|할\s*일|메모)(?:은|는|이|가|을|를|로|으로)?\s*(추가|등록|저장)?\s*(해\s*줘|해줘|해\s*주세요|해주세요)?/g, " ");
  title = title.replace(/(추가|등록|저장)\s*(해\s*줘|해줘|해\s*주세요|해주세요)/g, " ");
  title = title.replace(/(알려|알려줘|알려 줘|기억해|기억해줘|기억해 줘|잊지\s*말고|까지)/g, " ");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^[,.:;]+|[,.:;]+$/g, "").trim();
  return title;
}

export function parseRule(raw: string, now: Date): RuleResult {
  const text = normalize(raw);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mentionsDate = ABSOLUTE_DATE.test(text) || SLASH_DATE.test(text);
  let date = parseDate(text, today);
  const hasDate = date !== null;
  const invalidDate = mentionsDate && !hasDate;
  let time = parseTime(text);
  const hasTime = time !== null;
  const rolls = /(?<!\d)24시/.test(text);
  const taskHint = TASK_WORDS.test(text);
  const eventHint = EVENT_WORDS.test(text);
  let kind: RuleResult["kind"];
  let review: boolean;
  let explanation: string;

  if (hasTime) {
    if (date === null && !invalidDate) {
      date = today;
      if (rolls) date = addDays(date, 1);
      else {
        const [h, m] = time!.split(":").map(Number);
        const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
        if (at < now) date = addDays(date, 1);
      }
    } else if (date !== null && rolls) {
      date = addDays(date, 1);
    }
    kind = taskHint && !eventHint ? "TODO" : "SCHEDULE";
    review = invalidDate;
    explanation = invalidDate ? "날짜가 올바르지 않아 확인이 필요함" : kind === "TODO"
      ? "날짜·시간이 있는 행동을 할 일로 분류"
      : hasDate ? "날짜와 시간을 찾음" : "시간을 찾고 다음 시점으로 날짜를 추정함";
  } else if (hasDate && eventHint && !taskHint) {
    time = "09:00";
    kind = "SCHEDULE";
    review = true;
    explanation = "날짜만 있는 일정이라 오전 9시로 임시 지정";
  } else {
    kind = "TODO";
    review = invalidDate || (hasDate && !taskHint);
    explanation = invalidDate ? "날짜가 올바르지 않아 확인이 필요함" :
      hasDate ? "시간 없는 항목을 날짜가 있는 할 일로 분류" : "날짜와 시간이 없어 할 일로 분류";
    if (hasDate) time = "09:00";
  }
  let title = cleanTitle(text);
  if (!title) title = "음성 메모";
  if (title.length > 80) title = title.slice(0, 80).trim();
  // Java keeps a start time only when both a date and a time exist.
  return { kind, title, date: date ? ymd(date) : null, time: date ? time : null, hasTime: hasTime && date !== null, needsReview: review, explanation };
}

/** 「3시」 said with no 오전/오후/아침/저녁… (and not 13시~): the hour alone does not say which half of the day. */
function bareHour(raw: string): number | null {
  const m = TIME.exec(normalize(raw));
  if (!m || m[1]) return null;
  if (/오전|오후|아침|점심|낮|저녁|밤|새벽|AM|PM/i.test(raw)) return null;
  return Number(m[2]);
}

/**
 * The draft for the calendar: parseRule (kept line for line with the phone's Java parser), then
 * one human guess on top — 「3시 치과」 means 15:00, not 03:00. Hours 1–6 said alone are taken as
 * afternoon (nobody books a dentist at 3 a.m.); 7–12 stay as said. The AI still refines it.
 */
/** The user's day (설정): 퇴근 시각, 점심, 교시표. */
export interface DayClock {
  onWork?: string;
  offWork?: string;
  lunch?: string;
  periods?: string[];
}

const KO_NUM: Record<string, string> = { 일: "1", 이: "2", 삼: "3", 사: "4", 오: "5", 육: "6", 칠: "7", 팔: "8", 구: "9", 십: "10" };

/**
 * Speech-to-text slips in school words: 「오반도」 → 「5반도」, 「삼학년」 → 「3학년」, 「육교시」 →
 * 「6교시」. Only a single number word glued to 반·학년·교시·모둠·번, at a word start.
 */
export function fixNumbers(raw: string): string {
  return raw.replace(/(^|[^가-힣])(일|이|삼|사|오|육|칠|팔|구|십)(반|학년|교시|모둠|조)(?=$|[^가-힣]|도|은|는|이|가|에|의|과|와|을|를|만|부터|까지)/g, (_m, pre: string, n: string, unit: string) => `${pre}${KO_NUM[n]}${unit}`);
}

/**
 * Words about the user's own day become clock times: 「퇴근 전」 → 「16:40까지」, 「점심 전」 →
 * 「12:10까지」, 「점심시간에」 → 「12:10~13:00」, 「3교시 전」 → 「10:40까지」, 「3교시 후」 →
 * 「11:20」, 「5교시에」 → 「13:00~13:40」. Four digits before 까지·에·부터 (「1320까지」) are a time.
 */
export function timeWords(raw: string, day: DayClock = {}): string {
  const on = day.onWork || "08:20";
  const off = day.offWork || "16:20";
  const [l0, l1] = (day.lunch || "12:20-13:20").split("-");
  const per = day.periods ?? [];
  let v = fixNumbers(raw);
  v = v.replace(/출근\s*(?:하기\s*)?(?:전에|전까지|전)/g, `${on}까지`).replace(/출근\s*(?:하면|후에|후|하고|해서)/g, `${on}`).replace(/아침에(?!\s*\d)/g, `${on}에`);
  v = v.replace(/퇴근\s*(?:하기\s*)?(?:전에|전까지|전|까지)/g, `${off}까지`).replace(/퇴근\s*(?:후에|후|하고)/g, `${off}`);
  v = v.replace(/점심\s*(?:시간\s*)?(?:전에|전까지|전)/g, `${l0}까지`).replace(/점심\s*(?:시간\s*)?(?:후에|후|먹고)/g, `${l1}`).replace(/점심\s*(?:시간|때)\s*(?:에)?/g, `${l0}~${l1} `);
  v = v.replace(/(\d{1,2})\s*교시\s*(전에|전까지|전|후에|후|끝나고|뒤|에|부터)?/g, (m, n: string, w = "") => {
    const r = per[Number(n) - 1];
    if (!r) return m;
    const [a, b] = r.split("-");
    if (/전/.test(w)) return `${a}까지`;
    if (/후|끝나고|뒤/.test(w)) return `${b}부터 `;
    return `${a}~${b} `;
  });
  v = v.replace(/(?<![\d./:-])([01]\d|2[0-3])([0-5]\d)(?=\s*(?:까지|에|부터|시작|마감))/g, "$1:$2");
  return v;
}

/** 「16202120」: two clock times written together (HHMMHHMM). */
const PACKED_RANGE = /(?<![\d./:-])([01]\d|2[0-3])([0-5]\d)([01]\d|2[0-3])([0-5]\d)(?![\d./-])/;
/** 「1620~2120」 「16:20-21:20」 「1620 2120」 「16:20부터 21:20까지」. */
const CLOCK_RANGE = /(?<![\d./])([01]?\d|2[0-3]):?([0-5]\d)(\s*(?:~|-|–|부터|에서)\s*|\s+)([01]?\d|2[0-3]):?([0-5]\d)(?![\d./])(?:\s*까지)?/;
/** 「4시~6시」 「16시 20부터 21시 20까지」 (분 may be left out) 「오전 10시부터 12시 반까지」. */
const HOUR_RANGE = /(?:(오전|오후|아침|낮|저녁|밤|새벽)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?|\s*(반))?\s*(?:~|-|–|부터|에서)\s*(?:(오전|오후|아침|낮|저녁|밤|새벽)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?|\s*(반))?(?:\s*까지)?/;
/** 「16:20」 */
const CLOCK_ONE = /(?<![\d./])([01]?\d|2[0-3]):([0-5]\d)(?![\d./])/;
/** 「16시 20」 「3시 20에」 (분 left out; 「16시 20분」 is parseRule's own). */
const HOUR_MIN = /(?:(오전|오후|아침|낮|저녁|밤|새벽)\s*)?(\d{1,2})\s*시\s*(\d{1,2})(?!\d)(?!\s*(?:분|시|일|월|명|개|번|층|호|원|년|살|%|주|달))/;
/** 「오늘 1620 회의」: four digits alone count as a time only next to a day word. */
const PACKED_ONE = /(?<![\d./:-])([01]\d|2[0-3])([0-5]\d)(?![\d./:-])(?!\s*(?:원|명|개|번|호|층|년|건|초|살|km|m|%|kg|g|동|번지|대|권|장|쪽|p))/;
const DAY_WORD = /오늘|내일|모레|글피|요일|\d{1,2}\s*월\s*\d{1,2}\s*일|(?<!\d)\d{1,2}[./]\d{1,2}(?![\d])/;
const PM = /오후|낮|저녁|밤/;
const AM = /오전|아침|새벽/;
const MARKED = /오전|오후|아침|점심|낮|저녁|밤|새벽/;

/** The hour as meant: 오후 3 → 15, 오전 12 → 0, a bare 1–6 → afternoon. */
const meantHour = (p: string | undefined, v: number, bare: boolean) => (p && PM.test(p) && v < 12 ? v + 12 : p && AM.test(p) && v === 12 ? 0 : !p && bare && v >= 1 && v <= 6 ? v + 12 : v);

/** The sentence with the said time written as clock times, for the AI (「16202120」 → 「16:20~21:20」). */
export function clockText(raw0: string, day: DayClock = {}): string {
  const raw = timeWords(raw0, day);
  // In place, so 「오늘 1320까지 …」 reads 「오늘 13:20까지 …」 (the time keeps its 까지·부터).
  const t = timeRange(raw);
  if (t) return raw.replace(t.match, `${t.start}~${t.end}${/까지\s*$/.test(t.match) ? "까지" : ""}`);
  const one = singleTime(raw);
  return one ? raw.replace(one.match, one.time) : raw;
}

/**
 * A time range said in a sentence → start, end and the sentence without it. Clock forms are taken
 * as written; 「4시~6시」 follows the afternoon guess, and an end earlier than the start moves to
 * the afternoon too. The end must come after the start (so 「20261027」 is not a range).
 */
export function timeRange(raw: string): { start: string; end: string; rest: string; match: string } | null {
  const ok = (h1: number, m1: number, h2: number, m2: number, text: string) =>
    h1 <= 23 && h2 <= 23 && h2 * 60 + m2 > h1 * 60 + m1 ? { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2)}:${pad(m2)}`, rest: raw.replace(text, " "), match: text } : null;
  const p = PACKED_RANGE.exec(raw);
  if (p) {
    const r = ok(+p[1], +p[2], +p[3], +p[4], p[0]);
    if (r) return r;
  }
  const c = CLOCK_RANGE.exec(raw);
  // Plain digits count only as two full HHMM, or with a colon, or joined by ~ / 부터.
  const four = (h: string, x: string) => h.length === 2 && x.length === 2;
  if (c && (c[0].includes(":") || (four(c[1], c[2]) && four(c[4], c[5])) || (c[3].trim() !== "" && four(c[1], c[2])))) {
    const r = ok(+c[1], +c[2], +c[4], +c[5], c[0]);
    if (r) return r;
  }
  const h = HOUR_RANGE.exec(raw);
  if (!h) return null;
  const bare = !MARKED.test(raw);
  const h1 = meantHour(h[1], +h[2], bare);
  let h2 = meantHour(h[5] ?? h[1], +h[6], bare);
  const m1 = h[3] ? +h[3] : h[4] ? 30 : 0;
  const m2 = h[7] ? +h[7] : h[8] ? 30 : 0;
  if (h2 * 60 + m2 <= h1 * 60 + m1 && h2 < 12) h2 += 12;
  if (m1 > 59 || m2 > 59) return null;
  return ok(h1, m1, h2, m2, h[0]);
}

/** One clock time parseRule cannot read: 「16:20」, 「16시 20」, 「오늘 1620」. */
export function singleTime(raw: string): { time: string; rest: string; match: string } | null {
  const c = CLOCK_ONE.exec(raw);
  if (c) return { time: `${pad(+c[1])}:${c[2]}`, rest: raw.replace(c[0], " "), match: c[0] };
  const h = HOUR_MIN.exec(raw);
  if (h && +h[3] <= 59) {
    const hh = meantHour(h[1], +h[2], !MARKED.test(raw));
    if (hh <= 23) return { time: `${pad(hh)}:${pad(+h[3])}`, rest: raw.replace(h[0], " "), match: h[0] };
  }
  const p = PACKED_ONE.exec(raw);
  if (p && DAY_WORD.test(raw.replace(p[0], " "))) return { time: `${p[1]}:${p[2]}`, rest: raw.replace(p[0], " "), match: p[0] };
  return null;
}

/** 「메모 …」 「기억: …」 at the start: always a 기억, whatever else is in it. */
const MEMO_HEAD = /^\s*(메모|기억|노트)\s*[:：,]?\s+/;

/**
 * What the words alone make: a 기억 unless they clearly say when. `final`: no AI needed (an
 * explicit 「메모 …」, or nothing about a day or time at all). A date without a time and without
 * appointment/to-do words (「11월 3일에 엄마가 김치 보내준대」) is a 기억 draft the AI may turn
 * into an entry; when the AI is unsure it stays a 기억 (with 「일정으로」·「할 일로」 on its card).
 */
export function memoDraft(raw0: string, now: Date, day: DayClock = {}): { title: string; details?: string; final: boolean } | null {
  const raw = MEMO_HEAD.test(raw0) ? raw0 : timeWords(raw0, day);
  const head = MEMO_HEAD.exec(raw);
  const body = head ? raw.slice(head[0].length) : raw;
  const [first, ...rest] = body.trim().split("\n");
  const memo = (final: boolean) => ({ title: first.trim().slice(0, 80), details: rest.join("\n").trim() || undefined, final });
  if (head) return body.trim() ? memo(true) : null;
  if (timeRange(raw) || singleTime(raw)) return null;
  const r = parseRule(raw, now);
  if (!r.date && !r.hasTime) return memo(true);
  // Hearsay (「…보내준대」, 「…온다고」) is something to remember, even with a to-do word in it.
  const hearsay = /(대|래|더라|다고|라고|한다)\s*[.!]?\s*$/.test(raw.trim());
  if (r.date && !r.hasTime && !EVENT_WORDS.test(raw) && (hearsay || !TASK_WORDS.test(raw)) && !/까지|마감|일정|약속|예약/.test(raw)) return memo(false);
  return null;
}

export function parseDraft(raw0: string, now: Date, day: DayClock = {}): RuleResult {
  const raw = timeWords(raw0, day);
  const range = timeRange(raw);
  if (range) {
    // The day and the title from the rest of the sentence; the range is the time.
    const r = parseRule(range.rest, now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const date = r.date ?? ymd(today);
    const taskOnly = r.kind === "TODO" && !/일정|약속|근무|회의|수업|모임|출장|진료|상담/.test(raw);
    return { ...r, kind: taskOnly ? "TODO" : "SCHEDULE", date, time: range.start, end: range.end, hasTime: true, needsReview: false, explanation: "날짜와 시간을 찾음" };
  }
  const one = singleTime(raw);
  if (one) {
    const r = parseRule(one.rest, now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [hh, mm] = one.time.split(":").map(Number);
    // No day said: today if that time is still ahead, else tomorrow (like parseRule).
    const date = r.date ?? ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm) > now ? today : addDays(today, 1));
    const taskOnly = r.kind === "TODO" && !/일정|약속|근무|회의|수업|모임|출장|진료|상담/.test(raw);
    return { ...r, kind: taskOnly ? "TODO" : "SCHEDULE", date, time: one.time, hasTime: true, needsReview: false, explanation: r.date ? "날짜와 시간을 찾음" : "시간을 찾고 다음 시점으로 날짜를 추정함" };
  }
  const r = parseRule(raw, now);
  const h = bareHour(raw);
  if (!r.hasTime || !r.time || !r.date || h === null || h < 1 || h > 6) return r;
  const [hh, mm] = r.time.split(":").map(Number);
  if (hh !== h) return r;
  const time = `${pad(hh + 12)}:${pad(mm)}`;
  let date = r.date;
  // No day said: parseRule moved 03:00 to tomorrow because it had passed; 15:00 may still be today.
  if (r.explanation === "시간을 찾고 다음 시점으로 날짜를 추정함" && !/(?<!\d)24시/.test(raw)) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh + 12, mm);
    date = ymd(at > now ? today : addDays(today, 1));
  }
  return { ...r, time, date };
}

/** Words that make a sentence more than 「one appointment」: lists, order, reminders, memory, school. */
const NOT_SIMPLE = /[,，、:;·\n~]|그리고|그 ?전에|전에|후에|다음에|끝나고|하고 |랑 |이랑|및|까지|부터|알려|알림|기억|챙기|준비|하위|매주|매일|격주|반복|마다|학교|학년|학부모|학생|교무|교실|수업|담임|연수|공문|결재|출석|수행평가|방과후|교감|교장|동아리|시험|평가|회의|조회|입학|졸업|면담|운동장|급식|학급|방학|개학/;
/** Conversational endings the rule title keeps (「치과 예약 있어」): the AI writes a cleaner title. */
const TITLE_TAIL = /(?:있어|있음|있다|있고|해|해야|해줘|해 줘|줘|야|이야|거야|잡아|잡아줘|추가|넣어|넣어줘|해요|요|임|함|거든|래|대)$/;

/**
 * True when the rule draft is as good as the AI's would be: one appointment, an explicit date
 * and clock time (not guessed), a short clean title, nothing else in the sentence. Such sentences
 * skip the AI (「간단한 문장은 AI 생략」). Lists, sub-tasks, reminders, school items, documents and
 * photos always go to the AI.
 */
export function isSimpleCertain(raw: string, r: RuleResult): boolean {
  // A said range (「1620~2120」) is as clear as a single time: judge the rest of the sentence.
  const text = normalize(r.end ? timeRange(raw)?.rest ?? raw : singleTime(raw)?.rest ?? raw).trim();
  if (r.kind !== "SCHEDULE" || !r.hasTime || r.needsReview || r.explanation !== "날짜와 시간을 찾음") return false;
  if (text.length > 30 || NOT_SIMPLE.test(text)) return false;
  if (/(아침|저녁|밤|새벽|낮)(?!\s*\d)/.test(text)) return false;
  // 「6시」 alone may be morning or evening: let the AI decide.
  if (!r.end && bareHour(raw) === 6) return false;
  const title = r.title.trim();
  return title !== "음성 메모" && title.length >= 2 && title.length <= 15 && !TITLE_TAIL.test(title) && /^[가-힣A-Za-z0-9 ]+$/.test(title);
}
