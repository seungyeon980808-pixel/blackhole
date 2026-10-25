package android.app.job;
public abstract class JobService extends android.content.Context { public abstract boolean onStartJob(JobParameters p); public abstract boolean onStopJob(JobParameters p);
  public final void jobFinished(JobParameters p, boolean reschedule) { throw new RuntimeException("stub"); } }
