package com.malhaedwo.pttprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
                !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) &&
                !Intent.ACTION_TIME_CHANGED.equals(action) &&
                !Intent.ACTION_TIMEZONE_CHANGED.equals(action)) return;
        BroadcastReceiver.PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                CaptureAutomation.processAllReady(app);
                SyncScheduler.ensurePeriodic(app);
                SyncScheduler.request(app);
                BlackholeAlarms.restoreAll(app);
                BlackholeQuickNotification.refresh(app);
                Blackhole.requestUpload(app);
                // 업데이트·재부팅 뒤에도 휴대폰 달력 받기를 다시 건다(예전 30분 등록은 15분으로 바뀜).
                CalendarRefreshJob.schedule(app);
            } finally { pending.finish(); }
        }, "MalhaedwoReschedule").start();
    }
}
