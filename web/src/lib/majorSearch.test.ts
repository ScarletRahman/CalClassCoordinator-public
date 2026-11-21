import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aliasesFor, collegeShortLabel, programShortName, searchMajors, searchMinors, squash } from "./majorSearch";
import type { College, Major, Minor } from "./types";

const DATA = process.env.CCC_DATA_DIR ?? path.resolve(process.cwd(), "..", "data");
const has = fs.existsSync(path.join(DATA, "requirements", "majors.json"));
const read = <T,>(rel: string) => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")) as T;

describe("major search (inline fixture)", () => {
  const majors = [
    { name: "Physics", degree: "BA", college: "LS" },
    { name: "Cognitive Science", degree: "BA", college: "LS" },
    { name: "Computer Science", degree: "BA", college: "CDSS" },
    { name: "Electrical Engineering and Computer Sciences", degree: "BS", college: "COE" },
    { name: "Statistics", degree: "BA", college: "CDSS" },
    { name: "Data Science", degree: "BA", college: "CDSS" },
    { name: "Dutch Studies", degree: "BA", college: "LS" },
    { name: "Business Administration", degree: "BS", college: "HAAS" },
    { name: "Made Up Program", degree: "BA", college: "LS", aliases: ["mup", "invented"] },
  ];
  const colleges = [
    { id: "LS", name: "College of Letters & Science" },
    { id: "CDSS", name: "College of Computing, Data Science, and Society" },
    { id: "COE", name: "College of Engineering" },
    { id: "HAAS", name: "Haas School of Business" },
  ];
  const names = (q: string) => searchMajors(q, majors, colleges).map((h) => h.item.name);

  it("ranks the shorthand above initials and never surfaces mid-word hits like physiCS", () => {
    expect(names("cs")).toEqual(["Computer Science", "Electrical Engineering and Computer Sciences", "Cognitive Science"]);
    expect(names("ds")).toEqual(["Data Science", "Dutch Studies"]);
  });

  it("ignores case, spaces and punctuation", () => {
    for (const q of ["cogsci", "Cog Sci", "COG-SCI", " cog.sci "]) expect(names(q)[0]).toBe("Cognitive Science");
    expect(squash("L & S")).toBe("lands");
  });

  it("uses aliases from the data file as well as the built-in table", () => {
    expect(names("mup")).toEqual(["Made Up Program"]);
    expect(names("inv")[0]).toBe("Made Up Program");
    expect(aliasesFor({ name: "Computer Science", aliases: ["cs", "csba"] })).toEqual(["cs", "compsci", "lscs", "csba"]);
  });

  it("tags a result only when the reason is not visible in its name", () => {
    const cs = searchMajors("cs", majors, colleges);
    expect(cs[0].tag).toBe("cs");
    expect(cs[2]).toMatchObject({ kind: "initials", tag: "cs" });
    expect(searchMajors("stat", majors, colleges)[0].tag).toBeUndefined();
    expect(searchMajors("haas", majors, colleges)[0]).toMatchObject({ item: { name: "Business Administration" }, tag: "haas" });
  });

  it("finds programs by college, last", () => {
    expect(names("engineering")).toEqual(["Electrical Engineering and Computer Sciences"]);
    expect(names("l&s")).toEqual(expect.arrayContaining(["Physics", "Cognitive Science", "Dutch Studies"]));
  });

  it("forgives one typo when nothing else matches, and returns nothing for nonsense", () => {
    expect(names("phsyics")).toEqual(["Physics"]);
    expect(names("statistcs")).toEqual(["Statistics"]);
    expect(names("zzzz")).toEqual([]);
  });

  it("returns everything in order for an empty query", () => {
    expect(names("  ")).toEqual(majors.map((m) => m.name));
  });

  it("short names and college labels", () => {
    expect(programShortName("Cognitive Science BA")).toBe("CogSci");
    expect(programShortName("Data Science")).toBe("DS");
    expect(programShortName("Statistics", { minor: true })).toBe("Stats minor");
    expect(programShortName("Legal Studies BA")).toBe("Legal Studies");
    expect(programShortName("Sustainable Environmental Design BA")).toBe("SED");
    expect(collegeShortLabel("LS")).toBe("L&S");
    expect(collegeShortLabel("XYZ", [{ id: "XYZ", name: "School of X" }])).toBe("School of X");
  });
});

