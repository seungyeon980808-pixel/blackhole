/**
 * 가짜 자료: the approved prototype's sample week, placed around today so a fresh install
 * shows a populated calendar. Every entry is marked `sample` and can be hidden in 설정.
 * No real names or records.
 */
import { addDays, stamp, ymd } from "./dates";
import { emptyState, type CalendarState, type Area } from "./model";

export function seedState(today: Date): CalendarState {
  const s = emptyState();
  const day = (n: number) => ymd(addDays(today, n));
  const createdAt = stamp(today);
  let id = 1;
  const base = (title: string, area: Area, source = "가짜 자료") => ({ id: `s-${id++}`, title, area, source, createdAt, sample: true });
  const ev = (n: number, start: string, end: string, title: string, area: Area, x: { p?: boolean; rem?: string; src?: string } = {}) =>
    s.events.push({ ...base(title, area, x.src), kind: "event", date: day(n), start, end, provisional: !!x.p, reminders: x.rem ? [`${day(n)}T${x.rem}`] : [] });
  const task = (n: number, dueTime: string | null, title: string, area: Area, x: { done?: boolean; rem?: [number, string][]; subs?: [string, boolean][]; src?: string } = {}) =>
    s.tasks.push({
      ...base(title, area, x.src),
      kind: "task",
      due: day(n),
      dueTime,
      done: !!x.done,
      reminders: (x.rem ?? []).map(([d, t]) => `${day(d)}T${t}`),
      subs: (x.subs ?? []).map(([t, done]) => ({ title: t, done }))
    });
  const per = (a: number, b: number, title: string, area: Area) => s.periods.push({ ...base(title, area), kind: "period", from: day(a), to: day(b) });

  ev(0, "09:05", "09:50", "학급 문고 정리", "school");
  ev(0, "11:00", "11:35", "주간 계획 세우기", "personal");
  ev(0, "15:30", "16:25", "안과 진료", "personal", { p: true, src: "잠금화면 음성", rem: "15:00" });
  ev(0, "18:30", "20:00", "가족 저녁", "personal", { rem: "18:00" });
  ev(1, "08:30", "08:50", "운동장 조회", "school", { rem: "08:20" });
  ev(1, "14:00", "15:00", "학부모 공개수업", "school", { rem: "13:30" });
  ev(2, "14:00", "15:30", "학년 협의회", "school", { p: true, src: "휴대폰 사진" });
  ev(3, "16:00", "17:00", "과학과 협의회", "school");
  ev(3, "16:30", "17:30", "피아노 레슨", "personal");
  ev(4, "11:00", "12:00", "진로 상담", "school", { p: true, src: "디스코드" });
  ev(5, "18:00", "20:00", "가족 외식", "personal");
  ev(6, "18:00", "20:00", "친구 결혼식", "personal");
  ev(-4, "16:00", "17:00", "교과 협의회", "school");
  ev(-2, "10:00", "11:00", "치과", "personal");
  ev(-10, "09:00", "10:00", "수학여행 회의", "school");
  ev(-17, "19:00", "21:00", "동창 모임", "personal");
  ev(-13, "14:00", "15:00", "시험 감독", "school");
  ev(-6, "13:00", "14:00", "미용실", "personal");
  ev(-5, "16:00", "17:00", "교직원 연수", "school");
  ev(-19, "10:00", "11:00", "중간고사 회의", "school");
  ev(13, "09:00", "15:00", "현장체험학습", "school");

  task(0, "17:00", "출석부 정리", "school", { rem: [[0, "16:30"]], src: "음성" });
  task(0, null, "택배 반품 신청", "personal", { done: true });
  task(1, "08:00", "공개수업 자료 인쇄", "school", { rem: [[0, "20:00"]], subs: [["학습지 30부", true], ["PPT 점검", false], ["모둠 이름표", false]] });
  task(2, null, "엄마 생신 선물 주문", "personal", { rem: [[0, "21:00"]] });
  task(5, "18:00", "연수 결과 보고서 제출", "school", { rem: [[4, "09:00"], [5, "09:00"]], src: "디스코드", subs: [["연수 자료 정리", true], ["소감 작성", false], ["결재 올리기", false]] });
  task(10, null, "체험학습 동의서 회수", "school", { rem: [[9, "08:30"]], src: "휴대폰 사진", subs: [["1모둠", true], ["2모둠", true], ["3모둠", false], ["미제출자 명단", false]] });
  task(26, null, "자동차 보험 갱신", "personal");
  task(-1, null, "관리비 납부", "personal");

  per(-6, 5, "수행평가 채점 기간", "school");
  per(-13, 14, "운동 4주 챌린지", "personal");
  per(9, 12, "학부모 상담 주간", "school");

  s.chat.push({ id: "c-0", at: createdAt, who: "ai", text: "가짜 자료로 시작했어요. 설정에서 숨길 수 있어요. 지금은 이 Mac 안에만 저장되고 구글 캘린더에는 아무것도 쓰지 않아요." });
  s.nextId = 1;
  return s;
}
