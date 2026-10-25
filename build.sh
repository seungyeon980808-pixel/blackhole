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
VERSION="0.10.1"
OUTPUT="$BUILD/malhaedwo-ptt-probe-$VERSION.apk"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/tools"

"$JAVA_HOME/bin/javac" -encoding UTF-8 -source 11 -target 11 -cp "$ANDROID_JAR" -d "$BUILD/classes" $(find "$HERE/src" -name '*.java' -print)
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
