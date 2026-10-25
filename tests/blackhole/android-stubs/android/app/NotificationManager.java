package android.app;
public class NotificationManager { public static final int IMPORTANCE_LOW=2, IMPORTANCE_HIGH=4;
  public NotificationChannel getNotificationChannel(String id) { throw new RuntimeException("stub"); } public void createNotificationChannel(NotificationChannel c) { throw new RuntimeException("stub"); }
  public void notify(int id, Notification n) { throw new RuntimeException("stub"); } public void cancel(int id) { throw new RuntimeException("stub"); } public boolean canUseFullScreenIntent() { throw new RuntimeException("stub"); } }
