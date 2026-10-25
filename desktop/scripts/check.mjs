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
const fixtures = await text("src/fixtures.ts");
const ui = await text("src/ui.ts");
const styles = await text("src/styles.css");
const commands = await text("src-tauri/src/commands.rs");
const rustModels = await text("src-tauri/src/models.rs");
const rustCache = await text("src-tauri/src/cache.rs");
const rustFixtures = await text("src-tauri/src/fixtures.rs");
const workflow = await text("../.github/workflows/windows-desktop.yml");

check(packageJson.version === "0.1.1", "package version must be 0.1.1");
check(tauri.productName === "Blackhole Desktop", "Tauri productName must be Blackhole Desktop");
check(tauri.identifier === "com.malhaedwo.blackhole.desktop", "unexpected Tauri identifier");
check(tauri.version === "0.1.1", "Tauri version must be 0.1.1");
check(JSON.stringify(tauri.bundle.targets) === JSON.stringify(["nsis", "msi"]), "NSIS and MSI targets required");
check(tauri.bundle.windows.nsis.installMode === "currentUser", "NSIS must install per-user");
check(tauri.bundle.windows.webviewInstallMode.type === "downloadBootstrapper", "WebView2 bootstrapper required");
check(tauri.app.security.csp.includes("default-src 'self'"), "local-only CSP required");
check(!tauri.app.security.csp.includes("https:"), "CSP must not allow remote HTTPS content");
check(capability.permissions.length === 1 && capability.permissions[0] === "core:default", "capability must contain core only");
check(!JSON.stringify(capability).match(/shell|http|fs:/i), "forbidden capability detected");

const columnsBlock = domain.match(/ITEM_COLUMNS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "";
const columnCount = [...columnsBlock.matchAll(/"[A-Za-z]+"/g)].length;
check(columnCount === 23, `Items schema must contain 23 columns, found ${columnCount}`);
const rustItemBlock = rustModels.match(/pub struct Item \{([\s\S]*?)\n\}/)?.[1] ?? "";
const rustFieldCount = [...rustItemBlock.matchAll(/^\s*pub\s+[a-z_]+:/gm)].length;
check(rustFieldCount === 23, `Rust Item schema must contain 23 fields, found ${rustFieldCount}`);
check((fixtures.match(/itemId:\s*"fixture-/g) ?? []).length === 3, "frontend fixture must contain exactly 3 items");
check((rustFixtures.match(/"fixture-[a-z]+-[0-9]+"/g) ?? []).length === 3, "native fixture must contain exactly 3 items");
check(rustCache.includes("cache_roundtrip_preserves_envelope"), "native cache roundtrip test required");
check(rustCache.includes("corrupt_cache_is_quarantined_and_recovers_empty"), "native corrupt recovery test required");
check(fixtures.includes("가상") && fixtures.includes("인공 데이터"), "fixtures must be clearly artificial");
check(ui.includes("WRITE_DISABLED_REASON") && ui.includes("disabled"), "write controls must be disabled with a reason");
check(styles.includes('"Segoe UI Variable"') && styles.includes('"Malgun Gothic"'), "Windows and Korean legible font stack required");
check(styles.includes(":focus-visible"), "visible keyboard focus treatment required");
check(styles.includes("prefers-reduced-motion"), "reduced motion support required");
check(!/gradient\s*\(|box-shadow\s*:|Consolas|text-transform\s*:\s*uppercase/i.test(styles), "generic decorative UI treatment detected");
check(!ui.includes("VOICE APPROVAL DESK") && !ui.includes("YA DESKTOP"), "ornamental English labels must not return");
check(commands.includes('state: "unconfigured"') && commands.includes("can_write: false"), "native connection status must be unconfigured and read-only");
for (const command of ["load_local_cache", "store_local_cache", "bootstrap_fixture"]) {
  check(commands.includes(command), `missing native command: ${command}`);
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
  check(!forbiddenNames.test(name), `forbidden artifact file: ${name}`);
  if (/\.(ico|png|jpg|jpeg|gif|webp|lock)$/i.test(name)) continue;
  const content = await readFile(path, "utf8");
  for (const pattern of sensitiveContent) check(!pattern.test(content), `possible private Google configuration in ${name}`);
}

if (failures.length) {
  console.error("Acceptance check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("Acceptance check passed: safe local Blackhole Desktop v0.1.1 source contract verified.");
