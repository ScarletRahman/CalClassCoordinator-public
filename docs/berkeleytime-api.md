# Berkeleytime GraphQL API (notes, Nov 2026)

Reverse-engineered from the site's JS bundle (`https://berkeleytime.com/assets/index-*.js`).
No public REST API. The GitHub repo (asuc-octo/berkeleytime) was not readable from the cloud
session's GitHub access, so the schema below is what the client sends. Reference
implementation: `watcher/sources/berkeleytime.py`.

## Endpoint and request format

- `POST https://berkeleytime.com/api/graphql`, `Content-Type: application/json`. No auth, cookies or
  special headers needed for the read queries (`apollo-require-preflight` not required).
- **Persisted operations only.** Sending `{"query": "..."}` returns
  `400 {"error":"Invalid persisted operation request"}`. Send instead:

  ```json
  {"id": "<sha256 hex>", "variables": {...}}
  ```
  Leave out `variables` when there are none. The server only accepts ids of operations in the client bundle (an allowlist), so you cannot send ad-hoc queries.
- How the id is computed (the client's custom `fetch`):
  `sha256( stripIgnoredCharacters( print( removeTypenameFields( parse(queryText) ) ) ) )`
  (graphql-js 16). `watcher.sources.berkeleytime.persisted_id()` is a pure-Python port, tested
  against graphql-js output. If the site redeploys with changed query text, the ids change. To recover,
  re-extract the query text from the new bundle (template literals starting with `query Name(`).
- Errors: GraphQL errors come back as `{"errors":[...]}`, and an unknown id comes back as HTTP 400 `{"error":...}`.
- Enums: `semester` is `"Spring" | "Summer" | "Fall"`. `sessionId` is `"1"` (regular session) and
  summer uses e.g. `"8W"`. `number` (ClassNumber) is the class's section number such as `"001"`, **not** the
  5-digit class #. The 5-digit class # is `sectionId`.
- Site URL scheme: `/catalog/{year}/{Semester}/{SUBJECT}/{courseNumber}/{number}[/{sessionId}]`.

## Freshness and limits

- Enrollment is snapshotted every **15 minutes** (`granularitySeconds: 900`). On 2026-11-20 at 05:00Z
  the latest snapshot `endTime` was 04:45Z. So the data lags classes.berkeley.edu by up to about 15 min.
- History rows are **run-length compressed**: each row covers `[startTime, endTime]` during which
  the counts did not change. Rows for 61A Fall 2026 go back to 2026-03-22, 744 rows, about 0.9 MB.
- No documented rate limit. We send at most about 1 request per second with UA `CalClassCoordinator seat watcher`.
- Secondary sections (DIS/LAB) only expose `enrolledCount/maxEnroll/waitlistedCount/maxWaitlist`
  and have no reserved seats. Reserved seats exist only on the primary section.
- `seatReservationCount[].isValid == false` means the reservation has expired and its seats were released.
  Ignore these when you compute open reserved seats. Expired groups often show `maxEnroll: 1`.

## Operations used (persisted ids)

| Operation | id (sha256) | Variables |
|---|---|---|
| GetTerms | `e97249c70d8a47a59a96728627078b5bc951c52d566afa0a10f953af5adc3332` | none |
| GetTerm | `40f7350accb924cdb91a6b6ff820cd5d474008917554431a93f2e21bf3a53f23` | `year, semester` |
| GetCourseWithInstructor | `2e5bd7f134a8e007e7a6c2fa41a2d18b0dea3028df5f4f45942fa1d0c7205bf3` | `subject, number` (course number), `includeFormerNames?` |
| GetCourse | `c3d34f9ffd39827dce61241e71fc4503393668e9d97a3ba470f3ece5eef5c80e` | `subject, number` |
| GetClassDetails | `f91a5ed8c1e0a14186c41c0cb4c4ecfa105f35929a402f43e279c59cbb59fc84` | `year, semester, sessionId, subject, courseNumber, number` |
| GetClass | `79775dae18f1f702ad5c0d177254b33b973f126c5e21750cb7b5569ec5146a87` | same as GetClassDetails |
| GetClassSections | `643db8cbc7198c777fe68fefae29a5154093126014ecbced23a276047706fdea` | same |
| GetClassEnrollment | `a7807c4d5d2141157ae7dac31bd3d474ded7000294fde8b45ffa2729251dddf1` | same |
| GetEnrollment | `6b4e761f02e20db683488a9928ee2b8c6d07dbddab14851410cd0e94e2585382` | `year, semester, sessionId?, subject, courseNumber, sectionNumber` |
| GetEnrollmentTimeframes | `f11827caca4ffa25bba5d4ee7bf22c0fa6724af5e7bd975ec74f5c4f89ffdcca` | `year, semester` |
| GetCourseGradeDist | `975a079d64a086e0d443cda072718ffa067e834ba78e362f48779333513248e8` | see bundle |
| GetGradeDistribution | `3b25e544b49e4ce0b13cfe0e3a89f2ccf5ac28fa836d315e558929f11ab086b5` | see bundle |
| GetCourses | `ef3a260a0e8b4a6e32dcef6bc90c7193b333e9c9d3e552b484b986e1f440b397` | none (all courses) |

The full query texts for the watcher's operations, plus GetEnrollment and GetEnrollmentTimeframes, are
constants in `watcher/sources/berkeleytime.py`. They are copied verbatim, so `persisted_id(text)` reproduces the id.
The bundle has 73 operations in all: ratings, grades, plans, `GetCourseRequirements`, and others.

### Seat state (what the watcher uses)

1. `GetCourseWithInstructor {subject:"COMPSCI", number:"61A"}` returns every offering:
   `classes[]{year, semester, number, sessionId, term{temporalPosition: Past|Current|Future},
   primarySection{number, enrollment{latest{enrolledCount}}, meetings{instructors{givenName familyName}}}}`.
   This is also a cheap **by-professor offering history** for the ML thread.
2. `GetClassDetails` returns the primary section (LEC) with
   `primarySection{sectionId, component, meetings{instructors}, enrollment{latest{endTime, enrolledCount,
   maxEnroll, waitlistedCount, maxWaitlist, activeReservedMaxCount,
   seatReservationCount[]{enrolledCount, maxEnroll, requirementGroup{description}, isValid}}}}`,
   course title, grade distribution, ratings and exams. About 5 KB.
3. `GetClassSections` returns the secondary sections only (DIS/LAB), each with
   `sectionId, number, component, meetings, enrollment.latest{enrolledCount, maxEnroll, waitlistedCount, maxWaitlist}`.
   About 30 KB for 61A.

### Enrollment history (for the data/ML thread)

`GetEnrollment` (`sectionNumber` is the primary section number, e.g. `"001"`). Example variables:
`{"year":2026,"semester":"Fall","sessionId":"1","subject":"COMPSCI","courseNumber":"61A","sectionNumber":"001"}`.
Returns `enrollment{year, semester, sessionId, sectionId, subject, courseNumber, sectionNumber,
history[]{startTime, endTime, granularitySeconds, status ("O"/"C"/...), enrolledCount, waitlistedCount,
reservedCount, minEnroll, maxEnroll, maxWaitlist, openReserved, activeReservedMaxCount,
seatReservationCount[]{maxEnroll, enrolledCount, requirementGroup{description}, isValid}}}`.
Python: `BerkeleytimeSource().enrollment_history("COMPSCI 61A", "2026 Fall", "001")`.

`GetClassEnrollment` is a lighter version keyed by the class (`number`). It returns
`class.primarySection.enrollment.history[]{startTime, endTime, granularitySeconds, enrolledCount,
maxEnroll, waitlistedCount, maxWaitlist}` and has no reserved breakdown. About 160 KB for 61A.

`GetEnrollmentTimeframes {year, semester}` returns the official enrollment phases:
`enrollmentTimeframes[]{phase, isAdjustment, group ("continuing", "new_transfer", ...), startDate, endDate,
startEventSummary}`. For example, Spring 2027 Phase 1 for continuing students runs 2026-10-26 to 2026-11-15, and Phase 2 starts
2026-11-23. Use it to align fill-time curves to phase start ("filled N hours after Phase 1 opened").

## Example

```bash
curl -s https://berkeleytime.com/api/graphql -H 'content-type: application/json' \
  -A 'CalClassCoordinator' \
  -d '{"id":"f11827caca4ffa25bba5d4ee7bf22c0fa6724af5e7bd975ec74f5c4f89ffdcca","variables":{"year":2027,"semester":"Spring"}}'
```
