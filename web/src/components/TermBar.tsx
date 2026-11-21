"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronLeft, ChevronRight, GraduationCap, Plus, Sun } from "lucide-react";
import { CREDIT, CREDIT_LABEL, type TermEntry, type TermKey } from "@/lib/planTerms";
import { SEASONS, parseTerm, suggestNextSummer, suggestNextTerm, termLabel, termYearRange, type Season } from "@/lib/terms";
import type { Term } from "@/lib/types";

const unitsLabel = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;

/** What a term's marker says, in words and colour. */
export function termMarker(e: TermEntry): { text: string; tone: "done" | "now" | "enrolling" | "planned" | "review" | "credit" } {
  if (e.phase === "credit") return { text: "Credit", tone: "credit" };
  if (e.phase === "current") return { text: "In progress", tone: "now" };
  if (e.emptyPast) return { text: "Add what you took", tone: "planned" };
  if (e.phase === "enrolling") return { text: "Enrolling", tone: "enrolling" };
  if (e.phase === "future") return { text: "Planned", tone: "planned" };
  if (e.needsReview) return { text: "Needs review", tone: "review" };
  return e.done ? { text: "Done", tone: "done" } : { text: "Past", tone: "planned" };
}

export function MarkerBadge({ entry, onDark }: { entry: TermEntry; onDark?: boolean }) {
  const m = termMarker(entry);
  const cls = {
    done: onDark ? "text-emerald-300" : "text-emerald-700",
    now: onDark ? "text-white" : "text-cal-blue",
    enrolling: onDark ? "text-cal-gold" : "text-amber-700",
    planned: onDark ? "text-blue-200" : "text-slate-600",
    review: onDark ? "text-amber-300" : "text-amber-700",
    credit: onDark ? "text-blue-200" : "text-slate-600",
  }[m.tone];
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`}>
      {m.tone === "done" && <Check className="h-3 w-3" aria-hidden />}
      {m.tone === "review" && <AlertCircle className="h-3 w-3" aria-hidden />}
      {m.tone === "now" && <span className={`h-1.5 w-1.5 rounded-full ${onDark ? "bg-white" : "bg-cal-blue"}`} aria-hidden />}
      {m.tone === "enrolling" && <span className="h-1.5 w-1.5 rounded-full bg-cal-gold" aria-hidden />}
      {m.text}
    </span>
  );
}

/** Season and year selects for choosing any term, past or future. */
export function TermPicker({ value, onChange, existing, idPrefix }: { value: Term; onChange: (t: Term) => void; existing: Term[]; idPrefix: string }) {
  const { year, season } = parseTerm(value);
  // Same reach as the quick-add suggestions, which can run past the default window.
  const years = termYearRange([...existing, value, suggestNextTerm(existing), suggestNextSummer(existing)]);
  const cls = "h-10 rounded-lg border-0 bg-white px-2 text-base ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-cal-blue lg:h-9 lg:text-sm";
  return (
    <div className="flex gap-2">
      <label className="sr-only" htmlFor={`${idPrefix}-season`}>
        Season
      </label>
      <select id={`${idPrefix}-season`} value={season} onChange={(e) => onChange(`${year} ${e.target.value as Season}`)} className={`${cls} flex-1`}>
        {SEASONS.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`${idPrefix}-year`}>
        Year
      </label>
      <select id={`${idPrefix}-year`} value={year} onChange={(e) => onChange(`${e.target.value} ${season}`)} className={`${cls} w-24`}>
        {years.map((y) => (
          <option key={y}>{y}</option>
        ))}
      </select>
    </div>
  );
}

function AddTerm({ existing, hasCredit, onAdd }: { existing: Term[]; hasCredit: boolean; onAdd: (key: TermKey) => void }) {
  const [open, setOpen] = useState(false);
  const next = suggestNextTerm(existing);
  const summer = suggestNextSummer(existing);
  const [custom, setCustom] = useState<Term>(next);
  const boxRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const add = (k: TermKey) => {
    onAdd(k);
    setOpen(false);
  };
  const exists = existing.includes(custom);
  const quick = "inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-slate-50 px-3 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-cal-gold-100 hover:ring-cal-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Add term"
        onClick={() => {
          setCustom(next);
          setOpen((o) => !o);
        }}
        className="inline-flex h-[52px] items-center gap-1 rounded-xl border border-dashed border-slate-400 bg-white/60 px-2.5 text-sm sm:gap-1.5 sm:px-3 font-medium text-slate-700 hover:border-slate-500 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue"
      >
        <Plus className="h-4 w-4" aria-hidden />
        <span className="whitespace-nowrap">
          Add<span className="hidden sm:inline"> term</span>
        </span>
      </button>
      {open && (
        // A bottom sheet on phones, so the Add button is always on screen; a popover from sm up.
        <div role="dialog" aria-label="Add a term" className="fixed inset-x-3 bottom-3 z-40 rounded-2xl bg-white p-3 shadow-2xl ring-1 ring-slate-300 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:w-72">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Quick add</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <button type="button" className={quick} onClick={() => add(next)}>
              {termLabel(next)}
            </button>
            <button type="button" className={quick} onClick={() => add(summer)}>
              <Sun className="h-3.5 w-3.5 text-amber-500" aria-hidden /> {termLabel(summer)}
            </button>
            {!hasCredit && (
              <button type="button" className={quick} onClick={() => add(CREDIT)}>
                <GraduationCap className="h-3.5 w-3.5 text-slate-500" aria-hidden /> {CREDIT_LABEL}
              </button>
            )}
          </div>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Other term</p>
          <form
            className="mt-1.5 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              add(custom);
            }}
          >
            <TermPicker value={custom} onChange={setCustom} existing={existing} idPrefix="add-term" />
            <button type="submit" className="h-10 w-full rounded-lg bg-cal-blue px-3 text-sm font-semibold text-white hover:bg-cal-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue">
              {exists ? `Go to ${termLabel(custom)}` : `Add ${termLabel(custom)}`}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * One tab per term the student has anything in, oldest to newest, with the test and transfer
 * bucket first. Sticks under the page header; scrolls sideways on small screens.
 */
export default function TermBar({
  entries,
  selected,
  onSelect,
  onAdd,
  panelId,
  highlight,
}: {
  entries: TermEntry[];
  selected: TermKey | null;
  onSelect: (key: TermKey) => void;
  /** Add (or jump to) a term. CREDIT opens the credit bucket. */
  onAdd: (key: TermKey) => void;
  panelId: string;
  /** A tab to draw the eye to while it is empty (the credit tab for a new transfer student). */
  highlight?: TermKey | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const existing = entries.filter((e) => e.key !== CREDIT).map((e) => e.key);

  // Which edges have more tabs out of view: drives the fades and the scroll buttons.
  const [more, setMore] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, entries.length]);

  // Keep the selected tab in view (clear of the edge buttons) without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const pad = 44;
    const left = Math.max(0, tab.offsetLeft - pad);
    const right = tab.offsetLeft + tab.offsetWidth + pad;
    if (left < list.scrollLeft) list.scrollTo({ left, behavior: "smooth" });
    else if (right > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right - list.clientWidth, behavior: "smooth" });
  }, [selected, entries.length]);
  const page = (dir: 1 | -1) => listRef.current?.scrollBy({ left: dir * Math.max(160, listRef.current.clientWidth * 0.7), behavior: "smooth" });
  const edgeBtn = "absolute top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white text-slate-700 shadow-md ring-1 ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal-blue";

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = entries.findIndex((x) => x.key === selected);
    let j = -1;
    if (e.key === "ArrowRight") j = Math.min(entries.length - 1, i + 1);
    else if (e.key === "ArrowLeft") j = Math.max(0, i - 1);
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = entries.length - 1;
    if (j < 0 || j === i) return;
    e.preventDefault();
    onSelect(entries[j].key);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <div id="your-terms" tabIndex={-1} className="sticky top-[57px] z-20 -mx-4 border-b border-slate-200/70 bg-[#f6f7fb] px-4 py-2 outline-none sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
      <div className="flex items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          {more.left && (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-[#f6f7fb] to-transparent" aria-hidden />
              <button type="button" tabIndex={-1} aria-label="Show earlier terms" onClick={() => page(-1)} className={`${edgeBtn} left-0`}>
                <ChevronLeft className="h-5 w-5" aria-hidden />
              </button>
            </>
          )}
          {more.right && (
            <>
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-[#f6f7fb] to-transparent" aria-hidden />
              <button type="button" tabIndex={-1} aria-label="Show later terms" onClick={() => page(1)} className={`${edgeBtn} right-0`}>
                <ChevronRight className="h-5 w-5" aria-hidden />
              </button>
            </>
          )}
        <div ref={listRef} role="tablist" aria-label="Your terms" onKeyDown={onKeyDown} onScroll={measure} className="flex gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {entries.map((e) => {
            const on = e.key === selected;
            return (
              <button
                key={e.key}
                type="button"
                role="tab"
                id={`term-tab-${e.key.replace(/\s/g, "-")}`}
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on || (selected === null && e === entries[0]) ? 0 : -1}
                onClick={() => onSelect(e.key)}
                className={`flex h-12 shrink-0 flex-col justify-center rounded-xl px-3 text-left ring-1 transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cal-blue ${
                  on ? "bg-cal-blue text-white shadow-sm ring-cal-blue" : highlight === e.key && e.rows.length === 0 ? "bg-cal-gold-100 text-slate-900 ring-2 ring-cal-gold" : e.emptyPast ? "border border-dashed border-slate-300 bg-white/70 text-slate-700 ring-0 hover:border-slate-500" : "bg-white text-slate-900 ring-slate-200 hover:ring-slate-400"
                }`}
              >
                <span className="flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold leading-tight">
                  {e.key !== CREDIT && e.key.endsWith("Summer") && <Sun className={`h-3.5 w-3.5 ${on ? "text-cal-gold" : "text-amber-500"}`} aria-hidden />}
                  {e.label}
                </span>
                <span className={`flex items-center gap-1.5 whitespace-nowrap text-[11px] leading-tight ${on ? "text-blue-100" : "text-slate-600"}`}>
                  {highlight === e.key && e.rows.length === 0 ? <span className="font-medium">Start here</span> : <MarkerBadge entry={e} onDark={on} />}
                  {!e.emptyPast && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{unitsLabel(e.units)}</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
          {entries.length === 0 && <p className="self-center px-1 text-sm text-slate-600">No terms yet.</p>}
        </div>
        </div>
        <AddTerm existing={existing} hasCredit={entries.some((e) => e.key === CREDIT)} onAdd={onAdd} />
      </div>
    </div>
  );
}
