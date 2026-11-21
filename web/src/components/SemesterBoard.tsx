"use client";

import { useMemo, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { AlertTriangle, Check, ChevronRight, Eye, EyeOff, GripVertical, Plus, Sun, User, X, ChevronDown } from "lucide-react";
import CourseSearch from "./CourseSearch";
import { MarkerBadge } from "./TermBar";
import { instructorRangeNow, isoDay } from "@/lib/forecast";
import { forecastFor, insightFor, type Advisor } from "@/lib/planLookups";
import { CREDIT, addClassActions, findInPlan, moveClassActions, planLocations, termKeyLabel, type PlanLocation, type TermEntry, type TermKey, type TermRow } from "@/lib/planTerms";
import { suggestNextSummer, suggestNextTerm, termLabel } from "@/lib/terms";
import { usePref } from "@/lib/usePref";
import type { PlanData } from "@/lib/usePlanData";
import type { Catalog, PlannerState, Term } from "@/lib/types";
import type { Action } from "@/lib/store";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";
// Icon buttons: 40px on phones and tablets (and any touch pointer), 32px on a desktop with a mouse.
const iconBtn = `grid h-10 w-10 shrink-0 place-items-center rounded-lg lg:h-8 lg:w-8 pointer-coarse:h-10 pointer-coarse:w-10 ${focusRing}`;

function CourseCard({
  row,
  term,
  data,
  live,
  advise,
  phases,
  onOpen,
  onRemove,
  overlay,
}: {
  row: TermRow;
  term: Term;
  data: PlanData;
  /** This is the term being enrolled in, so forecasts and seats apply. */
  live: boolean;
  advise?: Advisor;
  phases?: Catalog["predictions"] extends infer P ? (P extends { phases: infer X } ? X : never) : never;
  onOpen?: () => void;
  onRemove?: () => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `${term}::${row.course}`, data: { term, course: row.course }, disabled: overlay });
  const c = data.courseIndex.get(row.course);
  const taken = row.status === "taken";
  const forecast = live && !taken ? forecastFor(data, row.course, row.professor) : null;
  const pred = forecast?.headline;
  const tone = advise?.(pred, row.course) ?? null;
  const nudge = forecast && forecast.several && !forecast.chosen ? `${forecast.count} instructors · ${instructorRangeNow(forecast.named, phases ?? [], isoDay(new Date()))} · pick one` : null;
  const insight = insightFor(data, row.course);
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      className={`relative rounded-xl p-1.5 ring-1 transition ${taken ? "bg-emerald-50/60 ring-emerald-200" : "bg-white ring-slate-200"} ${
        overlay ? "rotate-1 shadow-xl" : isDragging ? "opacity-30" : "hover:shadow-sm hover:ring-slate-400"
      }`}
    >
      <div className="flex items-start gap-0.5">
        {/* Pointer-only: keyboard and screen reader users move a class with "Move to" in the term editor. */}
        <button
          type="button"
          {...(overlay ? {} : listeners)}
          {...(overlay ? {} : attributes)}
          role={undefined}
          aria-roledescription={undefined}
          aria-describedby={undefined}
          tabIndex={-1}
          aria-hidden
          title={`Drag ${row.course} to another term`}
          className={`${iconBtn} cursor-grab touch-none text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing`}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" onClick={onOpen} className={`group min-w-0 flex-1 rounded-md py-1 text-left pointer-coarse:min-h-10 ${focusRing}`}>
          <span className="flex items-baseline gap-2">
            {taken && <Check className="h-3.5 w-3.5 shrink-0 self-center text-emerald-600" aria-label="Taken" />}
            <span className="text-sm font-semibold text-slate-900 group-hover:text-cal-blue group-hover:underline">{row.course}</span>
            <span className={`text-xs tabular-nums ${row.unitsKnown ? "text-slate-600" : "text-amber-700"}`}>{row.unitsKnown ? `${row.units}u` : "units?"}</span>
            {row.grade && <span className="text-xs font-medium text-emerald-700">{row.grade}</span>}
          </span>
          <span className="block truncate text-xs text-slate-600">{c?.title ?? row.label ?? "Not in our catalog"}</span>
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${row.course} from ${termLabel(term)}`} title="Remove" className={`${iconBtn} text-slate-400 hover:bg-rose-50 hover:text-rose-600`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      {nudge && (
        <button type="button" onClick={onOpen} className={`mx-1 mb-1 mt-0.5 block w-[calc(100%-0.5rem)] rounded-lg bg-cal-gold-100 px-2 py-1.5 text-left text-[11px] leading-snug text-cal-blue ring-1 ring-cal-gold/70 hover:bg-cal-gold/30 ${focusRing}`}>
          <User className="mr-1 inline h-3 w-3 -translate-y-px" aria-hidden />
          {nudge}
        </button>
      )}
      {(tone || insight?.difficulty != null || (row.professor && !taken)) && (
        <div className="flex flex-wrap items-center gap-1 px-1 pb-1 pt-0.5 pl-9 pointer-coarse:pl-11">
          {(pred?.professor || row.professor) && !taken && (
            <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200">
              <User className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{pred?.professor ?? row.professor}</span>
            </span>
          )}
          {tone && (
            <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ${tone.cls}`} title={tone.advice}>
              {pred && !tone.fromSeats && !pred.professorSeenBefore && <AlertTriangle className="h-3 w-3" aria-label="New instructor, lower confidence" />}
              {tone.label}
            </span>
          )}
          {insight?.difficulty != null && <span className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200">Difficulty {insight.difficulty.toFixed(1)}</span>}
        </div>
      )}
    </div>
  );
}

