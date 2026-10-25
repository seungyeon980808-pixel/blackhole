package com.malhaedwo.pttprobe;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Google Drive 폴더 찾기·만들기와 resumable 업로드. 기존 WAV 원본 업로드(GoogleSyncEngine)와
 * 블랙홀 인박스 업로드(BlackholeUploader)가 같은 코드를 쓴다. 주소는 시험용 가짜 서버로 바꿀 수 있다.
 */
final class DriveTransfer {
    static final String DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
    static final String DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
    static final String FOLDER_MIME = "application/vnd.google-apps.folder";
    static final int UPLOAD_CHUNK = 256 * 1024;

    private final String filesUrl;
    private final String uploadUrl;
    private final int chunkSize;

    DriveTransfer() { this(DRIVE_FILES, DRIVE_UPLOAD, UPLOAD_CHUNK); }

    DriveTransfer(String filesUrl, String uploadUrl, int chunkSize) {
        this.filesUrl = filesUrl;
        this.uploadUrl = uploadUrl;
        this.chunkSize = chunkSize;
    }

    /** parentId가 null이면 위치를 묻지 않는다(기존 「말해둬 원본 음성」 폴더와 같은 질의). */
    String findFolder(String token, String name, String parentId) throws Exception {
        String query = "mimeType='" + FOLDER_MIME + "' and name=" + queryLiteral(name) + " and trashed=false";
        if (parentId != null) query = queryLiteral(parentId) + " in parents and " + query;
        String url = filesUrl + "?spaces=drive&pageSize=10&fields=" + enc("files(id,name)") + "&q=" + enc(query);
        HttpResponse response = api(token, "GET", url, null, null);
        requireSuccess(response, "Drive 폴더 찾기");
        JSONArray files = new JSONObject(response.body).optJSONArray("files");
        return files != null && files.length() > 0 ? files.optJSONObject(0).optString("id", "") : "";
    }

    String createFolder(String token, String name, String parentId, Map<String,String> appProperties) throws Exception {
        JSONObject metadata = new JSONObject();
        metadata.put("name", name);
        metadata.put("mimeType", FOLDER_MIME);
        if (parentId != null) metadata.put("parents", new JSONArray().put(parentId));
        if (appProperties != null && !appProperties.isEmpty()) metadata.put("appProperties", properties(appProperties));
        HttpResponse created = api(token, "POST", filesUrl + "?fields=id", metadata.toString(), null);
        requireSuccess(created, "Drive 폴더 만들기");
        return new JSONObject(created.body).optString("id", "");
    }

    String findOrCreateFolder(String token, String name, String parentId, Map<String,String> appProperties) throws Exception {
        String folderId = findFolder(token, name, parentId);
        if (folderId.isEmpty()) folderId = createFolder(token, name, parentId, appProperties);
        if (folderId.isEmpty()) throw new Exception("Drive 폴더 ID를 받지 못했습니다");
        return folderId;
    }

    /** 폴더·파일이 있고 휴지통에 없으면 true. 404는 false. */
    boolean exists(String token, String fileId) throws Exception {
        if (fileId == null || fileId.isEmpty()) return false;
        HttpResponse response = api(token, "GET", filesUrl + "/" + enc(fileId) + "?fields=id,trashed", null, null);
        if (response.code == 404) return false;
        requireSuccess(response, "Drive 원본 확인");
        JSONObject file = new JSONObject(response.body);
        return !file.optString("id", "").isEmpty() && !file.optBoolean("trashed", false);
    }

