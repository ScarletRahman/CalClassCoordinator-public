# Enrollment predictions contract

Written by `python -m ml.predictor build` to `data/predictions/predictions.json`. Fields are only ever added.

```json
{
  "term": "Spring 2027",
  "generatedAt": "2026-11-20T10:12:00+00:00",
  "modelVersion": 2,
  "phase1UnitCap": 13.5,
  "phases": [{"name": "Phase 1", "start": "2026-10-26", "end": "2026-11-15", "estimated": false}],
  "predictions": [{
    "course": "COMPSCI 61A",
    "professor": "Kay Ousterhout",
    "professorSeenBefore": false,
    "warning": "New professor: no past enrollment data for Kay Ousterhout. This prediction is based on COMPSCI 61A's history under other professors.",
    "popularity": 0.838,
    "expectedDemandRatio": 1.089,
    "expectedFillDate": "2026-11-06",
    "fillsInPhase": "Phase 1",
    "pFullByPhase": {"Phase 1": 0.801, "Phase 2": 0.962, "Adjustment Period": 0.971},
    "recommendation": "Phase 1 priority",
    "confidence": "medium",
    "basis": "course",
    "historyTerms": 18,
    "capacity": 600,
    "capacityExpansion": {"pExpands": 0.736, "expectedGrowth": 0.388, "pastTerms": 9, "pastTermsExpanded": 7},
    "waitlist": {"pWaitlist": 0.97, "expectedPeak": 240, "clearRate": 0.932,
                 "pastTerms": 9, "pastTermsWithWaitlist": 9, "pastTermsMeasured": 9},
    "waitRisk": 0.06,
    "advice": "Likely full in Phase 1, but about 93% of the waitlist got a seat in past terms. ..."
  }]
}
```

| Field | Meaning |
|---|---|
| `course` | `SUBJECT NUMBER`, upper case, as on classes.berkeley.edu. |
| `professor` | Primary instructor of the lecture, or `null` when none is listed yet. One entry per course + professor. |
| `professorSeenBefore` | `false` when the professor has no past classes in the data. Show `warning` prominently in that case. |
| `warning` | `null` or a sentence to show the student: new professor, professor new to this course, only one past term, no professor listed, or estimated phase dates. |
| `popularity` | 0..1. Expected peak (enrolled + waitlisted) / capacity, where 1.0 means demand of 1.3x capacity or more. |
| `expectedDemandRatio` | The same thing unscaled; above 1 means more students than seats. |
| `pFullByPhase` | Cumulative probability the class is full by the end of each phase. "Full" means 97% enrolled or a waitlist has started. |
| `fillsInPhase` | First phase where that probability passes 50%, or `Does not fill`. |
| `expectedFillDate` | ISO date estimate inside `fillsInPhase`, or `null`. Treat as approximate (a few days either way). |
| `recommendation` | `Phase 1 priority`, `Phase 1 or early Phase 2`, `Phase 2 is fine`, or `Adjustment period is fine`. Since model version 2 this follows `waitRisk` (0.20+ priority, 0.10+ early), so a class that fills but whose waitlist clears is no longer a priority. |
| `confidence` | `high` (3+ past terms of this professor in this course), `medium`, or `low`. |
| `basis` | What the estimate rests on: `professor`, `professor-other-courses`, `course`, `department`, `global`. |
| `historyTerms` | Number of past offerings behind `basis`. |
| `capacity` | Seats listed when Phase 1 opened (before any were added), or `null`. |
| `capacityExpansion` | `pExpands`: probability the class ends with 5%+ more seats than it opened with. `expectedGrowth`: expected fractional growth (0.39 = +39%), averaged over terms that did and did not grow. `pastTerms` / `pastTermsExpanded`: this course's measured terms, across professors. |
| `waitlist` | `pWaitlist`: probability a waitlist forms. `expectedPeak`: longest expected waitlist, in students, or `null`. `clearRate`: estimated share of that waitlist that has a seat by the add/drop deadline; approximate, show it as "about N%". `pastTermsMeasured`: terms of this course behind `clearRate`; 0 or 1 means it mostly comes from similar classes. |
| `waitRisk` | 0..1. Chance of ending up without a seat if the class is left for Phase 2: (P(full by end of Phase 1) + half of what fills in Phase 2) x (1 - `clearRate`). Rank Phase 1 choices by this. |
| `advice` | `null` or one sentence for the student on whether waitlisting usually works here. |
| `phase1UnitCap` (top level) | Units a continuing undergraduate can hold in Phase 1 (waitlisted units count). The planner fits Phase 1 picks under it: `web/src/lib/enrollPlan.ts`. |
