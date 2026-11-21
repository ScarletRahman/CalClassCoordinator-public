"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, Lock, LockOpen, X } from "lucide-react";
import type { CourseColor } from "./colors";
import { statusLine, type SectionsEntry } from "./useSections";
import {
  blockLabel,
  componentName,
  componentsOf,
  conflictsWith,
  locationsLabel,
  meetingsLabel,
  resolveSelection,
  seatLabel,
  sectionNumber,
  sectionSortKey,
  sectionsOf,
  type Block,
  type ScheduleClass,
  type ScheduleSection,
  type SeatTone,
} from "@/lib/schedule";
import { termLabel } from "@/lib/terms";
import type { CourseId, Term } from "@/lib/types";

const SEAT_STYLES: Record<SeatTone, string> = {
  open: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  reserved: "bg-violet-50 text-violet-700 ring-violet-200",
  waitlist: "bg-amber-50 text-amber-800 ring-amber-200",
  full: "bg-slate-100 text-slate-500 ring-slate-200",
};

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

function SeatPill({ section }: { section: ScheduleSection }) {
  const label = seatLabel(section);
  if (!label) return null;
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${SEAT_STYLES[label.tone]}`}>
      {label.text}
    </span>
  );
}

function rowAria(kind: string, s: ScheduleSection, clashes: Block[]): string {
  const parts = [`${cap(kind)} ${sectionNumber(s)}`, meetingsLabel(s).replace(/-/g, " to "), locationsLabel(s), s.instructor, seatLabel(s)?.text];
  if (clashes.length) parts.push(`conflicts with ${clashes.map(blockLabel).join(" and ")}`);
  return parts.filter(Boolean).join(", ");
}

/** What a row shows; used both for selectable rows and for the collapsed "your pick" line. */
function RowBody({ section, clashes, showInstructor }: { section: ScheduleSection; clashes: Block[]; showInstructor?: boolean }) {
  const where = locationsLabel(section);
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-xs font-semibold tabular-nums text-slate-500">{sectionNumber(section)}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-800">{meetingsLabel(section)}</span>
        <SeatPill section={section} />
      </span>
      {(where || (showInstructor && section.instructor)) && (
        <span className="block truncate pl-10 text-xs text-slate-500">{[showInstructor ? section.instructor : null, where].filter(Boolean).join(" · ")}</span>
      )}
      {clashes.length > 0 && (
        <span className="flex items-center gap-1 pl-10 text-xs font-medium text-rose-600">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> Conflicts with {clashes.map(blockLabel).join(", ")}
        </span>
      )}
    </span>
  );
}

const COLLAPSE_OVER = 4;

function SectionGroup({
  kind,
  options,
  selected,
  clashesFor,
  onPick,
  onPreview,
  showInstructor,
  openSignal,
  locked,
}: {
  /** "lecture", "discussion", ... */
  kind: string;
  options: ScheduleSection[];
  selected?: ScheduleSection;
  clashesFor: (s: ScheduleSection) => Block[];
  onPick: (s: ScheduleSection) => void;
  onPreview: (s: ScheduleSection | null) => void;
  showInstructor?: boolean;
  /** Changes when the calendar asks this group to open. */
  openSignal?: number;
  locked?: boolean;
}) {
  const collapsible = options.length > COLLAPSE_OVER;
  const [expanded, setExpanded] = useState(false);
  const [hideFull, setHideFull] = useState(false);
  const [hideClashing, setHideClashing] = useState(false);
  useEffect(() => {
    if (openSignal) setExpanded(true);
  }, [openSignal]);

  const rows = useMemo(
    () =>
      [...options]
        .sort((a, b) => sectionSortKey(a) - sectionSortKey(b) || a.section.localeCompare(b.section, undefined, { numeric: true }))
        .map((s) => ({ s, clashes: clashesFor(s), tone: seatLabel(s)?.tone })),
    [options, clashesFor],
  );
  const open = !collapsible || expanded;
  const visible = rows.filter((r) => r.s === selected || ((!hideFull || r.tone !== "full") && (!hideClashing || r.clashes.length === 0)));
  const hidden = rows.length - visible.length;
  const hasSeats = rows.some((r) => r.tone);
  const selectedRow = rows.find((r) => r.s === selected);

  if (options.length === 1) {
    const only = rows[0];
    return (
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{cap(kind)}</h4>
        <div className={`flex rounded-lg px-2 py-1.5 ring-1 ${only.clashes.length ? "bg-rose-50/60 ring-rose-200" : "bg-slate-50 ring-slate-200"}`}>
          <RowBody section={only.s} clashes={only.clashes} showInstructor={showInstructor} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{cap(kind)}</h4>
        {collapsible && !locked && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-cal-blue hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue"
          >
            {expanded ? (<>Done <ChevronUp className="h-3.5 w-3.5" aria-hidden /></>) : (<>{selected ? "Change" : "Choose"} ({options.length} options) <ChevronDown className="h-3.5 w-3.5" aria-hidden /></>)}
          </button>
        )}
      </div>

      {(!open || locked) &&
        (selectedRow ? (
          <div className={`flex rounded-lg px-2 py-1.5 ring-1 ${selectedRow.clashes.length ? "bg-rose-50/60 ring-rose-200" : "bg-slate-50 ring-slate-200"}`}>
            <RowBody section={selectedRow.s} clashes={selectedRow.clashes} showInstructor={showInstructor} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            disabled={locked}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-amber-400 bg-amber-50 px-2.5 py-2 text-left text-[13px] font-medium text-amber-900 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue"
          >
            Pick {article(kind)} {kind}
            <span className="ml-auto text-xs font-normal text-amber-800">{options.length} options</span>
          </button>
        ))}

      {open && !locked && (
        <>
          {!selected && !collapsible && <p className="mb-1 text-xs font-medium text-amber-800">Pick {article(kind)} {kind}</p>}
          {collapsible && (
            <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              {hasSeats && (
                <label className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={hideFull} onChange={(e) => setHideFull(e.target.checked)} className="h-3.5 w-3.5 rounded accent-cal-blue" /> Hide full
                </label>
              )}
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={hideClashing} onChange={(e) => setHideClashing(e.target.checked)} className="h-3.5 w-3.5 rounded accent-cal-blue" /> Hide conflicting
              </label>
              {hidden > 0 && <span className="text-slate-400">{hidden} hidden</span>}
            </div>
          )}
          <div
            role="radiogroup"
            aria-label={`${cap(kind)} options`}
            className={`thin-scroll space-y-1 ${collapsible ? "max-h-80 overflow-y-auto rounded-lg bg-slate-50/70 p-1 ring-1 ring-slate-200" : ""}`}
            onMouseLeave={() => onPreview(null)}
          >
            {visible.map(({ s, clashes }) => {
              const isSelected = s === selected;
              return (
                <button
                  key={s.classNumber + s.section}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={rowAria(kind, s, clashes)}
                  onClick={() => {
                    onPick(s);
                    onPreview(null);
                    if (collapsible) setExpanded(false);
                  }}
                  onMouseEnter={() => onPreview(isSelected ? null : s)}
                  onFocus={() => onPreview(isSelected ? null : s)}
                  onBlur={() => onPreview(null)}
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left ring-1 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue ${
                    isSelected ? "bg-cal-gold-100 ring-cal-gold" : "bg-white ring-slate-200 hover:bg-slate-50 hover:ring-slate-300"
                  }`}
                >
                  <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ring-1 ${isSelected ? "bg-cal-blue text-white ring-cal-blue" : "bg-white ring-slate-300"}`} aria-hidden>
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                  <RowBody section={s} clashes={clashes} showInstructor={showInstructor} />
                </button>
              );
            })}
            {visible.length === 0 && <p className="px-2 py-3 text-center text-xs text-slate-500">All options hidden by filters.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function ReservedNote({ primary }: { primary: ScheduleSection }) {
  const groups = (primary.reserved ?? []).filter((r) => r.capacity > 0);
  if (!groups.length) return null;
  return (
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer select-none rounded hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue">
        Reserved seats
      </summary>
      <ul className="mt-1 space-y-1 pl-3">
        {groups.map((r) => (
          <li key={r.group} className="flex gap-2">
            <span className="shrink-0 font-semibold tabular-nums text-slate-700">{Math.max(0, r.capacity - r.enrolled)} left</span>
            <span>{r.group}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface CourseCardProps {
  course: CourseId;
  title?: string;
  units?: number;
  term: Term;
  color: CourseColor;
  entry: SectionsEntry;
  chosen?: readonly string[];
  /** Every block currently on the calendar (all classes). */
  blocks: Block[];
  locked: boolean;
  /** Set by a click on the calendar: scroll here and open that kind of section. */
  focus?: { component: string; nonce: number } | null;
  onToggleLock: () => void;
  onSelect: (sections: string[]) => void;
  onRemove: () => void;
  onRetry: () => void;
  onPreview: (s: ScheduleSection | null) => void;
  onOpenCourse?: () => void;
}

export default function CourseCard(props: CourseCardProps) {
  const { course, title, units, term, color, entry, chosen, blocks, locked, focus, onSelect, onPreview } = props;
  const ref = useRef<HTMLElement>(null);
  const [flash, setFlash] = useState(false);
  const classes: ScheduleClass[] = useMemo(() => entry.data?.classes ?? [], [entry.data]);
  const resolved = useMemo(() => resolveSelection(classes, chosen), [classes, chosen]);
  const status = statusLine(entry);

  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [focus]);

  // Blocks a candidate is compared against: everything but the pick it would replace.
  const othersForPrimary = useMemo(() => blocks.filter((b) => b.course !== course), [blocks, course]);
  const primaryClashes = useMemo(() => (s: ScheduleSection) => conflictsWith(s, othersForPrimary), [othersForPrimary]);
  const clashFns = useMemo(() => {
    const out: Record<string, (s: ScheduleSection) => Block[]> = {};
    if (!resolved.cls) return out;
    for (const comp of componentsOf(resolved.cls)) {
      const current = resolved.picks[comp];
      const others = blocks.filter((b) => !(b.course === course && current && b.classNumber === current.classNumber && b.section === current.section));
      out[comp] = (s) => conflictsWith(s, others);
    }
    return out;
  }, [blocks, course, resolved]);

  const pickPrimary = (s: ScheduleSection) => {
    if (s === resolved.primary) return;
    onSelect([s.classNumber]);
  };
  const pickSection = (comp: string, s: ScheduleSection) => {
    if (!resolved.primary) return;
    const rest = Object.entries(resolved.picks)
      .filter(([c, v]) => c !== comp && v)
      .map(([, v]) => v!.classNumber);
    onSelect([resolved.primary.classNumber, ...rest, s.classNumber]);
  };

  const primaries = useMemo(() => classes.map((c) => c.primary), [classes]);
  const primaryKind = componentName(resolved.primary?.component ?? primaries[0]?.component ?? "LEC");
  const data = entry.data;
  const body = () => {
    if (entry.phase === "loading" && !data) {
      return (
        <div className="space-y-2" aria-hidden>
          <div className="h-9 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-9 animate-pulse rounded-lg bg-slate-100" />
        </div>
      );
    }
    if (entry.phase === "error" && !data) {
      return (
        <p className="text-sm text-slate-600">
          Couldn&apos;t load times.{" "}
          <button type="button" onClick={props.onRetry} className="font-medium text-cal-blue underline hover:no-underline">
            Try again
          </button>
        </p>
      );
    }
    if (!classes.length) {
      return (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200">
          {data?.source === "none" && !data.live
            ? `No class times for ${termLabel(term)} yet.`
            : `Not listed for ${termLabel(term)}`}
        </p>
      );
    }
    return (
      <div className="space-y-3">
        <SectionGroup
          kind={primaryKind}
          options={primaries}
          selected={resolved.primary}
          clashesFor={primaryClashes}
          onPick={pickPrimary}
          onPreview={onPreview}
          showInstructor
          openSignal={focus && resolved.primary?.component === focus.component ? focus.nonce : undefined}
          locked={locked}
        />
        {resolved.primary && <ReservedNote primary={resolved.primary} />}
        {resolved.cls ? (
          componentsOf(resolved.cls).map((comp) => (
            <SectionGroup
              key={comp}
              kind={componentName(comp)}
              options={sectionsOf(resolved.cls!, comp)}
              selected={resolved.picks[comp]}
              clashesFor={clashFns[comp]}
              onPick={(s) => pickSection(comp, s)}
              onPreview={onPreview}
              showInstructor
              openSignal={focus?.component === comp ? focus.nonce : undefined}
              locked={locked}
            />
          ))
        ) : (
          <p className="text-xs text-slate-500">Pick {article(primaryKind)} {primaryKind} first.</p>
        )}
      </div>
    );
  };

  return (
    <section
      ref={ref}
      aria-label={course}
      className={`scroll-mt-3 rounded-2xl border-l-4 bg-white shadow-sm ring-1 transition ${color.edge} ${flash ? "ring-2 ring-cal-gold" : "ring-slate-200"}`}
    >
      <header className="flex items-start gap-2 px-3 pt-2.5">
        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${color.dot}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {props.onOpenCourse ? (
              <button type="button" onClick={props.onOpenCourse} className="truncate text-sm font-semibold text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue">
                {course}
              </button>
            ) : (
              <h3 className="truncate text-sm font-semibold text-slate-900">{course}</h3>
            )}
            {units != null && <span className="shrink-0 text-xs text-slate-500">{units} units</span>}
          </div>
          {(title ?? resolved.cls?.title) && <p className="truncate text-xs text-slate-500">{title ?? resolved.cls?.title}</p>}
          {status && (
            <p className={`mt-0.5 flex items-center gap-1 text-[11px] ${status.tone === "warn" ? "text-amber-700" : status.tone === "ok" ? "text-emerald-700" : "text-slate-500"}`} aria-live="polite">
              {status.busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              {status.text}
            </p>
          )}
        </div>
        {classes.length > 0 && (
          <button
            type="button"
            onClick={props.onToggleLock}
            aria-pressed={locked}
            title={locked ? "Locked. Find a schedule keeps these times." : "Lock times"}
            aria-label={locked ? `Unlock ${course}` : `Lock the times for ${course}`}
            className={`rounded-lg p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue ${locked ? "bg-cal-gold-100 text-cal-blue" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"}`}
          >
            {locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={props.onRemove}
          aria-label={`Remove ${course} from ${termLabel(term)}`}
          title="Remove from this semester"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="px-3 pb-3 pt-2">{body()}</div>
    </section>
  );
}
