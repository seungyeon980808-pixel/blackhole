package com.malhaedwo.pttprobe;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * 블랙홀 휴대폰 쪽 호스트 시험: 보내기 대기열, 가짜 드라이브 서버로 인박스 업로드, 알람 장부.
 * 실제 드라이브·기기 시험을 대신하지 않는다.
 */
public final class BlackholeHostTest {
    private static int checks;
    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final long T0 = ZonedDateTime.of(2026, 10, 25, 14, 32, 5, 0, SEOUL).toInstant().toEpochMilli();

    public static void main(String[] args) throws Exception {
        outbox();
        upload();
        legacyWavQueries();
        alarmBook();
        calendar();
        mirror();
        board();
        drafts(args.length > 0 ? args[0] : ".");
        mirrorDeadlines();
        System.out.println("BlackholeHostTest PASS: " + checks + " assertions (가짜 드라이브·호스트 시험, 기기 증거 아님)");
    }

    // ---------------------------------------------------------------- 보내기 대기열

    private static void outbox() throws Exception {
        File dir = Files.createTempDirectory("bh-outbox").toFile();
        BlackholeOutbox outbox = new BlackholeOutbox(dir, SEOUL);
        BlackholeOutbox.Entry text = outbox.addText("  내일 3시 과학부 회의\n자료 챙기기  ", BlackholeOutbox.SOURCE_CHAT, T0);
        check(text.inboxName.startsWith("20261025-143205-폰-" + text.id.substring(0, 8)) && text.inboxName.endsWith(".txt"),
                "문장 인박스 이름: " + text.inboxName);
        check(new String(Files.readAllBytes(text.file.toPath()), StandardCharsets.UTF_8).equals("내일 3시 과학부 회의\n자료 챙기기\n"),
                "문장 원본은 앞뒤 공백만 정리해 UTF-8로 저장");
        check(text.sha256.equals(BlackholeOutbox.sha256(text.file)) && text.sha256.length() == 64, "sha256 기록");
        check("text/plain".equals(text.mime) && BlackholeOutbox.KIND_TEXT.equals(text.kind), "문장 형식");

        byte[] photoBytes = new byte[5000];
        new Random(7).nextBytes(photoBytes);
        BlackholeOutbox.Entry photo = outbox.addStream(new ByteArrayInputStream(photoBytes), BlackholeOutbox.KIND_PHOTO,
                BlackholeOutbox.SOURCE_SHARE, "IMG_2031.JPG", "image/jpeg", T0 + 1000);
        check(photo.inboxName.endsWith("-IMG_2031.jpg") && "jpg".equals(photo.ext), "사진 이름은 원래 이름 유지, 확장자 소문자: " + photo.inboxName);
        BlackholeOutbox.Entry doc = outbox.addStream(new ByteArrayInputStream("hwp".getBytes()), BlackholeOutbox.KIND_FILE,
                BlackholeOutbox.SOURCE_SHARE, "../../가정통신문:10월*.hwp", "application/octet-stream", T0 + 2000);
        check(doc.inboxName.endsWith("-가정통신문_10월_.hwp"), "위험한 글자·경로를 지운 이름: " + doc.inboxName);
        BlackholeOutbox.Entry noName = outbox.addStream(new ByteArrayInputStream("x".getBytes()), BlackholeOutbox.KIND_FILE,
                BlackholeOutbox.SOURCE_SHARE, "", "application/pdf", T0 + 3000);
        check(noName.inboxName.matches("20261025-143208-폰-[0-9a-f]{8}\\.pdf"), "이름이 없으면 MIME으로 확장자: " + noName.inboxName);
        check("wav".equals(BlackholeOutbox.extensionFor("", "audio/x-wav")) && "bin".equals(BlackholeOutbox.extensionFor("a.", "weird/x")),
                "확장자 추정");

        check(throwsIo(() -> outbox.addText("   ", BlackholeOutbox.SOURCE_CHAT, T0)), "빈 문장은 거절");
        check(throwsIo(() -> outbox.addStream(new ByteArrayInputStream(new byte[0]), BlackholeOutbox.KIND_FILE,
                BlackholeOutbox.SOURCE_SHARE, "a.txt", "text/plain", T0)), "빈 파일은 거절");

        List<BlackholeOutbox.Entry> pending = outbox.pending();
        check(pending.size() == 4 && pending.get(0).id.equals(text.id) && pending.get(3).id.equals(noName.id), "대기열은 오래된 것부터");
        outbox.markUploaded(photo.id, "drive-1", T0 + 9000);
        outbox.markFailed(doc.id, "HTTP 500");
        BlackholeOutbox reopened = new BlackholeOutbox(dir, SEOUL);
        check(reopened.pending().size() == 3, "올린 것은 대기열에서 빠지고, 다시 열어도 유지");
        BlackholeOutbox.Entry docAgain = reopened.get(doc.id);
        check(BlackholeOutbox.STATE_FAILED.equals(docAgain.state) && docAgain.attempts == 1 && "HTTP 500".equals(docAgain.lastError),
                "실패 기록 유지(다시 시도 대상)");
        check(reopened.get(photo.id).uploaded() && photo.file.isFile(), "올린 뒤에도 휴대폰 원본은 지우지 않음");
        outbox.markFailed(photo.id, "늦게 온 실패");
        check(reopened.get(photo.id).uploaded(), "이미 올린 항목은 실패로 되돌리지 않음");
        check(reopened.recent(2).size() == 2 && reopened.recent(2).get(1).id.equals(noName.id), "최근 목록은 마지막 n개");
        check("내일 3시 과학부 회의\n자료 챙기기".equals(reopened.readText(reopened.get(text.id), 400)), "대화 화면 미리보기");

        File orphan = new File(dir, "deadbeef.part");
        try (FileOutputStream out = new FileOutputStream(orphan)) { out.write(1); }
        check(reopened.pending().size() == 3, "복사 도중 남은 .part는 항목이 아님");

        check(BlackholeOutbox.acceptsSharedUri("content", "com.android.providers.media.documents"), "다른 앱 content:// 공유 허용");
        check(!BlackholeOutbox.acceptsSharedUri("file", ""), "file:// 공유 거절(앱 내부 파일 유출 방지)");
        check(!BlackholeOutbox.acceptsSharedUri("content", "com.malhaedwo.pttprobe.blackhole.capture"), "이 앱 자신의 제공자 주소 거절");
        check(!BlackholeOutbox.acceptsSharedUri("content", null), "주인 없는 주소 거절");
    }

