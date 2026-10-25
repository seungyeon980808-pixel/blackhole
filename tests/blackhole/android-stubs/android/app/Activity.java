package android.app;
import android.content.*; import android.os.Bundle; import android.view.View; import android.view.Window;
public class Activity extends Context { public static final int RESULT_OK=-1;
  protected void onCreate(Bundle state) {} protected void onSaveInstanceState(Bundle out) {} protected void onStart() {} protected void onStop() {}
  protected void onDestroy() {} protected void onResume() {} protected void onNewIntent(Intent intent) {}
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {}
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {}
  @Deprecated public void onBackPressed() {}
  public void setTitle(CharSequence title) { throw new RuntimeException("stub"); } public Intent getIntent() { throw new RuntimeException("stub"); } public void setIntent(Intent i) { throw new RuntimeException("stub"); } public void finish() { throw new RuntimeException("stub"); }
  public void startActivityForResult(Intent intent, int requestCode) { throw new RuntimeException("stub"); } public void setContentView(View view) { throw new RuntimeException("stub"); } public Window getWindow() { throw new RuntimeException("stub"); }
  public void setShowWhenLocked(boolean b) { throw new RuntimeException("stub"); } public void setTurnScreenOn(boolean b) { throw new RuntimeException("stub"); }
  public final void requestPermissions(String[] permissions, int requestCode) { throw new RuntimeException("stub"); } }
