# Blackhole · 블랙홀

문장·음성·사진·링크를 던져 두기만 하면 로컬 AI가 일정·할 일·기억으로 정리하는 개인용 Android 앱과 데스크톱입니다. 이전 이름은 Ya(야), 그 전은 말해둬입니다(2026-10-25 이름 변경).

## 구성

- 음량 버튼/화면 버튼 PTT, WAV 원본 보존, 한국어 인식·파싱
- 승인함에서 검토·편집·승인 후 일정 알림 생성
- 명시적으로 선택한 Calendar에만 파생 일정 생성
- Google Sheets/Drive 동기화와 Apps Script 웹 승인함
- Windows Tauri 읽기 전용 승인 문서함과 로컬 fixture/cache 계약
- package: `com.malhaedwo.pttprobe` (기존 업데이트 호환을 위해 유지)

저장소·제품 이름은 블랙홀(blackhole)입니다. 기존 설치 위 업데이트를 위해 Android 패키지 `com.malhaedwo.pttprobe`, 서명, DB 이름 등 내부 식별자에는 이전 이름 “말해둬”를 그대로 둡니다.

## 현재 상태

이 브랜치는 다른 세션이나 Codex에서 바로 이어갈 수 있도록 다음 기준선을 한곳에 모읍니다.

- Android `0.9.0` / versionCode `25`: 지속 PTT opt-in, sticky service recreation, 시스템 바 inset 수정
- Windows Desktop `0.1.1`: Tauri 기반 읽기 전용 승인 문서함, 로컬 fixture/cache, 23열 Items 계약
- Android wiring 45 cases / 376 assertions, PTT 39 assertions, system inset 28 assertions
- Desktop UI test 5개, TypeScript/Vite build, acceptance 검사
- Windows Rust/NSIS/MSI는 GitHub Actions에서 통과했지만 실제 Windows 설치·제거·배율 검증은 별도 게이트

상세 인계는 `CODEX_HANDOFF.md`, 현재 검증 범위는 `CURRENT_RELEASE.md`, 에이전트 작업 규칙은 `AGENTS.md`를 먼저 읽으세요.

### Android 0.9.0 주의점

사용자의 PTT 선택은 보존하지만 명시적 종료는 자동 복구도 끕니다. `START_STICKY`는 시스템의 재생성 시도를 요청할 뿐 무중단을 보장하지 않습니다. 재부팅·강제 중지 후 microphone foreground service 자동 복구는 보장하지 않습니다. 표준 Gradle 프로젝트가 아니라 기존 수동 Java/D8 빌드 구조입니다.

### DB 최초 접근 보호

기존 `before-v5` 사본을 보존하면서 `before-app-0.9.0`에 현재 DB와 존재하는 WAL/SHM/journal을 별도 복사·검증합니다. 복사나 검증에 실패하면 DB helper를 생성하지 않습니다. 이는 APK 교체 전 백업이 아니라 새 코드의 최초 DB 접근 전 보호입니다.

## 공개용 설정

운영 계정/프로젝트/문서 식별자와 개인 경로는 예시 값으로 교체했습니다. **그대로는 Google 연결이 작동하지 않습니다.**

| 파일 | 구성할 값 |
|---|---|
| `GoogleOAuth.java` | CLIENT_ID, REDIRECT_SCHEME, ALLOWED_EMAIL |
| `apk-input/AndroidManifest.xml` | OAuth callback scheme (REDIRECT_SCHEME와 동일) |
| `GoogleSyncEngine.java` | SPREADSHEET_ID |
| `web/Code.gs` | ALLOWED_EMAIL |
| `MainActivity.java` | 실제 개인정보처리방침 URL |

Java 파일은 `src/com/malhaedwo/pttprobe/` 아래에 있습니다. `YOUR_GOOGLE_OAUTH_CLIENT_ID`는 도메인 접미사를 제외한 OAuth client ID 부분을 뜻합니다. 실제 client ID/redirect는 Google 설정과 일치시켜야 합니다. `owner@example.invalid`는 로그인할 수 없는 예시 주소이며 허용 계정을 무제한으로 확장하지 않습니다. 앱과 웹은 동일한 명시적 계정 allowlist를 사용해야 합니다.

