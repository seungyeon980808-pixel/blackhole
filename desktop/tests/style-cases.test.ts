// The owner's own way of writing, end to end: the worker's recorded answers (Haiku, see
// scripts/style-record.mjs) go through the app as a real sentence would, and the calendar is
// checked against what the owner meant.
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyState, type CalEvent, type Entry, type Task } from "../src/calendar/model";
import { draftFromText, refineDrafts } from "../src/calendar/store";
import { isFiller, isSimpleCertain, memoDraft, needsAi, parseDraft, timeWords } from "../src/calendar/rules";
import type { Proposal } from "../src/worker/proposal";

interface Want {
  k: string; has: string[]; area?: string; date?: string; start?: string | null; end?: string; remind?: string;
  due?: string; dueIn?: [string, string]; time?: string | null; noDue?: boolean; subsMin?: number; wait?: string; from?: string; to?: string;
}
interface Changed { id: string; gone?: boolean; date?: string; start?: string; end?: string; due?: string; time?: string }
interface Case { id: string; text?: string; file?: string; only?: boolean; done?: string[]; changed?: Changed[]; expect: Want[] }
interface Fixture { events: { id: string; title: string; date: string; start: string; end: string; area?: string }[]; tasks: { id: string; title: string; due: string }[] }
interface CaseSet { now: string; fixture: Fixture; cases: Case[] }

/** Each set: its sentences and the worker answers recorded for them (scripts/style-record.mjs). */
const SETS: Record<string, [string, string]> = {
  "1": ["style-cases.json", "style-proposals.json"],
  "2": ["style-cases-2.json", "style-proposals-2.json"],
  files: ["style-files.json", "style-files-proposals.json"],
  // Scored only at the end: STYLE_HOLDOUT=1.
  ...(process.env.STYLE_HOLDOUT ? { holdout: ["style-holdout.json", "style-holdout-proposals.json"] as [string, string], holdout2: ["style-holdout-2.json", "style-holdout-2-proposals.json"] as [string, string] } : {})
};
const dir = join(__dirname, "fixtures");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const sets = Object.entries(SETS).filter(([, [c, r]]) => existsSync(join(dir, c)) && existsSync(join(dir, r))).map(([name, [c, r]]) => ({ name, set: read(c) as CaseSet, rec: read(r) as Record<string, { text: string; proposal: Proposal }> }));
const squash = (x: string) => x.replace(/\s+/g, "");

function stateWithFixture(fx: Fixture) {
  const s = emptyState();
  for (const e of fx.events) s.events.push({ area: "school", ...e, kind: "event", source: "데스크톱", createdAt: "2026-10-27T09:00", provisional: false, reminders: [`${e.date}T${e.start}`] } as CalEvent);
  for (const t of fx.tasks) s.tasks.push({ ...t, kind: "task", area: "school", source: "데스크톱", createdAt: "2026-10-27T09:00", dueTime: null, done: false, reminders: [], subs: [] });
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
  if (w.dueIn && (f.noDue || String(f.due) < w.dueIn[0] || String(f.due) > w.dueIn[1])) bad.push(`「${x.title}」 due ${f.noDue ? "날짜없음" : String(f.due)} → ${w.dueIn.join("~")}`);
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
export function problems(c: Case, p: Proposal, set: CaseSet): string[] {
  const NOW = new Date(set.now);
  const s = stateWithFixture(set.fixture);
  const before = new Set([...s.events, ...s.tasks, ...s.periods, ...s.notes].map((x) => x.id));
  // The app's own path for a sentence (app.ts submitText / pullDrafts): filler → nothing; a sure 기억 or a
  // simple sentence → the rule draft is final (no AI); otherwise the draft is refined by the worker's answer.
  // A file goes straight to the worker.
  const text = c.text;
  if (text === undefined) refineDrafts(s, "k", p, "인박스", NOW);
  else if (!isFiller(text)) {
    const memo = memoDraft(text, NOW, s.settings)?.final;
    const simple = !memo && !needsAi(text) && isSimpleCertain(timeWords(text, s.settings), parseDraft(text, NOW, s.settings));
    const x = draftFromText(s, text, "데스크톱", NOW, "k");
    if (memo || simple) x.draft = false;
    else refineDrafts(s, "k", p, "데스크톱", NOW);
  }
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
  for (const ch of c.changed ?? []) {
    const x = [...s.events, ...s.tasks].find((y) => y.id === ch.id);
    if (!x) continue;
    const got: Record<string, unknown> = x.kind === "event" ? { gone: !!x.gone, date: x.date, start: x.start, end: x.end } : { gone: !!x.gone, due: x.due, time: x.dueTime };
    for (const [k, v] of Object.entries(ch)) if (k !== "id" && got[k] !== v) bad.push(`바뀜 ${ch.id} 「${x.title}」 ${k} ${String(got[k])} → ${String(v)}`);
  }
  if (c.done) {
    const doneNow = s.tasks.filter((t) => t.done && before.has(t.id)).map((t) => t.id).sort();
    if (JSON.stringify(doneNow) !== JSON.stringify([...c.done].sort())) bad.push(`완료 체크 ${JSON.stringify(doneNow)} → ${JSON.stringify(c.done)}`);
  }
  return bad;
}

describe.each(sets)("the owner's sentences ($name), worker answer → calendar", ({ set, rec }) => {
  it.each(set.cases.filter((c) => rec[c.id]))("$id $text$file", (c) => {
    expect(rec[c.id].text).toBe(c.text ?? c.file);
    expect(problems(c, rec[c.id].proposal, set)).toEqual([]);
  });
});

// STYLE_REPORT=<file>: every case's problems in one file (for reading a whole run at once).
if (process.env.STYLE_REPORT) {
  const report = sets.flatMap(({ name, set, rec }) => set.cases.filter((c) => rec[c.id]).map((c) => ({ set: name, id: c.id, text: c.text ?? c.file, problems: problems(c, rec[c.id].proposal, set) })));
  writeFileSync(process.env.STYLE_REPORT, JSON.stringify(report, null, 1));
}
