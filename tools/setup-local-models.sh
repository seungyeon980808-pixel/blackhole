#!/usr/bin/env bash
# Installs the local runners and models the Ya analysis worker uses (macOS, Apple Silicon).
# Safe to re-run: anything already present is skipped, and nothing is ever deleted.
#
#   bash tools/setup-local-models.sh                     # install what is missing
#   bash tools/setup-local-models.sh --with-comparison   # also gemma3:1b and gemma3:4b (evaluation only)
#   bash tools/setup-local-models.sh --with-document-model  # also gemma4:e4b for documents and images (6.6GB)
#   bash tools/setup-local-models.sh --check             # only report what is installed, then run a Korean smoke test
#
# Everything lives outside the repository:
#   Homebrew: ollama, whisper.cpp
#   Ollama models: ~/.ollama/models (gemma4:e2b-it-q4_K_M; gemma3:1b/4b with --with-comparison)
#   $YA_MODELS_DIR (default ~/.local/share/ya-models): whisper/ggml-large-v3-turbo-q5_0.bin, kordoc/
#   kordoc OCR models: ~/.cache/kordoc/models
set -euo pipefail

MODELS_DIR="${YA_MODELS_DIR:-$HOME/.local/share/ya-models}"
OLLAMA_URL="${YA_OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_MODELS=(gemma4:e2b-it-q4_K_M)
WHISPER_FILE="ggml-large-v3-turbo-q5_0.bin"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_FILE"
WHISPER_SHA256="394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
KORDOC_VERSION="4.24.3"
# Download sizes in MB, used for the disk check before anything is fetched.
SIZE_MB_OLLAMA=(4600)
SIZE_MB_WHISPER=548
SIZE_MB_KORDOC=460
LIMIT_MB=20480
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --with-comparison) OLLAMA_MODELS+=(gemma3:1b gemma3:4b); SIZE_MB_OLLAMA+=(806 3400) ;;
    --with-document-model) OLLAMA_MODELS+=(gemma4:e4b-it-q4_K_M); SIZE_MB_OLLAMA+=(6600) ;;
    *) echo "모르는 옵션: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

