/**
 * The phone's rule parser (Android `KoreanCommandParser`), line for line, so a draft made on
 * the Mac and one made on the phone from the same words come out the same. It runs in well
 * under a millisecond: this is what puts an entry on the calendar before the local AI answers.
 * Shared cases: tests/fixtures/rule-cases.json (also run against the Java parser).
 */
import { addDays, pad, ymd } from "./dates";
import { holiday } from "./holidays";

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
  /** Last day when a span of days was said (「11월 2일부터 6일까지」, 「내일부터 사흘간」): a 기간. Mac drafts only. */
  until?: string;
  /** 「30분 전에 알려줘」 「하루 전에 알림」: the reminder, minutes before the start/due. Mac drafts only. */
  remindBefore?: number;
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
const HOLIDAY_ALIAS: Record<string, string> = { 크리스마스: "성탄절", 성탄절: "성탄절", 한글날: "한글날", 개천절: "개천절", 삼일절: "삼일절", 어린이날: "어린이날", 현충일: "현충일", 광복절: "광복절", 신정: "신정", 부처님오신날: "부처님오신날", "추석 연휴": "추석 연휴", 추석: "추석", "설날 연휴": "설날 연휴", 설날: "설날", 설: "설날" };

/**
 * Day words the shared parser (same answers as the phone's Java parser) does not know, said as
 * dates it does (2026-10-27 밤 안정화): 「다음 달 3일」 「5일」 「월말」 「주말」 「3일 뒤」
 * 「일주일 뒤」 「30분 뒤」 「2시간 후」 「다다음 주 월요일」 「지난 금요일」 「어제」 「이번 주 안에」
 * 「다음 주 중에」 「이번 달 안에」 「정오」 「자정까지」 「크리스마스」 「추석」, and a lone 「1530 회의」.
 * Past days carry the year so they are not moved to next year.
 */
