/**
 * Everything platform-specific sits behind this interface: storage, the local worker,
 * the inbox and alarms. The desktop app passes a Tauri adapter; the phone WebView will
 * pass its own; the browser preview uses the memory adapter.
 */
import type { Proposal } from "../worker/proposal";
import type { CalendarState, Entry, SharedCalendar, UserAction } from "./model";
import type { Alarm } from "./store";

export interface AnalyzeInput {
  text?: string;
  file?: { name: string; bytes: Uint8Array };
  /** Dropped file path (desktop only). */
  path?: string;
  now: Date;
}

/** code "QUEUED": sent for analysis elsewhere (phone → Mac); not a failure. */
export class AnalyzeError extends Error {
  /** QUEUED: the inbox job id the upload will get on the Mac ("job-" + SHA-256 prefix). */
  constructor(readonly code: string, message: string, readonly job?: string) {
    super(message);
  }
}

/** A file in the Mac's inbox whose words are already known (a .txt, or a phone recording with
 *  the phone's own transcript): drafted at once, before the AI result for the same job. */
export interface InboxDraft {
  jobId: string;
  fileName: string;
  text: string;
  /** "text" (typed on the phone) or "voice" (phone speech recognition). */
  kind: "text" | "voice";
  /** When the phone made it (epoch ms), if known. */
  at?: number;
}

export interface InboxStatus {
  available: boolean;
  /** Drive 「블랙홀」 folder found on this machine (desktop only). */
  driveRoot?: string | null;
  testRoot?: string;
  enabled: boolean;
  root: string;
  lastScanAt: string | null;
  lastError: string | null;
  running: boolean;
}

export interface InboxResult {
  jobId: string;
  fileName: string;
  proposal: Proposal | null;
  error: string | null;
}

export interface ConnectionInfo {
  /** Short, always visible: 「로컬·미연결」. */
  label: string;
  detail: string;
}

export interface BlackholeAdapter {
  /** Source label for things typed here (데스크톱, 휴대폰). */
  readonly origin: string;
  readonly connection: ConnectionInfo;
  load(): Promise<unknown>;
  save(state: CalendarState): Promise<void>;
  analyze(input: AnalyzeInput): Promise<Proposal>;
  inboxStatus(): Promise<InboxStatus>;
  setInbox(enabled: boolean, root: string | null): Promise<InboxStatus>;
  inboxResults(): Promise<InboxResult[]>;
  /** Mac: inbox files that can be drafted right away (cheap; polled every 2 s). */
  inboxDrafts?(): Promise<InboxDraft[]>;
  /** Replace the alarm schedule. The adapter calls onFire when one is due. */
  scheduleAlarms(alarms: Alarm[]): Promise<void>;
  onAlarm(handler: (alarm: Alarm) => void): void;
  /** Start/stop the ringing sound and bring the window forward. Returns true when the adapter rings itself. */
  ring(on: boolean): Promise<boolean>;
  print(): Promise<void>;
  onFileDrop?(handler: (paths: string[]) => void): void;
  /** Window glass (desktop shows through) for the current theme, where the platform has it. */
  setLook?(theme: string, mode: string): Promise<void>;

  /** Mac (stage 5): Discord·Slack input into the inbox (tokens live in a file outside the repo). */
  messenger?(): Promise<MessengerStatus>;
  setMessenger?(enabled: boolean): Promise<MessengerStatus>;

  /* Mac ↔ phone sharing (optional). */
  /** Mac: write the shared copy. Resolves to a short status line. */
  publishShared?(shared: SharedCalendar): Promise<string>;
  /** Mac: actions the phone sent (read from the inbox; files are never deleted). */
  phoneActions?(): Promise<UserAction[]>;
  /** Phone: a hand-made change to send to the Mac. */
  recordAction?(action: UserAction): void;
  /** Phone (stage 5): lock-screen calendar wallpaper and hiding school titles (widget + lock screen). */
  board?(): Promise<{ lock: boolean; hideSchool: boolean; status: string }>;
  setBoard?(lock: boolean, hideSchool: boolean): Promise<void>;
  /** Phone (stage 4): calendars to mirror into, and the current choice. */
  googleCalendars?(): Promise<GoogleCalendars>;
  setGoogleCalendars?(enabled: boolean, provisional: string, main: string): Promise<void>;
  /** Phone: called when a newer shared copy from the Mac arrives, with the phone's
   *  changes the Mac has not applied yet (to replay on top). */
  onShared?(handler: (shared: SharedCalendar, pending: UserAction[]) => void): void;
  /** Phone: drafts made on the phone that the Mac has not answered yet (kept natively). */
  localDrafts?(): Entry[];
  /** Phone: keep drafts made in this page until the Mac's copy covers their job. */
  keepDrafts?(entries: Entry[]): void;
}

/** Stage 4: provisional events go to `provisional`, confirmed events and periods to `main`. */
export interface GoogleCalendars {
  permission: boolean;
  enabled: boolean;
  provisional: string;
  main: string;
  status: string;
  calendars: { id: string; name: string }[];
}

export interface MessengerStatus {
  configured: boolean;
  configPath: string;
  enabled: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  written: number;
}
