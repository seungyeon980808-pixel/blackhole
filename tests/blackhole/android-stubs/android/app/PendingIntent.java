package android.app;
import android.content.*;
public final class PendingIntent { public static final int FLAG_UPDATE_CURRENT=1<<27, FLAG_IMMUTABLE=1<<26, FLAG_MUTABLE=1<<25;
  public static PendingIntent getActivity(Context c, int code, Intent i, int flags) { throw new RuntimeException("stub"); }
  public static PendingIntent getBroadcast(Context c, int code, Intent i, int flags) { throw new RuntimeException("stub"); } }
