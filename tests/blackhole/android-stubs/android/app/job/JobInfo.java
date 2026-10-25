package android.app.job;
import android.content.ComponentName;
public class JobInfo { public static final int NETWORK_TYPE_ANY=1, BACKOFF_POLICY_EXPONENTIAL=1;
  public static final class Builder { public Builder(int id, ComponentName c) {} public Builder setRequiredNetworkType(int t) { throw new RuntimeException("stub"); }
    public Builder setBackoffCriteria(long ms, int policy) { throw new RuntimeException("stub"); } public Builder setPersisted(boolean b) { throw new RuntimeException("stub"); } public JobInfo build() { throw new RuntimeException("stub"); } } }
