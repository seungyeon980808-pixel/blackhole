package android.content;
public abstract class BroadcastReceiver { public abstract void onReceive(Context context, Intent intent);
  public final PendingResult goAsync() { throw new RuntimeException("stub"); } public static class PendingResult { public final void finish() { throw new RuntimeException("stub"); } } }
