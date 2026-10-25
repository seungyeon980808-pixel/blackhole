package com.malhaedwo.pttprobe;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.UUID;

/**
 * 블랙홀 보내기 대기열. 휴대폰에서 보낸 문장·사진·음성·파일 원본을 앱 저장소에 먼저 두고,
 * 드라이브 「블랙홀/인박스/」에 올린 뒤에도 지우지 않는다. 승인 DB(CaptureDatabase)와는 별개다.
 * 한 항목은 원본 파일(id.확장자)과 머리 정보(id.meta) 두 개로 이루어지며, 머리 정보가 있어야 항목으로 본다.
 */
public final class BlackholeOutbox {
    public static final String KIND_TEXT = "TEXT";
    public static final String KIND_PHOTO = "PHOTO";
    public static final String KIND_VOICE = "VOICE";
    public static final String KIND_FILE = "FILE";
    public static final String SOURCE_CHAT = "CHAT";
    public static final String SOURCE_SHARE = "SHARE";
    public static final String SOURCE_LOCK = "LOCK";
    public static final String SOURCE_PTT = "PTT";
    public static final String STATE_PENDING = "PENDING";
    public static final String STATE_UPLOADED = "UPLOADED";
    public static final String STATE_FAILED = "FAILED";
    public static final long MAX_BYTES = 200L * 1024 * 1024;
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss", Locale.ROOT);

    public static final class Entry {
        public String id;
        public String kind;
        public String source;
        public String displayName;
        public String mime;
        public String ext;
        public long bytes;
        public String sha256;
        public long createdAt;
        public String state;
        public String driveFileId;
        public int attempts;
        public String lastError;
        public long uploadedAt;
        public String inboxName;
        public File file;

        public boolean uploaded() { return STATE_UPLOADED.equals(state); }
    }

    private final File dir;
    private final ZoneId zone;
    private final Object lock = new Object();

    public BlackholeOutbox(File dir, ZoneId zone) {
        this.dir = dir;
        this.zone = zone == null ? ZoneId.systemDefault() : zone;
    }

    public File directory() { return dir; }

    public Entry addText(String text, String source, long now) throws IOException {
        String body = text == null ? "" : text.trim();
        if (body.isEmpty()) throw new IOException("보낼 내용이 없습니다");
        byte[] bytes = (body + "\n").getBytes(StandardCharsets.UTF_8);
        return add(new java.io.ByteArrayInputStream(bytes), KIND_TEXT, source, "", "text/plain", "txt", now);
    }

    /** 공유·사진 고르기처럼 바로 사라질 수 있는 스트림은 즉시 끝까지 복사한다. */
    public Entry addStream(InputStream input, String kind, String source, String displayName,
                           String mime, long now) throws IOException {
        String ext = extensionFor(displayName, mime);
        return add(input, kind, source, displayName, mimeFor(ext, mime), ext, now);
    }

    /** 녹음·카메라처럼 앱이 직접 만든 임시 파일은 복사 후 지운다. */
    public Entry addFile(File temp, String kind, String source, String displayName, String mime, long now) throws IOException {
        Entry entry;
        try (InputStream input = new FileInputStream(temp)) {
            entry = addStream(input, kind, source, displayName, mime, now);
        }
        //noinspection ResultOfMethodCallIgnored
        temp.delete();
        return entry;
    }