    // ---------------------------------------------------------------- 가짜 드라이브 업로드

    private static final class Tokens implements BlackholeUploader.TokenSource {
        String current;
        int invalidated;
        String afterInvalidate = "good";
        Tokens(String first) { current = first; }
        @Override public String token() { return current; }
        @Override public void invalidate() { invalidated++; current = afterInvalidate; }
    }

    private static final class Cache implements BlackholeUploader.FolderCache {
        final Map<String,String> values = new HashMap<>();
        @Override public String get(String key) { return values.getOrDefault(key, ""); }
        @Override public void put(String key, String value) { values.put(key, value); }
    }

    private static void upload() throws Exception {
        try (FakeDrive drive = new FakeDrive()) {
            DriveTransfer transfer = new DriveTransfer(drive.filesUrl(), drive.uploadUrl(), 256 * 1024);
            File dir = Files.createTempDirectory("bh-upload").toFile();
            BlackholeOutbox outbox = new BlackholeOutbox(dir, SEOUL);
            BlackholeOutbox.Entry text = outbox.addText("금요일까지 수행평가 채점", BlackholeOutbox.SOURCE_LOCK, T0);
            byte[] big = new byte[600 * 1024 + 17];
            new Random(3).nextBytes(big);
            BlackholeOutbox.Entry photo = outbox.addStream(new ByteArrayInputStream(big), BlackholeOutbox.KIND_PHOTO,
                    BlackholeOutbox.SOURCE_CHAT, "", "image/jpeg", T0 + 1);
            BlackholeOutbox.Entry voice = outbox.addStream(new ByteArrayInputStream(new byte[]{'R', 'I', 'F', 'F', 1, 2, 3}),
                    BlackholeOutbox.KIND_VOICE, BlackholeOutbox.SOURCE_LOCK, "", "audio/wav", T0 + 2);
            Cache cache = new Cache();
            Tokens tokens = new Tokens("good");
            BlackholeUploader uploader = new BlackholeUploader(outbox, transfer, tokens, cache, () -> T0 + 60_000);

            BlackholeUploader.Report report = uploader.run();
            check(report.uploaded == 3 && report.failed == 0, "세 항목 업로드: " + report.message());
            List<FakeDrive.FileRecord> roots = drive.children("root");
            check(roots.size() == 1 && "블랙홀".equals(roots.get(0).name), "내 드라이브 맨 위에 「블랙홀」 하나");
            List<FakeDrive.FileRecord> inboxes = drive.children(roots.get(0).id);
            check(inboxes.size() == 1 && "인박스".equals(inboxes.get(0).name), "「블랙홀」 안에 「인박스」 하나");
            String inboxId = inboxes.get(0).id;
            check(inboxId.equals(cache.get(BlackholeUploader.CACHE_INBOX)), "인박스 폴더 ID 캐시");
            List<FakeDrive.FileRecord> uploaded = drive.children(inboxId);
            check(uploaded.size() == 3, "인박스에 세 파일");
            FakeDrive.FileRecord photoOnDrive = find(uploaded, photo.inboxName);
            check(photoOnDrive != null && Arrays.equals(photoOnDrive.content, big), "큰 사진은 여러 조각(308)으로 올라가 바이트가 같음");
            check("image/jpeg".equals(photoOnDrive.mime) && photo.id.equals(photoOnDrive.props.get("blackholeId"))
                    && photo.sha256.equals(photoOnDrive.props.get("sha256")) && "CHAT".equals(photoOnDrive.props.get("blackholeSource")),
                    "MIME·appProperties(blackholeId·sha256·출처)");
            FakeDrive.FileRecord textOnDrive = find(uploaded, text.inboxName);
            check(textOnDrive != null && new String(textOnDrive.content, StandardCharsets.UTF_8).equals("금요일까지 수행평가 채점\n")
                    && "text/plain".equals(textOnDrive.mime), "문장은 .txt 원본 그대로");
            check(find(uploaded, voice.inboxName) != null && voice.inboxName.endsWith(".wav"), "음성은 .wav");
            check(outbox.pending().isEmpty() && photoOnDrive.id.equals(outbox.get(photo.id).driveFileId), "보낸 기록에 드라이브 ID");

            int before = drive.log.size();
            check(uploader.run().uploaded == 0 && drive.log.size() == before, "보낼 것이 없으면 드라이브에 묻지도 않음");

            // 올린 뒤 기록하기 전에 앱이 꺼진 경우: 다시 돌면 찾아서 재사용, 두 번 올리지 않음.
            BlackholeOutbox.Entry again = outbox.addText("중복 시험", BlackholeOutbox.SOURCE_CHAT, T0 + 3);
            report = uploader.run();
            check(report.uploaded == 1, "새 항목 하나 업로드");
            setState(dir, again.id, "PENDING");
            int startedBefore = drive.uploadsStarted;
            report = uploader.run();
            check(report.reused == 1 && report.uploaded == 0 && drive.uploadsStarted == startedBefore, "같은 blackholeId·sha256이 있으면 재사용");

            // 조각 업로드 중 503: 받은 위치를 물어 이어서 올린다.
            BlackholeOutbox.Entry flaky = outbox.addStream(new ByteArrayInputStream(big), BlackholeOutbox.KIND_FILE,
                    BlackholeOutbox.SOURCE_SHARE, "big.pdf", "application/pdf", T0 + 4);
            drive.failNextChunks = 1;
            report = uploader.run();
            FakeDrive.FileRecord flakyOnDrive = find(drive.children(inboxId), flaky.inboxName);
            check(report.uploaded == 1 && flakyOnDrive != null && Arrays.equals(flakyOnDrive.content, big), "503 뒤 이어 올리기");

            // 토큰 만료(401): 한 번 버리고 새 토큰으로.
            outbox.addText("토큰 시험", BlackholeOutbox.SOURCE_CHAT, T0 + 5);
            tokens.current = "expired";
            report = uploader.run();
            check(report.uploaded == 1 && tokens.invalidated == 1, "401이면 토큰을 새로 받아 다시 시도");

            // 인박스 폴더가 휴지통에 감: 캐시를 버리고 다시 만든다(블랙홀 폴더는 그대로 재사용).
            drive.files.get(inboxId).trashed = true;
            outbox.addText("폴더 지워짐 시험", BlackholeOutbox.SOURCE_CHAT, T0 + 6);
            report = uploader.run();
            String newInbox = cache.get(BlackholeUploader.CACHE_INBOX);
            check(report.uploaded == 1 && !newInbox.equals(inboxId) && drive.children("root").size() == 1,
                    "인박스가 없어지면 다시 만들고, 「블랙홀」은 하나뿐");

            // 캐시가 비어도(앱 데이터 새로 시작) 기존 폴더를 찾아 쓴다.
            Cache fresh = new Cache();
            BlackholeOutbox.Entry later = outbox.addText("캐시 없음", BlackholeOutbox.SOURCE_CHAT, T0 + 7);
            new BlackholeUploader(outbox, transfer, new Tokens("good"), fresh, () -> T0).run();
            check(newInbox.equals(fresh.get(BlackholeUploader.CACHE_INBOX)) && drive.children("root").size() == 1
                    && find(drive.children(newInbox), later.inboxName) != null, "캐시가 없어도 기존 폴더를 찾아 씀(중복 폴더 없음)");

            // 계속 실패: 그 항목만 실패로 남기고 보고.
            drive.failSessionCreate = true;
            BlackholeOutbox.Entry stuck = outbox.addText("계속 실패", BlackholeOutbox.SOURCE_CHAT, T0 + 8);
            report = uploader.run();
            check(report.failed == 1 && report.message().contains("실패 1") && BlackholeOutbox.STATE_FAILED.equals(outbox.get(stuck.id).state),
                    "서버 오류는 실패로 기록해 다음에 다시");
            drive.failSessionCreate = false;
            check(uploader.run().uploaded == 1 && outbox.pending().isEmpty(), "다음 실행에서 성공");

            // 휴대폰에 둔 원본이 바뀌면 올리지 않는다.
            BlackholeOutbox.Entry tampered = outbox.addText("원본", BlackholeOutbox.SOURCE_CHAT, T0 + 9);
            Files.write(tampered.file.toPath(), "바뀐 내용".getBytes(StandardCharsets.UTF_8));
            int started = drive.uploadsStarted;
            report = uploader.run();
            check(report.failed == 1 && drive.uploadsStarted == started, "sha256이 다르면 올리지 않음");
        }
    }

