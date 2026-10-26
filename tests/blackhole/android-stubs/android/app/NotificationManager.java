package android.app;
public class NotificationManager { public static final int IMPORTANCE_LOW=2, IMPORTANCE_DEFAULT=3, IMPORTANCE_HIGH=4;
  public static final int INTERRUPTION_FILTER_ALL=1, INTERRUPTION_FILTER_PRIORITY=2, INTERRUPTION_FILTER_NONE=3, INTERRUPTION_FILTER_ALARMS=4;
  public static class Policy { public static final int PRIORITY_CATEGORY_ALARMS=32; public final int priorityCategories = 0; }
  public NotificationChannel getNotificationChannel(String id) { throw new RuntimeException("stub"); } public void createNotificationChannel(NotificationChannel c) { throw new RuntimeException("stub"); }
  public int getCurrentInterruptionFilter() { throw new RuntimeException("stub"); } public Policy getNotificationPolicy() { throw new RuntimeException("stub"); }
  public void notify(int id, Notification n) { throw new RuntimeException("stub"); } public void cancel(int id) { throw new RuntimeException("stub"); } public boolean canUseFullScreenIntent() { throw new RuntimeException("stub"); } }
