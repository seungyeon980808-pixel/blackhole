#!/bin/bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS="${PTT_TOOLCHAIN_HOME:-$HOME/.local/share/blackhole/android-toolchain}"
JAVA_HOME="${JAVA_HOME:-$TOOLS/jdk/Contents/Home}"
ANDROID_JAR="$TOOLS/sdk/platforms/android-35/android.jar"
R8="$TOOLS/libs/r8-9.4.17.jar"
ARSC="$TOOLS/libs/ARSCLib-1.4.0.jar"
APKSIG="$TOOLS/libs/apksig-9.3.2.jar"
BUILD="$HERE/build"
INPUT="$HERE/apk-input"
VERSION="0.12.0"
OUTPUT="$BUILD/malhaedwo-ptt-probe-$VERSION.apk"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/tools"

# 운영 설정은 저장소 밖 파일에서 읽어 빌드용 사본에만 넣는다(공개 소스의 자리표시 값은 그대로).
# 자리표시 값이 남은 APK는 구글 연결·동기화가 멈추므로 만들지 않는다.
PRIVATE_CONFIG="${BLACKHOLE_PRIVATE_CONFIG:-$HOME/.config/blackhole/private.env}"
if [ ! -s "$PRIVATE_CONFIG" ]; then
  echo "Private configuration is required: $PRIVATE_CONFIG (see README 공개용 설정); refusing to build a placeholder APK" >&2
  exit 4
fi
# shellcheck disable=SC1090
. "$PRIVATE_CONFIG"
: "${BLACKHOLE_OAUTH_CLIENT_PREFIX:?}" "${BLACKHOLE_ALLOWED_EMAIL:?}" "${BLACKHOLE_SPREADSHEET_ID:?}" "${BLACKHOLE_PRIVACY_URL:?}"
export BLACKHOLE_OAUTH_CLIENT_PREFIX BLACKHOLE_ALLOWED_EMAIL BLACKHOLE_SPREADSHEET_ID BLACKHOLE_PRIVACY_URL
STAGE="$BUILD/staging"
mkdir -p "$STAGE"
cp -R "$HERE/src" "$STAGE/src"
cp -R "$INPUT" "$STAGE/apk-input"
INPUT="$STAGE/apk-input"

# 블랙홀 달력 화면(데스크톱과 같은 desktop/src/calendar)을 assets/calendar/로 넣는다.
# 웹 묶음은 Git에 없다: cd desktop && npm ci && npm run build:phone (또는 BLACKHOLE_CALENDAR_WEB로 위치 지정).
CALENDAR_WEB="${BLACKHOLE_CALENDAR_WEB:-$HERE/desktop/dist-phone}"
if [ ! -s "$CALENDAR_WEB/phone.html" ]; then
  echo "Calendar web bundle is required: $CALENDAR_WEB/phone.html (cd desktop && npm run build:phone)" >&2
  exit 6
fi
mkdir -p "$INPUT/root/assets/calendar"
cp -R "$CALENDAR_WEB/." "$INPUT/root/assets/calendar/"
find "$STAGE" \( -name '*.java' -o -name 'AndroidManifest.xml' \) -print0 | xargs -0 perl -pi -e '
  s/YOUR_GOOGLE_OAUTH_CLIENT_ID/$ENV{BLACKHOLE_OAUTH_CLIENT_PREFIX}/g;
  s/owner\@example\.invalid/$ENV{BLACKHOLE_ALLOWED_EMAIL}/g;
  s/YOUR_SPREADSHEET_ID/$ENV{BLACKHOLE_SPREADSHEET_ID}/g;
  s#https://example\.invalid/blackhole/privacy#$ENV{BLACKHOLE_PRIVACY_URL}#g;'
if grep -rqE --include='*.java' --include='AndroidManifest.xml' 'YOUR_GOOGLE_OAUTH_CLIENT_ID|YOUR_SPREADSHEET_ID|example\.invalid' "$STAGE"; then
  echo "Placeholder values remain after applying private configuration; refusing to build" >&2
  exit 5
fi

"$JAVA_HOME/bin/javac" -encoding UTF-8 -source 11 -target 11 -cp "$ANDROID_JAR" -d "$BUILD/classes" $(find "$STAGE/src" -name '*.java' -print)
"$JAVA_HOME/bin/java" -cp "$R8" com.android.tools.r8.D8 --release --min-api 31 --lib "$ANDROID_JAR" --lib "$TOOLS/libs/java-base.jar" --output "$BUILD/dex" $(find "$BUILD/classes" -name '*.class' -print)
mkdir -p "$INPUT/dex"
cp "$BUILD/dex/classes.dex" "$INPUT/dex/classes.dex"
"$JAVA_HOME/bin/javac" -encoding UTF-8 -source 11 -target 11 -cp "$ARSC:$APKSIG" -d "$BUILD/tools" "$HERE/tools/BuildApk.java" "$HERE/tools/InspectApk.java" "$HERE/tools/SignVerifyApk.java"
"$JAVA_HOME/bin/java" -cp "$BUILD/tools:$ARSC" BuildApk "$INPUT" "$BUILD/ptt-probe-unsigned.apk"

SIGNING_HOME="${PTT_SIGNING_HOME:-$HOME/.config/blackhole/signing}"
KEYSTORE="$SIGNING_HOME/ptt-probe.jks"
PASSFILE="$SIGNING_HOME/password"
if [ ! -s "$KEYSTORE" ] || [ ! -s "$PASSFILE" ]; then
  echo "Existing signing identity is required; refusing to generate a replacement key" >&2
  exit 3
fi
STOREPASS=$(cat "$PASSFILE")
"$JAVA_HOME/bin/java" -cp "$BUILD/tools:$APKSIG" SignVerifyApk "$BUILD/ptt-probe-unsigned.apk" "$OUTPUT" "$KEYSTORE" pttprobe "$STOREPASS" "$STOREPASS" | tee "$BUILD/signature-verification.txt"
"$JAVA_HOME/bin/java" -cp "$BUILD/tools:$ARSC" InspectApk "$OUTPUT" > "$BUILD/manifest-inspection.txt"
unzip -t "$OUTPUT"
shasum -a 256 "$OUTPUT" | tee "$BUILD/SHA256.txt"