APK 빌드(`build.sh`)는 위 값을 저장소 밖 `~/.config/blackhole/private.env`(또는 `BLACKHOLE_PRIVATE_CONFIG`)에서 읽어 빌드용 사본에만 넣습니다. 키는 `BLACKHOLE_OAUTH_CLIENT_PREFIX`, `BLACKHOLE_ALLOWED_EMAIL`, `BLACKHOLE_SPREADSHEET_ID`, `BLACKHOLE_PRIVACY_URL`입니다. 파일이 없거나 자리표시 값이 남으면 빌드를 멈춥니다(자리표시 APK는 구글 연결·동기화가 멈춤).

웹 코드는 사용할 Google Sheet에 연결된 Apps Script 프로젝트의 `Code.gs`, `Index.html`로 구성합니다. 개인 설정을 채운 사본은 공개 커밋하지 말고 로컬 또는 별도 비공개 저장소에서 관리하세요. OAuth client secret이나 토큰을 소스에 넣지 마세요.

## 호스트 테스트

JDK 11 이상이 필요합니다. 이 테스트는 Android 기기 시험의 대체물이 아닙니다.

```sh
export JAVA_HOME=/path/to/jdk
bash tests/wiring/run.sh
bash tests/insets/run.sh
bash tests/ptt/run.sh
```

## 수동 APK 빌드

필요한 도구는 저장소에 포함하지 않습니다. 각 도구의 배포처와 라이선스를 확인하여 준비하세요.

```text
$PTT_TOOLCHAIN_HOME/
  sdk/platforms/android-35/android.jar
  libs/r8-9.4.17.jar
  libs/ARSCLib-1.4.0.jar
  libs/apksig-9.3.2.jar
  libs/java-base.jar
```

`java-base.jar`는 D8에 제공할 JDK 플랫폼 라이브러리이며 기존 수동 도구 모음 규약입니다. 환경에 따라 호환되는 JDK 라이브러리 준비가 필요합니다. JAVA_HOME을 생략하면 도구 모음의 `jdk/Contents/Home`을 사용합니다. minSdk 31 / targetSdk 35입니다.

```sh
export JAVA_HOME=/path/to/jdk
export PTT_TOOLCHAIN_HOME=/path/to/android-toolchain
export PTT_SIGNING_HOME=/private/path/to/signing
bash build.sh
```

서명 디렉터리는 `ptt-probe.jks`(alias `pttprobe`)와 비밀번호 파일 `password`를 로컬에서 제공해야 합니다. 기본 위치는 `~/.config/blackhole/signing`입니다. 기존 설치 위 업데이트에는 반드시 원래 서명키가 필요합니다. 빌드는 키를 자동 생성하거나 교체하지 않습니다. 출력은 `build/malhaedwo-ptt-probe-0.9.0.apk`이며 서명 검증·Manifest 검사·ZIP 무결성·SHA-256 확인을 실행합니다.

## Windows Desktop

```sh
cd desktop
npm ci
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

실제 Google OAuth와 운영 데이터 연결은 아직 구현하지 않았습니다. 화면은 fixture/cache 상태를 명확히 표시하며, 운영 데이터에 쓰지 않습니다. Windows 설치본은 CI artifact로만 생성하고 Git에는 커밋하지 않습니다.

## 예정: LLM Wiki 연동

아직 특정 Wiki 서비스나 API를 선택하지 않았습니다. 첫 구현은 Desktop의 읽기 전용 adapter, 로컬 cache, fixture fallback으로 제한합니다. 승인된 문서만 검색 대상으로 삼고 DB·WAV·OAuth token·개인 로그는 전송하지 않습니다. 자세한 경계는 `CODEX_HANDOFF.md`에 기록했습니다.

## 데이터 안전 원칙

- 승인 전 알림/Calendar 생성 금지
- 음성인식·동기화 실패 시 WAV 원본 보존
- 기존 앱 제거/데이터 초기화 없이 동일 서명 업데이트
- Calendar 삭제 실패 시 연결 정보와 재시도 상태 보존
- 운영 데이터, 음성, DB, 토큰, 서명키, 개인 로그, 기존 Git 이력은 이 공개 복사본에 포함하지 않음

라이선스는 아직 지정하지 않았습니다. 공개 저장소라는 사실만으로 재배포·변경 허가를 부여하지 않습니다.
