"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bell, BellRing, Check, ExternalLink, Plus, Trash2, X } from "lucide-react";
import InstructorPicker from "./InstructorPicker";
import { alsoListedAs } from "@/lib/courseFamily";
import { courseUnits } from "@/lib/courseId";
import { instructorRangeNow, isoDay, type ForecastAdvice } from "@/lib/forecast";
import { insightFor, makeAdvisor, predictionsFor, seatsFor } from "@/lib/planLookups";
import { CREDIT, findInPlan } from "@/lib/planTerms";
import { reconcileInstructors, summarizeInstructors, type InstructorSummary } from "@/lib/professors";
import { compareTerms, currentTerm, termLabel } from "@/lib/terms";
import { useDialog } from "@/lib/useDialog";
import type { PlanData } from "@/lib/usePlanData";
import { InsightPanel } from "./InsightPanel";
import { createAlert, fetchMe, requestSignIn } from "@/lib/useAccount";
import type { Catalog, CourseDetails, CourseInsight, PlannerState, Prediction, SectionSeats, Term } from "@/lib/types";
import type { Action } from "@/lib/store";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";
const h3 = "text-xs font-semibold uppercase tracking-wider text-slate-600";

/** Catalog attribute codes in words. */
const ATTRIBUTE_LABELS: Record<string, string> = {
  AC: "American Cultures",
  "AH&I": "American History and Institutions",
  ELW: "Entry Level Writing",
  RCA: "Reading and Composition A",
  RCB: "Reading and Composition B",
  FL: "Foreign language",
  HSS: "Humanities/social science (College of Engineering)",
};

/** "Economics BA" -> "Economics", "College of Letters & Science ..." stays readable but short. */
function programName(title: string): string {
  return title.replace(/\s+(BA|BS|B\.A\.|B\.S\.|Minor|Major)$/i, "").replace(/\s+requirements?$/i, "").trim();
}

