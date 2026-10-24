# Ya 로컬 분석 작업기 (1단계)

음성(WAV)·글·문서(PDF, HWP, HWPX, DOCX, XLSX)·이미지(PNG, JPG, WebP) 하나를 넣으면 이 컴퓨터 안의 모델만으로 「제안 JSON」을 만듭니다. Google, Calendar, 외부 AI API에 연결하지 않습니다. 화면(UI)은 아직 없고, 2단계에서 데스크톱 앱이 같은 Rust 모듈을 부릅니다.

## 구조

```text
desktop/src-tauri/src/worker/
  pipeline.rs   입력 하나 → 제안 하나 (원본은 읽기만)
  runners.rs    whisper-cli, kordoc, Ollama(127.0.0.1만) 호출 경계
  extract.rs    Gemma 지시문, 출력 스키마, 엄격한 검증
  dates.rs      날짜·시간 해석(코드가 기준 시각으로 계산)
  queue.rs      작업 대기열(받음/분석 중/결과 있음/실패, 다시 시도, 중복 막기)
  source.rs     원본 해시, WAV 무음 검사
  proposal.rs   제안 JSON v1 타입
  config.rs     모델·실행기 위치(환경 변수로 바꿈)
desktop/src-tauri/src/bin/ya-worker.rs   CLI
desktop/schemas/proposal.v1.schema.json  JSON 스키마
desktop/src/worker/proposal.ts           TS 타입과 형식 검사
tools/setup-local-models.sh / .ps1       모델 설치
tools/worker-eval/                       평가 도구(가짜 문장 39개 + 정답)
```

## 흐름

```text
WAV ──(엔진 A) whisper.cpp ──┐
    └(엔진 B) Gemma 4 E2B가 직접 ─────────────┐
글 ────────────────────────────┤              │
문서 ── kordoc → Markdown ─────┤              │
이미지 ─(A) kordoc OCR ────────┤              │
       └(B) Gemma 4 E2B가 직접 ────────────────┤
                               ▼              ▼
                     Gemma: summary + items[] (JSON 스키마 강제)
                               ▼
              코드 검증: 형식 오류 = 실패, 원문에 없는 표현은 버림
              코드 날짜 계산: dateText·timeText → startAt/endAt/reminderAt
                               ▼
                         제안 JSON v1
```

- **어떤 지시든**: 한 입력에서 항목을 여러 개(최대 20) 뽑습니다. 종류는 일정(SCHEDULE), 할 일(TODO), 기억(NOTE)입니다. 「~라는 거 기억해 줘」, 「회의 있고 그 전에 자료 인쇄」, 공문 한 장 전체를 모두 같은 흐름으로 처리합니다. 긴 문서는 2,400자씩 나눠 처리합니다.
- **날짜는 코드가**: 모델은 원문 속 날짜·시간 표현(「다음 주 화요일」, 「오후 3시 ~ 5시」)을 글자 그대로 옮기기만 합니다. 기준 시각을 넣어 계산하는 일은 `dates.rs`가 Android `KoreanCommandParser`와 같은 규칙으로 합니다. 지원 표현: 오늘·내일·모레·글피·어제·그저께, (이번 주/다음 주) 요일, M월 D일, YYYY년 M월 D일, M/D, 오전·오후·아침·저녁·밤·새벽 N시 (N분/반), 한글 시각(세 시), 24시, 시간 범위(~, 부터…까지).
- **추측하지 않음**: 모델 출력이 JSON 스키마에 안 맞으면 작업을 실패로 남깁니다. 원문에 없는 날짜·시간·근거는 버리고 `needsReview`와 이유를 붙입니다. 해석 못 한 날짜는 비워 둡니다.
- **지어낸 문장 막기**: 무음·잡음에서 whisper가 만드는 「시청해주셔서 감사합니다」류 문장, B 엔진이 지시문 예시를 그대로 따라 한 경우는 「빈 음성」 실패로 처리합니다.
- **기억(NOTE)**: 23열 Items 시트에는 아직 NOTE 칸이 없습니다. 제안 JSON에만 있고, 시트·Calendar에 어떻게 둘지는 2·3단계에서 정합니다.

## CLI

```sh
cd desktop/src-tauri
cargo build --release --bin ya-worker
W=target/release/ya-worker

$W analyze --file 메모.wav --engine A          # 엔진 A (기본)
$W analyze --file 메모.wav --engine B          # 엔진 B
$W analyze --file 공문.hwp                      # 문서는 항상 A
$W analyze --file 안내문.png --engine B
$W analyze --text "금요일까지 보고서 내고 민수 연락처 기억해 줘" --now 2026-10-21T09:00:00+09:00

$W enqueue --queue ~/ya-queue --file 메모.wav   # 같은 내용이면 "duplicate"
$W run     --queue ~/ya-queue                   # 받음 상태 작업을 모두 분석
$W list    --queue ~/ya-queue
$W retry   --queue ~/ya-queue job-0123456789abcdef
```

