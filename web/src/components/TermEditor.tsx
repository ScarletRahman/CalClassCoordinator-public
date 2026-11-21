"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CheckCheck, ClipboardList, FileUp, Plus, Sun, Trash2, User, X } from "lucide-react";
import CourseSearch from "./CourseSearch";
import { TermPicker } from "./TermBar";
import { alsoListedAs } from "@/lib/courseFamily";
import { forecastFor, type Advisor } from "@/lib/planLookups";
import { COMMON_EXAMS, CREDIT, addClassActions, creditId, findInPlan, isFixedCredit, moveClassActions, planLocations, termKeyLabel, type TermEntry, type TermKey, type TermRow } from "@/lib/planTerms";
import { suggestNextTerm } from "@/lib/terms";
import type { PlanData } from "@/lib/usePlanData";
import type { Action } from "@/lib/store";
import type { Catalog, PlannerState, Term } from "@/lib/types";

const GRADES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F", "P", "NP", "S", "U", "I"];
const control = "h-10 rounded-lg border-0 bg-white text-sm ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-cal-blue lg:h-9";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";

function StatusToggle({ row, current, onChange }: { row: TermRow; current: boolean; onChange: (taken: boolean) => void }) {
  const opt = (taken: boolean, text: string) => {
    const on = (row.status === "taken") === taken;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => !on && onChange(taken)}
        className={`inline-flex h-full items-center gap-1 px-2.5 text-xs font-medium ${focusRing} ${
          on ? (taken ? "bg-emerald-600 text-white" : "bg-cal-blue text-white") : "bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        {taken && on && <Check className="h-3 w-3" aria-hidden />}
        {text}
      </button>
    );
  };
  return (
    <div role="radiogroup" aria-label={`Status of ${row.course}`} className="inline-flex h-10 shrink-0 overflow-hidden rounded-lg ring-1 ring-slate-300 lg:h-9">
      {opt(false, current ? "In progress" : "Planned")}
      {opt(true, "Taken")}
    </div>
  );
}

function ClassRow({
  row,
  entry,
  entries,
  data,
  showForecast,
  advise,
  onOpen,
  onMove,
  dispatch,
}: {
  row: TermRow;
  entry: TermEntry;
  entries: TermEntry[];
  data: PlanData;
  showForecast: boolean;
  advise: Advisor;
  onOpen: () => void;
  onMove: (to: TermKey) => void;
  dispatch: (a: Action) => void;
}) {
  const c = data.courseIndex.get(row.course);
  const also = alsoListedAs(row.course, data.courseIndex);
  const [pickingTerm, setPickingTerm] = useState(false);
  const existing = entries.filter((e) => e.key !== CREDIT).map((e) => e.key);
  const [other, setOther] = useState<Term>(() => suggestNextTerm(existing));
  const isCredit = entry.key === CREDIT;
  const fixed = isFixedCredit(row.source);
  // Hand-entered or test credit with no Berkeley class behind it is known by its label.
  const name = row.label && !c ? row.label : row.course;
  const forecast = showForecast && row.status === "planned" ? forecastFor(data, row.course, row.professor) : null;
  const tone = forecast?.headline ? advise(forecast.headline, row.course) : null;
  const detail = c ? (row.label && fixed ? `${row.label}, counts as ${row.course}` : null) : fixed ? (row.source === "ap" ? null : "No Berkeley equivalent set") : "Not in our catalog";
  const hover = c ? [c.title, also.length ? `Also listed as ${also.join(", ")}` : ""].filter(Boolean).join(". ") : undefined;
  const canFlip = !isCredit && (entry.phase === "past" || entry.phase === "current");

  return (
    <li className="px-3 py-2.5 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={onOpen} title={hover} className={`group min-h-10 min-w-0 flex-1 basis-60 rounded-lg text-left ${focusRing}`}>
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-slate-900 group-hover:text-cal-blue group-hover:underline">{name}</span>
            <span className={`text-xs tabular-nums ${row.unitsKnown ? "text-slate-600" : "font-medium text-amber-700"}`}>{row.unitsKnown ? `${row.units} unit${row.units === 1 ? "" : "s"}` : "units unknown"}</span>
            {row.source === "ap" && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">Test credit</span>}
            {row.source === "transfer" && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">Transfer credit</span>}
            {isCredit && !fixed && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">No term</span>}
          </span>
          {/* A catalog class is known by its code; the title is one hover (or one click) away. */}
          {detail && <span className="block truncate text-xs text-slate-600">{detail}</span>}
        </button>

        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          {!row.unitsKnown && (
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              Units
              <input
                type="number"
                min={0}
                max={12}
                step={0.5}
                inputMode="decimal"
                aria-label={`Units for ${name}`}
                placeholder="?"
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v) && v >= 0 && v <= 12) dispatch({ type: "setUnits", course: row.course, units: v });
                }}
                className={`${control} w-16 px-2`}
              />
            </label>
          )}
          {forecast && (forecast.headline || forecast.several) && (
            <button
              type="button"
              onClick={onOpen}
              className={`inline-flex h-10 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium ring-1 lg:h-9 lg:max-w-52 ${tone ? "max-w-[60%]" : "w-full sm:w-auto"} ${focusRing} ${
                forecast.several && !forecast.chosen ? "bg-cal-gold-100 text-cal-blue ring-cal-gold hover:bg-cal-gold/30" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
              }`}
            >
              <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{forecast.several && !forecast.chosen ? `Pick from ${forecast.count} instructors` : (forecast.headline?.professor ?? "Instructor not listed")}</span>
            </button>
          )}
          {!forecast && row.professor && (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <User className="h-3.5 w-3.5" aria-hidden /> {row.professor}
            </span>
          )}
          {tone && (
            <span className={`rounded-md px-1.5 py-1 text-[11px] font-medium ring-1 ${tone.cls}`} title={tone.advice}>
              {tone.label}
            </span>
          )}

          {row.status === "taken" && row.source !== "ap" && (
            <select
              aria-label={`Grade for ${row.course} (optional)`}
              value={row.grade ?? ""}
              onChange={(e) => dispatch({ type: "updateTaken", course: row.course, patch: { grade: e.target.value || undefined } })}
              className={`${control} w-[5.5rem] pl-2 pr-1 ${row.grade ? "text-slate-900" : "text-slate-500"}`}
            >
              <option value="">Grade</option>
              {row.grade && !GRADES.includes(row.grade) && <option>{row.grade}</option>}
              {GRADES.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          )}

          {canFlip ? (
            <StatusToggle
              row={row}
              current={entry.phase === "current"}
              onChange={(taken) => dispatch(taken ? { type: "markTaken", term: entry.key, course: row.course } : { type: "unmarkTaken", course: row.course, term: entry.key })}
            />
          ) : row.status === "taken" ? (
            // Every class in a future term is planned, so only an exception gets a label.
            <span className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-50 px-2 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
              <Check className="h-3 w-3" aria-hidden />
              {fixed ? "Credit" : "Taken"}
            </span>
          ) : null}

          {!fixed && (
            <select
              aria-label={`Move ${row.course} to another term`}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__other") setPickingTerm(true);
                else if (v) onMove(v);
              }}
              className={`${control} w-[6.75rem] pl-2 pr-1 text-slate-700`}
            >
              <option value="">Move to…</option>
              {entries
                .filter((e) => e.key !== entry.key && e.key !== CREDIT)
                .map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.label}
                  </option>
                ))}
              <option value="__other">Another term…</option>
              {!isCredit && row.status === "taken" && <option value={CREDIT}>No term (credit)</option>}
            </select>
          )}

          <button
            type="button"
            onClick={() => dispatch(row.status === "taken" ? { type: "removeTaken", course: row.course } : { type: "removePlanned", term: entry.key, course: row.course })}
            aria-label={`Remove ${name} from ${entry.label}`}
            title="Remove"
            className={`ml-auto grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-rose-50 hover:text-rose-600 lg:ml-0 lg:h-9 lg:w-9 ${focusRing}`}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {pickingTerm && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-2 ring-1 ring-slate-200"
          onSubmit={(e) => {
            e.preventDefault();
            setPickingTerm(false);
            onMove(other);
          }}
        >
          <span className="text-xs font-medium text-slate-600">Move {row.course} to</span>
          <TermPicker value={other} onChange={setOther} existing={existing} idPrefix={`move-${row.course.replace(/\W/g, "-")}`} />
          <button type="submit" className={`h-10 rounded-lg bg-cal-blue px-3 text-sm font-semibold text-white hover:bg-cal-blue-700 lg:h-9 ${focusRing}`}>
            Move
          </button>
          <button type="button" onClick={() => setPickingTerm(false)} className={`h-10 rounded-lg px-2 text-sm text-slate-600 hover:bg-slate-200 lg:h-9 ${focusRing}`}>
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

type CreditKind = "ap" | "ib" | "transfer" | "other";

/** Record credit that is not a Berkeley class: an AP or IB exam, a community college class. */
function AddCredit({ catalog, dispatch }: { catalog: Catalog; dispatch: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CreditKind>("ap");
  const [name, setName] = useState("");
  const [units, setUnits] = useState("");
  const [equiv, setEquiv] = useState<string | null>(null);
  const exams = kind === "ap" || kind === "ib" ? COMMON_EXAMS[kind] : [];
  const u = parseFloat(units);
  const valid = name.trim().length > 1 && isFinite(u) && u >= 0 && u <= 30;
  const field = `${control} px-2 text-base lg:text-sm`;
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={`inline-flex h-10 items-center gap-1.5 rounded-lg bg-cal-blue px-3 text-xs font-semibold text-white hover:bg-cal-blue-700 lg:h-9 ${focusRing}`}>
        <Plus className="h-4 w-4" aria-hidden /> Add test or transfer credit
      </button>
    );
  return (
    <form
      className="w-full rounded-xl bg-white p-3 ring-1 ring-slate-300"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const label = `${kind === "ap" ? "AP " : kind === "ib" ? "IB " : ""}${name.trim().replace(/^(AP|IB)\s+/i, "")}`;
        dispatch({ type: "addTaken", courses: [{ course: equiv ?? creditId(kind, name), label, units: u, source: kind === "ap" || kind === "ib" ? "ap" : "transfer" }] });
        setName("");
        setUnits("");
        setEquiv(null);
        setOpen(false);
      }}
    >
      <p className="text-sm font-semibold text-slate-900">Add credit</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-[9rem_1fr_6rem]">
        <label className="text-xs font-medium text-slate-700">
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as CreditKind)} className={`${field} mt-1 block w-full`}>
            <option value="ap">AP exam</option>
            <option value="ib">IB exam</option>
            <option value="transfer">Transfer class</option>
            <option value="other">Other credit</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          {kind === "ap" || kind === "ib" ? "Exam" : "Class or credit name"}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            list="credit-names"
            autoFocus
            placeholder={kind === "ap" ? "Calculus AB" : kind === "ib" ? "Physics HL" : "Intro to Sociology, Laney College"}
            className={`${field} mt-1 block w-full`}
          />
          <datalist id="credit-names">
            {exams.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Units
          <input type="number" min={0} max={30} step={0.1} inputMode="decimal" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="4" className={`${field} mt-1 block w-full`} />
        </label>
      </div>
      <div className="mt-2">
        <p className="text-xs font-medium text-slate-700">Counts as a Berkeley class (optional)</p>
        {equiv ? (
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-900">
            <Check className="h-4 w-4 text-emerald-600" aria-hidden /> {equiv}
            <button type="button" onClick={() => setEquiv(null)} className={`inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-slate-100 ${focusRing}`}>
              Change
            </button>
          </p>
        ) : (
          <div className="mt-1 max-w-md">
            <CourseSearch courses={catalog.courses} onPick={setEquiv} placeholder="Find the class it satisfies, e.g. math 1a" />
          </div>
        )}
        <p className="mt-1 text-xs text-slate-600">Choose one only if Berkeley gave you credit for that class, so it can tick off requirements.</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={!valid} className={`h-10 rounded-lg bg-cal-blue px-3.5 text-sm font-semibold text-white hover:bg-cal-blue-700 disabled:opacity-50 lg:h-9 ${focusRing}`}>
          Add credit
        </button>
        <button type="button" onClick={() => setOpen(false)} className={`h-10 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 lg:h-9 ${focusRing}`}>
          Cancel
        </button>
        {!valid && (name || units) && <p className="self-center text-xs text-slate-600">Enter a name and the units.</p>}
      </div>
    </form>
  );
}

/** The selected term, opened for editing right under the term bar. */
export default function TermEditor({
  entry,
  entries,
  catalog,
  data,
  state,
  dispatch,
  onOpenCourse,
  onImport,
  panelId,
  termActions,
  advise,
}: {
  entry: TermEntry;
  entries: TermEntry[];
  catalog: Catalog;
  data: PlanData;
  state: PlannerState;
  dispatch: (a: Action) => void;
  onOpenCourse: (course: string, term?: Term) => void;
  onImport: () => void;
  panelId: string;
  advise: Advisor;
  /**
   * SLOT for extra per-term buttons in this header, e.g. the weekly schedule builder's entry
   * point: `termActions={(term) => <button onClick={() => setSchedule(term)}>Weekly schedule</button>}`.
   * Called with the selected term (never the credit bucket). Planner passes it straight through.
   */
  termActions?: (term: Term) => React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [entry.key]);
  const inPlan = useMemo(() => planLocations(state), [state]);
  const isCredit = entry.key === CREDIT;
  const summer = !isCredit && entry.key.endsWith("Summer");
  const predTerm = catalog.predictions?.term;
  const showForecast = !isCredit && predTerm === entry.key && (entry.phase === "enrolling" || entry.phase === "current");
  // Over the cap is worth knowing in any term still ahead; under the minimum only where it is
  // actionable (the term in progress and the one being enrolled in).
  const notPast = entry.phase === "current" || entry.phase === "enrolling" || entry.phase === "future";
  const heavy = notPast && !summer && entry.units > 20.5;
  const light = (entry.phase === "current" || entry.phase === "enrolling") && !summer && entry.rows.length > 0 && entry.units < 13;
  const unknownUnits = entry.rows.filter((r) => !r.unitsKnown).length;
  const n = entry.rows.length;

  // Only say something when there is something to do; the tab already names the term's status.
  const blurb = isCredit
    ? "AP, IB, transfer and other credit with no Berkeley term."
    : entry.needsReview
      ? `${entry.label} is over. Mark what you finished as taken, then move or remove the rest.`
      : entry.phase === "past" && entry.emptyPast
        ? "Import your transcript or paste a list to fill this term."
        : null;

  const move = (course: string, to: TermKey) => {
    const actions = moveClassActions(state, course, to, data.courseIndex);
    // Moving a graded class into a future term turns it back into a planned class.
    const grade = findInPlan(state, course, data.courseIndex).taken?.grade;
    if (grade && actions.some((a) => a.type === "unmarkTaken") && !window.confirm(`${course} has a grade (${grade}). Moving it to ${termKeyLabel(to)} makes it a planned class and clears the grade. Move it anyway?`)) return;
    actions.forEach(dispatch);
  };
  const inProgress = entry.phase === "current";

  return (
    <section id={panelId} role="tabpanel" aria-label={entry.label} className="scroll-mt-32 rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 pb-3 pt-3.5 sm:px-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              {summer && <Sun className="h-4 w-4 text-amber-500" aria-hidden />}
              {entry.label}
            </h2>
            <span className={`text-sm tabular-nums ${heavy ? "font-semibold text-rose-600" : light ? "text-amber-700" : "text-slate-600"}`}>
              {n} class{n === 1 ? "" : "es"} · {entry.units} unit{entry.units === 1 ? "" : "s"}
              {unknownUnits > 0 && <span className="font-normal text-amber-700"> + {unknownUnits} with units unknown</span>}
            </span>
          </div>
          {(heavy || light) && (
            <p className={`mt-1 flex items-center gap-1.5 text-xs ${heavy ? "text-rose-600" : "text-amber-700"}`}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {heavy ? "Over the 20.5-unit cap" : "Under the 13-unit full-time minimum"}
            </p>
          )}
          {blurb && <p className={`mt-1 max-w-prose text-xs ${entry.needsReview ? "text-amber-800" : "text-slate-500"}`}>{blurb}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* SLOT: per-term actions (weekly schedule button goes here). */}
          {!isCredit && entry.phase !== "past" && termActions?.(entry.key)}
          {!isCredit && entry.plannedCount > 0 && (entry.phase === "past" || entry.phase === "current") && (
            <button
              type="button"
              onClick={() => dispatch({ type: "markSemesterTaken", term: entry.key })}
              className={`inline-flex h-10 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 lg:h-9 ${focusRing}`}
            >
              <CheckCheck className="h-4 w-4" aria-hidden /> Mark {entry.plannedCount === n ? "all" : entry.plannedCount} {inProgress ? "in-progress" : "planned"} class{entry.plannedCount === 1 ? "" : "es"} as taken
            </button>
          )}
          {!isCredit &&
            (confirming ? (
              <span className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 p-1.5 text-xs text-rose-900 ring-1 ring-rose-200" role="alert">
                <span className="pl-1">{n ? `Remove ${entry.label} and its ${n} class${n === 1 ? "" : "es"}?` : `Remove ${entry.label}?`}</span>
                <button type="button" autoFocus onClick={() => dispatch({ type: "removeTerm", term: entry.key })} className={`h-8 rounded-md bg-rose-600 px-2.5 font-semibold text-white hover:bg-rose-700 ${focusRing}`}>
                  Remove term
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={`h-8 rounded-md px-2 font-medium text-slate-700 hover:bg-white ${focusRing}`}>
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                // An empty term goes in one click (Undo brings it back); one with classes asks first.
                onClick={() => (n === 0 ? dispatch({ type: "removeTerm", term: entry.key }) : setConfirming(true))}
                className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-600 ring-1 ring-slate-300 hover:bg-rose-50 hover:text-rose-700 hover:ring-rose-200 lg:h-9 ${focusRing}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove term
              </button>
            ))}
        </div>
      </header>

      {n > 0 ? (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {entry.rows.map((row) => (
            <ClassRow
              key={row.course}
              row={row}
              entry={entry}
              entries={entries}
              data={data}
              showForecast={showForecast}
              advise={advise}
              onOpen={() => onOpenCourse(row.course, isCredit ? undefined : entry.key)}
              onMove={(to) => move(row.course, to)}
              dispatch={dispatch}
            />
          ))}
        </ul>
      ) : (
        <div className="border-t border-slate-100 px-4 py-6 text-center">
          <p className="text-sm font-medium text-slate-800">{isCredit ? "No test or transfer credit yet" : entry.phase === "past" ? `What did you take in ${entry.label}?` : `No classes in ${entry.label} yet`}</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-600">
            {isCredit
              ? "Add AP or IB exams and classes from another college below, or import your transcript to bring them all in."
              : entry.phase === "past"
                ? "Import your transcript to fill in every past term at once, paste a list like \u201cFall 2025: CS 61A, MATH 1B\u201d, or search below one class at a time."
                : "Search below to add a class, or move one here from another term."}
          </p>
          {(isCredit || entry.phase === "past") && (
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={onImport} className={`inline-flex h-10 items-center gap-1.5 rounded-lg bg-cal-blue px-3 text-xs font-semibold text-white hover:bg-cal-blue-700 lg:h-9 ${focusRing}`}>
                <FileUp className="h-3.5 w-3.5" aria-hidden /> Import your transcript
              </button>
              <button type="button" onClick={onImport} className={`inline-flex h-10 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 lg:h-9 ${focusRing}`}>
                <ClipboardList className="h-3.5 w-3.5" aria-hidden /> Paste a list
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-b-2xl border-t border-slate-100 bg-slate-50/70 px-3 py-3 sm:px-4">
        <div className="min-w-0 flex-1 basis-64">
          <CourseSearch
            courses={catalog.courses}
            inPlan={inPlan}
            onPick={(course) => addClassActions(entry.key, course).forEach(dispatch)}
            here={entry.key}
            onMoveHere={isCredit ? undefined : (course) => move(course, entry.key)}
            placeholder={isCredit ? "Add a Berkeley class you have transfer credit for" : `Add a class to ${entry.label}`}
          />
        </div>
        {isCredit && (
          <div className="basis-full">
            <AddCredit catalog={catalog} dispatch={dispatch} />
          </div>
        )}
      </div>
    </section>
  );
}
