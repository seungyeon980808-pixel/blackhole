# Blackhole 로컬 분석 작업기 (1단계)

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
desktop/src-tauri/src/bin/blackhole-worker.rs   CLI
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
cargo build --release --bin blackhole-worker
W=target/release/blackhole-worker

$W analyze --file 메모.wav --engine A          # 엔진 A (기본)
$W analyze --file 메모.wav --engine B          # 엔진 B
$W analyze --file 공문.hwp                      # 문서는 항상 A
$W analyze --file 안내문.png --engine B
$W analyze --text "금요일까지 보고서 내고 민수 연락처 기억해 줘" --now 2026-10-21T09:00:00+09:00

$W enqueue --queue ~/blackhole-queue --file 메모.wav   # 같은 내용이면 "duplicate"
$W run     --queue ~/blackhole-queue                   # 받음 상태 작업을 모두 분석
$W list    --queue ~/blackhole-queue
$W retry   --queue ~/blackhole-queue job-0123456789abcdef
```

성공하면 JSON을 표준 출력에, 실패하면 `{"error":{"code":...,"message":...}}`를 표준 오류에 쓰고 종료 코드 2를 냅니다.

환경 변수: `BLACKHOLE_OLLAMA_URL`(기본 `http://127.0.0.1:11434`), `BLACKHOLE_TEXT_MODEL`(기본 `gemma4:e2b-it-q4_K_M`), `BLACKHOLE_DIRECT_MODEL`(기본 `gemma4:e2b-it-q4_K_M`), `BLACKHOLE_WHISPER_BIN`, `BLACKHOLE_WHISPER_MODEL`, `BLACKHOLE_KORDOC_BIN`, `BLACKHOLE_MODELS_DIR`, `BLACKHOLE_LLM_TIMEOUT_SECS`.

## 대기열 규칙

- 작업 ID는 원본 SHA-256 앞 16자리입니다. 같은 바이트는 파일 이름이 달라도 한 번만 들어갑니다.
- 상태: `RECEIVED`(받음) → `ANALYZING`(분석 중) → `HAS_RESULT`(결과 있음) / `FAILED`(실패).
- 실패한 작업만 `retry`로 받음 상태로 돌립니다. 시도 횟수와 마지막 오류를 남깁니다.
- 분석 도중 작업기가 멈추면 다음에 열 때 `FAILED`/`INTERRUPTED`로 바뀌어 다시 시도할 수 있습니다.
- 원본은 경로만 기록하고 복사·이동·삭제하지 않습니다. 분석 직전에 해시를 다시 확인해 내용이 바뀌었으면 `INPUT_CHANGED`로 실패시킵니다.
- 대기열 파일(`jobs-v1.json`)은 원자적으로 저장합니다. 작업을 지우는 기능은 없습니다.

## 실패 코드

`INPUT_MISSING`, `INPUT_CHANGED`, `EMPTY_AUDIO`, `UNSUPPORTED_AUDIO`, `UNSUPPORTED_INPUT`, `EMPTY_DOCUMENT`, `STT_UNAVAILABLE`, `STT_MODEL_MISSING`, `STT_FAILED`, `READER_UNAVAILABLE`, `READER_FAILED`, `RUNNER_UNAVAILABLE`, `MODEL_MISSING`, `RUNNER_FAILED`, `INVALID_MODEL_OUTPUT`, `INTERRUPTED`, `IO`.

## 정확도 설정 (2026-10-24 추가)

모두 기본은 꺼져 있습니다. `~/.local/share/blackhole-models/worker-config.json`(또는 `BLACKHOLE_WORKER_CONFIG`가 가리키는 파일)에 적거나 환경 변수로 켭니다. 예시는 `tools/worker-config.example.json`이며, 실제 개인 단어 목록은 저장소에 넣지 않습니다. 설정 파일에 모르는 칸이 있으면 작업기가 시작하지 않습니다.

