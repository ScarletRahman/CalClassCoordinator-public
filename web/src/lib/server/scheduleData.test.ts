import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../__fixtures__/schedule-2027-spring.json";
import type { ScheduleTermFile } from "../schedule";
import { GET } from "@/app/api/sections/route";
import { _resetAll } from "./rateLimit";
import {
  _clearScheduleCache,
  chooseBasisTerm,
  fileAnswer,
  getSections,
  loadFileAnswer,
  mergeLive,
  mergeNotOffered,
  scheduleFiles,
  stripSeats,
  termFileName,
  termOfFileName,
  withLiveError,
} from "./scheduleData";

const spring = fixture as unknown as ScheduleTermFile;
const fall: ScheduleTermFile = { ...spring, term: "2026 Fall", generatedAt: "2026-04-01T00:00:00Z" };

let tmp: string;
let dataSchedule: string;
let stubSchedule: string;
const savedEnv = { ...process.env };

function write(dir: string, file: ScheduleTermFile) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, termFileName(file.term)), JSON.stringify(file));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-schedule-"));
  dataSchedule = path.join(tmp, "data", "schedule");
  stubSchedule = path.join(tmp, "stub", "schedule");
  write(stubSchedule, spring);
  write(stubSchedule, fall);
  fs.writeFileSync(
    path.join(stubSchedule, "index.json"),
    JSON.stringify({ terms: [{ term: "2027 Spring", file: "2027-spring.json" }, { term: "2026 Fall", file: "2026-fall.json" }, { term: "2025 Fall", file: "missing.json" }] }),
  );
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  _clearScheduleCache();
  _resetAll();
  delete process.env.WATCHER_URL;
  delete process.env.WATCHER_API_TOKEN;
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const dirs = () => [dataSchedule, stubSchedule];

describe("term file names", () => {
  it("round-trips", () => {
    expect(termFileName("2027 Spring")).toBe("2027-spring.json");
    expect(termOfFileName("2026-fall.json")).toBe("2026 Fall");
    expect(termOfFileName("index.json")).toBeNull();
    expect(termOfFileName("2026-fall.json.bak")).toBeNull();
  });
});

describe("chooseBasisTerm", () => {
  const published = ["2026 Spring", "2025 Fall", "2026 Fall", "2027 Spring"];
  it("uses the term itself when it is published", () => {
    expect(chooseBasisTerm("2027 Spring", published)).toBe("2027 Spring");
  });
  it("falls back to the most recent earlier term of the same season", () => {
    expect(chooseBasisTerm("2027 Fall", published)).toBe("2026 Fall");
    expect(chooseBasisTerm("2029 Spring", published)).toBe("2027 Spring");
  });
  it("never uses a later term or another season", () => {
    expect(chooseBasisTerm("2025 Spring", published)).toBeNull();
    expect(chooseBasisTerm("2027 Summer", published)).toBeNull();
    expect(chooseBasisTerm("2027 Fall", [])).toBeNull();
  });
});

describe("stripSeats", () => {
  it("drops seat counts and exams but keeps times and class numbers", () => {
    const [c] = stripSeats([{ ...spring.courses["COMPSCI 61A"][0], exams: [{ type: "FIN", date: "2027-05-12" }] }]);
    const orig = spring.courses["COMPSCI 61A"][0];
    expect(c.exams).toBeUndefined();
    expect(c.title).toBe(orig.title);
    for (const s of [c.primary, ...c.sections]) {
      expect(Object.keys(s).sort()).toEqual(expect.not.arrayContaining(["enrolled", "capacity", "waitlisted", "waitlistCapacity", "status", "open", "reserved"]));
    }
    expect(c.primary.classNumber).toBe(orig.primary.classNumber);
    expect(c.primary.instructor).toBe(orig.primary.instructor);
    expect(c.sections.map((s) => s.meetings)).toEqual(orig.sections.map((s) => s.meetings));
    expect(orig.primary.enrolled).toBeTypeOf("number"); // the cached file is not touched
  });
});

