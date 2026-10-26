/**
 * The phone's rule parser (Android `KoreanCommandParser`), line for line, so a draft made on
 * the Mac and one made on the phone from the same words come out the same. It runs in well
 * under a millisecond: this is what puts an entry on the calendar before the local AI answers.
 * Shared cases: tests/fixtures/rule-cases.json (also run against the Java parser).
 */
import { addDays, pad, ymd } from "./dates";

export interface RuleResult {
  kind: "SCHEDULE" | "TODO";
  title: string;
  /** YYYY-MM-DD, null when no usable date. */
  date: string | null;
  /** HH:MM (09:00 for date-only entries, like the Java parser). */
  time: string | null;
  /** A clock time was actually said (not the 09:00 stand-in). */
  hasTime: boolean;
  needsReview: boolean;
  explanation: string;
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
  const text = normalize(raw).trim();
  if (r.kind !== "SCHEDULE" || !r.hasTime || r.needsReview || r.explanation !== "날짜와 시간을 찾음") return false;
  if (text.length > 30 || NOT_SIMPLE.test(text)) return false;
  if (/(아침|저녁|밤|새벽|낮)(?!\s*\d)/.test(text)) return false;
  const title = r.title.trim();
  return title !== "음성 메모" && title.length >= 2 && title.length <= 15 && !TITLE_TAIL.test(title) && /^[가-힣A-Za-z0-9 ]+$/.test(title);
}
