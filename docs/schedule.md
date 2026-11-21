# Class times and the schedule builder

Where meeting times come from, the shapes they travel in, and how the pieces call each other.
Fields are only ever added.

## Shapes

A course offered in a term is a list of **classes**. One class is one primary section (usually
the lecture) plus the discussions and labs that belong to that lecture. A student enrolls in the
primary and, for each kind of secondary section the class has (DIS, LAB, ...), one of them.

```jsonc
CLASS = {
  "number": "001",                 // the primary's section number
  "sessionId": "8W",               // only when it is not the regular session (summer)
  "title": "The Structure and Interpretation of Computer Programs",
  "units": [4, 4],                 // [min, max]
  "exams": [{ "type": "FIN", "date": "2027-05-12", "start": "08:00", "end": "11:00" }],
  "primary": SECTION,
  "sections": [SECTION, ...]       // discussions/labs of this primary; may be empty
}
SECTION = {
  "classNumber": "28320",          // 5-digit class #, unique within a term
  "section": "001 LEC",            // number + component
  "component": "LEC",              // LEC, DIS, LAB, SEM, IND, ...
  "instructor": "Kay Ousterhout",  // missing when not announced
  "meetings": [                    // [] = no set time (async, independent study, not yet scheduled)
    { "days": [0, 2, 4],           // 0 = Monday ... 6 = Sunday
      "start": "13:00", "end": "13:59",   // 24-hour, Pacific time
      "location": "Dwinelle 155" } ],
  // seat counts, present when known:
  "enrolled": 332, "capacity": 600, "waitlisted": 0, "waitlistCapacity": 300,
  "status": "open",                // "open" | "waitlist" | "closed"
  "open": 173,                     // open seats that are not reserved for a group
  "reserved": [{ "group": "Students declared in the Computer Science BA major", "enrolled": 16, "capacity": 50 }]
}
```

Unknown fields are left out rather than sent as null. Secondary sections never carry `reserved`.

## Term files: `data/schedule/<yyyy>-<season>.json`

Written by `python -m watcher import-schedule` (source: Berkeleytime, one pass over every
undergraduate class of the term). Committed, so the hosted app always has times even when
nothing can be fetched live.

```jsonc
{ "term": "2027 Spring", "generatedAt": "2026-11-20T21:00:00Z", "source": "berkeleytime",
  "classCount": 2613, "skipped": 0, "failed": 0,
  "courses": { "COMPSCI 61A": [CLASS, ...], ... } }   // keys are course ids as in data/courses.json
```

`data/schedule/index.json` lists the files: `{ "terms": [{ "term", "file", "generatedAt", "courses", "classes" }] }`.
Seat counts in a term file are a snapshot from `generatedAt`; show them only with that date, and
prefer a live lookup.

## Live lookup: watcher API `GET /lookup?course=COMPSCI%2061A&term=2027%20Spring`

Bearer token as for the rest of the watcher API. Answers one course with fresh seats and times:

```jsonc
{ "course": "COMPSCI 61A", "term": "2027 Spring",
  "source": "berkeleytime",        // or "classes.berkeley.edu"
  "fetchedAt": "2026-11-20T21:03:10Z",
  "cached": true,                  // answered from the watcher's cache (fetchedAt says how old)
  "classes": [CLASS, ...] }
```

- `404 {"error": "not offered"}`: the course has no classes in that term.
- `400`: missing or malformed `course`/`term`. `502 {"error": ...}`: no source could answer.
- Results are cached for 5 minutes per course and term (misses for 30 minutes), and two
  requests for the same course share one fetch, so many students adding the same class cost
  Berkeley's servers one lookup.
- Sources are tried in the order of `lookup_sources` in the watcher config. The hosted app uses
  Berkeleytime only (classes.berkeley.edu refuses requests from the hosting provider);
  Berkeleytime's counts are at most 15 minutes behind.

## Web app: `GET /api/sections?course=COMPSCI%2061A&term=2027%20Spring[&live=1]`

What the schedule builder calls. Without `live` it answers instantly from the term file; with
`live=1` it asks the watcher and falls back to the file.

```jsonc
{ "course": "COMPSCI 61A", "term": "2027 Spring",
  "basisTerm": "2027 Spring",      // the term the times really come from
  "tentative": false,              // true when basisTerm != term (see below)
  "classes": [CLASS, ...],         // [] when the course is not offered / unknown
  "source": "file",                // "file" | "berkeleytime" | "classes.berkeley.edu" | "none"
  "asOf": "2026-11-20T21:00:00Z",  // when the seat counts and times were read
  "live": false,                   // true when this answer came from a live lookup
  "liveError": "…",                // set when live=1 was asked and failed (file data returned)
  "publishedTerms": ["2026 Fall", "2027 Spring"] }
```

**Terms Berkeley has not published yet.** For a term with no file (say 2027 Fall in November
2026), the answer uses the most recent earlier term of the same season (2026 Fall) with
`tentative: true`. Seat counts and exam dates are dropped because they belong to the old term;
class numbers are kept only so a pick can be remembered, and a pick that no longer matches is
ignored once the real term is published. The UI must say the times are last year's and may
change. With no earlier term either: `classes: []`, `source: "none"`, `basisTerm: null`.