export function dateWords(raw: string, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const md = (d: Date) => `${d.getMonth() + 1}월 ${d.getDate()}일`;
  const past = (d: Date) => `${d.getFullYear()}년 ${md(d)}`;
  const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const at = (d: Date) => `${d < today ? past(d) : md(d)} ${hm(d)}`;
  const DOW = "일월화수목금토";
  const dow = (c: string) => DOW.indexOf(c);
  const nextMonday = () => addDays(today, ((8 - today.getDay()) % 7) || 7);
  const monthDay = (y: number, m: number, d: number) => {
    const x = new Date(y, m, d);
    return x.getMonth() === ((m % 12) + 12) % 12 ? x : null;
  };
  let v = raw;
  // Spoken short forms: 낼 · 담주 · 수욜.
  v = v.replace(/(^|\s)낼(?=\s|$|부터|까지)/g, "$1내일").replace(/담주/g, "다음 주").replace(/([월화수목금토일])욜/g, "$1요일");
  // Numbers said in words before 월/일: 「삼월 이일」 「십일월 오일」 「이십일」 (a lone one-syllable 「오일」 stays: oil).
  const SINO: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
  const sino = (w: string) => {
    let n = 0;
    let cur = 0;
    for (const c of w) {
      if (c === "십") { n += (cur || 1) * 10; cur = 0; } else cur = SINO[c] ?? NaN;
    }
    return n + cur;
  };
  v = v.replace(/(?<![가-힣])([일이삼사오육칠팔구십]{1,3})월\s*([일이삼사오육칠팔구십]{1,3})일/g, (m, a: string, b: string) => {
    const x = sino(a);
    const y = sino(b);
    return x >= 1 && x <= 12 && y >= 1 && y <= 31 ? `${x}월 ${y}일` : m;
  });
  v = v.replace(/(?<![가-힣\d])((?:[이삼]?십)[일이삼사오육칠팔구]?)일(?=\s|$|까지|에|부터)/g, (m, a: string) => {
    const x = sino(a);
    return x >= 10 && x <= 31 ? `${x}일` : m;
  });
  // 「한 시간 뒤」 「두 시간 후」 「반 시간 뒤」 (before the hour words turn 「한 시」 into 「1시」).
  v = v.replace(/(한|두|세|네)\s*시간/g, (_m, n: string) => `${"한두세네".indexOf(n) + 1}시간`).replace(/반\s*시간/g, "30분");
  v = v.replace(/(\d{1,3})\s*분\s*(?:뒤|후)(?:에)?/g, (_m, n: string) => at(new Date(now.getTime() + Number(n) * 60_000)));
  v = v.replace(/(\d{1,2})\s*시간\s*(?:뒤|후)(?:에)?(?:\s*(\d{1,2})\s*분\s*(?:뒤|후)?)?/g, (_m, h: string, mm?: string) => at(new Date(now.getTime() + (Number(h) * 60 + Number(mm ?? 0)) * 60_000)));
  v = v.replace(/(?:일주일|1\s*주일|한\s*주)\s*(?:뒤|후)(?:에)?/g, () => md(addDays(today, 7)));
  v = v.replace(/(\d)\s*주\s*(?:뒤|후)(?:에)?/g, (_m, n: string) => md(addDays(today, 7 * Number(n))));
  v = v.replace(/(\d{1,3})\s*일\s*(?:뒤|후)(?:에)?/g, (_m, n: string) => md(addDays(today, Number(n))));
  // 다다음 주 X요일 · 지난(주) X요일 · 어제 · 그저께
  v = v.replace(/다다음\s*주\s*([월화수목금토일])요일/g, (_m, c: string) => md(addDays(nextMonday(), 7 + ((dow(c) + 6) % 7))));
  v = v.replace(/(?:지난|저번)\s*주\s*([월화수목금토일])요일/g, (_m, c: string) => past(addDays(nextMonday(), -14 + ((dow(c) + 6) % 7))));
  v = v.replace(/(?:지난|저번)\s*([월화수목금토일])요일/g, (_m, c: string) => past(addDays(today, -(((today.getDay() - dow(c) + 7) % 7) || 7))));
  v = v.replace(/그저께|그제/g, () => past(addDays(today, -2))).replace(/어제/g, () => past(addDays(today, -1)));
  // 다음 달 N일 · 이번 달 N일 · 다음 달 말 · 월말 · 이번 달 안에
  // A day the month does not have (「다음 달 31일」 in November) stays 「11월 31일」: no date, to be checked (not this month's 31st).
  v = v.replace(/다음\s*달\s*(\d{1,2})\s*일/g, (_m, n: string) => { const d = monthDay(today.getFullYear(), today.getMonth() + 1, Number(n)); return d ? md(d) : `${((today.getMonth() + 1) % 12) + 1}월 ${n}일`; });
  v = v.replace(/이번\s*달\s*(\d{1,2})\s*일/g, (m, n: string) => { const d = monthDay(today.getFullYear(), today.getMonth(), Number(n)); return d ? md(d) : m; });
  v = v.replace(/다음\s*달\s*(?:말|말일)/g, () => md(new Date(today.getFullYear(), today.getMonth() + 2, 0)));
  v = v.replace(/이번\s*달\s*(?:안에|안으로|중에|중|내로|내)/g, () => `${md(new Date(today.getFullYear(), today.getMonth() + 1, 0))}까지`);
  v = v.replace(/(?:이번\s*달\s*)?(?:월말|말일)/g, () => md(new Date(today.getFullYear(), today.getMonth() + 1, 0)));
  // 「12월 첫째 주 금요일」 「11월 셋째 주 수요일」 「다음 달 첫 월요일」 「이번 달 마지막 금요일」: the Nth such weekday
  // of that month (they came out as this Friday / 11월 4일). 「10월 마지막 날」: the month's last day.
  const monthOf = (num?: string, rel?: string) => (num ? Number(num) - 1 : today.getMonth() + (rel === "다음" ? 1 : 0));
  v = v.replace(/(?:(\d{1,2})\s*월|(다음|이번)\s*달)\s*(첫째|첫|둘째|셋째|넷째|다섯째|마지막)\s*(?:주\s*)?([월화수목금토일])요일/g, (m, num?: string, rel?: string, nth?: string, c?: string) => {
    const mon = monthOf(num, rel);
    const y = num && new Date(today.getFullYear(), mon + 1, 0) < today ? today.getFullYear() + 1 : today.getFullYear();
    const w = dow(c!);
    const n = ["첫", "둘째", "셋째", "넷째", "다섯째"].findIndex((x) => nth!.startsWith(x));
    let d: Date;
    if (n >= 0) {
      const first = new Date(y, mon, 1);
      d = addDays(first, ((w - first.getDay() + 7) % 7) + 7 * n);
      if (d.getMonth() !== ((mon % 12) + 12) % 12) return m;
    } else {
      const last = new Date(y, mon + 1, 0);
      d = addDays(last, -((last.getDay() - w + 7) % 7));
    }
    return d < today ? past(d) : md(d);
  });
  v = v.replace(/(?:(\d{1,2})\s*월|(다음|이번)\s*달)\s*마지막\s*날/g, (_m, num?: string, rel?: string) => {
    const mon = monthOf(num, rel);
    const y = num && new Date(today.getFullYear(), mon + 1, 0) < today ? today.getFullYear() + 1 : today.getFullYear();
    return md(new Date(y, mon + 1, 0));
  });
  // 「11월 말까지」 「12월 말」: that month's last day.
  v = v.replace(/(\d{1,2})\s*월\s*(?:말일|말)(?=\s|까지|에|$|경)/g, (m, num: string) => {
    const mon = Number(num) - 1;
    if (mon < 0 || mon > 11) return m;
    const y = new Date(today.getFullYear(), mon + 1, 0) < today ? today.getFullYear() + 1 : today.getFullYear();
    return md(new Date(y, mon + 1, 0));
  });
  // 「다음 주 토일 여행」 「이번 주 토·일」: from the first weekday to the second of that week.
  v = v.replace(/(다음|이번)\s*주\s*([월화수목금토일])\s*[·,~-]?\s*([월화수목금토일])(?![가-힣])/g, (m, w: string, a: string, b: string) => {
    const mon = w === "다음" ? nextMonday() : addDays(today, -((today.getDay() + 6) % 7));
    const at = (c: string) => addDays(mon, (dow(c) + 6) % 7);
    return at(b) > at(a) ? `${md(at(a))}부터 ${md(at(b))}까지` : m;
  });
  // 「다음 주 내내」 「이번 주 동안」: that week's weekdays (before 「다음 주 내」 below reads 「내내」 as 「내」).
  v = v.replace(/(다음|이번)\s*주\s*(?:내내|동안|하루\s*종일)/g, (_m, w: string) => {
    const mon = w === "다음" ? nextMonday() : addDays(today, -((today.getDay() + 6) % 7));
    const from = mon < today ? today : mon;
    return `${md(from)}부터 ${md(addDays(mon, 4))}까지`;
  });
  // 이번 주 안에 → 이번 주 금요일까지 · 다음 주 중에 → 다음 주 금요일까지
  v = v.replace(/(?:이번\s*주|금주)\s*(?:안에|안으로|중에|중|내로|내)/g, () => `${md(addDays(today, ((5 - today.getDay() + 7) % 7)))}까지`);
  v = v.replace(/다음\s*주\s*(?:안에|안으로|중에|중|내로|내)/g, () => `${md(addDays(nextMonday(), 4))}까지`);
  // 주말 (토요일): 다음 주말 · 이번 주말 · 주말
  v = v.replace(/다음\s*주말/g, () => md(addDays(nextMonday(), 5)));
  v = v.replace(/(?:이번\s*)?주말/g, () => md(today.getDay() === 0 ? today : addDays(today, (6 - today.getDay() + 7) % 7)));
  // A bare 「5일」 (not 「11월 5일」, not 「5일 동안」): this month, or next month when it has passed.
  v = v.replace(/(?<!월\s*)(?<![\d.\-/])(\d{1,2})\s*일(?!\s*(?:동안|간|째|분|만에|정도|씩|에\s*한|마다))(?=\s|까지|에|부터|$|[,.]|은|는|이|도)/g, (m, n: string) => {
    const k = Number(n);
    if (k < 1 || k > 31) return m;
    const d = (k >= today.getDate() ? monthDay(today.getFullYear(), today.getMonth(), k) : null) ?? monthDay(today.getFullYear(), today.getMonth() + 1, k);
    return d ? md(d) : m;
  });
  // 정오 · 자정 · named holidays (the next one from today)
  // 「밤 12시」 is midnight, not noon.
  v = v.replace(/(?:밤|저녁)\s*(?:12|열두)\s*시(?!\s*\d+\s*분|\s*반)/g, "23:59");
  v = v.replace(/정오/g, "12시").replace(/자정\s*(?:전까지|까지|전)/g, "23:59까지").replace(/자정(?:에)?/g, "23:59");
  v = v.replace(/크리스마스|성탄절|한글날|개천절|삼일절|어린이날|현충일|광복절|신정|부처님오신날|추석\s*연휴|추석|설날\s*연휴|설날/g, (m) => {
    const name = HOLIDAY_ALIAS[m.replace(/\s+/g, " ")] ?? m;
    for (let i = 0; i < 400; i++) {
      const d = addDays(today, i);
      if (holiday(ymd(d)) === name) return md(d);
    }
    return m;
  });
  // 「1530 회의」: four digits at the very start, then words, are a time.
  v = v.replace(/^\s*([01]\d|2[0-3])([0-5]\d)(?=\s+[가-힣])/, "$1:$2");
  return v;
}