    /** 기존 WAV 원본 업로드가 DriveTransfer로 옮겨진 뒤에도 같은 질의를 보내는지. */
    private static void legacyWavQueries() throws Exception {
        try (FakeDrive drive = new FakeDrive()) {
            DriveTransfer transfer = new DriveTransfer(drive.filesUrl(), drive.uploadUrl(), 256 * 1024);
            Map<String,String> owner = new LinkedHashMap<>();
            owner.put("owner", "malhaedwo");
            String folder = transfer.findOrCreateFolder("good", "말해둬 원본 음성", null, owner);
            check("mimeType='application/vnd.google-apps.folder' and name='말해둬 원본 음성' and trashed=false".equals(drive.queries.get(0)),
                    "WAV 폴더 찾기 질의가 예전과 같음");
            check("{\"name\":\"말해둬 원본 음성\",\"mimeType\":\"application/vnd.google-apps.folder\",\"appProperties\":{\"owner\":\"malhaedwo\"}}"
                    .equals(drive.createdFolderBodies.get(0)), "WAV 폴더 만들기 본문이 예전과 같음(위치 없음)");
            check(folder.equals(transfer.findOrCreateFolder("good", "말해둬 원본 음성", null, owner)) && drive.createdFolderBodies.size() == 1,
                    "두 번째는 찾아서 재사용");
            Map<String,String> props = new LinkedHashMap<>();
            props.put("malhaedwoItemId", "item-1");
            props.put("sha256", "abc");
            check(transfer.findChild("good", folder, props).isEmpty(), "없는 원본은 빈 ID");
            check(("'" + folder + "' in parents and trashed=false and appProperties has { key='malhaedwoItemId' and value='item-1' }"
                    + " and appProperties has { key='sha256' and value='abc' }").equals(drive.queries.get(drive.queries.size() - 1)),
                    "WAV 기존 원본 찾기 질의가 예전과 같음");
            File wav = Files.createTempFile("ptt", ".wav").toFile();
            Files.write(wav.toPath(), new byte[]{'R', 'I', 'F', 'F'});
            String id = transfer.resumableUpload("good", wav, wav.getName(), "audio/wav", folder, props, "WAV");
            check(id.equals(transfer.findChild("good", folder, props)) && "audio/wav".equals(drive.files.get(id).mime), "WAV 업로드 후 찾기");
            try {
                drive.failSessionCreate = true;
                transfer.resumableUpload("good", wav, wav.getName(), "audio/wav", folder, props, "WAV");
                check(false, "실패해야 함");
            } catch (DriveTransfer.HttpFailure failure) {
                check(failure.code == 500 && failure.getMessage().startsWith("Drive 업로드 세션 만들기 실패 (HTTP 500)"), "오류 문장 유지");
            }
            check("'x\\'y'".equals(DriveTransfer.queryLiteral("x'y")) && DriveTransfer.nextOffset("bytes=0-262143") == 262144
                    && DriveTransfer.nextOffset(null) == -1, "질의 따옴표·Range 해석");
        }
    }

