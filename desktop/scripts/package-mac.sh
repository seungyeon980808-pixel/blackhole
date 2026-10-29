#!/bin/bash
# 배포용 Mac 앱 묶음: Blackhole.app을 빌드해 build/release/Blackhole-<버전>-mac.zip 과 SHA-256을 만든다.
# 서명·공증은 하지 않는다(받는 사람은 처음 한 번 오른쪽 클릭 → 열기). 개인 자료·키는 앱에 들어가지 않는다
# (키는 각자 키체인, 자료는 각자 Application Support).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="$(node -p "require('$HERE/src-tauri/tauri.conf.json').version")"
cd "$HERE"
npm ci
npm test
# 빌드한 사람의 폴더 경로(/Users/<이름>/…)가 실행 파일에 남지 않게 ~로 바꿔 넣는다.
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~ --remap-path-prefix=$ROOT=." npm run tauri build -- --bundles app
APP="$HERE/src-tauri/target/release/bundle/macos/Blackhole.app"
OUT="$ROOT/build/release"
mkdir -p "$OUT"
ZIP="$OUT/Blackhole-$VERSION-mac.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
(cd "$OUT" && shasum -a 256 "$(basename "$ZIP")" | tee "$(basename "$ZIP").sha256")
echo "만듦: $ZIP"
