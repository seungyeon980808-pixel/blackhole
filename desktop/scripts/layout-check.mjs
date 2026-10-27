// 레이아웃 검사 (실제 브라우저): 창 4가지 × 대화 열림/접힘 × 테마 2가지에서
//   (a) 창 밖으로 나간 칸 0  (b) 칸끼리 겹침 0  (c) 날짜 줄과 아래 칸의 좌우 끝선 일치
// 가짜 자료(tests/layout)만 씁니다. 사용: npm run layout  (그림: LAYOUT_OUT=폴더)
// playwright-core와 Chromium은 이 저장소에 넣지 않습니다: 설치된 것을 PLAYWRIGHT_CORE·CHROMIUM으로 알려 주면 씁니다.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const p of [process.env.PLAYWRIGHT_CORE, "playwright-core"].filter(Boolean)) {
    try {
      return require(p);
    } catch {
      /* next */
    }
  }
  return null;
}
function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const exe = dir && join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  return exe && existsSync(exe) ? exe : undefined;
}

const pw = loadPlaywright();
if (!pw) {
  console.log("레이아웃 검사 건너뜀: playwright-core가 없습니다 (PLAYWRIGHT_CORE=경로 로 알려 주세요)");
  process.exit(0);
}
const PORT = Number(process.env.LAYOUT_PORT || 1437);
const OUT = process.env.LAYOUT_OUT || join(tmpdir(), "blackhole-layout");
mkdirSync(OUT, { recursive: true });
const MOCK = readFileSync(join(ROOT, "tests/layout/mock-tauri.js"), "utf8");
const FIXTURE = readFileSync(join(ROOT, "tests/layout/fixture.js"), "utf8");

// vite itself (not through run-tool, whose child would outlive a kill); same esbuild as run-tool on macOS.
const env = { ...process.env };
if (process.platform === "darwin") env.ESBUILD_BINARY_PATH = join(ROOT, "node_modules", "esbuild-wasm", "bin", "esbuild");
const server = spawn(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORT), "--strictPort"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("vite가 15초 안에 뜨지 않음")), 15000);
  server.stdout.on("data", (d) => String(d).includes(`${PORT}`) && (clearTimeout(t), resolve()));
  server.once("exit", (c) => reject(new Error(`vite 종료 ${c} (포트 ${PORT}을 다른 것이 쓰는지 확인)`)));
});

const SIZES = [[1000, 620], [1280, 800], [1440, 900], [1728, 1117]];
const browser = await pw.chromium.launch({ executablePath: chromiumPath() });
const fails = [];
let n = 0;
try {
  for (const theme of ["glass", "doc"]) {
    for (const [w, h] of SIZES) {
      for (const chat of ["open", "closed"]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
        await ctx.addInitScript(`window.__BH_LAYOUT=${JSON.stringify({ theme, chat })};\n${FIXTURE}`);
        await ctx.addInitScript(MOCK);
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`http://127.0.0.1:${PORT}/`);
        // The Mac window shows the desktop through (vibrancy); a plain backdrop stands in for it.
        await page.addStyleTag({ content: "html.native-glass{background:linear-gradient(135deg,#1d3f7a,#2a5f9a 50%,#2e8796) !important}" });
        await page.waitForSelector(".tdv .tgrid", { timeout: 8000 });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
          const box = (el) => {
            const b = el.getBoundingClientRect();
            return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
          };
          const side = document.querySelector(".bh.side") ? document.querySelector(".chatsheet") : null;
          const named = [
            ["머리줄", document.querySelector(".bar, .tool")],
            ["날짜 줄", document.querySelector(".wkd")],
            ["하루표", document.querySelector(".tgrid > .dt")],
            ["할 일", document.querySelector(".tgrid > .tl")],
            ["주요 일정", document.querySelector(".rstack .ups")],
            ["루틴", document.querySelector(".rstack .rts")],
            ["대화", side],
            ["입력", document.querySelector("#bhComp .inp, #bhComp .form")]
          ].filter(([, el]) => el && el.getBoundingClientRect().width > 0).map(([name, el]) => ({ name, ...box(el) }));
          const W = window.innerWidth;
          const H = window.innerHeight;
          const out = named.filter((x) => x.l < -1 || x.t < -1 || x.r > W + 1 || x.b > H + 1).map((x) => `${x.name}(${Math.round(x.l)},${Math.round(x.t)},${Math.round(x.r)},${Math.round(x.b)})`);
          const overlap = [];
          for (let i = 0; i < named.length; i++) {
            for (let j = i + 1; j < named.length; j++) {
              const a = named[i];
              const b = named[j];
              const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
              const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
              if (x > 1 && y > 1) overlap.push(`${a.name}↔${b.name}`);
            }
          }
          const wk = document.querySelector(".wkd")?.getBoundingClientRect();
          const grid = document.querySelector(".tgrid")?.getBoundingClientRect();
          const edge = wk && grid && (Math.abs(wk.left - grid.left) > 1 || Math.abs(wk.right - grid.right) > 1) ? `날짜 줄 ${Math.round(wk.left)}–${Math.round(wk.right)} / 칸 ${Math.round(grid.left)}–${Math.round(grid.right)}` : "";
          const page = document.scrollingElement;
          const scroll = page.scrollWidth > W + 1 || page.scrollHeight > H + 1 ? `창 전체가 스크롤됨 ${page.scrollWidth}×${page.scrollHeight}` : "";
          return { out, overlap, edge, scroll, mode: document.querySelector(".bh.side") ? "옆 대화" : document.querySelector(".bh.panel-closed") ? "접힘" : "서랍" };
        });
        const tag = `${theme}-${w}x${h}-${chat}`;
        await page.screenshot({ path: join(OUT, `${tag}.png`) });
        // Too narrow for the panel and the chat 「open」: the drawer slides in and stays inside the window.
        if (r.mode === "서랍" && chat === "open") {
          await page.click('[data-panel="open"]');
          await page.waitForTimeout(450);
          const d = await page.evaluate(() => {
            const b = document.querySelector(".chatsheet").getBoundingClientRect();
            return b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1 && b.width > 200 ? "" : `서랍이 창 밖 (${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)})`;
          });
          if (d) r.out.push(d);
          await page.screenshot({ path: join(OUT, `${tag}-drawer.png`) });
        }
        const bad = [...r.out.map((x) => `창 밖: ${x}`), ...r.overlap.map((x) => `겹침: ${x}`), r.edge && `끝선: ${r.edge}`, r.scroll, ...errors].filter(Boolean);
        n++;
        console.log(`${bad.length ? "✗" : "✓"} ${tag} (${r.mode})${bad.length ? " — " + bad.join(" · ") : ""}`);
        if (bad.length) fails.push(tag);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n레이아웃 검사 ${n - fails.length}/${n} 통과 · 그림: ${OUT}`);
process.exit(fails.length ? 1 : 0);
