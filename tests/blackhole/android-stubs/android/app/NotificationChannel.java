package android.app;
import android.media.AudioAttributes; import android.net.Uri;
public final class NotificationChannel { public NotificationChannel(String id, CharSequence name, int importance) {}
  public void setDescription(String d) { throw new RuntimeException("stub"); } public void setShowBadge(boolean b) { throw new RuntimeException("stub"); } public void setLockscreenVisibility(int v) { throw new RuntimeException("stub"); }
  public void setSound(Uri sound, AudioAttributes a) { throw new RuntimeException("stub"); } public void enableVibration(boolean b) { throw new RuntimeException("stub"); } public void setVibrationPattern(long[] p) { throw new RuntimeException("stub"); }
  public void setBypassDnd(boolean b) { throw new RuntimeException("stub"); } }