describe("fileAnswer", () => {
  it("answers from the term's own file", () => {
    const a = fileAnswer("COMPSCI 61A", "2027 Spring", spring, ["2027 Spring", "2026 Fall"]);
    expect(a).toMatchObject({ course: "COMPSCI 61A", term: "2027 Spring", basisTerm: "2027 Spring", tentative: false, source: "file", asOf: spring.generatedAt, live: false });
    expect(a.publishedTerms).toEqual(["2026 Fall", "2027 Spring"]);
    expect(a.classes[0].primary.enrolled).toBe(332);
    expect(a.liveError).toBeUndefined();
  });
  it("marks an earlier term's times tentative and hides seats", () => {
    const a = fileAnswer("COMPSCI 61A", "2027 Fall", fall, ["2026 Fall"]);
    expect(a).toMatchObject({ basisTerm: "2026 Fall", tentative: true, source: "file" });
    expect(a.classes[0].primary.enrolled).toBeUndefined();
    expect(a.classes[0].primary.meetings).toHaveLength(1);
  });
  it("gives an empty list for an unknown course or a missing file", () => {
    expect(fileAnswer("NOPE 1", "2027 Spring", spring, ["2027 Spring"])).toMatchObject({ classes: [], source: "file", basisTerm: "2027 Spring" });
    expect(fileAnswer("NOPE 1", "2027 Summer", null, ["2027 Spring"])).toMatchObject({ classes: [], source: "none", basisTerm: null, asOf: null, tentative: false });
  });
});

describe("merging a live lookup", () => {
  const base = fileAnswer("MATH 53", "2027 Spring", spring, ["2027 Spring"]);
  it("swaps in the watcher's classes", () => {
    const m = mergeLive(base, { classes: [spring.courses["MATH 53"][0]], source: "berkeleytime", fetchedAt: "2026-11-20T21:03:10Z" });
    expect(m).toMatchObject({ live: true, source: "berkeleytime", asOf: "2026-11-20T21:03:10Z", tentative: false, basisTerm: "2027 Spring" });
    expect(m.classes).toHaveLength(1);
    expect(m.publishedTerms).toEqual(base.publishedTerms);
  });
  it("treats a 404 as not offered", () => {
    const now = new Date("2026-11-20T22:00:00Z");
    expect(mergeNotOffered(base, { error: "not offered" }, now)).toMatchObject({ classes: [], live: true, source: "none", asOf: now.toISOString() });
    expect(mergeNotOffered(base, { error: "not offered", source: "berkeleytime" }, now).source).toBe("berkeleytime");
    expect(mergeNotOffered(base, null, now).classes).toEqual([]);
  });
  it("keeps the file data next to a live error", () => {
    const e = withLiveError(base, "nope");
    expect(e.liveError).toBe("nope");
    expect(e.classes).toBe(base.classes);
    expect(e.live).toBe(false);
  });
});

describe("files on disk", () => {
  it("falls back to the stub folder, ignoring index entries whose file is gone", () => {
    expect([...scheduleFiles(dirs()).keys()].sort()).toEqual(["2026 Fall", "2027 Spring"]);
  });
  it("prefers the data folder once it has a term file", () => {
    const other = path.join(tmp, "data2", "schedule");
    write(other, { ...spring, courses: { "MATH 53": spring.courses["MATH 53"] } });
    expect([...scheduleFiles([other, stubSchedule]).keys()]).toEqual(["2027 Spring"]);
    expect(loadFileAnswer("COMPSCI 61A", "2027 Spring", [other, stubSchedule]).classes).toEqual([]);
    expect(loadFileAnswer("MATH 53", "2027 Spring", [other, stubSchedule]).classes).toHaveLength(2);
  });
  it("answers, falls back to last year, and reports nothing for a season with no file", () => {
    expect(loadFileAnswer("COMPSCI 61A", "2027 Spring", dirs())).toMatchObject({ tentative: false, basisTerm: "2027 Spring", publishedTerms: ["2026 Fall", "2027 Spring"] });
    const tentative = loadFileAnswer("COMPSCI 61A", "2027 Fall", dirs());
    expect(tentative).toMatchObject({ tentative: true, basisTerm: "2026 Fall" });
    expect(tentative.classes[0].sections[0].capacity).toBeUndefined();
    expect(loadFileAnswer("COMPSCI 61A", "2027 Summer", dirs())).toMatchObject({ source: "none", classes: [] });
    expect(loadFileAnswer("COMPSCI 61A", "2027 Spring", [path.join(tmp, "nowhere")])).toMatchObject({ source: "none", publishedTerms: [] });
  });
  it("parses a term file once until it changes", () => {
    const read = vi.spyOn(fs, "readFileSync");
    const count = () => read.mock.calls.filter((c) => String(c[0]).endsWith("2027-spring.json")).length;
    loadFileAnswer("COMPSCI 61A", "2027 Spring", dirs());
    loadFileAnswer("MATH 53", "2027 Spring", dirs());
    loadFileAnswer("MATH 54", "2027 Spring", dirs());
    expect(count()).toBe(1);
    const p = path.join(stubSchedule, "2027-spring.json");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(p, later, later);
    loadFileAnswer("MATH 53", "2027 Spring", dirs());
    expect(count()).toBe(2);
  });
});

