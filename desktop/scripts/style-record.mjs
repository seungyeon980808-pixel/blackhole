// Runs the owner-style sentences (tests/fixtures/style-cases.json) through the real worker
// (Claude Haiku, key from the keychain) and keeps its answers in style-proposals.json, which
// tests/style-cases.test.ts then puts through the app. Costs about a won per sentence; the
// answer cache is off so every run is a fresh answer.
//   node scripts/style-record.mjs 1            every case of style-cases.json (sets: 1, 2, holdout, files)
//   node scripts/style-record.mjs 2 s5 x2      only these
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worker = join(root, "src-tauri", "target", "release", "blackhole-worker");
const SETS = { 1: ["style-cases.json", "style-proposals.json"], 2: ["style-cases-2.json", "style-proposals-2.json"], holdout: ["style-holdout.json", "style-holdout-proposals.json"], holdout2: ["style-holdout-2.json", "style-holdout-2-proposals.json"], holdout3: ["style-holdout-3.json", "style-holdout-3-proposals.json"], files: ["style-files.json", "style-files-proposals.json"] };
const [set, ...only] = process.argv.slice(2);
if (!SETS[set]) {
  console.error(`set: ${Object.keys(SETS).join(" | ")}`);
  process.exit(2);
}
const fixtures = join(root, "tests", "fixtures");
const casesFile = join(fixtures, SETS[set][0]);
const outFile = join(fixtures, SETS[set][1]);
const { now, cases } = JSON.parse(readFileSync(casesFile, "utf8"));
const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
for (const id of Object.keys(out)) if (!cases.some((c) => c.id === id)) delete out[id];

const run = (c) =>
  new Promise((resolve) => {
    const input = c.file ? ["--file", join(fixtures, c.file)] : ["--text", c.text];
    execFile(worker, ["analyze", ...input, "--now", now], { maxBuffer: 1 << 22, env: { ...process.env, BLACKHOLE_NO_ANSWER_CACHE: "1" } }, (err, stdout, stderr) => {
      if (err) return resolve({ id: c.id, error: (stderr || String(err)).slice(0, 300) });
      const p = JSON.parse(stdout);
      delete p.timings;
      resolve({ id: c.id, proposal: p });
    });
  });

const todo = cases.filter((c) => !only.length || only.includes(c.id));
let next = 0;
const lanes = Array.from({ length: 4 }, async () => {
  while (next < todo.length) {
    const c = todo[next++];
    const r = await run(c);
    if (r.error) console.log(`✗ ${c.id} ${r.error}`);
    else {
      out[c.id] = { text: c.text ?? c.file, proposal: r.proposal };
      console.log(`✓ ${c.id} ${r.proposal.items.map((x) => `${x.kind}:${x.title}`).join(" | ")}`);
    }
  }
});
await Promise.all(lanes);
writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