function TermColumn({
  entry,
  selected,
  data,
  catalog,
  live,
  advise,
  inPlan,
  dispatch,
  move,
  onOpenCourse,
  onSelect,
}: {
  entry: TermEntry;
  selected: boolean;
  data: PlanData;
  catalog: Catalog;
  live: boolean;
  advise: Advisor;
  inPlan: Map<string, PlanLocation>;
  dispatch: (a: Action) => void;
  move: (course: string, to: TermKey) => void;
  onOpenCourse: (course: string, term?: Term) => void;
  onSelect: () => void;
}) {
  const term = entry.key as Term;
  const { setNodeRef, isOver } = useDroppable({ id: term });
  const phases = catalog.predictions?.phases;
  const summer = term.endsWith("Summer");
  const heavy = entry.phase !== "past" && !summer && entry.units > 20.5;
  const light = (entry.phase === "current" || entry.phase === "enrolling") && !summer && entry.rows.length > 0 && entry.units < 13;
  return (
    <section
      ref={setNodeRef}
      aria-label={entry.label}
      className={`flex min-h-48 min-w-0 flex-col rounded-2xl p-2.5 ring-1 transition ${
        isOver ? "bg-cal-gold-100 ring-2 ring-cal-gold" : selected ? "bg-white ring-2 ring-cal-blue" : entry.phase === "past" ? "bg-slate-100/50 ring-slate-200" : "bg-slate-100/80 ring-slate-200"
      }`}
    >
      <header className="mb-2">
        <button
          type="button"
          onClick={onSelect}
          title="Open this term in the editor above"
          className={`group flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white ${focusRing}`}
        >
          <span className="min-w-0 flex-1">
            <span role="heading" aria-level={3} className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              {summer && <Sun className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />}
              {entry.label}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <MarkerBadge entry={entry} />
              <span aria-hidden>·</span>
              <span className={`tabular-nums ${heavy ? "font-semibold text-rose-600" : light ? "text-amber-700" : ""}`}>
                {entry.units} unit{entry.units === 1 ? "" : "s"}
                {heavy ? ", over the 20.5 cap" : light ? ", under 13" : ""}
              </span>
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center text-xs font-medium text-slate-600 group-hover:text-cal-blue">
            Edit <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </button>
      </header>
      <div className="flex flex-1 flex-col gap-1.5">
        {entry.rows.map((row) => (
          <CourseCard
            key={row.course}
            row={row}
            term={term}
            data={data}
            live={live}
            advise={advise}
            phases={phases}
            onOpen={() => onOpenCourse(row.course, term)}
            onRemove={() => dispatch(row.status === "taken" ? { type: "removeTaken", course: row.course } : { type: "removePlanned", term, course: row.course })}
          />
        ))}
        {!entry.rows.length && (
          <p className="grid flex-1 place-items-center rounded-xl border border-dashed border-slate-300 p-3 text-center text-xs text-slate-600">
            {entry.phase === "past" ? "Add what you took this term." : "Nothing here yet. Search below to add a class."}
          </p>
        )}
      </div>
      <div className="mt-2">
        <CourseSearch courses={catalog.courses} inPlan={inPlan} onPick={(course) => addClassActions(term, course).forEach(dispatch)} onMoveHere={(course) => move(course, term)} placeholder="Add a class" label={`Add a class to ${entry.label}`} />
      </div>
    </section>
  );
}

