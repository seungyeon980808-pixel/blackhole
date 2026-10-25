package com.malhaedwo.pttprobe;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class GoogleSyncEngine {
    public static final String SPREADSHEET_ID = "YOUR_SPREADSHEET_ID";
    private static final String SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/" + SPREADSHEET_ID;
    private static final String DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
    private static final String OWNER = GoogleOAuth.ALLOWED_EMAIL;
    private static final int ITEM_COLUMNS = 23;
    private static final int ATTACHMENT_COLUMNS = 12;
    private static final int AUDIT_COLUMNS = 8;
    private static final DriveTransfer DRIVE = new DriveTransfer();
    private static final Object LOCK = new Object();

    public static final class Result {
        public final boolean success;
        public final String message;
        Result(boolean success, String message) { this.success = success; this.message = message; }
    }

    private GoogleSyncEngine() {}

    public static Result sync(Context context) {
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            if (!GoogleOAuth.isConnected(app)) return new Result(true, "Google 연결 없음");
            SyncState.begin(app);
            try {
                Result result = null;
                for (int attempt = 0; attempt < 2; attempt++) {
                    String token = GoogleOAuth.getAccessToken(app);
                    try {
                        result = syncWithToken(app, token);
                        break;
                    } catch (HttpFailure failure) {
                        if (failure.code == 401 && attempt == 0) {
                            GoogleOAuth.clearCachedAccessToken(app);
                            continue;
                        }
                        throw failure;
                    }
                }
                if (result == null) throw new Exception("동기화 결과가 없습니다");
                if (result.success) SyncState.success(app);
                else SyncState.failure(app, result.message);
                return result;
            } catch (Throwable error) {
                String message = safe(error);
                SyncState.failure(app, message);
                return new Result(false, message);
            }
        }
    }

    private static Result syncWithToken(Context context, String token) throws Exception {
        checkInterrupted();
        CaptureDatabase db = CaptureDatabase.get(context);
        RemoteBook book = loadBook(token);
        checkInterrupted();
        int pulled = pullRemote(context, db, book);
        CaptureAutomation.processAllReady(context); // Retry due deletions even when tombstone pull is already pending.
        int pushed = 0;
        int uploaded = 0;
        int failed = 0;
        String firstError = "";
        List<SyncOperation> operations = db.listSyncOperations();
        for (SyncOperation operation : operations) {
            checkInterrupted();
            try {
                if ("DELETE".equals(operation.operation)) {
                    pushDelete(db, book, operation, token);
                    pushed++;
                } else if ("UPSERT".equals(operation.operation)) {
                    if (pushItem(context, db, book, operation, token)) pushed++;
                } else if ("UPLOAD".equals(operation.operation)) {
                    if (uploadAudio(context, db, book, operation, token)) uploaded++;
                } else {
                    db.removeSyncOperation(operation.id);
                }
            } catch (InterruptedException interrupted) {
                throw interrupted;
            } catch (HttpFailure failure) {
                if (failure.code == 401) throw failure;
                String message = safe(failure);
                db.markSyncFailure(operation, message);
                if (firstError.isEmpty()) firstError = message;
                failed++;
            } catch (Throwable error) {
                String message = safe(error);
                db.markSyncFailure(operation, message);
                if (firstError.isEmpty()) firstError = message;
                failed++;
            }
        }
        String message = "가져옴 " + pulled + " · 반영 " + pushed + " · 음성 " + uploaded;
        if (failed > 0) message += " · 실패 " + failed + " (" + firstError + ")";
        return new Result(failed == 0, message);
    }

    private static RemoteBook loadBook(String token) throws Exception {
        String url = SHEETS + "/values:batchGet?majorDimension=ROWS" +
                "&valueRenderOption=UNFORMATTED_VALUE" +
                "&dateTimeRenderOption=FORMATTED_STRING" +
                "&ranges=" + enc("Items!A:W") +
                "&ranges=" + enc("Attachments!A:L") +
                "&ranges=" + enc("AuditLog!A:H");
        HttpResponse response = api(token, "GET", url, null, null);
        requireSuccess(response, "Sheets 읽기");
        JSONObject json = new JSONObject(response.body);
        JSONArray ranges = json.optJSONArray("valueRanges");
        RemoteBook book = new RemoteBook();
        if (ranges == null) return book;
        for (int i = 0; i < ranges.length(); i++) {
            JSONObject range = ranges.optJSONObject(i);
            if (range == null) continue;
            String name = range.optString("range", "");
            JSONArray values = range.optJSONArray("values");
            if (values == null) continue;
            String plainName = name.replace("'", "");
            if (plainName.startsWith("Items!")) parseItems(values, book);
            else if (plainName.startsWith("Attachments!")) parseAttachments(values, book);
            else if (plainName.startsWith("AuditLog!")) parseAudits(values, book);
        }
        return book;
    }

    private static void parseItems(JSONArray rows, RemoteBook book) {
        for (int i = 1; i < rows.length(); i++) {
            JSONArray row = rows.optJSONArray(i);
            String uuid = cellString(row, 0);
            if (uuid.isEmpty()) continue;
            RemoteItem item = new RemoteItem(i + 1, normalized(row, ITEM_COLUMNS));
            book.items.put(uuid, item);
        }
    }

    private static void parseAttachments(JSONArray rows, RemoteBook book) {
        for (int i = 1; i < rows.length(); i++) {
            JSONArray row = rows.optJSONArray(i);
            String itemId = cellString(row, 1);
            if (itemId.isEmpty()) continue;
            RemoteAttachment attachment = new RemoteAttachment(i + 1, normalized(row, ATTACHMENT_COLUMNS));
            book.attachments.put(itemId, attachment);
        }
    }

    private static void parseAudits(JSONArray rows, RemoteBook book) {
        for (int i = 1; i < rows.length(); i++) {
            String id = cellString(rows.optJSONArray(i), 0);
            if (!id.isEmpty()) book.auditIds.add(id);
        }
    }

    private static int pullRemote(Context context, CaptureDatabase db, RemoteBook book) {
        int changed = 0;
        for (Map.Entry<String,RemoteItem> entry : book.items.entrySet()) {
            String uuid = entry.getKey();
            RemoteItem remote = entry.getValue();
            CaptureItem local = db.getByUuid(uuid);
            SyncOperation deletion = db.getSyncOperation(uuid, "DELETE");
            if (deletion != null) continue;
            if (local != null && local.isDeletePending()) continue;
            int remoteVersion = remote.version();
            if ("DELETED".equals(remote.status())) {
                if ((local == null || local.version <= remoteVersion)
                        && CaptureAutomation.requestRemoteDelete(context, uuid, remoteVersion)) {
                    changed++;
                }
                continue;
            }
            if (local != null) {
                db.rememberRemoteCalendarLink(uuid, remote.bool(17), remote.string(18), remote.string(19));
            }
            SyncOperation pending = db.getSyncOperation(uuid, "UPSERT");
            boolean localWins = pending != null && (pending.itemVersion > remoteVersion ||
                    (pending.itemVersion == remoteVersion && pending.updatedAt >= remote.updatedAt()));
            boolean remoteWins = local == null || remoteVersion > local.version ||
                    (remoteVersion == local.version && remote.updatedAt() > local.updatedAt + 1000L);
            if (!localWins && remoteWins) {
                long id = db.applyRemote(remote.capture());
                CaptureItem applied = db.getItem(id);
                CaptureAutomation.withdrawNotificationAfterEdit(context, local, applied);
                if (applied != null && applied.isApproved()) CaptureAutomation.process(context, id);
                else {
                    ReminderScheduler.cancel(context, id);
                    db.clearReminder(id);
                }
                changed++;
            }
        }
        return changed;
    }

    private static boolean pushItem(Context context, CaptureDatabase db, RemoteBook book,
                                    SyncOperation operation, String token) throws Exception {
        CaptureItem item = db.getByUuid(operation.itemUuid);
        if (item == null) {
            db.removeSyncOperation(operation.id);
            return false;
        }
        if (item.isDeletePending()) {
            db.removeSyncOperation(operation.id);
            return false;
        }
        RemoteItem remote = book.items.get(item.uuid);
        if (remote != null && "DELETED".equals(remote.status())
                && CaptureAutomation.requestRemoteDelete(context, item.uuid, remote.version())) {
            db.removeSyncOperation(operation.id);
            return false;
        }
        if (remote != null && (remote.version() > item.version ||
                (remote.version() == item.version && remote.updatedAt() > item.updatedAt + 1000L))) {
            long id = db.applyRemote(remote.capture());
            CaptureItem applied = db.getItem(id);
            CaptureAutomation.withdrawNotificationAfterEdit(context, item, applied);
            if (applied != null && applied.isApproved()) CaptureAutomation.process(context, id);
            else {
                ReminderScheduler.cancel(context, id);
                db.clearReminder(id);
            }
            db.removeSyncOperation(operation.id);
            return false;
        }
        JSONArray row = itemRow(item, remote);
        int prior = remote == null ? 0 : remote.version();
        int rowNumber;
        if (remote == null) {
            rowNumber = appendRow(token, "Items!A:W", row);
        } else {
            putRow(token, "Items!A" + remote.row + ":W" + remote.row, row);
            rowNumber = remote.row;
        }
        RemoteItem updated = new RemoteItem(rowNumber, normalized(row, ITEM_COLUMNS));
        book.items.put(item.uuid, updated);
        String action;
        if (remote == null) action = "ANDROID_CREATE_PENDING";
        else if (item.isApproved() && !"APPROVED".equals(remote.status()) && !"DONE".equals(remote.status())) action = "ANDROID_APPROVE";
        else if (item.isDone()) action = "ANDROID_DONE";
        else action = "ANDROID_EDIT_" + remoteStatus(item);
        appendAudit(token, book, item.uuid, action, prior, item.version, "android");
        db.rememberRemoteCalendarLink(item.uuid, updated.bool(17), updated.string(18), updated.string(19));
        db.markMetadataSynced(item.uuid, item.version, System.currentTimeMillis());
        db.removeSyncOperation(operation.id);
        return true;
    }

    private static JSONArray itemRow(CaptureItem item, RemoteItem prior) {
        JSONArray row = emptyRow(ITEM_COLUMNS);
        put(row, 0, item.uuid);
        put(row, 1, remoteStatus(item));
        put(row, 2, value(item.sourceType, "AUDIO"));
        put(row, 3, value(item.area, "PERSONAL"));
        put(row, 4, value(item.kind, "UNKNOWN"));
        put(row, 5, value(item.title, ""));
        put(row, 6, iso(item.startAt));
        put(row, 7, iso(item.endAt));
        put(row, 8, iso(item.reminderAt));
        put(row, 9, value(item.transcript, ""));
        put(row, 10, prior == null ? "" : prior.string(10));
        put(row, 11, iso(item.createdAt));
        put(row, 12, iso(item.updatedAt));
        put(row, 13, iso(item.approvedAt));
        put(row, 14, prior == null ? OWNER : value(prior.string(14), OWNER));
        put(row, 15, item.isApproved() ? OWNER : (prior == null ? "" : prior.string(15)));
        put(row, 16, item.version);
        put(row, 17, prior == null ? item.remoteCalendarEnabled : prior.bool(17));
        put(row, 18, prior == null ? value(item.remoteCalendarId, "") : prior.string(18));
        put(row, 19, prior == null ? value(item.remoteCalendarEventId, "") : prior.string(19));
        put(row, 20, "");
        put(row, 21, item.uuid);
        put(row, 22, "SYNCED");
        return row;
    }

    private static void pushDelete(CaptureDatabase db, RemoteBook book, SyncOperation operation,
                                   String token) throws Exception {
        RemoteItem remote = book.items.get(operation.itemUuid);
        int newVersion = operation.itemVersion;
        if (remote != null && !"DELETED".equals(remote.status())) {
            newVersion = Math.max(operation.itemVersion, remote.version() + 1);
            JSONArray row = normalized(remote.cells, ITEM_COLUMNS);
            put(row, 1, "DELETED");
            put(row, 12, iso(operation.updatedAt));
            put(row, 16, newVersion);
            put(row, 20, iso(operation.updatedAt));
            put(row, 22, "SYNCED");
            putRow(token, "Items!A" + remote.row + ":W" + remote.row, row);
            appendAudit(token, book, operation.itemUuid, "ANDROID_DELETE", remote.version(), newVersion,
                    "Drive file removed when accessible; external calendar is not changed");
            book.items.put(operation.itemUuid, new RemoteItem(remote.row, row));
        }
        String driveFileId = "";
        try { driveFileId = new JSONObject(value(operation.payload, "{}")).optString("driveFileId", ""); }
        catch (Throwable ignored) {}
        RemoteAttachment attachment = book.attachments.get(operation.itemUuid);
        if (driveFileId.isEmpty() && attachment != null) driveFileId = attachment.string(4);
        if (!driveFileId.isEmpty()) deleteDriveFile(token, driveFileId);
        if (attachment != null && !"DELETED".equals(attachment.string(11))) {
            JSONArray row = normalized(attachment.cells, ATTACHMENT_COLUMNS);
            put(row, 11, "DELETED");
            putRow(token, "Attachments!A" + attachment.row + ":L" + attachment.row, row);
            book.attachments.put(operation.itemUuid, new RemoteAttachment(attachment.row, row));
        }
        db.removeSyncOperation(operation.id);
    }

    private static boolean uploadAudio(Context context, CaptureDatabase db, RemoteBook book,
                                       SyncOperation operation, String token) throws Exception {
        CaptureItem item = db.getByUuid(operation.itemUuid);
        if (item == null) {
            db.removeSyncOperation(operation.id);
            return false;
        }
        if (item.isDeletePending()) {
            db.removeSyncOperation(operation.id);
            return false;
        }
        File file = item.audioPath == null ? null : new File(item.audioPath);
        if (file == null || !file.isFile()) {
            db.removeSyncOperation(operation.id);
            return false;
        }
        if (!book.items.containsKey(item.uuid)) {
            SyncOperation upsert = db.getSyncOperation(item.uuid, "UPSERT");
            if (upsert == null) {
                db.queueAllForSync();
            }
            throw new Exception("음성 메타데이터가 아직 Sheets에 없습니다");
        }
        String sha = sha256(file);
        RemoteAttachment existing = book.attachments.get(item.uuid);
        if (existing != null && sha.equalsIgnoreCase(existing.string(7)) &&
                !existing.string(4).isEmpty() && !"DELETED".equals(existing.string(11)) &&
                driveFileExists(token, existing.string(4))) {
            db.markDriveUploaded(item.uuid, existing.string(4), sha);
            db.removeSyncOperation(operation.id);
            return false;
        }
        String driveFileId = "";
        if (item.driveFileId != null && !item.driveFileId.isEmpty() &&
                sha.equalsIgnoreCase(value(item.audioSha256, "")) && driveFileExists(token, item.driveFileId)) {
            driveFileId = item.driveFileId;
        }
        String folder = ensureDriveFolder(context, token);
        if (driveFileId.isEmpty()) driveFileId = findDriveAudio(token, folder, item.uuid, sha);
        boolean uploadedNew = driveFileId.isEmpty();
        if (uploadedNew) driveFileId = resumableUpload(token, file, folder, item.uuid, sha);
        JSONArray row = attachmentRow(item, file, driveFileId, sha);
        int rowNumber;
        if (existing == null) rowNumber = appendRow(token, "Attachments!A:L", row);
        else {
            putRow(token, "Attachments!A" + existing.row + ":L" + existing.row, row);
            rowNumber = existing.row;
        }
        book.attachments.put(item.uuid, new RemoteAttachment(rowNumber, row));
        db.markDriveUploaded(item.uuid, driveFileId, sha);
        db.removeSyncOperation(operation.id);
        return uploadedNew;
    }

    private static JSONArray attachmentRow(CaptureItem item, File file, String driveFileId, String sha) {
        JSONArray row = emptyRow(ATTACHMENT_COLUMNS);
        put(row, 0, item.uuid + "-audio");
        put(row, 1, item.uuid);
        put(row, 2, "AUDIO");
        put(row, 3, "audio/wav");
        put(row, 4, driveFileId);
        put(row, 5, file.getName());
        put(row, 6, file.getName());
        put(row, 7, sha);
        put(row, 8, file.length());
        put(row, 9, item.durationMs);
        put(row, 10, iso(item.createdAt));
        put(row, 11, "SYNCED");
        return row;
    }

    private static String ensureDriveFolder(Context context, String token) throws Exception {
        SharedPreferences preferences = context.getSharedPreferences("malhaedwo_sync_runtime", Context.MODE_PRIVATE);
        String cached = preferences.getString("drive_folder_id", "");
        if (cached != null && !cached.isEmpty()) return cached;
        Map<String,String> appProperties = new LinkedHashMap<>();
        appProperties.put("owner", "malhaedwo");
        String folderId;
        try { folderId = DRIVE.findOrCreateFolder(token, "말해둬 원본 음성", null, appProperties); }
        catch (DriveTransfer.HttpFailure failure) { throw new HttpFailure(failure.code, failure.getMessage()); }
        preferences.edit().putString("drive_folder_id", folderId).apply();
        return folderId;
    }

    private static boolean driveFileExists(String token, String fileId) throws Exception {
        if (fileId == null || fileId.isEmpty()) return false;
        HttpResponse response = api(token, "GET", DRIVE_FILES + "/" + enc(fileId) + "?fields=id,trashed", null, null);
        if (response.code == 404) return false;
        requireSuccess(response, "Drive 원본 확인");
        JSONObject file = new JSONObject(response.body);
        return !file.optString("id", "").isEmpty() && !file.optBoolean("trashed", false);
    }

    private static String findDriveAudio(String token, String folderId, String itemUuid, String sha) throws Exception {
        Map<String,String> appProperties = new LinkedHashMap<>();
        appProperties.put("malhaedwoItemId", itemUuid);
        appProperties.put("sha256", sha);
        try { return DRIVE.findChild(token, folderId, appProperties); }
        catch (DriveTransfer.HttpFailure failure) { throw new HttpFailure(failure.code, failure.getMessage()); }
    }

    private static String resumableUpload(String token, File file, String folderId,
                                          String itemUuid, String sha) throws Exception {
        Map<String,String> appProperties = new LinkedHashMap<>();
        appProperties.put("malhaedwoItemId", itemUuid);
        appProperties.put("sha256", sha);
        try { return DRIVE.resumableUpload(token, file, file.getName(), "audio/wav", folderId, appProperties, "WAV"); }
        catch (DriveTransfer.HttpFailure failure) { throw new HttpFailure(failure.code, failure.getMessage()); }
    }

    private static void deleteDriveFile(String token, String fileId) throws Exception {
        HttpResponse response = api(token, "DELETE", DRIVE_FILES + "/" + enc(fileId), null, null);
        if (response.code == 404) return;
        requireSuccess(response, "Drive 원본 삭제");
    }

    private static int appendRow(String token, String range, JSONArray row) throws Exception {
        JSONObject body = valuesBody(range, row);
        String url = SHEETS + "/values/" + enc(range) + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS";
        HttpResponse response = api(token, "POST", url, body.toString(), null);
        requireSuccess(response, range + " 추가");
        JSONObject updates = new JSONObject(response.body).optJSONObject("updates");
        String updatedRange = updates == null ? "" : updates.optString("updatedRange", "");
        int rowNumber = rowNumber(updatedRange);
        if (rowNumber <= 0) throw new Exception(range + " 추가 행 번호를 받지 못했습니다");
        return rowNumber;
    }

    private static void putRow(String token, String range, JSONArray row) throws Exception {
        JSONObject body = valuesBody(range, row);
        String url = SHEETS + "/values/" + enc(range) + "?valueInputOption=RAW";
        HttpResponse response = api(token, "PUT", url, body.toString(), null);
        requireSuccess(response, range + " 수정");
    }

    private static JSONObject valuesBody(String range, JSONArray row) throws Exception {
        JSONObject body = new JSONObject();
        body.put("range", range);
        body.put("majorDimension", "ROWS");
        body.put("values", new JSONArray().put(row));
        return body;
    }

    private static void appendAudit(String token, RemoteBook book, String itemUuid, String action,
                                    int priorVersion, int newVersion, String detail) throws Exception {
        String auditId = "android-" + itemUuid + "-" + newVersion + "-" + action.toLowerCase(Locale.ROOT);
        if (book.auditIds.contains(auditId)) return;
        JSONArray row = emptyRow(AUDIT_COLUMNS);
        put(row, 0, auditId);
        put(row, 1, itemUuid);
        put(row, 2, action);
        put(row, 3, OWNER);
        put(row, 4, iso(System.currentTimeMillis()));
        put(row, 5, priorVersion);
        put(row, 6, newVersion);
        put(row, 7, detail);
        appendRow(token, "AuditLog!A:H", row);
        book.auditIds.add(auditId);
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

    private static String responseMessage(String body) {
        try {
            JSONObject json = new JSONObject(value(body, "{}"));
            Object error = json.opt("error");
            if (error instanceof JSONObject) return ((JSONObject) error).optString("message", "Google API 오류");
            if (error != null) return String.valueOf(error);
        } catch (Throwable ignored) {}
        return body == null || body.isEmpty() ? "응답 없음" : body.substring(0, Math.min(260, body.length()));
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        try (InputStream input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) >= 0) if (count > 0) digest.update(buffer, 0, count);
        }
        StringBuilder out = new StringBuilder();
        for (byte value : digest.digest()) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static JSONArray normalized(JSONArray source, int columns) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < columns; i++) {
            Object raw = source == null ? null : source.opt(i);
            out.put(raw == null || raw == JSONObject.NULL ? "" : raw);
        }
        return out;
    }

    private static JSONArray emptyRow(int columns) {
        JSONArray row = new JSONArray();
        for (int i = 0; i < columns; i++) row.put("");
        return row;
    }

    private static void put(JSONArray row, int index, Object value) {
        try { row.put(index, value == null ? "" : value); }
        catch (Throwable ignored) {}
    }

    private static String cellString(JSONArray row, int index) {
        if (row == null) return "";
        Object value = row.opt(index);
        if (value == null || value == JSONObject.NULL) return "";
        return String.valueOf(value).trim();
    }

    private static int rowNumber(String range) {
        if (range == null) return 0;
        int colon = range.indexOf(':');
        String first = colon >= 0 ? range.substring(0, colon) : range;
        int i = first.length() - 1;
        while (i >= 0 && Character.isDigit(first.charAt(i))) i--;
        try { return Integer.parseInt(first.substring(i + 1)); }
        catch (Throwable ignored) { return 0; }
    }

    private static String remoteStatus(CaptureItem item) {
        if (item == null || item.status == null) return "PENDING";
        if ("APPROVED".equals(item.status) || "DONE".equals(item.status) || "PENDING".equals(item.status)) return item.status;
        return "PENDING";
    }

    private static String iso(long millis) {
        return millis <= 0 ? "" : Instant.ofEpochMilli(millis).toString();
    }

    private static long millis(Object value) {
        if (value == null || value == JSONObject.NULL) return 0;
        if (value instanceof Number) return ((Number) value).longValue();
        String text = String.valueOf(value).trim();
        if (text.isEmpty()) return 0;
        try { return Instant.parse(text).toEpochMilli(); }
        catch (DateTimeParseException ignored) {}
        try { return Long.parseLong(text); }
        catch (Throwable ignored) { return 0; }
    }

    private static int number(Object value, int fallback) {
        if (value instanceof Number) return ((Number) value).intValue();
        try { return Integer.parseInt(String.valueOf(value)); }
        catch (Throwable ignored) { return fallback; }
    }

    private static boolean bool(Object value) {
        return value instanceof Boolean ? (Boolean) value : "TRUE".equalsIgnoreCase(String.valueOf(value));
    }

    private static void checkInterrupted() throws InterruptedException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedException("동기화 작업이 중지되었습니다");
    }

    private static String enc(String value) throws Exception { return URLEncoder.encode(value, "UTF-8").replace("+", "%20"); }
    private static String value(String value, String fallback) { return value == null || value.isEmpty() ? fallback : value; }
    private static String safe(Throwable error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().isEmpty() ? (error == null ? "알 수 없는 오류" : error.getClass().getSimpleName()) : message;
    }

    private static final class RemoteBook {
        final LinkedHashMap<String,RemoteItem> items = new LinkedHashMap<>();
        final Map<String,RemoteAttachment> attachments = new HashMap<>();
        final Set<String> auditIds = new HashSet<>();
    }

    private static final class RemoteItem {
        final int row;
        final JSONArray cells;
        RemoteItem(int row, JSONArray cells) { this.row = row; this.cells = cells; }
        String string(int index) { return cellString(cells, index); }
        boolean bool(int index) { return GoogleSyncEngine.bool(cells.opt(index)); }
        String status() { return string(1); }
        int version() { return number(cells.opt(16), 1); }
        long updatedAt() { return millis(cells.opt(12)); }
        RemoteCapture capture() {
            RemoteCapture capture = new RemoteCapture();
            capture.uuid = string(0);
            capture.status = value(status(), "PENDING");
            capture.sourceType = value(string(2), "WEB");
            capture.area = value(string(3), "PERSONAL");
            capture.kind = value(string(4), "UNKNOWN");
            capture.title = string(5);
            capture.startAt = millis(cells.opt(6));
            capture.endAt = millis(cells.opt(7));
            capture.reminderAt = millis(cells.opt(8));
            capture.transcript = string(9);
            capture.createdAt = millis(cells.opt(11));
            capture.updatedAt = updatedAt();
            capture.approvedAt = millis(cells.opt(13));
            capture.version = version();
            capture.remoteCalendarEnabled = bool(17);
            capture.remoteCalendarId = string(18);
            capture.remoteCalendarEventId = string(19);
            return capture;
        }
    }

    private static final class RemoteAttachment {
        final int row;
        final JSONArray cells;
        RemoteAttachment(int row, JSONArray cells) { this.row = row; this.cells = cells; }
        String string(int index) { return cellString(cells, index); }
    }

    private static final class HttpResponse {
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

    private static final class HttpFailure extends Exception {
        final int code;
        HttpFailure(int code, String message) { super(message); this.code = code; }
    }
}