    // ---------------------------------------------------------------- 알람 장부

    // ---------------------------------------------------------------- 블랙홀 달력(Mac 사본)

    private static void calendar() throws Exception {
        String shared = "{\"kind\":\"blackhole-calendar\",\"schemaVersion\":1,\"exportedAt\":\"2026-10-25T14:00\",\"events\":[],\"tasks\":[],\"periods\":[],\"notes\":[],\"appliedActions\":[\"a1\"]}";
        check(BlackholeCalendarStore.isShared(shared), "Mac 사본 형식 확인");
        check(!BlackholeCalendarStore.isShared("{}") && !BlackholeCalendarStore.isShared("") && !BlackholeCalendarStore.isShared("{\"kind\":\"x\"}"),
                "빈 파일·다른 형식은 사본이 아님");
        String pending = BlackholeCalendarStore.addPending("[]", "{\"id\":\"a1\",\"type\":\"confirm\",\"ref\":\"e-1\"}");
        pending = BlackholeCalendarStore.addPending(pending, "{\"id\":\"a2\",\"type\":\"toggleTask\",\"ref\":\"t-1\"}");
        pending = BlackholeCalendarStore.addPending(pending, "{\"id\":\"a2\",\"type\":\"toggleTask\",\"ref\":\"t-1\"}");
        check(new org.json.JSONArray(pending).length() == 2, "같은 동작은 한 번만 대기");
        check(throwsAny(() -> BlackholeCalendarStore.addPending("[]", "{\"type\":\"x\"}")), "id 없는 동작은 거절");
        String left = BlackholeCalendarStore.prune(pending, shared);
        check(new org.json.JSONArray(left).length() == 1 && left.contains("a2"), "Mac이 반영한 동작(a1)은 대기에서 빠짐");

        String alarms = "[{\"key\":\"e-1@2026-10-25T15:00\",\"atMs\":" + (T0 + 3_600_000) + ",\"title\":\"안과 진료\"},"
                + "{\"key\":\"t-1@old\",\"atMs\":" + (T0 - 1) + ",\"title\":\"지난 것\"},{\"bad\":1}]";
        List<BlackholeCalendarStore.CalendarAlarm> list = BlackholeCalendarStore.alarms(alarms, T0);
        check(list.size() == 1 && "안과 진료".equals(list.get(0).title) && list.get(0).at == T0 + 3_600_000, "앞으로 울릴 알림만 전화식 알람으로");
        check(list.get(0).id.equals(BlackholeCalendarStore.alarmId("e-1@2026-10-25T15:00")) && list.get(0).id.startsWith("cal-")
                && list.get(0).id.length() == 20, "같은 알림은 늘 같은 알람 id");
        check(BlackholeCalendarStore.ids("cal-1,x,cal-2").equals(Arrays.asList("cal-1", "cal-2")), "알람 id 목록");
        String keys = BlackholeCalendarStore.keys(list);
        String back = BlackholeCalendarStore.alarmAction(keys, list.get(0).id, "done", "x1", "2026-10-25T15:00");
        check(back != null && back.contains("\"ref\":\"e-1\"") && back.contains("\"answer\":\"done\"") && back.contains("\"type\":\"alarm\""),
                "휴대폰 알람의 「완료」를 Mac에 보낼 동작으로: " + back);
        check(BlackholeCalendarStore.alarmAction(keys, "cal-unknown", "done", "x2", "t") == null
                && BlackholeCalendarStore.alarmAction("{}", list.get(0).id, "ack", "x3", "t") == null, "달력 알람이 아니면 보내지 않음");

        try (FakeDrive drive = new FakeDrive()) {
            DriveTransfer transfer = new DriveTransfer(drive.filesUrl(), drive.uploadUrl(), 256 * 1024);
            Cache cache = new Cache();
            Tokens tokens = new Tokens("good");
            BlackholeUploader uploader = new BlackholeUploader(new BlackholeOutbox(Files.createTempDirectory("bh-cal").toFile(), SEOUL),
                    transfer, tokens, cache, () -> T0);
            File scratch = Files.createTempDirectory("bh-cal-scratch").toFile();
            BlackholeCalendarSync sync = new BlackholeCalendarSync(uploader, transfer, tokens, cache, scratch);
            check("{}".equals(sync.fetch()), "처음엔 휴대폰이 빈 「달력.json」을 만들고 그 내용을 받음");
            String root = drive.children("root").get(0).id;
            List<FakeDrive.FileRecord> made = new java.util.ArrayList<>();
            for (FakeDrive.FileRecord f : drive.children(root)) if ("달력.json".equals(f.name)) made.add(f);
            check(made.size() == 1 && "calendar-shared".equals(made.get(0).props.get("blackholeKind")), "「블랙홀」 맨 위에 달력.json 하나, 표시 붙임");
            // Mac(드라이브 앱)이 같은 파일에 덮어씀.
            made.get(0).content = shared.getBytes(StandardCharsets.UTF_8);
            check(shared.equals(sync.fetch()), "Mac이 덮어쓴 사본을 받음");
            BlackholeCalendarSync again = new BlackholeCalendarSync(uploader, transfer, tokens, new Cache(), scratch);
            again.fetch();
            int count = 0;
            for (FakeDrive.FileRecord f : drive.children(root)) if ("달력.json".equals(f.name)) count++;
            check(count == 1, "캐시가 없어도 표시로 찾아 두 번 만들지 않음");
            drive.validToken = "fresh";
            tokens.afterInvalidate = "fresh";
            check(shared.equals(sync.fetch()), "토큰이 만료되면 새로 받아 다시 시도");
        }
    }

