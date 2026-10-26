#!/usr/bin/env node
// Claude Haiku 5.5 on the same synthetic evaluation set as run-eval.mjs (cases.json).
// COSTS MONEY (Claude API): run it only after the owner has put a key in 설정 and agreed.
// Text input only — the same words the phone transcript or macOS speech recognition would give.
//
//   node tools/worker-eval/run-haiku-eval.mjs --yes [--effort low] [--limit N] [--report FILE]
//
// Uses the built worker (desktop/src-tauri/target/release/blackhole-worker) with
// BLACKHOLE_ANALYZER=claude; the key comes from the macOS keychain (never from this script).
// Raw results go to <models dir>/eval/haiku-*.json, only the Markdown table to --report.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { score } from "./scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
if (!process.argv.includes("--yes")) {
  console.error("이 평가는 Claude API 요금이 듭니다(사례 39개 × 1회, 대략 $0.01 미만 예상). 실행하려면 --yes 를 붙이세요.");
  process.exit(2);
}
const effort = arg("effort", "low");
const limit = Number(arg("limit", "0"));
const report = arg("report", null);
const worker = resolve(arg("worker", join(repo, "desktop/src-tauri/target/release/blackhole-worker")));
const modelsDir = process.env.BLACKHOLE_MODELS_DIR ?? join(homedir(), ".local/share/blackhole-models");
const out = join(modelsDir, "eval");
mkdirSync(out, { recursive: true });
const spec = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const cases = limit ? spec.cases.slice(0, limit) : spec.cases;
const REF = spec.referenceTime;

const env = { ...process.env, BLACKHOLE_ANALYZER: "claude", BLACKHOLE_CLAUDE_EFFORT: effort };
const perCase = [];
for (const c of cases) {
  const started = Date.now();
  const r = spawnSync(worker, ["analyze", "--text", c.text, "--now", REF], { encoding: "utf8", env, maxBuffer: 16 << 20 });
  const wallMs = Date.now() - started;
  let proposal = null;
  try { proposal = JSON.parse(r.stdout); } catch { /* error below */ }
  const items = proposal?.items ?? [];
  perCase.push({ id: c.id, wallMs, error: proposal ? null : r.stderr.slice(-300), items: items.map(({ kind, area, title, startAt, needsReview }) => ({ kind, area, title, startAt, needsReview })), score: score(c.items, items) });
  console.error(`${c.id} ${proposal ? "ok" : "실패"} ${wallMs}ms`);
}

const rows = perCase.flatMap((p) => p.score.rows);
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "-");
const exact = rows.filter((r) => r.kind && r.area && r.title && r.startAt).length;
const sentences = perCase.filter((p) => p.score.countOk && p.score.rows.every((r) => r.kind && r.area && r.title && r.startAt)).length;
const start = rows.filter((r) => r.startAt).length;
const walls = perCase.map((p) => p.wallMs).sort((a, b) => a - b);
const median = walls[Math.floor(walls.length / 2)] ?? 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(out, `haiku-${stamp}.json`), JSON.stringify({ referenceTime: REF, effort, perCase }, null, 1));
const table = `| 설정 | 항목 완전 정답 | 문장 완전 정답 | 시작 시각 | 중앙 시간 | 실패 |
|---|---|---|---|---|---|
| Claude Haiku 5.5 · effort ${effort} (글 입력) | ${pct(exact, rows.length)} | ${pct(sentences, perCase.length)} | ${pct(start, rows.length)} | ${median}ms | ${perCase.filter((p) => p.error).length} |
`;
console.log(table);
if (report) writeFileSync(report, `# Claude Haiku 5.5 평가 (${new Date().toISOString().slice(0, 10)})\n\n가상 문장 ${perCase.length}개, 기준 시각 ${REF}. 비용은 설정 화면의 「이번 달 대략 사용액」에서 확인.\n\n${table}`);
