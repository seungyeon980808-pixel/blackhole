# Codex handoff

Updated: 2026-09-19 KST

## Start here

Use branch `handoff/codex-20260915`. It combines the public-safe Android 0.9.0 source and the Windows Desktop 0.1.1 source in one working tree.

```sh
git clone https://github.com/seungyeon980808-pixel/ya.git
cd ya
git switch --track origin/handoff/codex-20260915
```

This branch is the continuation baseline. Do not start from `main`, which remains at the older public Android snapshot, or from `desktop/windows-0.1.1-visibility`, which does not contain Android 0.9.0.

## Current product boundaries

### Android

- Package: `com.malhaedwo.pttprobe`
- Version: 0.9.0 / code 25
- Manual Java/D8 build, minSdk 31, targetSdk 35
- Persistent PTT is opt-in. Explicit stop disables automatic restoration.
- Foreground-service recreation is best effort. Reboot and force-stop restoration are not guaranteed.
- Approval records are authoritative. Notifications and Calendar records are derived only after approval.
- Existing DB, WAV, OAuth state, and signing continuity must be preserved.

The 0.9.0 public-safe snapshot was imported from the verified local implementation commit `e20fd29`, without its private Git history, production configuration, device logs, or user-data evidence.

### Windows Desktop

- Version: 0.1.1
- Tauri 2 + Vanilla TypeScript + Vite
- Current function: read-only approval-document workspace using fixture/local cache contracts
- Google OAuth and live records are intentionally not connected
- The UI must visibly distinguish fixture, cached, and future connected states
- Windows CI produced NSIS and MSI installers; actual Windows install/remove/WebView2/scaling checks remain open

Relevant files:

- `desktop/src/domain.ts`: shared item model and 23-column contract
- `desktop/src/bridge.ts`: Tauri/web boundary
- `desktop/src/fixtures.ts`: non-production sample data
- `desktop/src/ui.ts`: view rendering
- `desktop/src/styles.css`: visual system
- `desktop/src-tauri/src/`: cache and command layer
- `desktop/DESIGN.md`: approved design principles

## Implemented milestone: LLM Wiki read-only foundation

작업 브랜치: `feat/desktop-wiki-readonly-foundation`. 기준선은 `handoff/codex-20260915`의 Desktop 0.1.1이며 Android와 기존 Items 계약·승인·Calendar·알림·Google 동기화 코드는 변경하지 않았습니다.

- `desktop/src/wiki/source.ts`: provider-neutral 검색·조회와 결과/cache 계약, HTTPS 원문 링크 검증.
- `fixture.ts`, `service.ts`: 비민감 인공 자료, offline cache 검색, 24시간 freshness, empty/provider/cache 오류.
- `cache.ts`, `desktop/src-tauri/src/wiki.rs`: 브라우저 메모리와 Tauri 앱 데이터 cache. 네이티브 cache는 원자 저장, 스키마·출처·링크 검증을 적용하며 손상된 파일은 보존합니다. 다른 provider·원출처의 기존 cache를 덮어쓰지 않습니다.
- `panel.ts`, `ui.ts`, `styles.css`: 기존 상세 점검면의 관련 Wiki 문서 영역. 검색어는 사용자가 직접 입력하며 기록 제목·전사문·ID를 provider로 자동 전달하지 않습니다. 인공 링크는 실제 문서 링크로 표시하지 않습니다.
- `inbox.ts`, `bridge.ts`, `main.ts`, `src-tauri/src/inbox.rs`: 기존 왼쪽 navigation에 채팅형 빠른 기록 대기열을 추가했습니다. 기록 추가는 Drive에 쓰지 않고, 사용자가 동기화를 누를 때 대기 중인 각 기억을 로컬 Google Drive 동기화 Inbox에 raw Markdown으로 저장합니다. 실패한 기록은 재시도할 수 있습니다. `YA_INBOX_PATH`로 경로를 명시할 수 있고, 기본 macOS 탐색은 `GoogleDrive-*/내 드라이브/1. 개인작업/Inbox`만 사용합니다. 브라우저 미리보기에서는 저장을 비활성화합니다.
- `tests/wiki.test.ts`, `tests/wiki-panel.test.ts`, `tests/wiki-cache.test.ts`: offline/empty/stale/provider/cache 오류, 상세 화면 통합, 직접 검색어 경계와 안전한 링크 검사. Tauri의 문자열 오류는 typed cache 오류로 정규화하며 저장 실패 시 읽을 수 있는 fixture 결과를 유지합니다.

