package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 블랙홀 달력: 데스크톱과 같은 달력 화면(assets/calendar, desktop/src/calendar 빌드)을 WebView로 띄운다.
 * 일정은 Mac이 드라이브 「블랙홀/달력.json」에 둔 사본을 보여 주고(BlackholeCalendarSync), 입력은 보내기
 * 대기열 → 드라이브 인박스로 보낸다(분석은 Mac). 휴대폰에서 누른 확정·체크는 「*.bhact」 동작 파일로 보낸다.
 * 지난 일정이 보이므로 잠금화면 위에는 뜨지 않는다. 앱 밖 주소로는 이동하지 않는다.
 */
public final class CalendarWebActivity extends Activity {
    static final String ORIGIN_HOST = "appassets.androidplatform.net";
    static final String START_URL = "https://" + ORIGIN_HOST + "/calendar/phone.html";
    private static final int REQUEST_MIC = 41;
    private static final int REQUEST_CALENDAR = 42;

    private WebView web;
    private PermissionRequest waitingMic;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("블랙홀 달력");
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return asset(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !START_URL.equals(request.getUrl().toString());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> micRequest(request));
            }
        });
        web.addJavascriptInterface(new Bridge(), "BlackholeAndroid");
        SystemBarInsets.setContentView(this, web, Color.rgb(13, 15, 32));
        web.loadUrl(START_URL);
        CalendarRefreshJob.schedule(this);
    }

    @Override public void onBackPressed() {
        finish();
    }

    @Override protected void onDestroy() {
        io.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** 이 앱의 달력 묶음만 내보내고, 그 밖의 주소는 막는다. */
    private WebResourceResponse asset(Uri url) {
        String path = url.getPath() == null ? "" : url.getPath();
        if (!"https".equals(url.getScheme()) || !ORIGIN_HOST.equals(url.getHost()) || !path.startsWith("/calendar/") || path.contains("..")) {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
        try {
            InputStream input = getAssets().open(path.substring(1));
            return new WebResourceResponse(mime(path), "utf-8", input);
        } catch (IOException missing) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
    }

    static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /** 「말하기」: 달력 화면이 마이크를 요청하면 녹음 권한을 확인해 그 요청에만 허락한다. */
    private void micRequest(PermissionRequest request) {
        boolean audioOnly = request.getResources().length == 1 && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0]);
        if (!audioOnly || !START_URL.startsWith(request.getOrigin().toString())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            waitingMic = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == REQUEST_CALENDAR) {
            mirrorNow();
            return;
        }
        if (code != REQUEST_MIC || waitingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) waitingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else waitingMic.deny();
        waitingMic = null;
    }

    private SharedPreferences prefs() { return Blackhole.prefs(this); }

    /** 지금 가진 Mac 사본을 구글 캘린더에 반영하고, 끝나면 화면에 알린다. */
    private void mirrorNow() {
        io.execute(() -> {
            String status = CalendarMirrorWriter.sync(this, prefs().getString(BlackholeCalendarStore.PREF_SHARED, "{}"));
            prefs().edit().putString(BlackholeCalendarMirror.PREF_STATUS, status).apply();
            if (web != null) web.post(() -> web.evaluateJavascript("window.blackholeCalendars&&window.blackholeCalendars()", null));
        });
    }

    private File stateFile() { return new File(new File(getFilesDir(), "blackhole-calendar"), "state.json"); }

    private static String reply(boolean ok, String message) {
        try { return new JSONObject().put("ok", ok).put("message", message == null ? "" : message).toString(); }
        catch (Exception error) { return "{\"ok\":false,\"message\":\"\"}"; }
    }

    private static String clock() { return new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date()); }

    /** 달력 화면이 부르는 함수들. 화면 스레드가 아니라 WebView 스레드에서 불린다. */
    final class Bridge {
        @JavascriptInterface public String loadState() {
            try { return new String(Files.readAllBytes(stateFile().toPath()), StandardCharsets.UTF_8); }
            catch (Exception missing) { return ""; }
        }

        @JavascriptInterface public void saveState(String json) {
            File file = stateFile();
            //noinspection ResultOfMethodCallIgnored
            file.getParentFile().mkdirs();
            File part = new File(file.getPath() + ".part");
            try (FileOutputStream out = new FileOutputStream(part)) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            } catch (IOException error) {
                return;
            }
            //noinspection ResultOfMethodCallIgnored
            part.renameTo(file);
        }

        @JavascriptInterface public String sendText(String text) {
            try {
                Blackhole.outbox(CalendarWebActivity.this).addText(text, BlackholeOutbox.SOURCE_CHAT, System.currentTimeMillis());
                Blackhole.requestUpload(CalendarWebActivity.this);
                return reply(true, "");
            } catch (IOException error) {
                return reply(false, error.getMessage());
            }
        }

        @JavascriptInterface public String sendFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String kind = mime.startsWith("image/") ? BlackholeOutbox.KIND_PHOTO : mime.startsWith("audio/") ? BlackholeOutbox.KIND_VOICE : BlackholeOutbox.KIND_FILE;
                Blackhole.outbox(CalendarWebActivity.this).addStream(new ByteArrayInputStream(bytes), kind, BlackholeOutbox.SOURCE_CHAT,
                        name, mime.endsWith("/*") ? "" : mime, System.currentTimeMillis());
                Blackhole.requestUpload(CalendarWebActivity.this);
                return reply(true, "");
            } catch (Exception error) {
                return reply(false, error.getMessage());
            }
        }

        /** 달력의 알림 시각을 전화식 알람으로 건다. 달력에서 빠진 알림은 풀어 준다. */
        @JavascriptInterface public void scheduleAlarms(String json) {
            List<BlackholeCalendarStore.CalendarAlarm> wanted = BlackholeCalendarStore.alarms(json, System.currentTimeMillis());
            Set<String> keep = new HashSet<>();
            BlackholeAlarmBook book = BlackholeAlarms.load(CalendarWebActivity.this);
            for (BlackholeCalendarStore.CalendarAlarm alarm : wanted) {
                keep.add(alarm.id);
                BlackholeAlarmBook.Alarm known = book.get(alarm.id);
                // 이미 같은 시각으로 걸려 있거나, 울렸거나 미뤄 둔 알람은 다시 걸지 않는다.
                if (known != null && (known.at == alarm.at || !known.waiting() || BlackholeAlarmBook.SNOOZED.equals(known.state))) continue;
                BlackholeAlarms.schedule(CalendarWebActivity.this, alarm.id, alarm.title, alarm.at);
            }
            prefs().edit().putString(BlackholeCalendarStore.PREF_ALARM_KEYS, BlackholeCalendarStore.keys(wanted)).apply();
            for (String old : BlackholeCalendarStore.ids(prefs().getString(BlackholeCalendarStore.PREF_ALARM_IDS, ""))) {
                if (!keep.contains(old)) BlackholeAlarms.cancel(CalendarWebActivity.this, old);
            }
            prefs().edit().putString(BlackholeCalendarStore.PREF_ALARM_IDS, String.join(",", keep)).apply();
        }

        @JavascriptInterface public String sharedCopy() {
            return prefs().getString(BlackholeCalendarStore.PREF_SHARED, "");
        }

        @JavascriptInterface public void refreshShared() {
            io.execute(() -> {
                CalendarRefreshJob.refresh(CalendarWebActivity.this);
                if (web != null) web.post(() -> web.evaluateJavascript("window.blackholeShared&&window.blackholeShared()", null));
            });
        }

        /** 5단계: 잠금화면 배경, 학교 일정 제목 가리기(위젯·잠금화면). */
        @JavascriptInterface public String boardOptions() {
            try {
                return new JSONObject().put("lock", prefs().getBoolean(BlackholeBoard.PREF_LOCK, false))
                        .put("hideSchool", prefs().getBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, false))
                        .put("status", prefs().getString(BlackholeBoard.PREF_STATUS, "")).toString();
            } catch (Exception error) {
                return "{}";
            }
        }

        @JavascriptInterface public void setBoardOptions(boolean lock, boolean hideSchool) {
            prefs().edit().putBoolean(BlackholeBoard.PREF_LOCK, lock).putBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, hideSchool).apply();
            CalendarRefreshJob.forgetLock(CalendarWebActivity.this);
            io.execute(() -> CalendarRefreshJob.publish(CalendarWebActivity.this));
        }

        /** 손으로 바꾼 것: Mac이 반영할 때까지 들고 있고, 인박스로 동작 파일을 보낸다. */
        @JavascriptInterface public void recordAction(String json) {
            try {
                BlackholeCalendarActions.record(CalendarWebActivity.this, json);
            } catch (Exception ignored) {
                // 형식이 틀린 동작은 버린다(화면에는 이미 반영됨, 다음 사본에서 되돌아감).
            }
        }

        /** 4단계: 고를 수 있는 캘린더와 지금 설정. */
        @JavascriptInterface public String googleCalendars() {
            try {
                org.json.JSONArray list = new org.json.JSONArray();
                for (CalendarSync.CalendarOption option : CalendarSync.listWritable(CalendarWebActivity.this)) {
                    list.put(new JSONObject().put("id", String.valueOf(option.id)).put("name", option.toString()));
                }
                return new JSONObject()
                        .put("permission", CalendarSync.hasPermission(CalendarWebActivity.this))
                        .put("enabled", prefs().getBoolean(BlackholeCalendarMirror.PREF_ENABLED, false))
                        .put("provisional", prefs().getString(BlackholeCalendarMirror.PREF_PROVISIONAL, ""))
                        .put("main", prefs().getString(BlackholeCalendarMirror.PREF_MAIN, ""))
                        .put("status", prefs().getString(BlackholeCalendarMirror.PREF_STATUS, ""))
                        .put("calendars", list).toString();
            } catch (Exception error) {
                return "{}";
            }
        }

        @JavascriptInterface public void setGoogleCalendars(boolean enabled, String provisional, String main) {
            prefs().edit().putBoolean(BlackholeCalendarMirror.PREF_ENABLED, enabled)
                    .putString(BlackholeCalendarMirror.PREF_PROVISIONAL, provisional == null ? "" : provisional)
                    .putString(BlackholeCalendarMirror.PREF_MAIN, main == null ? "" : main).apply();
            if (enabled && !CalendarSync.hasPermission(CalendarWebActivity.this)) {
                runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR}, REQUEST_CALENDAR));
            } else {
                mirrorNow();
            }
        }

        @JavascriptInterface public String pendingActions() {
            return prefs().getString(BlackholeCalendarStore.PREF_PENDING, "[]");
        }

        @JavascriptInterface public String syncStatus() {
            return prefs().getString(BlackholeCalendarStore.PREF_STATUS, "아직 받지 않음");
        }
    }
}