/** Every term side by side. Drag classes between terms; click a term's header to edit it above. */
export default function SemesterBoard({
  state,
  entries,
  selected,
  catalog,
  data,
  dispatch,
  advise,
  onOpenCourse,
  onSelectTerm,
}: {
  state: PlannerState;
  entries: TermEntry[];
  selected: TermKey | null;
  catalog: Catalog;
  data: PlanData;
  dispatch: (a: Action) => void;
  advise: Advisor;
  onOpenCourse: (course: string, term?: Term) => void;
  onSelectTerm: (key: TermKey) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<{ term: Term; course: string } | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [open, setOpen] = usePref("ccc.ui.allTerms", true);
  const predTerm = catalog.predictions?.term;
  const inPlan = useMemo(() => planLocations(state), [state]);

  const terms = entries.filter((e) => e.key !== CREDIT);
  // Empty past terms are placeholders for history not entered yet: not counted anywhere.
  const past = terms.filter((e) => e.phase === "past" && !e.emptyPast);
  const emptyPast = terms.filter((e) => e.emptyPast);
  const shown = showPast ? terms : terms.filter((e) => e.phase !== "past");
  const existing = terms.map((e) => e.key);

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const from = e.active.data.current as { term: Term; course: string } | undefined;
    const to = e.over?.id as Term | undefined;
    if (from && to && from.term !== to) move(from.course, to);
  };
  const move = (course: string, to: TermKey) => {
    const actions = moveClassActions(state, course, to, data.courseIndex);
    const grade = findInPlan(state, course, data.courseIndex).taken?.grade;
    if (grade && actions.some((a) => a.type === "unmarkTaken") && !window.confirm(`${course} has a grade (${grade}). Moving it to ${termKeyLabel(to)} makes it a planned class and clears the grade. Move it anyway?`)) return;
    actions.forEach(dispatch);
  };
  const draggingRow = dragging ? entries.find((e) => e.key === dragging.term)?.rows.find((r) => r.course === dragging.course) : undefined;

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setDragging(e.active.data.current as { term: Term; course: string })} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <h2>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`inline-flex h-10 items-center gap-1 rounded-lg text-xs font-semibold uppercase tracking-wider text-slate-600 hover:text-slate-900 lg:h-9 ${focusRing}`}>
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden /> All terms
          </button>
        </h2>
        {open && past.length + emptyPast.length > 0 && (
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            aria-pressed={showPast}
            className={`ml-auto inline-flex h-10 items-center gap-1.5 rounded-lg bg-white px-2.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 lg:h-9 ${focusRing}`}
          >
            {showPast ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
            {showPast ? "Hide" : "Show"} {past.length + emptyPast.length} past term{past.length + emptyPast.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      <div hidden={!open} className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        {shown.map((e) => (
          <TermColumn
            key={e.key}
            entry={e}
            selected={selected === e.key}
            data={data}
            catalog={catalog}
            live={!!predTerm && predTerm === e.key && e.phase !== "past"}
            advise={advise}
            inPlan={inPlan}
            dispatch={dispatch}
            move={move}
            onOpenCourse={onOpenCourse}
            onSelect={() => onSelectTerm(e.key)}
          />
        ))}
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-4 text-center">
          {shown.length === 0 && <p className="text-sm text-slate-700">No upcoming terms in your plan.</p>}
          <button type="button" onClick={() => dispatch({ type: "addSemester", term: suggestNextTerm(existing) })} className={`inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-3.5 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-300 hover:ring-slate-500 ${focusRing}`}>
            <Plus className="h-4 w-4" aria-hidden /> Add {termLabel(suggestNextTerm(existing))}
          </button>
          <button type="button" onClick={() => dispatch({ type: "addSemester", term: suggestNextSummer(existing) })} className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900 ${focusRing}`}>
            <Sun className="h-3.5 w-3.5 text-amber-500" aria-hidden /> Add {termLabel(suggestNextSummer(existing))}
          </button>
        </div>
      </div>
      <DragOverlay>{dragging && draggingRow && <CourseCard overlay row={draggingRow} term={dragging.term} data={data} live={false} />}</DragOverlay>
    </DndContext>
  );
}
