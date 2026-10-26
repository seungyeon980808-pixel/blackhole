package com.malhaedwo.pttprobe;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 보내기 대기열 → 드라이브 「블랙홀/인박스/」. 승인 DB·시트 동기화(GoogleSyncEngine)와 따로 돈다.
 * 같은 항목은 appProperties(blackholeId·sha256)로 찾아 두 번 올리지 않는다.
 */
final class BlackholeUploader {
    static final String ROOT_FOLDER = "블랙홀";
    static final String INBOX_FOLDER = "인박스";
    static final String CACHE_ROOT = "blackhole_root_folder_id";
    static final String CACHE_INBOX = "blackhole_inbox_folder_id";

    interface TokenSource {
        String token() throws Exception;
        void invalidate();
    }

    interface FolderCache {
        String get(String key);
        void put(String key, String value);
    }

    interface Clock { long now(); }

    static final class Report {
        int uploaded;
        int reused;
        int failed;
        String firstError = "";
        boolean hasFailures() { return failed > 0; }
        String message() {
            String text = "블랙홀 보냄 " + (uploaded + reused);
            if (failed > 0) text += " · 못 보낸 것 " + failed + " — " + firstError;
            return text;
        }
    }

    private final BlackholeOutbox outbox;
    private final DriveTransfer drive;
    private final TokenSource tokens;
    private final FolderCache cache;
    private final Clock clock;

    BlackholeUploader(BlackholeOutbox outbox, DriveTransfer drive, TokenSource tokens, FolderCache cache, Clock clock) {
        this.outbox = outbox;
        this.drive = drive;
        this.tokens = tokens;
        this.cache = cache;
        this.clock = clock;
    }