export function timeWords(raw: string, day: DayClock = {}, now?: Date): string {
  const on = day.onWork || "08:20";
  const off = day.offWork || "16:20";
  const [l0, l1] = (day.lunch || "12:20-13:20").split("-");
  const per = day.periods ?? [];
  let v = fixNumbers(raw);
  if (now) v = dateWords(v, now);
  // 「3:30 PM」 「Due Friday 5pm」 「tomorrow 10am」: English am/pm and day words (the worker reads them the same way).
  v = v.replace(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/gi, (_m, h: string, mm: string | undefined, ap: string) => `${/p/i.test(ap) ? "오후" : "오전"} ${mm ? `${h}:${mm}` : `${h}시`}`);
  v = v.replace(/\b(mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b/gi, (_m, d: string) => `${"월화수목금토일"[["mon", "tue", "wed", "thu", "fri", "sat", "sun"].findIndex((x) => d.toLowerCase().startsWith(x))]}요일`);
  v = v.replace(/\btomorrow\b/gi, "내일").replace(/\btonight\b/gi, "오늘 밤").replace(/\btoday\b/gi, "오늘").replace(/\bdue\b\s*/gi, "");
  // 「오후 3~5시」: both ends are hours (it read 「5시」 alone: 05:00 / 17:00).
  v = v.replace(/(?<![\d/.:\-월])(\d{1,2})\s*([~\-–])\s*(\d{1,2})\s*시/g, "$1시$2$3시");
  // 「4시쯤」 「12시 정각」 「3시경」: the hour itself.
  v = v.replace(/(\d{1,2}\s*시(?:\s*\d{1,2}\s*분|\s*반)?)\s*(?:쯤|경|정각)(?:에)?/g, "$1");
  // 「오후 2:40」 「저녁 7:30」: a clock time after a part of the day (it came out 02:40 / 07:30).
  v = v.replace(/(오후|저녁|밤|낮)\s*(\d{1,2}):([0-5]\d)/g, (m, w: string, h: string, mm: string) => {
    const n = Number(h);
    return n < 12 && !(w === "낮" && n >= 11) ? `${pad(n + 12)}:${mm}` : n <= 23 ? `${pad(n)}:${mm}` : m;
  });
  v = v.replace(/(오전|아침|새벽)\s*(\d{1,2}):([0-5]\d)/g, (m, _w: string, h: string, mm: string) => (Number(h) === 12 ? `00:${mm}` : Number(h) < 12 ? `${pad(Number(h))}:${mm}` : m));
  // 「퇴근하고 7시 영화」: the said hour, in the evening (not the 퇴근 time itself).
  v = v.replace(/퇴근\s*(?:하고|후에|후|해서|하면)\s*(\d{1,2})\s*시/g, (_m, h: string) => `${Number(h) < 12 ? "저녁 " : ""}${h}시`);
  // 「3교시~5교시」 「1~2교시」 「4,5,6교시」: from the first period's start to the last one's end.
  v = v.replace(/(\d{1,2})\s*(?:교시)?\s*(?:~|-|–|부터)\s*(\d{1,2})\s*교시(?:\s*까지)?/g, (m, a: string, b: string) => {
    const x = per[Number(a) - 1];
    const y = per[Number(b) - 1];
    return x && y && Number(b) > Number(a) ? `${x.split("-")[0]}~${y.split("-")[1]} ` : m;
  });
  v = v.replace(/(\d{1,2})((?:\s*,\s*\d{1,2})+)\s*교시/g, (m, a: string, rest: string) => {
    const nums = [a, ...rest.split(",").map((x) => x.trim()).filter(Boolean)].map(Number);
    const x = per[Math.min(...nums) - 1];
    const y = per[Math.max(...nums) - 1];
    return x && y ? `${x.split("-")[0]}~${y.split("-")[1]} ` : m;
  });
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
  const raw = MEMO_HEAD.test(raw0) ? raw0 : timeWords(raw0, day, now);
  const head = MEMO_HEAD.exec(raw);
  const body = head ? raw.slice(head[0].length) : raw;
  const [first, ...rest] = body.trim().split("\n");
  const memo = (final: boolean) => ({ title: first.trim().slice(0, 80), details: rest.join("\n").trim() || undefined, final });
  if (head) return body.trim() ? memo(true) : null;
  if (timeRange(raw) || singleTime(raw) || daySpan(raw, now)) return null;
  const r = parseRule(raw, now);
  // Something about a day the rules could not read: not a sure 기억 — let the AI decide.
  const dayHint = /(?<![\d-])\d{1,2}\s*일(?!\s*(?:동안|간|째))|주말|월말|말일|(?:뒤|후)(?:에)?(?:\s|$)|안에|중에|내로|자정|정오|연휴|다음\s*달|이번\s*달|오전|오후|저녁|아침|새벽|방과\s*후/.test(raw);
  if (!r.date && !r.hasTime) return memo(!dayHint);
  // Hearsay (「…보내준대」, 「…온다고」) is something to remember, even with a to-do word in it.
  const hearsay = /(대|래|더라|다고|라고|한다)\s*[.!]?\s*$/.test(raw.trim());
  if (r.date && !r.hasTime && !EVENT_WORDS.test(raw) && (hearsay || !TASK_WORDS.test(raw)) && !/까지|마감|일정|약속|예약/.test(raw)) return memo(false);
  return null;
}

/** 「30분 전에 알려줘」 「1시간 전 알림」 「하루 전에」 「전날」 (with an asking word after it, or at the end). */
const REMIND_BEFORE = /(?:(\d{1,3})\s*분|(\d{1,2}|한|두|세)\s*시간|(하루|전날|\d{1,2}\s*일|일주일))\s*(?:전에?)?\s*(?:미리\s*)?(알려\s*줘|알려\s*주세요|알려|알림|알람)/;

export function parseDraft(raw0: string, now: Date, day: DayClock = {}): RuleResult {
  // The reminder phrase comes off first (it left 「치과 30분 전에」 / 「치과 간 전 알림」 in titles).
  const rb = REMIND_BEFORE.exec(raw0);
  if (!rb || !/전/.test(rb[0])) return tidyDraft(parseDraftRaw(raw0, now, day));
  const n = (x: string) => ({ 한: 1, 두: 2, 세: 3 } as Record<string, number>)[x] ?? Number(x);
  const minutes = rb[1] ? Number(rb[1]) : rb[2] ? n(rb[2]) * 60 : rb[3] === "일주일" ? 7 * 1440 : /^\d/.test(rb[3]) ? Number(rb[3].replace(/\D/g, "")) * 1440 : 1440;
  const r = tidyDraft(parseDraftRaw(raw0.replace(rb[0], " ").replace(/\s+/g, " ").trim(), now, day));
  return { ...r, remindBefore: minutes };
}

/** Leftovers the shared parser keeps in titles: 「(화)」, an ISO date, a leading 「부터」 or 「매주」. */
function tidyDraft(r: RuleResult): RuleResult {
  const title = r.title
    .replace(/\(\s*[월화수목금토일]\s*\)/g, " ")
    .replace(/(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/g, " ")
    .replace(/(?<!\d)\d{4}-(?=\s|$)/g, " ")
    .replace(/(?:^|\s)(?:내년|올해|금년)(?=\s|$)/g, " ")
    .replace(/(?<!\d)\d{4}\.(?=\s|$)/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/(?:^|\s)(?:오전|오후)\s*(?:중|늦게|일찍)(?=\s|$)/g, " ")
    .replace(/(?:^|\s)(?:해\s*)?줘$/g, " ")
    .replace(/^(?:\s*(?:부터|까지|에서|에|~|-|,|매주|매일|매달|매월|격주|평일|주말|마다|이따|이따가|이후|이전|중으로|중에|안에|내로|낼|담주))+\s*/g, "")
    .replace(/(?:^|\s)(?:오전|오후)에(?=\s)/g, " ")
    .replace(/(?:^|\s)(?:하루\s*종일|온종일|종일)(?=\s|$)/g, " ")
    .replace(/^[\s:·,]+|[\s:·,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 「내일 3시에 알려줘」: nothing left but the asking → 「알림」.
  if (!title) return { ...r, title: /알려|알림/.test(r.title) || r.title === "줘" ? "알림" : r.title };
  return title !== r.title ? { ...r, title } : r;
}

const DAY_TOKEN = "(\\d{4}년\\s*\\d{1,2}월\\s*\\d{1,2}일|\\d{1,2}월\\s*\\d{1,2}일|\\d{1,2}[./]\\d{1,2}|(?:다음\\s*주\\s*|이번\\s*주\\s*)?[월화수목금토일]요일|오늘|내일|모레|글피)";
const DAY_SPAN = new RegExp(`${DAY_TOKEN}\\s*(?:부터|~|-|–|에서)\\s*${DAY_TOKEN}\\s*(?:까지)?`);
const DAY_COUNT = new RegExp(`${DAY_TOKEN}\\s*부터\\s*(\\d{1,2}일|이틀|사흘|나흘|닷새|엿새|일주일)\\s*(?:간|동안)`);
const COUNT_WORD: Record<string, number> = { 이틀: 2, 사흘: 3, 나흘: 4, 닷새: 5, 엿새: 6, 일주일: 7 };
const COUNT_ANY = /(\d{1,2}일|이틀|사흘|나흘|닷새|엿새|일주일)\s*(?:간|동안)|(이틀|사흘|나흘|닷새)(?=\s)/;
const DAY_FROM = new RegExp(`${DAY_TOKEN}\\s*부터`);
const DAY_PAIR = new RegExp(`${DAY_TOKEN}\\s*(?:,|과|와|및)?\\s*${DAY_TOKEN}\\s*(?=이틀|양일)`);

/** 「11월 2일부터 6일까지 체험학습」 「10/28~10/30 출장」 「다음 주 월요일부터 금요일까지」 「내일부터 사흘간 연수」 → a 기간. */
function daySpan(raw: string, now: Date): RuleResult | null {
  const dayOf = (tok: string) => parseRule(`${tok} 일정`, now).date;
  let from: string | null = null;
  let to: string | null = null;
  let rest = raw;
  const span = DAY_SPAN.exec(raw);
  if (span) {
    from = dayOf(span[1]);
    // 「다음 주 월요일부터 금요일까지」: the second weekday is in the same week as the first.
    const week = /다음\s*주|이번\s*주/.exec(span[1])?.[0];
    to = dayOf(week && /^[월화수목금토일]요일$/.test(span[2].trim()) ? `${week} ${span[2]}` : span[2]);
    rest = raw.replace(span[0], " ");
  } else if (DAY_COUNT.test(raw)) {
    const count = DAY_COUNT.exec(raw)!;
    from = dayOf(count[1]);
    const n = COUNT_WORD[count[2]] ?? Number(count[2].replace("일", ""));
    to = from ? ymd(addDays(new Date(`${from}T00:00`), n - 1)) : null;
    rest = raw.replace(count[0], " ");
  } else {
    // 「3일간 연수 11월 4일부터」 (the length first) · 「17일 18일 이틀 출장」 (both days, then the length).
    const len = COUNT_ANY.exec(raw);
    const start = DAY_FROM.exec(raw) ?? DAY_PAIR.exec(raw);
    if (!len || !start) return null;
    from = dayOf(start[1]);
    const word = len[1] ?? len[2];
    const n = COUNT_WORD[word] ?? Number(word.replace("일", ""));
    to = from ? ymd(addDays(new Date(`${from}T00:00`), n - 1)) : null;
    rest = raw.replace(start[0], " ").replace(len[0], " ");
  }
  if (!from || !to || to <= from || /\d{1,2}\s*시|\d{1,2}:\d{2}/.test(raw)) return null;
  const r = parseRule(rest.trim() || "기간", now);
  return { ...r, kind: "SCHEDULE", date: from, until: to, time: null, hasTime: false, needsReview: false, explanation: "기간을 찾음" };
}

function parseDraftRaw(raw0: string, now: Date, day: DayClock = {}): RuleResult {
  const raw = timeWords(raw0, day, now);
  const days = daySpan(raw, now);
  if (days) return days;
  const range = timeRange(raw);
  if (range) {
    // The day and the title from the rest of the sentence; the range is the time.
    const r = parseRule(range.rest, now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const date = r.date ?? ymd(today);
    // A time range is something that takes that time (an appointment), unless it is a hand-in.
    const taskOnly = r.kind === "TODO" && /제출|마감|내기|납부|신청|보내/.test(range.rest) && !/일정|약속|근무|회의|수업|모임|출장|진료|상담|연수/.test(raw);
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
  // (A to-do too: 「4시 전화하기」 at 9 a.m. went to tomorrow — its explanation differs, so ask without the hour.)
  const noDay = r.explanation === "시간을 찾고 다음 시점으로 날짜를 추정함" || parseRule(raw.replace(/\d{1,2}\s*시(?:\s*\d{1,2}\s*분|\s*반)?/, " "), now).date === null;
  if (noDay && !/(?<!\d)24시/.test(raw)) {
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