    // ---------------------------------------------------------------- 4단계 가승인 캘린더 계산

    private static void mirror() {
        String shared = "{\"kind\":\"blackhole-calendar\",\"schemaVersion\":1,\"events\":["
                + "{\"id\":\"e-1\",\"title\":\"학부모 상담\",\"date\":\"2026-10-26\",\"start\":\"15:00\",\"end\":\"16:00\",\"provisional\":true},"
                + "{\"id\":\"e-2\",\"title\":\"운동회\",\"date\":\"2026-10-27\",\"start\":null,\"end\":null,\"provisional\":false},"
                + "{\"id\":\"e-3\",\"title\":\"취소된 것\",\"date\":\"2026-10-27\",\"start\":\"09:00\",\"end\":\"10:00\",\"provisional\":false,\"gone\":true},"
                + "{\"id\":\"e-4\",\"title\":\"날짜 틀림\",\"date\":\"10월\",\"start\":\"09:00\"}],"
                + "\"tasks\":[],\"periods\":[{\"id\":\"p-1\",\"title\":\"상담 주간\",\"from\":\"2026-11-03\",\"to\":\"2026-11-06\"}],\"notes\":[]}";
        List<BlackholeCalendarMirror.Want> wanted = BlackholeCalendarMirror.wanted(shared, SEOUL);
        check(wanted.size() == 3, "취소·형식 틀린 일정은 빼고 일정 2 + 기간 1");
        BlackholeCalendarMirror.Want e1 = wanted.get(0);
        check(e1.provisional && !e1.allDay && e1.start == ZonedDateTime.of(2026, 10, 26, 15, 0, 0, 0, SEOUL).toInstant().toEpochMilli()
                && e1.end - e1.start == 3_600_000L, "시각 일정은 이 기기 시간대로");
        BlackholeCalendarMirror.Want e2 = wanted.get(1);
        check(e2.allDay && e2.end - e2.start == 86_400_000L && e2.start % 86_400_000L == 0, "종일 일정은 UTC 자정 하루");
        BlackholeCalendarMirror.Want p1 = wanted.get(2);
        check(p1.allDay && p1.end - p1.start == 4 * 86_400_000L, "기간 11/3–11/6은 종일 4일");

        Map<String,BlackholeCalendarMirror.Placed> placed = new LinkedHashMap<>();
        check(BlackholeCalendarMirror.plan(wanted, placed, 7, 7).isEmpty() && BlackholeCalendarMirror.plan(wanted, placed, -1, 9).isEmpty(),
                "두 캘린더가 같거나 정하지 않았으면 아무것도 안 씀");
        List<BlackholeCalendarMirror.Op> first = BlackholeCalendarMirror.plan(wanted, placed, 7, 9);
        check(first.size() == 3 && first.get(0).kind == BlackholeCalendarMirror.Kind.INSERT && first.get(0).calendarId == 7
                && first.get(1).calendarId == 9 && first.get(2).calendarId == 9, "가승인 → 가승인 캘린더(7), 확정·기간 → 본 캘린더(9)");
        long eventId = 100;
        for (BlackholeCalendarMirror.Op op : first) {
            BlackholeCalendarMirror.Placed p = new BlackholeCalendarMirror.Placed();
            p.entryId = op.want.entryId; p.calendarId = op.calendarId; p.eventId = eventId++; p.hash = op.want.hash;
            placed.put(p.entryId, p);
        }
        placed = BlackholeCalendarMirror.parsePlaced(BlackholeCalendarMirror.placedJson(placed));
        check(placed.size() == 3 && placed.get("e-1").eventId == 100, "장부 저장·읽기");
        check(BlackholeCalendarMirror.plan(wanted, placed, 7, 9).isEmpty(), "바뀐 게 없으면 아무것도 안 함");

        // 확정: 가승인 캘린더에서 지우고 본 캘린더에 넣는다. 기간은 사라지면 지운다.
        String confirmed = shared.replace("\"provisional\":true", "\"provisional\":false").replace(",\"periods\":[{\"id\":\"p-1\",\"title\":\"상담 주간\",\"from\":\"2026-11-03\",\"to\":\"2026-11-06\"}]", ",\"periods\":[]");
        List<BlackholeCalendarMirror.Op> next = BlackholeCalendarMirror.plan(BlackholeCalendarMirror.wanted(confirmed, SEOUL), placed, 7, 9);
        check(next.size() == 3 && next.get(0).kind == BlackholeCalendarMirror.Kind.DELETE && next.get(0).calendarId == 7
                && next.get(1).kind == BlackholeCalendarMirror.Kind.INSERT && next.get(1).calendarId == 9
                && next.get(2).kind == BlackholeCalendarMirror.Kind.DELETE && "p-1".equals(next.get(2).placed.entryId),
                "확정하면 가승인 캘린더 → 본 캘린더로 옮기고, 없어진 기간은 지움");
        String moved = shared.replace("\"start\":\"15:00\"", "\"start\":\"15:30\"");
        List<BlackholeCalendarMirror.Op> upd = BlackholeCalendarMirror.plan(BlackholeCalendarMirror.wanted(moved, SEOUL), placed, 7, 9);
        check(upd.size() == 1 && upd.get(0).kind == BlackholeCalendarMirror.Kind.UPDATE, "시각이 바뀌면 그 일정만 고침");
        check(BlackholeCalendarMirror.marker("e-1").equals("blackhole://calendar/e-1"), "앱이 만든 일정 표시");
    }

