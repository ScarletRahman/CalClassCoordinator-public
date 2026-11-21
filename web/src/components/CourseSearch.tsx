"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { highlightParts, searchCourses, searchIndexFor, type Range } from "@/lib/courseSearch";
import { locationText, type PlanLocation } from "@/lib/planTerms";
import type { Course } from "@/lib/types";

const LIMIT = 10;

function Marked({ text, ranges }: { text: string; ranges: Range[] }) {
  return (
    <>
      {highlightParts(text, ranges).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-cal-gold-100 text-inherit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

const unitsText = (u: number | [number, number]) => (Array.isArray(u) ? `${u[0]}-${u[1]} units` : `${u} unit${u === 1 ? "" : "s"}`);

/**
 * Type-ahead over the catalog. Accepts loose input ("data 100", "cs61a", "r1a", "linear algebra")
 * and lists each cross-listed class once. Classes already in the plan are shown, not hidden, so
 * a search never looks like the class is missing from the catalog.
 */
export default function CourseSearch({
  courses,
  onPick,
  placeholder = "Add a class",
  exclude,
  inPlan,
  onMoveHere,
  here,
  autoFocus,
  label,
}: {
  courses: Course[];
  onPick: (courseId: string) => void;
  placeholder?: string;
  /** Ids that cannot be picked (shown as "Already added"). */
  exclude?: Set<string>;
  /** Ids already in the plan and where. Shown with the reason, and not pickable. */
  inPlan?: Map<string, PlanLocation>;
  /** When given, a class that is already planned elsewhere offers "Move it here". */
  onMoveHere?: (courseId: string) => void;
  /** The term this search adds to: a class already in it is not offered "Move it here". */
  here?: string;
  autoFocus?: boolean;
  /** Accessible name when the placeholder is not descriptive enough. */
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const index = useMemo(() => searchIndexFor(courses), [courses]);
  const result = useMemo(() => searchCourses(q, index, { limit: LIMIT }), [q, index]);

  const rows = useMemo(
    () =>
      result.hits.map((h) => {
        const members = [h.id, ...h.also, ...h.formerly, ...h.sameAs];
        const held = members.find((m) => inPlan?.has(m));
        const loc = held ? inPlan!.get(held)! : undefined;
        const where = held && loc ? locationText(h.id, held, loc) : members.some((m) => exclude?.has(m)) ? "Already added" : undefined;
        return { hit: h, where, held, movable: !!loc && !loc.taken && !!onMoveHere && loc.key !== here };
      }),
    [result, inPlan, exclude, onMoveHere, here],
  );
  const custom = result.custom && !inPlan?.has(result.custom) && !exclude?.has(result.custom) ? result.custom : null;
  // Every row is a stop for the arrow keys, including classes already in the plan, so Enter
  // only ever acts on the row that is highlighted. The "add anyway" row comes last.
  const options = useMemo(() => [...rows.map((r) => r.hit.id), ...(custom ? [custom] : [])], [rows, custom]);
  // Suggestions ("closest MCELLBI classes") are not matches: Enter adds one only after the
  // student has moved to it on purpose.
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setActive(0);
    setArmed(false);
    setNote(null);
  }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (id: string) => {
    onPick(id);
    setQ("");
    setOpen(false);
  };
  /** Enter or click on a row: add it, or say why not. Never falls through to another row. */
  const choose = (id: string | undefined, deliberate: boolean) => {
    if (!id) return;
    if (id === custom) return deliberate || rows.length === 0 ? pick(id) : undefined;
    const row = rows.find((r) => r.hit.id === id);
    if (!row) return;
    if (row.where) return setNote(`${row.hit.id}: ${row.where}.`);
    if (row.hit.suggestion && !deliberate) return setNote(result.missing ? `No ${result.missing}. Pick a suggestion to add it.` : "Pick a suggestion to add it.");
    pick(id);
  };

  const showing = open && q.trim().length > 0;
  const activeId = options[active];
  const optionDomId = (id: string) => `${listId}-${id.replace(/[^A-Za-z0-9]/g, "_")}`;

  return (
    <div ref={boxRef} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        value={q}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing && activeId ? optionDomId(activeId) : undefined}
        aria-label={label ?? placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setArmed(true);
            setActive((a) => Math.min(a + 1, Math.max(0, options.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setArmed(true);
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            if (showing && activeId) {
              e.preventDefault();
              choose(activeId, armed);
            }
          } else if (e.key === "Escape" && showing) {
            // Close the list only; a dialog around us stays open.
            e.preventDefault();
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border-0 bg-white pl-8 pr-2 text-base ring-1 ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cal-blue sm:h-9 sm:text-sm"
      />
      <span className="sr-only" role="status" aria-live="polite">
        {note ?? ""}
      </span>
      {showing && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Matching classes"
          className="thin-scroll absolute left-0 z-30 mt-1 max-h-80 w-full min-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200"
        >
          {result.missing && (
            <li role="presentation" className="border-b border-slate-100 px-3 py-2 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">No {result.missing}.</span>
              {rows.length > 0 && " Closest classes in that subject:"}
            </li>
          )}
          {rows.map(({ hit, where, held, movable }) => {
            const isActive = hit.id === activeId;
            return (
              <li
                key={hit.id}
                id={optionDomId(hit.id)}
                role="option"
                aria-selected={isActive}
                aria-disabled={!!where && !movable}
                onMouseMove={() => {
                  // Only a real pointer move highlights a row: a list opening under a resting pointer must not
                  // change what Enter does, and hovering never arms a suggestion.
                  setActive(options.indexOf(hit.id));
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(hit.id, true)}
                className={`px-3 py-2 text-sm ${where ? "cursor-default" : "cursor-pointer"} ${isActive ? "bg-slate-100" : ""}`}
              >
                <div className={`flex items-baseline gap-2 ${where ? "opacity-60" : ""}`}>
                  <span className="shrink-0 font-semibold text-slate-900">
                    <Marked text={hit.id} ranges={hit.idRanges} />
                    {hit.formerly.length > 0 && <span className="font-normal text-slate-500"> (formerly {hit.formerly.join(", ")})</span>}
                    {hit.sameAs.length > 0 && <span className="font-normal text-slate-500"> (same class as {hit.sameAs.join(", ")})</span>}
                  </span>
                  {!where && <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-500">{unitsText(hit.units)}</span>}
                </div>
                <p className={`truncate text-slate-600 ${where ? "opacity-60" : ""}`}>
                  <Marked text={hit.title} ranges={hit.titleRanges} />
                </p>
                {hit.also.length > 0 && <p className={`truncate text-xs text-slate-500 ${where ? "opacity-60" : ""}`}>also {hit.also.join(", ")}</p>}
                {where && (
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-slate-700">
                    {where}
                    {movable && held && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveHere!(held);
                          setQ("");
                          setOpen(false);
                        }}
                        className="inline-flex min-h-8 items-center rounded-md bg-white px-2 font-semibold text-cal-blue ring-1 ring-blue-200 hover:bg-blue-50"
                      >
                        Move it here
                      </button>
                    )}
                  </p>
                )}
              </li>
            );
          })}
          {result.total > rows.length && (
            <li role="presentation" className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
              Showing {rows.length} of {result.total}
            </li>
          )}
          {custom && (
            <li
              id={optionDomId(custom)}
              role="option"
              aria-selected={custom === activeId}
              onMouseMove={() => {
                // Only a real pointer move highlights a row: a list opening under a resting pointer must not
                // change what Enter does, and hovering never arms a suggestion.
                setActive(options.indexOf(custom));
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(custom)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-slate-600 ${rows.length ? "border-t border-slate-100" : ""} ${custom === activeId ? "bg-slate-100" : ""}`}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Add “{custom}” anyway <span className="text-xs text-slate-400">(not in catalog)</span>
              </span>
            </li>
          )}
          {note && (
            <li role="presentation" className="border-t border-slate-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {note}
            </li>
          )}
          {!rows.length && !custom && !result.missing && (
            <li role="presentation" className="px-3 py-2 text-sm text-slate-500">
              No classes match “{q.trim()}”.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