describe.skipIf(!has)("major search on the real catalog", () => {
  const majors = has ? read<Major[]>("requirements/majors.json") : [];
  const minors = has ? read<Minor[]>("requirements/minors.json") : [];
  const colleges = has ? read<College[]>("requirements/colleges.json") : [];
  const top = (q: string, n = 1) => searchMajors(q, majors, colleges).slice(0, n).map((h) => `${h.item.name} ${h.item.degree}`);

  // query -> the major that must come first
  const FIRST: [string, string][] = [
    ["cs", "Computer Science BA"],
    ["comp sci", "Computer Science BA"],
    ["compsci", "Computer Science BA"],
    ["ds", "Data Science BA"],
    ["data sci", "Data Science BA"],
    ["cogsci", "Cognitive Science BA"],
    ["cog sci", "Cognitive Science BA"],
    ["eecs", "Electrical Engineering and Computer Sciences BS"],
    ["EE", "Electrical Engineering and Computer Sciences BS"],
    ["mcb", "Molecular and Cell Biology BA"],
    ["ib", "Integrative Biology BA"],
    ["econ", "Economics BA"],
    ["polisci", "Political Science BA"],
    ["poli sci", "Political Science BA"],
    ["psych", "Psychology BA"],
    ["stats", "Statistics BA"],
    ["stat", "Statistics BA"],
    ["ieor", "Industrial Engineering and Operations Research BS"],
    ["meche", "Mechanical Engineering BS"],
    ["mech e", "Mechanical Engineering BS"],
    ["bioe", "Bioengineering BS"],
    ["bio e", "Bioengineering BS"],
    ["mse", "Materials Science and Engineering BS"],
    ["cee", "Civil Engineering BS"],
    ["cheme", "Chemical Engineering BS"],
    ["eep", "Environmental Economics and Policy BS"],
    ["crs", "Conservation and Resource Studies BS"],
    ["isf", "Interdisciplinary Studies BA"],
    ["haas", "Business Administration BS"],
    ["biz", "Business Administration BS"],
    ["business", "Business Administration BS"],
    ["ph", "Public Health BA"],
    ["nst", "Nutrition and Metabolic Biology BS"],
    ["orms", "Analytics BA"],
    ["legal studies", "Legal Studies BA"],
    ["media studies", "Media Studies BA"],
    ["applied math", "Applied Mathematics BA"],
    ["math", "Mathematics BA"],
    ["ep", "Engineering Physics BS"],
    ["gws", "Gender and Women's Studies BA"],
    ["anthro", "Anthropology BA"],
    ["physics", "Physics BA"],
    ["neuro", "Neuroscience BA"],
    ["polecon", "Political Economy BA"],
  ];
  it.each(FIRST)("%s -> %s", (q, want) => {
    expect(top(q)[0]).toBe(want);
  });

  it("keeps EECS near the top for cs and never buries shorthands under substring hits", () => {
    expect(top("cs", 2)).toEqual(["Computer Science BA", "Electrical Engineering and Computer Sciences BS"]);
    expect(top("cs", 20)).not.toContain("Physics BA");
    expect(top("cs", 20)).not.toContain("Statistics BA");
    expect(top("cs", 20)).toContain("Cognitive Science BA");
    expect(top("ds", 20)).not.toContain("Legal Studies BA");
    expect(top("nst", 20)).toEqual(["Nutrition and Metabolic Biology BS"]);
  });

  it("met lists the Haas dual degrees and bio lists the biology majors", () => {
    const met = top("met", 6);
    expect(met.length).toBe(6);
    expect(met.every((n) => /Business/.test(n))).toBe(true);
    expect(top("bio", 2)).toEqual(["Molecular and Cell Biology BA", "Integrative Biology BA"]);
  });

  it("every major is findable by its full name and by its first word", () => {
    for (const m of majors) {
      expect(searchMajors(m.name, majors, colleges).map((h) => h.item.name), m.name).toContain(m.name);
      const first = m.name.split(/[\s/]+/)[0];
      expect(searchMajors(first, majors, colleges).map((h) => h.item.id), first).toContain(m.id);
    }
  });

  it("ignores degree words, finds M.E.T. by name, and keeps EECS joint majors above initials", () => {
    expect(top("cs ba")[0]).toBe("Computer Science BA");
    expect(top("compsci ba")[0]).toBe("Computer Science BA");
    expect(top("eecs bs")[0]).toBe("Electrical Engineering and Computer Sciences BS");
    expect(top("management", 3).every((n) => /Business/.test(n))).toBe(true);
    const cs = top("cs", 20);
    const joint = cs.findIndex((n) => /Computer Science\//.test(n));
    expect(joint).toBeGreaterThan(-1);
    expect(joint).toBeLessThan(cs.indexOf("Celtic Studies BA"));
    expect(joint).toBeLessThan(cs.indexOf("Cognitive Science BA"));
    expect(top("ds", 20)).not.toContain("Asian American and Asian Diaspora Studies BA");
    const tags = searchMajors("cs", majors, colleges).map((h) => h.tag).filter(Boolean);
    expect(tags.every((t) => t === t!.toLowerCase())).toBe(true);
  });

  it("searches minors the same way", () => {
    const names = (q: string) => searchMinors(q, minors).map((h) => h.item.name);
    expect(names("art")).not.toContain("Earth and Planetary Science");
    expect(names("art")[0]).toMatch(/^(Art|History of Art)/);
    const first = (q: string) => searchMinors(q, minors)[0]?.item.name;
    expect(first("cs")).toBe("Computer Science");
    expect(first("ds")).toBe("Data Science");
    expect(first("eecs")).toBe("Electrical Engineering and Computer Science");
    expect(first("gpp")).toBe("Global Poverty & Practice");
    expect(first("sts")).toBe("Science, Technology, and Society");
    expect(first("pubpol")).toBe("Public Policy");
    expect(first("cogsci")).toBe("Cognitive Science and the Future of Tech");
  });
});
