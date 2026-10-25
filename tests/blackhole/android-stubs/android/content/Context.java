package android.content;
import java.io.File;
public abstract class Context {
  public static final int MODE_PRIVATE=0; public static final int RECEIVER_NOT_EXPORTED=4;
  public Context getApplicationContext() { throw new RuntimeException("stub"); }
  public SharedPreferences getSharedPreferences(String name, int mode) { throw new RuntimeException("stub"); }
  public <T> T getSystemService(Class<T> type) { throw new RuntimeException("stub"); }
  public File getFilesDir() { throw new RuntimeException("stub"); }
  public int checkSelfPermission(String permission) { throw new RuntimeException("stub"); }
  public void sendBroadcast(Intent intent) { throw new RuntimeException("stub"); }
  public String getPackageName() { throw new RuntimeException("stub"); }
  public ContentResolver getContentResolver() { throw new RuntimeException("stub"); }
  public android.content.res.Resources getResources() { throw new RuntimeException("stub"); }
  public Intent registerReceiver(BroadcastReceiver receiver, IntentFilter filter, int flags) { throw new RuntimeException("stub"); }
  public void unregisterReceiver(BroadcastReceiver receiver) { throw new RuntimeException("stub"); }
  public void startActivity(Intent intent) { throw new RuntimeException("stub"); }
}
