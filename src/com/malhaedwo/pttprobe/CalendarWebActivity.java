package com.malhaedwo.pttprobe;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
    /** 위젯 줄을 눌렀을 때 열 날짜(yyyy-MM-dd): 그날 일 보기로 연다. */
    static final String EXTRA_DAY = "blackhole_day";
    private static final int REQUEST_MIC = 41;
    private static final int REQUEST_CALENDAR = 42;

    private WebView web;
    private PermissionRequest waitingMic;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private boolean listening;
    /** 새 Mac 사본(주기 작업·보낸 뒤 받기) 또는 휴대폰 초안(보내기 화면·잠금화면·받아쓰기)이 생기면 바로 다시 그린다. */
    private final BroadcastReceiver changed = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (web == null || intent == null) return;
            String js = CalendarRefreshJob.ACTION_SHARED.equals(intent.getAction())
                    ? "window.blackholeShared&&window.blackholeShared()" : "window.blackholeDrafts&&window.blackholeDrafts()";
            web.post(() -> web.evaluateJavascript(js, null));
        }
    };

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
        String day = day(getIntent());
        web.loadUrl(day.isEmpty() ? START_URL : START_URL + "#day=" + day);
        CalendarRefreshJob.schedule(this);
    }

    /** 이미 열려 있을 때 위젯 줄을 누르면 그 날짜로 옮긴다. 날짜 없이 열면 그대로 둔다. */
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String day = day(intent);
        if (web != null && !day.isEmpty()) web.evaluateJavascript("window.blackholeOpenDay&&window.blackholeOpenDay('" + day + "')", null);
    }

    /** 날짜 모양(yyyy-MM-dd)만 받는다(자바스크립트에 그대로 넣으므로). */
    static String day(Intent intent) {
        String day = intent == null ? null : intent.getStringExtra(EXTRA_DAY);
        return day != null && day.matches("\\d{4}-\\d{2}-\\d{2}") ? day : "";
    }

    @Override protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(CalendarRefreshJob.ACTION_SHARED);
        filter.addAction(Blackhole.ACTION_DRAFTS);
        registerReceiver(changed, filter, Context.RECEIVER_NOT_EXPORTED);
        listening = true;
    }

    @Override protected void onStop() {
        if (listening) {
            unregisterReceiver(changed);
            listening = false;
        }
        super.onStop();
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
        return reply(ok, message, "");
    }

    /** job: Mac 작업기가 이 원본에 줄 작업 id(초안과 Mac 결과를 잇는 열쇠). */
    private static String reply(boolean ok, String message, String job) {
        try { return new JSONObject().put("ok", ok).put("message", message == null ? "" : message).put("job", job).toString(); }
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

        /** 문장 보내기. 초안은 달력 화면이 같은 규칙으로 만들어 keepDrafts로 넘긴다(여기서 또 만들지 않음). */
        @JavascriptInterface public String sendText(String text) {
            try {
                BlackholeOutbox.Entry entry = Blackhole.outbox(CalendarWebActivity.this).addText(text, BlackholeOutbox.SOURCE_CHAT, System.currentTimeMillis());
                Blackhole.requestUpload(CalendarWebActivity.this);
                return reply(true, "", BlackholeDrafts.jobId(entry.sha256));
            } catch (IOException error) {
                return reply(false, Blackhole.localError(error));
            }
        }

        @JavascriptInterface public void keepDrafts(String json) {
            Blackhole.keepDrafts(CalendarWebActivity.this, json);
        }

        @JavascriptInterface public String localDrafts() {
            return Blackhole.drafts(CalendarWebActivity.this);
        }

        @JavascriptInterface public String sendFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String kind = mime.startsWith("image/") ? BlackholeOutbox.KIND_PHOTO : mime.startsWith("audio/") ? BlackholeOutbox.KIND_VOICE : BlackholeOutbox.KIND_FILE;
                BlackholeOutbox.Entry entry = Blackhole.outbox(CalendarWebActivity.this).addStream(new ByteArrayInputStream(bytes), kind, BlackholeOutbox.SOURCE_CHAT,
                        name, mime.endsWith("/*") ? "" : mime, System.currentTimeMillis());
                Blackhole.requestUpload(CalendarWebActivity.this);
                // 「말하기」 녹음: 기기 안 받아쓰기로 초안(끝나면 blackholeDrafts로 화면에 알림).
                BlackholeVoiceText.transcribe(CalendarWebActivity.this, entry);
                return reply(true, "", BlackholeDrafts.jobId(entry.sha256));
            } catch (Exception error) {
                return reply(false, Blackhole.localError(error));
            }
        }

        /** 달력의 알림 시각을 전화식 알람으로 건다. 달력에서 빠진 알림은 풀어 준다. */
        @JavascriptInterface public void scheduleAlarms(String json) {
            BlackholeAlarms.syncCalendar(CalendarWebActivity.this, json);
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
                        .put("status", prefs().getString(BlackholeBoard.PREF_STATUS, ""))
                        .put("bright", prefs().getInt(BlackholeBoard.PREF_BRIGHT, 0))
                        .put("opacity", prefs().getInt(BlackholeBoard.PREF_OPACITY, 100))
                        .put("lockTasks", prefs().getBoolean(BlackholeBoard.PREF_LOCK_TASKS, true))
                        .put("lockHideTitles", prefs().getBoolean(BlackholeBoard.PREF_LOCK_HIDE_TITLES, false)).toString();
            } catch (Exception error) {
                return "{}";
            }
        }

        @JavascriptInterface public void setBoardOptions(boolean lock, boolean hideSchool) {
            prefs().edit().putBoolean(BlackholeBoard.PREF_LOCK, lock).putBoolean(BlackholeBoard.PREF_HIDE_SCHOOL, hideSchool).apply();
            CalendarRefreshJob.forgetLock(CalendarWebActivity.this);
            io.execute(() -> CalendarRefreshJob.publish(CalendarWebActivity.this));
        }

        /** 홈 화면에 블랙홀 위젯 추가(시스템이 확인 창을 띄운다). 안 되면 false. */
        @JavascriptInterface public boolean pinWidget() {
            android.appwidget.AppWidgetManager manager = android.appwidget.AppWidgetManager.getInstance(CalendarWebActivity.this);
            if (manager == null || !manager.isRequestPinAppWidgetSupported()) return false;
            return manager.requestPinAppWidget(new android.content.ComponentName(CalendarWebActivity.this, CalendarWidgetProvider.class), null, null);
        }

        /** 위젯·잠금화면 그림의 밝기(-50~50)·판 불투명도(0~150%). */
        @JavascriptInterface public void setBoardLook(int bright, int opacity) {
            prefs().edit().putInt(BlackholeBoard.PREF_BRIGHT, Math.max(-50, Math.min(50, bright)))
                    .putInt(BlackholeBoard.PREF_OPACITY, Math.max(0, Math.min(150, opacity))).apply();
            CalendarRefreshJob.forgetLock(CalendarWebActivity.this);
            io.execute(() -> CalendarRefreshJob.publish(CalendarWebActivity.this));
        }

        /** 잠금화면 알림의 할 일 목록(「완료」)과 제목 가리기. */
        @JavascriptInterface public void setLockTasks(boolean show, boolean hideTitles) {
            prefs().edit().putBoolean(BlackholeBoard.PREF_LOCK_TASKS, show).putBoolean(BlackholeBoard.PREF_LOCK_HIDE_TITLES, hideTitles).apply();
            io.execute(() -> BlackholeQuickNotification.refresh(CalendarWebActivity.this));
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
