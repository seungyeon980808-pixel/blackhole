package com.malhaedwo.pttprobe;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Mac의 달력 사본 받기. 휴대폰 권한(drive.file)은 휴대폰이 만든 파일만 보므로,
 * 「블랙홀/달력.json」을 휴대폰이 빈 파일 「{}」로 먼저 만들고 Mac 블랙홀 앱이 그 파일에 덮어쓴다.
 * 여기서는 그 파일을 찾거나 만들고, 내용을 받아 온다. 휴대폰은 이 파일에 쓰지 않는다.
 */
final class BlackholeCalendarSync {
    static final String SHARED_NAME = "달력.json";
    static final String CACHE_SHARED = "blackhole_calendar_file_id";
    static final String KIND_PROPERTY = "blackholeKind";
    static final String KIND_VALUE = "calendar-shared";

    private final BlackholeUploader uploader;
    private final DriveTransfer drive;
    private final BlackholeUploader.TokenSource tokens;
    private final BlackholeUploader.FolderCache cache;
    private final File scratch;

    BlackholeCalendarSync(BlackholeUploader uploader, DriveTransfer drive, BlackholeUploader.TokenSource tokens,
                          BlackholeUploader.FolderCache cache, File scratch) {
        this.uploader = uploader;
        this.drive = drive;
        this.tokens = tokens;
        this.cache = cache;
        this.scratch = scratch;
    }

    /** 사본 내용(아직 Mac이 안 썼으면 「{}」). 토큰이 만료됐으면 한 번 새로 받아 다시 한다. */
    String fetch() throws Exception {
        String token = tokens.token();
        try {
            return fetch(token);
        } catch (DriveTransfer.HttpFailure failure) {
            if (failure.code != 401 && failure.code != 404) throw failure;
            if (failure.code == 401) {
                tokens.invalidate();
                token = tokens.token();
            } else {
                cache.put(CACHE_SHARED, "");
            }
            return fetch(token);
        }
    }

    private String fetch(String token) throws Exception {
        return drive.downloadText(token, ensureSharedFile(token));
    }

    /** 「블랙홀」 폴더 맨 위의 「달력.json」(휴대폰이 만든 것). 없으면 빈 파일로 만든다. */
    String ensureSharedFile(String token) throws Exception {
        String cached = cache.get(CACHE_SHARED);
        if (cached != null && !cached.isEmpty() && drive.exists(token, cached)) return cached;
        uploader.ensureInbox(token);
        String root = cache.get(BlackholeUploader.CACHE_ROOT);
        if (root == null || root.isEmpty() || !drive.exists(token, root)) {
            root = drive.findFolder(token, BlackholeUploader.ROOT_FOLDER, "root");
            if (root.isEmpty()) throw new Exception("드라이브 「블랙홀」 폴더를 찾지 못했습니다");
            cache.put(BlackholeUploader.CACHE_ROOT, root);
        }
        Map<String,String> marker = new LinkedHashMap<>();
        marker.put(KIND_PROPERTY, KIND_VALUE);
        String id = drive.findChild(token, root, marker);
        if (id.isEmpty()) {
            //noinspection ResultOfMethodCallIgnored
            scratch.mkdirs();
            File empty = new File(scratch, "calendar-empty.json");
            Files.write(empty.toPath(), "{}".getBytes(StandardCharsets.UTF_8));
            id = drive.resumableUpload(token, empty, SHARED_NAME, "application/json", root, marker, "달력 사본");
            //noinspection ResultOfMethodCallIgnored
            empty.delete();
        }
        cache.put(CACHE_SHARED, id);
        return id;
    }
}