ollama_up() { curl -fsS "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
ollama_has() { ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$1"; }

# 1. Plan: what is missing and how big it is.
need_mb=0
plan=()
have ollama || plan+=("Homebrew ollama (~60MB)")
have whisper-cli || plan+=("Homebrew whisper.cpp (~10MB)")
for i in "${!OLLAMA_MODELS[@]}"; do
  if ! (have ollama && ollama_up && ollama_has "${OLLAMA_MODELS[$i]}"); then
    plan+=("Ollama ${OLLAMA_MODELS[$i]} (${SIZE_MB_OLLAMA[$i]}MB)")
    need_mb=$((need_mb + SIZE_MB_OLLAMA[$i]))
  fi
done
if [[ ! -f "$MODELS_DIR/whisper/$WHISPER_FILE" ]]; then
  plan+=("whisper $WHISPER_FILE (${SIZE_MB_WHISPER}MB)")
  need_mb=$((need_mb + SIZE_MB_WHISPER))
fi
if [[ ! -x "$MODELS_DIR/kordoc/node_modules/.bin/kordoc" ]]; then
  plan+=("kordoc $KORDOC_VERSION + OCR models (~${SIZE_MB_KORDOC}MB)")
  need_mb=$((need_mb + SIZE_MB_KORDOC))
fi

free_mb=$(df -m "$HOME" | awk 'NR==2 {print $4}')
log "칩: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), 메모리: $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))GB, 남은 디스크: ${free_mb}MB"
if ((${#plan[@]} == 0)); then
  log "설치할 것 없음: 모두 설치되어 있습니다."
else
  log "설치할 것 (받을 용량 약 ${need_mb}MB):"
  printf '  - %s\n' "${plan[@]}"
fi

if ((CHECK_ONLY == 0 && ${#plan[@]} > 0)); then
  if ((need_mb > LIMIT_MB)); then
    log "받을 용량이 ${LIMIT_MB}MB를 넘습니다. 멈춥니다."; exit 1
  fi
  if ((free_mb < need_mb + 5120)); then
    log "디스크 여유가 부족합니다(필요 ${need_mb}MB + 여유 5GB). 멈춥니다."; exit 1
  fi

  # 2. Runners from Homebrew (official formulae only).
  have brew || { log "Homebrew가 필요합니다: https://brew.sh"; exit 1; }
  have ollama || brew install ollama
  have whisper-cli || brew install whisper.cpp
  have node || { log "kordoc에 Node.js 20 이상이 필요합니다."; exit 1; }

  if ! ollama_up; then
    log "Ollama 서버를 백그라운드로 시작합니다(로그: $MODELS_DIR/ollama-serve.log)."
    mkdir -p "$MODELS_DIR"
    nohup ollama serve >"$MODELS_DIR/ollama-serve.log" 2>&1 &
    for _ in $(seq 1 30); do ollama_up && break; sleep 1; done
    ollama_up || { log "Ollama 서버가 뜨지 않았습니다."; exit 1; }
  fi

  # 3. Models.
  for model in "${OLLAMA_MODELS[@]}"; do
    ollama_has "$model" || ollama pull "$model"
  done
  mkdir -p "$MODELS_DIR/whisper"
  if [[ ! -f "$MODELS_DIR/whisper/$WHISPER_FILE" ]]; then
    curl -fL --progress-bar -o "$MODELS_DIR/whisper/$WHISPER_FILE.part" "$WHISPER_URL"
    actual=$(shasum -a 256 "$MODELS_DIR/whisper/$WHISPER_FILE.part" | cut -d' ' -f1)
    if [[ "$actual" != "$WHISPER_SHA256" ]]; then
      log "whisper 모델 해시가 다릅니다($actual). 받은 파일은 .part로 남겨 둡니다."; exit 1
    fi
    mv "$MODELS_DIR/whisper/$WHISPER_FILE.part" "$MODELS_DIR/whisper/$WHISPER_FILE"
  fi
  if [[ ! -x "$MODELS_DIR/kordoc/node_modules/.bin/kordoc" ]]; then
    mkdir -p "$MODELS_DIR/kordoc"
    [[ -f "$MODELS_DIR/kordoc/package.json" ]] || printf '{"name":"ya-kordoc","private":true}\n' >"$MODELS_DIR/kordoc/package.json"
    npm install --prefix "$MODELS_DIR/kordoc" --no-fund --no-audit "kordoc@$KORDOC_VERSION"
  fi
  # Fetch OCR models now so analysis never downloads anything.
  "$MODELS_DIR/kordoc/node_modules/.bin/kordoc" check-ocr-models
fi

# 4. Report and smoke test.
log ""
log "설치 상태:"
log "  ollama: $(ollama -v 2>/dev/null | tail -1 || echo 없음)"
log "  whisper-cli: $(command -v whisper-cli || echo 없음)"
ollama list 2>/dev/null | sed 's/^/  /' || true
ls -l "$MODELS_DIR/whisper/$WHISPER_FILE" 2>/dev/null | sed 's/^/  /' || log "  whisper 모델 없음"
log "  kordoc: $("$MODELS_DIR/kordoc/node_modules/.bin/kordoc" --version 2>/dev/null || echo 없음)"

if ollama_up && ollama_has gemma4:e2b-it-q4_K_M; then
  log ""
  log "한국어 확인(gemma4:e2b-it-q4_K_M):"
  curl -fsS "$OLLAMA_URL/api/generate" \
    -d '{"model":"gemma4:e2b-it-q4_K_M","think":false,"prompt":"한 문장으로 답해: 내일 오후 3시 학부모 상담은 언제야?","stream":false,"options":{"temperature":0}}' |
    python3 -c 'import json,sys; print("  " + json.load(sys.stdin)["response"].strip())'
fi
if have whisper-cli && have say && [[ -f "$MODELS_DIR/whisper/$WHISPER_FILE" ]]; then
  tmp=$(mktemp -d)
  say -v Yuna -o "$tmp/check.wav" --data-format=LEI16@16000 "내일 오후 세 시에 학부모 상담" 2>/dev/null &&
    printf '  whisper: %s\n' "$(whisper-cli -m "$MODELS_DIR/whisper/$WHISPER_FILE" -l ko -nt -np -f "$tmp/check.wav" 2>/dev/null | tr -d '\n')"
fi