    private Entry add(InputStream input, String kind, String source, String displayName,
                      String mime, String ext, long now) throws IOException {
        synchronized (lock) {
            ensureDir();
            Entry entry = new Entry();
            entry.id = UUID.randomUUID().toString().replace("-", "");
            entry.kind = kind;
            entry.source = source;
            entry.displayName = displayName == null ? "" : displayName;
            entry.mime = mime;
            entry.ext = ext;
            entry.createdAt = now;
            entry.state = STATE_PENDING;
            entry.driveFileId = "";
            entry.lastError = "";
            File part = new File(dir, entry.id + ".part");
            MessageDigest digest = sha256Digest();
            long total = 0;
            try (OutputStream output = new FileOutputStream(part)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count == 0) continue;
                    total += count;
                    if (total > MAX_BYTES) throw new IOException("200MB보다 큰 파일은 보낼 수 없습니다");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                if (output instanceof FileOutputStream) ((FileOutputStream) output).getFD().sync();
            } catch (IOException error) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                throw error;
            }
            if (total == 0) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                throw new IOException("빈 파일은 보낼 수 없습니다");
            }
            entry.bytes = total;
            entry.sha256 = hex(digest.digest());
            entry.inboxName = inboxName(entry, zone);
            entry.file = new File(dir, entry.id + "." + ext);
            if (!part.renameTo(entry.file)) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                throw new IOException("보낼 원본을 저장하지 못했습니다");
            }
            writeMeta(entry);
            return entry;
        }
    }

    /** 아직 드라이브에 올리지 못한 항목, 오래된 것부터. */
    public List<Entry> pending() {
        List<Entry> out = new ArrayList<>();
        for (Entry entry : all()) if (!entry.uploaded()) out.add(entry);
        return out;
    }

    /** 대화 화면용: 오래된 것부터 마지막 limit개. */
    public List<Entry> recent(int limit) {
        List<Entry> all = all();
        int from = Math.max(0, all.size() - Math.max(0, limit));
        return new ArrayList<>(all.subList(from, all.size()));
    }

    public Entry get(String id) {
        synchronized (lock) { return readMeta(new File(dir, id + ".meta")); }
    }

    public void markUploaded(String id, String driveFileId, long now) throws IOException {
        synchronized (lock) {
            Entry entry = get(id);
            if (entry == null) return;
            entry.state = STATE_UPLOADED;
            entry.driveFileId = driveFileId == null ? "" : driveFileId;
            entry.uploadedAt = now;
            entry.lastError = "";
            writeMeta(entry);
        }
    }

    public void markFailed(String id, String message) throws IOException {
        synchronized (lock) {
            Entry entry = get(id);
            if (entry == null || entry.uploaded()) return;
            entry.state = STATE_FAILED;
            entry.attempts++;
            entry.lastError = message == null ? "" : message;
            writeMeta(entry);
        }
    }

    public int pendingCount() { return pending().size(); }

    /** 문장 항목의 본문(대화 화면 미리보기). 다른 종류는 빈 문자열. */
    public String readText(Entry entry, int maxChars) {
        if (entry == null || !KIND_TEXT.equals(entry.kind) || entry.file == null) return "";
        StringBuilder out = new StringBuilder();
        try (Reader reader = new InputStreamReader(new FileInputStream(entry.file), StandardCharsets.UTF_8)) {
            char[] buffer = new char[2048];
            int count;
            while (out.length() < maxChars && (count = reader.read(buffer)) >= 0) out.append(buffer, 0, count);
        } catch (IOException ignored) {}
        String text = out.toString().trim();
        return text.length() > maxChars ? text.substring(0, maxChars) + "…" : text;
    }

    private List<Entry> all() {
        synchronized (lock) {
            List<Entry> out = new ArrayList<>();
            File[] files = dir.listFiles();
            if (files == null) return out;
            for (File file : files) {
                String name = file.getName();
                if (name.endsWith(".meta")) {
                    Entry entry = readMeta(file);
                    if (entry != null && entry.file != null && entry.file.isFile()) out.add(entry);
                } else if (name.endsWith(".part") || name.endsWith(".meta.tmp")) {
                    // 앱이 복사 도중 끝난 흔적. 머리 정보가 없으므로 항목이 아니다.
                    if (System.currentTimeMillis() - file.lastModified() > 60_000L) {
                        //noinspection ResultOfMethodCallIgnored
                        file.delete();
                    }
                }
            }
            Collections.sort(out, (a, b) -> a.createdAt != b.createdAt
                    ? Long.compare(a.createdAt, b.createdAt) : a.id.compareTo(b.id));
            return out;
        }
    }

    private void ensureDir() throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("보내기 보관 폴더를 만들지 못했습니다");
    }

    private void writeMeta(Entry entry) throws IOException {
        Properties p = new Properties();
        p.setProperty("id", entry.id);
        p.setProperty("kind", entry.kind);
        p.setProperty("source", entry.source);
        p.setProperty("displayName", entry.displayName);
        p.setProperty("mime", entry.mime);
        p.setProperty("ext", entry.ext);
        p.setProperty("bytes", String.valueOf(entry.bytes));
        p.setProperty("sha256", entry.sha256);
        p.setProperty("createdAt", String.valueOf(entry.createdAt));
        p.setProperty("state", entry.state);
        p.setProperty("driveFileId", entry.driveFileId == null ? "" : entry.driveFileId);
        p.setProperty("attempts", String.valueOf(entry.attempts));
        p.setProperty("lastError", entry.lastError == null ? "" : entry.lastError);
        p.setProperty("uploadedAt", String.valueOf(entry.uploadedAt));
        p.setProperty("inboxName", entry.inboxName);
        File tmp = new File(dir, entry.id + ".meta.tmp");
        try (FileOutputStream stream = new FileOutputStream(tmp);
             Writer writer = new OutputStreamWriter(stream, StandardCharsets.UTF_8)) {
            p.store(writer, null);
            writer.flush();
            stream.getFD().sync();
        }
        File meta = new File(dir, entry.id + ".meta");
        if (!tmp.renameTo(meta)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("보내기 기록을 저장하지 못했습니다");
        }
    }

    private Entry readMeta(File meta) {
        if (meta == null || !meta.isFile()) return null;
        Properties p = new Properties();
        try (Reader reader = new InputStreamReader(new FileInputStream(meta), StandardCharsets.UTF_8)) {
            p.load(reader);
        } catch (IOException error) {
            return null;
        }
        Entry entry = new Entry();
        entry.id = p.getProperty("id", "");
        if (entry.id.isEmpty()) return null;
        entry.kind = p.getProperty("kind", KIND_FILE);
        entry.source = p.getProperty("source", SOURCE_CHAT);
        entry.displayName = p.getProperty("displayName", "");
        entry.mime = p.getProperty("mime", "application/octet-stream");
        entry.ext = p.getProperty("ext", "bin");
        entry.bytes = number(p.getProperty("bytes"));
        entry.sha256 = p.getProperty("sha256", "");
        entry.createdAt = number(p.getProperty("createdAt"));
        entry.state = p.getProperty("state", STATE_PENDING);
        entry.driveFileId = p.getProperty("driveFileId", "");
        entry.attempts = (int) number(p.getProperty("attempts"));
        entry.lastError = p.getProperty("lastError", "");
        entry.uploadedAt = number(p.getProperty("uploadedAt"));
        entry.inboxName = p.getProperty("inboxName", entry.id + "." + entry.ext);
        entry.file = new File(dir, entry.id + "." + entry.ext);
        return entry;
    }

    /**
     * 인박스에 올릴 이름: 「20261025-143200-폰-ab12cd34[-원래이름].확장자」.
     * 시각을 앞에 두어 Mac 쪽 정렬과 같고, id 앞 8자로 같은 초에 보낸 것도 겹치지 않는다.
     */
    static String inboxName(Entry entry, ZoneId zone) {
        String stamp = STAMP.format(Instant.ofEpochMilli(entry.createdAt).atZone(zone));
        String stem = stem(entry.displayName);
        StringBuilder name = new StringBuilder(stamp).append("-폰-").append(entry.id, 0, 8);
        if (!stem.isEmpty()) name.append('-').append(stem);
        return name.append('.').append(entry.ext).toString();
    }

    static String stem(String displayName) {
        if (displayName == null) return "";
        String name = displayName.trim();
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        int dot = name.lastIndexOf('.');
        if (dot > 0) name = name.substring(0, dot);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c < 0x20 || c == 0x7f || "/\\:*?\"<>|".indexOf(c) >= 0) out.append('_');
            else out.append(c);
        }
        String clean = out.toString().trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        return clean.length() > 60 ? clean.substring(0, 60).trim() : clean;
    }

    /** 공유로 받은 주소는 다른 앱의 content:// 만 받는다. file:// 이나 이 앱 자신의 제공자는 거절(내부 DB·토큰 유출 방지). */
    static boolean acceptsSharedUri(String scheme, String authority) {
        if (!"content".equals(scheme) || authority == null || authority.isEmpty()) return false;
        return !authority.startsWith("com.malhaedwo.pttprobe");
    }

    static String extensionFor(String displayName, String mime) {
        String fromName = "";
        if (displayName != null) {
            int dot = displayName.lastIndexOf('.');
            if (dot >= 0 && dot < displayName.length() - 1) fromName = displayName.substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        if (!fromName.isEmpty() && fromName.length() <= 8 && fromName.matches("[a-z0-9]+")) return fromName;
        String m = mime == null ? "" : mime.toLowerCase(Locale.ROOT);
        switch (m) {
            case "image/jpeg": return "jpg";
            case "image/png": return "png";
            case "image/webp": return "webp";
            case "image/heic": return "heic";
            case "audio/wav": case "audio/x-wav": case "audio/wave": return "wav";
            case "audio/mp4": case "audio/m4a": case "audio/x-m4a": return "m4a";
            case "audio/mpeg": return "mp3";
            case "application/pdf": return "pdf";
            case "text/plain": return "txt";
            case "text/markdown": return "md";
            case "application/x-hwp": case "application/haansofthwp": case "application/vnd.hancom.hwp": return "hwp";
            case "application/vnd.hancom.hwpx": case "application/haansofthwpx": return "hwpx";
            case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx";
            case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "xlsx";
            case "video/mp4": return "mp4";
            default: return "bin";
        }
    }

    static String mimeFor(String ext, String given) {
        if (given != null && !given.trim().isEmpty() && !"*/*".equals(given) && given.indexOf('/') > 0) return given;
        switch (ext) {
            case "jpg": case "jpeg": return "image/jpeg";
            case "png": return "image/png";
            case "webp": return "image/webp";
            case "wav": return "audio/wav";
            case "txt": return "text/plain";
            case "md": return "text/markdown";
            case "pdf": return "application/pdf";
            default: return "application/octet-stream";
        }
    }

    public static String sha256(File file) throws IOException {
        MessageDigest digest = sha256Digest();
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) if (count > 0) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    private static MessageDigest sha256Digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static long number(String value) {
        try { return Long.parseLong(value); }
        catch (Throwable ignored) { return 0; }
    }
}
