"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, MessageSquareQuote } from "lucide-react";
import { termLabel } from "@/lib/terms";
import type { CourseInsight, InsightConfidence, InsightSignal, ProfessorInsight, Term } from "@/lib/types";

const CONFIDENCE_TEXT: Record<InsightConfidence, string> = {
  high: "Lots of data",
  medium: "Some data",
  low: "Little data",
};

function confidenceOf(insight: CourseInsight, key: "difficulty" | "shouldTake"): InsightConfidence | undefined {
  const c = insight.confidence;
  return typeof c === "string" ? c : c?.[key];
}

function Meter({ label, value, hint, confidence }: { label: string; value: number; hint: string; confidence?: InsightConfidence }) {
  return (
    <div className="flex-1 rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900">
        {value.toFixed(1)}
        <span className="text-sm font-normal text-slate-400"> / 5</span>
      </p>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full rounded-full ${confidence === "low" ? "bg-slate-400" : "bg-cal-blue"}`} style={{ width: `${(value / 5) * 100}%` }} />
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        {hint}
        {confidence ? ` · ${CONFIDENCE_TEXT[confidence]}` : ""}
      </p>
    </div>
  );
}

function Signals({ title, signals }: { title: string; signals?: InsightSignal[] }) {
  if (!signals?.length) return null;
  const total = signals.reduce((a, s) => a + s.weight, 0) || 1;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{title}</p>
      <ul className="mt-1 space-y-1">
        {signals.map((s) => (
          <li key={s.label} className="flex items-baseline gap-2 text-xs text-slate-600">
            <span className="flex-1">{s.label}</span>
            <span className="tabular-nums text-slate-900">{s.value.toFixed(1)}</span>
            <span className="w-10 text-right tabular-nums text-slate-400">{Math.round((s.weight / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GradeBars({ grades }: { grades: NonNullable<CourseInsight["grades"]> }) {
  const dist = grades.distribution ?? [];
  if (!dist.length) return null;
  const max = Math.max(...dist.map((d) => d.count));
  const total = dist.reduce((a, d) => a + d.count, 0);
  return (
    <div className="mt-2 flex h-16 items-end gap-0.5" role="img" aria-label={`Grade distribution, average ${grades.letter}`}>
      {dist.map((d) => (
        <div key={d.letter} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={`${d.letter}: ${Math.round((d.count / total) * 100)}%`}>
          <div
            className={`w-full rounded-t ${/^(P|S)$/.test(d.letter) ? "bg-slate-300" : /^(NP|U|F|D)/.test(d.letter) ? "bg-rose-300" : "bg-cal-blue/70"}`}
            style={{ height: `${Math.max(2, (d.count / max) * 44)}px` }}
          />
          <span className="text-[9px] leading-none text-slate-400">{d.letter}</span>
        </div>
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200">
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-sm font-medium text-slate-800">{value}</p>
    </div>
  );
}

function ProfessorTable({ rows }: { rows: ProfessorInsight[] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
      <table className="w-full text-left text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="px-3 py-2 font-medium">Professor</th>
            <th className="px-1.5 py-2 font-medium" title="Typical number of scheduled midterms">Midterms</th>
            <th className="px-1.5 py-2 font-medium" title="RateMyProfessors quality, out of 5">RMP</th>
            <th className="px-1.5 py-2 font-medium" title="Average grade when this professor taught it">Avg GPA</th>
            <th className="px-1.5 py-2 pr-3 font-medium" title="Difficulty for this professor, out of 5">Difficulty</th>
          </tr>
        </thead>
        <tbody className="text-slate-700">
          {rows.map((p) => (
            <tr key={p.professor} className="border-t border-slate-100 align-top">
              <td className="px-3 py-1.5">
                <span className="font-medium">{p.professor}</span>
                <span className="block text-[11px] text-slate-400">
                  {p.teachingNext
                    ? `Teaching ${termLabel(p.teachingNext as Term)}`
                    : p.lastTaught
                      ? `Last taught ${termLabel(p.lastTaught as Term)}`
                      : ""}
                </span>
              </td>
              <td className="px-1.5 py-1.5 tabular-nums">{p.midterms ?? "–"}</td>
              <td className="px-1.5 py-1.5 tabular-nums">
                {p.rmp != null ? (
                  p.rmpUrl ? (
                    <a href={p.rmpUrl} target="_blank" rel="noreferrer" className="text-cal-blue hover:underline" title={`${p.rmpCount ?? ""} ratings${p.wouldTakeAgain != null ? `, ${p.wouldTakeAgain}% would take again` : ""}`}>
                      {p.rmp.toFixed(1)}
                    </a>
                  ) : (
                    p.rmp.toFixed(1)
                  )
                ) : (
                  "–"
                )}
              </td>
              <td className="px-1.5 py-1.5 tabular-nums">{p.gpa?.toFixed(2) ?? "–"}</td>
              <td className="px-1.5 py-1.5 pr-3 tabular-nums">{p.difficulty?.toFixed(1) ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Is it worth it?" block of the class drawer: ratings, why, grades, professors, what students say. */
export function InsightPanel({ insight }: { insight: CourseInsight }) {
  const [showWhy, setShowWhy] = useState(false);
  const [allReviews, setAllReviews] = useState(false);
  const g = insight.grades;
  const sr = insight.studentRatings;
  const reviews = insight.reviews ?? [];
  const hasSignals = (insight.signals?.difficulty?.length ?? 0) + (insight.signals?.shouldTake?.length ?? 0) > 0;
  const facts: [string, string][] = [];
  if (insight.midterms != null) facts.push(["Midterms", String(insight.midterms)]);
  if (insight.finalExam) facts.push(["Final exam", /^(Y|D)$/i.test(insight.finalExam) ? "Yes" : /^(N)$/i.test(insight.finalExam) ? "No" : "Varies"]);
  if (g) facts.push(["Average grade", `${g.letter} (${g.average.toFixed(2)})`]);
  if (g?.pctA != null) facts.push(["A range", `${g.pctA}%`]);
  if (sr?.workload != null) facts.push(["Workload", `${sr.workload.toFixed(1)} / 5`]);
  if (sr?.recordedPct != null && sr.count >= 3) facts.push(["Lectures recorded", sr.recordedPct >= 60 ? "Usually" : sr.recordedPct <= 30 ? "Rarely" : "Sometimes"]);
  if (sr?.attendanceRequiredPct != null && sr.count >= 3) facts.push(["Attendance", sr.attendanceRequiredPct >= 60 ? "Required" : "Not required"]);

  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Ratings
        {insight.stub && <span className="ml-1 font-normal normal-case tracking-normal text-amber-600">· sample data</span>}
      </h3>
      {(insight.difficulty != null || insight.shouldTake != null) && (
        <div className="mt-1.5 flex gap-3">
          {insight.difficulty != null && <Meter label="Difficulty" value={insight.difficulty} hint="5 = hardest" confidence={confidenceOf(insight, "difficulty")} />}
          {insight.shouldTake != null && <Meter label="Should I take it" value={insight.shouldTake} hint="5 = yes" confidence={confidenceOf(insight, "shouldTake")} />}
        </div>
      )}
      {hasSignals && (
        <div className="mt-1.5">
          <button onClick={() => setShowWhy((v) => !v)} aria-expanded={showWhy} className="inline-flex items-center gap-1 text-xs font-medium text-cal-blue hover:underline">
            How these are calculated <ChevronDown className={`h-3 w-3 transition-transform ${showWhy ? "rotate-180" : ""}`} />
          </button>
          {showWhy && (
            <div className="mt-1.5 space-y-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
              <Signals title="Difficulty (score out of 5, weight)" signals={insight.signals?.difficulty} />
              <Signals title="Should I take it" signals={insight.signals?.shouldTake} />
              <p className="text-[11px] text-slate-400">Thin data pulls ratings toward the middle.</p>
            </div>
          )}
        </div>
      )}
      {insight.sentiment && <p className="mt-2 text-sm leading-relaxed text-slate-600">{insight.sentiment}</p>}
      {facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {facts.map(([k, v]) => (
            <Fact key={k} label={k} value={v} />
          ))}
        </div>
      )}
      {g && <GradeBars grades={g} />}
      {(insight.byProfessor?.length ?? 0) > 0 && <ProfessorTable rows={insight.byProfessor!} />}
      {reviews.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <MessageSquareQuote className="h-3 w-3" /> What students say
          </p>
          <ul className="mt-1 space-y-2">
            {(allReviews ? reviews : reviews.slice(0, 2)).map((r, i) => (
              <li key={i} className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                {r.title && <p className="text-sm font-medium text-slate-800">{r.title}</p>}
                <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">{r.text}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {[r.term ? termLabel(r.term as Term) : r.date?.slice(0, 4), r.professor, r.grade && `got ${r.grade}`, r.source].filter(Boolean).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
          {reviews.length > 2 && (
            <button onClick={() => setAllReviews((v) => !v)} className="mt-1 text-xs font-medium text-cal-blue hover:underline">
              {allReviews ? "Show fewer" : `Show ${reviews.length - 2} more`}
            </button>
          )}
        </div>
      )}
      {(insight.reddit?.length ?? 0) > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">On r/berkeley</p>
          <ul className="mt-1 space-y-1">
            {insight.reddit!.map((p) => (
              <li key={p.url} className="text-sm">
                <a href={p.url} target="_blank" rel="noreferrer" className="text-cal-blue hover:underline">
                  {p.title}
                </a>
                <span className="ml-1 text-[11px] text-slate-400">
                  {p.score} points{p.date ? ` · ${p.date.slice(0, 4)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(insight.sources?.length ?? 0) > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
          Sources:
          {insight.sources!.map((s) => (
            <a key={s} href={s} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-cal-blue hover:underline">
              {new URL(s).hostname.replace(/^www\./, "")} <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
        </p>
      )}
    </section>
  );
}
