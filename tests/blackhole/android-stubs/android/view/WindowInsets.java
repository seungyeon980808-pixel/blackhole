package android.view;
import android.graphics.Insets;
public final class WindowInsets { public Insets getInsets(int typeMask) { throw new RuntimeException("stub"); }
  public static final class Type { public static int ime() { throw new RuntimeException("stub"); } public static int systemBars() { throw new RuntimeException("stub"); } public static int displayCutout() { throw new RuntimeException("stub"); } }
  public static final class Builder { public Builder(WindowInsets i) {} public Builder setInsets(int t, Insets i) { throw new RuntimeException("stub"); }
    public Builder setInsetsIgnoringVisibility(int t, Insets i) { throw new RuntimeException("stub"); } public Builder setDisplayCutout(DisplayCutout c) { throw new RuntimeException("stub"); } public WindowInsets build() { throw new RuntimeException("stub"); } } }