    Report run() throws Exception {
        Report report = new Report();
        List<BlackholeOutbox.Entry> pending = outbox.pending();
        if (pending.isEmpty()) return report;
        String token = tokens.token();
        String inbox;
        try {
            inbox = ensureInbox(token);
        } catch (DriveTransfer.HttpFailure failure) {
            if (failure.code != 401) throw failure;
            tokens.invalidate();
            token = tokens.token();
            inbox = ensureInbox(token);
        }
        for (BlackholeOutbox.Entry entry : pending) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException("업로드 작업이 중지되었습니다");
            boolean retried = false;
            while (true) {
                try {
                    upload(token, inbox, entry, report);
                    break;
                } catch (InterruptedException interrupted) {
                    throw interrupted;
                } catch (DriveTransfer.HttpFailure failure) {
                    if (!retried && failure.code == 401) {
                        tokens.invalidate();
                        token = tokens.token();
                        retried = true;
                        continue;
                    }
                    if (!retried && failure.code == 404) {
                        // 인박스 폴더가 지워졌거나 휴지통에 있음: 캐시를 버리고 다시 찾는다.
                        cache.put(CACHE_INBOX, "");
                        cache.put(CACHE_ROOT, "");
                        inbox = ensureInbox(token);
                        retried = true;
                        continue;
                    }
                    fail(entry, failure, report);
                    break;
                } catch (Exception error) {
                    fail(entry, error, report);
                    break;
                }
            }
        }
        return report;
    }

    private void upload(String token, String inbox, BlackholeOutbox.Entry entry, Report report) throws Exception {
        String actual = BlackholeOutbox.sha256(entry.file);
        if (!actual.equalsIgnoreCase(entry.sha256)) throw new Exception("보관된 원본이 바뀌어 올리지 않았습니다");
        Map<String,String> identity = new LinkedHashMap<>();
        identity.put("blackholeId", entry.id);
        identity.put("sha256", entry.sha256);
        String fileId = drive.findChild(token, inbox, identity);
        if (fileId.isEmpty()) {
            Map<String,String> properties = new LinkedHashMap<>(identity);
            properties.put("blackholeSource", entry.source);
            properties.put("blackholeKind", entry.kind);
            fileId = drive.resumableUpload(token, entry.file, entry.inboxName, entry.mime, inbox, properties, "블랙홀");
            report.uploaded++;
        } else {
            report.reused++;
        }
        outbox.markUploaded(entry.id, fileId, clock.now());
    }

    /**
     * 실패를 「원인 · 할 일」 한국어 한 줄로. 인터넷·드라이브 잠시 문제는 저절로 다시 하므로 기다리라고만,
     * Google 연결이 끊긴 것·저장 공간처럼 사람이 해야 하는 것은 할 일을 적는다. 모르는 오류는 끝에 짧게 붙인다.
     */
    static String explain(Throwable error, String retryWord) {
        String raw = error == null || error.getMessage() == null ? (error == null ? "" : error.getClass().getSimpleName()) : error.getMessage();
        for (Throwable t = error; t != null; t = t.getCause()) {
            if (t instanceof java.net.UnknownHostException || t instanceof java.net.ConnectException
                    || t instanceof java.net.SocketTimeoutException || t instanceof java.net.NoRouteToHostException
                    || t instanceof javax.net.ssl.SSLException || t instanceof java.net.SocketException) {
                return "인터넷 연결 없음 · 연결되면 자동으로 " + retryWord;
            }
        }
        if (raw.contains("Google 연결이 필요") || raw.contains("허용된 Google 계정") || raw.contains("invalid_grant")
                || raw.contains("Google 연결 갱신 실패") || raw.contains("연결 권한을 받지 못")) {
            return "Google 연결이 끊김 · 블랙홀 첫 화면에서 「Google 연결」을 다시 눌러 주세요";
        }
        if (error instanceof DriveTransfer.HttpFailure) {
            int code = ((DriveTransfer.HttpFailure) error).code;
            if (code == 401) return "Google 연결이 끊김 · 블랙홀 첫 화면에서 「Google 연결」을 다시 눌러 주세요";
            if (code == 403 && raw.contains("storageQuotaExceeded")) return "구글 드라이브 저장 공간이 가득 참 · 공간을 비우면 자동으로 " + retryWord;
            if (code == 403) return "드라이브가 이 앱의 접근을 막음 · Google 연결을 다시 해 주세요";
            if (code == 429 || code >= 500 || code == 408) return "구글 드라이브가 잠시 응답하지 않음 · 잠시 뒤 자동으로 " + retryWord;
        }
        if (raw.contains("「블랙홀」 폴더를 찾지 못")) return "드라이브에 「블랙홀」 폴더가 없음 · Mac 블랙홀에서 휴대폰 공유를 켜 주세요";
        String detail = raw.length() > 60 ? raw.substring(0, 60) + "…" : raw;
        return "드라이브에 올리지 못함 · 잠시 뒤 자동으로 " + retryWord + (detail.isEmpty() ? "" : " (" + detail + ")");
    }

    private void fail(BlackholeOutbox.Entry entry, Exception error, Report report) {
        String message = explain(error, "다시 보냅니다");
        try { outbox.markFailed(entry.id, message); } catch (Exception ignored) {}
        if (report.firstError.isEmpty()) report.firstError = message;
        report.failed++;
    }

    /** 내 드라이브 맨 위 「블랙홀」 → 그 안 「인박스」. 없으면 만든다. 찾은 ID는 캐시하되, 쓰기 전 한 번 확인한다. */
    String ensureInbox(String token) throws Exception {
        String cached = cache.get(CACHE_INBOX);
        if (cached != null && !cached.isEmpty() && drive.exists(token, cached)) return cached;
        Map<String,String> marker = new LinkedHashMap<>();
        marker.put("owner", "blackhole");
        String root = cache.get(CACHE_ROOT);
        if (root == null || root.isEmpty() || !drive.exists(token, root)) {
            root = drive.findOrCreateFolder(token, ROOT_FOLDER, "root", marker);
            cache.put(CACHE_ROOT, root);
        }
        String inbox = drive.findOrCreateFolder(token, INBOX_FOLDER, root, marker);
        cache.put(CACHE_INBOX, inbox);
        return inbox;
    }
}
