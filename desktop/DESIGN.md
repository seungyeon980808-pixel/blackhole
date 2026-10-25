# 블랙홀 데스크톱 화면 계약 (2단계, 2026-10-25)

이전 「승인 문서함」 계약(0.1.x)은 끝났습니다. 승인함은 없애고 가승인 일정을 달력에서 확정/취소합니다.

## 명세

- 승인된 시안 두 개가 명세입니다.
  - 유리 테마(기본): `design/calendar-glass/prototype-glass.html`
  - 공문서 테마: `design/calendar-glass/prototype-doc.html`
- 출력(A4)은 두 테마 모두 공문서 양식입니다.
- 구조를 바꿔야 하면 먼저 제품 소유자에게 묻습니다. 장식 아이콘, 같은 정보 반복 금지. 빽빽하게.

## 구조

```text
desktop/src/calendar/      달력 앱 (Tauri를 import하지 않음 → 휴대폰 WebView가 그대로 씀)
  app.ts                   mountBlackhole(root, adapter): 월·주·일, 입력칸, 대화, 알람, 출력, 설정
  adapter.ts               저장·작업기·인박스·알람·인쇄 어댑터 인터페이스
  model.ts / store.ts      자료 형식과 순수 함수(작업기 제안 → 일정·할 일·기간·기억)
  fc.ts                    FullCalendar(MIT: core·daygrid·timegrid·interaction) — 월(두 테마), 주(유리)
  views/glass.ts, doc.ts   일간(10분 칸 + □/○/- 체크리스트), 공문서 주간 표, 대화 말풍선, 알람, A4
  recorder.ts              말하기: 16kHz WAV 녹음(웹 API)
  memory-adapter.ts        브라우저 미리보기용(작업기 없음)
desktop/src/adapters/tauri.ts   데스크톱 어댑터 (이번 단계에서 구현한 유일한 어댑터)
desktop/src-tauri/src/desk.rs   명령: 상태 파일, 작업기 분석, 시험 폴더 인박스, 알람(창 앞으로 + 소리), 인쇄
desktop/src-tauri/src/calendar.rs  위 명령의 순수 부분과 테스트
```

## 원칙

- 유리 테마는 Mac에서 창 자체가 반투명입니다(투명 창 + macOS 비침 효과, 어둡게=HUD, 밝게=팝오버 재질). 바탕화면이 흐리게 비치고, 시안의 그라데이션은 옅은 색조로만 남깁니다. 제목 막대는 투명(신호등 단추만 보임)하고 위쪽 줄을 끌어 창을 옮깁니다. 공문서 테마는 흰 종이로 불투명합니다. 브라우저·휴대폰에서는 시안처럼 그라데이션 배경을 칠합니다.

- 화면에 항상 「로컬·미연결」을 보입니다. 4단계 전에는 구글에 쓰지 않습니다.
- 일정은 가승인(점선 테두리 + 「가」)으로 들어가고 확정/취소를 받습니다. 할 일·기간·기억은 바로 들어가고 되돌리기를 줍니다. 취소·되돌리기는 지우지 않고 표시만 바꿉니다.
- 작업기에서 온 글자는 모두 이스케이프합니다.
- 360px 폭(휴대폰)에서 세 칸 일간은 세로로 쌓이고, 월간 칩은 시각을 숨겨 제목을 보입니다.
- 키보드: 체크 상자·하위 항목·손잡이는 Tab으로 가고 Enter/Space로 누릅니다. Esc는 출력·설정·대화를 닫습니다. `:focus-visible`, `prefers-reduced-motion`을 지킵니다.
