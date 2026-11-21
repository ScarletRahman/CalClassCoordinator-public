"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, CalendarDays, Check, CloudOff, FileUp, Info, LayoutGrid, ListChecks, Loader2, Pencil, RotateCcw, Undo2, User, X } from "lucide-react";
import AccountMenu from "./AccountMenu";
import Checklist from "./Checklist";
import CourseDrawer from "./CourseDrawer";
import Onboarding from "./Onboarding";
import Phase1Picks from "./Phase1Picks";
import ScheduleBuilder from "./ScheduleBuilder";
import SemesterBoard from "./SemesterBoard";
import TermBar from "./TermBar";
import TermEditor from "./TermEditor";
import TranscriptImport from "./TranscriptImport";
import { alsoListedAs, registerCourseFamilies } from "@/lib/courseFamily";
import { courseUnits, registerSubjectAliases } from "@/lib/courseId";
import { waitRiskOf } from "@/lib/enrollPlan";
import { forecastState, gamePlanToday, instructorRangeNow, isoDay } from "@/lib/forecast";
import { forecastFor, makeAdvisor, type Advisor } from "@/lib/planLookups";
import { CREDIT, CREDIT_LABEL, addClassActions, buildTermEntries, defaultTermKey, findInPlan, unitsOutlook, type TermEntry, type TermKey } from "@/lib/planTerms";
import { fillRank } from "@/lib/professors";
import { alreadyMetBy } from "@/lib/requirements";
import { PlannerProvider, usePlanner, type Action } from "@/lib/store";
import { compareTerms, currentTerm, termLabel } from "@/lib/terms";
import { useDialog } from "@/lib/useDialog";
import { usePlanData, type PlanData } from "@/lib/usePlanData";
import type { Catalog, PlannerState, Term } from "@/lib/types";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";
const focusRingOnDark = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";
const PANEL_ID = "term-editor";
type View = "plan" | "reqs" | "enroll" | "schedule";
const VIEWS = [
  // [id, label, short label for phones, icon]
  ["plan", "Plan", "Plan", LayoutGrid],
  ["reqs", "Requirements", "Reqs", ListChecks],
  ["enroll", "Enrollment", "Enroll", CalendarClock],
  ["schedule", "Weekly schedule", "Week", CalendarDays],
] as const;
const VIEW_PREF = "ccc.ui.view";

export default function Planner({ catalog }: { catalog: Catalog }) {
  return (
    <PlannerProvider>
      <PlannerInner catalog={catalog} />
    </PlannerProvider>
  );
}

function Modal({ children, onClose, wide, label }: { children: React.ReactNode; onClose: () => void; wide?: boolean; label: string }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div className="fixed inset-0 z-40 grid place-items-start overflow-y-auto overscroll-contain p-4 sm:place-items-center">
      <button type="button" tabIndex={-1} className="fixed inset-0 cursor-default bg-slate-900/40" aria-label="Close" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={`relative w-full ${wide ? "max-w-3xl" : "max-w-xl"} mx-auto outline-none`}>
        {children}
      </div>
    </div>
  );
}