    // ---------------------------------------------------------------- 5단계 위젯·잠금화면 내용

    private static void board() {
        String shared = "{\"kind\":\"blackhole-calendar\",\"schemaVersion\":1,\"events\":["
                + "{\"id\":\"e-1\",\"title\":\"민수 어머니 상담\",\"area\":\"school\",\"date\":\"2026-10-25\",\"start\":\"15:30\",\"end\":\"16:00\",\"provisional\":true},"
                + "{\"id\":\"e-2\",\"title\":\"가족 저녁\",\"area\":\"personal\",\"date\":\"2026-10-25\",\"start\":\"09:00\",\"end\":\"10:00\"},"
                + "{\"id\":\"e-3\",\"title\":\"내일 것\",\"area\":\"personal\",\"date\":\"2026-10-26\",\"start\":\"09:00\",\"end\":\"10:00\"},"
                + "{\"id\":\"e-4\",\"title\":\"취소\",\"area\":\"personal\",\"date\":\"2026-10-25\",\"start\":\"11:00\",\"gone\":true}],"
                + "\"tasks\":[{\"id\":\"t-1\",\"title\":\"보고서\",\"area\":\"school\",\"due\":\"2026-10-27\",\"done\":false,\"subs\":[{\"title\":\"a\",\"done\":true},{\"title\":\"b\",\"done\":false}]},"
                + "{\"id\":\"t-2\",\"title\":\"관리비\",\"area\":\"personal\",\"due\":\"2026-10-24\",\"done\":false},"
                + "{\"id\":\"t-3\",\"title\":\"먼 것\",\"area\":\"personal\",\"due\":\"2026-12-01\",\"done\":false}],"
                + "\"periods\":[{\"id\":\"p-1\",\"title\":\"채점 기간\",\"area\":\"school\",\"from\":\"2026-10-19\",\"to\":\"2026-10-30\"}],\"notes\":[]}";
        java.time.LocalDate day = java.time.LocalDate.of(2026, 10, 25);
        BlackholeBoard.Board b = BlackholeBoard.build(shared, day, java.time.LocalTime.of(14, 0), false);
        check("10월 25일 일요일".equals(b.date), "날짜 머리: " + b.date);
        check(b.events.size() == 2 && "09:00".equals(b.events.get(0).time) && b.events.get(0).past && b.events.get(1).provisional,
                "오늘 일정만 시각 순, 지난 것 표시, 가승인 표시");
        check(b.tasks.size() == 2 && "1일 지남".equals(b.tasks.get(0).badge) && "D-2".equals(b.tasks.get(1).badge)
                && b.tasks.get(1).text.endsWith(" 1/2"), "할 일은 마감 순(7일 안), 밀린 것·D-day·하위 진행");
        check(b.periods.size() == 1 && b.periods.get(0).endsWith("7/12일"), "진행 중 기간과 경과");
        BlackholeBoard.Board hidden = BlackholeBoard.build(shared, day, java.time.LocalTime.of(14, 0), true);
        check("학교 일정".equals(hidden.events.get(1).text) && hidden.tasks.get(1).text.startsWith("학교 할 일")
                && hidden.periods.get(0).startsWith("학교 기간") && "가족 저녁".equals(hidden.events.get(0).text),
                "학교 일정 제목 가리기: 학교 항목만 가림(학생 이름이 잠금화면에 안 보이게)");
        check(BlackholeBoard.build("", day, java.time.LocalTime.NOON, false).empty(), "사본이 없으면 빈 판");
    }

    private interface Body { void run() throws Exception; }

    private static boolean throwsAny(Body body) {
        try { body.run(); return false; } catch (Exception expected) { return true; }
    }

