# 이어서 일하는 사람에게 (handoff)

갱신: 2026-10-27 KST

## 어디서 시작하나

- 최신 작업: `feature/blackhole-mac-polish2-20261027` (Mac 앱 다듬기 2차). 그 바탕은 통합본 `feature/blackhole-unified-20261026`(Mac + 휴대폰 0.11.10).
- `main`과 `handoff/codex-20260915`는 옛 기준(Android 0.9.0, Windows 0.1.1)입니다. 여기서 시작하지 마세요.
- 먼저 읽기: `AGENTS.md`, `README.md`, `CURRENT_RELEASE.md`, `docs/plan-blackhole.md`(끝부분 진행 기록), `desktop/DESIGN.md`.

## 구조

```text
desktop/src/calendar/        달력 화면 (Mac 창과 휴대폰 WebView가 같이 씀, Tauri import 없음)
  app.ts                     mountBlackhole: 화면·입력·설정·알람·되돌리기
  rules.ts                   규칙 초안(휴대폰 Java 해석기와 줄마다 같음) + parseDraft(「3시」=오후)
  store.ts / model.ts        자료 형식, 초안 → AI 결과 반영, 휴대폰 동작 적용
  views/glass.ts, doc.ts     유리·공문서 테마
desktop/src/adapters/tauri.ts   Mac 어댑터
desktop/src/mac/             빠른 입력창, 알람 창
desktop/src-tauri/src/       Rust: 저장, 인박스, Claude 호출, 키체인, 단축키, 메뉴 막대, 알람
src/, apk-input/, build.sh   휴대폰 앱(수동 Java/D8 빌드)
```

## 지켜야 할 계약

- 드라이브 「블랙홀/달력.json」과 인박스 파일 형식은 Mac·휴대폰이 함께 씁니다. 한쪽만 바꾸지 마세요.
- `rules.ts`의 `parseRule`은 휴대폰 Java 해석기와 같은 결과를 내야 합니다(`tests/fixtures/rule-cases.json`). 사람 쪽 추정은 `parseDraft`에만 더합니다.
- 지우기·취소는 표시만 바꿉니다(`gone`). 되돌리기는 반대 동작(`restore`)을 보내 휴대폰도 따라옵니다.
- AI는 Claude Haiku 5.5(`claude-haiku-5-5`)만. 키는 키체인에만. 시험 호출은 최소로.
- 구글 캘린더 쓰기, 디스코드·슬랙 실제 연결은 켜지 않습니다.
- 개인 정보(이메일, 시트 ID, 클라이언트 ID), 개인 기록이 담긴 스크린샷은 커밋하지 않습니다.

## 화면 다듬기 방법

개발 미리보기(`npm run dev`)에 가짜 Tauri 내부(`window.__TAURI_INTERNALS__`)를 넣으면 Mac 어댑터가 가짜 자료로 돕니다. 키 없음·예산 초과·인박스 오류·처음 쓰기 같은 상태도 가짜 응답으로 띄워 Playwright로 찍습니다. 실제 앱 화면은 사용자 자료가 보이므로 저장소에 넣지 않습니다.

## 검사

```sh
cd desktop
npm ci
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml

# 휴대폰 호스트 시험(JDK 필요)
bash tests/wiring/run.sh
bash tests/insets/run.sh
bash tests/ptt/run.sh
```

확인하지 않은 것을 확인했다고 쓰지 마세요. 사람 손이 필요한 것은 `CURRENT_RELEASE.md`에 적어 둡니다.
