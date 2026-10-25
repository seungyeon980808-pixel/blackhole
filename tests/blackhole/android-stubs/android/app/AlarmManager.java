package android.app;
public class AlarmManager { public boolean canScheduleExactAlarms() { throw new RuntimeException("stub"); } public void setAlarmClock(AlarmClockInfo info, PendingIntent operation) { throw new RuntimeException("stub"); }
  public void cancel(PendingIntent operation) { throw new RuntimeException("stub"); } public static final class AlarmClockInfo { public AlarmClockInfo(long triggerTime, PendingIntent showIntent) {} } }
