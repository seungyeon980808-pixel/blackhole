/**
 * Proposal JSON v2 produced by the local worker (`ya-worker`, Rust `worker::proposal`).
 * Schema: `desktop/schemas/proposal.v2.schema.json`. Not wired into the UI yet (stage 2).
 */
import type { ItemArea, ItemKind } from "../domain";

export type ProposalKind = ItemKind | "NOTE" | "PERIOD";
export type ProposalSourceType = "audio" | "text" | "document" | "image";
export type ProposalEngineId = "A" | "B";

export interface ProposalEvidence {
  sentence: string;
  dateText: string;
  timeText: string;
  /** End of a PERIOD as said ("6일"). */
  endDateText: string;
  /** Reminder time as said ("목요일 9시"). */
  reminderText: string;
}

export interface ProposalItem {
  kind: ProposalKind;
  area: ItemArea;
  title: string;
  details: string;
  /** ISO 8601 with offset, or "" when no date/time was stated. */
  startAt: string;
  endAt: string;
  reminderAt: string;
  /** Every reminder instant, earliest first; ring like a phone call at each. */
  reminders: string[];
  /** Sub-checklist under a TODO, in the source's words. */
  subtasks: string[];
  evidence: ProposalEvidence;
  confidence: number;
  needsReview: boolean;
  reviewReasons: string[];
}

export interface Proposal {
  schemaVersion: 2;
  source: { type: ProposalSourceType; format: string; sha256: string; bytes: number };
  referenceTime: string;
  engine: { id: ProposalEngineId; reader: string; llmModel: string; promptVersion: string; workerVersion: string };
  sourceText: string;
  summary: string;
  items: ProposalItem[];
  needsReview: boolean;
  reviewReasons: string[];
  timings: { readMs: number; llmMs: number; totalMs: number };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isInstantOrEmpty = (value: unknown) => value === "" || (isString(value) && !Number.isNaN(Date.parse(value)));
const isStringList = (value: unknown) => Array.isArray(value) && value.every(isString);

function isItem(value: unknown): value is ProposalItem {
  const item = value as ProposalItem;
  return (
    typeof item === "object" && item !== null &&
    ["SCHEDULE", "TODO", "NOTE", "PERIOD"].includes(item.kind) &&
    ["PERSONAL", "SCHOOL"].includes(item.area) &&
    isString(item.title) && item.title.length > 0 && item.title.length <= 80 &&
    isString(item.details) &&
    isInstantOrEmpty(item.startAt) && isInstantOrEmpty(item.endAt) && isInstantOrEmpty(item.reminderAt) &&
    Array.isArray(item.reminders) && item.reminders.every((r) => isString(r) && r !== "" && isInstantOrEmpty(r)) &&
    Array.isArray(item.subtasks) && item.subtasks.length <= 20 && item.subtasks.every((t) => isString(t) && t.length > 0) &&
    typeof item.evidence === "object" && item.evidence !== null &&
    isString(item.evidence.sentence) && isString(item.evidence.dateText) && isString(item.evidence.timeText) &&
    isString(item.evidence.endDateText) && isString(item.evidence.reminderText) &&
    typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 &&
    typeof item.needsReview === "boolean" && isStringList(item.reviewReasons)
  );
}

/** Structural check for worker output crossing the Tauri boundary. Rejects instead of repairing. */
export function isProposal(value: unknown): value is Proposal {
  const p = value as Proposal;
  return (
    typeof p === "object" && p !== null &&
    p.schemaVersion === 2 &&
    typeof p.source === "object" && p.source !== null &&
    ["audio", "text", "document", "image"].includes(p.source.type) &&
    isString(p.source.format) && /^[0-9a-f]{64}$/.test(p.source.sha256) && Number.isInteger(p.source.bytes) &&
    isInstantOrEmpty(p.referenceTime) && p.referenceTime !== "" &&
    typeof p.engine === "object" && p.engine !== null && ["A", "B"].includes(p.engine.id) &&
    isString(p.engine.reader) && isString(p.engine.llmModel) && isString(p.engine.promptVersion) && isString(p.engine.workerVersion) &&
    isString(p.sourceText) && isString(p.summary) &&
    Array.isArray(p.items) && p.items.length <= 20 && p.items.every(isItem) &&
    typeof p.needsReview === "boolean" && isStringList(p.reviewReasons) &&
    typeof p.timings === "object" && p.timings !== null &&
    [p.timings.readMs, p.timings.llmMs, p.timings.totalMs].every((n) => Number.isInteger(n) && n >= 0)
  );
}