| 설정 파일 칸 | 환경 변수 | 하는 일 |
|---|---|---|
| `fillMissing` | `BLACKHOLE_FILL_MISSING=1` | 모델이 빠뜨린 날짜·시간을 코드가 원문(한 항목이면 전체, 여러 항목이면 그 항목의 근거 문장)에서 찾아 채웁니다. 채운 항목은 늘 검토 표시가 붙습니다. 기억(NOTE)에는 채우지 않습니다. |
| `whisperPrompt` | `BLACKHOLE_WHISPER_PROMPT` | whisper에 용어 힌트(`--prompt`)를 줍니다. |
| `schoolWords`, `personalWords` | `BLACKHOLE_WORD_LISTS=off`로 끔 | 지시문에 단어 목록을 보여 주고, 항목이 한쪽 목록의 말만 담고 있으면 영역을 그쪽으로 정합니다(양쪽 다 있으면 모델 판단 유지). |
| `recheckBelow` | `BLACKHOLE_RECHECK_BELOW=0.7` | 확신이 이 값보다 낮거나 검토할 항목이 있으면 모델에게 한 번 더 대조시키고, 검토 사유가 적은 답을 고릅니다. 두 번째 답이 깨지면 첫 답을 씁니다. |
| `imageOcrHint` | `BLACKHOLE_IMAGE_OCR_HINT=1` | 이미지를 엔진 B로 읽을 때 kordoc 글자 인식 결과를 힌트로 함께 줍니다. 글자 인식이 실패해도 그림 읽기는 계속합니다. |
| `documentModel` | `BLACKHOLE_DOCUMENT_MODEL` | 문서·이미지에만 쓸 더 큰 모델(예: `gemma4:e4b-it-q4_K_M`). 음성·글은 기본 모델 그대로. |

날짜 해석은 이번에 `2026. 11. 12.` 같은 공문 날짜, `15:00`·`15:00~17:00` 같은 24시간 표기, `11/27(금)`을 더 읽습니다(설정 없이 항상 켜짐).

## 평가

```sh
node tools/worker-eval/run-eval.mjs --report docs/worker-eval-results.md
```

`say -v Yuna`로 합성한 가짜 음성만 씁니다. 합성 WAV·문서·원자료는 `~/.local/share/blackhole-models/eval`에 두고 저장소에는 표만 남깁니다. 결과는 `docs/worker-eval-results.md`.

### 추천 기본 엔진: A (whisper.cpp + Gemma 4 E2B)

2026-10-24 이 Mac(Apple M5, 16GB)에서 잰 결과(`docs/worker-eval-results.md`)입니다.

- **정확도가 가장 높습니다.** 항목 완전 정답 88%, 문장 완전 정답 87%, 시작 시각 95%입니다. Gemma 3 4B는 78%, B 엔진은 51%, 기존 규칙 파서는 37%였습니다. 규칙 파서는 영역을 고르지 못하고, 기억(NOTE)이나 여러 항목도 만들지 못합니다.
- **틀린 것이 조용히 넘어가지 않습니다.** 시각이 틀린 항목 2개는 모두 검토 표시가 붙었습니다.
- **빠르고 모델이 하나입니다.** 모델을 올려 둔 상태에서 입력 하나에 중앙값 1.2초가 걸립니다. 같은 4.6GB 모델 파일 하나로 A·B를 모두 처리하고, 실행 중 메모리는 약 3.3GB(Ollama 실행기)+0.85GB(whisper)입니다.
- **B 엔진은 아직 기본으로 쓰기 어렵습니다.** 받아쓰기 오류율이 10.5%로 whisper(0.2%)보다 훨씬 높습니다(예: 「4시 반」→「댄시 바레」). 거의 무음인 입력에서는 지시문 예시를 그대로 따라 한 경우도 1건 있었습니다. 이 경우는 작업기가 「빈 음성」 실패로 막았습니다. 비교·대체 경로로만 남깁니다.
- **문서·이미지는 kordoc + Gemma 4 E2B(A)**가 가상 공문 HWPX·PDF·PNG 3건의 항목 5개를 모두 맞혔습니다. 이미지를 Gemma가 직접 읽는 B는 2개 중 1개만 맞혔습니다.

평가의 한계: 음성은 macOS의 한국어 목소리 중 실제로 말하는 Yuna 하나뿐입니다. 사람 목소리, 잡음, 사투리, 긴 녹음은 재지 않았습니다. 사례 39개는 작은 표본이라 몇 %p 차이는 의미가 크지 않습니다. 문서·이미지는 3건뿐입니다.

