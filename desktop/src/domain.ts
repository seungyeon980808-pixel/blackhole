/** Exact public web Items sheet contract: 23 columns, in canonical order. */
export const ITEM_COLUMNS = [
  "itemId", "status", "sourceType", "area", "kind", "title", "startAt",
  "endAt", "reminderAt", "transcript", "notes", "createdAt", "updatedAt",
  "approvedAt", "createdBy", "approvedBy", "version", "calendarEnabled",
  "calendarId", "calendarEventId", "deletedAt", "idempotencyKey", "syncState"
] as const;

export type ItemStatus = "PENDING" | "APPROVED" | "DONE" | "DELETED";
export type ItemKind = "SCHEDULE" | "TODO";
export type ItemArea = "PERSONAL" | "SCHOOL" | "OUTSIDE";
export type SyncState = "LOCAL_FIXTURE" | "PENDING" | "SYNCED" | "ERROR";

export interface Item {
  itemId: string;
  status: ItemStatus;
  sourceType: string;
  area: ItemArea;
  kind: ItemKind;
  title: string;
  startAt: string;
  endAt: string;
  reminderAt: string;
  transcript: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string;
  createdBy: string;
  approvedBy: string;
  version: number;
  calendarEnabled: boolean;
  calendarId: string;
  calendarEventId: string;
  deletedAt: string;
  idempotencyKey: string;
  syncState: SyncState;
}

export interface CacheEnvelope {
  schemaVersion: 1;
  items: Item[];
  updatedAt: string;
}

export interface CacheLoadResult {
  cache: CacheEnvelope;
  recoveredCorrupt: boolean;
  warning: string | null;
}

export interface ConnectionStatus {
  state: "unconfigured";
  label: string;
  detail: string;
  configured: false;
  canWrite: false;
  lastSyncAt: null;
}

export const WRITE_DISABLED_REASON =
  "Google 연결과 안전한 승인 동기화가 아직 구성되지 않아 변경할 수 없습니다.";
