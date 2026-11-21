"use client";

import { useMemo } from "react";
import { courseUnits } from "@/lib/courseId";
import { DEFAULT_PHASE1_CAP, HIGH_RISK, planEnrollment, type PlanItem } from "@/lib/enrollPlan";
import { isoDay } from "@/lib/forecast";
import { forecastFor } from "@/lib/planLookups";
import type { Catalog, PlannerState, Term } from "@/lib/types";
import type { PlanData } from "@/lib/usePlanData";

const HOW = "Picked to remove the most risk of ending up without a seat: how likely the class is full by Phase 2, and how often its waitlist has cleared or seats were added. Ties go to the class that fills earlier. Waitlisted units count.";

function Chip({ item, onOpen }: { item: PlanItem; onOpen: () => void }) {
  const hot = item.risk >= HIGH_RISK;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={item.reason}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ring-1 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue ${item.squeezedOut ? "bg-rose-50 ring-rose-200" : "bg-white ring-slate-200"}`}
      >
        <span className="font-semibold text-slate-900">{item.course}</span>
        <span className="tabular-nums text-slate-500">{item.units}u</span>
        {item.prediction && <span className={`tabular-nums ${hot ? "font-semibold text-rose-700" : "text-slate-500"}`}>{Math.round(item.risk * 100)}%</span>}
      </button>
    </li>
  );
}

/**
 * Which planned classes to spend the Phase 1 unit limit on, and which can wait for Phase 2.
 * The percentage on each class is its wait risk; the reason is in the tooltip. Hidden once
 * Phase 1 is over, since the choice has been made.
 */
export default function Phase1Picks({ catalog, state, data, onOpenCourse }: { catalog: Catalog; state: PlannerState; data: PlanData; onOpenCourse: (c: string, t?: Term) => void }) {
  const preds = catalog.predictions;
  const cap = preds?.phase1UnitCap ?? DEFAULT_PHASE1_CAP;
  const sem = state.semesters.find((s) => s.term === preds?.term);
  const plan = useMemo(
    () =>
      planEnrollment(
        (sem?.courses ?? []).map((pc) => {
          // With several instructors and none chosen, judge the class by its most in-demand one.
          const f = forecastFor(data, pc.course, pc.professor);
          return { course: pc.course, units: courseUnits(data.courseIndex.get(pc.course)), prediction: f.headline ?? f.named[0] ?? f.unnamed[0] };
        }),
        cap,
      ),
    [sem, data, cap],
  );
  const phase1 = preds?.phases.find((p) => /1/.test(p.name));
  if (!preds || !phase1 || phase1.end < isoDay(new Date()) || plan.phase1.length + plan.phase2.length === 0) return null;
  const open = (c: string) => () => onOpenCourse(c, preds.term);

  return (
    <dl className="mt-3 grid gap-x-4 gap-y-2 border-t border-slate-100 pt-3 sm:grid-cols-[auto_1fr]" title={HOW}>
      <dt className="text-xs font-semibold text-cal-blue">
        Phase 1 <span className="font-normal tabular-nums text-slate-500">{plan.phase1Units}/{plan.cap}u</span>
      </dt>
      <dd>
        <ul className="flex flex-wrap gap-1.5">{plan.phase1.map((it) => <Chip key={it.course} item={it} onOpen={open(it.course)} />)}</ul>
      </dd>
      {plan.phase2.length > 0 && (
        <>
          <dt className="text-xs font-semibold text-slate-600">Phase 2</dt>
          <dd>
            <ul className="flex flex-wrap gap-1.5">{plan.phase2.map((it) => <Chip key={it.course} item={it} onOpen={open(it.course)} />)}</ul>
          </dd>
        </>
      )}
    </dl>
  );
}
