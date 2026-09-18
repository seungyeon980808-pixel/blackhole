# Ya · 야

옆 사람에게 “야” 하고 말을 건네듯, 음성으로 기록하고 확인한 뒤 일정으로 연결하는 개인용 Android 앱과 Windows 검토 데스크톱입니다.

## 구성

- 음량 버튼/화면 버튼 PTT, WAV 원본 보존, 한국어 인식·파싱
- 승인함에서 검토·편집·승인 후 일정 알림 생성
- 명시적으로 선택한 Calendar에만 파생 일정 생성
- Google Sheets/Drive 동기화와 Apps Script 웹 승인함
- Windows Tauri 읽기 전용 승인 문서함과 로컬 fixture/cache 계약
- package: `com.malhaedwo.pttprobe` (기존 업데이트 호환을 위해 유지)

기존 코드의 화면·내부 명칭에는 이전 이름 “말해둬”가 남아 있습니다. 저장소/제품 이름은 Ya이며, 이번 공개용 복사본은 기능 전체의 이름 변경 작업과 구분합니다.

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

서명 디렉터리는 `ptt-probe.jks`(alias `pttprobe`)와 비밀번호 파일 `password`를 로컬에서 제공해야 합니다. 기본 위치는 `~/.config/ya/signing`입니다. 기존 설치 위 업데이트에는 반드시 원래 서명키가 필요합니다. 빌드는 키를 자동 생성하거나 교체하지 않습니다. 출력은 `build/malhaedwo-ptt-probe-0.9.0.apk`이며 서명 검증·Manifest 검사·ZIP 무결성·SHA-256 확인을 실행합니다.

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

## LLM Wiki 읽기 전용 기반

`desktop/src/wiki/`에 provider-neutral `WikiSource`(검색·문서 조회), 인공 자료만 사용하는 `FixtureWikiSource`, 로컬 cache adapter를 구현했습니다. 기존 상세 점검면 아래의 **관련 Wiki 문서**에서 직접 검색할 수 있습니다. 선택한 기록의 제목·전사문·DB는 검색어로 자동 전달하지 않습니다. 새 패키지나 Wiki 쓰기·게시 기능은 없습니다.

위 Desktop 검증 명령을 실행한 뒤 `npm run dev`로 브라우저 미리보기를, `npm run tauri dev`로 네이티브 개발 앱을 실행합니다. 브라우저에서는 cache가 메모리에만 유지되며 새로고침하면 사라집니다. Tauri에서는 앱 데이터 디렉터리의 `wiki-cache-v1.json`을 사용합니다. 기존 승인 cache 파일은 변경하지 않습니다. Windows 설치·배율 검증은 여전히 별도입니다.

화면의 각 결과에는 제목·요약·원문 링크·provider·연결 상태·cache 최신성을 표시합니다. `fixture`는 인공 예시, `cached`는 저장된 결과이며 원출처도 함께 표시합니다. 24시간이 넘거나 저장 시각이 미래이면 stale로 표시합니다. offline은 cache 범위에서만 검색하며 cache가 없으면 `error`입니다. provider 오류와 cache 오류도 별도로 표시합니다. fixture 원문 링크는 `example.invalid` 예시로서 실제 문서가 없고 클릭해도 외부로 이동하지 않습니다.

`connected-read-only`는 향후 provider와 테스트를 위한 계약이며 기본 앱에서는 활성화되지 않습니다. 실제 Wiki URL/API가 제공되지 않아 네트워크 adapter, 인증, OAuth와 실제 문서 연결은 구현하지 않았습니다. 연결하려면 서비스 URL, 읽기 전용 검색·문서 조회 API와 응답 스키마, 문서 ID·원문 URL 규칙, 인증과 권한 범위, 명시적으로 승인된 문서 범위가 필요합니다. cache 검색은 마지막으로 저장한 결과에 한정되며 전체 Wiki 검색을 의미하지 않습니다.

## 데이터 안전 원칙

- 승인 전 알림/Calendar 생성 금지
- 음성인식·동기화 실패 시 WAV 원본 보존
- 기존 앱 제거/데이터 초기화 없이 동일 서명 업데이트
- Calendar 삭제 실패 시 연결 정보와 재시도 상태 보존
- 운영 데이터, 음성, DB, 토큰, 서명키, 개인 로그, 기존 Git 이력은 이 공개 복사본에 포함하지 않음

라이선스는 아직 지정하지 않았습니다. 공개 저장소라는 사실만으로 재배포·변경 허가를 부여하지 않습니다.
