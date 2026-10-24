import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProposal } from "../src/worker/proposal";

const sample = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/proposal-sample.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas/proposal.v1.schema.json"), "utf8"));
const clone = () => structuredClone(sample);

describe("worker proposal v1", () => {
  it("accepts real worker output (synthetic input)", () => {
    expect(isProposal(sample)).toBe(true);
    expect(sample.items.map((item: { kind: string }) => item.kind)).toEqual(["SCHEDULE", "NOTE"]);
  });

  it("rejects malformed proposals instead of repairing them", () => {
    const broken = [
      (p: any) => { p.schemaVersion = 2; },
      (p: any) => { p.items[0].kind = "MEETING"; },
      (p: any) => { p.items[0].area = "WORK"; },
      (p: any) => { p.items[0].title = ""; },
      (p: any) => { p.items[0].startAt = "내일"; },
      (p: any) => { p.items[0].confidence = 1.5; },
      (p: any) => { p.source.sha256 = "abc"; },
      (p: any) => { p.engine.id = "C"; },
      (p: any) => { delete p.timings; },
    ];
    for (const breakIt of broken) {
      const p = clone();
      breakIt(p);
      expect(isProposal(p)).toBe(false);
    }
  });

  it("keeps the JSON schema and the sample in step", () => {
    expect(Object.keys(sample).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(sample.items[0]).sort()).toEqual([...schema.$defs.item.required].sort());
    expect(schema.$defs.item.properties.kind.enum).toEqual(["SCHEDULE", "TODO", "NOTE"]);
  });
});
