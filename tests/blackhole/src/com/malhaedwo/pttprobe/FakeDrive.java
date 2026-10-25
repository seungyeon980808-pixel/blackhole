package com.malhaedwo.pttprobe;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 시험용 가짜 Google Drive (127.0.0.1). 실제 드라이브에는 아무것도 보내지 않는다.
 * 폴더 찾기·만들기, 파일 확인, appProperties 질의, resumable 업로드(308·Range), 일부러 내는 오류를 흉내 낸다.
 */
final class FakeDrive implements AutoCloseable {
    static final class FileRecord {
        String id;
        String name;
        String mime;
        String parent;
        boolean trashed;
        Map<String,String> props = new LinkedHashMap<>();
        byte[] content = new byte[0];
    }

    static final class Session {
        final FileRecord file;
        final long total;
        final ByteArrayOutputStream received = new ByteArrayOutputStream();
        Session(FileRecord file, long total) { this.file = file; this.total = total; }
    }

    final Map<String,FileRecord> files = new LinkedHashMap<>();
    final Map<String,Session> sessions = new LinkedHashMap<>();
    final List<String> log = new ArrayList<>();
    final List<String> queries = new ArrayList<>();
    final List<String> createdFolderBodies = new ArrayList<>();
    String validToken = "good";
    /** 다음 청크 PUT 몇 번에 503을 낸다(받은 바이트는 버린다). */
    int failNextChunks;
    /** 업로드 세션 만들기에 늘 500을 낸다. */
    boolean failSessionCreate;
    int uploadsStarted;
    private int nextId = 1;
    private final HttpServer server;

