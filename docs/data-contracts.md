# Data contracts between the parts of CalClassCoordinator

The planner web app (`web/`) reads everything below from the repo-level `data/`
folder (or from the URL in the matching env var). Producers may write richer data;
the web app ignores unknown fields. Course ids are always `"SUBJECT NUMBER"` in
uppercase using the official Berkeley subject code, e.g. `"COMPSCI 61A"`, `"MATH 54"`,
`"DATA C100"`, `"LS C70T"`. Subject codes follow the official catalog: no spaces or punctuation (`ELENG`, `LS`, `PBHLTH`, `MCELLBI`).

Terms are written `"2026 Fall"`, `"2027 Spring"`, `"2027 Summer"`.

## 1. Courses — `data/courses.json` (requirements thread)
```jsonc
[{ "id": "COMPSCI 61A", "subject": "COMPSCI", "number": "61A",
   "title": "The Structure and Interpretation of Computer Programs",
   "units": 4,              // or [min, max] for variable units
   "description": "...",
   "breadths": ["Mathematical Sciences"],   // L&S 7-course breadth areas it satisfies
   "attributes": ["AC", "RCA", "RCB", "QR", "AH&I", "UD"], // university/college reqs it can satisfy (see below)
   "crossListed": ["DATA C61A"],
   "prereqs": "COMPSCI 61A or ...", "url": "https://classes.berkeley.edu/..." }]
```
Attribute codes: `AC` American Cultures, `RCA`/`RCB` Reading & Composition A/B,
`ELW` Entry Level Writing, `AH&I` American History & Institutions, `QR` quantitative reasoning,
`FL` foreign language, `UD` upper division, `HSS` CoE humanities/social sciences.

## 2. Requirements — `data/requirements/` (requirements thread)
- `colleges.json`: `[{ "id": "LS", "name": "College of Letters & Science", "requirementGroupId": "college-LS" }]`
  ids: `LS`, `CDSS`, `COE`, `HAAS`, `CED`, `CNR`, `CHEM`.
- `majors.json`: `[{ "id": "ls-data-science-ba", "name": "Data Science", "degree": "BA", "college": "CDSS",
   "requirementGroupIds": ["major-data-science-ba"], "url": "https://..." }]`
- `groups/<groupId>.json`: one requirement group (major, college, university-wide):
```jsonc
{ "id": "major-data-science-ba", "title": "Data Science BA", "kind": "major", // major|college|university|minor
  "source": "https://...", "requirements": [
    { "id": "lower-div", "title": "Lower division", "notes": "...", "rule": RULE } ] }
```
RULE is one of:
```jsonc
{ "type": "course", "course": "COMPSCI 61A" }
{ "type": "allOf", "rules": [RULE, ...] }
{ "type": "anyOf", "rules": [RULE, ...] }                 // pick one
{ "type": "nOf", "n": 2, "rules": [RULE, ...] }            // pick n
{ "type": "filter", "count": 2, "minUnits": 8,            // count and/or minUnits
  "filter": { "courses": ["..."], "subjects": ["STAT"], "minNumber": 100, "maxNumber": 199,
              "breadth": "Arts & Literature", "attribute": "AC", "exclude": ["..."] } }
{ "type": "units", "minUnits": 120, "filter": { ... } }   // e.g. 120 total, 36 upper-div
{ "type": "manual", "text": "Senior residence requirement" } // shown as a self-check box
```
`university.json` (group id `university`) holds ELW, AC, AH&I, 120 units, etc.

Additive fields (details in `docs/requirements-data.md`):
- Group `"choices": [{ "id": "domain-emphasis", "title": "Domain Emphasis", "pick": 1, "options": [{ "id": "cognition", "title": "Cognition" }] }]`;
  a requirement inside an option has `"choice": "<choiceId>", "option": "<optionId>"`. Requirements without them are required for everyone.
