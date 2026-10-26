package com.malhaedwo.pttprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

/**
 * 잠금화면 알림의 「완료」: 잠금을 풀지 않고 할 일을 끝낸다. 휴대폰 달력·위젯·잠금화면에는 바로 보이고
 * (Mac이 반영할 때까지 대기 동작으로 얹음), Mac에는 기존 동작 파일(*.bhact) 길로 간다. 끝내기만 하고 지우기·고치기는 없다.
 */
public final class BlackholeTaskReceiver extends BroadcastReceiver {
    static final String ACTION_DONE = "com.malhaedwo.pttprobe.BLACKHOLE_TASK_DONE";
    static final String EXTRA_ID = "task_id";
    static final String EXTRA_SRC = "task_src";

    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DONE.equals(intent.getAction())) return;
        String id = intent.getStringExtra(EXTRA_ID);
        if (id == null || id.isEmpty()) return;
        Context app = context.getApplicationContext();
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                String at = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.ROOT).format(new Date());
                String action = BlackholeCalendarStore.completeAction("lock-" + UUID.randomUUID().toString().substring(0, 12), at, id,
                        intent.getStringExtra(EXTRA_SRC));
                if (action != null) BlackholeCalendarActions.record(app, action);
                app.sendBroadcast(new Intent(Blackhole.ACTION_DRAFTS).setPackage(app.getPackageName()));
                CalendarRefreshJob.publish(app);
            } catch (Exception ignored) {
                // 기록하지 못하면 알림은 그대로 남아 다시 누를 수 있다.
            } finally {
                pending.finish();
            }
        }, "BlackholeTaskDone").start();
    }
}
