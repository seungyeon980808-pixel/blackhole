# 로컬 모델 설치 기록

작성 2026-10-24. Blackhole 로컬 분석 작업기(`blackhole-worker`)가 쓰는 실행기와 모델입니다. 모두 저장소 밖에 있고, 음성·문서 내용을 외부로 보내지 않습니다. 모델 파일을 받을 때만 인터넷을 씁니다.

설치·확인은 `bash tools/setup-local-models.sh`로 다시 할 수 있습니다(기본은 Gemma 4 E2B 하나, 평가용 Gemma 3 두 개는 `--with-comparison`). 이미 있는 것은 건너뛰고, 아무것도 지우지 않습니다. `--check`를 붙이면 설치 없이 상태만 보고 한국어 문장 하나로 실행을 확인합니다.

## 설치한 기기

- Apple M5, 메모리 16GB, macOS (Darwin 25.6)
- 설치 전 남은 디스크 89GB, 받은 용량 합계 약 10GB(한도 20GB)

## 실행기

| 이름 | 버전 | 받은 곳 | 위치 | 용량 |
|---|---|---|---|---|
| Ollama | 0.40.10 | Homebrew `ollama` | `/opt/homebrew/Cellar/ollama` | 60MB |
| whisper.cpp (`whisper-cli`) | 1.9.5 | Homebrew `whisper.cpp` | `/opt/homebrew/Cellar/whisper.cpp` | 6MB |
| kordoc | 4.24.3 (MIT) | npm `kordoc` | `~/.local/share/blackhole-models/kordoc` | 438MB(Node 의존성 포함) |

Homebrew가 함께 설치한 의존성: `ggml` 0.27.0, `llama.cpp` 0.7.0, `sdl2-compat` 2.32.74, `sdl3` 3.4.18, `mlx-c` 0.7.0_1 (합계 약 38MB). `llama.cpp`는 whisper.cpp의 의존성으로 들어왔고 작업기는 쓰지 않습니다.

Ollama 서버는 `ollama serve`를 백그라운드로 띄워 `127.0.0.1:11434`에서만 받습니다(로그 `~/.local/share/blackhole-models/ollama-serve.log`). 로그인 시 자동 시작은 설정하지 않았습니다. 작업기는 `http://127.0.0.1`·`localhost`·`[::1]`이 아닌 실행기 주소를 거부합니다.

## 모델

| 용도 | 이름 | 양자화 | 해시 | 용량 | 위치 |
|---|---|---|---|---|---|
| 음성 인식(엔진 A) | whisper `ggml-large-v3-turbo-q5_0.bin` | q5_0 | 파일 SHA-256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` | 548MB | `~/.local/share/blackhole-models/whisper/` |
| 비교용(평가에서만 사용) | Ollama `gemma3:4b` | Q4_K_M | ID `68ceab7e468a`, 모델 층 `sha256:f06e91e18fc7…`, 그림 층 `sha256:7a50f9607a47…` | 3.4GB | `~/.ollama/models` |
| 비교용(평가에서만 사용) | Ollama `gemma3:1b` | Q4_K_M | ID `97558784bdc9`, 모델 층 `sha256:2f8c3d137f24…` | 806MB | `~/.ollama/models` |
| **기본**: 글 정리(엔진 A)와 음성·이미지 직접(엔진 B) | Ollama `gemma4:e2b-it-q4_K_M` | Q4_K_M | ID `b37049369adf`, 모델 층 `sha256:6dd7ac24fe13…`, 음성·그림 층 `sha256:7ba3bbacdf1b…` | 4.6GB | `~/.ollama/models` |
| 비교용(정확도 실험 (d)) | Ollama `gemma4:e4b-it-q4_K_M` | Q4_K_M | ID `dc35e8d9c606`, 모델 층 `sha256:370c2879f176…`, 음성·그림 층 `sha256:4cb21b935cd7…` | 6.6GB | `~/.ollama/models` |
| 이미지 글자 읽기(OCR) | kordoc 내장 PP-OCRv5 korean | ONNX | kordoc이 SHA-256 검증 | 18MB | `~/.cache/kordoc/models` |

### Gemma 3n 대신 Gemma 4 E2B를 쓴 이유

지시문은 「오디오를 직접 받는 Gemma(3n 계열)」였습니다. 그런데 Ollama 0.40.10의 `gemma3n`은 그림만 받고 음성 입력을 받지 않습니다. llama.cpp에서도 Gemma 3n 음성 입력이 확인되지 않았습니다. 그래서 같은 「E(유효 파라미터)」 기기용 계열의 후속 모델인 **Gemma 4 E2B**를 골랐습니다. `ollama show` 결과 능력 목록에 `audio`가 있고, 실제로 WAV를 넣어 「내일 오후 3시에 학부모 상담 일정 추가해 줘」를 정확히 받아 적는 것을 확인했습니다. Ollama API에서 음성은 그림과 같은 `images` 칸에 base64로 넣습니다(공식 문서에는 아직 나오지 않는 동작이라 Ollama를 올릴 때 다시 확인해야 합니다).

## 실행 확인 (2026-10-24, 이 Mac)

```text
$ whisper-cli -m ~/.local/share/blackhole-models/whisper/ggml-large-v3-turbo-q5_0.bin -l ko -nt -np -f t1.wav
 내일 오후 3시에 학부모 상담 일정 추가해줘.

