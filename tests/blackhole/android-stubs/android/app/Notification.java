package android.app;
import android.content.Context; import android.graphics.drawable.Icon;
public class Notification { public int flags; public static final int FLAG_INSISTENT=4, VISIBILITY_PUBLIC=1;
  public static final String CATEGORY_SERVICE="service", CATEGORY_ALARM="alarm", CATEGORY_REMINDER="reminder", CATEGORY_STATUS="status";
  public static class Builder { public Builder(Context c, String channel) {}
    public Builder setSmallIcon(int icon) { throw new RuntimeException("stub"); } public Builder setContentTitle(CharSequence t) { throw new RuntimeException("stub"); } public Builder setContentText(CharSequence t) { throw new RuntimeException("stub"); }
    public Builder setOngoing(boolean b) { throw new RuntimeException("stub"); } public Builder setOnlyAlertOnce(boolean b) { throw new RuntimeException("stub"); } public Builder setShowWhen(boolean b) { throw new RuntimeException("stub"); }
    public Builder setVisibility(int v) { throw new RuntimeException("stub"); } public Builder setCategory(String c) { throw new RuntimeException("stub"); } public Builder setContentIntent(PendingIntent p) { throw new RuntimeException("stub"); }
    public Builder addAction(Action a) { throw new RuntimeException("stub"); } public Builder setPublicVersion(Notification n) { throw new RuntimeException("stub"); } public Builder setAutoCancel(boolean b) { throw new RuntimeException("stub"); }
    public Builder setGroup(String g) { throw new RuntimeException("stub"); } public Builder setGroupSummary(boolean b) { throw new RuntimeException("stub"); } public Builder setSortKey(String k) { throw new RuntimeException("stub"); }
    public Builder setTimeoutAfter(long ms) { throw new RuntimeException("stub"); } public Builder setFullScreenIntent(PendingIntent p, boolean high) { throw new RuntimeException("stub"); } public Notification build() { throw new RuntimeException("stub"); } }
  public static class Action { public static final class Builder { public Builder(Icon icon, CharSequence title, PendingIntent intent) {}
    public Builder addRemoteInput(RemoteInput r) { throw new RuntimeException("stub"); } public Builder setAllowGeneratedReplies(boolean b) { throw new RuntimeException("stub"); }
    public Builder setAuthenticationRequired(boolean b) { throw new RuntimeException("stub"); } public Action build() { throw new RuntimeException("stub"); } } } }
