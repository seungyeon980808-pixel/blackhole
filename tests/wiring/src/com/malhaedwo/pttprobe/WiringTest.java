package com.malhaedwo.pttprobe;

import android.app.*;
import android.content.*;
import android.database.sqlite.SQLiteDatabase;
import android.provider.CalendarContract;

import java.lang.reflect.Field;
import java.util.*;

public final class WiringTest {
 private static int cases, assertions;
 public static void main(String[] args) throws Exception {
  run("approved-only automation and receiver",WiringTest::approvedOnlyAutomationAndReceiver);
  run("time-edit stale, done, deleted suppression",WiringTest::staleDoneDeletedSuppression);
  run("receiver generation match",WiringTest::receiverGenerationMatch);
  run("PendingIntent identity replacement and cancellation",WiringTest::pendingIntentIdentity);
  run("exact, inexact, and exact-permission denial",WiringTest::exactInexactDenied);
  run("notification app/channel/vibration diagnostics",WiringTest::notificationDiagnostics);
  run("lock-screen reminder content is safe and timestamped",WiringTest::lockScreenReminderContent);
  run("Calendar marker retry recovers inserted event",WiringTest::markerRetryRecovery);
  run("Calendar update failure state and retry",WiringTest::updateFailureRetry);
  run("Calendar delete failure state and retry",WiringTest::deleteFailureRetry);
  run("applyRemote retains local link then automation updates same event",WiringTest::remoteEditAutomation);
  run("remote-only and non-approved edits do not acquire local work",WiringTest::remoteScopeSafety);
  run("pending scheduler and receiver reject direct calls",WiringTest::pendingDirect);
  run("low importance and channel change before delivery",WiringTest::channelChange);
  run("Calendar insert failure state and retry",WiringTest::insertFailureRetry);
  run("cancel withdraws only matching posted notification",WiringTest::cancelPostedScoped);
  run("notification withdrawal without AlarmManager or PendingIntent",WiringTest::cancelWithoutAlarm);
  run("alarm-only reconciliation preserves posted notification",WiringTest::alarmOnlyPreservesNotification);
  run("local delete withdraws already-posted notification",WiringTest::localDeleteWithdrawal);
  run("done automation withdraws already-posted notification",WiringTest::doneWithdrawal);
  run("time edit withdraws old post before replacement",WiringTest::editWithdrawal);
  run("repeated elapsed reconciliation preserves post until DONE",WiringTest::elapsedPreservedThenDone);
  run("repeated elapsed reconciliation preserves post until local deletion",WiringTest::elapsedPreservedThenLocalDelete);
  run("repeated elapsed reconciliation preserves post until remote deletion",WiringTest::elapsedPreservedThenRemoteDelete);
  run("persisted local edit into past withdraws old post",WiringTest::localPastEditWithdrawal);
  run("persisted local reminder removal withdraws old post",WiringTest::localReminderRemoval);
  run("accepted remote notification-field edits withdraw old post",WiringTest::remoteNotificationFieldEdits);
  run("remote metadata-only edit preserves elapsed post",WiringTest::metadataOnlyEditPreserves);
  run("accepted-edit helper ignores mismatched IDs and missing records",WiringTest::editIdentityGuard);
  run("unchanged persisted elapsed record keeps posted notification",WiringTest::unchangedElapsedEditPreserves);
  System.out.println("WiringTest passed: "+cases+" cases, "+assertions+" assertions");
 }
 private static void approvedOnlyAutomationAndReceiver() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); CaptureDatabase db=CaptureDatabase.get(c); long future=soon(60);
  long id=seed(db,"approval","PENDING","SCHEDULE","Pending",future,future,0,"NONE",0,null,0,null);
  CaptureAutomation.process(c,id); eq(0,c.alarms.alarms.size(),"pending item must not schedule");
  db.approve(id); CaptureAutomation.process(c,id); eq(1,c.alarms.alarms.size(),"approved item schedules"); yes(c.alarms.alarms.get(0).exact,"exact alarm used");
  CaptureItem armed=db.getItem(id); eq("EXACT",armed.reminderState,"DB stores schedule result"); eq(1L,armed.reminderGeneration,"generation created");
  new ReminderReceiver().onReceive(c,c.alarms.alarms.get(0).operation.getIntent()); eq(1,c.notifications.notifications.size(),"matching approved event posts");
 }
 private static void staleDoneDeletedSuppression() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); CaptureDatabase db=CaptureDatabase.get(c); long first=soon(55);
  long id=seed(db,"edit","APPROVED","SCHEDULE","Before",first,first,0,"NONE",0,null,0,null); CaptureAutomation.process(c,id);
  Intent stale=c.alarms.alarms.get(0).operation.getIntent(); long edited=soon(75); db.updateEdited(id,"After","SCHEDULE","PERSONAL",edited,edited+1000,edited); CaptureAutomation.process(c,id);
  CaptureItem changed=db.getItem(id); eq(2L,changed.reminderGeneration,"time edit advances generation"); new ReminderReceiver().onReceive(c,stale); eq(0,c.notifications.notifications.size(),"stale time/generation suppressed");
  Intent current=c.alarms.alarms.get(0).operation.getIntent(); db.markDone(id,true); new ReminderReceiver().onReceive(c,current); eq(0,c.notifications.notifications.size(),"done item suppressed");
  long id2=seed(db,"deleted","APPROVED","SCHEDULE","Delete",soon(80),soon(80),1,"NONE",0,null,0,null); Intent deleted=reminderIntent(id2,db.getItem(id2).reminderAt,1); db.delete(id2); new ReminderReceiver().onReceive(c,deleted); eq(0,c.notifications.notifications.size(),"deleted item suppressed");
 }
 private static void receiverGenerationMatch() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); CaptureDatabase db=CaptureDatabase.get(c); long at=soon(50); long id=seed(db,"generation","APPROVED","SCHEDULE","Generation",at,at,4,"NONE",0,null,0,null);
  new ReminderReceiver().onReceive(c,reminderIntent(id,at,3)); eq(0,c.notifications.notifications.size(),"wrong generation suppressed");
  new ReminderReceiver().onReceive(c,reminderIntent(id,at,4)); eq(1,c.notifications.notifications.size(),"matching generation posts");
 }
 private static void pendingIntentIdentity() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); CaptureItem x=item(71,soon(40),1); ReminderScheduler.schedule(c,x); AlarmManager.Alarm first=c.alarms.alarms.get(0); String identity=first.operation.identity();
  x.reminderAt=soon(65);x.reminderGeneration=2;ReminderScheduler.schedule(c,x);eq(1,c.alarms.alarms.size(),"replacement leaves one alarm");AlarmManager.Alarm second=c.alarms.alarms.get(0);eq(identity,second.operation.identity(),"identity stable by id/data");eq(x.reminderAt,second.at,"new trigger replaces old");eq(2L,second.operation.getIntent().getLongExtra(ReminderScheduler.EXTRA_GENERATION,0),"extras updated");yes(c.alarms.cancelled.size()>=1,"old identity cancelled before replace");ReminderScheduler.cancel(c,x.id);eq(0,c.alarms.alarms.size(),"cancel finds same identity despite zeroed extras");
 }
 private static void exactInexactDenied() throws Exception {
  TestEnvironment.ContextImpl exact=fresh();CaptureItem a=item(81,soon(40),1);eq("EXACT",ReminderScheduler.schedule(exact,a).state,"exact state");yes(exact.alarms.alarms.get(0).exact,"exact API called");
  TestEnvironment.ContextImpl inexact=fresh();inexact.alarms.exactAllowed=false;CaptureItem b=item(82,soon(40),1);ReminderScheduler.Result ir=ReminderScheduler.schedule(inexact,b);eq("INEXACT_DEGRADED",ir.state,"inexact state");no(inexact.alarms.alarms.get(0).exact,"inexact API called");contains(ir.message,"정확한 알람", "degradation disclosed");
  TestEnvironment.ContextImpl denied=fresh();denied.alarms.throwSecurity=true;CaptureItem d=item(83,soon(40),1);ReminderScheduler.Result dr=ReminderScheduler.schedule(denied,d);eq("BLOCKED",dr.state,"SecurityException blocks");eq(0,denied.alarms.alarms.size(),"denied alarm not retained");contains(dr.message,"권한", "permission denial diagnosed");
 }
 private static void notificationDiagnostics() throws Exception {
  TestEnvironment.ContextImpl initial=fresh();ReminderScheduler.Readiness initialReadiness=ReminderScheduler.notificationReadiness(initial,false);eq("첫 알림 예약 시 채널 준비",initialReadiness.message,"initial channel state is preparation, not a creation failure");
  TestEnvironment.ContextImpl runtime=fresh();runtime.deny(android.Manifest.permission.POST_NOTIFICATIONS);ReminderScheduler.Result rr=ReminderScheduler.schedule(runtime,item(91,soon(40),1));eq("BLOCKED",rr.state,"runtime permission block");eq(0,runtime.alarms.alarms.size(),"runtime block creates no alarm");long blockedAt=soon(45);CaptureDatabase blockedDb=CaptureDatabase.get(runtime);long blockedId=seed(blockedDb,"blocked-receiver","APPROVED","SCHEDULE","Blocked",blockedAt,blockedAt,1,"NONE",0,null,0,null);new ReminderReceiver().onReceive(runtime,reminderIntent(blockedId,blockedAt,1));eq(0,runtime.notifications.notifications.size(),"blocked receiver does not post");eq("BLOCKED",blockedDb.getItem(blockedId).reminderState,"receiver persists blocked state");contains(blockedDb.getItem(blockedId).alarmLastError,"권한","receiver persists readiness reason");
  TestEnvironment.ContextImpl app=fresh();app.notifications.enabled=false;ReminderScheduler.Result ar=ReminderScheduler.schedule(app,item(92,soon(40),1));eq("BLOCKED",ar.state,"app-wide block");contains(ar.message,"앱 알림", "app setting diagnosed");
  TestEnvironment.ContextImpl channel=fresh();NotificationChannel off=new NotificationChannel(ReminderScheduler.CHANNEL_ID,"x",NotificationManager.IMPORTANCE_NONE);off.enableVibration(true);channel.notifications.setChannel(off);ReminderScheduler.Result cr=ReminderScheduler.schedule(channel,item(93,soon(40),1));eq("BLOCKED",cr.state,"disabled channel blocks");contains(cr.message,"채널", "channel diagnosed");
  TestEnvironment.ContextImpl vibration=fresh();NotificationChannel quiet=new NotificationChannel(ReminderScheduler.CHANNEL_ID,"x",NotificationManager.IMPORTANCE_HIGH);quiet.enableVibration(false);vibration.notifications.setChannel(quiet);ReminderScheduler.Result vr=ReminderScheduler.schedule(vibration,item(94,soon(40),1));eq("EXACT",vr.state,"vibration warning does not conflate delivery/exactness");contains(vr.message,"진동", "vibration setting diagnosed");eq(1,vibration.alarms.alarms.size(),"delivery still scheduled");
 }
 private static void lockScreenReminderContent() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); CaptureDatabase db=CaptureDatabase.get(c); long at=soon(40);
  long id=seed(db,"lock-screen","APPROVED","SCHEDULE","Lock screen schedule",at,at,1,"NONE",0,null,0,null);
  CaptureItem stored=db.getItem(id);
  new ReminderReceiver().onReceive(c,reminderIntent(id,stored.reminderAt,stored.reminderGeneration));
  Notification posted=c.notifications.notifications.get((int)(10_000+id));
  notNull(posted,"approved schedule posts a notification");
  eq(Notification.VISIBILITY_PUBLIC,posted.visibility,"schedule notification is eligible for lock-screen display");
  eq(at,posted.when,"lock-screen notification carries the scheduled time");
  no(posted.bigText.contains(stored.transcript),"lock-screen detail excludes the transcript");
  eq("예약한 알림 시각입니다",posted.text,"lock-screen detail uses a concise schedule message");
 }
 private static void markerRetryRecovery() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureItem x=item(101,soon(60),1);x.uuid="marker-u";x.calendarIdempotencyKey="stable-k";x.calendarSelectedId=7;x.title="First";x.transcript="one";long id=CalendarSync.upsert(c,x);eq(1,c.resolver.events.size(),"first call inserts");eq(1,c.resolver.insertCount,"one insert");
  CaptureItem retry=item(101,soon(70),1);retry.uuid=x.uuid;retry.calendarIdempotencyKey=x.calendarIdempotencyKey;retry.calendarSelectedId=7;retry.calendarEventId=0;retry.title="Recovered";retry.transcript="two";long recovered=CalendarSync.upsert(c,retry);eq(id,recovered,"marker finds inserted event without local event id");eq(1,c.resolver.events.size(),"retry avoids duplicate");eq(1,c.resolver.updateCount,"actual CalendarSync updates recovered event");eq("Recovered",c.resolver.events.get(id).get(CalendarContract.Events.TITLE),"recovered event receives edit");
 }
 private static void updateFailureRetry() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureDatabase db=CaptureDatabase.get(c);long at=soon(90);String marker=CalendarReliability.descriptionWithMarker("body","update-u","update-k");c.resolver.addEvent(301,7,"old",marker,CalendarReliability.customAppUri("update-u","update-k"));long id=seed(db,"update-u","APPROVED","SCHEDULE","New",at,at,1,"PENDING",301,"update-k",7,"Asia/Seoul");c.resolver.throwUpdate=true;CaptureAutomation.processExplicit(c,id);CaptureItem failed=db.getItem(id);eq("FAILED",failed.calendarSyncState,"failed update persisted");eq(1,failed.calendarAttempts,"attempt incremented");yes(failed.calendarNextAttemptAt>System.currentTimeMillis(),"retry time persisted");contains(failed.calendarSyncError,"provider update failure","provider error retained");
  c.resolver.throwUpdate=false;CaptureAutomation.processExplicit(c,id);CaptureItem recovered=db.getItem(id);eq("SYNCED",recovered.calendarSyncState,"explicit retry recovers");eq(301L,recovered.calendarEventId,"same event retained");eq(0,recovered.calendarAttempts,"attempts reset");eq(1,c.resolver.events.size(),"no duplicate after retry");
 }
 private static void deleteFailureRetry() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureDatabase db=CaptureDatabase.get(c);long at=soon(90);c.resolver.addEvent(401,7,"delete","body",null);long id=seed(db,"delete-u","APPROVED","SCHEDULE","Delete",at,at,1,"SYNCED",401,"delete-k",7,"Asia/Seoul");c.resolver.failDelete=true;CaptureAutomation.requestDelete(c,id);CaptureItem failed=db.getItem(id);notNull(failed,"failed delete keeps row");eq("DELETE_PENDING",failed.status,"delete remains pending");eq("DELETE_FAILED",failed.calendarSyncState,"delete failure state");eq(1,failed.calendarAttempts,"delete attempt incremented");yes(failed.calendarNextAttemptAt>0,"delete retry timestamp");
  c.resolver.failDelete=false;CaptureAutomation.processExplicit(c,id);eq(null,db.getItem(id),"successful retry removes local row");eq(0,c.resolver.events.size(),"successful retry removes provider event");
 }
 private static void remoteEditAutomation() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureDatabase db=CaptureDatabase.get(c);long oldAt=soon(100);String marker=CalendarReliability.descriptionWithMarker("old","remote-u","remote-k");c.resolver.addEvent(501,7,"Old",marker,CalendarReliability.customAppUri("remote-u","remote-k"));long id=seed(db,"remote-u","APPROVED","SCHEDULE","Old",oldAt,oldAt+1000,1,"SYNCED",501,"remote-k",7,"Asia/Seoul");
  RemoteCapture r=remote("remote-u","APPROVED","SCHEDULE","Remote edit",soon(130),2);long applied=db.applyRemote(r);eq(id,applied,"applyRemote updates existing row");CaptureItem pending=db.getItem(id);eq("PENDING",pending.calendarSyncState,"remote content edit marks local Calendar pending");eq(501L,pending.calendarEventId,"local event id retained");eq("remote-k",pending.calendarIdempotencyKey,"idempotency metadata retained");eq(7L,pending.calendarSelectedId,"calendar selection retained");eq("Asia/Seoul",pending.calendarTimezone,"timezone retained");
  CaptureAutomation.process(c,id);CaptureItem done=db.getItem(id);eq("SYNCED",done.calendarSyncState,"automation clears pending after provider update");eq(501L,done.calendarEventId,"automation keeps same event id");eq("remote-k",done.calendarIdempotencyKey,"key remains after processing");eq(7L,done.calendarSelectedId,"selection remains after processing");eq("Asia/Seoul",done.calendarTimezone,"timezone remains after processing");eq(0,c.resolver.insertCount,"processing does not insert replacement");eq(1,c.resolver.events.size(),"one provider event remains");eq("Remote edit",c.resolver.events.get(501L).get(CalendarContract.Events.TITLE),"actual CalendarSync writes remote title");eq(r.startAt,c.resolver.events.get(501L).get(CalendarContract.Events.DTSTART),"actual CalendarSync writes remote time");
 }
 private static void remoteScopeSafety() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureDatabase db=CaptureDatabase.get(c);RemoteCapture web=remote("web-u","APPROVED","SCHEDULE","Web",soon(100),1);web.remoteCalendarEnabled=true;web.remoteCalendarEventId="web-event";long webId=db.applyRemote(web);CaptureItem webItem=db.getItem(webId);eq("NONE",webItem.calendarSyncState,"new web-only link does not create local work");eq(0L,webItem.calendarEventId,"new web item has no local event id");
  long local=seed(db,"pending-u","PENDING","SCHEDULE","Local",soon(90),soon(90),0,"SYNCED",601,"keep-k",7,"Asia/Seoul");RemoteCapture pending=remote("pending-u","PENDING","SCHEDULE","Remote changed",soon(120),2);db.applyRemote(pending);CaptureItem after=db.getItem(local);eq("SYNCED",after.calendarSyncState,"non-approved edit does not mark pending");eq(601L,after.calendarEventId,"non-approved merge retains local id");
  long transcriptAt=soon(140);long transcriptId=seed(db,"transcript-u","APPROVED","SCHEDULE","Same",transcriptAt,transcriptAt,0,"SYNCED",602,"transcript-k",7,"Asia/Seoul");RemoteCapture transcriptOnly=remote("transcript-u","APPROVED","SCHEDULE","Same",transcriptAt,2);transcriptOnly.transcript="changed description";db.applyRemote(transcriptOnly);CaptureItem transcriptPending=db.getItem(transcriptId);eq("PENDING",transcriptPending.calendarSyncState,"transcript-only Calendar description edit marks pending");eq(602L,transcriptPending.calendarEventId,"transcript-only edit retains local id");
 }
 private static void pendingDirect() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureDatabase db=CaptureDatabase.get(c);long at=soon(60);long id=seed(db,"direct-pending","PENDING","SCHEDULE","Pending",at,at,1,"NONE",0,null,0,null);
  eq("NONE",ReminderScheduler.schedule(c,db.getItem(id)).state,"direct pending scheduler rejects");eq(0,c.alarms.alarms.size(),"no pending alarm");new ReminderReceiver().onReceive(c,reminderIntent(id,at,1));eq(0,c.notifications.notifications.size(),"direct pending receiver rejects");
 }
 private static void channelChange() throws Exception {
  TestEnvironment.ContextImpl c=fresh();NotificationChannel low=new NotificationChannel(ReminderScheduler.CHANNEL_ID,"x",2);low.enableVibration(true);c.notifications.setChannel(low);CaptureDatabase db=CaptureDatabase.get(c);long at=soon(60);long id=seed(db,"channel-change","APPROVED","SCHEDULE","Channel",at,at,1,"NONE",0,null,0,null);ReminderScheduler.Result result=ReminderScheduler.schedule(c,db.getItem(id));eq("EXACT",result.state,"low importance still scheduled");contains(result.message,"중요도","low importance warning retained");
  Intent alarm=c.alarms.alarms.get(0).operation.getIntent();NotificationChannel off=new NotificationChannel(ReminderScheduler.CHANNEL_ID,"x",NotificationManager.IMPORTANCE_NONE);c.notifications.setChannel(off);new ReminderReceiver().onReceive(c,alarm);eq(0,c.notifications.notifications.size(),"channel disabled after scheduling suppresses delivery");eq("BLOCKED",db.getItem(id).reminderState,"late channel block persisted");contains(db.getItem(id).alarmLastError,"채널","late block accurately diagnosed");
 }
 private static void insertFailureRetry() throws Exception {
  TestEnvironment.ContextImpl c=fresh();CaptureDatabase db=CaptureDatabase.get(c);long at=soon(90);long id=seed(db,"insert-u","APPROVED","SCHEDULE","Insert",at,at,1,"PENDING",0,"insert-k",7,"Asia/Seoul");c.resolver.throwInsert=true;CaptureAutomation.processExplicit(c,id);CaptureItem failed=db.getItem(id);eq("FAILED",failed.calendarSyncState,"failed insert persisted");eq(1,failed.calendarAttempts,"insert attempts retained");yes(failed.calendarNextAttemptAt>System.currentTimeMillis(),"insert backoff retained");eq(0,c.resolver.events.size(),"failed insert created no event");
  c.resolver.throwInsert=false;CaptureAutomation.processExplicit(c,id);CaptureItem done=db.getItem(id);eq("SYNCED",done.calendarSyncState,"insert retry succeeds");yes(done.calendarEventId>0,"insert retry linked");eq(1,c.resolver.events.size(),"one event after retry");
 }
 private static long postedFixture(TestEnvironment.ContextImpl c,String uuid) {
  CaptureDatabase db=CaptureDatabase.get(c); long at=soon(60);
  long id=seed(db,uuid,"APPROVED","SCHEDULE",uuid,at,at,1,"NONE",0,null,0,null);
  CaptureAutomation.process(c,id);
  CaptureItem armed=db.getItem(id);
  new ReminderReceiver().onReceive(c,reminderIntent(id,armed.reminderAt,armed.reminderGeneration));
  yes(c.notifications.notifications.containsKey((int)(10_000+id)),"real receiver uses backward-compatible notification ID");
  return id;
 }
 private static void cancelPostedScoped() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long first=postedFixture(c,"withdraw-first"); long other=postedFixture(c,"keep-other");
  eq(2,c.notifications.notifications.size(),"two posted fixtures");
  ReminderScheduler.cancel(c,first);
  no(c.notifications.notifications.containsKey((int)(10_000+first)),"target post withdrawn");
  yes(c.notifications.notifications.containsKey((int)(10_000+other)),"other record post untouched");
  eq(1,c.alarms.alarms.size(),"only target alarm cancelled");
  eq(other,c.alarms.alarms.get(0).operation.getIntent().getLongExtra(ReminderScheduler.EXTRA_ID,-1),"other record alarm untouched");
  ReminderScheduler.cancel(c,first); eq(1,c.notifications.notifications.size(),"repeated withdrawal idempotent");
 }
 private static void cancelWithoutAlarm() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"no-alarm-service");
  c.alarmServiceAvailable=false; ReminderScheduler.cancel(c,id);
  eq(0,c.notifications.notifications.size(),"missing AlarmManager does not skip notification withdrawal");
  c.alarmServiceAvailable=true; long noToken=postedFixture(c,"no-pending-token");
  PendingIntent.reset(); ReminderScheduler.cancel(c,noToken);
  eq(0,c.notifications.notifications.size(),"missing PendingIntent does not skip withdrawal");
 }
 private static void alarmOnlyPreservesNotification() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"elapsed-post");
  ReminderScheduler.cancelAlarmOnly(c,id);
  eq(0,c.alarms.alarms.size(),"alarm-only cleanup removes future token");
  eq(1,c.notifications.notifications.size(),"alarm-only cleanup does not erase valid posted reminder");
 }
 private static void localDeleteWithdrawal() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"local-delete-post");
  CaptureAutomation.requestDelete(c,id);
  eq(null,CaptureDatabase.get(c).getItem(id),"local delete removes record");
  eq(0,c.alarms.alarms.size(),"local delete cancels alarm");
  eq(0,c.notifications.notifications.size(),"local delete withdraws posted notification");
 }
 private static void doneWithdrawal() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"done-post");
  CaptureDatabase.get(c).markDone(id,true); CaptureAutomation.process(c,id);
  eq("DONE",CaptureDatabase.get(c).getItem(id).status,"fixture is completed");
  eq(0,c.alarms.alarms.size(),"done reconciliation cancels alarm");
  eq(0,c.notifications.notifications.size(),"done reconciliation withdraws post");
 }
 private static void editWithdrawal() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"edited-post"); long next=soon(90);
  CaptureDatabase.get(c).updateEdited(id,"Edited","SCHEDULE","PERSONAL",next,next+3600000,next);
  CaptureAutomation.process(c,id);
  eq(0,c.notifications.notifications.size(),"edit withdraws old posted notification");
  eq(1,c.alarms.alarms.size(),"edit keeps exactly one replacement alarm");
  eq(next,c.alarms.alarms.get(0).at,"replacement scheduled for edited time");
 }
 private static long elapsedPostedFixture(TestEnvironment.ContextImpl c,String uuid) {
  CaptureDatabase db=CaptureDatabase.get(c); long elapsed=System.currentTimeMillis()-60_000L;
  long id=seed(db,uuid,"APPROVED","SCHEDULE",uuid,elapsed,elapsed,1,"NONE",0,null,0,null);
  new ReminderReceiver().onReceive(c,reminderIntent(id,elapsed,1));
  eq(1,c.notifications.notifications.size(),"actual receiver posted elapsed fixture");
  CaptureAutomation.processAllReady(c);
  yes(c.notifications.notifications.containsKey((int)(10_000+id)),"first ordinary reconciliation preserves elapsed post");
  eq(0L,db.getItem(id).scheduledReminderAt,"first reconciliation clears scheduling metadata");
  CaptureAutomation.processAllReady(c);
  yes(c.notifications.notifications.containsKey((int)(10_000+id)),"second ordinary reconciliation still preserves elapsed post");
  eq("APPROVED",db.getItem(id).status,"ordinary reconciliation does not complete item");
  eq(0,c.alarms.alarms.size(),"elapsed reminder is not scheduled again");
  return id;
 }
 private static void elapsedPreservedThenDone() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=elapsedPostedFixture(c,"elapsed-done");
  CaptureDatabase.get(c).markDone(id,true); CaptureAutomation.process(c,id);
  eq("DONE",CaptureDatabase.get(c).getItem(id).status,"explicit completion persists");
  eq(0,c.notifications.notifications.size(),"DONE withdraws previously preserved post");
 }
 private static void elapsedPreservedThenLocalDelete() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=elapsedPostedFixture(c,"elapsed-local-delete");
  CaptureAutomation.requestDelete(c,id);
  eq(null,CaptureDatabase.get(c).getItem(id),"explicit local deletion removes elapsed record");
  eq(0,c.notifications.notifications.size(),"local deletion withdraws preserved post");
 }
 private static void elapsedPreservedThenRemoteDelete() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=elapsedPostedFixture(c,"elapsed-remote-delete");
  CaptureDatabase db=CaptureDatabase.get(c);
  yes(CaptureAutomation.requestRemoteDelete(c,"elapsed-remote-delete",db.getItem(id).version),"remote deletion accepted after reconciliation");
  eq(null,db.getItem(id),"accepted remote deletion removes elapsed record");
  eq(0,c.notifications.notifications.size(),"remote deletion withdraws preserved post");
 }
 private static void localPastEditWithdrawal() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"past-edit"); CaptureDatabase db=CaptureDatabase.get(c);
  CaptureItem before=db.getItem(id); long past=System.currentTimeMillis()-60_000;
  db.updateEdited(id,"Edited past","SCHEDULE","PERSONAL",past,past+3600000,past);
  CaptureItem after=db.getItem(id); eq(past,after.reminderAt,"past edit is actually persisted");
  CaptureAutomation.withdrawNotificationAfterEdit(c,before,after); CaptureAutomation.process(c,id);
  eq(0,c.notifications.notifications.size(),"past-time edit removes old post despite elapsed guard");
  eq(0,c.alarms.alarms.size(),"past-time edit has no replacement alarm");
 }
 private static void localReminderRemoval() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=postedFixture(c,"remove-reminder"); CaptureDatabase db=CaptureDatabase.get(c); CaptureItem before=db.getItem(id);
  db.updateEdited(id,before.title,before.kind,before.area,before.startAt,before.endAt,0);
  CaptureItem after=db.getItem(id); eq(0L,after.reminderAt,"reminder removal persisted");
  CaptureAutomation.withdrawNotificationAfterEdit(c,before,after); CaptureAutomation.process(c,id);
  eq(0,c.notifications.notifications.size(),"explicit removal withdraws posted reminder");
  eq(0,c.alarms.alarms.size(),"explicit removal leaves no future alarm");
 }
 private static RemoteCapture sameRemote(CaptureItem before) {
  RemoteCapture r=remote(before.uuid,before.status,before.kind,before.title,before.startAt,before.version+1);
  r.reminderAt=before.reminderAt; r.endAt=before.endAt; r.transcript=before.transcript; return r;
 }
 private static void remoteNotificationFieldEdits() throws Exception {
  for(String field:new String[]{"status","kind","reminderAt","title","transcript"}) {
   TestEnvironment.ContextImpl c=fresh(); long id=elapsedPostedFixture(c,"remote-field-"+field); CaptureDatabase db=CaptureDatabase.get(c); CaptureItem before=db.getItem(id);
   RemoteCapture r=sameRemote(before);
   if(field.equals("status"))r.status="DONE";
   if(field.equals("kind"))r.kind="TODO";
   if(field.equals("reminderAt"))r.reminderAt-=60_000;
   if(field.equals("title"))r.title=null;
   if(field.equals("transcript"))r.transcript=null;
   long applied=db.applyRemote(r); CaptureItem after=db.getItem(applied);
   eq(id,applied,"remote "+field+" edit persisted on same record");
   eq(r.version,after.version,"accepted remote version persisted");
   CaptureAutomation.withdrawNotificationAfterEdit(c,before,after); CaptureAutomation.process(c,applied);
   eq(0,c.notifications.notifications.size(),"accepted remote "+field+" edit withdraws old post");
  }
 }
 private static void metadataOnlyEditPreserves() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=elapsedPostedFixture(c,"metadata-only"); CaptureDatabase db=CaptureDatabase.get(c); CaptureItem before=db.getItem(id);
  RemoteCapture r=sameRemote(before); r.remoteCalendarEnabled=true; r.remoteCalendarEventId="remote-metadata";
  long applied=db.applyRemote(r); CaptureItem after=db.getItem(applied);
  yes(after.version>before.version,"metadata version actually advanced");
  eq("remote-metadata",after.remoteCalendarEventId,"remote metadata actually persisted");
  CaptureAutomation.withdrawNotificationAfterEdit(c,before,after); CaptureAutomation.processAllReady(c);
  eq(1,c.notifications.notifications.size(),"metadata-only accepted update does not withdraw elapsed post");
 }
 private static void editIdentityGuard() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long first=postedFixture(c,"guard-first"); long other=postedFixture(c,"guard-other"); CaptureDatabase db=CaptureDatabase.get(c);
  CaptureAutomation.withdrawNotificationAfterEdit(c,db.getItem(first),db.getItem(other));
  CaptureAutomation.withdrawNotificationAfterEdit(c,null,db.getItem(other));
  CaptureAutomation.withdrawNotificationAfterEdit(c,db.getItem(first),null);
  eq(2,c.notifications.notifications.size(),"different or missing records cannot cancel either post");
  eq(2,c.alarms.alarms.size(),"identity guard preserves both alarms");
 }
 private static void unchangedElapsedEditPreserves() throws Exception {
  TestEnvironment.ContextImpl c=fresh(); long id=elapsedPostedFixture(c,"unchanged-elapsed"); CaptureDatabase db=CaptureDatabase.get(c); CaptureItem before=db.getItem(id);
  db.updateEdited(id,before.title,before.kind,before.area,before.startAt,before.endAt,before.reminderAt);
  CaptureItem after=db.getItem(id); yes(after.version>before.version,"no-op content save still persisted version");
  CaptureAutomation.withdrawNotificationAfterEdit(c,before,after); CaptureAutomation.processAllReady(c); CaptureAutomation.processAllReady(c);
  eq(1,c.notifications.notifications.size(),"unchanged expired content retains post after repeated sync");
 }
 private static TestEnvironment.ContextImpl fresh() throws Exception {Field f=CaptureDatabase.class.getDeclaredField("instance");f.setAccessible(true);f.set(null,null);PendingIntent.reset();SyncScheduler.requests=0;return new TestEnvironment.ContextImpl();}
 private static long seed(CaptureDatabase db,String uuid,String status,String kind,String title,long start,long reminder,long generation,String calendarState,long eventId,String key,long selected,String timezone){ContentValues v=new ContentValues();long now=System.currentTimeMillis();v.put("item_uuid",uuid);v.put("audio_path","");v.put("source_type","WEB");v.put("source_mime","application/octet-stream");v.put("area","PERSONAL");v.put("transcript","transcript");v.put("kind",kind);v.put("title",title);v.put("start_at",start);v.put("end_at",start+3600000);v.put("reminder_at",reminder);v.put("status",status);v.put("calendar_event_id",eventId);v.put("approved_at","APPROVED".equals(status)?now:0);v.put("updated_at",now);v.put("version",1);v.put("created_at",now);v.put("calendar_sync_state",calendarState);v.put("calendar_attempts",0);v.put("calendar_next_attempt_at",0);v.put("calendar_idempotency_key",key);v.put("calendar_selected_id",selected);v.put("calendar_timezone",timezone);v.put("calendar_delete_pending",0);v.put("reminder_state","NONE");v.put("reminder_generation",generation);v.put("scheduled_reminder_at",generation>0?reminder:0);v.put("deleted_at",0);return db.getWritableDatabase().insertOrThrow("captures",null,v);}
 private static CaptureItem item(long id,long at,long generation){CaptureItem x=new CaptureItem();x.id=id;x.uuid="u-"+id;x.status="APPROVED";x.kind="SCHEDULE";x.title="Item "+id;x.startAt=at;x.endAt=at+3600000;x.reminderAt=at;x.reminderGeneration=generation;x.calendarSyncState="NONE";return x;}
 private static RemoteCapture remote(String uuid,String status,String kind,String title,long start,int version){RemoteCapture r=new RemoteCapture();r.uuid=uuid;r.status=status;r.sourceType="WEB";r.area="PERSONAL";r.kind=kind;r.title=title;r.startAt=start;r.endAt=start+3600000;r.reminderAt=start;r.transcript="remote transcript";r.createdAt=System.currentTimeMillis()-1000;r.updatedAt=System.currentTimeMillis();r.approvedAt="APPROVED".equals(status)?System.currentTimeMillis():0;r.version=version;return r;}
 private static Intent reminderIntent(long id,long at,long generation){return new Intent().setAction(ReminderScheduler.ACTION_REMIND).putExtra(ReminderScheduler.EXTRA_ID,id).putExtra(ReminderScheduler.EXTRA_REMINDER_AT,at).putExtra(ReminderScheduler.EXTRA_GENERATION,generation);}
 private static long soon(int minutes){return System.currentTimeMillis()+minutes*60000L;}
 private interface Checked {void run() throws Exception;} private static void run(String name,Checked body)throws Exception{body.run();cases++;System.out.println("PASS "+name);} private static void yes(boolean v,String m){assertions++;if(!v)throw new AssertionError(m);}private static void no(boolean v,String m){yes(!v,m);}private static void eq(Object e,Object a,String m){assertions++;if(!Objects.equals(e,a))throw new AssertionError(m+" expected="+e+" actual="+a);}private static void contains(String a,String needle,String m){assertions++;if(a==null||!a.contains(needle))throw new AssertionError(m+" actual="+a);}private static void notNull(Object a,String m){yes(a!=null,m);}
}
