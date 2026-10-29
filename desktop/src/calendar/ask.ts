/**
 * 「질문하면 답하기」: a local answer engine (no AI, no cost) over the user's own records —
 * events, to-dos, periods, 기억, inbox results, Obsidian notes (Drive 「블랙홀/노트/」) and secret
 * NAMES (never values). Character-bigram inverted index (works for Korean without a tokenizer),
 * date words turned into ranges by code. Only when the local result is fuzzy, or the question
 * asks for a summary, the few best lines go to the AI.
 *
 * Shared by the main window's chat panel and the quick window (same engine, same answers).
 */
import { addDays, DOW, parseDay, ymd } from "./dates";
import type { CalendarState } from "./model";
import { parseRule } from "./rules";

export type DocKind = "event" | "task" | "period" | "note" | "obsidian" | "inbox" | "secret";

export interface AskDoc {
  /** Entry id, `secret:<name>`, `obsidian:<path>` or `inbox:<n>`. */
  id: string;
  kind: DocKind;
  title: string;
  text: string;
  /** The day the record is about (event day, deadline, period start, note day). */
  date: string;
  /** Period end. */
  to?: string;
  /** When it was put in (YYYY-MM-DD) — 「지난주에 …라고 했지?」 asks by this. */
  said: string;
  time?: string;
  done?: boolean;
  /** Where it came from (원문 위치): source, note path. */
  where: string;
}

export interface AskSources {
  secrets: { name: string; at: string }[];
  notes: { path: string; title: string; text: string; date: string }[];
}

export interface AskHit {
  id: string;
  kind: DocKind;
  title: string;
  when: string;
  where: string;
}

export interface Answer {
  /** local: answered here · ai: send `lines` to the AI · none: nothing found. */
  mode: "local" | "ai" | "none";
  text: string;
  hits: AskHit[];
  /** For the AI (mode "ai"): `[id] …` lines, never a secret value. */
  lines: string[];
  /** Milliseconds the local search took. */
  ms: number;
}

export const KIND_LABEL: Record<DocKind, string> = { event: "일정", task: "할 일", period: "기간", note: "기억", obsidian: "노트", inbox: "인박스", secret: "비밀" };

/* ---------- question or put-in ---------- */

const ASK_WORDS = /왜|냐\s*$|니\s*$|잖아|이상하게|안\s?(돼|되|들어가)|틀렸|뭐였지|뭐였더라|뭐더라|뭐지|언제|어디|몇 ?시|몇 ?개|있나|알려 ?줘|뭐야|뭐 ?있|무슨|누구|얼마|찾아 ?줘|기억나|했지|였지|였더라|했더라|이었나|인가요?$|있어요?\?|맞지|어때|정리해 ?줘|요약/;

/**
 * "ask" a question, "put" something to put in, "both" can't tell (a clock time and a question
 * word: 「내일 3시에 알려줘」) — then the user picks with one click.
 */
export function classify(raw: string, now: Date): "ask" | "put" | "both" {
  const t = raw.trim();
  if (!t) return "put";
  // Pasted messages (several lines, a chat export 「[오전 8:02] 학년부장: … 되시나요?」) are put in, whatever they ask.
  if (t.split("\n").filter((l) => l.trim()).length > 1 || /\[(?:오전|오후)\s*\d{1,2}:\d{2}\]|^\S{1,10}\s*:\s/.test(t) || t.length > 120) return "put";
  if (/[?？]\s*$/.test(t)) return "ask";
  if (!ASK_WORDS.test(t)) return "put";
  return parseRule(t, now).hasTime ? "both" : "ask";
}

const PASTED = /\[(?:오전|오후)\s*\d{1,2}:\d{2}\]|^\S{1,10}\s*:\s/m;
const SETTING_WORDS = /(알람|알림|설정|글씨|글자|소리|진동|테마|기본\s*길이|다크|라이트|어둡게|밝게|화면|출근\s*시[각간]|퇴근\s*시[각간]|점심\s*시간\s*[은는을이])/;
const ORDER_WORDS = /(해\s*줘|해\s*주|하십시오|하세요|바꿔|바꾸|으로\s*해|로\s*해|게\s*해|되게|울리게|맞춰|해\s*놔|해\s*둬)/;

/**
 * 넣기·질문·설정 나누기 (the AI) is worth one small call: a question or a setting order somewhere
 * in the words. A pasted message (a chat export, 「이름: …」) is put in, whatever it asks; plain
 * put-in words never go (they take the usual path at no extra cost).
 */