    FakeDrive() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
    }

    String base() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
    String filesUrl() { return base() + "/drive/v3/files"; }
    String uploadUrl() { return base() + "/upload/drive/v3/files"; }

    FileRecord folder(String name, String parent) {
        FileRecord record = new FileRecord();
        record.id = "f" + (nextId++);
        record.name = name;
        record.mime = DriveTransfer.FOLDER_MIME;
        record.parent = parent;
        files.put(record.id, record);
        return record;
    }

    List<FileRecord> children(String parent) {
        List<FileRecord> out = new ArrayList<>();
        for (FileRecord record : files.values()) if (parent.equals(record.parent) && !record.trashed) out.add(record);
        return out;
    }

    @Override public void close() { server.stop(0); }

    private synchronized void handle(HttpExchange exchange) throws IOException {
        try {
            String method = exchange.getRequestMethod();
            String path = exchange.getRequestURI().getPath();
            String rawQuery = exchange.getRequestURI().getRawQuery();
            byte[] body = readAll(exchange.getRequestBody());
            log.add(method + " " + path);
            String auth = exchange.getRequestHeaders().getFirst("Authorization");
            if (!("Bearer " + validToken).equals(auth)) {
                send(exchange, 401, "{\"error\":{\"message\":\"Invalid Credentials\"}}", null);
                return;
            }
            Map<String,String> query = parseQuery(rawQuery);
            if (path.equals("/drive/v3/files") && method.equals("GET")) {
                String q = query.getOrDefault("q", "");
                queries.add(q);
                JSONArray out = new JSONArray();
                for (FileRecord record : files.values()) if (matches(record, q)) {
                    out.put(new JSONObject().put("id", record.id).put("name", record.name).put("trashed", record.trashed));
                }
                send(exchange, 200, new JSONObject().put("files", out).toString(), null);
            } else if (path.startsWith("/drive/v3/files/") && method.equals("GET")) {
                FileRecord record = files.get(path.substring("/drive/v3/files/".length()));
                if (record == null) send(exchange, 404, "{\"error\":{\"message\":\"File not found\"}}", null);
                else send(exchange, 200, new JSONObject().put("id", record.id).put("trashed", record.trashed).toString(), null);
            } else if (path.equals("/drive/v3/files") && method.equals("POST")) {
                String json = new String(body, StandardCharsets.UTF_8);
                createdFolderBodies.add(json);
                JSONObject metadata = new JSONObject(json);
                JSONArray parents = metadata.optJSONArray("parents");
                FileRecord record = folder(metadata.optString("name", ""), parents == null ? "root" : parents.optString(0, "root"));
                send(exchange, 200, new JSONObject().put("id", record.id).toString(), null);
            } else if (path.equals("/upload/drive/v3/files") && method.equals("POST")) {
                if (failSessionCreate) {
                    send(exchange, 500, "{\"error\":{\"message\":\"Backend Error\"}}", null);
                    return;
                }
                uploadsStarted++;
                JSONObject metadata = new JSONObject(new String(body, StandardCharsets.UTF_8));
                FileRecord record = new FileRecord();
                record.id = "u" + (nextId++);
                record.name = metadata.optString("name", "");
                record.mime = metadata.optString("mimeType", "");
                record.parent = metadata.optJSONArray("parents").optString(0, "");
                JSONObject props = metadata.optJSONObject("appProperties");
                if (props != null) for (java.util.Iterator<String> it = props.keys(); it.hasNext(); ) {
                    String key = it.next();
                    record.props.put(key, props.optString(key, ""));
                }
                long total = Long.parseLong(exchange.getRequestHeaders().getFirst("X-Upload-Content-Length"));
                String sid = "s" + (nextId++);
                sessions.put(sid, new Session(record, total));
                send(exchange, 200, "{}", base() + "/upload/session/" + sid);
            } else if (path.startsWith("/upload/session/") && method.equals("PUT")) {
                Session session = sessions.get(path.substring("/upload/session/".length()));
                if (session == null) { send(exchange, 404, "{}", null); return; }
                String range = exchange.getRequestHeaders().getFirst("Content-Range");
                if (range.startsWith("bytes */")) {
                    long have = session.received.size();
                    // 실제 드라이브처럼 받은 것이 없으면 Range 머리를 붙이지 않는다.
                    if (have > 0) exchange.getResponseHeaders().add("Range", "bytes=0-" + (have - 1));
                    send(exchange, 308, "", null);
                    return;
                }
                if (failNextChunks > 0) {
                    failNextChunks--;
                    send(exchange, 503, "{\"error\":{\"message\":\"Service Unavailable\"}}", null);
                    return;
                }
                Matcher m = Pattern.compile("bytes (\\d+)-(\\d+)/(\\d+)").matcher(range);
                if (!m.matches() || Long.parseLong(m.group(1)) != session.received.size()) {
                    send(exchange, 400, "{\"error\":{\"message\":\"bad range " + range + "\"}}", null);
                    return;
                }
                session.received.write(body);
                if (session.received.size() >= session.total) {
                    session.file.content = session.received.toByteArray();
                    files.put(session.file.id, session.file);
                    send(exchange, 200, new JSONObject().put("id", session.file.id).toString(), null);
                } else {
                    exchange.getResponseHeaders().add("Range", "bytes=0-" + (session.received.size() - 1));
                    send(exchange, 308, "", null);
                }
            } else {
                send(exchange, 404, "{}", null);
            }
        } catch (Throwable error) {
            error.printStackTrace();
            send(exchange, 500, "{\"error\":{\"message\":\"fake drive bug\"}}", null);
        }
    }

    private static boolean matches(FileRecord record, String q) {
        if (q.contains("trashed=false") && record.trashed) return false;
        Matcher name = Pattern.compile("name='((?:[^'\\\\]|\\\\.)*)'").matcher(q);
        if (name.find() && !unescape(name.group(1)).equals(record.name)) return false;
        if (q.contains("mimeType='" + DriveTransfer.FOLDER_MIME + "'") && !DriveTransfer.FOLDER_MIME.equals(record.mime)) return false;
        Matcher parent = Pattern.compile("^'((?:[^'\\\\]|\\\\.)*)' in parents").matcher(q);
        if (parent.find() && !unescape(parent.group(1)).equals(record.parent)) return false;
        Matcher prop = Pattern.compile("appProperties has \\{ key='((?:[^'\\\\]|\\\\.)*)' and value='((?:[^'\\\\]|\\\\.)*)' \\}").matcher(q);
        while (prop.find()) {
            if (!unescape(prop.group(2)).equals(record.props.get(unescape(prop.group(1))))) return false;
        }
        return true;
    }

    private static String unescape(String value) { return value.replace("\\'", "'").replace("\\\\", "\\"); }

    private static Map<String,String> parseQuery(String raw) {
        Map<String,String> out = new LinkedHashMap<>();
        if (raw == null) return out;
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            out.put(URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8));
        }
        return out;
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) >= 0) out.write(buffer, 0, count);
        return out.toByteArray();
    }

    private static void send(HttpExchange exchange, int code, String body, String location) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (location != null) exchange.getResponseHeaders().add("Location", location);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=UTF-8");
        exchange.sendResponseHeaders(code, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) try (OutputStream output = exchange.getResponseBody()) { output.write(bytes); }
        exchange.close();
    }
}
