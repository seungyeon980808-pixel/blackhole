#!/usr/bin/env node
// Compares engine A (STT → Gemma text), engine B (Gemma reads audio directly) and the
// existing Android rule parser on synthetic Korean commands. macOS only (uses `say`).
//
//   node tools/worker-eval/run-eval.mjs [--out DIR] [--report FILE] [--configs a4,a1,b,...] [--limit N]
//
// Generated WAV/PDF/PNG files and raw results go to --out (default: <models dir>/eval),
// never into the repository. Only the Markdown report (synthetic data) is written to --report.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const modelsDir = process.env.YA_MODELS_DIR ?? join(homedir(), ".local/share/ya-models");
const out = resolve(arg("out", join(modelsDir, "eval")));
const report = arg("report", null);
const limit = Number(arg("limit", "0"));
const worker = resolve(arg("worker", join(repo, "desktop/src-tauri/target/release/ya-worker")));
const kordoc = process.env.YA_KORDOC_BIN ?? join(modelsDir, "kordoc/node_modules/.bin/kordoc");
const ollama = process.env.YA_OLLAMA_URL ?? "http://127.0.0.1:11434";
const spec = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const cases = limit ? spec.cases.slice(0, limit) : spec.cases;
const REF = spec.referenceTime;

const CONFIGS = {
  a1: { label: "A · whisper + gemma3:1b", engine: "A", textModel: "gemma3:1b" },
  a4: { label: "A · whisper + gemma3:4b", engine: "A", textModel: "gemma3:4b" },
  ae2: { label: "A · whisper + gemma4:e2b (기본값)", engine: "A", textModel: "gemma4:e2b-it-q4_K_M" },
  b: { label: "B · gemma4:e2b 직접(음성·이미지)", engine: "B", textModel: "gemma4:e2b-it-q4_K_M" },
};
const configIds = arg("configs", "a1,a4,ae2,b").split(",").filter(Boolean);

mkdirSync(join(out, "wav"), { recursive: true });
mkdirSync(join(out, "docs"), { recursive: true });

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...options });
  if (result.error) throw result.error;
  return result;
}

// 1. Synthetic speech (no real recordings).
for (const c of cases) {
  const wav = join(out, "wav", `${c.id}.wav`);
  if (!existsSync(wav)) run("say", ["-v", c.voice, "-r", String(c.rate), "-o", wav, "--data-format=LEI16@16000", c.text]);
}

const squash = (s) => (s ?? "").replace(/[\s.,!?~·'"「」()\-]/g, "");
function cer(ref, hyp) {
  const a = [...squash(ref)], b = [...squash(hyp)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return a.length ? prev[b.length] / a.length : 0;
}

/** Scores predicted items against gold items; each gold item is matched to its best unused prediction. */
function score(gold, predicted) {
  const used = new Set();
  const rows = gold.map((g) => {
    let best = -1, bestHits = 0;
    predicted.forEach((p, i) => {
      if (used.has(i)) return;
      const hits = g.titleKeywords.filter((k) => squash(p.title).includes(squash(k))).length;
      if (hits > bestHits) { best = i; bestHits = hits; }
    });
    if (best < 0) return { kind: false, area: false, title: false, startAt: false, flagged: true };
    used.add(best);
    const p = predicted[best];
    return {
      kind: p.kind === g.kind,
      area: p.area === g.area,
      title: bestHits === g.titleKeywords.length,
      startAt: (p.startAt ?? "") === g.startAt,
      flagged: Boolean(p.needsReview),
    };
  });
  return { rows, countOk: predicted.length === gold.length };
}

function maxRss(stderr) {
  const m = /(\d+)\s+maximum resident set size/.exec(stderr ?? "");
  return m ? Number(m[1]) : 0;
}

/** Resident memory of Ollama's model runner processes (Ollama's own /api/ps size under-reports on Metal). */
function runnerRss() {
  const ps = run("ps", ["-axo", "rss=,command="]).stdout;
  return ps.split("\n").filter((l) => /llama-server|ollama runner|mlx/.test(l) && !/\bps\b/.test(l))
    .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0]) * 1024, 0);
}