검증 결과: 기존 UI 5개 포함 TypeScript 20개, Rust 8개 통과. TypeScript/Vite 빌드와 acceptance 통과. Android host wiring 45 cases/376 assertions, insets 28 assertions, PTT 39 assertions도 통과했습니다. 브라우저에서 인공 자료 검색·빈 결과·키보드 포커스를 직접 조작하고 1180px/700px 화면을 확인했습니다. cache 문자열 오류 회귀는 정규화를 제거하면 2개 실패하고 복원하면 통과하는 것을 확인했습니다. 이는 실제 Windows 설치나 운영 Wiki 연결 검증이 아닙니다.

실행: `cd desktop`, `npm ci`, `npm test`, `npm run build`, `npm run acceptance`, `cargo test --locked --manifest-path src-tauri/Cargo.toml`. 개발 미리보기는 `npm run dev`, 네이티브 앱은 `npm run tauri dev`입니다. 두 개발 서버를 동시에 시작하지 마세요.

기준선 검사에서 UI 5개·빌드·acceptance는 통과했지만 Cargo.lock이 없어 --locked가 실패했습니다. 기존 의존성만으로 Cargo.lock을 생성했습니다. macOS 검사에 필요한 PNG 아이콘은 기존 ICO에서 변환했습니다. 700px 상세 화면의 기존 가로 flex 문제는 DESIGN.md의 세로 재배치 규칙에 맞게 보정했습니다. 생성된 Tauri 스키마 디렉터리는 Git에서 제외합니다. npm 설치 시 기존 의존성의 moderate 취약점 2건이 보고되었으며 이번 기능에서 패키지를 변경하지 않았습니다.

Blocker: 사용자 제공 Wiki 주소는 `[LLM Wiki 주소]` 자리표시자입니다. 실제 서비스 URL, 검색/조회 API, 응답 스키마, 인증·읽기 권한, 승인된 문서 범위가 필요합니다. 실제 네트워크 연결을 추측해 만들지 않았으며 연결 완료를 주장하지 않습니다. Windows 설치·WebView2·배율·운영 OAuth는 이번 로컬 검증 범위 밖입니다. Android 음성 기록을 같은 Inbox로 보내려면 실제 OAuth 설정, 대상 Drive 폴더 ID, 필요한 권한 범위를 먼저 확정해야 합니다.

기본 앱은 fixture이며 `connected-read-only`는 계약·테스트에서만 사용합니다. cache도 원출처 fixture를 명시합니다. Wiki 쓰기·편집·게시와 민감정보 업로드 경로는 없습니다. 아래의 기존 첫 구현 및 데이터 경계는 향후 실제 provider 연결에도 적용합니다.

## Future milestone: actual LLM Wiki provider

The Wiki provider is not selected yet. Confirm the exact service and API before implementing a network adapter.

### First vertical slice

1. Add a provider-neutral `WikiSource` interface under `desktop/src/wiki/`.
2. Implement a fixture source and local cache before any network connection.
3. Add read-only article search and article retrieval.
4. Show related Wiki context in the item detail area, not as a new generic dashboard.
5. Display connection state and cache freshness beside every result.
6. Link from a result to its canonical Wiki page.
7. Add unit tests for offline, stale-cache, empty, and provider-error states.

Suggested states:

- `fixture`
- `cached`
- `connected-read-only`
- `error`

### Data boundary

Allowed inputs:

- Explicitly approved public or team Wiki pages
- Search text intentionally entered by the user
- Non-sensitive item categories or tags after approval

Forbidden inputs:

- WAV or transcript originals without explicit approval
- SQLite DB or backups
- OAuth tokens, authorization codes, PKCE verifiers, cookies, or signing data
- Raw device logs or screenshots containing personal records
- Automatic Wiki writes, edits, or publication in the first milestone

### Completion condition

The first Wiki milestone is complete only when fixture and cache modes work offline, every result shows provenance/state/freshness, no writes are possible, tests cover error states, and a sensitive-data scan is clean.

## Design workflow

The user rejected generic template-like concepts. Do not begin with a polish-only pass because that preserves the incumbent frame.

1. Read `desktop/DESIGN.md` and the real information architecture.
2. Produce three structurally different visual directions before implementation.
3. Keep motion low and information density appropriate for a document-review desktop app.
4. Wait for explicit direction selection.
5. Implement one selected direction, then audit accessibility, keyboard operation, scaling, and empty/error states.

## Verification commands

```sh
bash tests/wiring/run.sh
bash tests/insets/run.sh
bash tests/ptt/run.sh

cd desktop
npm ci
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

See `CURRENT_RELEASE.md` for what has and has not been verified. Do not convert a blocked gate into a passing claim.
