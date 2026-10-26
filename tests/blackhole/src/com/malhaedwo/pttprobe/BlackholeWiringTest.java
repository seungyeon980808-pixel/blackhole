package com.malhaedwo.pttprobe;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 매니페스트와 소스의 배선을 글자로 확인한다(기기 시험 아님).
 * 잠금화면에서 지난 내용이 보이지 않는지, 알람이 전체 화면·알람 스트림을 쓰는지, 승인 DB와 섞이지 않는지.
 */
public final class BlackholeWiringTest {
    private static int checks;
    private static Path root;

    public static void main(String[] args) throws Exception {
        root = Path.of(args[0]);
        String manifest = read("apk-input/AndroidManifest.xml");

        // 앱 정체성은 그대로.
        check(manifest.contains("package=\"com.malhaedwo.pttprobe\""), "패키지 이름 유지");
        check(manifest.contains("android:versionCode=\"35\"") && manifest.contains("android:versionName=\"0.11.6\""),
                "버전 0.11.6(35)");
        check(manifest.contains("android.permission.USE_FULL_SCREEN_INTENT"), "전체 화면 알림 권한 선언");
        check(!manifest.contains("android.permission.CAMERA"), "CAMERA 권한 없음(카메라 앱에 맡김)");

        String share = component(manifest, "activity", ".BlackholeShareActivity");
        check(share.contains("android:exported=\"true\"") && share.contains("android.intent.action.SEND\"")
                && share.contains("android.intent.action.SEND_MULTIPLE\"") && share.contains("android:mimeType=\"*/*\""),
                "공유 메뉴: SEND·SEND_MULTIPLE, 사진·파일·문장 모두");
        check(share.contains("android:label=\"블랙홀로 보내기\""), "공유 메뉴 이름 「블랙홀로 보내기」");
        check(!share.contains("showWhenLocked"), "공유 화면은 잠금 위에 뜨지 않음");

        String lock = component(manifest, "activity", ".BlackholeLockCaptureActivity");
        check(lock.contains("android:showWhenLocked=\"true\"") && lock.contains("android:exported=\"false\"")
                && lock.contains("android:excludeFromRecents=\"true\"") && lock.contains("android:taskAffinity=\"\""),
                "잠금 입력 화면: 잠금 위, 비공개, 최근 목록 제외, 앱 작업과 분리");
        check(!lock.contains("turnScreenOn"), "잠금 입력 화면은 화면을 스스로 켜지 않음");

        String chat = component(manifest, "activity", ".BlackholeSendActivity");
        check(chat.contains("android:exported=\"false\"") && !chat.contains("showWhenLocked"), "대화 화면(지난 내용)은 잠금을 풀어야 열림");

        String calendar = component(manifest, "activity", ".CalendarWebActivity");
        check(calendar.contains("android:exported=\"false\"") && !calendar.contains("showWhenLocked"), "달력 화면(지난 일정)은 비공개, 잠금을 풀어야 열림");
        String web = src("CalendarWebActivity");
        check(web.contains("setAllowFileAccess(false)") && web.contains("setAllowContentAccess(false)"), "달력 WebView는 파일·제공자 접근 끔");
        check(web.contains("ORIGIN_HOST.equals(url.getHost())") && web.contains("path.startsWith(\"/calendar/\")") && web.contains("403"),
                "달력 WebView는 이 앱의 assets/calendar만 내보내고 나머지 주소는 막음");
        check(web.contains("shouldOverrideUrlLoading") && web.contains("RESOURCE_AUDIO_CAPTURE") && web.contains("request.deny()"),
                "다른 주소로 이동 금지, 마이크는 녹음 요청만 허락");
        check(!web.contains("BlackholeCalendarSync") || !src("BlackholeCalendarSync").contains("\"PATCH\""), "휴대폰은 달력 사본에 쓰지 않음");
        check(read("build.sh").contains("root/assets/calendar") && read("build.sh").contains("exit 6"), "APK에 달력 웹 묶음을 넣고, 없으면 빌드 중단");

        String mirror = src("CalendarMirrorWriter");
        check(mirror.contains("PREF_ENABLED, false") && mirror.contains("provisional == main"), "가승인 캘린더 반영은 켜고 두 캘린더를 따로 고르기 전에는 쓰지 않음");
        check(mirror.contains("ownedBy(resolver") && mirror.contains("CUSTOM_APP_URI"), "이 앱이 만든 일정만 바꾸고 지움");

        String widget = component(manifest, "receiver", ".CalendarWidgetProvider");
        check(widget.contains("APPWIDGET_UPDATE") && widget.contains("@xml/blackhole_widget_info"), "홈 위젯 등록");
        check(component(manifest, "service", ".CalendarRefreshJob").contains("BIND_JOB_SERVICE"), "30분 새로 고침 작업 등록");
        String refresh = src("CalendarRefreshJob");
        check(refresh.contains("PREF_LOCK, false") && refresh.contains("FLAG_LOCK"), "잠금화면 배경은 켠 경우에만, 잠금화면에만");

        String alarm = component(manifest, "activity", ".BlackholeAlarmActivity");
        check(alarm.contains("android:showWhenLocked=\"true\"") && alarm.contains("android:turnScreenOn=\"true\"")
                && alarm.contains("android:exported=\"false\""), "알람 화면: 잠금 위에서 화면을 켬");
        check(component(manifest, "activity", ".BlackholeAlarmSetupActivity").contains("android:exported=\"false\""), "알람 안내 화면");
        check(component(manifest, "receiver", ".BlackholeAlarmReceiver").contains("android:exported=\"false\""), "알람 수신기 비공개");
        check(component(manifest, "receiver", ".BlackholeReplyReceiver").contains("android:exported=\"false\""), "바로 답장 수신기 비공개");
        check(component(manifest, "service", ".BlackholeUploadJob").contains("android.permission.BIND_JOB_SERVICE"), "업로드 작업 등록");
        String provider = component(manifest, "provider", ".BlackholeCaptureProvider");
        check(provider.contains("android:exported=\"false\"") && provider.contains("android:grantUriPermissions=\"true\"")
                && provider.contains("com.malhaedwo.pttprobe.blackhole.capture"), "카메라 임시 제공자는 비공개, 한 장씩 권한만");

        // 잠금화면 개인정보 경계.
        String quick = src("BlackholeQuickNotification");
        check(quick.contains("setPublicVersion(") && quick.contains("VISIBILITY_PUBLIC"), "고정 알림 공개 판 지정");
        check(!quick.contains("outbox(") && !quick.contains("readText") && !quick.contains("recent("), "고정 알림은 지난 내용을 읽지 않음");
        check(quick.contains("addRemoteInput(") && quick.contains("\"말하기\"") && quick.contains("\"적기\"") && quick.contains("\"사진\""),
                "[말하기][적기(바로 답장)][사진]");
        check(quick.contains("FLAG_MUTABLE") && quick.contains("new Intent(app, BlackholeReplyReceiver.class)"),
                "바로 답장만 MUTABLE이고 받는 곳은 이 앱 수신기로 고정");
        String lockSrc = src("BlackholeLockCaptureActivity");
        check(lockSrc.contains("setShowWhenLocked(true)") && !lockSrc.contains("recent(") && !lockSrc.contains("readText")
                && !lockSrc.contains("BlackholeSendActivity") && !lockSrc.contains("requestPermissions("),
                "잠금 입력 화면: 지난 내용·대화 화면 길·권한 창 없음");
        check(lockSrc.contains("ACTION_IMAGE_CAPTURE") || src("BlackholeCapture").contains("ACTION_IMAGE_CAPTURE_SECURE"),
                "잠금 중에는 잠금용 카메라(IMAGE_CAPTURE_SECURE)");
        String reply = src("BlackholeReplyReceiver");
        check(reply.contains("SOURCE_LOCK") && !reply.contains("show(app, text") && !reply.contains("+ text"), "답장 뒤 알림에 보낸 글을 남기지 않음");

        // 공유 받기 안전.
        String shareSrc = src("BlackholeShareActivity");
        check(shareSrc.contains("acceptsSharedUri("), "공유 주소 검사(file://·자기 제공자 거절)");

        // 알람.
        String alarms = src("BlackholeAlarms");
        check(alarms.contains("setAlarmClock(") && alarms.contains("AlarmClockInfo"), "setAlarmClock 정확 알람");
        check(alarms.contains("USAGE_ALARM") && alarms.contains("FLAG_INSISTENT") && alarms.contains("setVibrationPattern"),
                "알람 오디오 스트림 + 반복 소리·진동");
        check(alarms.contains("setFullScreenIntent(") && alarms.contains("CATEGORY_ALARM"), "전체 화면 알림");
        check(alarms.contains("\"확인\"") && alarms.contains("\"완료\"") && alarms.contains("\"10분 뒤\""), "확인/완료/10분 뒤 단추");
        check(alarms.contains("canUseFullScreenIntent()") && alarms.contains("SDK_INT < 34"), "안드로이드 14 전체 화면 권한 확인");
        String setup = src("BlackholeAlarmSetupActivity");
        check(setup.contains("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT") && setup.contains("ACTION_REQUEST_SCHEDULE_EXACT_ALARM")
                && setup.contains("POST_NOTIFICATIONS"), "권한 안내: 알림·정확한 알람·전체 화면");
        String alarmScreen = src("BlackholeAlarmActivity");
        check(alarmScreen.contains("setShowWhenLocked(true)") && alarmScreen.contains("setTurnScreenOn(true)")
                && alarmScreen.contains("FLAG_KEEP_SCREEN_ON"), "알람 화면 잠금 위·화면 켜기");
        String boot = src("BootReceiver");
        check(boot.contains("BlackholeAlarms.restoreAll(app)") && boot.contains("BlackholeQuickNotification.refresh(app)"),
                "재부팅·앱 교체 뒤 알람·고정 알림 복구");
        check(src("MainActivity").contains("BlackholeSendActivity.class"), "첫 화면에서 보내기 화면으로 가는 줄");

        // 승인 DB·캘린더와 섞지 않음, 외부 AI 없음.
        for (String name : new String[]{"Blackhole", "BlackholeOutbox", "BlackholeUploader", "BlackholeUploadJob", "BlackholeSendActivity",
                "BlackholeShareActivity", "BlackholeLockCaptureActivity", "BlackholeQuickNotification", "BlackholeReplyReceiver",
                "BlackholeAlarms", "BlackholeAlarmBook", "BlackholeAlarmActivity", "BlackholeAlarmReceiver", "BlackholeCapture"}) {
            String s = src(name);
            check(!s.contains("CaptureDatabase.") && !s.contains("CalendarContract") && !s.contains("CalendarSync"),
                    name + ": 승인 DB·캘린더를 건드리지 않음");
            check(!s.contains(".readAllBytes(") && !s.contains(".transferTo(") && !s.contains(".isBlank(") && !s.contains(".strip("),
                    name + ": API 31에 없는 자바 메서드 안 씀");
        }
        String ptt = src("PttService");
        String handoff = src("BlackholePttHandoff");
        check(ptt.contains("BlackholePttHandoff.send(this, result.file)") && handoff.contains("BlackholeOutbox.SOURCE_PTT")
                && handoff.contains("new FileInputStream(wav)") && !handoff.contains("addFile(") && !handoff.contains(".delete("),
                "평소 녹음도 블랙홀 인박스로: 원본 WAV는 지우지 않고 복사만");
        check(ptt.indexOf("TranscriptionManager.enqueue") < ptt.indexOf("BlackholePttHandoff.send(this, result.file)"),
                "기존 저장·인식이 먼저, 블랙홀 복사는 그 뒤");
        check(handoff.contains("catch (Throwable"), "블랙홀 복사 실패가 녹음 저장을 깨지 않음");

        String engine = src("GoogleSyncEngine");
        check(engine.contains("DRIVE.findOrCreateFolder(token, \"말해둬 원본 음성\", null, appProperties)")
                && engine.contains("DRIVE.resumableUpload(token, file, file.getName(), \"audio/wav\", folderId, appProperties, \"WAV\")")
                && engine.contains("\"drive_folder_id\""), "기존 WAV 업로드는 같은 폴더·캐시 키로 공용 업로드 코드를 씀");
        check(src("BlackholeUploader").contains("\"블랙홀\"") && src("BlackholeUploader").contains("\"인박스\""), "블랙홀/인박스 폴더 이름");

        // 2026-10-26: 휴대폰 달력 받기(CalendarRefreshJob) 등록·즉시 갱신 배선.
        check(refresh.contains("PERIOD_MS = 15 * 60_000L") && refresh.contains("setPeriodic(PERIOD_MS, FLEX_MS)"),
                "달력 받기 주기 = 안드로이드 최소 15분(+여유 5분)");
        check(refresh.contains("pending.getIntervalMillis() == PERIOD_MS") && !refresh.contains("getPendingJob(JOB_ID) != null) return"),
                "예전(30분) 등록이 남아 있으면 새 간격으로 다시 등록");
        check(refresh.contains("SOON_JOB_ID") && refresh.contains("setMinimumLatency(SOON_DELAYS_MS[step])"),
                "보낸 직후 15초·30초·1분·2분·5분 뒤 다시 받기");
        check(src("BlackholeUploadJob").contains("if (report.uploaded > 0) CalendarRefreshJob.soon(app)"), "업로드가 끝나면 다시 받기 시작");
        check(boot.contains("CalendarRefreshJob.schedule(app)"), "재부팅·앱 업데이트 뒤 달력 받기 등록");
        check(src("MainActivity").contains("CalendarRefreshJob.refreshAsync(this)") && src("BlackholeSendActivity").contains("CalendarRefreshJob.refreshAsync(this)"),
                "앱·보내기 화면을 열면 바로 받기(등록 확인 포함)");
        check(src("CalendarWidgetProvider").contains("CalendarRefreshJob.schedule(context)") && src("CalendarWebActivity").contains("CalendarRefreshJob.schedule(this)"),
                "위젯·달력 화면에서도 등록");
        check(refresh.contains("sendBroadcast(new Intent(ACTION_SHARED)") && src("CalendarWebActivity").contains("CalendarRefreshJob.ACTION_SHARED")
                && src("CalendarWebActivity").contains("Blackhole.ACTION_DRAFTS"), "새 사본·새 초안이 오면 열린 달력이 바로 다시 그림");
        check(src("Blackhole").contains("BlackholeDrafts.overlay(") && src("Blackhole").contains("BlackholeCalendarStore.withPending(")
                && refresh.contains("Blackhole.boardShared(app)") && src("CalendarWidgetProvider").contains("Blackhole.boardShared(app)"),
                "위젯·잠금화면에도 휴대폰 초안과 막 누른 체크가 보임");
        // 4. 홈 위젯: 새 사본·보내기·녹음·체크 직후 다시 그림, 누르면 달력, 재부팅 뒤 유지.
        check(refresh.contains("CalendarWidgetProvider.updateAll(app)") && src("Blackhole").contains("CalendarRefreshJob.publish(app)")
                && src("BlackholeTaskReceiver").contains("CalendarRefreshJob.publish(app)"), "위젯: 사본 받기·초안·잠금화면 체크 직후 다시 그림");
        check(src("CalendarWidgetProvider").contains("new Intent(app, CalendarWebActivity.class)") && src("CalendarWidgetProvider").contains("setOnClickPendingIntent(boardView, open)"),
                "위젯을 누르면 블랙홀 달력");
        check(boot.contains("CalendarRefreshJob.publish(app)"), "재부팅·업데이트 뒤 위젯·잠금화면 다시 그림");
        check(ptt.contains("CalendarRefreshJob.onScreenOn(context)") && refresh.contains("now - lastScreenOn < 60_000L"),
                "화면을 켤 때 바로 받기(1분에 한 번, 실기기에서 위젯이 15분 늦던 문제)");
        check(read("apk-input/res/xml/blackhole_widget_info.xml").contains("home_screen|keyguard")
                && read("apk-input/resources/package_1/res/xml/blackhole_widget_info.xml").contains("home_screen|keyguard"),
                "위젯을 잠금화면 위젯 목록에도 내놓음(지원하는 기기에서)");
        check(refresh.contains("BlackholeAlarms.syncCalendar(app, \"[]\")") && src("BlackholeAlarms").contains("BlackholeCalendarStore.union(")
                && src("BlackholeAlarms").contains("alarmsFromShared(Blackhole.boardShared(app)") && src("CalendarWebActivity").contains("BlackholeAlarms.syncCalendar(CalendarWebActivity.this, json)"),
                "Mac 사본을 받을 때마다 휴대폰 알람을 맞춤(달력 화면을 안 열어도)");
        check(src("BlackholeAlarms").contains("known.waiting() && known.at > now"), "울리는 중·미뤄 둔 알람은 목록 다시 맞추기에서 끄지 않음(실기기: 울린 지 2초 만에 꺼지던 버그)");
        // 6. 잠금화면 알림: 할 일 「완료」·메모 적기, 잠금 상태에서 되는 것은 거기까지.
        check(!src("BlackholeQuickNotification").contains("setGroupSummary(true)"), "고정 입력 알림을 할 일 묶음 대표로 쓰지 않음(삼성이 숨김 — 실기기 확인)");
        quick = src("BlackholeQuickNotification");
        String taskReceiver = component(manifest, "receiver", ".BlackholeTaskReceiver");
        check(taskReceiver.contains("android:exported=\"false\""), "완료 수신기는 이 앱 안에서만");
        check(quick.contains("\"완료\"") && quick.contains("setAuthenticationRequired(false)") && quick.contains("BlackholeTaskReceiver.ACTION_DONE")
                && quick.contains("PendingIntent.FLAG_IMMUTABLE"), "잠금화면 할 일마다 「완료」(잠금 해제 없이)");
        check(quick.contains("PREF_LOCK_TASKS, true") && quick.contains("PREF_LOCK_HIDE_TITLES, false") && quick.contains("PREF_HIDE_SCHOOL, false"),
                "잠금화면 할 일: 기본 켬, 제목 가리기·학교 가리기 설정");
        check(src("BlackholeTaskReceiver").contains("BlackholeCalendarActions.record(app, action)") && !src("BlackholeTaskReceiver").contains("\"cancel\""),
                "완료는 기존 휴대폰→Mac 동작 길로, 지우기·취소는 없음");
        check(refresh.contains("Blackhole.pruneDrafts(app, text)"), "Mac 사본을 받으면 다룬 원본의 휴대폰 초안을 정리");
        // 초안 먼저: 보내기 경로마다 규칙 파서 초안.
        check(src("BlackholeSendActivity").contains("Blackhole.sendText(this, text") && src("BlackholeReplyReceiver").contains("Blackhole.sendText(app,")
                && src("BlackholeShareActivity").contains("Blackhole.sendText(app, text, source)"), "보내기·잠금화면 적기·공유 문장 → 휴대폰 초안");
        check(src("BlackholeCapture").contains("BlackholeVoiceText.transcribe(app, entry)") && src("TranscriptionManager").contains("BlackholeVoiceText.onPttTranscript(")
                && src("CalendarWebActivity").contains("BlackholeVoiceText.transcribe(CalendarWebActivity.this, entry)"),
                "녹음(보내기·잠금화면·PTT·달력 말하기) → 기기 안 받아쓰기 → 초안 + Mac용 받아쓰기 파일");
        check(src("BlackholeVoiceText").contains("\"blackhole-stt\"") && src("BlackholeVoiceText").contains("EXT = \"bhstt\""), "받아쓰기 파일 형식(Mac DraftScan과 같음)");

        System.out.println("BlackholeWiringTest PASS: " + checks + " assertions (source wiring, not device evidence)");
    }

    private static String component(String manifest, String tag, String name) {
        Matcher m = Pattern.compile("<" + tag + "\\s[^>]*android:name=\"" + Pattern.quote(name) + "\"[^>]*?(/>|>[\\s\\S]*?</" + tag + ">)")
                .matcher(manifest);
        if (!m.find()) throw new AssertionError("FAIL manifest has " + tag + " " + name);
        return m.group();
    }

    private static String src(String name) throws Exception { return read("src/com/malhaedwo/pttprobe/" + name + ".java"); }

    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(root.resolve(path)), StandardCharsets.UTF_8);
    }

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError("FAIL " + label);
        System.out.println("PASS " + label);
    }
}
