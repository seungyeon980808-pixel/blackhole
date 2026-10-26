# 블랙홀 Mac 앱 (Blackhole 0.2.0)

Tauri 2 + Vite + TypeScript. 달력 화면(`src/calendar/`)은 휴대폰 앱의 WebView도 그대로 씁니다. 화면 규칙은 `DESIGN.md`, 쓰는 법은 `../docs/desktop-app.md`, AI 설정은 `../docs/local-worker.md`.

## 하는 일

- 월·주·일 달력, 유리(반투명 창)·공문서 테마, A4 출력
- 항상 열린 입력칸: 쓰고 Enter → 규칙 초안이 바로 달력에 → Claude Haiku 5.5가 다듬음
- 빠른 입력·찾기 창, 클립보드 보내기, 화면 캡처해 넣기, 끌어 놓기, ⌘V 사진, Raycast
- 인박스(드라이브 「블랙홀」 폴더), 휴대폰과 달력 공유
- 화면 전체 알람, 메뉴 막대 아이콘, 로그인 시 켜기
- 비밀은 키체인에만, 월 AI 예산

## 명령

Node.js 20 이상, Rust, Xcode 명령줄 도구가 필요합니다.

```sh
npm ci
npm run dev                              # 브라우저 미리보기(가짜 자료, 작업기·인박스 없음)
npm run tauri dev                        # 개발 실행
npm run tauri build -- --bundles app     # src-tauri/target/release/bundle/macos/Blackhole.app
npm run build:phone                      # 휴대폰 APK에 들어갈 달력 화면
```

검사:

```sh
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

## 설치

만든 `Blackhole.app`으로 `/Applications/Blackhole.app`을 교체합니다. 덮기 전에 기존 앱을 `~/.local/share/blackhole/app-backup/`에 복사합니다. 앱 자료(`~/Library/Application Support/com.malhaedwo.blackhole.desktop/`, `~/.local/share/blackhole/`)는 그대로 이어 씁니다. 서명·공증은 하지 않습니다(개인 Mac 전용).

## 개인 설정

Claude API 키는 앱 설정에서 붙여 넣으면 macOS 키체인에만 저장됩니다. AI 설정 파일은 `~/.local/share/blackhole-models/worker-config.json`. 저장소에는 개인 값이 없습니다.