/** Text with http(s) URLs turned into links. Anything else stays plain text. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <span key={i}>{part}</span>;
        const url = part.replace(/[.,;:!?]+$/, "");
        const tail = part.slice(url.length);
        return (
          <span key={i}>
            <a href={url} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-cal-blue underline">
              {url}
            </a>
            {tail}
          </span>
        );
      })}
    </>
  );
}

/** The one forecast that applies: the chosen (or only) instructor's, in full, as of today. */
function ForecastDetail({ p, advice, historyOnly }: { p: Prediction; advice: ForecastAdvice | null; historyOnly?: boolean }) {
  const phases = Object.entries(p.pFullByPhase ?? {});
  const basis: Record<string, string> = {
    professor: "this instructor's past terms teaching this class",
    "professor-other-courses": "this instructor's other classes",
    course: "this class under other instructors",
    department: "similar classes in the department",
    global: "classes across campus",
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {advice && <span className={`rounded-md px-2 py-1 text-xs font-semibold ring-1 ${advice.cls}`}>{advice.label}</span>}
      </div>
      <p className="mt-1.5 text-sm font-medium text-slate-900">{advice?.advice ?? "No forecast for this class."}</p>
      {advice?.suggestAlert && (
        <button
          type="button"
          onClick={() => document.getElementById("drawer-seats")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className={`mt-2 inline-flex h-10 items-center gap-1.5 rounded-lg bg-cal-blue px-3 text-xs font-semibold text-white hover:bg-cal-blue-700 lg:h-9 ${focusRing}`}
        >
          <Bell className="h-3.5 w-3.5" aria-hidden /> Set a seat alert
        </button>
      )}
      {phases.length > 0 && (
        <dl className="mt-2.5 space-y-1.5">
          {phases.map(([name, v]) => (
            <div key={name} className="flex items-center gap-2">
              <dt className="w-40 shrink-0 whitespace-nowrap text-xs text-slate-600">Full by end of {name.replace(" Period", "").replace("Phase ", "Ph. ")}</dt>
              <dd className="flex flex-1 items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <span className={`block h-full rounded-full ${v >= 0.5 ? "bg-rose-500" : "bg-slate-400"}`} style={{ width: `${Math.round(v * 100)}%` }} />
                </span>
                <span className="w-9 text-right text-xs tabular-nums text-slate-700">{Math.round(v * 100)}%</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="w-40 shrink-0 text-xs text-slate-600">Popularity</span>
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
          <span className="block h-full rounded-full bg-cal-blue" style={{ width: `${Math.round(p.popularity * 100)}%` }} />
        </span>
        <span className="w-9 text-right text-xs tabular-nums text-slate-700">{Math.round(p.popularity * 100)}%</span>
      </div>
      {(p.waitlist || p.capacityExpansion) && (
        <dl className="mt-2.5 grid grid-cols-3 gap-2 text-center">
          {p.waitlist && (
            <div className="rounded-lg bg-white p-1.5 ring-1 ring-slate-200" title="Share of the longest waitlist that ended up with a seat by the add/drop deadline in past terms. Estimated from daily totals, so treat it as approximate.">
              <dt className="text-[11px] text-slate-600">Waitlist gets in</dt>
              <dd className="text-sm font-semibold tabular-nums text-slate-900">about {Math.round(p.waitlist.clearRate * 100)}%</dd>
            </div>
          )}
          {p.waitlist && (
            <div className="rounded-lg bg-white p-1.5 ring-1 ring-slate-200" title={`A waitlist formed in ${p.waitlist.pastTermsWithWaitlist} of ${p.waitlist.pastTerms} past terms.`}>
              <dt className="text-[11px] text-slate-600">Typical waitlist</dt>
              <dd className="text-sm font-semibold tabular-nums text-slate-900">{p.waitlist.pWaitlist < 0.3 ? "rare" : p.waitlist.expectedPeak != null ? `up to ~${p.waitlist.expectedPeak}` : "likely"}</dd>
            </div>
          )}
          {p.capacityExpansion && (
            <div className="rounded-lg bg-white p-1.5 ring-1 ring-slate-200" title={p.capacityExpansion.pastTerms ? `Seats were added after enrollment opened in ${p.capacityExpansion.pastTermsExpanded} of ${p.capacityExpansion.pastTerms} past terms.` : "Based on similar classes."}>
              <dt className="text-[11px] text-slate-600">Adds seats</dt>
              <dd className="text-sm font-semibold tabular-nums text-slate-900">
                {Math.round(p.capacityExpansion.pExpands * 100)}% of terms{p.capacityExpansion.pExpands >= 0.4 && p.capacityExpansion.expectedGrowth >= 0.03 ? `, +${Math.round(p.capacityExpansion.expectedGrowth * 100)}%` : ""}
              </dd>
            </div>
          )}
        </dl>
      )}
      {!historyOnly && (!p.professorSeenBefore || p.warning) && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {p.warning ?? "We have not seen this instructor teach this class before, so this estimate uses the class's overall history."}
        </p>
      )}
      <p className="mt-2 text-[11px] text-slate-500">
        {p.confidence != null && `Confidence: ${typeof p.confidence === "number" ? `${Math.round(p.confidence * 100)}%` : p.confidence}. `}
        {historyOnly ? "Based on how this class has filled in past terms." : p.basis && basis[p.basis] && `Based on ${basis[p.basis]}${p.historyTerms ? ` (${p.historyTerms} past offering${p.historyTerms === 1 ? "" : "s"})` : ""}.`}
      </p>
    </div>
  );
}

function Forecast({
  summary,
  chosenName,
  advice,
  rangeNow,
  teachingNow,
}: {
  summary: InstructorSummary;
  chosenName?: string;
  advice: ForecastAdvice | null;
  rangeNow: string;
  /** Instructors from live seat data when they contradict the forecast's list. */
  teachingNow?: string[];
}) {
  if (summary.headline) {
    const p = summary.headline;
    return (
      <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <p className="mb-2 text-xs text-slate-600">
          {teachingNow?.length ? (
            <>
              Taught this term by <span className="font-semibold text-slate-900">{teachingNow.slice(0, 3).join(", ")}</span>
              {teachingNow.length > 3 ? ` and ${teachingNow.length - 3} more` : ""}. Forecast uses the class&apos;s history.
            </>
          ) : p.professor ? (
            <>
              With <span className="font-semibold text-slate-900">{p.professor}</span>
              {summary.several ? ", your pick" : ""}
            </>
          ) : (
            "No instructor listed yet"
          )}
        </p>
        <ForecastDetail p={p} advice={advice} historyOnly={!!teachingNow?.length} />
      </div>
    );
  }
  if (summary.several) {
    return (
      <div className="rounded-xl bg-cal-gold-100 p-3 ring-1 ring-cal-gold">
        <p className="text-sm font-semibold text-cal-blue">Depends on the instructor</p>
        <p className="mt-0.5 text-sm text-slate-700">
          {rangeNow ? `${rangeNow[0].toUpperCase()}${rangeNow.slice(1)}.` : `${summary.count} instructors.`}
        </p>
        {chosenName && summary.chosenUnknown && <p className="mt-1.5 text-xs text-amber-900">No forecast for {chosenName}.</p>}
      </div>
    );
  }
  return <p className="rounded-xl bg-white p-3 text-sm text-slate-600 ring-1 ring-slate-200">No enrollment history for this class yet.</p>;
}

type AlertGate = "checking" | "signedOut" | "unverified" | "ready";

function SeatRow({ s, course }: { s: SectionSeats; course: string }) {
  const [open, setOpen] = useState(false);
  const [gate, setGate] = useState<AlertGate>("checking");
  const [includeReserved, setIncludeReserved] = useState(false);
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(null);
  const [busy, setBusy] = useState(false);
  const free = Math.max(0, s.capacity - s.enrolled);
  const reservedFree = (s.reserved ?? []).reduce((a, r) => a + Math.max(0, r.capacity - r.enrolled), 0);
  const pct = s.capacity ? Math.min(100, (s.enrolled / s.capacity) * 100) : 0;
  const numeric = /^\d+$/.test(s.classNumber);

  const start = async () => {
    setOpen(true);
    setStatus(null);
    setGate("checking");
    try {
      const me = await fetchMe();
      setGate(!me ? "signedOut" : me.emailVerified ? "ready" : "unverified");
    } catch {
      setGate("signedOut");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const r = await createAlert({ classNumber: s.classNumber, course, term: s.term, includeReserved });
      setStatus({
        ok: true,
        msg: r.delivered
          ? "Alert on. You'll get an email when a seat opens."
          : "Alert saved. Emails start once seat tracking is connected.",
      });
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 401) setGate("signedOut");
      else if (code === 403 && /verify/i.test((err as Error).message)) setGate("unverified");
      else setStatus({ ok: false, msg: err instanceof Error ? err.message : "Couldn't save the alert" });
    }
    setBusy(false);
  };

  return (
    <li className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${free - reservedFree > 0 ? "bg-emerald-500" : free > 0 ? "bg-violet-500" : "bg-rose-500"}`} />
        <p className="flex-1 text-sm font-medium text-slate-900">
          {s.section} <span className="font-normal text-slate-500">{s.instructor ? `· ${s.instructor}` : ""}</span>
        </p>
        <span className="text-xs tabular-nums text-slate-600">
          {s.enrolled}/{s.capacity}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full rounded-full ${pct >= 100 ? "bg-rose-500" : pct > 90 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-slate-600">
        {free > 0 ? `${free} seat${free === 1 ? "" : "s"} open` : "Full"}
        {reservedFree > 0 && ` (${Math.min(free, reservedFree)} reserved)`}
        {s.waitlisted != null && ` · waitlist ${s.waitlisted}${s.waitlistCapacity ? `/${s.waitlistCapacity}` : ""}`}
        <span className="text-slate-400"> · #{s.classNumber}</span>
      </p>
      {(s.reserved?.length ?? 0) > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {s.reserved!.map((r) => (
            <li key={r.group} className="flex justify-between text-[11px] text-violet-700">
              <span>Reserved: {r.group}</span>
              <span className="tabular-nums">
                {Math.max(0, r.capacity - r.enrolled)} of {r.capacity} left
              </span>
            </li>
          ))}
        </ul>
      )}
      {!open && !status?.ok && numeric && (
        <button onClick={start} className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-cal-blue ring-1 ring-blue-200 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue lg:h-8">
          <Bell className="h-3.5 w-3.5" /> Alert me when a seat opens
        </button>
      )}
      {open && !status?.ok && gate === "checking" && <p className="mt-2 text-xs text-slate-400">Checking your account…</p>}
      {open && !status?.ok && gate === "signedOut" && (
        <p className="mt-2 text-xs text-slate-600">
          <button type="button" onClick={requestSignIn} className="font-medium text-cal-blue hover:underline">
            Sign in
          </button>{" "}
          to get seat alerts by email.
        </p>
      )}
      {open && !status?.ok && gate === "unverified" && (
        <p className="mt-2 text-xs text-amber-800">
          Verify your email first. You can resend the link from the account menu.
        </p>
      )}
      {open && !status?.ok && gate === "ready" && (
        <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button disabled={busy} className="h-10 rounded-lg bg-cal-blue px-3 text-xs font-semibold text-white disabled:opacity-50 lg:h-8">
            {busy ? "Saving" : "Turn on alert"}
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={includeReserved} onChange={(e) => setIncludeReserved(e.target.checked)} className="accent-[#002676]" />
            Include reserved seats
          </label>
        </form>
      )}
      {status && (
        <p className={`mt-2 flex items-start gap-1.5 text-xs ${status.ok ? "text-emerald-700" : "text-rose-600"}`}>
          {status.ok && <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          {status.msg}
        </p>
      )}
    </li>
  );
}

export default function CourseDrawer({
  courseId,
  term,
  catalog,
  data,
  state,
  dispatch,
  onClose,
}: {
  courseId: string;
  term?: Term;
  catalog: Catalog;
  data: PlanData;
  state: PlannerState;
  dispatch: (a: Action) => void;
  onClose: () => void;
}) {
  const ref = useDialog<HTMLElement>(onClose);
  // The class may sit in the plan under another of its cross-listed codes: show and edit that one.
  const spot = findInPlan(state, courseId, data.courseIndex);
  const id = spot.taken?.course ?? spot.planned?.course.course ?? courseId;
  const c = data.courseIndex.get(id);
  const also = alsoListedAs(id, data.courseIndex);
  const family = [id, ...also];
  const preds = predictionsFor(data, id);
  const seats = seatsFor(data, id);
  const leanInsight = insightFor(data, id);
  const taken = spot.taken;
  const plannedIn = spot.planned?.term;
  const predTerm = catalog.predictions?.term;
  // Name the program: "Statistics" alone could be anyone's statistics requirement.
  const countsFor = [
    ...new Set(
      data.groupResults.flatMap((g) => g.requirements.filter((r) => r.result.used.some((u) => family.includes(u.id))).map((r) => `${programName(g.group.title)}: ${r.title}${r.section && !r.title.toLowerCase().includes(r.section.toLowerCase()) ? ` (${r.section.toLowerCase()})` : ""}`)),
    ),
  ];
  const phases = catalog.predictions?.phases ?? [];
  const advise = makeAdvisor(data, phases);

  // Until the class is in the plan there is nowhere to save an instructor, so hold the pick here.
  const [preview, setPreview] = useState<string | undefined>(undefined);
  useEffect(() => setPreview(undefined), [id]);
  const chosenName = spot.planned ? spot.planned.course.professor : preview;
  const summary = summarizeInstructors(preds.list, chosenName);
  const selectedName = summary.chosen?.professor;
  const teaching = reconcileInstructors(preds.list, seats.list);
  const advice = advise(summary.headline, id);
  const rangeNow = instructorRangeNow(summary.named, phases, isoDay(new Date()));

  const [details, setDetails] = useState<CourseDetails | null>(null);
  const [fullInsight, setFullInsight] = useState<CourseInsight | null>(null);
  // The catalog carries only the two ratings; grades, professors and reviews arrive with the details.
  const insight = fullInsight ?? leanInsight;
  useEffect(() => {
    setDetails(null);
    setFullInsight(null);
    const ac = new AbortController();
    fetch(`/api/course?id=${encodeURIComponent(c?.id ?? id)}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.details) setDetails(b.details);
        if (b?.insight) setFullInsight(b.insight);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [id, c?.id]);
  const description = insight?.summary ?? c?.description ?? details?.description;
  const prereqs = c?.prereqs ?? details?.prereqs;

  const cur = currentTerm();
  const openTerms = state.semesters.filter((s) => compareTerms(s.term, cur) >= 0 || s.term === plannedIn);
  const addTerm = predTerm && openTerms.some((s) => s.term === predTerm) ? predTerm : openTerms.find((s) => compareTerms(s.term, cur) > 0)?.term ?? openTerms[0]?.term;
  const status = taken ? (spot.key === CREDIT ? "Taken" : `Taken ${termLabel(taken.term!)}`) : plannedIn ? `${plannedIn === cur ? "In progress" : "Planned"} ${termLabel(plannedIn)}` : "Not in your plan";

  const pickInstructor = (professor?: string) => {
    if (spot.planned) dispatch({ type: "setProfessor", term: spot.planned.term, course: id, professor });
    else setPreview(professor);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" tabIndex={-1} className="absolute inset-0 cursor-default bg-slate-900/40" aria-label="Close class details" onClick={onClose} />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        tabIndex={-1}
        className="thin-scroll relative flex h-dvh w-full max-w-md flex-col overflow-y-auto overscroll-contain bg-[#f6f7fb] shadow-2xl outline-none"
      >
        <header className="sticky top-0 z-10 bg-cal-blue px-4 py-3.5 text-white sm:px-5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wider text-cal-gold">
                {courseUnits(c)} units · {status}
              </p>
              <h2 id="drawer-title" className="text-xl font-semibold leading-tight">
                {id}
              </h2>
              {also.length > 0 && <p className="text-xs text-blue-100">Same class as {also.join(", ")}</p>}
              <p className="mt-0.5 text-sm text-blue-100">{c?.title ?? (taken?.label || "Not in the catalog")}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-blue-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 p-4 pb-10 sm:p-5">
          {!taken && (
            <section>
              <h3 className={h3}>{plannedIn ? "In your plan" : "Add to your plan"}</h3>
              {openTerms.length ? (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {openTerms.map((s) => {
                    const here = plannedIn === s.term;
                    return (
                      <button
                        key={s.term}
                        type="button"
                        aria-pressed={here}
                        aria-label={here ? `${termLabel(s.term)}, where this class is now` : plannedIn ? `Move to ${termLabel(s.term)}` : `Add to ${termLabel(s.term)}`}
                        onClick={() => {
                          if (here) return; // already here: removing is the explicit button below
                          if (plannedIn) dispatch({ type: "movePlanned", from: plannedIn, to: s.term, course: id });
                          else {
                            dispatch({ type: "addPlanned", term: s.term, course: id });
                            if (preview) dispatch({ type: "setProfessor", term: s.term, course: id, professor: preview });
                          }
                        }}
                        className={`inline-flex h-10 items-center gap-1 rounded-full px-3.5 text-xs font-medium ring-1 lg:h-8 ${focusRing} ${
                          here ? "bg-cal-blue text-white ring-cal-blue" : "bg-white text-slate-700 ring-slate-300 hover:ring-slate-500"
                        }`}
                      >
                        {here ? <Check className="h-3 w-3" aria-hidden /> : <Plus className="h-3 w-3" aria-hidden />}
                        {termLabel(s.term)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1.5 text-sm text-slate-600">Add a term to your plan first.</p>
              )}
              {plannedIn && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "removePlanned", term: plannedIn, course: id })}
                    className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50 lg:h-8 ${focusRing}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove from {termLabel(plannedIn)}
                  </button>
                </div>
              )}
            </section>
          )}

          {!taken && (
            <section>
              <h3 className={h3}>When to enroll{predTerm ? ` · ${termLabel(predTerm)}` : ""}</h3>
              <div className="mt-1.5">
                <Forecast summary={summary} chosenName={chosenName} advice={advice} rangeNow={rangeNow} teachingNow={teaching.mismatch ? teaching.fromSeats : undefined} />
              </div>
              {preds.list.length > 0 && preds.via !== id && <p className="mt-1.5 text-xs text-slate-600">Forecast from {preds.via}.</p>}
              {preds.list.length > 0 && predTerm && plannedIn && plannedIn !== predTerm && (
                <p className="mt-1.5 text-xs text-slate-600">
                  Forecast is for {termLabel(predTerm)}, not {termLabel(plannedIn)}.
                </p>
              )}
            </section>
          )}

          {!taken && summary.several && !teaching.mismatch && (
            <div>
              <InstructorPicker summary={summary} seats={seats.list} selected={selectedName} onSelect={pickInstructor} termName={predTerm ? termLabel(predTerm) : "the coming term"} advise={advise} course={id} rangeNow={rangeNow} />
              {!spot.planned && preview && addTerm && (
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: "addPlanned", term: addTerm, course: id });
                    dispatch({ type: "setProfessor", term: addTerm, course: id, professor: preview });
                  }}
                  className={`mt-2 inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-cal-blue px-3 py-2 text-sm font-semibold text-white hover:bg-cal-blue-700 ${focusRing}`}
                >
                  <Plus className="h-4 w-4 shrink-0" aria-hidden /> Add to {termLabel(addTerm)} with {preview}
                </button>
              )}
            </div>
          )}

          {!taken && (
            <section id="drawer-seats" className="scroll-mt-28">
              <h3 className={h3}>
                Seats right now
                {catalog.seats && (
                  <span className="ml-1 font-normal normal-case tracking-normal text-slate-500">
                    · updated {new Date(catalog.seats.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                )}
              </h3>
              {seats.list.length ? (
                <ul className="mt-1.5 space-y-2">
                  {[...seats.list]
                    .sort((a, b) => Number(!!selectedName && b.instructor === selectedName) - Number(!!selectedName && a.instructor === selectedName))
                    .map((s) => (
                      <SeatRow key={s.classNumber} s={s} course={seats.via} />
                    ))}
                </ul>
              ) : (
                <p className="mt-1.5 rounded-xl bg-white p-3 text-sm text-slate-600 ring-1 ring-slate-200">
                  No live seat counts{term ? ` for ${termLabel(term)}` : ""} yet. Check classes.berkeley.edu.
                </p>
              )}
            </section>
          )}

          {countsFor.length > 0 && (
            <section>
              <h3 className={h3}>Counts toward</h3>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {countsFor.map((t) => (
                  <span key={t} className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 ring-1 ring-emerald-200">
                    {t}
                  </span>
                ))}
              </div>
            </section>
          )}

          {(description || prereqs || (c?.breadths?.length ?? 0) > 0 || c?.url) && (
            <section>
              <h3 className={h3}>About</h3>
              {description && (
                <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                  <Linkified text={description} />
                </p>
              )}
              {prereqs && <p className="mt-1.5 text-xs text-slate-600">Prerequisites: {prereqs.replace(/^prerequisites?:\s*/i, "")}</p>}
              {details?.offered && <p className="mt-1 text-xs text-slate-600">{details.offered}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[...(c?.breadths ?? []).map((b) => `${b} breadth`), ...(c?.attributes ?? []).filter((a) => a !== "UD").map((a) => ATTRIBUTE_LABELS[a] ?? a)].map((b) => (
                  <span key={b} className="rounded-md bg-white px-2 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200">
                    {b}
                  </span>
                ))}
              </div>
              {c?.url && (
                <a href={c.url} target="_blank" rel="noreferrer" className={`mt-2 inline-flex min-h-8 items-center gap-1 rounded text-xs font-medium text-cal-blue hover:underline ${focusRing}`}>
                  View on classes.berkeley.edu <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              )}
            </section>
          )}

          {insight && <InsightPanel insight={insight} />}

          {taken && (
            <section className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
              <p className="text-sm text-slate-700">
                Taken{taken.grade ? `, grade ${taken.grade}` : ""}. Edit it from the term bar.
              </p>
              <button
                type="button"
                onClick={() => {
                  dispatch({ type: "removeTaken", course: id });
                  onClose();
                }}
                className={`mt-2 inline-flex h-10 items-center rounded-lg px-3 text-xs font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50 lg:h-8 ${focusRing}`}
              >
                Remove from taken
              </button>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
