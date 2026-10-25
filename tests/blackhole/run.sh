#!/bin/bash
# 블랙홀 휴대폰 쪽 호스트 시험.
#  1) 보내기 대기열·가짜 드라이브 업로드·알람 장부를 실제로 실행한다(127.0.0.1 가짜 서버, 실제 드라이브 접속 없음).
#  2) 안드로이드 화면·알림·알람 코드는 tests/blackhole/android-stubs의 API 모양에 맞춰 컴파일만 해 본다.
#     스텁은 실제 android.jar가 아니므로, 진짜 컴파일 검사는 APK 빌드(build.sh)에서 해야 한다.
#  3) 매니페스트·소스 배선(잠금화면·전체 화면·개인정보 경계)을 글자로 확인한다.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 11+ installation}"
if [ ! -x "$JAVA_HOME/bin/javac" ]; then
  echo "JDK not found: $JAVA_HOME" >&2
  exit 2
fi
SRC="${PRODUCTION_SOURCE_DIR:-$ROOT/src/com/malhaedwo/pttprobe}"
HERE="$ROOT/tests/blackhole"
OUT="$HERE/.build"
rm -rf "$OUT"
mkdir -p "$OUT/host" "$OUT/stubbed"

collect() { find "$@" -name '*.java' -print | sort; }

# 1) 실행 시험
HOST=()
while IFS= read -r f; do HOST+=("$f"); done < <(collect "$HERE/json" "$HERE/src")
"$JAVA_HOME/bin/javac" -encoding UTF-8 --release 11 -d "$OUT/host" "${HOST[@]}" \
  "$SRC/BlackholeOutbox.java" "$SRC/DriveTransfer.java" "$SRC/BlackholeUploader.java" "$SRC/BlackholeAlarmBook.java" \
  "$SRC/BlackholeCalendarStore.java" "$SRC/BlackholeCalendarSync.java"
"$JAVA_HOME/bin/java" -ea -cp "$OUT/host" com.malhaedwo.pttprobe.BlackholeHostTest

# 2) 안드로이드 쪽 컴파일 검사(스텁)
STUBS=()
while IFS= read -r f; do STUBS+=("$f"); done < <(collect "$HERE/android-stubs" "$HERE/json")
ANDROID_SIDE=()
while IFS= read -r f; do ANDROID_SIDE+=("$f"); done < <(find "$SRC" -name 'Blackhole*.java' -print | sort)
"$JAVA_HOME/bin/javac" -encoding UTF-8 --release 11 -Xlint:-deprecation -d "$OUT/stubbed" "${STUBS[@]}" "${ANDROID_SIDE[@]}" \
  "$SRC/DriveTransfer.java" "$SRC/WavRecorder.java" "$SRC/SystemBarInsets.java" "$SRC/BootReceiver.java"
echo "Android side compile check PASS: ${#ANDROID_SIDE[@]} Blackhole files (stub API, not android.jar)"

# 3) 배선 확인
"$JAVA_HOME/bin/java" -ea -cp "$OUT/host" com.malhaedwo.pttprobe.BlackholeWiringTest "$ROOT"
