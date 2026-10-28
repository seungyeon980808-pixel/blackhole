// 레이아웃 검사용 가짜 자료 (실제 사람·학교 자료 아님). window.__BH_LAYOUT = { theme, chat } 를 먼저 둡니다.
(() => {
  const L = window.__BH_LAYOUT || { theme: "glass", chat: "open" };
  const FIX = (t, mode) => {
    const p = (n) => String(n).padStart(2, "0");
    const d0 = new Date(); const k = (o) => { const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + o); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
    const T = k(0); const at = "2026-10-01T08:00";
    const ev = (id, title, date, start, end, x = {}) => ({ id, kind: "event", title, area: "school", source: "t", createdAt: at, date, start, end, reminders: [], ...x });
    const tk = (id, title, due, dueTime, x = {}) => ({ id, kind: "task", title, area: "school", source: "t", createdAt: at, due, dueTime, done: false, reminders: [], subs: [], ...x });
    const s = { schemaVersion: 1, events: [
        ev("e1", "2학년 3반 수업", T, "09:00", "09:45"), ev("e2", "학년 협의회", T, "11:00", "12:00"), ev("e3", "대의원회", T, "13:40", "14:30", { star: 1 }),
        ev("e4", "학부모 상담", T, "15:10", "15:50"), ev("e5", "공개수업", k(2), "10:00", "10:45", { star: 2 }), ev("e6", "교육청 연수", k(9), "14:00", "17:00", { star: 1 }) ],
      tasks: [
        tk("t1", "출석부 정리", T, "10:30"), tk("t2", "중간고사 출제 원안 제출", T, "15:00", { star: 2, subs: [{ title: "문항 초안", done: true }, { title: "검토 요청", done: false }, { title: "결재 올리기", done: false }] }),
        tk("t3", "가정통신문 기안", T, "18:00", { star: 1 }), tk("t4", "학습지 30부 인쇄", T, null), tk("t5", "생기부 점검", k(3), "17:00", { star: 1, subs: [{ title: "1반", done: true }, { title: "2반", done: false }] }),
        tk("t6", "도서 반납", k(5), null), tk("t7", "방과후 신청서 확인", T, "08:30", { done: true }) ],
      periods: [], notes: [{ id: "n1", kind: "note", title: "2학년 4반 진도 종료", area: "school", source: "휴대폰", createdAt: k(-2) + "T15:10", details: "" }, { id: "n2", kind: "note", title: "3학년 1반 진도 3단원까지", area: "school", source: "데스크톱", createdAt: k(-1) + "T09:00", details: "" }], memos: [], chat: [], inbox: [], log: [],
      routines: [
        { id: "r1", title: "메일 확인", at: "08:20", repeat: "weekdays", done: [k(-3), k(-1), T], createdAt: at },
        { id: "r2", title: "교실 환기", at: "12:30", repeat: "daily", done: [k(-1)], createdAt: at },
        { id: "r3", title: "업무일지", at: "16:10", repeat: [1, 3, 5], done: [], createdAt: at } ],
      settings: { theme: t, ...(mode ? { mode } : {}) } };
    return s;
  };
  try {
    localStorage.setItem("bh-mock-state", JSON.stringify(FIX(L.theme, L.theme === "glass" ? "dark" : null)));
    localStorage.setItem("bh-panel", L.chat === "closed" ? "closed" : "open");
    localStorage.removeItem("bh-panel-w");
  } catch {}
  window.__BH_SCN = { key: true };
  // the clock at 10:40 today
  const R = Date;
  const n = new R();
  const off = new R(n.getFullYear(), n.getMonth(), n.getDate(), 10, 40).getTime() - R.now();
  class D extends R { constructor(...a) { a.length ? super(...a) : super(R.now() + off); } static now() { return R.now() + off; } }
  window.Date = D;
})();

// 주·월 보기 검사용: 이번 주와 앞뒤 주에 일정·마감·기간을 더 (07:40 · 17:00 이후처럼 업무 시간 밖, 끝낸 할 일, 한 날에 여러 개)
(() => {
  const s = JSON.parse(localStorage.getItem("bh-mock-state"));
  const p = (n) => String(n).padStart(2, "0");
  const d0 = new Date(); const k = (o) => { const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + o); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const wd = d0.getDay(); const w = (i) => k(i - wd); // 이번 주 일(0)~토(6)
  const at = "2026-10-01T08:00";
  const ev = (id, title, date, start, end, x = {}) => ({ id, kind: "event", title, area: "school", source: "t", createdAt: at, date, start, end, reminders: [], ...x });
  const tk = (id, title, due, dueTime, x = {}) => ({ id, kind: "task", title, area: "school", source: "t", createdAt: at, due, dueTime, done: false, reminders: [], subs: [], ...x });
  s.events.push(
    ev("w1", "등교 지도", w(1), "07:40", "08:20"), ev("w2", "수행평가 점수 확인", w(1), "13:20", "14:05"), ev("w3", "맨드살롱", w(1), "17:00", "18:00", { area: "personal" }),
    ev("w4", "교과협의회", w(2), "14:15", "15:00"), ev("w5", "3학년 진로 상담 주간 안내", w(2), "10:40", "11:25", { provisional: true }),
    ev("w6", "학부모 총회 준비", w(4), "15:10", "16:30"), ev("w7", "동아리 지도", w(4), "13:20", "14:05"), ev("w8", "저녁 약속", w(5), "19:00", "21:00", { area: "personal" }),
    ev("w9", "체육대회", w(5), null, null), ev("w10", "학년 회식", w(3), "17:30", "19:30", { area: "personal" }),
    ev("m1", "교육청 컨설팅", k(-9), "14:00", "16:00"), ev("m2", "부장 회의", k(-8), "15:10", "16:00"), ev("m3", "치과", k(12), "17:30", "18:00", { area: "personal" }),
    ev("m4", "수업 공개의 날", k(15), "09:00", "12:00"), ev("m5", "학교운영위원회", k(15), "16:30", "18:00"), ev("m6", "현장체험학습 사전답사", k(16), "13:00", "17:00"),
    ev("m7", "성적 처리 마감 회의", k(16), "15:10", "16:00"), ev("m8", "방과후 강사 면담", k(16), "16:30", "17:00"));
  s.tasks.push(
    tk("x1", "수행평가 채점", w(1), null), tk("x2", "출장 신청", w(1), null, { done: true }), tk("x3", "결재 올리기", w(1), null, { done: true }),
    tk("x4", "주간 계획 제출", w(2), null), tk("x5", "체험학습 동의서 회수", w(2), null), tk("x6", "시험 범위 공지", w(2), null), tk("x7", "교실 게시판 정리", w(2), null), tk("x8", "급식 지도표 확인", w(2), null, { done: true }),
    tk("x9", "보충수업 계획서", w(4), "16:00"), tk("x10", "가정통신문 회수", k(-6), null, { done: true }), tk("x11", "연수 이수증 제출", k(10), null),
    tk("x12", "생활기록부 입력", k(16), null), tk("x13", "출결 마감", k(16), null), tk("x14", "도서 구입 신청", k(16), null));
  s.periods = [{ id: "p1", kind: "period", title: "2학기 중간고사 기간", area: "school", source: "t", createdAt: at, from: k(19), to: k(23) }, { id: "p2", kind: "period", title: "진로 상담 주간", area: "school", source: "t", createdAt: at, from: w(1), to: w(5) }];
  s.settings = { ...s.settings, showPeriods: true };
  localStorage.setItem("bh-mock-state", JSON.stringify(s));
})();
