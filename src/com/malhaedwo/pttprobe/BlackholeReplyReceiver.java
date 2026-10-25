package com.malhaedwo.pttprobe;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 고정 알림의 [적기] 바로 답장. 받은 글을 보내기 대기열에 넣고, 알림에는 보낸 시각만 남긴다(내용은 남기지 않음). */
public final class BlackholeReplyReceiver extends BroadcastReceiver {
    static final String ACTION_REPLY = "com.malhaedwo.pttprobe.BLACKHOLE_REPLY";

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_REPLY.equals(intent.getAction())) return;
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence text = results == null ? null : results.getCharSequence(BlackholeQuickNotification.KEY_TEXT);
        Context app = context.getApplicationContext();
        String line;
        if (text == null || text.toString().trim().isEmpty()) {
            line = BlackholeQuickNotification.IDLE_TEXT;
        } else {
            try {
                Blackhole.outbox(app).addText(text.toString(), BlackholeOutbox.SOURCE_LOCK, System.currentTimeMillis());
                Blackhole.requestUpload(app);
                line = "보냈습니다 " + new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date()) + " · 이어서 말하기·적기·사진";
            } catch (Exception error) {
                line = "보내지 못했습니다: " + error.getMessage();
            }
        }
        // 다시 걸어야 답장 입력칸의 「보내는 중」 표시가 사라진다.
        BlackholeQuickNotification.show(app, line);
        app.sendBroadcast(new Intent(BlackholeUploadJob.ACTION_CHANGED).setPackage(app.getPackageName()));
    }
}