function GamePlan({ catalog, state, data, advise, onOpenCourse }: { catalog: Catalog; state: PlannerState; data: PlanData; advise: Advisor; onOpenCourse: (c: string, t?: Term) => void }) {
  const preds = catalog.predictions;
  if (!preds) return null;
  const sem = state.semesters.find((s) => s.term === preds.term);
  const today = isoDay(new Date());
  // What needs action soonest comes first: classes that have probably filled (waitlist and
  // alerts), then by the phase they fill in and demand. A class whose instructor is not chosen
  // is ranked by its most in-demand section, since that is the risk.
  const ranked = (sem?.courses ?? [])
    .map((pc) => {
      const f = forecastFor(data, pc.course, pc.professor);
      const advice = advise(f.headline, pc.course);
      const pick = f.several && !f.chosen;
      const gone = advice ? advice.state === "passed" && !(advice.fromSeats && !advice.suggestAlert) : pick && f.named.every((p) => forecastState(p, preds.phases, today) === "passed");
      const rank = f.headline ? fillRank(f.headline) : (f.earliest ?? 4);
      const pop = f.headline?.popularity ?? f.peakPopularity ?? -1;
      // Within a phase, the class you are likelier to lose by waiting (waitlist rarely clears) comes first.
      const risk = waitRiskOf(f.headline ?? f.named[0]);
      return { pc, f, advice, pick, gone, rank, pop, risk };
    })
    .sort((a, b) => Number(b.gone) - Number(a.gone) || a.rank - b.rank || b.risk - a.risk || b.pop - a.pop);
  const head = gamePlanToday(preds.phases, today, { total: ranked.length, filled: ranked.filter((r) => r.gone).length, needPick: ranked.filter((r) => r.pick).length });
  return (
    <section className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 sm:p-4" aria-labelledby="gameplan-h">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CalendarClock className="h-5 w-5 shrink-0 text-cal-blue" aria-hidden />
        <h2 id="gameplan-h" className="text-sm font-semibold text-slate-900">
          Enrollment game plan · {termLabel(preds.term)}
        </h2>
        {head.badge && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${head.active ? "bg-cal-gold text-cal-blue" : "bg-slate-100 text-slate-700"}`}>{head.badge}</span>}
      </div>
      {ranked.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">Add classes to {termLabel(preds.term)} and we will rank which to grab first.</p>
      ) : (
        <>
          <ol className="mt-2 space-y-1">
            {ranked.map(({ pc, f, advice, pick }, i) => {
              const p = f.headline;
              return (
                <li key={pc.course}>
                  <button type="button" onClick={() => onOpenCourse(pc.course, preds.term)} title={advice ? advice.advice : pick ? `${f.count} instructors. Right now, ${instructorRangeNow(f.named, preds.phases, today)}.` : "No enrollment history yet, so no forecast."} className={`flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50 ${focusRing}`}>
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-cal-blue text-xs font-semibold text-white">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-slate-900">{pc.course}</span>
                        {p?.professor && (
                          <span className="inline-flex min-w-0 items-center gap-1 text-xs font-medium text-slate-700">
                            <User className="h-3 w-3 shrink-0" aria-hidden />
                            <span className="truncate">{p.professor}</span>
                          </span>
                        )}
                        {p && !p.professorSeenBefore && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-700" title={p.warning ?? undefined}>
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {p.professor ? "new instructor" : "no instructor listed"}
                          </span>
                        )}
                      </span>
                      {p?.waitlist && fillRank(p) <= 1 && (
                        <span className="block text-xs text-slate-600">
                          about {Math.round(p.waitlist.clearRate * 100)}% of its waitlist gets in{(p.capacityExpansion?.pExpands ?? 0) >= 0.5 ? " · usually adds seats" : ""}
                        </span>
                      )}
                    </span>
                    {!advice && !pick && <span className="mt-0.5 shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-300">No forecast</span>}
                    {advice && <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ${advice.cls}`}>{advice.label}</span>}
                    {pick && <span className="mt-0.5 shrink-0 rounded-md bg-cal-gold-100 px-1.5 py-0.5 text-[11px] font-semibold text-cal-blue ring-1 ring-cal-gold">Pick an instructor</span>}
                  </button>
                </li>
              );
            })}
          </ol>
          <Phase1Picks catalog={catalog} state={state} data={data} onOpenCourse={onOpenCourse} />
        </>
      )}
    </section>
  );
}

/** What to say after an action that deserves an Undo. Null for everything else. */
function undoMessage(a: Action): string | null {
  switch (a.type) {
    case "removePlanned":
      return `Removed ${a.course} from ${termLabel(a.term)}`;
    case "removeTaken":
      return `Removed ${a.course}`;
    case "removeTerm":
    case "removeSemester":
      return `Removed ${termLabel(a.term)}`;
    case "markSemesterTaken":
      return `Marked ${termLabel(a.term)} as taken`;
    case "markTaken":
      return `Marked ${a.course} as taken`;
    case "movePlanned":
      return `Moved ${a.course} to ${termLabel(a.to)}`;
    case "setTakenTerm":
      return `Moved ${a.course} to ${a.term ? termLabel(a.term) : CREDIT_LABEL.toLowerCase()}`;
    case "unmarkTaken":
      return `${a.course} is now planned for ${termLabel(a.term)}. Undo restores its grade.`;
    default:
      return null;
  }
}

