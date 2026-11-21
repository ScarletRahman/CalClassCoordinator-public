"use client";

import { createContext, useContext, useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleDashed, Clock, ExternalLink, Hourglass, Info, Layers, Plus, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { collapseFamilies, siblingText, type FamilyEntry } from "@/lib/crossList";
import { squash } from "@/lib/majorSearch";
import {
  claimedCourses,
  creditHints,
  familyKeyOf,
  isProgramKind,
  matchesFilter,
  type ChoiceResult,
  type GroupResult,
  type OverlapEntry,
  type OverlapResult,
  type RequirementResult,
  type RuleResult,
  type StudentCourse,
} from "@/lib/requirements";
import { usePlanner } from "@/lib/store";
import { termLabel } from "@/lib/terms";
import { planDataFor, type PlanData } from "@/lib/usePlanData";
import { usePref } from "@/lib/usePref";
import type { Course, CourseFilter, CourseId, Term } from "@/lib/types";

const KIND_LABEL: Record<string, string> = {
  major: "Major",
  "joint-major": "Joint major",
  "dual-degree": "Dual degree",
  "simultaneous-degree": "Simultaneous degree",
  minor: "Minor",
  certificate: "Certificate",
  college: "College and breadth",
  university: "University",
};

function kindLabel(kind: string): string {
  if (KIND_LABEL[kind]) return KIND_LABEL[kind];
  const s = kind.replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Requirements";
}

/** Accent per kind so a card reads as "a program" and its sections read as parts of it. */
function kindTone(kind: string): { bar: string; eyebrow: string } {
  if (kind === "college" || kind === "university") return { bar: "bg-slate-300", eyebrow: "text-slate-600" };
  if (kind === "minor" || kind === "certificate") return { bar: "bg-cal-gold", eyebrow: "text-amber-800" };
  return { bar: "bg-cal-blue", eyebrow: "text-cal-blue" };
}

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue focus-visible:ring-offset-1";

// One vocabulary for where a class stands, used on every row, chip and legend.
type Phase = "done" | "progress" | "planned";
const phaseOf = (s: Pick<StudentCourse, "status" | "inProgress">): Phase => (s.status === "taken" ? "done" : s.inProgress ? "progress" : "planned");
const PHASE: Record<Phase, { label: string; text: string; dot: string; row: string }> = {
  done: { label: "Done", text: "text-emerald-700", dot: "bg-emerald-500 text-white", row: "bg-emerald-50/70 ring-emerald-200 hover:bg-emerald-50" },
  progress: { label: "In progress", text: "text-amber-800", dot: "bg-cal-gold text-cal-blue", row: "bg-amber-50/80 ring-amber-200 hover:bg-amber-50" },
  planned: { label: "Planned", text: "text-cal-blue", dot: "bg-cal-blue text-white", row: "bg-blue-50/70 ring-blue-200 hover:bg-blue-50" },
};

function PhaseDot({ phase, size = "h-5 w-5" }: { phase: Phase; size?: string }) {
  const Icon = phase === "done" ? Check : phase === "progress" ? Hourglass : Clock;
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-full ${PHASE[phase].dot}`} aria-hidden>
      <Icon className="h-3 w-3" strokeWidth={3} />
    </span>
  );
}

/** A met requirement is done, in progress (resting on a class being taken now) or planned. */
function requirementPhase(r: RuleResult): Phase | null {
  if (r.completed) return "done";
  if (!r.satisfied) return null;
  const pending = claimedCourses(r).filter((u) => u.status !== "taken");
  return pending.length > 0 && pending.every((u) => u.inProgress) ? "progress" : "planned";
}

interface UsedBy {
  key: string;
  title: string;
  groupId: string;
}

interface Ctx {
  idx: Map<CourseId, Course>;
  /** Family key -> the student's taken or planned class. */
  held: Map<CourseId, StudentCourse>;
  /** Family key -> the requirements that count it. */
  usedBy: Map<CourseId, UsedBy[]>;
  credits: { course: string; label?: string }[];
  overlap: OverlapResult | null;
  showOverlap: boolean;
  labels: Record<string, string>;
  onAdd: (course: string) => void;
  onOpenCourse: (course: string) => void;
  onToggleManual: (key: string) => void;
}
const ChecklistContext = createContext<Ctx | null>(null);
const useCtx = () => useContext(ChecklistContext)!;
/** Which requirement a class row sits in, so it can say "counts for <another row>". */
const RowContext = createContext<{ key: string; groupId: string } | null>(null);

const plural = (n: number, one: string, many = `${one}es`) => `${n} ${n === 1 ? one : many}`;
const classes = (n: number) => plural(n, "class");
const fmtUnits = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const BREADTHS = new Set(["Arts & Literature", "Biological Science", "Historical Studies", "International Studies", "Philosophy & Values", "Physical Science", "Social & Behavioral Sciences"]);
const meetsText = (names: string[]) => names.map((n) => (BREADTHS.has(n) ? `${n} breadth` : n)).join(", ");

// ---------- small pieces ----------

function StatusIcon({ r, size = "h-5 w-5" }: { r: RuleResult; size?: string }) {
  const phase = requirementPhase(r);
  if (phase) return <PhaseDot phase={phase} size={size} />;
  if (r.progress > 0)
    return (
      <span
        className={`block ${size} shrink-0 rounded-full ring-2 ring-inset ring-slate-400`}
        style={{ background: `conic-gradient(#94a3b8 ${Math.max(0.12, r.progress) * 360}deg, transparent 0)` }}
        aria-hidden
      />
    );
  return <CircleDashed className={`${size} shrink-0 text-slate-400`} aria-hidden />;
}

/** The number is what is finished; the second arc is what is in progress or planned. */
function Ring({ done, met, total }: { done: number; met: number; total: number }) {
  const pct = total ? met / total : 0;
  const donePct = total ? done / total : 0;
  return (
    <span
      className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full"
      style={{ background: `conic-gradient(#10b981 ${donePct * 360}deg, #002676 ${donePct * 360}deg ${pct * 360}deg, #e2e8f0 0)` }}
      aria-hidden
    >
      <span className="grid h-8 w-8 place-items-center rounded-full bg-white text-[10px] font-semibold tabular-nums text-slate-700">
        {done}/{total}
      </span>
    </span>
  );
}

/** Catalog notes arrive as raw text, often a long "- item" list. Show them as tidy, clamped prose. */
function Notes({ text, clampAt = 4, className = "" }: { text: string; clampAt?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const blocks = useMemo(() => {
    const out: ({ type: "p"; text: string } | { type: "ul"; items: string[] })[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const bullet = line.match(/^(?:[-*•–]|\d+[.)])\s+(.*)$/);
      const last = out[out.length - 1];
      if (bullet) {
        if (last?.type === "ul") last.items.push(bullet[1]);
        else out.push({ type: "ul", items: [bullet[1]] });
      } else out.push({ type: "p", text: line });
    }
    return out;
  }, [text]);
  const lineCount = blocks.reduce((a, b) => a + (b.type === "ul" ? b.items.length : Math.max(1, Math.ceil(b.text.length / 70))), 0);
  const long = lineCount > clampAt + 1;
  let budget = open || !long ? Infinity : clampAt;
  return (
    <div className={`text-xs leading-relaxed text-slate-600 ${className}`}>
      {blocks.map((b, i) => {
        if (budget <= 0) return null;
        if (b.type === "p") {
          const lines = Math.max(1, Math.ceil(b.text.length / 70));
          const cut = lines > budget ? `${b.text.slice(0, Math.max(60, budget * 70)).replace(/\s+\S*$/, "")}…` : b.text;
          budget -= lines;
          return (
            <p key={i} className={i ? "mt-1" : ""}>
              {cut}
            </p>
          );
        }
        const items = b.items.slice(0, budget);
        budget -= items.length;
        return (
          <ul key={i} className={`list-disc space-y-0.5 pl-4 marker:text-slate-400 ${i ? "mt-1" : ""}`}>
            {items.map((it, j) => (
              <li key={j}>{it}</li>
            ))}
          </ul>
        );
      })}
      {long && (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`-ml-1 inline-flex min-h-10 items-center rounded-md px-1 text-xs font-semibold text-cal-blue hover:underline ${FOCUS}`}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** A stack icon and the number of programs (the names are in the tooltip): the class counts (or could count) for two or more of the student's programs. */
function OverlapBadge({ entry }: { entry: OverlapEntry }) {
  const { labels } = useCtx();
  if (entry.programs.length < 2) return null;
  const names = entry.programs.map((g) => labels[g] ?? g);
  const detail = `${entry.status ? "Counts" : "Could count"} for ${names.join(" and ")}`;
  return (
    <span title={detail} className="inline-flex max-w-full items-center gap-1 rounded-full bg-cal-gold-100 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-cal-blue ring-1 ring-cal-gold">
      <Layers className="h-3 w-3 shrink-0" aria-hidden />
      <span aria-hidden>{names.length}</span>
      <span className="sr-only">{detail}</span>
    </span>
  );
}

/**
 * One class: a wide, obviously clickable row that opens the class details, plus a separate
 * "Add" button. Cross-listed and renumbered twins are a single row.
 */
function CourseRow({ entry, usedHere, note, compact }: { entry: FamilyEntry; usedHere?: StudentCourse; note?: string; compact?: boolean }) {
  const { idx, held, usedBy, overlap, onAdd, onOpenCourse } = useCtx();
  const row = useContext(RowContext);
  const rec = idx.get(entry.id);
  const fam = familyKeyOf(entry.id, idx);
  const mine = usedHere ?? held.get(fam);
  const badge = !compact ? overlap?.byCourse.get(entry.id) : undefined;
  const units = rec ? (Array.isArray(rec.units) ? (rec.units[0] === rec.units[1] ? `${rec.units[0]}` : `${rec.units[0]}-${rec.units[1]}`) : `${rec.units}`) : null;
  const unitsText = units ? `${units} ${units === "1" ? "unit" : "units"}` : null;
  const where = mine?.term ? termLabel(mine.term) : null;
  const phase = mine ? phaseOf(mine) : null;
  // Only claim "counts for X" when another row really uses the class, and name that row.
  const others = (usedBy.get(fam) ?? []).filter((u) => u.key !== row?.key);
  const other = others.find((u) => u.groupId === row?.groupId) ?? others[0];
  const statusText = !mine
    ? null
    : usedHere
      ? `${PHASE[phase!].label}${where ? `, ${where}` : ""}`
      : `${phase === "done" ? "Taken" : PHASE[phase!].label}${where ? ` ${where}` : ""}${other ? `, counts for ${other.title}` : ""}`;
  const tone = !mine ? "bg-white ring-slate-200 hover:bg-slate-50 hover:ring-slate-300" : !usedHere ? "bg-slate-50 ring-slate-200 hover:bg-slate-100" : PHASE[phase!].row;
  const siblings = siblingText(entry.id, idx);
  return (
    <div className="flex items-stretch gap-1.5">
      <button onClick={() => onOpenCourse(entry.id)} className={`group flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left ring-1 transition-colors ${tone} ${FOCUS}`}>
        {mine && usedHere && <PhaseDot phase={phase!} />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="whitespace-nowrap text-sm font-semibold text-slate-900">{entry.id}</span>
            {unitsText && <span className="whitespace-nowrap text-xs tabular-nums text-slate-600">{unitsText}</span>}
          </span>
          {rec?.title && <span className={`block text-xs text-slate-600 ${compact ? "truncate" : "line-clamp-2"}`}>{rec.title}</span>}
          {siblings && !compact && <span className="block text-[11px] text-slate-600">{siblings}</span>}
          {statusText && <span className={`block text-[11px] font-medium ${usedHere ? PHASE[phase!].text : "text-slate-600"}`}>{statusText}</span>}
          {note && <span className="block text-[11px] text-slate-600">{note}</span>}
          {badge && badge.programs.length >= 2 && (
            <span className="mt-1 block">
              <OverlapBadge entry={badge} />
            </span>
          )}
          {badge && badge.breadth.length > 0 && (
            <span className="block text-[11px] italic text-slate-600">
              {badge.status ? "Also meets" : "Would also meet"} {meetsText(badge.breadth)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-xs font-semibold text-cal-blue group-hover:underline">
          Details
          <ChevronRight className="h-4 w-4" aria-hidden />
        </span>
      </button>
      {!mine && (
        <button
          onClick={() => onAdd(entry.id)}
          aria-label={`Add ${entry.id} to your plan`}
          className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl bg-white px-3 text-xs font-semibold text-cal-blue ring-1 ring-slate-200 transition-colors hover:bg-cal-gold-100 hover:ring-cal-gold ${FOCUS}`}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add
        </button>
      )}
    </div>
  );
}

/** A list of classes with cross-listed families collapsed, an in-place filter and "Show all". */
function CourseList({
  ids,
  used = [],
  initial = 6,
  label,
  notes,
  compact,
}: {
  ids: CourseId[];
  used?: StudentCourse[];
  initial?: number;
  label: string;
  notes?: (e: OverlapEntry | undefined, id: CourseId) => string | undefined;
  compact?: boolean;
}) {
  const { idx, held, overlap } = useCtx();
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const usedByFam = useMemo(() => new Map(used.map((u) => [familyKeyOf(u.id, idx), u])), [used, idx]);
  const entries = useMemo(
    () =>
      collapseFamilies(ids, idx, (members) => {
        const k = familyKeyOf(members[0], idx);
        return usedByFam.get(k)?.id ?? held.get(k)?.id;
      }),
    [ids, idx, held, usedByFam],
  );
  const needle = squash(q);
  const shown = needle ? entries.filter((e) => [e.id, ...e.also, idx.get(e.id)?.title ?? ""].some((t) => squash(t).includes(needle))) : entries;
  // One or two extra rows are shown outright rather than hidden behind a button.
  const slack = compact ? 0 : 2;
  const limit = all || needle ? 60 : shown.length <= initial + slack ? shown.length : initial;
  const visible = shown.slice(0, limit);
  const hidden = shown.length - visible.length;
  return (
    <div className="space-y-1.5">
      {entries.length > 8 && (all || !compact) && (
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Filter these ${entries.length} classes`}
            aria-label={`Filter ${label}`}
            className="h-10 w-full rounded-xl border-0 bg-slate-50 pl-8 pr-3 text-sm ring-1 ring-slate-200 placeholder:text-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-cal-blue"
          />
        </label>
      )}
      <ul className="space-y-1.5" aria-label={label}>
        {visible.map((e) => (
          <li key={e.id}>
            <CourseRow entry={e} usedHere={usedByFam.get(familyKeyOf(e.id, idx))} note={notes?.(overlap?.byCourse.get(e.id), e.id)} compact={compact} />
          </li>
        ))}
      </ul>
      {needle && shown.length === 0 && <p className="px-1 py-1 text-xs text-slate-600">No class in this list matches &ldquo;{q.trim()}&rdquo;.</p>}
      {hidden > 0 &&
        (all || needle ? (
          <p className="px-1 text-xs text-slate-600">
            Showing {visible.length} of {shown.length}. Type in the filter to narrow it down.
          </p>
        ) : (
          <button
            onClick={() => setAll(true)}
            className={`inline-flex min-h-10 w-full items-center justify-center gap-1 rounded-xl bg-white px-3 text-xs font-semibold text-cal-blue ring-1 ring-slate-200 hover:bg-slate-50 ${FOCUS}`}
          >
            Show all {shown.length} classes
            <ChevronDown className="h-4 w-4" aria-hidden />
          </button>
        ))}
      {all && !needle && entries.length > initial + slack && (
        <button onClick={() => setAll(false)} className={`inline-flex min-h-10 items-center rounded-md px-1 text-xs font-semibold text-slate-600 hover:text-slate-900 ${FOCUS}`}>
          Show fewer
        </button>
      )}
    </div>
  );
}

const hasConstraint = (f?: CourseFilter) => !!f && !!(f.subjects?.length || f.breadth || f.attribute || f.minNumber != null || f.maxNumber != null);

/** "Browse matching classes" for rules given as a description (a breadth area, a subject range). */
function BrowseMatching({ filter, label }: { filter: CourseFilter; label: string }) {
  const { idx, held } = useCtx();
  const [open, setOpen] = useState(false);
  const ids = useMemo(() => {
    if (!open) return [];
    const seen = new Set<Course>();
    const out: CourseId[] = [];
    for (const c of idx.values()) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (!c.retired && matchesFilter(c.id, filter, idx) && !held.has(familyKeyOf(c.id, idx))) out.push(c.id);
    }
    // Classes students actually take first, when the data says which those are.
    return out.sort((a, b) => (idx.get(b)?.popularity ?? 0) - (idx.get(a)?.popularity ?? 0));
  }, [open, idx, filter, held]);
  if (!idx.size) return null;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-white px-3 text-xs font-semibold text-cal-blue ring-1 ring-slate-200 hover:bg-slate-50 ${FOCUS}`}
      >
        <Search className="h-3.5 w-3.5" aria-hidden />
        {open ? "Hide matching classes" : "Browse matching classes"}
      </button>
      {open && (
        <div className="mt-2">
          {ids.length ? (
            <>
              <p className="mb-1.5 text-xs text-slate-600">{classes(collapseFamilies(ids, idx).length)} in the catalog would count. Not all are offered every term.</p>
              <CourseList ids={ids} label={`classes matching ${label}`} initial={8} />
            </>
          ) : (
            <p className="text-xs text-slate-600">We could not find matching classes in the catalog. Check the official requirements.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** "57 done + 25 planned of 120 units", with a bar that shows the two parts. */
function Meter({ r }: { r: RuleResult }) {
  const need = r.need ?? 0;
  const have = r.have ?? 0;
  const done = Math.min(r.haveDone ?? have, have);
  const unit = r.unit === "units" ? "units" : "classes";
  const w = (n: number) => `${need ? Math.min(100, (n / need) * 100) : 0}%`;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={need} aria-valuenow={Math.min(have, need)}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-cal-blue/50" style={{ width: w(have) }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: w(done) }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-slate-700">{splitText(r)} {unit}</span>
    </div>
  );
}

/** "57 done + 25 planned of 120" when part is only planned, else "36 of 120". */
function splitText(r: RuleResult): string {
  const need = r.need ?? 0;
  const have = r.have ?? 0;
  const done = Math.min(r.haveDone ?? have, have);
  return have > done ? `${fmtUnits(done)} done + ${fmtUnits(have - done)} planned of ${fmtUnits(need)}` : `${fmtUnits(have)} of ${fmtUnits(need)}`;
}

// ---------- the opened requirement, in plain language ----------

const isCourseLeaf = (r: RuleResult) => r.kind === "course" && !!r.course;

/**
 * The ids behind a rule that is really one class: a plain course, or a "one of" whose options
 * are all the same cross-listed class (DATA C100 or STAT C100 or COMPSCI C100).
 */
function oneClass(r: RuleResult, idx: Map<CourseId, Course>): CourseId[] | null {
  if (isCourseLeaf(r)) return [r.course!];
  if (r.kind === "anyOf" && r.children?.length && r.children.every(isCourseLeaf)) {
    const ids = r.children.map((k) => k.course!);
    if (collapseFamilies(ids, idx).length === 1) return ids;
  }
  return null;
}

function Heading({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <p className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-slate-800">
      {children}
      {extra && <span className="text-xs font-normal text-slate-600">{extra}</span>}
    </p>
  );
}

function ManualRule({ r, reqKey }: { r: RuleResult; reqKey: string }) {
  const { onToggleManual } = useCtx();
  const [first, ...lines] = r.label.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // When the prose is just a list of classes, the class list below says it better.
  const mentioned = (r.candidates ?? []).map(squash);
  const listy = mentioned.length > 0 && lines.filter((l) => mentioned.some((m) => squash(l).startsWith(m))).length >= lines.length / 2;
  const rest = listy ? [] : lines;
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={`flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2.5 ring-1 transition-colors ${r.satisfied ? "bg-emerald-50/70 ring-emerald-200" : "bg-white ring-slate-200 hover:bg-slate-50"}`}>
        <input id={id} type="checkbox" checked={r.satisfied} onChange={() => onToggleManual(reqKey)} className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 accent-[#059669]" />
        <span className="min-w-0 text-sm text-slate-800">
          <span className="block font-medium">{r.satisfied ? "You marked this done" : "Check this off yourself when it is done"}</span>
          {first && <span className="mt-0.5 block text-xs text-slate-600">{first.replace(/:$/, "")}</span>}
        </span>
      </label>
      {rest.length > 0 && <Notes text={rest.join("\n")} clampAt={3} className="mt-1.5 px-1" />}
      {(r.candidates?.length ?? 0) > 0 && (
        <div className="mt-2.5">
          <Heading extra={listy ? undefined : "for reference"}>{listy ? "Classes on the list" : "Classes this requirement mentions"}</Heading>
          <CourseList ids={r.candidates!} label="classes this requirement mentions" initial={5} />
        </div>
      )}
    </div>
  );
}

function RuleBody({ r, reqKey, depth }: { r: RuleResult; reqKey: string; depth: number }) {
  const { idx } = useCtx();
  if (r.manual) return <ManualRule r={r} reqKey={reqKey} />;
  if (isCourseLeaf(r)) return <CourseList ids={[r.course!]} used={r.used} label={r.course!} />;

  if (r.children) {
    const kids = r.children;
    const soFar = r.need && r.need > 1 && (r.have ?? 0) > 0 && !r.satisfied ? `${r.have} of ${r.need} so far` : undefined;
    const singles = kids.map((k) => oneClass(k, idx));
    if (singles.every((x) => x)) {
      const ids = singles.flatMap((x) => x!);
      const count = collapseFamilies(ids, idx).length;
      const used = kids.flatMap((k) => k.used);
      const heading = count <= 1 ? null : r.kind === "anyOf" ? (count === 2 ? "Take either one" : "Take one of these") : r.kind === "nOf" ? `Take ${r.need} of these ${count}` : "Take all of these";
      return (
        <div>
          {heading && <Heading extra={soFar}>{heading}</Heading>}
          <CourseList ids={ids} used={used} label={heading ?? ids[0]} />
        </div>
      );
    }
    // Mixed: some options are themselves combinations or named bins. Loose classes are grouped,
    // and each combination gets a quiet panel carrying the catalog's name for it.
    const blocks: ({ type: "courses"; items: RuleResult[] } | { type: "rule"; item: RuleResult; index: number })[] = [];
    kids.forEach((k, i) => {
      const last = blocks[blocks.length - 1];
      if (singles[i] && !k.name) {
        if (last?.type === "courses") last.items.push(k);
        else blocks.push({ type: "courses", items: [k] });
      } else blocks.push({ type: "rule", item: k, index: i });
    });
    const named = kids.some((k) => k.name);
    const noun = named ? "groups" : "options";
    const heading =
      r.kind === "anyOf" ? `Choose one of these ${noun}` : r.kind === "nOf" ? `Complete ${r.need} of these ${kids.length} ${noun}` : named ? "Complete each of these" : "Complete all of these";
    const joiner = r.kind === "anyOf" ? "or" : null;
    const panel = depth % 2 === 0 ? "bg-slate-50 ring-1 ring-slate-200/70" : "bg-white ring-1 ring-slate-200";
    return (
      <div>
        <Heading extra={soFar}>{heading}</Heading>
        <div className="space-y-2">
          {blocks.map((b, bi) => (
            <div key={bi}>
              {bi > 0 && joiner && (
                <p className="mb-2 flex items-center gap-2 text-[11px] font-medium text-slate-500" aria-hidden>
                  <span className="h-px flex-1 bg-slate-200" />
                  {joiner}
                  <span className="h-px flex-1 bg-slate-200" />
                </p>
              )}
              {b.type === "courses" ? (
                <CourseList ids={b.items.flatMap((k) => oneClass(k, idx) ?? [])} used={b.items.flatMap((k) => k.used)} label={heading} />
              ) : (
                <div className={`rounded-xl p-2.5 ${panel}`}>
                  {b.item.name && (
                    <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-slate-900">
                      {b.item.chosen !== false && b.item.satisfied && <PhaseDot phase={requirementPhase(b.item) ?? "planned"} size="h-4 w-4" />}
                      {b.item.name}
                    </p>
                  )}
                  <RuleBody r={b.item} reqKey={`${reqKey}.${b.index}`} depth={depth + 1} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // filter / units
  const listed = r.filter?.courses?.length ? r.filter.courses : null;
  const isUnits = r.unit === "units";
  const need = r.need ?? 0;
  const usedIds = r.used.filter((u) => !u.credit).map((u) => u.id);
  const listIds = listed ? [...usedIds, ...(r.candidates ?? [])] : [];
  const heading = listed
    ? isUnits
      ? `Take ${fmtUnits(need)} units from this list`
      : `Take ${need === 1 ? "one class" : classes(need)} from this list`
    : `Take ${r.label}`;
  const creditUnits = r.used.filter((u) => u.credit).reduce((a, u) => a + u.units, 0);
  // A whole-degree unit total counts nearly every class; listing them all here is noise.
  const showUsed = r.kind !== "units" || usedIds.length <= 6;
  return (
    <div>
      <Heading extra={listed ? `${classes(collapseFamilies(listIds, idx).length)} on it` : undefined}>{heading}</Heading>
      {(isUnits || need > 1) && need > 0 && (
        <div className="mb-2">
          <Meter r={r} />
        </div>
      )}
      {listed ? (
        <CourseList ids={listIds} used={r.used} label={heading} />
      ) : (
        <div className="space-y-2">
          {showUsed && usedIds.length > 0 && <CourseList ids={usedIds} used={r.used} label="classes counting here" />}
          {!showUsed && (
            <p className="text-xs text-slate-600">
              Counting {classes(usedIds.length)} from your plan{creditUnits > 0 ? ` and ${fmtUnits(creditUnits)} units of test credit` : ""}.
            </p>
          )}
          {!r.satisfied && hasConstraint(r.filter) && <BrowseMatching filter={r.filter!} label={r.label} />}
        </div>
      )}
    </div>
  );
}

// ---------- collapsed requirement row ----------

/** What is still needed, in a few words, for the collapsed row. */
function needText(r: RuleResult, idx: Map<CourseId, Course>): string {
  if (r.manual) return "Check this off yourself";
  if (isCourseLeaf(r)) return r.course!;
  if (r.children) {
    const n = r.children.length;
    const singles = r.children.map((k) => oneClass(k, idx));
    if (singles.every((x) => x)) {
      const entries = collapseFamilies(singles.flatMap((x) => x!), idx);
      if (entries.length === 1) return entries[0].id;
      if (r.kind === "anyOf") return entries.length <= 3 ? entries.map((e) => e.id).join(" or ") : `One of ${entries.length} classes`;
      if (r.kind === "nOf") return `${r.need} of ${entries.length} classes`;
      return entries.length <= 3 ? entries.map((e) => e.id).join(" and ") : `All ${entries.length} classes`;
    }
    const noun = r.children.some((k) => k.name) ? "groups" : "options";
    if (r.kind === "anyOf") return `One of ${n} ${noun}`;
    if (r.kind === "nOf") return `${r.need} of ${n} ${noun}`;
    return (r.have ?? 0) > 0 ? "" : `All ${n} parts`;
  }
  return r.label ? r.label[0].toUpperCase() + r.label.slice(1) : "";
}

/** Leaves on the path being counted (the unchosen side of a "one of" is left out). */
function countedLeaves(r: RuleResult): RuleResult[] {
  if (!r.children) return [r];
  const picked = r.children.filter((c) => c.chosen !== false);
  return (picked.length ? picked : r.children).flatMap(countedLeaves);
}

/**
 * Honest progress for an unmet requirement: a count when there is something to count
 * ("36 of 120 units"), and separately how many self-check boxes are left, instead of a
 * percentage that averages the two.
 */
function progressOf(r: RuleResult): { fraction?: string; split?: string; confirm: number } {
  if (r.satisfied) return { confirm: 0 };
  const leaves = countedLeaves(r);
  const confirm = r.manual ? 0 : leaves.filter((l) => l.manual && !l.satisfied).length;
  const countable = leaves.filter((l) => !l.manual && l.need && l.unit !== "options" && (l.need > 1 || l.unit === "units"));
  const c = !r.children && r.need && r.unit !== "options" ? r : countable.length === 1 ? countable[0] : null;
  if (c && (c.need! > 1 || c.unit === "units")) {
    const have = c.have ?? 0;
    const done = Math.min(c.haveDone ?? have, have);
    return {
      fraction: `${fmtUnits(have)} of ${fmtUnits(c.need!)}${c.unit === "units" ? " units" : ""}`,
      split: have > done && done > 0 ? `${fmtUnits(done)} done + ${fmtUnits(have - done)} planned` : undefined,
      confirm,
    };
  }
  if (r.need && r.need > 1 && (r.have ?? 0) > 0) return { fraction: `${r.have} of ${r.need}`, confirm };
  return { fraction: !confirm && r.progress > 0 ? `${Math.round(r.progress * 100)}%` : undefined, confirm };
}

/** The classes counting for a requirement, each a real button that opens its details. */
function UsedChips({ r, badges, rowPhase }: { r: RuleResult; badges: boolean; rowPhase?: Phase | null }) {
  const { idx, overlap, onOpenCourse } = useCtx();
  const used = useMemo(() => {
    const seen = new Set<CourseId>();
    return claimedCourses(r).filter((u) => {
      const k = familyKeyOf(u.id, idx);
      if (u.credit || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [r, idx]);
  if (!used.length) return null;
  const shown = used.slice(0, 3);
  return (
    <>
      {shown.map((u) => {
        const phase = phaseOf(u);
        const Icon = phase === "done" ? Check : phase === "progress" ? Hourglass : Clock;
        const e = badges ? overlap?.byCourse.get(u.id) : undefined;
        return (
          <span key={u.id} className="inline-flex flex-wrap items-center gap-1">
            <button
              onClick={(ev) => {
                ev.stopPropagation();
                onOpenCourse(u.id);
              }}
              title={`Open ${u.id}`}
              className={`-my-2 inline-flex min-h-10 items-center gap-1 whitespace-nowrap rounded-md px-1 text-xs font-semibold underline decoration-dotted underline-offset-2 hover:decoration-solid ${PHASE[phase].text} ${FOCUS}`}
            >
              {u.id}
              {/* The row's own icon already gives the status; mark a chip only when it differs. */}
              {phase !== rowPhase && <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />}
              <span className="sr-only">{PHASE[phase].label}</span>
              {phase === "planned" && u.term && <span className="font-normal">{termLabel(u.term)}</span>}
            </button>
            {e && <OverlapBadge entry={e} />}
          </span>
        );
      })}
      {used.length > shown.length && <span className="text-xs text-slate-600">+{used.length - shown.length} more</span>}
    </>
  );
}

function RequirementRow({ req, group, divider, standalone }: { req: RequirementResult; group: GroupResult; divider: boolean; standalone?: boolean }) {
  const { idx, credits } = useCtx();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const r = req.result;
  const phase = requirementPhase(r);
  const prog = progressOf(r);
  const hints = useMemo(
    () => (r.satisfied || !credits.length ? [] : creditHints({ title: req.title, notes: req.notes, text: countedLeaves(r).filter((l) => l.manual).map((l) => l.label).join("\n") }, credits)),
    [r, req.title, req.notes, credits],
  );
  const canTick = !r.satisfied && countedLeaves(r).some((l) => l.manual && !l.satisfied);
  // "One of 5 classes" says nothing the chevron does not; name the classes only when there are few enough to name.
  const needRaw = r.satisfied ? "" : needText(r, idx);
  const need = /^(one|all|\d+) of \d+ |^all \d+ | approved classes$|^\d+(\.\d+)? units? from /i.test(needRaw) ? "" : needRaw;
  const hintBits = [
    need && squash(need) !== squash(req.title) && !((r.kind === "units" || r.kind === "allOf") && prog.fraction) ? need : "",
    prog.split ?? "",
    prog.confirm ? `${prog.fraction ? "and " : ""}${plural(prog.confirm, "thing", "things")} to confirm` : "",
  ].filter(Boolean);
  // Self-check rules often repeat their own text as the note; print it once.
  const notesRepeatRule = !!req.notes && !!r.manual && squash(req.notes).slice(0, 60) === squash(r.label).slice(0, 60);
  const metBy = r.satisfied && !r.manual ? claimedCourses(r).filter((u) => !u.credit).map((u) => u.id) : [];
  const rowCtx = useMemo(() => ({ key: req.key, groupId: group.group.id }), [req.key, group.group.id]);
  return (
    <li className={standalone ? "border-t-[6px] border-slate-100" : divider ? "border-t border-slate-100" : ""}>
      {/* The whole strip expands the row; the class chips inside are their own buttons. */}
      <div onClick={() => setOpen((o) => !o)} className="flex min-h-11 cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-slate-50">
        <span className="mt-px flex">
          <StatusIcon r={r} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen((o) => !o);
              }}
              aria-expanded={open}
              aria-controls={panelId}
              className={`rounded text-left text-sm font-medium text-slate-900 ${FOCUS}`}
            >
              {req.title}
            </button>
            <UsedChips r={r} badges={isProgramKind(group.group.kind)} rowPhase={phase} />
          </span>
          {hintBits.length > 0 && <span className="mt-0.5 block text-xs text-slate-600">{hintBits.join(" · ")}</span>}
          {hints.length > 0 && <span className="mt-0.5 block text-xs font-medium text-amber-800">You have {hints.join(" and ")} on record</span>}
        </span>
        <span className="mt-px flex shrink-0 items-center gap-1">
          {phase && <span className="sr-only">{PHASE[phase].label}</span>}
          {prog.fraction && <span className="text-xs tabular-nums text-slate-700">{prog.fraction}</span>}
          <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </span>
      </div>
      {open && (
        <div id={panelId} className="space-y-2.5 px-3 pb-3.5 pt-0.5">
          {hints.length > 0 && (
            <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-2.5 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {canTick
                ? `You have ${hints.join(" and ")} on record: tick the box below if it covers this.`
                : `You have ${hints.join(" and ")} on record. The catalog says it can count here; confirm with your advisor.`}
            </p>
          )}
          {metBy.length > 0 && (
            <p className="rounded-xl bg-emerald-50/70 px-2.5 py-2 text-xs text-emerald-900 ring-1 ring-emerald-200">
              Already met by {metBy.slice(0, 4).join(", ")}
              {metBy.length > 4 ? ` and ${metBy.length - 4} more` : ""}. Another class here would not count again.
            </p>
          )}
          {req.notes && !notesRepeatRule && <Notes text={req.notes} className="rounded-xl bg-slate-50 px-2.5 py-2" />}
          <RowContext.Provider value={rowCtx}>
            <RuleBody r={r} reqKey={req.key} depth={0} />
          </RowContext.Provider>
        </div>
      )}
    </li>
  );
}

// ---------- choices (emphasis, concentration, track) ----------

function ChoicePicker({ groupId, choice, onDone }: { groupId: string; choice: ChoiceResult; onDone?: () => void }) {
  const { dispatch } = usePlanner();
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  // A short list is shown whole, in catalog order with the best match first; no search, no scroller.
  const few = choice.options.length <= 8;
  const ranked = useMemo(
    () => choice.options.map((o, i) => ({ o, i })).sort((a, b) => b.o.progress - a.o.progress || b.o.satisfied - a.o.satisfied || a.i - b.i).map((x) => x.o),
    [choice.options],
  );
  const needle = squash(q);
  const matches = needle ? ranked.filter((o) => squash(o.title).includes(needle)) : ranked;
  const INITIAL = 5;
  const visible = few || all || needle ? matches : matches.slice(0, INITIAL);
  const pick = (id: string) => {
    const has = choice.chosen.includes(id);
    const next = choice.pick <= 1 ? (has ? [] : [id]) : has ? choice.chosen.filter((x) => x !== id) : [...choice.chosen, id].slice(-choice.pick);
    dispatch({ type: "setChoice", groupId, choiceId: choice.id, optionIds: next });
    if (choice.pick <= 1 || next.length >= choice.pick) onDone?.();
  };
  const noun = choice.title.toLowerCase();
  return (
    <div className="space-y-1.5">
      {!few && (
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${choice.options.length} options`}
            aria-label={`Search ${noun} options`}
            className="h-10 w-full rounded-xl border-0 bg-white pl-8 pr-3 text-sm ring-1 ring-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cal-blue"
          />
        </label>
      )}
      <ul className="space-y-1" aria-label={`${choice.title} options`}>
        {visible.map((o) => {
          const on = choice.chosen.includes(o.id);
          const best = o.id === choice.suggested;
          return (
            <li key={o.id}>
              <button
                onClick={() => pick(o.id)}
                aria-pressed={on}
                className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left ring-1 transition-colors ${
                  on ? "bg-cal-gold-100 ring-cal-gold" : "bg-white ring-slate-200 hover:bg-slate-50 hover:ring-slate-300"
                } ${FOCUS}`}
              >
                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ring-1 ${on ? "bg-cal-blue text-white ring-cal-blue" : "bg-white ring-slate-300"}`} aria-hidden>
                  {on && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-900">{o.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-600">
                    {o.total > 0 ? (
                      <>
                        <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-slate-200" aria-hidden>
                          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(o.progress * 100)}%` }} />
                        </span>
                        {o.progress > 0
                          ? o.satisfied === o.total
                            ? "Your classes already cover it"
                            : `Your classes cover ${Math.round(o.progress * 100)}%`
                          : `${plural(o.total, "requirement", "requirements")}, none started`}
                      </>
                    ) : (
                      "No extra classes"
                    )}
                  </span>
                </span>
                {best && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                    <Sparkles className="h-3 w-3" aria-hidden /> Best match
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {needle && matches.length === 0 && <p className="px-1 text-xs text-slate-600">No option matches &ldquo;{q.trim()}&rdquo;. Check the spelling.</p>}
      {matches.length > visible.length && (
        <button
          onClick={() => setAll(true)}
          className={`inline-flex min-h-10 w-full items-center justify-center gap-1 rounded-xl bg-white px-3 text-xs font-semibold text-cal-blue ring-1 ring-slate-200 hover:bg-slate-50 ${FOCUS}`}
        >
          Show all {matches.length} options <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

function PendingChoice({ groupId, choice, divider }: { groupId: string; choice: ChoiceResult; divider: boolean }) {
  const left = choice.pick - choice.chosen.length;
  const best = choice.options.find((o) => o.id === choice.suggested);
  const noun = choice.title.toLowerCase();
  return (
    <li className={`bg-cal-gold-100/50 px-3 py-3 ${divider ? "border-t border-slate-100" : ""}`}>
      <div className="flex items-start gap-2.5">
        <CircleDashed className="mt-px h-5 w-5 shrink-0 text-amber-700" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {choice.chosen.length ? `Choose ${left} more for your ${noun}` : choice.pick > 1 ? `Choose ${choice.pick} for your ${noun}` : `Choose your ${noun}`}
          </p>
          <p className="mt-0.5 text-xs text-slate-700">
            {best
              ? `Best fit so far: ${best.title}.`
              : "You can change it later."}
          </p>
        </div>
      </div>
      <div className="mt-2.5">
        <ChoicePicker groupId={groupId} choice={choice} />
      </div>
    </li>
  );
}

function OptionHeading({ groupId, choice, optionId, divider }: { groupId: string; choice: ChoiceResult; optionId: string; divider: boolean }) {
  const [changing, setChanging] = useState(false);
  const option = choice.options.find((o) => o.id === optionId);
  return (
    <li className={`bg-cal-gold-100/40 ${divider ? "border-t border-slate-100" : ""}`}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <h3 className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium text-slate-600">{choice.title}</span>
          <span className="block text-[13px] font-semibold text-slate-900">{option?.title ?? optionId}</span>
        </h3>
        <button
          onClick={() => setChanging((c) => !c)}
          aria-expanded={changing}
          aria-label={changing ? `Keep it: ${option?.title ?? "this option"}` : `Change ${choice.title.toLowerCase()}`}
          className={`inline-flex min-h-10 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-cal-blue hover:bg-white hover:ring-1 hover:ring-slate-200 ${FOCUS}`}
        >
          {changing ? (
            <>
              <X className="h-3.5 w-3.5" aria-hidden /> Keep it
            </>
          ) : (
            "Change"
          )}
        </button>
      </div>
      {changing && (
        <div className="border-t border-slate-200/70 px-3 py-2.5">
          <ChoicePicker groupId={groupId} choice={choice} onDone={() => setChanging(false)} />
        </div>
      )}
    </li>
  );
}

// ---------- classes that count for more than one program ----------

function OverlapPanel({ overlap }: { overlap: OverlapResult }) {
  const { labels } = useCtx();
  const open = true;
  const reqNote = (e: OverlapEntry | undefined) => {
    if (!e) return undefined;
    const bits = e.requirements.map((r) => {
      const where = `${r.title} (${labels[r.groupId] ?? r.groupId})`;
      if (r.selfCheck) return `${where}, once you check it off`;
      return r.need ? `${where}, ${r.have} of ${r.need} needed` : where;
    });
    const verb = e.status ? (e.requirements.some((r) => r.need) ? "Counts toward" : "Counts for") : "Would count for";
    return `${verb} ${[...new Set(bits)].join(" and ")}`;
  };
  return (
    <div className="border-t border-slate-100">
      {open && (
        <div className="space-y-3 px-3 pb-3.5">
          <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Majors cap how many classes can overlap, often two upper division. Check each department&apos;s rule.
          </p>
          <div>
            <Heading extra={overlap.counting.length ? classes(overlap.counting.length) : undefined}>Counting twice</Heading>
            {overlap.counting.length ? (
              <CourseList compact ids={overlap.counting.map((e) => e.id)} used={overlap.counting.map((e) => ({ id: e.id, status: e.status!, term: e.term, units: 0, inProgress: e.inProgress }))} label="classes already counting twice" initial={5} notes={reqNote} />
            ) : (
              <p className="text-xs text-slate-600">None yet.</p>
            )}
          </div>
          <div>
            <Heading extra={overlap.could.length ? `${classes(overlap.could.length)}, best value first` : undefined}>Could count twice</Heading>
            {overlap.could.length ? (
              <CourseList compact ids={overlap.could.map((e) => e.id)} label="classes that could count twice" initial={5} notes={reqNote} />
            ) : (
              <p className="text-xs text-slate-600">None right now.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const OVERLAP_PREF = "ccc.ui.showOverlap";

// ---------- the checklist ----------

type Row =
  | { type: "section"; key: string; title: string; done: number; total: number }
  | { type: "option"; key: string; choice: ChoiceResult; optionId: string }
  | { type: "pending"; key: string; choice: ChoiceResult }
  | { type: "req"; key: string; req: RequirementResult; standalone?: boolean };

/** Flatten a program into rows: headings, the chosen emphasis, "choose one" prompts, requirements. */
function buildRows(g: GroupResult): Row[] {
  const rows: Row[] = [];
  const reqs = g.requirements;
  const choiceById = new Map(g.choices.map((c) => [c.id, c]));
  const shownOptions = new Set<string>();
  // The section a row sits under: inside a chosen option, a section that only repeats the
  // option's own name is dropped (the option bar is the heading).
  const sectionOf = (r: RequirementResult | undefined) => {
    if (!r || r.optional) return undefined;
    const opt = r.choice ? choiceById.get(r.choice)?.options.find((o) => o.id === r.option) : undefined;
    if (!opt) return r.section;
    // Option sections read "<Option>: <Section>"; the option bar already says the first half.
    const own = r.section?.startsWith(`${opt.title}:`) ? r.section.slice(opt.title.length + 1).trim() : r.section;
    return !own || squash(own) === squash(opt.title) ? undefined : own;
  };
  const bar = (c: ChoiceResult, id: string) => {
    // One bar per chosen option, above the first place that option shows up.
    if (shownOptions.has(`${c.id}:${id}`)) return false;
    shownOptions.add(`${c.id}:${id}`);
    rows.push({ type: "option", key: `${c.key}:${id}`, choice: c, optionId: id });
    return true;
  };
  const extras = (at: number) => {
    for (const c of g.choices) {
      if (c.insertAt !== at) continue;
      // A chosen option with no requirements of its own still needs a bar so it can be changed.
      for (const id of c.chosen) if (!reqs.some((r) => r.choice === c.id && r.option === id)) bar(c, id);
      if (c.pending) rows.push({ type: "pending", key: c.key, choice: c });
    }
  };
  let current: string | undefined; // title of the section in effect
  reqs.forEach((req, i) => {
    extras(i);
    if (req.optional) return;
    const choice = req.choice ? choiceById.get(req.choice) : undefined;
    if (choice && req.option) bar(choice, req.option);
    const section = sectionOf(req);
    let standalone = false;
    if (section !== current) {
      if (section) {
        let end = i;
        while (end + 1 < reqs.length && sectionOf(reqs[end + 1]) === section) end++;
        const run = reqs.slice(i, end + 1).filter((x) => !x.optional);
        // A section holding one requirement of the same name would print the name twice: the
        // row stands in for its own heading, set apart so it does not read as part of the last one.
        if (run.length === 1 && squash(run[0].title) === squash(section)) standalone = rows.some((x) => x.type === "req" || x.type === "section");
        else rows.push({ type: "section", key: `s:${req.key}`, title: section, done: run.filter((x) => x.result.satisfied).length, total: run.length });
      } else if (current && !choice) standalone = true; // rows with no section after a named one
      current = section;
    }
    rows.push({ type: "req", key: req.key, req, standalone });
  });
  extras(reqs.length);
  return rows;
}

function GroupCard({ g }: { g: GroupResult }) {
  const [collapsed, setCollapsed] = usePref(`ccc.ui.group.${g.group.id}`, false);
  const [showOptional, setShowOptional] = useState(false);
  const rows = useMemo(() => buildRows(g), [g]);
  const optional = useMemo(() => g.requirements.filter((r) => r.optional), [g]);
  const tone = kindTone(g.group.kind);
  const counted = g.requirements.filter((r) => !r.optional);
  const inProgress = counted.filter((r) => requirementPhase(r.result) === "progress").length;
  const planned = g.satisfied - g.completed - inProgress;
  const left = g.total - g.satisfied;
  const source = Array.isArray(g.group.source) ? g.group.source[0] : g.group.source;
  const bodyId = useId();
  const optionalId = useId();
  // The ring already says how many are done; add only what it cannot show.
  const summary = [inProgress ? `${inProgress} in progress` : null, planned > 0 ? `${planned} planned` : null, left ? `${left} to go` : "All done"].filter(Boolean).join(" · ");
  return (
    <section className="relative overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200" aria-label={`${kindLabel(g.group.programType ?? g.group.kind)}: ${g.group.title}`}>
      <span className={`absolute inset-x-0 top-0 h-1 ${tone.bar}`} aria-hidden />
      <header className="flex items-center gap-1 pr-1.5 pt-1">
        <h2 className="min-w-0 flex-1">
          <button
            className={`flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-slate-50 ${FOCUS} focus-visible:ring-inset focus-visible:ring-offset-0`}
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
          >
            <Ring done={g.completed} met={g.satisfied} total={g.total} />
            <span className="min-w-0 flex-1">
              <span className={`block text-[11px] font-bold uppercase tracking-wider ${tone.eyebrow}`}>{kindLabel(g.group.programType ?? g.group.kind)}</span>
              <span className="block text-[15px] font-semibold leading-snug text-slate-900">{g.group.title}</span>
              <span className="block text-xs font-normal text-slate-600">{g.total ? summary : "Nothing to track here"}</span>
            </span>
            <ChevronDown className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${collapsed ? "-rotate-90" : ""}`} aria-hidden />
          </button>
        </h2>
        {source && (
          <a
            href={source}
            target="_blank"
            rel="noreferrer"
            title="Official requirements in the Berkeley catalog"
            aria-label={`Official requirements for ${g.group.title} (opens in a new tab)`}
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 ${FOCUS}`}
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        )}
      </header>
      {!collapsed && (
        <ul id={bodyId} className="border-t border-slate-100">
          {rows.map((row, i) => {
            const prev = rows[i - 1];
            const divider = i > 0;
            if (row.type === "section")
              return (
                <li key={row.key} className={`flex items-baseline gap-2 bg-slate-50 px-3 py-1.5 ${divider ? "border-t border-slate-100" : ""}`}>
                  <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-slate-700">{row.title}</h3>
                  <span className="shrink-0 text-[11px] tabular-nums text-slate-600">
                    {row.done} of {row.total}
                  </span>
                </li>
              );
            if (row.type === "option") return <OptionHeading key={row.key} groupId={g.group.id} choice={row.choice} optionId={row.optionId} divider={divider} />;
            if (row.type === "pending") return <PendingChoice key={row.key} groupId={g.group.id} choice={row.choice} divider={divider} />;
            return <RequirementRow key={row.key} req={row.req} group={g} standalone={row.standalone} divider={divider && prev?.type !== "section" && prev?.type !== "option"} />;
          })}
          {rows.length === 0 && optional.length === 0 && <li className="px-3 py-3 text-sm text-slate-600">No requirements listed for this program yet.</li>}
          {optional.length > 0 && (
            <li className="border-t-[6px] border-slate-100">
              <button
                onClick={() => setShowOptional((o) => !o)}
                aria-expanded={showOptional}
                aria-controls={optionalId}
                className={`flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-slate-50 ${FOCUS} focus-visible:ring-inset focus-visible:ring-offset-0`}
              >
                <span className="flex-1">
                  <span className="block text-[13px] font-semibold text-slate-700">Optional (honors and extras)</span>
                  <span className="block text-xs text-slate-600">{plural(optional.length, "item", "items")}, not counted in your totals</span>
                </span>
                <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${showOptional ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {showOptional && (
                <ul id={optionalId} className="border-t border-slate-100">
                  {optional.map((req, i) => (
                    <RequirementRow key={req.key} req={req} group={g} divider={i > 0} />
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export default function Checklist({
  groups,
  onAdd,
  onOpenCourse,
  onToggleManual,
  data,
  columns,
}: {
  /** Lay the programs out side by side on wide screens (the Requirements view). */
  columns?: boolean;
  groups: GroupResult[];
  nextTerm?: Term;
  onAdd: (course: string) => void;
  onOpenCourse: (course: string) => void;
  onToggleManual: (key: string) => void;
  /** Optional: the full plan data. Found automatically when `groups` came from usePlanData. */
  data?: PlanData;
}) {
  const plan = data ?? planDataFor(groups);
  const [showOverlap, setShowOverlap] = useState(false);
  useEffect(() => {
    try {
      setShowOverlap(localStorage.getItem(OVERLAP_PREF) === "1");
    } catch {
      /* private mode */
    }
  }, []);
  const toggleOverlap = () =>
    setShowOverlap((v) => {
      try {
        localStorage.setItem(OVERLAP_PREF, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });

  const ctx = useMemo<Ctx>(() => {
    const idx = plan?.courseIndex ?? new Map<CourseId, Course>();
    const held = new Map<CourseId, StudentCourse>();
    const usedBy = new Map<CourseId, UsedBy[]>();
    for (const g of groups) {
      for (const req of g.requirements) {
        for (const u of claimedCourses(req.result)) {
          const k = familyKeyOf(u.id, idx);
          const list = usedBy.get(k) ?? [];
          if (!list.some((x) => x.key === req.key)) list.push({ key: req.key, title: req.title, groupId: g.group.id });
          usedBy.set(k, list);
        }
      }
    }
    const students = plan?.students ?? groups.flatMap((g) => g.requirements.flatMap((r) => r.result.used));
    for (const s of students) {
      if (s.credit) continue;
      const k = familyKeyOf(s.id, idx);
      const cur = held.get(k);
      if (!cur || (cur.status !== "taken" && s.status === "taken")) held.set(k, s);
    }
    return { idx, held, usedBy, credits: plan?.credits ?? [], overlap: plan?.overlap ?? null, showOverlap, labels: plan?.programLabels ?? {}, onAdd, onOpenCourse, onToggleManual };
  }, [plan, groups, showOverlap, onAdd, onOpenCourse, onToggleManual]);

  const overlap = ctx.overlap && ctx.overlap.programs.length >= 2 ? ctx.overlap : null;
  const hasMinor = overlap?.programs.some((p) => p.kind === "minor");
  return (
    <ChecklistContext.Provider value={ctx}>
      <div className="space-y-3">
        {overlap && (
          <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200" aria-label="Classes that count for more than one program">
            <button
              type="button"
              onClick={toggleOverlap}
              aria-expanded={showOverlap}
              className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-medium text-slate-900 hover:bg-slate-50 ${FOCUS} focus-visible:ring-inset focus-visible:ring-offset-0`}
            >
              <Layers className="h-4 w-4 shrink-0 text-cal-blue" aria-hidden />
              <span className="flex-1">
                {overlap.counting.length} {overlap.counting.length === 1 ? "class counts" : "classes count"} for more than one {hasMinor ? "program" : "major"}
              </span>
              <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${showOverlap ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {showOverlap && <OverlapPanel overlap={overlap} />}
          </section>
        )}
        <div className={columns ? "grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3" : "space-y-3"}>
          {groups.map((g) => (
            <GroupCard key={g.group.id} g={g} />
          ))}
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-slate-600">
          {(["done", "progress", "planned"] as Phase[]).map((p) => (
            <span key={p} className="inline-flex items-center gap-1.5">
              <PhaseDot phase={p} size="h-3.5 w-3.5" /> {PHASE[p].label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="block h-3.5 w-3.5 rounded-full ring-2 ring-inset ring-slate-400" style={{ background: "conic-gradient(#94a3b8 150deg, transparent 0)" }} aria-hidden /> Partly met
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CircleDashed className="h-3.5 w-3.5 text-slate-500" aria-hidden /> Not started
          </span>
        </p>
      </div>
    </ChecklistContext.Provider>
  );
}
