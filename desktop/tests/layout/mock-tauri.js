// Fake Tauri internals for the dev preview: the Mac adapter runs against fake data.
// Scenario in window.__BH_SCN (set before this runs): { key, budgetOver, inboxError, onboarded, big, missed }
(() => {
  const scn = Object.assign({ key: true, budgetOver: false, inboxError: false, onboarded: true, empty: false, big: 0 }, window.__BH_SCN || {});
  const callbacks = new Map();
  let nextCb = 1;
  const listeners = new Map();
  const calls = [];
  window.__bhCalls = calls;
  const emit = (event, payload) => (listeners.get(event) || []).forEach((id) => callbacks.get(id)?.({ event, id: 0, payload }));
  window.__bhEmit = emit;
  const today = () => new Date();
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  };
  let state = null;
  try { state = JSON.parse(localStorage.getItem("bh-mock-state") || "null"); } catch {}
  const claude = () => ({
    analyzer: "claude", model: "claude-haiku-5-5", hasKey: scn.key, monthRequests: 214, monthUsd: scn.budgetOver ? 3.02 : 0.031,
    budgetUsd: 3, skipSimple: true,
    month: { requests: 214, usd: 0.031, input: 9800, output: 41000, cacheRead: 610000, cacheWrite: 0, skippedCache: 12, skippedRule: 30, skippedShort: 3, skippedBudget: 0 }
  });
  const desk = { settings: { shortcuts: { quick: "Ctrl+Alt+Super+Space", clipboard: "Ctrl+Alt+Super+V", capture: "Ctrl+Alt+Super+S" }, autostart: true, alarmSound: "Glass", onboarded: scn.onboarded, autostartOffered: true, rightCmdTwice: true, board: true, boardSize: (window.__BH_SIZE || "small"), boardMode: "desktop", mainWidget: false },
    autostartOn: true, pretty: { quick: "⌃⌥⌘Space", clipboard: "⌃⌥⌘V", capture: "⌃⌥⌘S" }, problems: [], sounds: ["Glass", "Ping", "Hero", "Submarine", "Funk", "Sosumi", "Purr", "Tink"], accessibility: false, raycastDir: "~/.local/share/blackhole/raycast" };
  const inbox = () => ({ available: true, driveRoot: "/Users/me/Library/CloudStorage/GoogleDrive/내 드라이브/블랙홀", testRoot: "/Users/me/.local/share/blackhole/test-inbox", enabled: true,
    root: "/Users/me/Library/CloudStorage/GoogleDrive/내 드라이브/블랙홀", lastScanAt: iso(today()), lastError: scn.inboxError ? "드라이브 폴더를 읽지 못함 · Google Drive가 켜져 있는지 확인해 주세요" : null, running: false });
  const proposal = (text) => {
    const d = today();
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 15, 0);
    const e = new Date(t.getTime() + 3600e3);
    const title = text.replace(/(내일|오늘|모레|오후|오전|\d+시|\d+분|에|까지)/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) || "새 일정";
    return { schemaVersion: 2, source: { type: "text", format: "txt", sha256: "a".repeat(64), bytes: text.length }, referenceTime: iso(d),
      engine: { id: "A", reader: "text", llmModel: "claude-haiku-5-5", promptVersion: "p", workerVersion: "w" }, sourceText: text, summary: "",
      items: [{ kind: /까지|제출|하기/.test(text) ? "TODO" : "SCHEDULE", area: /학교|수업|협의/.test(text) ? "SCHOOL" : "PERSONAL", title, details: "", startAt: iso(t), endAt: /까지|제출/.test(text) ? "" : iso(e), reminderAt: "", reminders: [], subtasks: [],
        evidence: { sentence: text, dateText: "내일", timeText: "3시", endDateText: "", reminderText: "" }, confidence: 0.9, needsReview: false, reviewReasons: [] }],
      needsReview: false, reviewReasons: [], timings: { readMs: 1, llmMs: 900, totalMs: 901 } };
  };
  const hits = [
    { id: "s-3", kind: "일정", title: "안과 진료", sub: "오늘 15:30" }, { id: "s-22", kind: "할 일", title: "출석부 정리", sub: "오늘 17:00까지" },
    { id: "secret:와이파이", kind: "비밀", title: "와이파이", sub: "키체인 · Touch ID로 복사" }
  ];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = {
    load_calendar_state: () => (scn.empty ? { schemaVersion: 1 } : state),
    save_calendar_state: ({ state: s }) => { state = s; try { localStorage.setItem("bh-mock-state", JSON.stringify(s)); } catch {} return null; },
    analyze_text: async ({ text }) => { await wait(900); if (!scn.key) throw { code: "API_KEY_MISSING", message: "Claude 키 없음 · 설정에서 넣으면 다듬어집니다" }; return proposal(text); },
    analyze_path: async () => { await wait(900); return proposal("파일 내용"); },
    analyze_bytes: async () => { await wait(900); return proposal("사진 내용"); },
    inbox_status: inbox, inbox_set: inbox, inbox_results: () => [], inbox_drafts: () => [], inbox_drafted: () => null, inbox_put: ({ path }) => path,
    alarms_schedule: () => null, alarm_missed: () => null, alarm_ring: () => true, alarm_sound_try: () => null,
    alarm_current: () => (window.__BH_ALARMS || []), alarm_answer: () => null,
    put_take: () => [], quick_put_bytes: () => null, quick_put_path: () => null, secret_intake: ({ text }) => (/비번|비밀번호/.test(text) ? "secret" : /^[A-Za-z0-9!@#$%^&*]{10,}$/.test(text) ? "ask" : "put"),
    raycast_install: () => "~/.local/share/blackhole/raycast", quick_action: () => null, ai_skipped: () => null,
    claude_set_options: claude, claude_status: claude, claude_set_key: claude, claude_clear_key: claude, claude_check: () => "연결됨 · claude-haiku-5-5",
    desk_status: () => desk, desk_set: ({ settings }) => ({ ...desk, settings }), speech_permission: () => "허용됨", open_privacy: () => null, notify_test: () => null,
    print_page: () => null, set_window_look: () => null,
    messenger_status: () => ({ configured: false, configPath: "~/.config/blackhole/messenger.json", enabled: false, lastPollAt: null, lastError: null, written: 0 }), messenger_set: () => null,
    share_calendar: () => "휴대폰 사본 씀 · 방금", phone_actions: () => [],
    quick_today: () => hits.slice(0, 2), quick_search: ({ query }) => hits.filter((h) => h.title.includes(query) || h.kind.includes(query)), quick_query_take: () => "",
    quick_put_text: ({ text }) => (/비번|^[A-Za-z0-9!@#]{10,}$/.test(text) ? "ask" : "put"), quick_memo: () => "put", quick_hide: () => null, quick_open: () => null,
    ask_sources: () => ({ secrets: [{ name: "학교 와이파이", at: "2026-10-01T08:00" }, { name: "지마켓 비번", at: "2026-10-02T08:00" }], notes: [{ path: "기억/2026-10-18 차 정기점검.md", title: "2026-10-18 차 정기점검", text: "엔진오일 교체는 다음 달 둘째 주, 서비스센터 예약 필요", date: "2026-10-18" }] }),
    ask_records: async ({ lines }) => { await wait(600); const id = (lines[0] || "").match(/^\[([^\]]+)\]/)?.[1]; return { answer: "이번 주에는 화요일 학급 문고 정리부터 토요일 친구 결혼식까지 일정 7개가 있어요. 공개수업(수)과 협의회(목) 준비가 겹칩니다.", ids: id ? [id] : [] }; },
    note_open: () => null, board_size: () => null, board_fit: () => null, board_toggle: () => null, board_open: () => null, secret_copy: () => null,
    quick_ask: async () => { await wait(500); return { answer: "안과 진료는 오늘 15:30이에요.", hits: hits.slice(0, 1) }; }
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) { const id = nextCb++; callbacks.set(id, (x) => { if (once) callbacks.delete(id); cb(x); }); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      calls.push(cmd);
      if (cmd === "plugin:event|listen") { if (!listeners.has(args.event)) listeners.set(args.event, []); listeners.get(args.event).push(args.handler); return args.handler; }
      if (cmd.startsWith("plugin:")) return null;
      const h = H[cmd];
      if (!h) { console.warn("mock: no command", cmd); return null; }
      return h(args || {});
    }
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
