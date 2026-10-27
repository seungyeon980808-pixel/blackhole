/**
 * CSS 괄호 짝 (2026-10-28 밤샘): 남는 「}」 하나가 바로 뒤 규칙(설정 → 루틴 줄)을 통째로 무시하게 만들었다.
 * 빌드는 경고만 내고 지나가서, 시험으로 막는다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".css") ? [p] : [];
  });

it.each(files(join(__dirname, "../src")))("%s has balanced braces", (f) => {
  const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  let depth = 0;
  const bad: number[] = [];
  css.split("\n").forEach((line, i) => {
    for (const c of line) {
      depth += c === "{" ? 1 : c === "}" ? -1 : 0;
      if (depth < 0) {
        bad.push(i + 1);
        depth = 0;
      }
    }
  });
  expect({ extraCloseAt: bad, unclosed: depth }).toEqual({ extraCloseAt: [], unclosed: 0 });
});