    private static void alarmBook() {
        BlackholeAlarmBook book = new BlackholeAlarmBook();
        book.schedule("a1", "4교시 실험 준비 | 비커\n챙기기", T0 + 3_600_000);
        book.schedule("a2", "", T0 + 60_000);
        BlackholeAlarmBook back = BlackholeAlarmBook.parse(book.serialize());
        check("4교시 실험 준비 | 비커\n챙기기".equals(back.get("a1").title) && back.get("a1").at == T0 + 3_600_000
                && BlackholeAlarmBook.SCHEDULED.equals(back.get("a1").state), "저장·복원(제목의 |·줄바꿈·한글)");
        check(BlackholeAlarmBook.parse("깨진 줄\n|1|x|y\na|NaN|SCHEDULED|t\n").all().isEmpty(), "깨진 줄은 무시");
        check(back.next(T0).id.equals("a2"), "다음 알람");

        check(back.startRinging("a2", T0 + 60_000) && BlackholeAlarmBook.RINGING.equals(back.get("a2").state), "울리기 시작");
        check(!back.startRinging("a2", T0 + 60_000), "이미 울리는 알람은 다시 시작 안 함");
        BlackholeAlarmBook.Alarm snoozed = back.snooze("a2", T0 + 70_000);
        check(snoozed.at == T0 + 70_000 + 10 * 60_000 && BlackholeAlarmBook.SNOOZED.equals(snoozed.state), "10분 뒤");
        check(back.startRinging("a2", snoozed.at), "미룬 알람은 다시 울림");
        back.acknowledge("a2");
        check(!back.startRinging("a2", T0 + 999_999), "확인한 알람이 늦게 와도 다시 울리지 않음");
        back.complete("a1");
        check(BlackholeAlarmBook.DONE.equals(back.get("a1").state) && !back.startRinging("a1", T0), "완료 기록, 다시 울리지 않음");

        BlackholeAlarmBook boot = new BlackholeAlarmBook();
        boot.schedule("future", "미래", T0 + 3_600_000);
        boot.schedule("late", "조금 늦음", T0 - 5 * 60_000);
        boot.schedule("old", "많이 늦음", T0 - 60 * 60_000);
        boot.schedule("ring", "울리다 꺼짐", T0 - 2 * 60_000);
        boot.startRinging("ring", T0 - 2 * 60_000);
        List<BlackholeAlarmBook.Alarm> again = boot.restore(T0);
        check(again.size() == 3 && again.get(0).id.equals("late") && again.get(2).id.equals("future"),
                "재부팅 뒤: 미래·조금 늦은·울리던 알람은 다시 걸기(시각 순)");
        check(BlackholeAlarmBook.MISSED.equals(boot.get("old").state), "10분 넘게 지난 알람은 놓친 알람");
        check(BlackholeAlarmBook.SNOOZED.equals(boot.get("ring").state), "울리던 알람은 다시 울릴 대기");

        int code = BlackholeAlarmBook.requestCode("a1");
        check(code == BlackholeAlarmBook.requestCode("a1") && (code & 0xFF000000) == 0x5B000000, "요청 번호는 고정·전용 띠");
        BlackholeAlarmBook many = new BlackholeAlarmBook();
        many.schedule("keep", "대기", T0 + 1);
        for (int i = 0; i < BlackholeAlarmBook.MAX_KEPT + 20; i++) {
            many.schedule("x" + i, "", T0);
            many.acknowledge("x" + i);
        }
        check(many.all().size() <= BlackholeAlarmBook.MAX_KEPT + 1 && many.get("keep") != null, "오래된 끝난 알람만 정리, 대기 알람은 유지");
    }

    // ---------------------------------------------------------------- 도우미

    private static FakeDrive.FileRecord find(List<FakeDrive.FileRecord> files, String name) {
        for (FakeDrive.FileRecord file : files) if (name.equals(file.name)) return file;
        return null;
    }

    private static void setState(File dir, String id, String state) throws Exception {
        File meta = new File(dir, id + ".meta");
        String text = new String(Files.readAllBytes(meta.toPath()), StandardCharsets.UTF_8);
        Files.write(meta.toPath(), text.replaceAll("(?m)^state=.*$", "state=" + state).getBytes(StandardCharsets.UTF_8));
    }

    private interface Io { void run() throws Exception; }

    private static boolean throwsIo(Io body) {
        try { body.run(); return false; }
        catch (java.io.IOException expected) { return true; }
        catch (Exception other) { return false; }
    }

    // ---------------------------------------------------------------- 휴대폰 초안 (2026-10-26)

