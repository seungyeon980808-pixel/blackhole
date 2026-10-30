// 넣기·질문·설정 with the real worker (Claude, costs money) over a copy of a calendar file, each
// sentence on a fresh copy. Off unless BLACKHOLE_LIVE_STATE=<calendar json> (never the live file:
// copy it first). The report (BLACKHOLE_LIVE_REPORT=<file>) is read by eye.
//   BLACKHOLE_LIVE_STATE=… BLACKHOLE_LIVE_SENTENCES=<json list> BLACKHOLE_LIVE_REPORT=… npx vitest run tests/route-live.test.ts
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { mountBlackhole, type BlackholeApp } from "../src/calendar/app";
import type { BlackholeAdapter, ClaudeStatus } from "../src/calendar/adapter";
import { memoryAdapter } from "../src/calendar/memory-adapter";
import { normalizeState } from "../src/calendar/model";

const STATE = process.env.BLACKHOLE_LIVE_STATE;
const worker = join(__dirname, "..", "src-tauri", "target", "release", "blackhole-worker");
const claude: ClaudeStatus = { analyzer: "claude", model: "claude-haiku-5-5", hasKey: true, monthRequests: 0, monthUsd: 0, budgetUsd: 0, skipSimple: true };
const NOW = new Date(process.env.BLACKHOLE_LIVE_NOW ?? Date.now());
const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00+09:00`;
};

const run = (args: string[]) =>
  new Promise<unknown>((resolve, reject) =>
    execFile(worker, [...args, "--now", iso(NOW)], { maxBuffer: 1 << 22, env: { ...process.env, BLACKHOLE_NO_ANSWER_CACHE: "1" } }, (err, out, errOut) => (err ? reject(new Error(errOut || String(err))) : resolve(JSON.parse(out))))
  );
const scratch = STATE ? mkdtempSync(join(tmpdir(), "bh-live-")) : "";
let n = 0;

let app: BlackholeApp | null = null;
afterEach(() => {
  app?.destroy();
  app = null;
  localStorage.clear();
});

describe.skipIf(!STATE)("live 넣기·질문·설정", () => {
  const sentences: string[] = STATE ? JSON.parse(readFileSync(process.env.BLACKHOLE_LIVE_SENTENCES!, "utf8")) : ["(꺼짐)"];
  const report: unknown[] = [];
  it.each(sentences)("%s", async (text) => {
    const saved = normalizeState(JSON.parse(readFileSync(STATE!, "utf8")))!;
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.querySelector<HTMLElement>("#app")!;
    Object.defineProperty(root, "clientWidth", { configurable: true, get: () => 1300 });
    const calls: string[] = [];
    const adapter: BlackholeAdapter = {
      ...memoryAdapter(),
      origin: "데스크톱",
      claude: async () => claude,
      aiSkipped: () => undefined,
      writeMemo: async () => undefined,
      askAi: async () => ({ answer: "", ids: [] }),
      analyze: async (input: { text?: string }) => (calls.push("analyze"), (await run(["analyze", "--text", input.text ?? ""])) as never),
      routeText: async (t) => (calls.push("route"), (await run(["route", "--text", t])) as never),
      answerAi: async (q, lines) => {
        calls.push(`answer(${lines.length}줄)`);
        const f = join(scratch, `lines-${n++}.txt`);
        writeFileSync(f, lines.join("\n"));
        return (await run(["answer", "--text", q, "--file", f])) as never;
      }
    };
    app = await mountBlackhole(root, adapter, { now: () => new Date(NOW), seed: false });
    const s = app.state;
    for (const k of ["events", "tasks", "periods", "notes", "routines"] as const) (s as never as Record<string, unknown>)[k] = (saved as never as Record<string, unknown>)[k];
    s.settings = saved.settings;
    s.nextId = saved.nextId;
    s.chat = [];
    const before = new Set([...s.events, ...s.tasks, ...s.periods, ...s.notes].map((x) => `${x.id}:${x.gone ? 1 : 0}`));
    const settings = JSON.stringify(s.settings);
    await app.submitText(text);
    const changed = [...s.events, ...s.tasks, ...s.periods, ...s.notes].filter((x) => !before.has(`${x.id}:${x.gone ? 1 : 0}`));
    report.push({
      text,
      calls,
      chat: s.chat.filter((m) => m.who === "ai").map((m) => ({ text: m.text, scope: m.scope, hits: m.hits?.map((h) => `${h.title} (${h.when})`), refs: m.refs?.length, undo: !!m.undo, redo: m.redo?.as })),
      changed: changed.map((x) => `${x.gone ? "취소 " : ""}${x.kind} ${x.title} ${"date" in x ? x.date + " " + (x.start ?? "") : "due" in x ? x.due : ""} ${"reminders" in x ? x.reminders.join(",") : ""}`),
      settings: JSON.stringify(s.settings) === settings ? undefined : s.settings
    });
    if (process.env.BLACKHOLE_LIVE_REPORT) writeFileSync(process.env.BLACKHOLE_LIVE_REPORT, JSON.stringify(report, null, 1));
  }, 180_000);
});