### 2차 실험 뒤 추천 설정 (2026-10-24)

`tools/worker-config.example.json`을 `~/.local/share/blackhole-models/worker-config.json`으로 복사하고 단어 목록을 자기 것으로 바꿉니다. 문서·이미지용 `gemma4:e4b-it-q4_K_M`은 `bash tools/setup-local-models.sh --with-document-model`로 받습니다.

- 켬: `fillMissing`, `whisperPrompt`, 단어 목록, `imageOcrHint`, `documentModel` = e4b
- 끔: `recheckBelow`

평가용 결과는 아래와 같습니다(`docs/worker-eval-results.md` 2차 절).

| 대상 | 1단계 | 추천 설정 |
|---|---|---|
| 음성 항목 완전 정답 | 88% | 90% |
| 문서·이미지 항목 완전 정답 | 70% | 89% |

e4b를 쓰지 않으면 이미지 힌트(`imageOcrHint`)도 끄는 편이 낫습니다. 작은 모델이 그림을 직접 읽으면 정확도가 떨어집니다.

## 블랙홀 폴더 처리 (2026-10-25)

```sh
blackhole-worker inbox --root "<블랙홀 폴더>"             # 한 번 훑기
blackhole-worker inbox --root "<블랙홀 폴더>" --watch 30  # 30초마다 계속
```

- `인박스/`에 파일(문장 .txt, 음성 .wav, PDF·한글·워드·엑셀, 사진)을 넣으면 `원본/연/월/<해시8>-<이름>`에 사본을 남기고 분석해 `노트/{학교|개인|미분류}/연/월/날짜 제목 (해시8).md`를 씁니다. 인박스 원본은 지우거나 옮기지 않습니다.
- 같은 바이트는 해시로 한 번만 처리합니다. 실패는 `.블랙홀/` 대기열에 남고 다음 훑기 때 최대 3번까지 다시 시도합니다.
- 올라오는 중인 파일은 `--settle`(기본 5초) 동안 건드리지 않습니다.
- 노트: 머리말(해시·받은 시각·출처·원본 링크·학교/개인·상태 「미확정」), `## 정리`(□ 일정·할 일, 들여쓴 하위 할 일, 기간, 기억, ※ 검토 사유), `## 원문`(읽어 낸 글 전체 — 옵시디언 검색 대상), `## 원본`(사본 임베드).
- `블랙홀/` 폴더를 옵시디언 보관함으로 열면 노트·원본을 함께 검색합니다.
- 제안 JSON v2: 항목에 `subtasks`, `reminders`(기본: 시각이 있으면 30분 전, 날짜만 있으면 그날 09:00, 「~에 알려 줘」가 있으면 그 시각), `kind: PERIOD`(startAt=첫날 00:00, endAt=마지막 다음 날 00:00).

## 짧은 음성·때 표현 (2026-10-25 실제 녹음에서 나온 결함 수정)

- **짧거나 약한 음성**: 1초 미만이거나 음량(RMS)이 300 미만인 녹음은 모델을 부르지 않고 항목 0개로 끝냅니다. 노트에는 `※ 검토: 음성이 너무 짧거나 약함 (길이·음량)`만 남습니다. 0.6초 녹음에서 whisper가 힌트 낱말(「수행평회, 교직원 연수, 방과후 수행평가」)을 지어낸 일이 있었습니다.
- 3초 미만 녹음은 `whisperPrompt` 없이 받아씁니다.
- 받아쓴 글의 낱말이 모두 `whisperPrompt`·단어 목록 낱말(또는 그 변형, 예: 수행평회≈수행평가)이면 지어낸 것으로 보고 항목 없이 `※ 검토: 받아쓴 글이 힌트 낱말뿐이라 지어낸 것으로 봄`을 남깁니다.
- **때 표현**: 시(時) 없이 말한 새벽·아침·오전·점심·낮·오후·저녁·밤은 기본 시각(05·08·09·12·13·15·18·21시)으로 두고 `대략 시각: 「저녁」을 18:00로 둠` 검토 표시를 붙입니다. 설정 파일 `dayparts`(예: `{"저녁": "19:00"}`)로 바꿉니다. 「저녁 7시」처럼 시가 있으면 그대로 씁니다.
