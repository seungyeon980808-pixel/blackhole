// The owner's own way of writing, end to end: the worker's recorded answers (Haiku, see
// scripts/style-record.mjs) go through the app as a real sentence would, and the calendar is
// checked against what the owner meant.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/style-cases.json";
import recorded from "./fixtures/style-proposals.json";
import { emptyState, type CalEvent, type Entry, type Task } from "../src/calendar/model";
import { applyProposal } from "../src/calendar/store";
import type { Proposal } from "../src/worker/proposal";

interface Want {
  k: string; has: string[]; area?: string; date?: string; start?: string | null; end?: string; remind?: string;
  due?: string; time?: string | null; noDue?: boolean; subsMin?: number; wait?: string; from?: string; to?: string;
}
interface Case { id: string; text: string; only?: boolean; done?: string[]; expect: Want[] }

const NOW = new Date(cases.now);
const squash = (x: string) => x.replace(/\s+/g, "");

function stateWithFixture() {
  const s = emptyState();
  for (const e of cases.fixture.events) s.events.push({ ...e, kind: "event", area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", provisional: false, reminders: [] });
  for (const t of cases.fixture.tasks) s.tasks.push({ ...t, kind: "task", area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", dueTime: null, done: false, reminders: [], subs: [] });
  return s;
}

const fields = (x: Entry): Record<string, unknown> => {
  const r: Record<string, unknown> = { ...x };
  if (x.kind === "task") r.time = (x as Task).dueTime;
  return r;
};

function mismatches(w: Want, x: Entry): string[] {
  const bad: string[] = [];
  const f = fields(x);
  const check = (name: string, want: unknown, got: unknown) => {
    if (want !== undefined && want !== got) bad.push(`「${x.title}」 ${name} ${String(got)} → ${String(want)}`);
  };
  check("area", w.area, x.area);
  check("date", w.date, f.date);
  check("start", w.start, f.start);
  check("end", w.end, f.end);
  check("due", w.due, f.noDue ? "날짜없음" : f.due);
  check("time", w.time, f.time);
  check("from", w.from, f.from);
  check("to", w.to, f.to);
  if (w.noDue && !f.noDue) bad.push(`「${x.title}」 날짜 없음이어야 함 (due ${String(f.due)})`);
  if (w.remind && !((x as CalEvent).reminders ?? []).includes(w.remind)) bad.push(`「${x.title}」 알림 ${JSON.stringify((x as CalEvent).reminders)} → ${w.remind}`);
  if (w.subsMin && ((x as Task).subs?.length ?? 0) < w.subsMin) bad.push(`「${x.title}」 단계 ${(x as Task).subs?.length ?? 0}개 → ${w.subsMin}개 이상`);
  if (w.wait && !((x as Task).wait ?? "").includes(w.wait)) bad.push(`「${x.title}」 기다림 「${(x as Task).wait ?? ""}」 → 「${w.wait}」`);
  return bad;
}

/** What is wrong for one case (empty: right). */
export function problems(c: Case, p: Proposal): string[] {
  const s = stateWithFixture();
  const before = new Set([...s.events, ...s.tasks, ...s.periods, ...s.notes].map((x) => x.id));
  applyProposal(s, p, "데스크톱", NOW);
  const made = [...s.events, ...s.tasks, ...s.periods, ...s.notes].filter((x) => !before.has(x.id) && !x.gone);
  const bad: string[] = [];
  const left = [...made];
  // Each wanted entry takes the made one (right kind, title words) it fits best.
  for (const w of c.expect) {
    const fits = left.filter((x) => x.kind === w.k && w.has.every((h) => squash(x.title).includes(squash(h))));
    if (!fits.length) {
      bad.push(`없음 ${w.k} 「${w.has.join("·")}」`);
      continue;
    }
    const best = fits.map((x) => ({ x, wrong: mismatches(w, x) })).sort((a, b) => a.wrong.length - b.wrong.length)[0];
    left.splice(left.indexOf(best.x), 1);
    bad.push(...best.wrong);
  }
  if (c.only && left.length) bad.push(`더 생김: ${left.map((x) => `${x.kind} 「${x.title}」`).join(", ")}`);
  if (c.done) {
    const doneNow = s.tasks.filter((t) => t.done && before.has(t.id)).map((t) => t.id).sort();
    if (JSON.stringify(doneNow) !== JSON.stringify([...c.done].sort())) bad.push(`완료 체크 ${JSON.stringify(doneNow)} → ${JSON.stringify(c.done)}`);
  }
  return bad;
}

const rec = recorded as unknown as Record<string, { text: string; proposal: Proposal }>;

describe("the owner's sentences, worker answer → calendar", () => {
  it.each((cases.cases as Case[]).filter((c) => rec[c.id]))("$id $text", (c) => {
    expect(rec[c.id].text).toBe(c.text);
    expect(problems(c, rec[c.id].proposal)).toEqual([]);
  });
});

// STYLE_REPORT=<file>: every case's problems in one file (for reading a whole run at once).
if (process.env.STYLE_REPORT) {
  const report = (cases.cases as Case[]).filter((c) => rec[c.id]).map((c) => ({ id: c.id, text: c.text, problems: problems(c, rec[c.id].proposal) }));
  writeFileSync(process.env.STYLE_REPORT, JSON.stringify(report, null, 1));
}
