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
            if (failed > 0) text += " · 실패 " + failed + " (" + firstError + ")";
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

    private void fail(BlackholeOutbox.Entry entry, Exception error, Report report) {
        String message = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
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