describe("getSections with live=1", () => {
  const lookup = { course: "MATH 53", term: "2027 Spring", source: "berkeleytime", fetchedAt: "2026-11-20T21:03:10Z", cached: false, classes: [spring.courses["MATH 53"][1]] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("does not call the watcher unless asked", async () => {
    process.env.WATCHER_URL = "http://watcher.test";
    const fetchImpl = vi.fn();
    const a = await getSections("MATH 53", "2027 Spring", { dirs: dirs(), fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(a.live).toBe(false);
  });
  it("asks the watcher with the bearer token and returns its answer", async () => {
    process.env.WATCHER_URL = "http://watcher.test/";
    process.env.WATCHER_API_TOKEN = "s3cret";
    const fetchImpl = vi.fn(async () => json(lookup));
    const a = await getSections("MATH 53", "2027 Spring", { live: true, dirs: dirs(), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://watcher.test/lookup?course=MATH%2053&term=2027%20Spring");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(a).toMatchObject({ live: true, source: "berkeleytime", asOf: lookup.fetchedAt });
    expect(a.classes).toHaveLength(1);
    expect(a.liveError).toBeUndefined();
  });
  it("returns no classes when the watcher says 404", async () => {
    process.env.WATCHER_URL = "http://watcher.test";
    const a = await getSections("MATH 53", "2027 Spring", { live: true, dirs: dirs(), fetchImpl: async () => json({ error: "not offered" }, 404) });
    expect(a).toMatchObject({ classes: [], live: true });
  });
  it("keeps the saved times when an older watcher has no /lookup at all", async () => {
    process.env.WATCHER_URL = "http://watcher.test";
    const a = await getSections("MATH 53", "2027 Spring", { live: true, dirs: dirs(), fetchImpl: async () => json({ error: "not found" }, 404) });
    expect(a.live).toBe(false);
    expect(a.classes.length).toBeGreaterThan(0);
    expect(a.liveError).toBeTruthy();
  });
  it("falls back to the file with liveError on 502, bad bodies and network errors", async () => {
    process.env.WATCHER_URL = "http://watcher.test";
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const fetchImpl of [
      async () => json({ error: "no source could answer" }, 502),
      async () => json({ nope: true }),
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ]) {
      const a = await getSections("MATH 53", "2027 Spring", { live: true, dirs: dirs(), fetchImpl });
      expect(a.live).toBe(false);
      expect(a.source).toBe("file");
      expect(a.liveError).toBeTruthy();
      expect(a.classes).toHaveLength(2);
    }
  });
  it("skips the watcher for tentative terms and when WATCHER_URL is unset", async () => {
    const fetchImpl = vi.fn();
    const unset = await getSections("MATH 53", "2027 Spring", { live: true, dirs: dirs(), fetchImpl });
    expect(unset.liveError).toBeTruthy();
    process.env.WATCHER_URL = "http://watcher.test";
    const tentative = await getSections("MATH 53", "2027 Fall", { live: true, dirs: dirs(), fetchImpl });
    expect(tentative).toMatchObject({ tentative: true, live: false });
    expect(tentative.liveError).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/sections", () => {
  const get = (qs: string, ip = "1.2.3.4") => GET(new Request(`http://localhost/api/sections?${qs}`, { headers: { "x-forwarded-for": ip } }));

  it("answers from the stub data shipped with the app", async () => {
    process.env.CCC_DATA_DIR = path.join(tmp, "nowhere");
    const r = await get("course=compsci%2061a&term=2027%20Spring");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, max-age=60");
    const body = await r.json();
    expect(body).toMatchObject({ course: "COMPSCI 61A", term: "2027 Spring", tentative: false, source: "file", live: false });
    expect(body.classes[0].sections.length).toBeGreaterThan(40);
  });
  it("marks live answers no-store", async () => {
    process.env.CCC_DATA_DIR = path.join(tmp, "nowhere");
    const r = await get("course=MATH%2053&term=2027%20Spring&live=1");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).liveError).toBeTruthy();
  });
  it("rejects malformed input", async () => {
    for (const qs of ["term=2027%20Spring", "course=MATH%2053", "course=MATH%2053&term=Spring%202027", "course=MATH&term=2027%20Spring", "course=..%2F..%2Fetc%2053&term=2027%20Spring", `course=${"A".repeat(40)}%201&term=2027%20Spring`, "course=MATH%2053&term=2027%20Winter"]) {
      expect((await get(qs)).status, qs).toBe(400);
    }
  });
  it("rate limits live lookups separately", async () => {
    process.env.CCC_DATA_DIR = path.join(tmp, "nowhere");
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await get("course=MATH%2053&term=2027%20Spring&live=1", "9.9.9.9")).status;
    expect(last).toBe(429);
    expect((await get("course=MATH%2053&term=2027%20Spring", "9.9.9.9")).status).toBe(200);
  });
});
