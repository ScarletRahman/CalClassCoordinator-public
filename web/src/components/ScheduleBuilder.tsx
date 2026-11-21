"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Check, Info, RefreshCw, Sparkles, Undo2, X } from "lucide-react";
import CourseSearch from "./CourseSearch";
import CourseCard from "./schedule/CourseCard";
import WeekGrid from "./schedule/WeekGrid";
import { colorAt } from "./schedule/colors";
import { useSections } from "./schedule/useSections";
import { courseUnits } from "@/lib/courseId";
import {
  autoPick,
  blocksFor,
  componentName,
  conflictPairCount,
  describeConflicts,
  findConflicts,
  joinWords,
  missingComponents,
  resolveSelection,
  sectionBlocks,
  selectionNumbers,
  untimedSections,
  type Block,
  type CourseChoice,
  type ScheduleSection,
} from "@/lib/schedule";
import type { Action } from "@/lib/store";
import { compareTerms, currentTerm, termLabel } from "@/lib/terms";
import type { PlanData } from "@/lib/usePlanData";
import type { Catalog, CourseId, PlannerState, Term } from "@/lib/types";

interface Notice {
  tone: "ok" | "warn";
  text: string;
  details?: string[];
  /** What the picks were before "Find a schedule", for Undo. */
  undo?: { term: Term; sections: Record<CourseId, string[]> };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Full-screen weekly schedule for one semester: pick a lecture, discussion and lab for each
 * planned class and see the week, with clashes and seats. Picks are saved on the plan.
 */
export default function ScheduleBuilder({
  catalog,
  state,
  dispatch,
  data,
  initialTerm,
  onClose,
  onOpenCourse,
  escapeDisabled,
  inline,
}: {
  catalog: Catalog;
  state: PlannerState;
  dispatch: (a: Action) => void;
  data: PlanData;
  initialTerm: Term;
  onClose: () => void;
  onOpenCourse?: (course: CourseId, term?: Term) => void;
  /** True while something on top (the class drawer) should get Escape instead. */
  escapeDisabled?: boolean;
  /** Render as a section of the page (the Weekly schedule tab) instead of a full-screen dialog. */
  inline?: boolean;
}) {
  const [term, setTerm] = useState<Term>(initialTerm);
  const [preview, setPreview] = useState<{ course: CourseId; section: ScheduleSection } | null>(null);
  const [focus, setFocus] = useState<{ course: CourseId; component: string; nonce: number } | null>(null);
  const [locked, setLocked] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const terms = useMemo(() => {
    const now = currentTerm();
    const list = state.semesters.map((s) => s.term).filter((t) => compareTerms(t, now) >= 0);
    for (const t of [initialTerm, term]) if (!list.includes(t)) list.push(t);
    return list.sort(compareTerms);
  }, [state.semesters, initialTerm, term]);

  const planned = useMemo(() => state.semesters.find((s) => s.term === term)?.courses ?? [], [state.semesters, term]);
  const courseIds = useMemo(() => planned.map((c) => c.course), [planned]);
  const { entryFor, refresh, retry, coolingDown } = useSections(term, courseIds);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escapeDisabled || inline) return;
      // Escape inside the search box or a menu closes that first.
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return el.blur();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, escapeDisabled, inline]);

  useEffect(() => {
    if (inline) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = before;
    };
  }, [inline]);

  const choices: CourseChoice[] = useMemo(
    () => planned.map((p) => ({ course: p.course, classes: entryFor(p.course).data?.classes ?? [], chosen: p.sections })),
    [planned, entryFor],
  );
  const blocks = useMemo(() => blocksFor(choices), [choices]);
  const conflicts = useMemo(() => findConflicts(blocks), [blocks]);
  const conflictLines = useMemo(() => describeConflicts(conflicts), [conflicts]);
  const clashCount = conflictPairCount(conflicts);
  const untimed = useMemo(() => untimedSections(choices), [choices]);
  const ghosts: Block[] = useMemo(() => (preview ? sectionBlocks(preview.course, preview.section) : []), [preview]);
  const colorIndex = useMemo(() => new Map(courseIds.map((c, i) => [c, i])), [courseIds]);
  const colorOf = useCallback((course: CourseId) => colorAt(colorIndex.get(course) ?? 0), [colorIndex]);

  const unitsOf = (course: CourseId) => {
    const known = data.courseIndex.get(course);
    if (known) return courseUnits(known);
    const u = resolveSelection(entryFor(course).data?.classes ?? [], undefined).cls?.units;
    return u ? u[1] : undefined;
  };
  const totalUnits = courseIds.reduce((a, c) => a + (unitsOf(c) ?? 0), 0);

  const entries = courseIds.map((c) => entryFor(c));
  const stillLoading = entries.some((e) => e.phase === "loading");
  const tentative = entries.find((e) => e.data?.tentative)?.data;
  const toPick = choices.flatMap((c) => {
    if (!c.classes.length) return [];
    const r = resolveSelection(c.classes, c.chosen);
    if (!r.primary) return [`${c.course} ${componentName(c.classes[0].primary.component)}`];
    return missingComponents(r).map((m) => `${c.course} ${componentName(m)}`);
  });
  const anyTimes = choices.some((c) => c.classes.length > 0);

  const lockKey = (course: CourseId) => `${term}|${course}`;
  const toggleLock = (course: CourseId) =>
    setLocked((prev) => {
      const next = new Set(prev);
      if (!next.delete(lockKey(course))) next.add(lockKey(course));
      return next;
    });

  const findSchedule = () => {
    const withTimes = choices.filter((c) => c.classes.length > 0);
    const fixed: Record<CourseId, string[]> = {};
    for (const c of withTimes) if (locked.has(lockKey(c.course))) fixed[c.course] = selectionNumbers(resolveSelection(c.classes, c.chosen));
    const result = autoPick(withTimes, fixed);
    const before: Record<CourseId, string[]> = {};
    let changed = 0;
    for (const c of withTimes) {
      const next = result.selections[c.course];
      if (!next || sameList(next, c.chosen ?? [])) continue;
      before[c.course] = [...(c.chosen ?? [])];
      // Filling in the only possible lecture is not a change worth announcing.
      if (!sameList(next, selectionNumbers(resolveSelection(c.classes, c.chosen)))) changed++;
      dispatch({ type: "setSections", term, course: c.course, sections: next });
    }
    const undo = Object.keys(before).length ? { term, sections: before } : undefined;
    const left = conflictPairCount(result.conflicts);
    if (left === 0) {
      setNotice({
        tone: "ok",
        text: changed ? `No conflicts. Changed ${changed} ${changed === 1 ? "class" : "classes"}.` : "No conflicts. Nothing changed.",
        undo: changed ? undo : undefined,
      });
    } else {
      const clashing = [...new Set(result.conflicts.flatMap((c) => [c.a.course, c.b.course]))];
      setNotice({
        tone: "warn",
        text: `${result.capped ? "Couldn't find a conflict-free schedule in time." : "No conflict-free schedule exists for these classes."} ${joinWords(clashing)} still clash.${
          Object.keys(fixed).length ? " Unlocking a class may help." : ""
        }${changed ? " Kept the closest fit." : ""}`,
        details: describeConflicts(result.conflicts),
        undo,
      });
    }
  };

  const undoNotice = () => {
    if (!notice?.undo) return;
    for (const [course, sections] of Object.entries(notice.undo.sections)) dispatch({ type: "setSections", term: notice.undo.term, course, sections });
    setNotice(null);
  };

  const exclude = useMemo(() => new Set([...courseIds, ...state.taken.map((t) => t.course)]), [courseIds, state.taken]);

  return (
    <div
      className={inline ? "flex flex-col overflow-hidden rounded-2xl bg-[#f6f7fb] shadow-sm ring-1 ring-slate-200 lg:h-[calc(100dvh-150px)] lg:min-h-[560px]" : "fixed inset-0 z-40 flex flex-col bg-[#f6f7fb]"}
      {...(inline ? { role: "region" } : { role: "dialog", "aria-modal": true })}
      aria-label={`Weekly schedule for ${termLabel(term)}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-3 py-2.5 sm:px-5">
        {!inline && (
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-cal-blue text-cal-gold" aria-hidden>
              <CalendarDays className="h-4 w-4" />
            </span>
            <h1 className="text-base font-semibold text-slate-900">Weekly schedule</h1>
          </div>
        )}
        <label className="flex items-center">
          <span className="sr-only">Semester</span>
          <select
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setPreview(null);
              setNotice(null);
            }}
            className="rounded-lg border-0 bg-slate-50 py-1.5 pl-2.5 pr-8 text-sm font-medium text-slate-800 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-cal-blue"
          >
            {terms.map((t) => (
              <option key={t} value={t}>
                {termLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm text-slate-600">
          <span className="font-semibold tabular-nums text-slate-900">{totalUnits}</span> units
        </span>
        {anyTimes && !stillLoading && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${
              clashCount ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
            }`}
            aria-live="polite"
          >
            {clashCount ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
            {clashCount ? `${clashCount} ${clashCount === 1 ? "conflict" : "conflicts"}` : "No conflicts"}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={findSchedule}
            disabled={!anyTimes || stillLoading}
            aria-label="Find a schedule with no conflicts"
            className="inline-flex items-center gap-1.5 rounded-lg bg-cal-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-cal-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-gold disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> <span>Find a schedule<span className="hidden sm:inline"> with no conflicts</span></span>
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={coolingDown || !courseIds.length || !!tentative}
            title={coolingDown ? "Just checked. Try again in a moment." : "Update seat counts"}
            aria-label="Refresh seats"
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> <span>Refresh<span className="hidden sm:inline"> seats</span></span>
          </button>
          {!inline && (
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue"
            >
              <X className="h-3.5 w-3.5" aria-hidden /> Close
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* Calendar: first on phones, right-hand side on wide screens. */}
        <main className="min-w-0 p-3 sm:p-5 lg:order-2 lg:flex-1 lg:overflow-y-auto">
          {tentative && (
            <p className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {termLabel(term)} times aren&apos;t out yet. Showing {termLabel(tentative.basisTerm ?? term)} times for now, without seat counts.
              </span>
            </p>
          )}
          {notice && (
            <div
              role="status"
              className={`mb-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ring-1 ${notice.tone === "ok" ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200"}`}
            >
              {notice.tone === "ok" ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1">{notice.text}</span>
              {notice.undo && (
                <button type="button" onClick={undoNotice} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold underline hover:no-underline">
                  <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo
                </button>
              )}
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 hover:bg-black/5">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {conflictLines.length > 0 && (
            <div className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200" aria-live="polite">
              <p className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="h-4 w-4" aria-hidden /> {clashCount === 1 ? "Overlap" : "Overlaps"}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-6">
                {conflictLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {toPick.length > 0 && !stillLoading && (
            <p className="mb-3 rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
              <span className="font-semibold text-slate-700">Not scheduled yet:</span> {toPick.join(", ")}
            </p>
          )}
          <WeekGrid
            blocks={blocks}
            ghosts={ghosts}
            conflicts={conflicts}
            untimed={untimed}
            colorOf={colorOf}
            onBlockClick={(b) => setFocus({ course: b.course, component: b.component, nonce: Date.now() })}
          />
          <p className="mt-3 text-xs text-slate-400">Times are Pacific. Confirm in CalCentral before enrolling.</p>
        </main>

        <aside className="thin-scroll w-full shrink-0 space-y-3 border-t border-slate-200 p-3 sm:p-5 lg:order-1 lg:w-[420px] lg:overflow-y-auto lg:border-r lg:border-t-0" aria-label={`Classes in ${termLabel(term)}`}>
          <CourseSearch courses={catalog.courses} exclude={exclude} onPick={(course) => dispatch({ type: "addPlanned", term, course })} placeholder={`Add a class to ${termLabel(term)}`} />
          {planned.length === 0 && (
            <p className="rounded-2xl bg-white p-4 text-sm text-slate-500 ring-1 ring-slate-200">
              No classes in {termLabel(term)} yet.
            </p>
          )}
          {planned.map((p) => {
            const course = data.courseIndex.get(p.course);
            return (
              <CourseCard
                key={`${term}|${p.course}`}
                course={p.course}
                title={course?.title}
                units={unitsOf(p.course)}
                term={term}
                color={colorOf(p.course)}
                entry={entryFor(p.course)}
                chosen={p.sections}
                blocks={blocks}
                locked={locked.has(lockKey(p.course))}
                focus={focus?.course === p.course ? focus : null}
                onToggleLock={() => toggleLock(p.course)}
                onSelect={(sections) => {
                  setNotice(null);
                  dispatch({ type: "setSections", term, course: p.course, sections });
                }}
                onRemove={() => dispatch({ type: "removePlanned", term, course: p.course })}
                onRetry={() => retry(p.course)}
                onPreview={(section) => setPreview(section ? { course: p.course, section } : null)}
                onOpenCourse={onOpenCourse ? () => onOpenCourse(p.course, term) : undefined}
              />
            );
          })}
        </aside>
      </div>
    </div>
  );
}
