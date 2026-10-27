/** 밤샘 안정화: 날짜 말 × 시간 말 × 제목을 섞은 문장 수천 개 — 규칙이 지켜야 할 것만 본다(가짜 문장). */
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/calendar/model";
import { memoDraft, parseDraft } from "../src/calendar/rules";

const NOW = new Date(2026, 9, 27, 10, 40);
const DAYS = ["", "오늘", "내일", "모레", "글피", "금요일", "이번 주 목요일", "다음 주 화요일", "다다음 주 월요일", "11월 5일", "12/3", "다음 달 3일", "15일", "월말", "이번 주말", "3일 뒤", "일주일 뒤", "크리스마스에"];
const TIMES = ["", "3시", "오후 3시 반", "오전 9시", "15:30", "9시 10분", "3교시에", "2~3교시", "4시~6시", "1620~2120", "점심시간에", "퇴근 전", "출근 전", "정오에", "자정까지", "30분 뒤", "2시간 후"];
const TITLES = ["학부모 상담", "보고서 제출", "교과 협의회", "학습지 30부 인쇄", "공개수업", "연수 보고서 결재", "가정통신문 기안", "치과 진료"];
const ENDS = ["", "까지", " 하기", " 있음"];

it("thousands of mixed sentences: real days and times, clean titles, never a sure 기억 when a day was said", () => {
  const bad: string[] = [];
  let n = 0;
  for (const day of DAYS) for (const time of TIMES) for (const title of TITLES) for (const end of ENDS) {
    if (end && n % 3) { n++; continue; }
    const v = [day, time, title + end].filter(Boolean).join(" ");
    n++;
    let r;
    try { r = parseDraft(v, NOW, DEFAULT_SETTINGS); } catch (e) { bad.push(`${v} → 오류 ${String(e)}`); continue; }
    if (r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) bad.push(`${v} → 날짜 ${r.date}`);
    if (r.hasTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time ?? "")) bad.push(`${v} → 시각 ${r.time}`);
    if (r.end && r.time && r.end <= r.time) bad.push(`${v} → 끝 ${r.time}–${r.end}`);
    if (!r.title.trim()) bad.push(`${v} → 제목 없음`);
    if (/\d{1,2}\s*시(?!간)|교시|요일|^\s*(부터|까지|~|에)\s|\(\s*[월화수목금토일]\s*\)|\d{1,2}월\s*\d{1,2}일|\d{1,2}:\d{2}|주말|월말|뒤|정오|자정|크리스마스/.test(r.title)) bad.push(`${v} → 제목 「${r.title}」`);
    if (day && !r.date) bad.push(`${v} → 날짜 못 읽음`);
    if ((day || time) && memoDraft(v, NOW, DEFAULT_SETTINGS)?.final) bad.push(`${v} → 기억으로 빠짐`);
  }
  expect(n).toBeGreaterThan(2000);
  expect(bad.slice(0, 40)).toEqual([]);
});
