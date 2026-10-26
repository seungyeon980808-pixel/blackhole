package com.malhaedwo.pttprobe;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.widget.Toast;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 다른 앱의 공유 메뉴 「블랙홀로 보내기」. 사진·파일·문장(ACTION_SEND / SEND_MULTIPLE)을 받아
 * 받은 권한이 사라지기 전에 보내기 대기열로 복사하고, 안내만 띄운 뒤 닫는다. 지난 내용은 보여 주지 않는다.
 */
public final class BlackholeShareActivity extends Activity {
    interface Finished { void finished(String message); }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        String action = intent == null ? null : intent.getAction();
        List<Uri> uris = new ArrayList<>();
        String text = null;
        if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) uris.add(stream);
            text = sharedText(intent);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) for (Uri uri : streams) if (uri != null) uris.add(uri);
            text = sharedText(intent);
        }
        if (uris.isEmpty() && (text == null || text.trim().isEmpty())) {
            Toast.makeText(this, "보낼 내용이 없습니다", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        importAsync(this, uris, text, BlackholeOutbox.SOURCE_SHARE, message -> {
            Toast.makeText(getApplicationContext(), message, Toast.LENGTH_SHORT).show();
            finish();
        });
    }

    private static String sharedText(Intent intent) {
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String body = text == null ? "" : text.toString().trim();
        if (subject != null && !subject.trim().isEmpty() && !body.startsWith(subject.trim())) {
            body = subject.trim() + (body.isEmpty() ? "" : "\n" + body);
        }
        return body;
    }

    /** 공유·파일 고르기 공용: 뒤에서 복사하고, 끝나면 화면 스레드에서 알려 준다. */
    static void importAsync(Activity activity, List<Uri> uris, String text, String source, Finished finished) {
        Context app = activity.getApplicationContext();
        ContentResolver resolver = activity.getContentResolver();
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            BlackholeOutbox outbox = Blackhole.outbox(app);
            int ok = 0;
            int failed = 0;
            String firstError = "";
            long now = System.currentTimeMillis();
            for (Uri uri : uris) {
                try {
                    // file:// 이나 이 앱 자신의 제공자 주소를 받으면 앱 내부 파일(DB·토큰)이 밖으로 나갈 수 있다.
                    if (!BlackholeOutbox.acceptsSharedUri(uri.getScheme(), uri.getAuthority())) throw new SecurityException("허용되지 않은 주소");
                    String name = displayName(resolver, uri);
                    String mime = resolver.getType(uri);
                    String kind = mime != null && mime.toLowerCase(Locale.ROOT).startsWith("image/")
                            ? BlackholeOutbox.KIND_PHOTO : BlackholeOutbox.KIND_FILE;
                    try (InputStream input = resolver.openInputStream(uri)) {
                        if (input == null) throw new java.io.IOException("파일을 열 수 없습니다");
                        outbox.addStream(input, kind, source, name, mime, now++);
                    }
                    ok++;
                } catch (Throwable error) {
                    failed++;
                    if (firstError.isEmpty()) firstError = Blackhole.localError(error);
                }
            }
            if (text != null && !text.trim().isEmpty()) {
                try {
                    Blackhole.sendText(app, text, source);
                    ok++;
                } catch (Throwable error) {
                    failed++;
                    if (firstError.isEmpty()) firstError = Blackhole.localError(error);
                }
            }
            if (ok > 0) Blackhole.requestUpload(app);
            String message = ok > 0 ? "블랙홀로 보냈습니다" + (ok > 1 ? " (" + ok + "개)" : "") : "보내지 못했습니다";
            if (failed > 0) message += " · 실패 " + failed + " (" + firstError + ")";
            String result = message;
            main.post(() -> finished.finished(result));
        }, "BlackholeImport").start();
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null) return name;
            }
        } catch (Throwable ignored) {}
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }
}
