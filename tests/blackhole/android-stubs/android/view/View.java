package android.view;
import android.graphics.drawable.Drawable;
public class View { public static final int FOCUS_DOWN=130, GONE=8;
  public View(android.content.Context c) {}
  public void setPadding(int l, int t, int r, int b) { throw new RuntimeException("stub"); } public int getPaddingBottom() { throw new RuntimeException("stub"); } public final ViewParent getParent() { throw new RuntimeException("stub"); }
  public void setOnApplyWindowInsetsListener(OnApplyWindowInsetsListener l) { throw new RuntimeException("stub"); } public boolean post(Runnable r) { throw new RuntimeException("stub"); }
  public void setBackground(Drawable d) { throw new RuntimeException("stub"); } public void setBackgroundColor(int c) { throw new RuntimeException("stub"); } public void setOnClickListener(OnClickListener l) { throw new RuntimeException("stub"); }
  public void setVisibility(int v) { throw new RuntimeException("stub"); } public void setLayoutParams(ViewGroup.LayoutParams p) { throw new RuntimeException("stub"); } public void setEnabled(boolean b) { throw new RuntimeException("stub"); }
  public void requestApplyInsets() { throw new RuntimeException("stub"); } public boolean isAttachedToWindow() { throw new RuntimeException("stub"); } public void addOnAttachStateChangeListener(OnAttachStateChangeListener l) { throw new RuntimeException("stub"); }
  public interface OnClickListener { void onClick(View v); }
  public interface OnApplyWindowInsetsListener { WindowInsets onApplyWindowInsets(View v, WindowInsets insets); }
  public interface OnAttachStateChangeListener { void onViewAttachedToWindow(View v); void onViewDetachedFromWindow(View v); } }
