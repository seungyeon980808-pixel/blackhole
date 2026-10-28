// Runs the owner-style sentences (tests/fixtures/style-cases.json) through the real worker
// (Claude Haiku, key from the keychain) and keeps its answers in style-proposals.json, which
// tests/style-cases.test.ts then puts through the app. Costs a few won per sentence.
//   node scripts/style-record.mjs            every case
//   node scripts/style-record.mjs d5 t9      only these
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worker = join(root, "src-tauri", "target", "release", "blackhole-worker");
const casesFile = join(root, "tests", "fixtures", "style-cases.json");
const outFile = join(root, "tests", "fixtures", "style-proposals.json");
const { now, cases } = JSON.parse(readFileSync(casesFile, "utf8"));
const only = process.argv.slice(2);
const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};

const run = (c) =>
  new Promise((resolve) => {
    execFile(worker, ["analyze", "--text", c.text, "--now", now], { maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
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
      out[c.id] = { text: c.text, proposal: r.proposal };
      console.log(`✓ ${c.id} ${r.proposal.items.map((x) => `${x.kind}:${x.title}`).join(" | ")}`);
    }
  }
});
await Promise.all(lanes);
writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
