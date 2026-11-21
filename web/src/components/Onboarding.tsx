"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, GraduationCap, Info, Search, X } from "lucide-react";
import { collegeShortLabel, searchPrograms, type SearchableProgram } from "@/lib/majorSearch";
import type { Catalog, College, Year } from "@/lib/types";

const YEARS: Year[] = ["Freshman", "Sophomore", "Junior", "Senior", "Transfer (Junior)", "Fifth year+"];
const MAX_MAJORS = 3;
const MAX_MINORS = 3;

const TYPE_LABEL: Record<string, string> = {
  "joint-major": "Joint major",
  "dual-degree": "Dual degree",
  "simultaneous-degree": "Simultaneous degree",
};

type Program = SearchableProgram & { id: string };

/**
 * Search-and-tick list for majors or minors. Whatever is ticked stays in view: as chips above
 * the search box and as the first rows of the list, whatever the search or college filter says.
 */
function ProgramPicker<T extends Program>({
  noun,
  items,
  colleges = [],
  selected,
  onChange,
  max,
  examples,
  listWhenEmpty,
}: {
  noun: "major" | "minor";
  items: T[];
  colleges?: College[];
  selected: string[];
  onChange: (ids: string[]) => void;
  max: number;
  examples: string;
  /** Show the whole list before anything is typed (majors) or wait for a search (minors). */
  listWhenEmpty: boolean;
}) {
  const [q, setQ] = useState("");
  const [college, setCollege] = useState("all");
  const [active, setActive] = useState(0);
  const [nudge, setNudge] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const chosen = selected.map((id) => byId.get(id)).filter((m): m is T => !!m);
  const atCap = chosen.length >= max;
  const query = q.trim();
  const searching = !!query || college !== "all";

  const hits = useMemo(() => {
    const pool = college === "all" ? items : items.filter((m) => m.college === college);
    return searchPrograms(query, pool, colleges);
  }, [items, colleges, query, college]);

  // Ticked programs first, always. Then the matches that are not ticked.
  const rows = useMemo(() => {
    const tagOf = new Map(hits.map((h) => [h.item.id, h.tag]));
    const picked = chosen.map((item) => ({ item, tag: tagOf.get(item.id), on: true }));
    const showRest = listWhenEmpty || !!query;
    const rest = showRest ? hits.filter((h) => !selected.includes(h.item.id)).map((h) => ({ item: h.item, tag: h.tag, on: false })) : [];
    return [...picked, ...rest];
    // `chosen` is derived from `selected` and `byId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, selected, byId, listWhenEmpty, query]);
  const matchCount = hits.length;
  const firstMatch = chosen.length;

  // Start the keyboard cursor on the best match, not on an already ticked row.
  useEffect(() => {
    setActive(rows.length > firstMatch ? firstMatch : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, college]);
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(false), 2500);
    return () => clearTimeout(t);
  }, [nudge]);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (atCap) setNudge(true);
    else onChange([...selected, id]);
  };

  const move = (to: number) => {
    if (!rows.length) return;
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setActive(next);
    listRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(active - 1);
    } else if (e.key === "Home" && rows.length) {
      e.preventDefault();
      move(0);
    } else if (e.key === "End" && rows.length) {
      e.preventDefault();
      move(rows.length - 1);
    } else if (e.key === "Enter" && rows[active]) {
      e.preventDefault();
      toggle(rows[active].item.id);
    } else if (e.key === "Escape" && q) {
      e.preventDefault();
      e.stopPropagation();
      setQ("");
    }
  };

  const plural = `${noun}s`;
  const countText = !query && college === "all" ? `${items.length} ${plural}` : `${matchCount} ${matchCount === 1 ? noun : plural} ${matchCount === 1 ? "matches" : "match"}`;
  const showList = rows.length > 0 || !!query || (listWhenEmpty && searching);
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div>
      {chosen.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Your ${plural}`}>
          {chosen.map((m) => (
            <li key={m.id}>
              <span className="inline-flex min-h-10 items-center gap-1 rounded-full bg-cal-gold-100 py-1 pl-3 pr-1 text-sm font-medium text-slate-900 ring-1 ring-cal-gold">
                <Check className="h-3.5 w-3.5 shrink-0 text-cal-blue" aria-hidden />
                <span>
                  {m.name}
                  {m.degree && <span className="font-normal text-slate-600"> {m.degree}</span>}
                </span>
                <button
                  onClick={() => toggle(m.id)}
                  aria-label={`Remove ${m.name}${m.degree ? ` ${m.degree}` : ""}`}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-600 hover:bg-white hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {atCap && (
        <p
          role="status"
          className={`mt-2 flex items-start gap-1.5 rounded-xl px-3 py-2 text-xs ring-1 transition-colors ${
            nudge ? "bg-amber-100 text-amber-900 ring-amber-300" : "bg-slate-50 text-slate-600 ring-slate-200"
          }`}
        >
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Up to {max} {plural}. Remove one to pick another.
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && rows[active] ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-label={`Search ${plural}`}
            placeholder={`Search ${plural}, e.g. ${examples}`}
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full rounded-xl border-0 bg-slate-50 pl-9 pr-10 text-sm ring-1 ring-slate-200 placeholder:text-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-cal-blue"
          />
          {q && (
            <button
              onClick={() => {
                setQ("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-lg text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </label>
        {colleges.length > 0 && (
          <select
            value={college}
            onChange={(e) => setCollege(e.target.value)}
            aria-label="Filter by college"
            className="h-11 rounded-xl border-0 bg-slate-50 px-3 text-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-cal-blue sm:max-w-56"
          >
            <option value="all">All colleges</option>
            {colleges.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {(listWhenEmpty || !!query) && (
        <p className="mt-2 flex items-center justify-between gap-3 px-1 text-xs text-slate-600" aria-live="polite">
          <span>{countText}</span>
          <span className="hidden sm:inline">↑↓ to move, Enter to pick</span>
        </p>
      )}

      {showList && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={plural[0].toUpperCase() + plural.slice(1)}
          className="thin-scroll mt-1.5 max-h-72 overflow-y-auto rounded-xl ring-1 ring-slate-200"
        >
          {rows.map(({ item: m, tag, on }, i) => {
            const blocked = !on && atCap;
            const typeLabel = m.programType && m.programType !== "major" ? TYPE_LABEL[m.programType] ?? m.programType.replace(/-/g, " ") : null;
            const collegeLabel = collegeShortLabel(m.college, colleges);
            return (
              <div key={m.id}>
                {searching && i === 0 && firstMatch > 0 && <p className="bg-slate-50 px-4 py-1 text-[11px] font-medium text-slate-600">Already picked</p>}
                {searching && i === firstMatch && firstMatch > 0 && rows.length > firstMatch && (
                  <p className="border-t border-slate-100 bg-slate-50 px-4 py-1 text-[11px] font-medium text-slate-600">Matches</p>
                )}
                <div
                  id={optionId(i)}
                  data-row={i}
                  role="option"
                  aria-selected={on}
                  aria-disabled={blocked || undefined}
                  onClick={() => {
                    setActive(i);
                    toggle(m.id);
                  }}
                  onMouseMove={() => active !== i && setActive(i)}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2 text-left text-sm last:border-0 ${
                    on ? "bg-cal-gold-100" : i === active ? "bg-slate-100" : "bg-white"
                  } ${i === active ? "ring-2 ring-inset ring-cal-blue/60" : ""} ${blocked ? "opacity-55" : ""}`}
                >
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ring-1 ${on ? "bg-cal-blue text-white ring-cal-blue" : "bg-white ring-slate-300"}`} aria-hidden>
                    {on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-slate-900">{m.name}</span>
                    {m.degree && <span className="text-slate-600"> {m.degree}</span>}
                    {tag && (
                      <span className="ml-2 inline-block rounded-md bg-slate-100 px-1.5 py-0.5 align-middle text-[11px] font-medium text-slate-600 ring-1 ring-slate-200" title={`Matches "${tag}"`}>
                        {tag}
                      </span>
                    )}
                    {typeLabel && <span className="block text-xs text-slate-600">{typeLabel}</span>}
                  </span>
                  {collegeLabel && <span className="shrink-0 text-right text-xs text-slate-600">{collegeLabel}</span>}
                </div>
              </div>
            );
          })}
          {matchCount === 0 && searching && (
            <div className={`px-4 py-4 text-sm text-slate-600 ${rows.length ? "border-t border-slate-100" : ""}`}>
              <p className="font-medium text-slate-800">{query ? <>No {plural} match &ldquo;{query}&rdquo;</> : `No ${plural} in this college`}</p>
              <p className="mt-0.5 text-xs text-slate-600">Try a shorthand like {examples}.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {query && (
                  <button onClick={() => setQ("")} className="min-h-10 rounded-lg bg-white px-3 text-xs font-semibold text-cal-blue ring-1 ring-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue">
                    Clear search
                  </button>
                )}
                {college !== "all" && (
                  <button onClick={() => setCollege("all")} className="min-h-10 rounded-lg bg-white px-3 text-xs font-semibold text-cal-blue ring-1 ring-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue">
                    Search all colleges
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Onboarding({
  catalog,
  initialMajorIds = [],
  initialYear = null,
  initialMinorIds = [],
  onDone,
  onCancel,
}: {
  catalog: Catalog;
  initialMajorIds?: string[];
  initialYear?: Year | null;
  initialMinorIds?: string[];
  onDone: (majorIds: string[], year: Year | null, minorIds: string[]) => void;
  onCancel?: () => void;
}) {
  const [majorIds, setMajorIds] = useState<string[]>(initialMajorIds);
  const [year, setYear] = useState<Year | null>(initialYear);
  const [minorIds, setMinorIds] = useState<string[]>(initialMinorIds);
  const editing = initialMajorIds.length > 0;
  const yearRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Radio group keyboard pattern: one tab stop, arrows move and select.
  const onYearKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? YEARS.length - 1 : step ? (i + step + YEARS.length) % YEARS.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setYear(YEARS[to]);
    yearRefs.current[to]?.focus();
  };
  const yearTabStop = year ? YEARS.indexOf(year) : 0;

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-8">
      <div className="flex items-start gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-cal-blue text-cal-gold">
          <GraduationCap className="h-6 w-6" aria-hidden />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{editing ? "Edit your majors and year" : "Set up your plan"}</h1>
          <p className="mt-0.5 text-sm text-slate-600">
            {editing ? "Your classes stay as they are." : "Pick your year and major to load your requirements."}
          </p>
        </div>
        {onCancel && (
          <button onClick={onCancel} aria-label="Close" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue">
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>

      <h2 className="mt-6 text-sm font-semibold text-slate-800">Year</h2>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Year">
        {YEARS.map((y, i) => (
          <button
            key={y}
            ref={(el) => {
              yearRefs.current[i] = el;
            }}
            role="radio"
            aria-checked={year === y}
            tabIndex={i === yearTabStop ? 0 : -1}
            onKeyDown={(e) => onYearKey(e, i)}
            onClick={() => setYear(y)}
            className={`min-h-10 rounded-full px-3.5 text-sm ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue focus-visible:ring-offset-1 ${
              year === y ? "bg-cal-blue text-white ring-cal-blue" : "bg-white text-slate-700 ring-slate-200 hover:ring-slate-400"
            }`}
          >
            {y}
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-800">
          Major <span className="font-normal text-slate-600">(up to {MAX_MAJORS})</span>
        </h2>
        <span className="shrink-0 text-xs tabular-nums text-slate-600">
          {majorIds.length} of {MAX_MAJORS}
        </span>
      </div>
      <ProgramPicker noun="major" items={catalog.majors} colleges={catalog.colleges} selected={majorIds} onChange={setMajorIds} max={MAX_MAJORS} examples="cs, cogsci or econ" listWhenEmpty />

      {catalog.minors.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-slate-800">
            Minors <span className="font-normal text-slate-600">(optional, up to {MAX_MINORS})</span>
          </h2>
          <ProgramPicker noun="minor" items={catalog.minors} selected={minorIds} onChange={setMinorIds} max={MAX_MINORS} examples="ds, stats or gpp" listWhenEmpty={false} />
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-600">{majorIds.length ? "You can change this later." : "Pick a major to continue."}</p>
        <button
          disabled={!majorIds.length}
          onClick={() => onDone(majorIds, year, minorIds)}
          className="min-h-11 shrink-0 rounded-xl bg-cal-blue px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-cal-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cal-blue focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {initialMajorIds.length ? "Save" : "Continue"}
        </button>
      </div>
    </div>
  );
}
