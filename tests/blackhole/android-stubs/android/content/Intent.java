package android.content;
import android.net.Uri; import android.os.Parcelable; import java.util.ArrayList;
public class Intent implements Parcelable {
  public static final String ACTION_SEND="android.intent.action.SEND", ACTION_SEND_MULTIPLE="android.intent.action.SEND_MULTIPLE",
    EXTRA_STREAM="android.intent.extra.STREAM", EXTRA_TEXT="android.intent.extra.TEXT", EXTRA_SUBJECT="android.intent.extra.SUBJECT",
    ACTION_GET_CONTENT="android.intent.action.GET_CONTENT", EXTRA_MIME_TYPES="android.intent.extra.MIME_TYPES",
    EXTRA_ALLOW_MULTIPLE="android.intent.extra.ALLOW_MULTIPLE", CATEGORY_OPENABLE="android.intent.category.OPENABLE",
    ACTION_BOOT_COMPLETED="android.intent.action.BOOT_COMPLETED", ACTION_MY_PACKAGE_REPLACED="android.intent.action.MY_PACKAGE_REPLACED",
    ACTION_TIME_CHANGED="android.intent.action.TIME_SET", ACTION_TIMEZONE_CHANGED="android.intent.action.TIMEZONE_CHANGED", ACTION_VIEW="android.intent.action.VIEW";
  public static final int FLAG_ACTIVITY_NEW_TASK=0x10000000, FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS=0x00800000, FLAG_ACTIVITY_NO_USER_ACTION=0x00040000,
    FLAG_GRANT_READ_URI_PERMISSION=1, FLAG_GRANT_WRITE_URI_PERMISSION=2;
  public Intent() {} public Intent(String action) {} public Intent(String action, Uri uri) {} public Intent(Context c, Class<?> cls) {}
  public Intent putExtra(String k, String v) { throw new RuntimeException("stub"); } public Intent putExtra(String k, String[] v) { throw new RuntimeException("stub"); }
  public Intent putExtra(String k, boolean v) { throw new RuntimeException("stub"); } public Intent putExtra(String k, Parcelable v) { throw new RuntimeException("stub"); }
  public Intent setAction(String a) { throw new RuntimeException("stub"); } public String getAction() { throw new RuntimeException("stub"); } public String getStringExtra(String k) { throw new RuntimeException("stub"); }
  public CharSequence getCharSequenceExtra(String k) { throw new RuntimeException("stub"); }
  @Deprecated public <T extends Parcelable> T getParcelableExtra(String k) { throw new RuntimeException("stub"); }
  @Deprecated public <T extends Parcelable> ArrayList<T> getParcelableArrayListExtra(String k) { throw new RuntimeException("stub"); }
  public Intent addFlags(int f) { throw new RuntimeException("stub"); } public Intent setType(String t) { throw new RuntimeException("stub"); } public Intent addCategory(String c) { throw new RuntimeException("stub"); }
  public void setClipData(ClipData d) { throw new RuntimeException("stub"); } public ClipData getClipData() { throw new RuntimeException("stub"); } public Uri getData() { throw new RuntimeException("stub"); }
  public Intent setPackage(String p) { throw new RuntimeException("stub"); }
}