/** Unloads every model from memory (keep_alive 0) so each configuration is measured alone. Deletes nothing. */
async function unloadAll() {
  try {
    const body = await (await fetch(`${ollama}/api/ps`)).json();
    for (const m of body.models ?? []) {
      await fetch(`${ollama}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
    }
    await new Promise((r) => setTimeout(r, 2000));
  } catch { /* runner down: analyze() will report it */ }
}

function analyze(config, args) {
  const env = { ...process.env, YA_TEXT_MODEL: config.textModel };
  const started = Date.now();
  const r = run("/usr/bin/time", ["-l", worker, "analyze", ...args, "--engine", config.engine, "--now", REF], { env });
  const wall = Date.now() - started;
  let proposal = null, error = null;
  try { proposal = JSON.parse(r.stdout); } catch { /* error path below */ }
  if (!proposal) {
    const m = /\{[\s\S]*\}/.exec(r.stderr);
    try { error = JSON.parse(m?.[0] ?? "{}").error ?? { message: r.stderr.slice(-300) }; } catch { error = { message: r.stderr.slice(-300) }; }
  }
  return { proposal, error, wall, rss: maxRss(r.stderr) };
}

const results = { referenceTime: REF, generatedAt: new Date().toISOString(), configs: {}, documents: {} };

// 2. Engines A/B on synthetic speech.
for (const id of configIds) {
  const config = CONFIGS[id];
  console.error(`▶ ${config.label}`);
  await unloadAll();
  let peakRunner = 0;
  analyze(config, ["--text", "예열용 문장입니다"]); // load the model; not scored
  if (config.engine === "B") analyze(config, ["--file", join(out, "wav", `${cases[0].id}.wav`)]);
  const perCase = [];
  for (const c of cases) {
    const r = analyze(config, ["--file", join(out, "wav", `${c.id}.wav`)]);
    const items = r.proposal?.items ?? [];
    perCase.push({
      id: c.id,
      error: r.error,
      transcript: r.proposal?.sourceText ?? "",
      cer: r.proposal ? cer(c.text, r.proposal.sourceText) : 1,
      totalMs: r.proposal?.timings.totalMs ?? r.wall,
      wallMs: r.wall,
      rss: r.rss,
      items: items.map(({ kind, area, title, startAt, needsReview }) => ({ kind, area, title, startAt, needsReview })),
      score: score(c.items, items),
    });
    peakRunner = Math.max(peakRunner, runnerRss());
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  results.configs[id] = { ...config, perCase, ollamaModelBytes: peakRunner };
}

// 3. Existing Android rule parser, on the reference text and on whisper transcripts.
const classes = join(out, "rules-classes");
mkdirSync(classes, { recursive: true });
const javac = run("javac", ["-encoding", "UTF-8", "-d", classes,
  join(repo, "src/com/malhaedwo/pttprobe/KoreanCommandParser.java"),
  join(repo, "src/com/malhaedwo/pttprobe/ParsedCommand.java"),
  join(here, "RuleParserCli.java")]);
if (javac.status !== 0) throw new Error(javac.stderr);
const whisperSource = results.configs.a4 ?? results.configs.a1 ?? results.configs.ae2;
for (const [id, label, textOf] of [
  ["rules-gold", "규칙 파서 · 정답 문장", (c) => c.text],
  ["rules-whisper", "규칙 파서 · whisper 문장", (c) => whisperSource?.perCase.find((p) => p.id === c.id)?.transcript ?? ""],
]) {
  if (id === "rules-whisper" && !whisperSource) continue;
  const tsv = cases.map((c) => `${c.id}\t${textOf(c).replace(/\s+/g, " ")}`).join("\n") + "\n";
  const r = run("/usr/bin/time", ["-l", "java", "-Duser.timezone=Asia/Seoul", "-cp", classes, "RuleParserCli", REF], { input: tsv });
  const parsed = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  results.configs[id] = {
    label, engine: "rules", ollamaModelBytes: 0,
    perCase: cases.map((c) => {
      const p = parsed.find((x) => x.id === c.id);
      // The Android app stores area PERSONAL unless the user edits it.
      const items = p ? [{ kind: p.kind, area: "PERSONAL", title: p.title, startAt: p.startAt, needsReview: p.needsReview }] : [];
      return { id: c.id, error: null, transcript: textOf(c), cer: 0, totalMs: (p?.micros ?? 0) / 1000, rss: maxRss(r.stderr), items, score: score(c.items, items) };
    }),
  };
}

// 4. Documents and images (kordoc), engine A and image engine B.
const docConfigs = [["a4", CONFIGS.a4], ["ae2", CONFIGS.ae2], ["b", CONFIGS.b]];
for (const d of spec.documents) {
  const file = join(out, "docs", `${d.id}.${d.format}`);
  if (!existsSync(file)) {
    if (d.format === "hwpx" || d.format === "png") {
      const md = join(out, "docs", `${d.id}.md`);
      writeFileSync(md, d.markdown);
      const hwpx = d.format === "hwpx" ? file : join(out, "docs", `${d.id}.hwpx`);
      run(kordoc, ["generate", md, "-o", hwpx]);
      if (d.format === "png") run(kordoc, ["render", hwpx, "--format", "png", "-o", file]);
    } else if (d.format === "pdf") {
      const txt = join(out, "docs", `${d.id}.txt`);
      writeFileSync(txt, d.text + "\n");
      writeFileSync(file, run("cupsfilter", [txt], { encoding: "buffer" }).stdout);
    }
  }
  results.documents[d.id] = {};
  for (const [cid, config] of docConfigs) {
    if (config.engine === "B" && d.format !== "png") continue;
    const r = analyze(config, ["--file", file]);
    const items = r.proposal?.items ?? [];
    results.documents[d.id][cid] = {
      format: d.format, label: config.label, error: r.error, totalMs: r.proposal?.timings.totalMs ?? r.wall,
      items: items.map(({ kind, area, title, startAt }) => ({ kind, area, title, startAt })), score: score(d.items, items),
    };
  }
}

writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));

// 5. Markdown report.
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "-");
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mb = (bytes) => (bytes ? `${(bytes / 1024 / 1024).toFixed(0)}MB` : "-");
const lines = [];
lines.push(`기준 시각 ${REF}, 가상 음성 ${cases.length}개(macOS \`say -v Yuna\` 합성, 말 빠르기 3종), 정답 항목 ${cases.reduce((n, c) => n + c.items.length, 0)}개.`, "");
lines.push("| 방식 | 종류 | 영역 | 제목 | 시작 시각 | 항목 완전 정답 | 문장 완전 정답 | 실패 | 시각 틀린 항목 중 검토 표시 | 받아쓰기 오류율(CER) | 처리 시간 중앙값 | 작업기 최대 메모리 | 모델 실행기 메모리 |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [id, r] of Object.entries(results.configs)) {
  // A failed job or an unmatched item never reaches the calendar silently, so it counts as flagged.
  const rows = r.perCase.flatMap((p) => p.score.rows.map((x) => (p.error ? { ...x, flagged: true } : x)));
  const n = rows.length;
  const count = (f) => rows.filter((x) => x[f]).length;
  const perfectItems = rows.filter((x) => x.kind && x.area && x.title && x.startAt).length;
  const wrongDates = rows.filter((x) => !x.startAt);
  const flaggedWrong = r.engine === "rules" ? "-" : `${wrongDates.filter((x) => x.flagged).length}/${wrongDates.length}`;
  const perfectCases = r.perCase.filter((p) => p.score.countOk && p.score.rows.every((x) => x.kind && x.area && x.title && x.startAt)).length;
  const failures = r.perCase.filter((p) => p.error).length;
  const meanCer = r.perCase.reduce((s, p) => s + p.cer, 0) / r.perCase.length;
  const ms = median(r.perCase.map((p) => p.totalMs));
  lines.push(`| ${r.label} | ${pct(count("kind"), n)} | ${r.engine === "rules" ? `${pct(count("area"), n)}*` : pct(count("area"), n)} | ${pct(count("title"), n)} | ${pct(count("startAt"), n)} | ${pct(perfectItems, n)} | ${pct(perfectCases, r.perCase.length)} | ${failures} | ${flaggedWrong} | ${r.engine === "rules" ? "-" : (meanCer * 100).toFixed(1) + "%"} | ${ms < 10 ? ms.toFixed(2) + "ms" : (ms / 1000).toFixed(1) + "초"} | ${mb(Math.max(...r.perCase.map((p) => p.rss)))} | ${mb(r.ollamaModelBytes)} |`);
}
lines.push("", "작업기 최대 메모리: `ya-worker`와 그 자식(whisper-cli, kordoc) 프로세스의 최대 RSS. 모델 실행기 메모리: Ollama 모델 실행 프로세스의 최대 RSS(모델 하나만 올린 상태). 처리 시간: 모델을 미리 올려 둔 뒤 입력 하나의 음성 인식·문서 읽기·Gemma 시간 합.", "", "\\* 규칙 파서는 영역을 고르지 않습니다. Android 앱이 저장하는 기본값 PERSONAL로 채점했습니다. 기억(NOTE)과 한 문장 속 여러 항목도 만들지 못합니다.", "");
lines.push("### 문서·이미지 (kordoc)", "", "| 문서 | 방식 | 항목 완전 정답 | 시작 시각 | 처리 시간 | 실패 |", "|---|---|---|---|---|---|");
for (const [id, byConfig] of Object.entries(results.documents)) {
  for (const r of Object.values(byConfig)) {
    const rows = r.score.rows;
    lines.push(`| ${id} (${r.format}) | ${r.label.replace("whisper", "kordoc").replace("(음성·이미지)", "(이미지)")} | ${rows.filter((x) => x.kind && x.area && x.title && x.startAt).length}/${rows.length} | ${rows.filter((x) => x.startAt).length}/${rows.length} | ${(r.totalMs / 1000).toFixed(1)}초 | ${r.error ? r.error.code ?? "오류" : ""} |`);
  }
}
const md = lines.join("\n") + "\n";
console.log(md);
if (report) writeFileSync(resolve(report), md);