export function wantsRoute(raw: string): boolean {
  const t = raw.trim();
  if (!t || PASTED.test(t)) return false;
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const asks = lines.some((l) => /[?？]\s*$/.test(l) || ASK_WORDS.test(l));
  return asks || (SETTING_WORDS.test(t) && ORDER_WORDS.test(t));
}

/* ---------- date words → range ---------- */

export interface Range {
  from: string;
  to: string;
  label: string;
}

export function dateRange(text: string, now: Date): Range | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = (n: number, label: string): Range => ({ from: ymd(addDays(today, n)), to: ymd(addDays(today, n)), label });
  const week = (n: number, label: string): Range => {
    const s = addDays(today, -today.getDay() + 7 * n);
    return { from: ymd(s), to: ymd(addDays(s, 6)), label };
  };
  const month = (n: number, label: string): Range => {
    const a = new Date(today.getFullYear(), today.getMonth() + n, 1);
    const b = new Date(today.getFullYear(), today.getMonth() + n + 1, 0);
    return { from: ymd(a), to: ymd(b), label };
  };
  if (/지난\s?주|저번\s?주/.test(text)) return week(-1, "지난주");
  if (/다음\s?주/.test(text)) return week(1, "다음 주");
  if (/이번\s?주|금주|이 주/.test(text)) return week(0, "이번 주");
  if (/주말/.test(text)) {
    const sat = addDays(today, 6 - today.getDay());
    return { from: ymd(sat), to: ymd(addDays(sat, 1)), label: "주말" };
  }
  if (/지난\s?달|저번\s?달/.test(text)) return month(-1, "지난달");
  if (/다음\s?달/.test(text)) return month(1, "다음 달");
  if (/이번\s?달/.test(text)) return month(0, "이번 달");
  if (/그저께|그제/.test(text)) return day(-2, "그저께");
  if (/어제/.test(text)) return day(-1, "어제");
  if (/모레/.test(text)) return day(2, "모레");
  if (/내일/.test(text)) return day(1, "내일");
  if (/오늘/.test(text)) return day(0, "오늘");
  return null;
}

/* ---------- documents ---------- */

const short = (k: string): string => {
  const d = parseDay(k);
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
};

export function docsOf(s: CalendarState, src: AskSources | null): AskDoc[] {
  const out: AskDoc[] = [];
  const said = (c: string) => c.slice(0, 10);
  for (const e of s.events) if (!e.gone && !e.sample) out.push({ id: e.id, kind: "event", title: e.title, text: e.details ?? "", date: e.date, time: e.start ?? undefined, said: said(e.createdAt), where: e.source });
  for (const t of s.tasks) if (!t.gone && !t.sample) out.push({ id: t.id, kind: "task", title: t.title, text: [t.details ?? "", ...t.subs.map((x) => x.title)].join(" "), date: t.noDue ? said(t.createdAt) : t.due, time: t.dueTime ?? undefined, done: t.done, said: said(t.createdAt), where: t.source });
  for (const p of s.periods) if (!p.gone && !p.sample) out.push({ id: p.id, kind: "period", title: p.title, text: p.details ?? "", date: p.from, to: p.to, said: said(p.createdAt), where: p.source });
  for (const n of s.notes) if (!n.gone && !n.sample) out.push({ id: n.id, kind: "note", title: n.title, text: n.details ?? "", date: said(n.createdAt), said: said(n.createdAt), where: n.source });
  s.inbox.forEach((x, i) => {
    if (x.state === "실패" || x.state === "검토 필요") out.push({ id: `inbox:${i}`, kind: "inbox", title: x.title, text: `${x.state} ${x.out}`, date: x.at.slice(0, 10), said: x.at.slice(0, 10), where: `인박스 ${x.at.slice(11, 16)}` });
  });
  for (const x of src?.secrets ?? []) out.push({ id: `secret:${x.name}`, kind: "secret", title: x.name, text: "", date: x.at.slice(0, 10), said: x.at.slice(0, 10), where: "이 Mac 키체인" });
  for (const n of src?.notes ?? []) out.push({ id: `obsidian:${n.path}`, kind: "obsidian", title: n.title.replace(/^\d{4}-\d{2}-\d{2}\s*/, ""), text: n.text, date: n.date, said: n.date, where: `노트/${n.path}` });
  return out;
}

