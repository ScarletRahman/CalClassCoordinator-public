"use client";

import { useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Search } from "lucide-react";
import { SEARCH_THRESHOLD, filterInstructors, seatsForInstructor, sortInstructors, type InstructorSort, type InstructorSummary } from "@/lib/professors";
import type { Advisor } from "@/lib/planLookups";
import type { Prediction, SectionSeats } from "@/lib/types";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";
const PAGE = 8;

function Option({
  checked,
  tabbable,
  onSelect,
  children,
  label,
}: {
  checked: boolean;
  /** Roving tabindex: only one radio in the group is a tab stop. */
  tabbable: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={label}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className={`flex w-full items-start gap-3 rounded-xl p-3 text-left ring-1 transition ${focusRing} ${
          checked ? "bg-cal-gold-100 ring-2 ring-cal-blue" : "bg-white ring-slate-200 hover:ring-slate-400"
        }`}
      >
        <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ring-1 ${checked ? "bg-cal-blue text-white ring-cal-blue" : "bg-white ring-slate-400"}`} aria-hidden>
          {checked && <Check className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1">{children}</span>
      </button>
    </li>
  );
}

function InstructorBody({ p, seats, advise, course }: { p: Prediction; seats: SectionSeats[]; advise: Advisor; course: string }) {
  const tone = advise(p, course);
  const live = seatsForInstructor(seats, p.professor);
  const pct = Math.round(p.popularity * 100);
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">{p.professor}</span>
        {!p.professorSeenBefore && (
          <span title="First time teaching this class. Forecast uses the class's history." className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">
            <AlertTriangle className="h-3 w-3" aria-hidden /> New
          </span>
        )}
        {tone && <span className={`ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ${tone.cls}`}>{tone.label}</span>}
      </span>
      <span className="mt-1.5 flex items-center gap-2">
        <span className="w-[4.5rem] shrink-0 text-[11px] text-slate-500">Popularity</span>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
          <span className="block h-full rounded-full bg-cal-blue" style={{ width: `${pct}%` }} />
        </span>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-slate-600">{pct}%</span>
      </span>
      <span className="mt-1 block text-xs text-slate-600">
        {tone?.advice ?? "No forecast"}
        {live && !tone?.fromSeats && (
          <span className={live.open > 0 ? "text-emerald-700" : "text-slate-500"}>
            {" "}
            · {live.open > 0 ? `${live.open} seat${live.open === 1 ? "" : "s"} open now` : live.waitlisted ? `full, ${live.waitlisted} waitlisted` : "full now"}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * The instructor is the main decision for classes with many sections (R1A, R1B): a radio list
 * with each instructor's forecast, an explicit "No preference", sorting, and a search box once
 * the list is long.
 */
export default function InstructorPicker({
  summary,
  seats,
  selected,
  onSelect,
  termName,
  advise,
  course,
}: {
  summary: InstructorSummary;
  seats: SectionSeats[];
  /** Chosen instructor's name, or undefined for no preference. */
  selected?: string;
  onSelect: (professor?: string) => void;
  termName: string;
  advise: Advisor;
  /** The id seat data is filed under, for live counts per instructor. */
  course: string;
  /** Today's spread across instructors ("3 of 15 have probably filled already; ..."). */
  rangeNow: string;
}) {
  const groupRef = useRef<HTMLUListElement>(null);
  // Arrow keys move through the radios and select, as a native radio group does.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir && e.key !== "Home" && e.key !== "End") return;
    const radios = [...(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    if (!radios.length) return;
    e.preventDefault();
    const i = radios.indexOf(document.activeElement as HTMLElement);
    const j = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (i + dir + radios.length) % radios.length;
    radios[j].focus();
    radios[j].click();
  };
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<InstructorSort>("demand");
  const [showAll, setShowAll] = useState(false);
  const id = useId();

  const list = useMemo(() => filterInstructors(sortInstructors(summary.named, sort), query), [summary.named, sort, query]);
  const searching = query.trim().length > 0;
  // Keep the chosen instructor on screen even when the list is cut short.
  const cut = showAll || searching ? list : list.slice(0, PAGE);
  const visible = !showAll && !searching && summary.chosen && !cut.includes(summary.chosen) ? [summary.chosen, ...cut.slice(0, PAGE - 1)] : cut;
  const hidden = list.length - visible.length;

  return (
    <section aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 id={`${id}-h`} className="text-sm font-semibold text-slate-900">
          Instructor
        </h3>
        <p className="text-xs text-slate-500">
          {summary.count} teaching in {termName}
        </p>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {summary.count > SEARCH_THRESHOLD && (
          <div className="relative min-w-0 flex-1 basis-40">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an instructor"
              aria-label="Find an instructor by name"
              className="h-10 w-full rounded-lg border-0 bg-white pl-8 pr-2 text-base ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cal-blue sm:h-9 sm:text-sm"
            />
          </div>
        )}
        <label className="sr-only" htmlFor={`${id}-sort`}>
          Sort instructors
        </label>
        <select
          id={`${id}-sort`}
          value={sort}
          onChange={(e) => setSort(e.target.value as InstructorSort)}
          className="h-10 rounded-lg border-0 bg-white pl-2 pr-1 text-sm text-slate-700 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-cal-blue sm:h-9"
        >
          <option value="demand">Fills first</option>
          <option value="easiest">Easiest to get into</option>
          <option value="name">Name</option>
        </select>
      </div>

      <ul ref={groupRef} role="radiogroup" aria-labelledby={`${id}-h`} onKeyDown={onKeyDown} className="mt-2 space-y-1.5">
        {!searching && (
          <Option checked={!selected} tabbable={!selected} onSelect={() => onSelect(undefined)} label="No preference">
            <span className="text-sm font-semibold text-slate-900">No preference</span>
            <span className="mt-0.5 block text-xs text-slate-600">Any section</span>
          </Option>
        )}
        {visible.map((p, i) => (
          <Option
            key={p.professor}
            checked={selected === p.professor}
            tabbable={selected === p.professor || (searching && !visible.some((v) => v.professor === selected) && i === 0)}
            onSelect={() => onSelect(p.professor)}
            label={`${p.professor}, ${advise(p, course)?.label ?? "no forecast"}`}
          >
            <InstructorBody p={p} seats={seats} advise={advise} course={course} />
          </Option>
        ))}
      </ul>
      {searching && list.length === 0 && <p className="mt-2 rounded-xl bg-white p-3 text-sm text-slate-500 ring-1 ring-slate-200">No instructor matches “{query.trim()}”.</p>}
      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll(true)} className={`mt-2 h-10 w-full rounded-lg bg-white text-sm font-medium text-cal-blue ring-1 ring-slate-300 hover:bg-slate-50 sm:h-9 ${focusRing}`}>
          Show all {list.length} instructors
        </button>
      )}
      {showAll && !searching && list.length > PAGE && (
        <button type="button" onClick={() => setShowAll(false)} className={`mt-2 h-10 w-full rounded-lg text-sm font-medium text-slate-600 hover:bg-white sm:h-9 ${focusRing}`}>
          Show fewer
        </button>
      )}
    </section>
  );
}
