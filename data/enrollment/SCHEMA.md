# Enrollment data schema

All files are produced by scripts in `ml/scrapers/` and consumed by `ml/` (the by-professor predictor).
Terms are written like `Fall 2024`, `Spring 2025`, `Summer 2025`. Courses are `SUBJECT NUMBER`, e.g. `COMPSCI 61A` (subject in the official upper-case abbreviation used by classes.berkeley.edu / Berkeleytime).
Instructor names are `First Last`, multiple instructors joined with `; `.

## calendar/phases.json
Enrollment phase windows per term (from registrar.berkeley.edu and archived academic calendars).
```json
[{"term":"Fall 2024","phases":[{"name":"Phase 1","start":"2024-04-15","end":"2024-05-03"},
  {"name":"Phase 2","start":"2024-07-15","end":"2024-08-16"},
  {"name":"Adjustment Period","start":"2024-08-21","end":"2024-09-18"}],
  "instructionStart":"2024-08-28","source":"<url>","notes":""}]
```
Phase `name`s used: `Phase 1`, `Phase 2`, `Adjustment Period` (continuing students), plus where known `Phase 1 New Undergrads` (incoming students' only phase, earliest of transfer/first-year start), `Phase 1.5` (Fall 2020 only) and `Add/Drop Deadline` (start = end = last day to add via CalCentral). A phase with `"estimated": true` has at least one date inferred (rule or pattern) rather than published; `notes` says which. Appointment rules: `calendar/appointments.md`.

## sections.csv
One row per section per term. Columns:
`term,course,section,component,instructors,capacity,enrolled,waitlisted,waitlist_capacity,reserved_capacity,source`
`component` is LEC/DIS/LAB/SEM/etc. Counts are final/census or the latest known snapshot.

## timeseries.csv(.gz)
Daily enrollment snapshots (Berkeleytime enrollment history). Columns:
`term,course,section,instructors,date,enrolled,capacity,waitlisted,waitlist_capacity,source`
`section` may be `ALL` for course-level aggregates.

## observations.csv
One row per term + course + primary professor, built by `python -m ml.predictor build`. Besides the fill labels it carries, for rows with daily history:
`capacity_start` (median capacity over the first 7 days of Phase 1), `capacity_max`, `expansion_ratio` (max / start), `waitlist_peak`, `waitlist_end` (still waiting at the add/drop deadline) and `waitlist_cleared` (estimated share of the peak waitlist that got a seat). The last four are empty when the history stops before the add/drop deadline.