$ curl 127.0.0.1:11434/api/generate  (gemma3:1b) "한 문장으로 답해: 내일 오후 3시 학부모 상담은 언제야?"
내일 오후 3시입니다.

$ blackhole-worker analyze --file t1.wav --engine B --now 2026-10-21T09:00:00+09:00
sourceText: 내일 오후 3시에 학부모 상담 일정 추가해 줘
items[0]: SCHEDULE SCHOOL 「학부모 상담 일정 추가」 2026-10-22T15:00:00+09:00

$ kordoc notice.png   (가상 안내문을 그림으로 만든 것)
1.일시:11월 3일(화) ~11월 6일(금),오후3시 ~ 5시 ...
```

t1.wav는 macOS `say -v Yuna`로 합성한 가짜 음성입니다.

## 지우는 법

필요할 때만 직접 실행하세요. 작업기와 설치 스크립트는 아무것도 지우지 않습니다.

```sh
# Gemma 모델 (Ollama). 평가용 Gemma 3만 지우려면 앞의 두 개만
ollama rm gemma3:1b gemma3:4b
ollama rm gemma4:e4b-it-q4_K_M        # 실험 (d) 비교용
ollama rm gemma4:e2b-it-q4_K_M

# whisper 모델, kordoc, 평가용 합성 파일
rm -r ~/.local/share/blackhole-models
rm -r ~/.cache/kordoc

# 실행기 (함께 들어온 의존성은 autoremove가 정리)
brew uninstall ollama whisper.cpp
brew autoremove

# Ollama 설정·키 폴더 (모델 삭제 후)
rm -r ~/.ollama
```

## 평가용 가짜 문서 도구 (2026-10-24 추가)

- 손글씨체 글꼴 Nanum Pen Script (OFL, Google Fonts 저장소): `~/.local/share/blackhole-models/eval-gen/fonts/` 3MB. 가짜 손글씨 메모를 만들 때만 씁니다.
- 가짜 문서·이미지와 실험 원자료: `~/.local/share/blackhole-models/eval/` (`docs2/`, `experiments-*.json`, 1단계 실행 파일 사본 `blackhole-worker-c3788e7`).
- 문서 생성에 쓰는 Pillow·openpyxl은 `uv run --with`로 그때그때 받아 쓰고 시스템에 설치하지 않았습니다.
- 받은 용량 합계(1단계 포함): 약 17GB, 한도 20GB 안.

## Windows

`tools/setup-local-models.ps1`을 만들었습니다(winget의 Ollama·Node.js, whisper.cpp 공식 GitHub 릴리스 b5454 `whisper-bin-x64.zip`, 같은 모델). **Windows 기기에서 아직 실행하지 않았습니다.** Windows 기기를 쓸 수 있을 때 확인해야 합니다.

## 실행기 선택: Ollama

| | Ollama | llama.cpp (`llama-server`) |
|---|---|---|
| Mac(Apple Silicon) | Homebrew·공식 앱, Metal 가속 | Homebrew, Metal 가속 |
| Windows | 공식 설치본·winget | 공식 릴리스 zip |
| Gemma 4 음성 입력 | 확인됨(이 Mac에서 실행) | `llama-server`의 `input_audio` 처리에 알려진 문제(GitHub 이슈 #21868)가 있었음 |
| 구조화 출력(JSON 스키마) | `format`에 스키마 그대로 | 문법(GBNF) 또는 스키마 변환 |
| 모델 받기·해시 | `ollama pull`이 층별 SHA-256 검증 | GGUF 파일과 mmproj를 따로 관리 |

두 플랫폼에서 같은 방식으로 설치되고, 음성 입력이 실제로 되고, JSON 스키마를 그대로 넘길 수 있어서 Ollama를 골랐습니다. 작업기는 `ChatModel` 경계 뒤에 실행기를 두어 나중에 llama.cpp로 바꿀 수 있습니다.
