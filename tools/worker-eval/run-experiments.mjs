#!/usr/bin/env node
// Accuracy experiments: each switch on/off over the same synthetic voice and document sets.
//
//   node tools/worker-eval/run-experiments.mjs --split dev|eval [--suite voice,docs] [--configs id,...] [--report FILE]
//
// Run make-docs.py first. `--split dev` is for tuning; only `--split eval` numbers are reported.
// Inputs, raw results and the stage-1 binary live under <models dir>/eval, never in the repo.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maxRss, score } from "./scoring.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const modelsDir = process.env.YA_MODELS_DIR ?? join(homedir(), ".local/share/ya-models");
const evalDir = join(modelsDir, "eval");
const split = arg("split", "dev");
const suites = arg("suite", "voice,docs").split(",");
const report = arg("report", null);
const worker = join(repo, "desktop/src-tauri/target/release/ya-worker");
const stage1 = join(evalDir, "ya-worker-c3788e7");
const ollama = process.env.YA_OLLAMA_URL ?? "http://127.0.0.1:11434";
const docsDir = join(evalDir, "docs2");
const voiceSpec = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const docSpec = JSON.parse(readFileSync(join(here, "documents.json"), "utf8"));
const REF = docSpec.referenceTime;
const exampleConfig = join(repo, "tools/worker-config.example.json");
const examplePrompt = JSON.parse(readFileSync(exampleConfig, "utf8")).whisperPrompt;

const E2B = "gemma4:e2b-it-q4_K_M";
const E4B = "gemma4:e4b-it-q4_K_M";
const OFF = { YA_WORKER_CONFIG: "off", YA_DOCUMENT_MODEL: "off", YA_FILL_MISSING: "0", YA_RECHECK_BELOW: "off", YA_IMAGE_OCR_HINT: "0", YA_WHISPER_PROMPT: "off" };
const WORDS = { YA_WORKER_CONFIG: exampleConfig, YA_DOCUMENT_MODEL: "off", YA_FILL_MISSING: "0", YA_IMAGE_OCR_HINT: "0", YA_RECHECK_BELOW: "off", YA_WHISPER_PROMPT: "off" };

// image: "ocr" = engine A (kordoc OCR → text), "vision" = engine B, "both" = engine B + OCR hint.
const CONFIGS = {
  stage1: { label: "1단계 그대로", bin: stage1, env: {}, image: "ocr" },
  base: { label: "기준(날짜 형식 확장만)", env: OFF, image: "ocr" },
  fill: { label: "(a) 빠진 날짜·시간 채우기", env: { ...OFF, YA_FILL_MISSING: "1" }, image: "ocr" },
  prompt: { label: "(b) whisper 용어 힌트", env: { ...OFF, YA_WHISPER_PROMPT: examplePrompt }, image: "ocr", voiceOnly: true },
  words: { label: "(c) 학교/개인 단어 목록", env: WORDS, image: "ocr" },
  e4b: { label: "(d) gemma4:e4b", env: { ...OFF, YA_TEXT_MODEL: E4B, YA_DIRECT_MODEL: E4B }, image: "ocr" },
  recheck: { label: "(e) 확신 낮으면 다시 묻기(0.7)", env: { ...OFF, YA_RECHECK_BELOW: "0.7" }, image: "ocr" },
  vision: { label: "이미지: Gemma가 직접 읽기(B)", env: OFF, image: "vision", imagesOnly: true },
  hint: { label: "(f) 이미지: 직접 읽기 + OCR 힌트", env: { ...OFF, YA_IMAGE_OCR_HINT: "1" }, image: "both", imagesOnly: true },
  hint4: { label: "(f)+(d) 이미지: e4b 직접 + OCR 힌트", env: { ...OFF, YA_IMAGE_OCR_HINT: "1", YA_DIRECT_MODEL: E4B }, image: "both", imagesOnly: true },
  docmodel: { label: "(d') 문서·이미지만 e4b", env: { ...OFF, YA_DOCUMENT_MODEL: E4B }, image: "ocr", docsOnly: true },
  combo: { label: "조합: (a)+(b)+(c)+(f)", env: { ...WORDS, YA_FILL_MISSING: "1", YA_WHISPER_PROMPT: examplePrompt, YA_IMAGE_OCR_HINT: "1" }, image: "both" },
  combo4: { label: "조합 + 문서·이미지만 e4b", env: { ...WORDS, YA_FILL_MISSING: "1", YA_WHISPER_PROMPT: examplePrompt, YA_IMAGE_OCR_HINT: "1", YA_DOCUMENT_MODEL: E4B }, image: "both", docsOnly: true },
};
const configIds = arg("configs", Object.keys(CONFIGS).join(",")).split(",");

