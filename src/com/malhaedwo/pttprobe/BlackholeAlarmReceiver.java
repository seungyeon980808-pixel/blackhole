package com.malhaedwo.pttprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/** 알람 시각(FIRE), 울림 시간 끝(TIMEOUT, 놓친 알람)과 알림 단추(확인·완료·10분 뒤)를 받는다. 내보내지 않는 수신기다. */
public final class BlackholeAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        String id = intent == null ? null : intent.getStringExtra(BlackholeAlarms.EXTRA_ID);
        if (action == null || id == null || id.isEmpty()) return;
        if (BlackholeAlarms.ACTION_FIRE.equals(action)) {
            BlackholeAlarms.fire(context, id);
        } else if (BlackholeAlarms.ACTION_TIMEOUT.equals(action)) {
            BlackholeAlarms.timeout(context, id);
        } else if (BlackholeAlarms.ACTION_ACK.equals(action) || BlackholeAlarms.ACTION_DONE.equals(action)
                || BlackholeAlarms.ACTION_SNOOZE.equals(action)) {
            String message = BlackholeAlarms.handle(context, id, action);
            Toast.makeText(context.getApplicationContext(), message, Toast.LENGTH_SHORT).show();
        }
    }
}
