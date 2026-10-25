package android.content;
public interface SharedPreferences {
  String getString(String key, String fallback); boolean getBoolean(String key, boolean fallback); Editor edit();
  interface Editor { Editor putString(String k, String v); Editor putBoolean(String k, boolean v); void apply(); boolean commit(); }
}