const isImage = (fmt) => ["png", "jpg", "jpeg", "webp"].includes(fmt);
function group(doc) {
  if (doc.make === "handwriting") return "손글씨체 이미지";
  if (doc.make === "md-hwpx-png-photo") return "휴대폰 사진(JPG·WebP)";
  if (doc.make === "md-hwpx-png-scan") return "스캔 PDF";
  if (doc.make.startsWith("html-screen") || doc.make === "md-hwpx-png") return "화면 캡처·표 그림(PNG)";
  return { hwpx: "HWPX", pdf: "텍스트 PDF", docx: "DOCX", xlsx: "XLSX" }[doc.format] ?? doc.format;
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...options });
  if (r.error) throw r.error;
  return r;
}

async function unloadAll() {
  try {
    const body = await (await fetch(`${ollama}/api/ps`)).json();
    for (const m of body.models ?? []) await fetch(`${ollama}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
  } catch { /* reported by the worker */ }
}

function analyze(config, args, engine) {
  const env = { ...process.env, YA_TEXT_MODEL: E2B, YA_DIRECT_MODEL: E2B, ...config.env };
  const r = run("/usr/bin/time", ["-l", config.bin ?? worker, "analyze", ...args, "--engine", engine, "--now", REF], { env });
  let proposal = null, error = null;
  try { proposal = JSON.parse(r.stdout); } catch { /* error below */ }
  if (!proposal) {
    try { error = JSON.parse(/\{[\s\S]*\}/.exec(r.stderr)?.[0] ?? "{}").error ?? { code: "?", message: r.stderr.slice(-200) }; }
    catch { error = { code: "?", message: r.stderr.slice(-200) }; }
  }
  return { proposal, error, rss: maxRss(r.stderr) };
}

const results = { split, referenceTime: REF, generatedAt: new Date().toISOString(), voice: {}, docs: {} };
const voiceCases = split === "dev" ? docSpec.voiceDev : voiceSpec.cases;
const docs = docSpec.documents.filter((d) => d.split === split);

// Dev voice WAVs live next to the eval ones.
for (const c of docSpec.voiceDev) {
  const wav = join(evalDir, "wav", `${c.id}.wav`);
  if (!existsSync(wav)) run("say", ["-v", c.voice, "-r", String(c.rate), "-o", wav, "--data-format=LEI16@16000", c.text]);
}

for (const id of configIds) {
  const config = CONFIGS[id];
  if (!config) throw new Error(`unknown config ${id}`);
  console.error(`▶ ${config.label}`);
  await unloadAll();
  analyze(config, ["--text", "예열용 문장입니다"], "A");

  if (suites.includes("voice") && !config.imagesOnly && !config.docsOnly) {
    results.voice[id] = voiceCases.map((c) => {
      const r = analyze(config, ["--file", join(evalDir, "wav", `${c.id}.wav`)], "A");
      process.stderr.write(".");
      const items = r.proposal?.items ?? [];
      return { id: c.id, error: r.error, ms: r.proposal?.timings.totalMs ?? 0, transcript: r.proposal?.sourceText ?? "",
        items: items.map(({ kind, area, title, details, startAt, needsReview }) => ({ kind, area, title, details, startAt, needsReview })),
        score: score(c.items, items) };
    });
    process.stderr.write("\n");
  }
  if (suites.includes("docs") && !config.voiceOnly) {
    results.docs[id] = [];
    for (const d of docs) {
      if (config.imagesOnly && !isImage(d.format)) continue;
      const engine = isImage(d.format) && config.image !== "ocr" ? "B" : "A";
      const r = analyze(config, ["--file", join(docsDir, `${d.id}.${d.format}`)], engine);
      process.stderr.write(".");
      const items = r.proposal?.items ?? [];
      results.docs[id].push({ id: d.id, group: group(d), format: d.format, engine, error: r.error, ms: r.proposal?.timings.totalMs ?? 0,
        sourceText: (r.proposal?.sourceText ?? "").slice(0, 400),
        items: items.map(({ kind, area, title, details, startAt, needsReview }) => ({ kind, area, title, details, startAt, needsReview })),
        score: score(d.items, items, { withDetails: true }) });
    }
    process.stderr.write("\n");
  }
}

mkdirSync(evalDir, { recursive: true });
writeFileSync(join(evalDir, `experiments-${split}.json`), JSON.stringify(results, null, 1));

// ---- report ----
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const median = (xs) => { const s = xs.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const secs = (ms) => `${(ms / 1000).toFixed(1)}초`;
function summarize(runs) {
  const rows = runs.flatMap((r) => r.score.rows.map((x) => (r.error ? { ...x, flagged: true } : x)));
  const n = rows.length;
  const c = (f) => rows.filter((x) => x[f]).length;
  const perfect = rows.filter((x) => x.kind && x.area && x.title && x.startAt).length;
  const wrong = rows.filter((x) => !(x.kind && x.area && x.title && x.startAt));
  return { n, perfect, kind: c("kind"), area: c("area"), title: c("title"), startAt: c("startAt"),
    flaggedWrong: `${wrong.filter((x) => x.flagged).length}/${wrong.length}`,
    failures: runs.filter((r) => r.error).length, ms: median(runs.map((r) => r.ms)) };
}
const lines = [];
const label = (id) => CONFIGS[id].label;
if (Object.keys(results.voice).length) {
  lines.push(`#### 음성 (${split === "dev" ? "개선용" : "평가용"} ${voiceCases.length}문장, 정답 항목 ${voiceCases.reduce((n, c) => n + c.items.length, 0)}개, 엔진 A)`, "");
  lines.push("| 설정 | 항목 완전 정답 | 종류 | 영역 | 제목 | 시작 시각 | 틀린 항목 중 검토 표시 | 실패 | 처리 시간 중앙값 |", "|---|---|---|---|---|---|---|---|---|");
  for (const [id, runs] of Object.entries(results.voice)) {
    const s = summarize(runs);
    lines.push(`| ${label(id)} | ${pct(s.perfect, s.n)} | ${pct(s.kind, s.n)} | ${pct(s.area, s.n)} | ${pct(s.title, s.n)} | ${pct(s.startAt, s.n)} | ${s.flaggedWrong} | ${s.failures} | ${secs(s.ms)} |`);
  }
  lines.push("");
}
if (Object.keys(results.docs).length) {
  lines.push(`#### 문서·이미지 전체 (${split === "dev" ? "개선용" : "평가용"} ${docs.length}건, 정답 항목 ${docs.reduce((n, d) => n + d.items.length, 0)}개)`, "");
  lines.push("| 설정 | 대상 | 항목 완전 정답 | 종류 | 영역 | 제목 | 시작 시각 | 틀린 항목 중 검토 표시 | 실패 | 처리 시간 중앙값 |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const [id, runs] of Object.entries(results.docs)) {
    const s = summarize(runs);
    const scope = CONFIGS[id].imagesOnly ? "이미지만" : "전체";
    lines.push(`| ${label(id)} | ${scope} | ${s.perfect}/${s.n} (${pct(s.perfect, s.n)}) | ${pct(s.kind, s.n)} | ${pct(s.area, s.n)} | ${pct(s.title, s.n)} | ${pct(s.startAt, s.n)} | ${s.flaggedWrong} | ${s.failures} | ${secs(s.ms)} |`);
  }
  lines.push("", `#### 형식별 항목 완전 정답 (${split === "dev" ? "개선용" : "평가용"})`, "");
  const groups = [...new Set(docs.map(group))];
  const ids = Object.keys(results.docs);
  lines.push(`| 형식 | 건수 | ${ids.map(label).join(" | ")} |`, `|---|---|${ids.map(() => "---").join("|")}|`);
  for (const g of groups) {
    const cells = ids.map((id) => {
      const runs = results.docs[id].filter((r) => r.group === g);
      if (!runs.length) return "-";
      const s = summarize(runs);
      return `${s.perfect}/${s.n}`;
    });
    lines.push(`| ${g} | ${docs.filter((d) => group(d) === g).length} | ${cells.join(" | ")} |`);
  }
  lines.push("");
}
const md = lines.join("\n") + "\n";
console.log(md);
if (report) writeFileSync(resolve(report), md);
