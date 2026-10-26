package com.malhaedwo.pttprobe;

import android.content.Context;

/** 컴파일 검사용 모양(실제는 src/CalendarRefreshJob.java, JobService라 스텁 검사에서 빠짐). */
public final class CalendarRefreshJob {
    static final String ACTION_SHARED = "com.malhaedwo.pttprobe.BLACKHOLE_SHARED";
    static void schedule(Context context) {}
    static void soon(Context context) {}
    static void refreshAsync(Context context) {}
    static void publish(Context context) {}
}
