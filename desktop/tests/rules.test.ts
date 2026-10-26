import { describe, expect, it } from "vitest";
import golden from "./fixtures/rule-cases.json";
import { parseRule } from "../src/calendar/rules";

describe("rule parser (same rules as the phone's KoreanCommandParser)", () => {
  const [d, t] = golden.referenceLocal.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const now = new Date(y, m - 1, day, hh, mm);

  it.each(golden.cases)("$text", (c) => {
    const r = parseRule(c.text, now);
    expect(r.kind).toBe(c.kind);
    expect(r.title).toBe(c.title);
    expect(r.date && r.time ? `${r.date}T${r.time}` : "").toBe(c.start);
    expect(r.needsReview).toBe(c.needsReview);
    expect(r.explanation).toBe(c.explanation);
  });

  it("answers well under a millisecond per sentence", () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) for (const c of golden.cases) parseRule(c.text, now);
    const per = (performance.now() - t0) / (200 * golden.cases.length);
    expect(per).toBeLessThan(1);
  });
});
