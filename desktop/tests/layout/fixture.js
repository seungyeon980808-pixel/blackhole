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
