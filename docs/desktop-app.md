# 블랙홀 데스크톱 앱 (2단계, Mac)

Tauri 2 + TypeScript. 같은 달력 화면(`desktop/src/calendar/`)을 나중에 휴대폰 앱이 WebView로 띄웁니다.

## 실행

```sh
cd desktop
npm ci
npm run tauri dev                         # 개발 실행
npm run tauri build -- --bundles app      # src-tauri/target/release/bundle/macos/Blackhole.app
```

- 서명·공증은 하지 않습니다. `/Applications`에 넣지 않고 빌드 폴더에서 바로 엽니다.
- 작업기는 1단계와 같은 설정을 씁니다: `~/.local/share/blackhole-models`, Ollama(`127.0.0.1:11434`)의 `gemma4:e2b-it-q4_K_M`, 환경 변수 `BLACKHOLE_*`, `worker-config.json`. Ollama가 꺼져 있으면 대화창에 「분석하지 못했어요」가 뜨고 아무것도 넣지 않습니다.
- 브라우저(`npm run dev` → http://127.0.0.1:1420)로 열면 「미리보기·미연결」 모드: 작업기·인박스 없이 화면만 봅니다.

## 저장 위치 (로컬·미연결)

`~/Library/Application Support/com.malhaedwo.blackhole.desktop/`

| 파일·폴더 | 내용 |
|---|---|
| `blackhole-calendar-v1.json` | 일정·할 일·기간·기억·대화·설정. 원자적 저장. 깨진 파일은 `.corrupt-<시각>`으로 옮겨 두고 새로 시작 |
| `입력/<해시8>-<이름>` | 앱에서 보낸 사진·녹음·파일의 사본(작업기가 읽는 원본) |
| `시험-블랙홀/` | 인박스 시험 폴더(`인박스/`, `원본/`, `노트/`, `.블랙홀/`). 설정에서 「인박스 처리」를 켜면 15초마다 훑음 |

구글 캘린더·시트에는 아무것도 쓰지 않습니다. 인박스 폴더는 설정에서 「시험 폴더」와 「드라이브 「블랙홀」」 중 고릅니다(기본은 시험 폴더). 드라이브 폴더는 휴대폰이 만든 `~/Library/CloudStorage/GoogleDrive-*/내 드라이브/블랙홀`만 허용하고, 거기에는 `원본/` 사본과 `노트/`·`.블랙홀/`만 씁니다. 인박스 원본은 지우거나 옮기지 않습니다. 그 밖의 동기화 폴더(iCloud, Dropbox, 드라이브의 다른 폴더)는 거부합니다.

## 쓰는 법

- 아래 입력칸에 문장을 쓰고 Enter(또는 ↑). 사진 단추는 사진·PDF·한글·워드·엑셀·txt·wav를 받습니다. 마이크 단추는 누르면 녹음, 다시 누르면 보냅니다. 창에 파일을 끌어 놓아도 됩니다.
- 일정은 「가승인」(점선, 「가」)으로 들어갑니다. 확정/취소는 입력칸 위 한 줄, 대화 기록, 일간 「확인 대기」에서. 할 일·기간·기억은 바로 들어가고 「되돌리기」가 있습니다.
- 손잡이를 끌어 올리면(또는 누르면) 대화 기록이 열립니다.
- 알람: 정해진 시각에 창이 맨 앞으로 오고(항상 위), Dock이 튀고, 「Glass」 소리가 반복됩니다. 「확인/완료」 또는 「10분 뒤」를 누를 때까지(최대 10분) 계속됩니다. 창을 닫아도 앱은 Dock에 남아 알람을 울립니다(완전히 끄려면 ⌘Q).
- 출력: 지금 보기(월·주·일)를 A4 공문서 양식으로 미리 보고 「인쇄」.
- 유리 테마는 창이 반투명이라 바탕화면이 흐리게 비칩니다(2026-10-25 제품 소유자 요청). 공문서 테마는 불투명한 흰 종이입니다.
- 설정: 유리/공문서, 어둡게/밝게, 가짜 자료 보이기, 인박스 처리, 알람 시험(10초 뒤).

## 어댑터 (휴대폰이 구현할 것)

`desktop/src/calendar/adapter.ts`의 `BlackholeAdapter`: `load/save`, `analyze`, `inboxStatus/setInbox/inboxResults`, `scheduleAlarms/onAlarm/ring`, `print`, (선택) `onFileDrop`. 휴대폰은 같은 화면에 자기 어댑터를 넘기면 됩니다.