    /** 같은 appProperties를 가진 파일이 parentId 안에 이미 있으면 그 ID(중복 업로드 방지). */
    String findChild(String token, String parentId, Map<String,String> appProperties) throws Exception {
        StringBuilder query = new StringBuilder(queryLiteral(parentId)).append(" in parents and trashed=false");
        for (Map.Entry<String,String> property : appProperties.entrySet()) {
            query.append(" and appProperties has { key=").append(queryLiteral(property.getKey()))
                    .append(" and value=").append(queryLiteral(property.getValue())).append(" }");
        }
        String url = filesUrl + "?spaces=drive&pageSize=10&fields=" + enc("files(id,trashed)") + "&q=" + enc(query.toString());
        HttpResponse response = api(token, "GET", url, null, null);
        requireSuccess(response, "Drive 기존 원본 찾기");
        JSONArray files = new JSONObject(response.body).optJSONArray("files");
        if (files == null) return "";
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i);
            if (file != null && !file.optBoolean("trashed", false)) {
                String id = file.optString("id", "");
                if (!id.isEmpty()) return id;
            }
        }
        return "";
    }

    /** label은 오류 문장에 들어간다(예: "WAV", "블랙홀"). */
    String resumableUpload(String token, File file, String name, String mime, String parentId,
                           Map<String,String> appProperties, String label) throws Exception {
        JSONObject metadata = new JSONObject();
        metadata.put("name", name);
        metadata.put("mimeType", mime);
        metadata.put("parents", new JSONArray().put(parentId));
        if (appProperties != null && !appProperties.isEmpty()) metadata.put("appProperties", properties(appProperties));
        Map<String,String> headers = new HashMap<>();
        headers.put("X-Upload-Content-Type", mime);
        headers.put("X-Upload-Content-Length", String.valueOf(file.length()));
        HttpResponse start = api(token, "POST", uploadUrl + "?uploadType=resumable&fields=id,name,size", metadata.toString(), headers);
        requireSuccess(start, "Drive 업로드 세션 만들기");
        String session = start.header("Location");
        if (session.isEmpty()) throw new Exception("Drive resumable 업로드 주소를 받지 못했습니다");
        long total = file.length();
        long offset = 0;
        int failures = 0;
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            while (offset < total) {
                checkInterrupted();
                int length = (int) Math.min(chunkSize, total - offset);
                byte[] chunk = new byte[length];
                input.seek(offset);
                input.readFully(chunk);
                HttpURLConnection connection = (HttpURLConnection) new URL(session).openConnection();
                connection.setRequestMethod("PUT");
                connection.setDoOutput(true);
                connection.setConnectTimeout(30_000);
                connection.setReadTimeout(60_000);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("Content-Type", mime);
                connection.setRequestProperty("Content-Range", "bytes " + offset + "-" + (offset + length - 1) + "/" + total);
                connection.setFixedLengthStreamingMode(length);
                int code;
                String body;
                String accepted;
                try {
                    try (OutputStream output = connection.getOutputStream()) { output.write(chunk); }
                    code = connection.getResponseCode();
                    body = read(connection, code, 2_000_000);
                    accepted = connection.getHeaderField("Range");
                } catch (java.io.IOException network) {
                    connection.disconnect();
                    if (failures++ < 2) {
                        offset = queryUploadOffset(token, session, total, offset);
                        continue;
                    }
                    throw network;
                }
                connection.disconnect();
                if (code == 200 || code == 201) {
                    String id = new JSONObject(body).optString("id", "");
                    if (id.isEmpty()) throw new Exception("Drive 업로드 파일 ID가 없습니다");
                    return id;
                }
                if (code == 308) {
                    long next = nextOffset(accepted);
                    offset = next > offset ? next : offset + length;
                    failures = 0;
                    continue;
                }
                if ((code == 408 || code == 429 || code >= 500) && failures++ < 2) {
                    offset = queryUploadOffset(token, session, total, offset);
                    continue;
                }
                throw new HttpFailure(code, "Drive " + label + " 업로드 실패: " + responseMessage(body));
            }
        }
        throw new Exception("Drive " + label + " 업로드가 완료 응답 없이 끝났습니다");
    }

    private static long queryUploadOffset(String token, String session, long total, long fallback) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(session).openConnection();
            connection.setRequestMethod("PUT");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(0);
            connection.setRequestProperty("Content-Range", "bytes */" + total);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(20_000);
            int code = connection.getResponseCode();
            String range = connection.getHeaderField("Range");
            connection.disconnect();
            if (code == 308) {
                long next = nextOffset(range);
                return next >= 0 ? next : 0;
            }
        } catch (Throwable ignored) {}
        return fallback;
    }

    static long nextOffset(String range) {
        if (range == null) return -1;
        int dash = range.lastIndexOf('-');
        if (dash < 0) return -1;
        try { return Long.parseLong(range.substring(dash + 1).trim()) + 1; }
        catch (Throwable ignored) { return -1; }
    }

    static String queryLiteral(String value) {
        String escaped = value == null ? "" : value.replace("\\", "\\\\").replace("'", "\\'");
        return "'" + escaped + "'";
    }

    private static JSONObject properties(Map<String,String> values) throws Exception {
        JSONObject out = new JSONObject();
        for (Map.Entry<String,String> value : new LinkedHashMap<>(values).entrySet()) out.put(value.getKey(), value.getValue());
        return out;
    }

    private static HttpResponse api(String token, String method, String endpoint, String json,
                                    Map<String,String> extraHeaders) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(25_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        if (extraHeaders != null) for (Map.Entry<String,String> header : extraHeaders.entrySet()) {
            connection.setRequestProperty(header.getKey(), header.getValue());
        }
        if (json != null) {
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        }
        int code = connection.getResponseCode();
        String body = read(connection, code, 4_000_000);
        Map<String,List<String>> headers = connection.getHeaderFields();
        connection.disconnect();
        return new HttpResponse(code, body, headers);
    }

    private static void requireSuccess(HttpResponse response, String action) throws HttpFailure {
        if (response.code >= 200 && response.code < 300) return;
        throw new HttpFailure(response.code, action + " 실패 (HTTP " + response.code + "): " + responseMessage(response.body));
    }

    private static String read(HttpURLConnection connection, int code, int maxChars) throws Exception {
        InputStream stream = code >= 200 && code < 400 ? connection.getInputStream() : connection.getErrorStream();
        if (stream == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null && out.length() < maxChars) {
                checkInterrupted();
                out.append(line);
            }
        }
        return out.toString();
    }

    static String responseMessage(String body) {
        try {
            JSONObject json = new JSONObject(body == null || body.isEmpty() ? "{}" : body);
            Object error = json.opt("error");
            if (error instanceof JSONObject) return ((JSONObject) error).optString("message", "Google API 오류");
            if (error != null) return String.valueOf(error);
        } catch (Throwable ignored) {}
        return body == null || body.isEmpty() ? "응답 없음" : body.substring(0, Math.min(260, body.length()));
    }

    private static void checkInterrupted() throws InterruptedException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedException("업로드 작업이 중지되었습니다");
    }

    private static String enc(String value) throws Exception { return URLEncoder.encode(value, "UTF-8").replace("+", "%20"); }

    static final class HttpResponse {
        final int code;
        final String body;
        final Map<String,List<String>> headers;
        HttpResponse(int code, String body, Map<String,List<String>> headers) {
            this.code = code;
            this.body = body == null ? "" : body;
            this.headers = headers == null ? new HashMap<>() : headers;
        }
        String header(String name) {
            for (Map.Entry<String,List<String>> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name) && entry.getValue() != null && !entry.getValue().isEmpty()) {
                    return entry.getValue().get(0);
                }
            }
            return "";
        }
    }

    static final class HttpFailure extends Exception {
        final int code;
        HttpFailure(int code, String message) { super(message); this.code = code; }
    }
}
