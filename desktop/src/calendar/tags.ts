/**
 * 기억 태그 (2026-10-28 사용자 요청: 「알아서 해시태그를 달고, 날짜와 주제별로」).
 * Local rules first (0원): 학반 「2학년 3반」 → 2-3, school words → their topic. Tags the user set
 * by hand are kept on the 기억 (Mac only, not in 달력.json); the rest are worked out each time.
 */
import type { CalendarState, Memo } from "./model";
import { fixNumbers } from "./rules";

/** Topic words → one tag each (the same topic always gets the same tag). */
const TOPICS: [RegExp, string][] = [
  [/진도/, "진도"],
  [/수행\s*평가/, "수행평가"],
  [/방과\s*후/, "방과후"],
  [/공문|[가-힣]+과-\d{2,}|시행\s*문/, "공문"],
  [/명단|신청자|참가자|대상자/, "명단"],
  [/회의|협의회|위원회|연수회/, "회의"],
  [/연수|직무\s*연수|원격\s*연수/, "연수"],
  [/시험|고사|출제|채점/, "시험"],
  [/생기부|생활\s*기록부|세특|행발/, "생기부"],
  [/상담|면담/, "상담"],
  [/출결|결석|지각|조퇴/, "출결"],
  [/교원\s*학습\s*공동체|전학공/, "전학공"],
  [/동아리/, "동아리"],
  [/학부모|가정\s*통신문/, "학부모"],
  [/예산|품의|구입|결재/, "예산"],
  [/비밀번호|와이파이|wifi|계정|아이디/i, "계정"],
  [/병원|치과|약국|운동|가족|엄마|아빠|생일/, "개인"]
];

/** 「2학년 3반」 「2-3」 「3반」 → 「2-3」 / 「3반」 (받아쓰기 「오반」도 고쳐 읽음). */
export function classTags(text: string): string[] {
  const t = fixNumbers(text);
  const out = new Set<string>();
  for (const m of t.matchAll(/([1-6])\s*학년\s*([1-9]\d?)\s*반/g)) out.add(`${m[1]}-${m[2]}`);
  for (const m of t.matchAll(/(?:^|[^\d-])([1-6])-([1-9]\d?)(?:반|\b|(?=[^\d]))/g)) out.add(`${m[1]}-${m[2]}`);
  if (!out.size) for (const m of t.matchAll(/(?:^|[^\d])([1-9]\d?)\s*반(?=$|[^가-힣]|도|은|는|이|가|의|과|와|에)/g)) out.add(`${m[1]}반`);
  return [...out];
}

/** 「2-3」 「5반」: a 학반 tag (filters; 주제별 groups by topics only). */
export const isClassTag = (t: string): boolean => /^[1-6]-[1-9]\d?$|^[1-9]\d?반$/.test(t);

/** At most three: the topics first, then the 학반. */
export function ruleTags(text: string): string[] {
  const topics = TOPICS.filter(([re]) => re.test(text)).map(([, t]) => t);
  return [...new Set([...topics, ...classTags(text)])].slice(0, 3);
}

/** The tags a 기억 shows: the user's own if set, else the rules'. */
export function tagsOf(n: Memo): string[] {
  return n.tags ?? ruleTags(`${n.title} ${n.details ?? ""}`);
}

/** Every tag in use with its count, most used first. */
export function tagCounts(s: CalendarState, notes: Memo[] = liveNotes(s)): [string, number][] {
  const m = new Map<string, number>();
  for (const n of notes) for (const t of tagsOf(n)) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}

export function liveNotes(s: CalendarState): Memo[] {
  return s.notes.filter((n) => !n.gone && (s.settings.showSamples || !n.sample));
}

/** 오늘 · 어제 · 이번 주 · 지난주 · 이번 달 · 그 이전 (the week starts on Sunday, like the calendar). */
export function dateGroup(day: string, today: string): string {
  const d = new Date(`${day}T00:00`);
  const t = new Date(`${today}T00:00`);
  const diff = Math.round((t.getTime() - d.getTime()) / 864e5);
  if (diff <= 0) return "오늘";
  if (diff === 1) return "어제";
  const w0 = new Date(t);
  w0.setDate(t.getDate() - t.getDay());
  if (d >= w0) return "이번 주";
  const w1 = new Date(w0);
  w1.setDate(w0.getDate() - 7);
  if (d >= w1) return "지난주";
  if (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth()) return "이번 달";
  return "그 이전";
}
export const DATE_GROUPS = ["오늘", "어제", "이번 주", "지난주", "이번 달", "그 이전"];

/**
 * Like records under one tag in one line, without AI: the title with its 학반 taken out is the key
 * (「2학년 3반 진도 종료」 「2-4 진도 종료」 → 「진도 종료: 2-3, 2-4」). Only keys with two or more.
 */
export function summaries(notes: Memo[]): { key: string; classes: string[]; ids: string[] }[] {
  const by = new Map<string, { classes: string[]; ids: string[] }>();
  for (const n of notes) {
    const cls = classTags(n.title);
    if (!cls.length) continue;
    const key = fixNumbers(n.title)
      .replace(/([1-6])\s*학년\s*([1-9]\d?)\s*반(도|은|는|이|가|의)?/g, " ")
      .replace(/(^|\s)[1-6]-[1-9]\d?(반)?(도|은|는|이|가|의)?/g, " ")
      .replace(/(^|\s)[1-9]\d?\s*반(도|은|는|이|가|의)?(?=\s|$)/g, " ")
      .replace(/[,·]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!key) continue;
    const g = by.get(key) ?? { classes: [], ids: [] };
    g.classes.push(...cls);
    g.ids.push(n.id);
    by.set(key, g);
  }
  return [...by].filter(([, g]) => g.ids.length > 1).map(([key, g]) => ({ key, classes: [...new Set(g.classes)].sort(), ids: g.ids }));
}

/** 「#진도 #2-3 사진」 → tags [진도, 2-3] and the words left. */
export function splitTagQuery(q: string): { tags: string[]; words: string } {
  const tags = [...q.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
  return { tags, words: q.replace(/#[^\s#]+/g, " ").replace(/\s+/g, " ").trim() };
}

/** A tag name as kept: no 「#」, no spaces (Obsidian tags cannot have them), at most 20 letters. */
export const cleanTag = (t: string): string => t.replace(/^#+/, "").replace(/\s+/g, "_").replace(/[,#]/g, "").slice(0, 20);