    private static void drafts(String root) throws Exception {
        // 달력 화면(TS)과 같은 정답표: 규칙이 어긋나면 두 쪽 초안이 달라진다.
        org.json.JSONObject golden = new org.json.JSONObject(new String(Files.readAllBytes(
                new File(root, "desktop/tests/fixtures/rule-cases.json").toPath()), StandardCharsets.UTF_8));
        long ref = java.time.LocalDateTime.parse(golden.optString("referenceLocal")).atZone(SEOUL).toInstant().toEpochMilli();
        org.json.JSONArray cases = golden.optJSONArray("cases");
        int same = 0;
        for (int i = 0; i < cases.length(); i++) {
            org.json.JSONObject c = cases.optJSONObject(i);
            ParsedCommand p = KoreanCommandParser.parse(c.optString("text"), ref);
            String start = p.startAt == 0 ? "" : java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
                    .format(java.time.Instant.ofEpochMilli(p.startAt).atZone(SEOUL));
            if (p.kind.equals(c.optString("kind")) && p.title.equals(c.optString("title")) && start.equals(c.optString("start"))) same++;
        }
        check(same == cases.length(), "규칙 파서가 공용 정답표 " + cases.length() + "문장과 같음(달력 화면 TS와 같은 규칙)");

        long at = java.time.LocalDateTime.parse("2026-10-21T09:00").atZone(SEOUL).toInstant().toEpochMilli();
        org.json.JSONObject ev = BlackholeDrafts.fromText("내일 오후 3시에 학부모 상담", at, "job-0123456789abcdef", SEOUL);
        check("event".equals(ev.optString("kind")) && "2026-10-22".equals(ev.optString("date")) && "15:00".equals(ev.optString("start"))
                && "16:00".equals(ev.optString("end")) && ev.optBoolean("provisional", false) && ev.optBoolean("draft", false)
                && "job-0123456789abcdef".equals(ev.optString("srcKey")) && ev.optString("id").startsWith("e-d")
                && "2026-10-22T14:30".equals(ev.optJSONArray("reminders").optString(0, "")),
                "일정 초안: 가승인, 1시간, 30분 전 알림, 원본 작업 id로 연결");
        org.json.JSONObject task = BlackholeDrafts.fromText("금요일까지 보고서 제출", at, "job-b", SEOUL);
        check("task".equals(task.optString("kind")) && "2026-10-23".equals(task.optString("due")) && task.opt("dueTime") == org.json.JSONObject.NULL
                && "2026-10-23T09:00".equals(task.optJSONArray("reminders").optString(0, "")) && !task.has("noDue"),
                "할 일 초안: 날짜만 → 마감일, 시각 없음, 그날 09:00 알림");
        org.json.JSONObject memo = BlackholeDrafts.fromText("민수 연락처 기억해 줘", at, "job-c", SEOUL);
        check("task".equals(memo.optString("kind")) && memo.optBoolean("noDue", false) && memo.optJSONArray("reminders").length() == 0,
                "날짜 없는 말은 마감 없는 할 일(달력에는 안 나옴)");
        check(BlackholeDrafts.jobId("ABCDEF0123456789ffff").equals("job-abcdef0123456789"), "작업 id = Mac 작업기와 같은 규칙");

        String list = BlackholeDrafts.addAll("[]", ev.toString());
        list = BlackholeDrafts.addAll(list, "[" + task + "," + memo + "]");
        list = BlackholeDrafts.addAll(list, ev.toString());
        check(new org.json.JSONArray(list).length() == 3, "초안 보관: 같은 id는 한 번");
        String shared = "{\"kind\":\"blackhole-calendar\",\"schemaVersion\":1,\"events\":[],\"tasks\":[],\"periods\":[],\"notes\":[]}";
        String board = BlackholeDrafts.overlay(shared, list);
        check(new org.json.JSONObject(board).optJSONArray("events").length() == 1 && new org.json.JSONObject(board).optJSONArray("tasks").length() == 2,
                "위젯·잠금화면: Mac 사본 위에 휴대폰 초안을 얹음");
        String macHas = shared.replace("\"notes\":[]", "\"notes\":[],\"sources\":[\"job-0123456789abcdef\"]")
                .replace("\"tasks\":[]", "\"tasks\":[{\"id\":\"t-9\",\"kind\":\"task\",\"srcKey\":\"job-b\",\"due\":\"2026-10-23\"}]");
        String pruned = BlackholeDrafts.prune(list, macHas, at + 60_000L, SEOUL);
        check(new org.json.JSONArray(pruned).length() == 1 && pruned.contains("job-c"), "Mac 사본이 다룬 원본의 초안은 뺌(sources·srcKey)");
        check(new org.json.JSONArray(BlackholeDrafts.prune(list, shared, at + BlackholeDrafts.KEEP_MS + 120_000L, SEOUL)).length() == 0,
                "사흘 지난 초안은 정리");
        check(BlackholeDrafts.overlay(macHas, list).split("job-b", -1).length == 2, "Mac에 이미 있는 원본은 위젯에 두 번 나오지 않음");
    }

    private static void mirrorDeadlines() {
        String shared = "{\"kind\":\"blackhole-calendar\",\"schemaVersion\":1,\"events\":[],\"periods\":[],\"notes\":[],\"tasks\":["
                + "{\"id\":\"t-1\",\"title\":\"보고서 제출\",\"due\":\"2026-10-23\",\"dueTime\":\"18:00\",\"done\":false},"
                + "{\"id\":\"t-2\",\"title\":\"출석부\",\"due\":\"2026-10-24\",\"dueTime\":null,\"done\":false},"
                + "{\"id\":\"t-3\",\"title\":\"끝낸 것\",\"due\":\"2026-10-24\",\"dueTime\":null,\"done\":true},"
                + "{\"id\":\"t-4\",\"title\":\"마감 없음\",\"due\":\"2026-10-24\",\"dueTime\":null,\"done\":false,\"noDue\":true}]}";
        List<BlackholeCalendarMirror.Want> wanted = BlackholeCalendarMirror.wanted(shared, SEOUL);
        check(wanted.size() == 2, "구글 캘린더: 마감 있는 할 일만(끝낸 것·마감 없는 것 뺌)");
        BlackholeCalendarMirror.Want t1 = wanted.get(0);
        check("[마감] 보고서 제출".equals(t1.title) && !t1.allDay && !t1.provisional && t1.end - t1.start == 30 * 60_000L
                && t1.start == ZonedDateTime.of(2026, 10, 23, 18, 0, 0, 0, SEOUL).toInstant().toEpochMilli(), "시각 있는 마감: 그 시각 30분, 본 캘린더");
        check(wanted.get(1).allDay && "[마감] 출석부".equals(wanted.get(1).title), "시각 없는 마감: 그날 종일");
        List<BlackholeCalendarMirror.Op> ops = BlackholeCalendarMirror.plan(wanted, new LinkedHashMap<>(), 7, 9);
        check(ops.size() == 2 && ops.get(0).calendarId == 9 && ops.get(1).calendarId == 9, "마감은 본 캘린더(9)에");
    }

    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError("FAIL " + label);
        System.out.println("PASS " + label);
    }
}