/** How a record is said in one line (glass dates; 「까지」 for deadlines). */
export function whenOf(d: AskDoc): string {
  if (d.kind === "event") return `${short(d.date)} ${d.time ?? "종일"}`;
  if (d.kind === "task") return `${short(d.date)}${d.time ? " " + d.time : ""}까지${d.done ? " · 끝냄" : ""}`;
  if (d.kind === "period") return `${short(d.date)} ~ ${short(d.to ?? d.date)}`;
  if (d.kind === "secret") return "키체인 · Touch ID로 복사";
  return short(d.date);
}

const hitOf = (d: AskDoc): AskHit => ({ id: d.id, kind: d.kind, title: d.title, when: whenOf(d), where: d.where });

/* ---------- index ---------- */

const norm = (v: string) => v.toLowerCase().normalize("NFC");

/** Bigrams of each word (a one-letter word is its own gram). */
function grams(text: string): string[] {
  const out: string[] = [];
  for (const w of norm(text).split(/[^0-9a-z가-힣]+/)) {
    if (!w) continue;
    if (w.length === 1) out.push(w);
    for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}

/** Words that mean the same (the first is the one kept): 「끝난」 finds 「종료」. */
const SAME: string[][] = [
  ["종료", "끝나", "끝났", "끝난", "끝내", "끝냈", "끝낸", "마치", "마쳤", "마친", "완료", "다했", "끝"],
  ["진도", "수업진도"],
  ["비번", "비밀번호", "암호", "패스워드"],
  ["회의", "협의", "미팅"],
  ["상담", "면담"],
  ["시험", "고사"],
  ["제출", "내기", "냈", "보내"],
  ["연수", "교육"]
];
const flat = (v: string) => norm(v).replace(/[^0-9a-z가-힣]+/g, "");
/** One canonical word per synonym group found in the text. */
function sameWords(v: string): string[] {
  return SAME.filter((g) => g.some((w) => v.includes(w))).map((g) => g[0]);
}
/** A search word without its ending/particle: 「반이지」 → 「반」, 「진도가」 → 「진도」. */
function stems(w: string): string[] {
  const out = [w];
  let x = w;
  for (let i = 0; i < 3 && x.length > 1; i++) {
    const y = x.replace(/(이지|이야|이니|인지|이에요|예요|이|가|지|요|야)$/, "");
    if (y === x || !y) break;
    out.push((x = y));
  }
  return out;
}

export class AskIndex {
  readonly docs: AskDoc[];
  private readonly post = new Map<string, Map<number, number>>();
  /** Title / everything, spaces and marks removed, plus the canonical synonyms (for `find`). */
  private readonly flatTitle: string[];
  private readonly flatAll: string[];

  constructor(docs: AskDoc[]) {
    this.docs = docs;
    this.flatTitle = docs.map((d) => flat(d.title));
    this.flatAll = docs.map((d) => {
      const f = flat(`${d.title} ${d.text}`);
      return `${f}${sameWords(f).join("")}`;
    });
    docs.forEach((d, i) => {
      const add = (g: string, w: number) => {
        let m = this.post.get(g);
        if (!m) this.post.set(g, (m = new Map()));
        m.set(i, Math.max(m.get(i) ?? 0, w));
      };
      for (const g of grams(d.title)) add(g, 1);
      for (const g of grams(d.text)) add(g, 0.6);
    });
  }

  /**
   * `cover`: share of the query's grams found anywhere in the doc (decides 「clear」 or not).
   * `score`: the same with the title counting more (decides the order).
   */
  search(query: string): { doc: AskDoc; score: number; cover: number }[] {
    const qg = [...new Set(grams(query))];
    if (!qg.length) return [];
    const score = new Map<number, number>();
    const cover = new Map<number, number>();
    for (const g of qg) {
      for (const [i, w] of this.post.get(g) ?? []) {
        score.set(i, (score.get(i) ?? 0) + w);
        cover.set(i, (cover.get(i) ?? 0) + 1);
      }
    }
    return [...score].map(([i, v]) => ({ doc: this.docs[i], score: v / qg.length, cover: cover.get(i)! / qg.length })).sort((a, b) => b.score - a.score || b.cover - a.cover);
  }

  /**
   * The search box (and the chat's candidates): forgiving about words. Spaces are ignored,
   * endings are cut (「진도가」 → 진도), synonyms meet (「끝난」 → 종료), and a word that is
   * mostly there by letter pairs still counts. `score` 0–1.5: share of the words found
   * (in the title counts more).
   */
  find(query: string, limit = 40): { doc: AskDoc; score: number }[] {
    const words = termsOf(query).split(" ").filter(Boolean).map((w) => w.replace(/^몇/, "")).filter(Boolean);
    if (!words.length) {
      const f = flat(query);
      if (f.length < 2) return [];
      words.push(f);
    }
    // One form per word root (「반이」 and 「몇반이지」 are the same 「반」); a one-letter root weighs half.
    const seen = new Set<string>();
    const forms = words.map((w) => {
      const f = flat(w);
      const all = stems(f);
      const same = sameWords(f);
      const root = same[0] ?? all[all.length - 1];
      return { root, all: [...all, ...same], grams: grams(f), w: root.length > 1 || same.length ? 1 : 0.5 };
    }).filter((x) => !seen.has(x.root) && !!seen.add(x.root));
    const total = forms.reduce((n, x) => n + x.w, 0);
    const long = forms.some((x) => x.w === 1);
    const out: { doc: AskDoc; score: number }[] = [];
    this.docs.forEach((doc, i) => {
      let sum = 0;
      let hit = 0;
      let longHit = false;
      for (const w of forms) {
        if (w.all.some((x) => x && this.flatTitle[i].includes(x))) sum += 1.5 * w.w;
        else if (w.all.some((x) => x && this.flatAll[i].includes(x))) sum += w.w;
        else if (w.grams.length > 1 && w.grams.filter((g) => this.flatAll[i].includes(g)).length / w.grams.length >= 0.6) sum += 0.6 * w.w;
        else continue;
        hit += w.w;
        if (w.w === 1) longHit = true;
      }
      if (hit && hit / total >= 0.5 && (longHit || !long)) out.push({ doc, score: sum / total });
    });
    return out.sort((a, b) => b.score - a.score || b.doc.date.localeCompare(a.doc.date)).slice(0, limit);
  }
}

/* ---------- answering ---------- */

/** Words that only shape the question (dropped before searching), after endings are cut. */
const STOP_WORDS = new Set(("지금 다 몇 몇개 뭐였지 뭐였더라 뭐더라 뭐지 뭐야 뭐 있어 있나 있었지 있었나 있지 있을까 언제 어디 몇시 몇 시 개 알려줘 알려 줘 무슨 누구 얼마 얼마나 찾아줘 찾아 기억나 했지 맞지 좀 거 것 어떻게 하기로 하기 해 해야 내야 해줘 할 하는 요약해 정리해 " +
  "오늘 내일 모레 어제 그제 그저께 주 이번 지난 다음 저번 지난주 이번주 다음주 저번주 금주 주말 달 이번달 지난달 다음달 저번달 " +
  "마감 일 일정 약속 스케줄 기간 비번 비밀번호 암호 메모 기억 노트 무엇 뭘 어떤 그거 거기").split(" "));
/** Endings cut from each word (「언제까지야」 → 「언제」, 「수거는」 → 「수거」). 이/가 stay (와이파이). */
const ENDING = /(이라고|라고|했었지|했지|했더라|었지|였지|였더라|이었나|인가요|인가|이야|예요|이에요|까지|에서|으로|해요|야|요|은|는|을|를|에|의|도|로|랑|과|와)$/;

function termsOf(q: string): string {
  return q.split(/[^0-9A-Za-z가-힣]+/).map((w) => {
    let x = w;
    for (let i = 0; i < 2 && x.length > 1; i++) {
      const y = x.replace(ENDING, "");
      // A word never shrinks below two letters (「치과」 is not 「치」 + 과).
      if (y === x || y.length < 2) break;
      x = y;
    }
    return x;
  }).filter((w) => w && !STOP_WORDS.has(w) && !(w.length === 1 && /[가-힣]/.test(w))).join(" ");
}


function kindsOf(q: string): DocKind[] | null {
  if (/비번|비밀번호|암호|pw|PIN|핀번호|계좌|카드\s?번호/i.test(q)) return ["secret", "note", "obsidian"];
  if (/마감|할\s?일|해야|제출/.test(q)) return ["task"];
  if (/일정|약속|스케줄|회의|모임/.test(q) && !/노트|메모/.test(q)) return ["event", "period"];
  if (/메모|기억|노트/.test(q)) return ["note", "obsidian"];
  return null;
}

const SUMMARY = /요약|정리해|어때|왜|어떻게|비교|추천|몇\s?개|얼마나/;
const SAID = /라고|했지|했더라|말했|적었|넣었|적어\s?둔|넣어\s?둔/;

function inRange(d: AskDoc, r: Range, bySaid: boolean): boolean {
  if (bySaid) return d.said >= r.from && d.said <= r.to;
  const end = d.to ?? d.date;
  return d.date <= r.to && end >= r.from;
}

const LINE_TEXT = 160;
export function lineOf(d: AskDoc): string {
  // Secrets: the name only. The value never leaves the keychain.
  const body = d.kind === "secret" ? "(값은 키체인에만)" : d.text.replace(/\s+/g, " ").slice(0, LINE_TEXT);
  // The year too: a question over the whole year (「작년 기말고사」) needs it.
  return `[${d.id}] ${KIND_LABEL[d.kind]} · ${d.kind === "secret" ? "" : `${d.date.slice(0, 4)}년 `}${whenOf(d)} · ${d.title}${body ? ` — ${body}` : ""}`;
}

/** Nearest upcoming first (not done), then the most recent past. */
function byNear(today: string) {
  return (a: AskDoc, b: AskDoc) => {
    const fa = a.date >= today && !a.done;
    const fb = b.date >= today && !b.done;
    if (fa !== fb) return fa ? -1 : 1;
    return fa ? `${a.date}${a.time ?? ""}`.localeCompare(`${b.date}${b.time ?? ""}`) : `${b.date}${b.time ?? ""}`.localeCompare(`${a.date}${a.time ?? ""}`);
  };
}

const STRONG = 0.75;
const WEAK = 0.45;

/**
 * Answer a question from the index. Clear → mode "local" (no AI). Fuzzy or a summary asked →
 * mode "ai" with the best lines. Nothing near → "none".
 */
export function answer(index: AskIndex, question: string, now: Date): Answer {
  const t0 = performance.now();
  const today = ymd(now);
  const range = dateRange(question, now);
  const bySaid = SAID.test(question);
  const kinds = kindsOf(question);
  const terms = termsOf(question);
  const done = (a: Omit<Answer, "ms">): Answer => ({ ...a, ms: performance.now() - t0 });
  const okKind = (d: AskDoc) => (kinds ? kinds.includes(d.kind) : d.kind !== "inbox" || /인박스|실패|검토/.test(question));

  // 「이번 주 마감 뭐 있어?」: a range and maybe a kind, no other words → a list, made here.
  if (!terms && range) {
    const want = kinds ?? ["event", "task", "period"];
    const list = index.docs
      .filter((d) => want.includes(d.kind) && inRange(d, range, bySaid) && !(d.kind === "task" && d.done && !bySaid))
      .sort((a, b) => `${a.date}${a.time ?? ""}`.localeCompare(`${b.date}${b.time ?? ""}`));
    const what = kinds?.[0] === "task" ? "마감" : kinds?.[0] === "event" ? "일정" : kinds?.includes("secret") ? "비밀" : "일정·마감";
    if (SUMMARY.test(question) && list.length >= 2) return done({ mode: "ai", text: `${range.label} ${what} ${list.length}개`, hits: list.slice(0, 12).map(hitOf), lines: list.slice(0, 12).map(lineOf) });
    return done({ mode: "local", text: list.length ? `${range.label} ${what} ${list.length}개` : `${range.label} ${what} 없음`, hits: list.slice(0, 20).map(hitOf), lines: [] });
  }

  if (!terms) return done({ mode: "none", text: "무엇을 찾을지 한 단어만 더 써 주세요 · 예: 「치과 언제야?」", hits: [], lines: [] });

  const found = index.search(terms).filter((x) => okKind(x.doc) && (!range || inRange(x.doc, range, bySaid)));
  const strong = found.filter((x) => x.cover >= STRONG).map((x) => x.doc).sort(byNear(today));
  const near = found.filter((x) => x.cover >= WEAK).slice(0, 8).map((x) => x.doc);

  if (strong.length && !SUMMARY.test(question)) {
    const top = strong[0];
    // The card shows the title and details; the line says only the answer itself.
    const head =
      top.kind === "secret" ? "키체인에 있어요 · 복사는 Touch ID 뒤" :
      top.kind === "obsidian" || top.kind === "note" ? (top.text ? top.text.replace(/\s+/g, " ").slice(0, 80) : "찾았어요") :
      whenOf(top);
    return done({ mode: "local", text: strong.length > 1 ? `${head} · 찾은 것 ${strong.length}개` : head, hits: strong.slice(0, 8).map(hitOf), lines: [] });
  }
  if (near.length) return done({ mode: "ai", text: "가까운 기록", hits: near.map(hitOf), lines: near.map(lineOf) });
  // Different words for the same thing (「끝난 반」 ↔ 「진도 종료」): the forgiving search.
  const loose = index.find(question, 8).filter((x) => okKind(x.doc) && (!range || inRange(x.doc, range, bySaid))).map((x) => x.doc);
  if (loose.length) return done({ mode: "ai", text: "가까운 기록", hits: loose.map(hitOf), lines: loose.map(lineOf) });
  return done({ mode: "none", text: range ? `${range.label}에는 「${terms}」 기록이 없어요` : `「${terms}」 기록을 찾지 못했어요`, hits: [], lines: [] });
}

/* ---------- 찾기 → 정리 (RAG): the app finds, the AI puts the found lines together ---------- */

/** First ±3 months around today; when that is not enough, the year before (and half a year ahead). */
export const WINDOWS = [
  { back: 92, ahead: 92, label: "±3개월" },
  { back: 365, ahead: 183, label: "1년" }
] as const;
const MAX_LINES = 150;

export interface Gathered {
  docs: AskDoc[];
  from: string;
  to: string;
  /** Records in the window (searched over). */
  total: number;
}

/**
 * The lines for one question: every record in the window that any search word finds (by score),
 * then — when room is left — the rest of the window nearest to today, so a record in other words
 * (「9반 다음 시간에 성운부터」 for 「진도」) still reaches the AI. Secrets and inbox lines stay out.
 */
export function gather(index: AskIndex, terms: string[], now: Date, w: (typeof WINDOWS)[number], question = ""): Gathered {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = ymd(addDays(today, -w.back));
  const to = ymd(addDays(today, w.ahead));
  const inWin = (d: AskDoc) => (d.date <= to && (d.to ?? d.date) >= from) || (d.said >= from && d.said <= to);
  const pool = index.docs.filter((d) => d.kind !== "secret" && d.kind !== "inbox" && inWin(d));
  const ids = new Set(pool.map((d) => d.id));
  const score = new Map<string, number>();
  const add = (id: string, v: number) => score.set(id, (score.get(id) ?? 0) + v);
  // A rare word weighs more (「성운」 over 「반」·「끝」, which most records have).
  for (const t of [...new Set(terms.map((x) => x.trim()).filter((x) => x.length > 0))]) {
    const found = index.find(t, index.docs.length).filter((x) => ids.has(x.doc.id));
    const idf = Math.log((pool.length + 1) / (found.length + 1));
    for (const { doc, score: v } of found) add(doc.id, v * idf);
  }
  // A day range said (「다음 주」 「이번 달」) or a kind (「할 일」 「일정」): those records first.
  const range = question ? dateRange(question, now) : null;
  const kinds = question ? kindsOf(question) : null;
  if (range || kinds) {
    for (const d of pool) {
      const inR = !range || inRange(d, range, SAID.test(question));
      const inK = !kinds || kinds.includes(d.kind);
      if (inR && inK) add(d.id, 100);
    }
  }
  const t0 = ymd(today);
  const near = (d: AskDoc) => Math.abs(parseDay(d.date).getTime() - parseDay(t0).getTime());
  const hit = pool.filter((d) => score.has(d.id)).sort((a, b) => score.get(b.id)! - score.get(a.id)! || near(a) - near(b));
  const rest = pool.filter((d) => !score.has(d.id)).sort((a, b) => near(a) - near(b));
  return { docs: [...hit, ...rest].slice(0, MAX_LINES), from, to, total: pool.length };
}

export interface AnswerLine {
  text: string;
  ids: string[];
  missing: boolean;
}

/**
 * Only what the records say: a line must rest on records that were sent (or say plainly that
 * there is no record). Lines with no real grounds are dropped. The ids kept are the ones sent.
 */
export function checkLines(lines: AnswerLine[], sent: AskDoc[]): { lines: AnswerLine[]; dropped: number } {
  const ok = new Set(sent.map((d) => d.id));
  const out: AnswerLine[] = [];
  let dropped = 0;
  for (const l of lines) {
    const text = (l.text ?? "").trim();
    if (!text) continue;
    const ids = (l.ids ?? []).map((x) => x.replace(/^\[|\]$/g, "").trim()).filter((x) => ok.has(x));
    if (ids.length) out.push({ text, ids, missing: false });
    else if (l.missing) out.push({ text, ids: [], missing: true });
    else dropped++;
  }
  return { lines: out, dropped };
}
