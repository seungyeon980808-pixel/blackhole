// Sentences that skip the AI (「간단한 문장은 AI 생략」) end with the rule draft alone: on every owner-style
// sentence that takes that path, the draft must already be what the owner meant.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyState, type CalEvent } from "../src/calendar/model";
import { draftFromText } from "../src/calendar/store";
import { isSimpleCertain, needsAi, parseDraft, timeWords } from "../src/calendar/rules";

interface Want { k: string; has: string[]; date?: string; start?: string | null; end?: string; area?: string }
interface Case { id: string; text?: string; only?: boolean; changed?: unknown[]; done?: string[]; expect: Want[] }
const dir = join(__dirname, "fixtures");
const sets = ["style-cases.json", "style-cases-2.json", "style-holdout.json", "style-holdout-2.json"].map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { now: string; cases: Case[] });

const simple = sets.flatMap((set) => set.cases.filter((c) => c.text).map((c) => ({ c, now: new Date(set.now) }))).filter(({ c, now }) => {
  const s = emptyState();
  // As the app asks it (app.ts skipsAi).
  return !needsAi(c.text!) && isSimpleCertain(timeWords(c.text!, s.settings), parseDraft(c.text!, now, s.settings));
});

describe("AI 생략 경로", () => {
  it("some owner sentences take it", () => expect(simple.length).toBeGreaterThan(5));
  it.each(simple.map(({ c, now }) => ({ id: c.id, text: c.text!, c, now })))("$id $text", ({ c, now }) => {
    // A change, a finished report or several entries always need the AI: never skipped.
    expect(c.changed ?? c.done ?? null).toBeNull();
    expect(c.expect).toHaveLength(1);
    const w = c.expect[0];
    const s = emptyState();
    const x = draftFromText(s, c.text!, "데스크톱", now, "k") as CalEvent;
    expect(x.kind).toBe(w.k);
    for (const h of w.has) expect(x.title.replace(/\s+/g, "")).toContain(h.replace(/\s+/g, ""));
    if (w.date) expect(x.date).toBe(w.date);
    if (w.start !== undefined) expect(x.start).toBe(w.start);
    if (w.end) expect(x.end).toBe(w.end);
  });
});