- Sub-rules of a requirement built from alternatives may carry `"label": "Option 1"`.
- An `allOf` rule may carry `"overlap": true`: its sub-rules are conditions on the same classes (College of Engineering H/SS: six courses, two of them upper division, two of them R&C), so one class may meet several of them.
- `majors.json` / `minors.json` records have `"aliases": ["cogsci", "cog sci"]`: lower-case shorthands for search.
- `courses.json` records may have `"sameAs": ["MATH 51"]`: the same class under another number or code (renumbered, recoded, or the C-prefixed form). Symmetric, complete per family, never overlaps `crossListed`. Treat `sameAs` and `crossListed` ids as the same class when matching a transcript to a rule.
- `"retired": true` on a course: an old number kept only so transcripts resolve (always has `sameAs`; title and units are its successor's). Do not offer it for planning.
- `"popularity": 9448` on every course: students enrolled in the primary component over the terms on file, summed over the `sameAs` family (0 when unknown). For ordering search results only.
- Requirement `"optional": true`: honors, optional or recommended rows; show them but do not count them toward completion.
- Group `"programType": "major" | "joint-major" | "dual-degree"` on major groups (`kind` stays `"major"`).
- Requirements inside a choice have `section` `"<Option title>"` or `"<Option title>: <Section>"` in every program.
- College and university groups are meant to be evaluated independently of the major (one class may satisfy rows in several groups). The 120-unit minimum appears only in `university`.
- `courses.json` records may have `"source": "berkeleytime"` (course no longer in the catalog); `crossListed` is symmetric and complete per family.

## 3. Enrollment predictions — `data/predictions/predictions.json` (ML thread)
```jsonc
{ "term": "2027 Spring", "generatedAt": "2026-11-20T00:00:00Z",
  "phases": [{ "name": "Phase 1", "start": "2026-10-20", "end": "2026-11-14" },
             { "name": "Phase 2", "start": "2026-11-17", "end": "2027-01-16" },
             { "name": "Adjustment", "start": "2027-01-17", "end": "2027-02-06" }],
  "predictions": [{ "course": "COMPSCI 61A", "professor": "John DeNero",
     "professorSeenBefore": true, "warning": null, // e.g. "First time this professor teaches it, low confidence"
     "popularity": 0.93,                          // 0..1
     "expectedFillDate": "2026-10-23", "fillsInPhase": "Phase 1",
     "pFullByPhase": { "Phase 1": 0.95, "Phase 2": 0.99 },
     "recommendation": "Enroll on your first Phase 1 appointment", "confidence": 0.8 }] }
```
Added 2026-11-20 (model version 2, all optional for readers): per prediction `capacity`, `capacityExpansion`, `waitlist`, `waitRisk`, `advice`; top level `phase1UnitCap`. Field meanings are in `docs/predictions.md`.

## 4. Seat status — watcher (watcher thread)
Either `data/seats/latest.json` on disk, or `GET $WATCHER_URL/seats` returning the same shape:
```jsonc
{ "updatedAt": "2026-11-20T04:00:00Z", "term": "2027 Spring", "sections": [
  { "course": "COMPSCI 61A", "classNumber": "12345", "section": "001 LEC",
    "instructor": "John DeNero", "enrolled": 1300, "capacity": 1400,
    "waitlisted": 0, "waitlistCapacity": 200, "open": true,
    "reserved": [{ "group": "Freshmen", "enrolled": 400, "capacity": 450 }] } ] }
```
Subscriptions (optional): `POST $WATCHER_URL/subscriptions { "email", "classNumber", "includeReserved" }`.

## 5. Course insights — `data/insights/` (insights thread, `python -m insights build`)

`insights.json` is small on purpose (it ships to the browser with the catalog): one row per class
that has at least one rating.
```jsonc
[{ "course": "COMPSCI 61A", "difficulty": 3.5,   // 1..5, 5 = hardest
   "shouldTake": 3.8,                             // 1..5, 5 = strongly yes
   "confidence": "high" }]                        // low | medium | high (of difficulty, else of shouldTake)
```
Everything else is in `details/<SUBJECT>.json`, an object keyed by course id. The web app serves one
class at a time through `GET /api/course?id=...` as `insight`. All fields except `course` are optional.
```jsonc
{ "COMPSCI 61A": {
   "course": "COMPSCI 61A", "difficulty": 3.5, "shouldTake": 3.8,
   "confidence": { "difficulty": "high", "shouldTake": "high" },
   "signals": { "difficulty": [{ "label": "Average grade B (3.12)", "value": 3.7, "weight": 0.347 }], "shouldTake": [...] },
   "sentiment": "356 students on Berkeleytime rate it ...",   // one short paragraph
   "sentimentWrittenBy": "model",                 // present only when a model wrote the paragraph from reviews
   "midterms": 2, "finalExam": "Y",               // typical scheduled midterms; registrar final-exam code
   "grades": { "average": 3.12, "letter": "B", "students": 6629, "pctA": 40, "pctBelowB": 16, "pctPassNoPass": 9,
               "distribution": [{ "letter": "A+", "count": 301 }] },
   "studentRatings": { "count": 356, "difficulty": 3.7, "workload": 3.3, "usefulness": 4.3,
                       "recordedPct": 94, "attendanceRequiredPct": 2 },   // Berkeleytime
   "byProfessor": [{ "professor": "John DeNero", "terms": 8, "lastTaught": "2026 Fall", "teachingNext": "2027 Spring",
      "gpa": 3.2, "midterms": 2,
      "rmp": 4.6, "rmpCount": 120, "rmpDifficulty": 3.2, "wouldTakeAgain": 93, "rmpUrl": "https://...", "rmpForThisClass": true,
      "studentCount": 322, "studentDifficulty": 3.7, "studentUsefulness": 4.3,
      "difficulty": 3.5, "shouldTake": 3.9 }],     // newest first, at most 8, last 5 years
   "reviews": [{ "text": "...", "title": "...", "term": "2025 Fall", "professor": "...", "grade": "A", "source": "Berkeleytime" }],  // or source "RateMyProfessors" with "date" instead of "term"
   "reddit": [{ "title": "...", "url": "https://www.reddit.com/...", "score": 120, "date": "2025-04-02" }],
   "sources": ["https://..."] } }
```
`summary` (older contract) is still read by the web app if present but is no longer written; the class
description comes from `data/course_details.json`. `data/insights/raw/` holds the collected snapshots the
build reads, and `data/insights/REPORT.md` the coverage numbers and the rating method.

## Class times — `data/schedule/` and the watcher's `GET /lookup` (schedule builder thread)
Lecture, discussion and lab meeting times per term, plus live per-course lookups. Shapes and
endpoints are in [`docs/schedule.md`](schedule.md). The plan gains one optional field:
`PlannedCourse.sections` (`string[]` of chosen class numbers: the lecture plus one per section kind).
