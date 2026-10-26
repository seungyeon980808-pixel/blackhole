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

  /* Mac: quick input, clipboard, Dock, capture — everything put in arrives here. */
  onPut?(handler: (put: PutItem) => void): void;
  /** Mac: copy a file into the current inbox folder (resolves to its inbox name). */
  inboxPut?(path: string): Promise<string>;
  /** Mac: a pasted picture/file from this page, sent the same way as the quick window's. */
  putBytes?(name: string, bytes: Uint8Array, via: string): Promise<void>;
  /** Mac: a dropped file path (converted where needed: m4a → wav, heic → png). */
  putPath?(path: string, via: string): Promise<void>;
  /** Mac: these inbox jobs were drafted; `skip` need no AI. Wakes the scanner. */
  inboxDrafted?(skip: string[]): Promise<void>;
  /** Mac: secrets first — "secret" kept in the keychain only, "ask" 「비밀로 저장할까요?」, "put" go on. */
  secretIntake?(text: string, secret?: boolean): Promise<"put" | "secret" | "ask">;
  /** Mac: open the quick input/search window (⌘F). */
  openQuick?(): void;
  /** Mac: write the Raycast script commands and show their folder. */
  raycastInstall?(): Promise<string>;
  /** Mac: count a call that was not made (simple sentence, rule draft final). */
  aiSkipped?(reason: string): void;
  setClaudeOptions?(budgetUsd: number, skipSimple: boolean): Promise<ClaudeStatus>;

  /* Mac: the full-screen alarm window rings by itself (the page only keeps the calendar). */
  readonly nativeAlarms?: boolean;
  onAlarmAnswer?(handler: (alarm: Alarm, answer: "done" | "snooze" | "ok") => void): void;
  showMissed?(alarms: Alarm[]): Promise<void>;

  /* Mac: menu bar, shortcuts, login item, alarm sound, first-start guide. */
  desk?(): Promise<DeskStatus>;
  setDesk?(settings: DeskSettings): Promise<DeskStatus>;
  trySound?(sound: string): void;
  speechPermission?(): Promise<string>;
  openPrivacy?(pane: "microphone" | "speech" | "screen" | "notifications" | "accessibility"): void;
  notifyTest?(): void;

  /** Mac: the Claude API analyzer (key in the macOS keychain; the page never sees it). */
  claude?(): Promise<ClaudeStatus>;
  setClaudeKey?(key: string): Promise<ClaudeStatus>;
  clearClaudeKey?(): Promise<ClaudeStatus>;
  checkClaude?(): Promise<string>;

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
  board?(): Promise<BoardOptions>;
  setBoard?(lock: boolean, hideSchool: boolean): Promise<void>;
  /** Phone: widget·lock-screen picture brightness (-50…50) and panel opacity (0…150 %). */
  setBoardLook?(bright: number, opacity: number): Promise<void>;
  /** Phone: today's to-dos in the lock-screen notification (완료 there), and hiding their titles. */
  setLockTasks?(show: boolean, hideTitles: boolean): Promise<void>;
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

export interface BoardOptions {
  lock: boolean;
  hideSchool: boolean;
  status: string;
  bright?: number;
  opacity?: number;
  lockTasks?: boolean;
  lockHideTitles?: boolean;
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

export interface ClaudeStatus {
  analyzer: string;
  model: string;
  hasKey: boolean;
  monthRequests: number;
  monthUsd: number;
  /** Monthly limit in USD (0 = none); at the limit the AI stops and drafts stay. */
  budgetUsd?: number;
  /** 「간단한 문장은 AI 생략」 */
  skipSimple?: boolean;
  month?: {
    requests: number; usd: number; input: number; output: number; cacheRead: number; cacheWrite: number;
    skippedCache: number; skippedRule: number; skippedShort: number; skippedBudget: number;
  };
}

/** Something put in from outside the page (quick window, clipboard, Dock, capture). */
export interface PutItem {
  text?: string;
  path?: string;
  /** ⌘Enter in the quick window: a 기억 as typed (no AI). */
  memo?: string;
  /** Open this entry (search result). */
  open?: string;
  link?: { url: string; title: string; text: string };
  via: string;
}

export interface DeskSettings {
  shortcuts: { quick: string; clipboard: string; capture: string };
  autostart: boolean;
  alarmSound: string;
  onboarded: boolean;
  autostartOffered?: boolean;
  rightCmdTwice: boolean;
}

export interface DeskStatus {
  settings: DeskSettings;
  autostartOn: boolean;
  pretty: { quick: string; clipboard: string; capture: string };
  problems: string[];
  sounds: string[];
  /** 손쉬운 사용 allowed (right ⌘ twice needs it). */
  accessibility: boolean;
  raycastDir: string;
}

export interface MessengerStatus {
  configured: boolean;
  configPath: string;
  enabled: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  written: number;
}
