import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTerm, parseTerm, termLabel } from "./terms";

describe("normalizeTerm", () => {
  it("accepts both spellings", () => {
    expect(normalizeTerm("Spring 2027")).toBe("2027 Spring");
    expect(normalizeTerm("2027 Spring")).toBe("2027 Spring");
    expect(normalizeTerm(" fall 2026 ")).toBe("2026 Fall");
  });
});

// The predictor's real output, when present, must name a term the planner can read.
const file = path.join(process.env.CCC_DATA_DIR ?? path.resolve(process.cwd(), "..", "data"), "predictions", "predictions.json");
describe.skipIf(!fs.existsSync(file))("real predictions file", () => {
  it("has a readable term and course ids in catalog form", () => {
    const f = JSON.parse(fs.readFileSync(file, "utf8")) as { term: string; predictions: { course: string }[] };
    const t = parseTerm(normalizeTerm(f.term));
    expect(t.year).toBeGreaterThan(2020);
    expect(["Spring", "Summer", "Fall"]).toContain(t.season);
    expect(termLabel(normalizeTerm(f.term))).not.toMatch(/NaN|undefined/);
    expect(f.predictions.length).toBeGreaterThan(0);
    for (const p of f.predictions) expect(p.course).toMatch(/^[A-Z]+ [A-Z]*\d+[A-Z]*$/);
  });
});
