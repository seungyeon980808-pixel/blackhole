import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const packageJson = JSON.parse(await text("package.json"));
const tauri = JSON.parse(await text("src-tauri/tauri.conf.json"));
const capability = JSON.parse(await text("src-tauri/capabilities/default.json"));
const domain = await text("src/domain.ts");
const commands = await text("src-tauri/src/commands.rs");
const desk = await text("src-tauri/src/desk.rs");
const calendarRs = await text("src-tauri/src/calendar.rs");
const rustModels = await text("src-tauri/src/models.rs");
const rustCache = await text("src-tauri/src/cache.rs");
const rustFixtures = await text("src-tauri/src/fixtures.rs");
const tauriAdapter = await text("src/adapters/tauri.ts");
const samples = await text("src/calendar/samples.ts");
const baseCss = await text("src/calendar/styles/base.css");
const workflow = await text("../.github/workflows/windows-desktop.yml");

check(packageJson.version === "0.2.0", "package version must be 0.2.0");
check(tauri.version === "0.2.0", "Tauri version must be 0.2.0");
check(tauri.productName === "Blackhole", "Tauri productName must be Blackhole");
check(tauri.identifier === "com.malhaedwo.blackhole.desktop", "Tauri identifier must stay unchanged (app data continuity)");
check(tauri.app.windows[0].title === "블랙홀", "window title must be 블랙홀");
check(tauri.app.windows[0].backgroundThrottling === "disabled", "the calendar page must keep running when the window is hidden (inbox drafts, results)");
check(JSON.stringify(tauri.bundle.targets) === JSON.stringify(["nsis", "msi"]), "Windows NSIS and MSI targets must stay configured");
check(tauri.bundle.windows.nsis.installMode === "currentUser", "NSIS must install per-user");
check(tauri.bundle.windows.webviewInstallMode.type === "downloadBootstrapper", "WebView2 bootstrapper required");
const csp = tauri.app.security.csp;
check(csp.includes("default-src 'self'"), "local-only CSP required");
check(/script-src 'self';/.test(csp), "scripts must come from the app only");
check(!/https?:\/\/(?!ipc\.localhost)/.test(csp) && !csp.includes("https:"), "CSP must not allow remote content");
check(JSON.stringify(capability.permissions) === JSON.stringify(["core:default", "core:window:allow-start-dragging"]), "capability must contain core and window dragging only");
check(!JSON.stringify(capability).match(/shell|http|fs:/i), "forbidden capability detected");

const columnsBlock = domain.match(/ITEM_COLUMNS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "";
const columnCount = [...columnsBlock.matchAll(/"[A-Za-z]+"/g)].length;
check(columnCount === 23, `Items schema must contain 23 columns, found ${columnCount}`);
const rustItemBlock = rustModels.match(/pub struct Item \{([\s\S]*?)\n\}/)?.[1] ?? "";
const rustFieldCount = [...rustItemBlock.matchAll(/^\s*pub\s+[a-z_]+:/gm)].length;
check(rustFieldCount === 23, `Rust Item schema must contain 23 fields, found ${rustFieldCount}`);
check((rustFixtures.match(/"fixture-[a-z]+-[0-9]+"/g) ?? []).length === 3, "native fixture must contain exactly 3 items");
check(rustCache.includes("cache_roundtrip_preserves_envelope"), "native cache roundtrip test required");
check(rustCache.includes("corrupt_cache_is_quarantined_and_recovers_empty"), "native corrupt recovery test required");
check(commands.includes('state: "unconfigured"') && commands.includes("can_write: false"), "native Google connection must stay unconfigured and read-only");

// Stage 2 calendar contract
check(tauriAdapter.includes('label: "로컬·미연결"'), "desktop must show 「로컬·미연결」");
check(samples.includes("sample: true") && samples.includes("가짜 자료"), "seeded data must be marked as fake");
check(calendarRs.includes("fn check_inbox_root") && calendarRs.includes("cloudstorage"), "inbox must refuse cloud-synced folders");
check(calendarRs.includes("synced_folders_are_refused") && calendarRs.includes("state_roundtrip_and_corrupt_file_is_moved_aside"), "calendar storage tests required");
check(desk.includes("TEST_INBOX_DIR"), "inbox must default to the local test folder");
check(baseCss.includes(":focus-visible"), "visible keyboard focus treatment required");
check(baseCss.includes("prefers-reduced-motion"), "reduced motion support required");
check(baseCss.includes("size: A4"), "A4 print layout required");
const lock = JSON.parse(await text("package-lock.json"));
for (const [name, info] of Object.entries(lock.packages ?? {})) {
  if (!name.includes("@fullcalendar/")) continue;
  check(info.license === "MIT", `${name} must be MIT (found ${info.license})`);
  check(!/resource|scheduler|premium|timeline/.test(name), `premium FullCalendar plugin not allowed: ${name}`);
}

for (const step of ["npm ci", "npm test", "npm run build", "cargo test --locked", "--bundles nsis,msi", "upload-artifact@v4"]) {
  check(workflow.includes(step), `workflow missing: ${step}`);
}
check(!workflow.match(/action-gh-release|gh\s+release|npm\s+publish/i), "workflow must not publish releases");

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory)) {
    if (["node_modules", "dist", "target"].includes(entry)) continue;
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...await filesUnder(path)); else result.push(path);
  }
  return result;
}

const rootPath = fileURLToPath(new URL(".", root));
const allFiles = await filesUnder(rootPath);
const forbiddenNames = /\.(wav|db|sqlite|log)$/i;
const sensitiveContent = [
  /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{15,}/,
  /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{15,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /ya29\.[0-9A-Za-z_-]+/,
  /"(?:client_secret|refresh_token|access_token)"\s*:/i
];
for (const path of allFiles) {
  const name = relative(rootPath, path);
  if (/^src\/(calendar|phone)\/.*\.ts$/.test(name)) {
    const code = await readFile(path, "utf8");
    check(!code.includes("@tauri-apps"), `calendar module must not import Tauri (phone WebView reuse): ${name}`);
  }
  if (/^src\/.*\.ts$/.test(name)) {
    const code = await readFile(path, "utf8");
    check(!/googleapis\.com|calendar\/v3|sheets\.googleapis/.test(code), `no Google API calls in stage 2: ${name}`);
  }
  check(!forbiddenNames.test(name), `forbidden artifact file: ${name}`);
  if (/\.(ico|png|jpg|jpeg|gif|webp|lock)$/i.test(name)) continue;
  const content = await readFile(path, "utf8");
  for (const pattern of sensitiveContent) check(!pattern.test(content), `possible private Google configuration in ${name}`);
}

if (failures.length) {
  console.error("Acceptance check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("Acceptance check passed: safe local Blackhole Desktop v0.2.0 calendar source contract verified.");