성공하면 JSON을 표준 출력에, 실패하면 `{"error":{"code":...,"message":...}}`를 표준 오류에 쓰고 종료 코드 2를 냅니다.

환경 변수: `YA_OLLAMA_URL`(기본 `http://127.0.0.1:11434`), `YA_TEXT_MODEL`(기본 `gemma4:e2b-it-q4_K_M`), `YA_DIRECT_MODEL`(기본 `gemma4:e2b-it-q4_K_M`), `YA_WHISPER_BIN`, `YA_WHISPER_MODEL`, `YA_KORDOC_BIN`, `YA_MODELS_DIR`, `YA_LLM_TIMEOUT_SECS`.

## 대기열 규칙

- 작업 ID는 원본 SHA-256 앞 16자리입니다. 같은 바이트는 파일 이름이 달라도 한 번만 들어갑니다.
- 상태: `RECEIVED`(받음) → `ANALYZING`(분석 중) → `HAS_RESULT`(결과 있음) / `FAILED`(실패).
- 실패한 작업만 `retry`로 받음 상태로 돌립니다. 시도 횟수와 마지막 오류를 남깁니다.
- 분석 도중 작업기가 멈추면 다음에 열 때 `FAILED`/`INTERRUPTED`로 바뀌어 다시 시도할 수 있습니다.
- 원본은 경로만 기록하고 복사·이동·삭제하지 않습니다. 분석 직전에 해시를 다시 확인해 내용이 바뀌었으면 `INPUT_CHANGED`로 실패시킵니다.
- 대기열 파일(`jobs-v1.json`)은 원자적으로 저장합니다. 작업을 지우는 기능은 없습니다.

## 실패 코드

`INPUT_MISSING`, `INPUT_CHANGED`, `EMPTY_AUDIO`, `UNSUPPORTED_AUDIO`, `UNSUPPORTED_INPUT`, `EMPTY_DOCUMENT`, `STT_UNAVAILABLE`, `STT_MODEL_MISSING`, `STT_FAILED`, `READER_UNAVAILABLE`, `READER_FAILED`, `RUNNER_UNAVAILABLE`, `MODEL_MISSING`, `RUNNER_FAILED`, `INVALID_MODEL_OUTPUT`, `INTERRUPTED`, `IO`.

## 평가

```sh
node tools/worker-eval/run-eval.mjs --report docs/worker-eval-results.md
```

`say -v Yuna`로 합성한 가짜 음성만 씁니다. 합성 WAV·문서·원자료는 `~/.local/share/ya-models/eval`에 두고 저장소에는 표만 남깁니다. 결과는 `docs/worker-eval-results.md`.

### 추천 기본 엔진: A (whisper.cpp + Gemma 4 E2B)

2026-10-24 이 Mac(Apple M5, 16GB)에서 잰 결과(`docs/worker-eval-results.md`)입니다.

- **정확도가 가장 높습니다.** 항목 완전 정답 88%, 문장 완전 정답 87%, 시작 시각 95%입니다. Gemma 3 4B는 78%, B 엔진은 51%, 기존 규칙 파서는 37%였습니다. 규칙 파서는 영역을 고르지 못하고, 기억(NOTE)이나 여러 항목도 만들지 못합니다.
- **틀린 것이 조용히 넘어가지 않습니다.** 시각이 틀린 항목 2개는 모두 검토 표시가 붙었습니다.
- **빠르고 모델이 하나입니다.** 모델을 올려 둔 상태에서 입력 하나에 중앙값 1.2초가 걸립니다. 같은 4.6GB 모델 파일 하나로 A·B를 모두 처리하고, 실행 중 메모리는 약 3.3GB(Ollama 실행기)+0.85GB(whisper)입니다.
- **B 엔진은 아직 기본으로 쓰기 어렵습니다.** 받아쓰기 오류율이 10.5%로 whisper(0.2%)보다 훨씬 높습니다(예: 「4시 반」→「댄시 바레」). 거의 무음인 입력에서는 지시문 예시를 그대로 따라 한 경우도 1건 있었습니다. 이 경우는 작업기가 「빈 음성」 실패로 막았습니다. 비교·대체 경로로만 남깁니다.
- **문서·이미지는 kordoc + Gemma 4 E2B(A)**가 가상 공문 HWPX·PDF·PNG 3건의 항목 5개를 모두 맞혔습니다. 이미지를 Gemma가 직접 읽는 B는 2개 중 1개만 맞혔습니다.

평가의 한계: 음성은 macOS의 한국어 목소리 중 실제로 말하는 Yuna 하나뿐입니다. 사람 목소리, 잡음, 사투리, 긴 녹음은 재지 않았습니다. 사례 39개는 작은 표본이라 몇 %p 차이는 의미가 크지 않습니다. 문서·이미지는 3건뿐입니다.