function PlannerInner({ catalog }: { catalog: Catalog }) {
  const { state, dispatch: rawDispatch, hydrated, sync, connectAccount } = usePlanner();
  const data = usePlanData(catalog, state);
  const [drawer, setDrawer] = useState<{ course: string; term?: Term } | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [addTarget, setAddTarget] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [picked, setPicked] = useState<TermKey | null>(null);
  const [showCredit, setShowCredit] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string; before: PlannerState } | null>(null);
  // One thing at a time: each view is a step (plan terms, check requirements, enroll, build the week).
  const [view, setView] = useState<View>("plan");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_PREF) as View | null;
      if (saved && VIEWS.some(([id]) => id === saved)) setView(saved);
    } catch {
      /* storage blocked: start on the plan */
    }
  }, []);
  const changeView = useCallback((v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_PREF, v);
    } catch {
      /* not remembered, still works */
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => b?.user && connectAccount(true))
      .catch(() => {});
  }, [hydrated, connectAccount]);

  // Teach the id normaliser the catalog's subject aliases, and the plan reducer which codes are
  // the same class, before anything parses text or dispatches.
  useMemo(() => registerSubjectAliases(catalog.subjects), [catalog.subjects]);
  useMemo(() => registerCourseFamilies(data.courseIndex), [data.courseIndex]);
  const knownCourseIds = useMemo(() => new Set(data.courseIndex.keys()), [data.courseIndex]);
  const openCourse = useCallback((course: string, term?: Term) => setDrawer({ course, term }), []);

  // Every change goes through here so removals and moves can be undone from a toast. Several
  // actions fired by one click (a move is sometimes two) share the snapshot taken before the first.
  const stateRef = useRef(state);
  stateRef.current = state;
  const batch = useRef<PlannerState | null>(null);
  const dispatch = useCallback(
    (a: Action) => {
      const text = undoMessage(a);
      if (text) {
        const before = batch.current ?? stateRef.current;
        if (!batch.current) {
          batch.current = before;
          queueMicrotask(() => (batch.current = null));
        }
        setToast({ id: Date.now(), text, before });
      }
      rawDispatch(a);
    },
    [rawDispatch],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const predTerm = catalog.predictions?.term ?? null;
  // A transfer student's history is mostly credit from elsewhere: keep that tab on show.
  const isTransfer = state.year === "Transfer (Junior)";
  const entries = useMemo(() => {
    const list = buildTermEntries(state, data.courseIndex, new Date(), predTerm);
    if ((showCredit || isTransfer) && !list.some((e) => e.key === CREDIT)) {
      const empty: TermEntry = { key: CREDIT, label: CREDIT_LABEL, phase: "credit", rows: [], units: 0, takenCount: 0, plannedCount: 0, done: false, needsReview: false, emptyPast: false };
      list.unshift(empty);
    }
    return list;
  }, [state, data.courseIndex, predTerm, showCredit, isTransfer]);
  const advise = useMemo(() => makeAdvisor(data, catalog.predictions?.phases), [data, catalog.predictions]);
  const outlook = useMemo(() => unitsOutlook(entries), [entries]);
  const selectedKey = picked && entries.some((e) => e.key === picked) ? picked : defaultTermKey(entries, new Date(), predTerm);
  const selectedEntry = entries.find((e) => e.key === selectedKey);

  // The schedule tab opens on the term being edited when it can still be scheduled, else the next one.
  const scheduleTerm: Term =
    selectedEntry && selectedEntry.key !== CREDIT && selectedEntry.phase !== "past"
      ? selectedEntry.key
      : (entries.find((e) => e.key !== CREDIT && e.phase !== "past")?.key ?? currentTerm());
  const selectTerm = useCallback((key: TermKey) => {
    setPicked(key);
    changeView("plan");
    // Bring the editor into view when the click came from further down the page.
    requestAnimationFrame(() => {
      const el = document.getElementById(PANEL_ID);
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top < 110 || top > window.innerHeight * 0.55) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [changeView]);
  const addTerm = (key: TermKey) => {
    if (key === CREDIT) setShowCredit(true);
    else if (!entries.some((e) => e.key === key)) dispatch({ type: "addSemester", term: key });
    selectTerm(key);
  };

  // In the order the student picked them, not the catalog's alphabetical order.
  const majors = state.majorIds.map((id) => catalog.majors.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const minors = catalog.minors.filter((m) => state.minorGroupIds.includes(m.id));
  const usingStub = Object.entries(catalog.sources).filter(([, v]) => v === "stub").map(([k]) => k);
  const termEntries = entries.filter((e) => e.key !== CREDIT);
  const aheadTerms = termEntries.filter((e) => e.phase !== "past");
  const pastTerms = termEntries.filter((e) => e.phase === "past");
  const plannedCount = state.semesters.reduce((a, x) => a + x.courses.length, 0);
  const tickCount = Object.values(state.manualChecks ?? {}).filter(Boolean).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // Clicking "+" on a missing requirement: drop it into the only open term, or ask which one.
  const addFromChecklist = (course: string) => {
    if (findInPlan(state, course, data.courseIndex).key) return openCourse(course);
    if (aheadTerms.length === 1 && pastTerms.length === 0) dispatch({ type: "addPlanned", term: aheadTerms[0].key, course });
    else setAddTarget(course);
  };
  const addTo = (key: TermKey, course: string) => {
    addClassActions(key, course).forEach(dispatch);
    setAddTarget(null);
  };

  const toGo = data.totals.total - data.totals.satisfied;
  const pct = data.totals.total ? Math.round((data.totals.satisfied / data.totals.total) * 100) : 0;
  const donePct = data.totals.total ? Math.round((data.totals.completed / data.totals.total) * 100) : 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  const unitsAll = data.totals.unitsTaken + data.totals.unitsPlanned;
  const heroBtn = `inline-flex h-10 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-medium hover:bg-white/20 lg:h-9 ${focusRingOnDark}`;
  const addCourse = addTarget ? data.courseIndex.get(addTarget) : undefined;
  const addAlso = addTarget ? alsoListedAs(addTarget, data.courseIndex) : [];
  const pill = `inline-flex h-10 items-center rounded-full px-3.5 text-sm font-medium ring-1 lg:h-9 ${focusRing}`;

  return (
    <div className="flex min-h-screen flex-col">
      {hydrated && state.majorIds.length > 0 && (
        <a
          href="#your-terms"
          onClick={() => changeView("plan")}
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-cal-blue focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to your terms
        </a>
      )}
      <header className="sticky top-0 z-30 h-[57px] border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-full max-w-[1600px] items-center gap-3 px-4 sm:px-6">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cal-blue text-sm font-bold text-cal-gold" aria-hidden>
            Cal
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight text-slate-900">CalClassCoordinator</p>
          </div>
          {/* Save status at every width: short on phones, full from md. Errors always show. */}
          <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${sync === "error" ? "font-semibold text-rose-700" : "text-slate-600"}`} role="status" aria-live="polite">
            {sync === "local" && (<><CloudOff className="h-3.5 w-3.5" aria-hidden /><span className="md:hidden">This device</span><span className="hidden md:inline">Saved on this device only</span></>)}
            {sync === "saving" && (<><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Saving</>)}
            {sync === "saved" && (<><Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /><span className="md:hidden">Saved</span><span className="hidden md:inline">Saved to your account</span></>)}
            {sync === "error" && (<><AlertTriangle className="h-3.5 w-3.5" aria-hidden /><span className="md:hidden">Not saved</span><span className="hidden md:inline">Could not save to your account</span></>)}
          </span>
          <AccountMenu onSignedIn={() => connectAccount(true)} onSignedOut={() => connectAccount(false)} />
        </div>
      </header>

      {!hydrated ? (
        <div className="mx-auto w-full max-w-3xl flex-1 p-8" aria-busy="true" aria-label="Loading your plan">
          <div className="h-96 animate-pulse rounded-2xl bg-slate-200/70" />
        </div>
      ) : state.majorIds.length === 0 ? (
        <main className="flex-1 px-4 py-8 sm:py-12">
          <Onboarding catalog={catalog} onDone={(majorIds, year, minorIds) => { dispatch({ type: "setProfile", majorIds, year, minorIds }); setImporting(true); }} />
        </main>
      ) : (
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4 sm:px-6 sm:py-5">
          {usingStub.length > 0 && (
            <p className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Developer note: sample data is filling in for {usingStub.join(", ")}. Students never see sample data in production.
            </p>
          )}

          <section className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl bg-cal-blue px-4 py-4 text-white shadow-sm sm:px-5" aria-label="Your progress">
            <div className="min-w-0 basis-full xl:flex-1 xl:basis-0">
              <p className="text-xs font-medium uppercase tracking-wider text-cal-gold">{state.year ?? "Your plan"}</p>
              <h1 className="text-lg font-semibold leading-snug">{majors.map((m) => `${m.name} ${m.degree}`).join(" + ") || "Choose a major"}</h1>
              {minors.length > 0 && <p className="text-sm text-blue-100">Minor: {minors.map((m) => m.name).join(", ")}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <div
                  className="relative h-2 w-full max-w-md overflow-hidden rounded-full bg-white/20"
                  role="img"
                  aria-label={`${data.totals.completed} of ${data.totals.total} requirements done, ${data.totals.satisfied - data.totals.completed} more planned`}
                >
                  <div className="absolute inset-y-0 left-0 rounded-full bg-cal-gold/50 transition-all" style={{ width: `${pct}%` }} />
                  <div className="absolute inset-y-0 left-0 rounded-full bg-cal-gold transition-all" style={{ width: `${donePct}%` }} />
                </div>
                <span className="shrink-0 text-xs tabular-nums text-blue-100">
                  {data.totals.completed} of {data.totals.total} requirements done
                </span>
              </div>
            </div>
            <dl className="flex gap-5 text-center sm:gap-6">
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-blue-200">Units done</dt>
                <dd className="text-xl font-semibold tabular-nums">{round(data.totals.unitsTaken)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-blue-200">Planned</dt>
                <dd className="text-xl font-semibold tabular-nums">{round(data.totals.unitsPlanned)}</dd>
              </div>
              <div title="Units done and planned, out of the 120 most degrees need">
                <dt className="text-[11px] uppercase tracking-wide text-blue-200">Of 120</dt>
                <dd className="text-xl font-semibold tabular-nums">{Math.min(100, Math.round((unitsAll / 120) * 100))}%</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setImporting(true)} className={heroBtn}>
                <FileUp className="h-3.5 w-3.5" aria-hidden /> Import transcript
              </button>
              <button type="button" onClick={() => setEditingProfile(true)} className={heroBtn}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Major and year
              </button>
              <button type="button" onClick={() => setConfirmReset(true)} aria-label="Start over" title="Start over" className={`${heroBtn} text-blue-100`}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">Start over</span>
              </button>
            </div>
          </section>

          {outlook.short && data.totals.unitsTaken > 0 && (
            <p className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200" role="note">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">
                  {outlook.toGo} units to go with {plural(outlook.termsLeft, "term")} left.
                </span>{" "}
                That is more than {plural(outlook.termsLeft, "term")} can hold at the usual 20.5 units each. Add a term or a summer, or check that your past classes and credit are all entered.
              </span>
            </p>
          )}

          <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-300" role="tablist" aria-label="View">
            {VIEWS.map(([id, label, short, Icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`view-tab-${id}`}
                aria-selected={view === id}
                aria-controls={`view-panel-${id}`}
                onClick={() => changeView(id)}
                className={`-mb-px inline-flex h-11 flex-1 shrink-0 items-center justify-center gap-1.5 border-b-[3px] px-2 text-sm font-semibold sm:flex-none sm:gap-2 sm:px-4 sm:text-[15px] ${focusRing} ${
                  view === id ? "border-cal-blue text-cal-blue" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
                }`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{label}</span>
                {id === "reqs" && toGo > 0 && <span className="hidden rounded-full sm:inline bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-700" title={`${toGo} requirements to go`}>{toGo}</span>}
              </button>
            ))}
          </div>

          <div id={`view-panel-${view}`} role="tabpanel" aria-labelledby={`view-tab-${view}`}>
            {view === "plan" && (
              <>
                <TermBar entries={entries} selected={selectedKey} onSelect={selectTerm} onAdd={addTerm} panelId={PANEL_ID} highlight={isTransfer ? CREDIT : null} />
                <div className="mt-1 space-y-5">
                  {selectedEntry ? (
                    <TermEditor
                      entry={selectedEntry}
                      entries={entries}
                      catalog={catalog}
                      data={data}
                      state={state}
                      dispatch={dispatch}
                      onOpenCourse={openCourse}
                      onImport={() => setImporting(true)}
                      panelId={PANEL_ID}
                      advise={advise}
                    />
                  ) : (
                    <section id={PANEL_ID} className="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
                      <p className="text-sm font-medium text-slate-700">No terms yet</p>
                      <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">Add a term above, or import your transcript.</p>
                    </section>
                  )}
                  <SemesterBoard state={state} entries={entries} selected={selectedKey} catalog={catalog} data={data} dispatch={dispatch} advise={advise} onOpenCourse={openCourse} onSelectTerm={selectTerm} />
                </div>
              </>
            )}
            {view === "reqs" &&
              (data.groupResults.length ? (
                <Checklist columns groups={data.groupResults} data={data} onAdd={addFromChecklist} onOpenCourse={openCourse} onToggleManual={(key) => dispatch({ type: "toggleManual", key })} />
              ) : (
                <p className="rounded-2xl bg-white p-4 text-sm text-slate-600 ring-1 ring-slate-200">No requirements for this major yet.</p>
              ))}
            {view === "enroll" && <GamePlan catalog={catalog} state={state} data={data} advise={advise} onOpenCourse={openCourse} />}
            {view === "schedule" && (
              <ScheduleBuilder inline catalog={catalog} state={state} dispatch={dispatch} data={data} initialTerm={scheduleTerm} onClose={() => changeView("plan")} onOpenCourse={openCourse} escapeDisabled={!!drawer} />
            )}
          </div>
        </main>
      )}

      <footer className="mt-6 border-t border-slate-200">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 text-xs text-slate-600 sm:px-6">
          <p className="min-w-0 flex-1 basis-72">
            CalClassCoordinator is an unofficial, student-run tool and is not affiliated with UC Berkeley. Confirm requirements with your advisor and your Academic Progress Report.
          </p>
          <a href="/privacy" className={`inline-flex min-h-10 items-center rounded font-medium text-slate-600 underline hover:text-slate-900 ${focusRing}`}>
            Privacy
          </a>
        </div>
      </footer>

      {editingProfile && (
        <Modal wide label="Major and year" onClose={() => setEditingProfile(false)}>
          <Onboarding
            catalog={catalog}
            initialMajorIds={state.majorIds}
            initialYear={state.year}
            initialMinorIds={state.minorGroupIds}
            onCancel={() => setEditingProfile(false)}
            onDone={(majorIds, year, minorIds) => { dispatch({ type: "setProfile", majorIds, year, minorIds }); setEditingProfile(false); }}
          />
        </Modal>
      )}

      {importing && (
        <Modal wide label="Import your classes" onClose={() => setImporting(false)}>
          <div className="rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-200 sm:p-6">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="flex-1 text-lg font-semibold text-slate-900">Import your classes</h2>
              <button type="button" onClick={() => setImporting(false)} aria-label="Close" className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 ${focusRing}`}>
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <TranscriptImport
              knownCourseIds={knownCourseIds}
              courseTitles={(id) => data.courseIndex.get(id)?.title}
              onImport={(r) => {
                // Finished classes, AP and transfer rows (with their units and labels) are taken;
                // AP/transfer land in the credit tab by their source.
                dispatch({ type: "addTaken", courses: r.courses });
                // Ungraded rows: the current term is in progress, later terms are planned. One
                // in a term that is already over is treated as taken there.
                for (const c of r.inProgress ?? []) {
                  const term = c.term ?? currentTerm();
                  if (c.source === "ap" || c.source === "transfer") dispatch({ type: "addTaken", courses: [c] });
                  else if (compareTerms(term, currentTerm()) < 0) dispatch({ type: "addTaken", courses: [{ ...c, term }] });
                  else {
                    dispatch({ type: "addPlanned", term, course: c.course });
                    if (c.units !== undefined && !data.courseIndex.has(c.course)) dispatch({ type: "setUnits", course: c.course, units: c.units });
                  }
                }
                setImporting(false);
              }}
            />
            <button type="button" onClick={() => setImporting(false)} className={`mt-3 inline-flex min-h-10 items-center rounded text-xs text-slate-600 hover:text-slate-900 hover:underline ${focusRing}`}>
              Skip for now, I will add classes by hand
            </button>
          </div>
        </Modal>
      )}

      {addTarget && (
        <Modal label={`Add ${addTarget} to your plan`} onClose={() => setAddTarget(null)}>
          <div className="rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-200 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-slate-900">When will you take {addTarget}?</h2>
                <p className="text-sm text-slate-600">
                  {addCourse?.title ?? "Not in our catalog"} · {courseUnits(addCourse)} units
                </p>
                {addAlso.length > 0 && <p className="text-xs text-slate-500">Same class as {addAlso.join(", ")}</p>}
                {(() => {
                  const met = alreadyMetBy(addTarget, data.groupResults, data.courseIndex);
                  if (!met.length) return null;
                  return (
                    <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 ring-1 ring-amber-200">
                      Heads up: {met[0].requirement} is already met{met[0].by.length ? ` by ${met[0].by.join(", ")}` : ""}, so this class would not count again toward your requirements.
                    </p>
                  );
                })()}
              </div>
              <button type="button" onClick={() => setAddTarget(null)} aria-label="Close" className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 ${focusRing}`}>
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <h3 className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Plan it for</h3>
            {aheadTerms.length ? (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {aheadTerms.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    data-autofocus={e.key === (selectedEntry?.phase !== "past" && selectedEntry?.phase !== "credit" ? selectedKey : aheadTerms[0].key) ? "" : undefined}
                    onClick={() => addTo(e.key, addTarget)}
                    className={`${pill} ${e.key === selectedKey ? "bg-cal-blue text-white ring-cal-blue hover:bg-cal-blue-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-cal-gold-100 hover:ring-cal-gold"}`}
                  >
                    {e.label}
                    {e.phase === "current" ? " (now)" : ""}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-sm text-slate-600">You have no current or future terms. Use Add term at the top of your plan first.</p>
            )}
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-500">I already took it</h3>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {pastTerms.map((e) => (
                <button key={e.key} type="button" onClick={() => addTo(e.key, addTarget)} className={`${pill} bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100`}>
                  {e.label}
                </button>
              ))}
              <button type="button" onClick={() => addTo(CREDIT, addTarget)} className={`${pill} bg-white text-slate-700 ring-slate-300 hover:bg-slate-50`}>
                {pastTerms.length ? "Another time or as transfer credit" : "Yes, mark it taken"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmReset && (
        <Modal label="Start over" onClose={() => setConfirmReset(false)}>
          <div className="rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-200 sm:p-5" role="alertdialog" aria-labelledby="reset-h" aria-describedby="reset-d">
            <h2 id="reset-h" className="text-base font-semibold text-slate-900">
              Erase your whole plan?
            </h2>
            <div id="reset-d" className="mt-1 text-sm text-slate-700">
              <p>This erases everything in your plan{sync === "local" ? " on this device" : " on this device and in your account"}:</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                <li>
                  your {plural(state.majorIds.length, "major")}
                  {state.minorGroupIds.length > 0 ? `, ${plural(state.minorGroupIds.length, "minor")}` : ""}
                  {state.year ? ` and year (${state.year})` : ""}
                </li>
                <li>
                  {plural(state.taken.length, "taken class", "taken classes")} and {plural(plannedCount, "planned class", "planned classes")}
                </li>
                <li>{plural(termEntries.length, "term")}, with the instructors you chose</li>
                <li>your program choices and the {plural(tickCount, "requirement")} you ticked off yourself</li>
              </ul>
              <p className="mt-2 font-medium text-slate-900">This cannot be undone.</p>
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" data-autofocus="" onClick={() => setConfirmReset(false)} className={`h-10 rounded-lg px-3.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 ${focusRing}`}>
                Keep my plan
              </button>
              <button
                type="button"
                onClick={() => {
                  rawDispatch({ type: "reset" });
                  setConfirmReset(false);
                  setToast(null);
                  setPicked(null);
                  setShowCredit(false);
                }}
                className={`h-10 rounded-lg bg-rose-600 px-3.5 text-sm font-semibold text-white hover:bg-rose-700 ${focusRing}`}
              >
                Erase everything
              </button>
            </div>
          </div>
        </Modal>
      )}


      {drawer && <CourseDrawer courseId={drawer.course} term={drawer.term} catalog={catalog} data={data} state={state} dispatch={dispatch} onClose={() => setDrawer(null)} />}

      {/* Under the header on phones (clear of the row controls and pickers the student is using,
          which sit lower), bottom centre on larger screens. Text wraps; nothing is cut off. */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 top-[61px] z-50 flex justify-center px-3 sm:bottom-4 sm:top-auto" role="status" aria-live="polite">
          <div key={toast.id} className="pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-xl bg-slate-900 py-1.5 pl-4 pr-1.5 text-sm text-white shadow-xl sm:w-auto">
            <span className="min-w-0 flex-1 py-1 leading-snug">{toast.text}</span>
            <button
              type="button"
              onClick={() => {
                rawDispatch({ type: "replace", state: toast.before });
                setToast(null);
              }}
              className={`ml-2 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-2.5 font-semibold text-cal-gold hover:bg-white/10 ${focusRingOnDark}`}
            >
              <Undo2 className="h-4 w-4" aria-hidden /> Undo
            </button>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-white/10 ${focusRingOnDark}`}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
