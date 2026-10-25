# 블랙홀 휴대폰 쪽 호스트 시험

```sh
export JAVA_HOME=/path/to/jdk
bash tests/blackhole/run.sh
```

세 단계로 돈다.

1. **실행 시험** (`BlackholeHostTest`): 보내기 대기열(`BlackholeOutbox`), 드라이브 인박스 업로드(`BlackholeUploader` + `DriveTransfer`), 알람 장부(`BlackholeAlarmBook`). 업로드는 127.0.0.1에 띄운 가짜 드라이브(`FakeDrive`)로만 시험하고 실제 Google 드라이브에는 접속하지 않는다. 기존 WAV 업로드 질의가 공용 코드로 옮긴 뒤에도 글자 그대로 같은지도 본다.
2. **안드로이드 쪽 컴파일 검사**: `android-stubs/`는 블랙홀 코드가 쓰는 안드로이드 API의 모양만 흉내 낸 것이다. 실제 `android.jar`가 아니므로, 진짜 API 검사는 `build.sh`(개인 도구 모음 필요)에서 해야 한다.
3. **배선 확인** (`BlackholeWiringTest`): 매니페스트 등록, 잠금화면에서 지난 내용이 보이지 않는 경계, 알람의 전체 화면·알람 스트림·반복, 승인 DB·캘린더와 분리.

이 시험은 기기 시험을 대신하지 않는다. 잠금화면 동작, 소리·진동, 전체 화면 표시, 실제 드라이브 업로드는 기기에서 따로 확인해야 한다.
