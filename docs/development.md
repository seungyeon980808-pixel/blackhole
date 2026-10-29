# 개발자용: 빌드·검사·휴대폰 APK

리드미에서 옮겨 온 개발 안내입니다. 작업 규칙은 `AGENTS.md`, 진행 기록은 `docs/plan-blackhole.md`, 화면 규칙은 `desktop/DESIGN.md`.

## Mac 앱 실행·빌드·검사

```sh
cd desktop
npm ci
npm run dev                                # 브라우저 미리보기(http://127.0.0.1:1420, 작업기·인박스 없음)
npm run tauri dev                          # 개발 실행
npm run tauri build -- --bundles app       # src-tauri/target/release/bundle/macos/Blackhole.app
```

검사(모두 통과해야 함):

```sh
cd desktop
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

설치는 만든 `Blackhole.app`으로 `/Applications/Blackhole.app`을 교체합니다. 덮기 전에 기존 앱을 `~/.local/share/blackhole/app-backup/`에 복사해 둡니다. 앱 자료 폴더는 그대로 이어 씁니다.

## 휴대폰(Android) 빌드

### 공개용 설정

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

### 호스트 테스트

JDK 11 이상이 필요합니다. 이 테스트는 Android 기기 시험의 대체물이 아닙니다.

```sh
export JAVA_HOME=/path/to/jdk
bash tests/wiring/run.sh
bash tests/insets/run.sh
bash tests/ptt/run.sh
```

### 수동 APK 빌드

블랙홀 달력 화면(데스크톱과 같은 `desktop/src/calendar`)이 APK의 `assets/calendar/`로 들어갑니다. 빌드 전에 웹 묶음을 만들어 두세요(Git에는 없음). 위치가 다르면 `BLACKHOLE_CALENDAR_WEB`으로 지정합니다. 없으면 `build.sh`가 멈춥니다(종료 코드 6).

```sh
cd desktop && npm ci && npm run build:phone && cd ..
```

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

서명 디렉터리는 `ptt-probe.jks`(alias `pttprobe`)와 비밀번호 파일 `password`를 로컬에서 제공해야 합니다. 기본 위치는 `~/.config/blackhole/signing`입니다. 기존 설치 위 업데이트에는 반드시 원래 서명키가 필요합니다. 빌드는 키를 자동 생성하거나 교체하지 않습니다. 출력은 `build/malhaedwo-ptt-probe-<버전>.apk`(지금 0.11.10)이며 서명 검증·Manifest 검사·ZIP 무결성·SHA-256 확인을 실행합니다.

## 휴대폰 화면

휴대폰 달력 화면은 Mac과 같은 `desktop/src/calendar`를 씁니다(`npm run build:phone` → APK의 `assets/calendar/`). 그래서 `desktop/src/calendar`를 고치면 다음 APK 빌드 때 휴대폰 화면에도 들어갑니다.

## 데이터 안전 원칙

- 지우기·취소·되돌리기는 표시만 바꾸고 기록을 지우지 않음
- 음성·파일 원본 보존, 인박스 원본은 지우거나 옮기지 않음
- 기존 앱 제거/데이터 초기화 없이 같은 서명으로 업데이트
- 비밀번호 같은 값은 키체인에만, AI·드라이브·달력·로그로 보내지 않음
- 운영 데이터, 음성, DB, 토큰, 서명키, 개인 로그는 이 공개 저장소에 넣지 않음

