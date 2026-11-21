"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { compareTerms, currentTerm, defaultFutureTerms, defaultPastTerms, nextTerm } from "./terms";
import { isSameClass } from "./courseFamily";
import { canonicalPlan, sanitizeState, sanitizeStateReport } from "./sanitizeState";
import type { CourseId, PlannerState, TakenCourse, Term, Year } from "./types";

export const EMPTY_STATE: PlannerState = {
  version: 1,
  majorIds: [],
  minorGroupIds: [],
  year: null,
  startTerm: null,
  taken: [],
  semesters: [],
  manualChecks: {},
  pins: {},
};

export type Action =
  | { type: "replace"; state: PlannerState }
  | { type: "setProfile"; majorIds: string[]; year: Year | null; minorIds?: string[] }
  | { type: "addTaken"; courses: TakenCourse[] }
  | { type: "removeTaken"; course: CourseId }
  /** Change a taken class's term, grade or units. A key set to undefined is cleared. */
  | { type: "updateTaken"; course: CourseId; patch: Partial<Pick<TakenCourse, "term" | "grade" | "units">> }
  /** Move a taken class to another term; no term files it under test and transfer credit. */
  | { type: "setTakenTerm"; course: CourseId; term?: Term }
  /** Set the units of a class, taken or planned (for classes the catalog does not list). */
  | { type: "setUnits"; course: CourseId; units?: number }
  /** One planned class in a term becomes taken in that term. */
  | { type: "markTaken"; term: Term; course: CourseId; grade?: string }
  /** A taken class goes back to planned in the given term. */
  | { type: "unmarkTaken"; course: CourseId; term: Term }
  | { type: "addPlanned"; term: Term; course: CourseId }
  | { type: "removePlanned"; term: Term; course: CourseId }
  | { type: "movePlanned"; from: Term; to: Term; course: CourseId }
  | { type: "setProfessor"; term: Term; course: CourseId; professor?: string }
  | { type: "setSections"; term: Term; course: CourseId; sections: string[] }
  | { type: "addSemester"; term?: Term; summer?: boolean }
  | { type: "removeSemester"; term: Term }
  /** Remove a term entirely: its planned classes and the taken classes recorded in it. */
  | { type: "removeTerm"; term: Term }
  | { type: "markSemesterTaken"; term: Term }
  | { type: "toggleManual"; key: string }
  | { type: "setChoice"; groupId: string; choiceId: string; optionIds: string[] }
  | { type: "reset" };

function sortSemesters(s: PlannerState["semesters"]) {
  return [...s].sort((a, b) => compareTerms(a.term, b.term));
}

/**
 * Cross-listed classes (DATA C100 = STAT C100 = COMPSCI C100) are one class: every action below
 * matches by family, so a plan can never hold two spellings of the same class. Families come
 * from the index the planner registers in courseFamily.ts.
 */
function withoutClass(semesters: PlannerState["semesters"], course: CourseId) {
  return semesters.map((s) =>
    s.courses.some((c) => isSameClass(c.course, course)) ? { ...s, courses: s.courses.filter((c) => !isSameClass(c.course, course)) } : s,
  );
}

export function reducer(state: PlannerState, a: Action): PlannerState {
  switch (a.type) {
    case "replace":
      return { ...EMPTY_STATE, ...a.state, version: 1 };
    case "reset":
      return EMPTY_STATE;
    case "setProfile": {
      let semesters = state.semesters;
      // A new plan starts with the terms the student's year implies they have finished (empty,
      // to fill in), the term they are in now, then the ones still ahead.
      if (!semesters.length && !state.taken.length) semesters = [...defaultPastTerms(a.year), currentTerm(), ...defaultFutureTerms(a.year)].map((term) => ({ term, courses: [] }));
      else if (!semesters.length) semesters = [currentTerm(), ...defaultFutureTerms(a.year)].map((term) => ({ term, courses: [] }));
      return { ...state, majorIds: a.majorIds, minorGroupIds: a.minorIds ?? state.minorGroupIds, year: a.year, semesters };
    }
    case "addTaken": {
      const taken = [...state.taken];
      let semesters = state.semesters;
      for (const c of a.courses) {
        const i = taken.findIndex((t) => isSameClass(t.course, c.course));
        if (i < 0) taken.push(c);
        // Already there under this or a cross-listed code: merge. A transcript knows which code
        // the student enrolled under, so its spelling wins; a hand-added duplicate does not rename.
        else taken[i] = { ...taken[i], ...c, course: c.source === "transcript" ? c.course : taken[i].course };
        // A class that shows up as taken shouldn't also sit in a future semester.
        semesters = withoutClass(semesters, c.course);
      }
      return { ...state, taken, semesters };
    }
    case "removeTaken":
      return { ...state, taken: state.taken.filter((t) => !isSameClass(t.course, a.course)) };
    case "updateTaken":
    case "setTakenTerm": {
      const patch = a.type === "setTakenTerm" ? { term: a.term } : a.patch;
      return {
        ...state,
        taken: state.taken.map((t) => {
          if (!isSameClass(t.course, a.course)) return t;
          const next: TakenCourse = { ...t, ...patch };
          for (const k of ["term", "grade", "units"] as const) if (k in patch && patch[k] === undefined) delete next[k];
          return next;
        }),
      };
    }
    case "setUnits": {
      const set = <T extends { course: CourseId; units?: number }>(c: T): T => {
        if (!isSameClass(c.course, a.course)) return c;
        const next = { ...c, units: a.units };
        if (a.units === undefined) delete next.units;
        return next;
      };
      return { ...state, taken: state.taken.map(set), semesters: state.semesters.map((s) => ({ ...s, courses: s.courses.map(set) })) };
    }
    case "markTaken": {
      const pc = state.semesters.find((s) => s.term === a.term)?.courses.find((c) => isSameClass(c.course, a.course));
      if (!pc) return state;
      const entry: TakenCourse = { course: pc.course, term: a.term, source: "manual", ...(a.grade ? { grade: a.grade } : {}), ...(pc.units !== undefined ? { units: pc.units } : {}) };
      return reducer(state, { type: "addTaken", courses: [entry] });
    }
    case "unmarkTaken": {
      const t = state.taken.find((x) => isSameClass(x.course, a.course));
      if (!t) return state;
      const rest = { ...state, taken: state.taken.filter((x) => x !== t) };
      return reducer(rest, { type: "addPlanned", term: a.term, course: t.course });
    }
    case "addPlanned": {
      if (state.taken.some((t) => isSameClass(t.course, a.course))) return state;
      const exists = state.semesters.some((s) => s.term === a.term);
      const base = exists ? state.semesters : [...state.semesters, { term: a.term, courses: [] }];
      // Keep the instructor choice when the class is already planned in this very term.
      const already = base.find((s) => s.term === a.term)?.courses.find((c) => isSameClass(c.course, a.course));
      if (already) return state;
      const semesters = withoutClass(base, a.course).map((s) => (s.term === a.term ? { ...s, courses: [...s.courses, { course: a.course }] } : s));
      return { ...state, semesters: sortSemesters(semesters) };
    }
    case "removePlanned":
      return {
        ...state,
        semesters: state.semesters.map((s) =>
          s.term === a.term ? { ...s, courses: s.courses.filter((c) => !isSameClass(c.course, a.course)) } : s,
        ),
      };
    case "movePlanned": {
      if (a.from === a.to) return state;
      const found = state.semesters.find((s) => s.term === a.from)?.courses.find((c) => isSameClass(c.course, a.course));
      if (!found) return state;
      // Class numbers belong to one term, so the weekly-schedule section picks do not travel.
      const { sections: _sections, ...moving } = found;
      void _sections;
      const base = state.semesters.some((s) => s.term === a.to) ? state.semesters : [...state.semesters, { term: a.to, courses: [] }];
      const semesters = withoutClass(base, moving.course).map((s) => (s.term === a.to ? { ...s, courses: [...s.courses, moving] } : s));
      return { ...state, semesters: sortSemesters(semesters) };
    }
    case "setProfessor":
      return {
        ...state,
        semesters: state.semesters.map((s) =>
          s.term === a.term
            ? { ...s, courses: s.courses.map((c) => (isSameClass(c.course, a.course) ? { ...c, professor: a.professor } : c)) }
            : s,
        ),
      };
    case "setSections":
      return {
        ...state,
        semesters: state.semesters.map((s) =>
          s.term === a.term
            ? { ...s, courses: s.courses.map((c) => (c.course === a.course ? { ...c, sections: a.sections } : c)) }
            : s,
        ),
      };
    case "addSemester": {
      let term = a.term;
      if (!term) {
        const sorted = sortSemesters(state.semesters);
        const last = sorted.length ? sorted.at(-1)!.term : currentTerm();
        if (a.summer) {
          // First summer from this year on that isn't on the board yet.
          let y = parseInt(currentTerm().split(" ")[0], 10);
          if (compareTerms(`${y} Summer`, currentTerm()) < 0) y++;
          while (state.semesters.some((s) => s.term === `${y} Summer`)) y++;
          term = `${y} Summer`;
        } else {
          term = nextTerm(last);
        }
      }
      if (state.semesters.some((s) => s.term === term)) return state;
      return { ...state, semesters: sortSemesters([...state.semesters, { term, courses: [] }]) };
    }
    case "removeSemester":
      return { ...state, semesters: state.semesters.filter((s) => s.term !== a.term) };
    case "removeTerm":
      return { ...state, semesters: state.semesters.filter((s) => s.term !== a.term), taken: state.taken.filter((t) => t.term !== a.term) };
    case "markSemesterTaken": {
      const sem = state.semesters.find((s) => s.term === a.term);
      if (!sem) return state;
      const add: TakenCourse[] = sem.courses.map((c) => ({ course: c.course, term: a.term, source: "manual" }));
      return reducer({ ...state, semesters: state.semesters.filter((s) => s.term !== a.term) }, { type: "addTaken", courses: add });
    }
    case "toggleManual":
      return { ...state, manualChecks: { ...state.manualChecks, [a.key]: !state.manualChecks[a.key] } };
    case "setChoice": {
      const forGroup = { ...(state.choices?.[a.groupId] ?? {}) };
      if (a.optionIds.length) forGroup[a.choiceId] = [...new Set(a.optionIds)];
      else delete forGroup[a.choiceId];
      return { ...state, choices: { ...(state.choices ?? {}), [a.groupId]: forGroup } };
    }
  }
}

const LS_KEY = "ccc.planner.v1";
/** Sidecar key: the server plan version this browser last saved or saw, shared between tabs. */
const LS_SYNC_KEY = "ccc.planner.v1.sync";
const SAVE_DELAY_MS = 800;
const REFETCH_MIN_GAP_MS = 3000;
export const CONFLICT_NOTICE = "Plan updated in another tab or device. Showing the latest.";
/** A save lost the race: the change made here is gone, so say so. */
export const LOST_CHANGE_NOTICE = "Plan updated in another tab or device. Your last change here wasn't saved.";

export { sanitizeState } from "./sanitizeState";

interface Ctx {
  state: PlannerState;
  dispatch: (a: Action) => void;
  hydrated: boolean;
  /** "local" = browser only, "saved"/"saving"/"error" = account sync status. */
  sync: "local" | "saving" | "saved" | "error";
  /** Call after sign-in: pulls the server copy (or pushes local if the server has none). */
  connectAccount: (signedIn: boolean) => Promise<void>;
  /** Saves any pending change to the account now. Resolves true when the account copy is up to date. */
  flushSave: () => Promise<boolean>;
  /** Try the last failed save again. */
  retrySave: () => Promise<boolean>;
  /**
   * After the server session has ended (sign-out, account deleted): stop syncing, and unless
   * keepLocal, clear the plan from this tab and this browser's storage.
   */
  disconnectAccount: (opts: { keepLocal: boolean }) => void;
}

const PlannerContext = createContext<Ctx | null>(null);

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function lsRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function writeSyncVersion(v: number | null) {
  if (v !== null) lsSet(LS_SYNC_KEY, JSON.stringify({ version: v }));
}

/** Reads a stored plan. "unreadable" covers bad JSON, non-objects and plans from a newer app version. */
function readStored(raw: string): { kind: "ok"; state: PlannerState; dropped: number } | { kind: "unreadable" | "future" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable" };
  }
  const v = (parsed as { version?: unknown } | null)?.version;
  if (parsed && typeof parsed === "object" && v !== undefined && v !== 1) return { kind: "future" };
  const r = sanitizeStateReport(parsed);
  return r.state ? { kind: "ok", state: r.state, dropped: r.dropped } : { kind: "unreadable" };
}

/** The state exactly as the reducer's "replace" would produce it, so comparisons are stable. */
const normalize = (s: PlannerState) => reducer(EMPTY_STATE, { type: "replace", state: s });

export function PlannerProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, EMPTY_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [sync, setSync] = useState<Ctx["sync"]>("local");
  const [notice, setNotice] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const signedInRef = useRef(false);
  /** Server version this tab last saw: null = server has no plan, undefined = not connected. */
  const versionRef = useRef<number | null | undefined>(undefined);
  /** Canonical JSON of what the server holds (as far as this tab knows), and of what localStorage holds. */
  const serverJsonRef = useRef<string | null>(null);
  const localJsonRef = useRef<string | null>(null);
  /** False when stored data could not be moved aside: never write over it. */
  const persistOkRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const lastFetchRef = useRef(0);

  // ---- hydrate from localStorage, never destroying what is there ----
  useEffect(() => {
    const raw = lsGet(LS_KEY);
    if (raw) {
      const r = readStored(raw);
      const backup = () => {
        if (!lsSet(`${LS_KEY}.backup-${Date.now()}`, raw)) persistOkRef.current = false;
      };
      if (r.kind === "ok") {
        if (r.dropped > 0) {
          backup();
          setNotice("Part of your saved plan couldn't be read and was left out. A backup is kept in this browser.");
        }
        const next = normalize(r.state);
        localJsonRef.current = r.dropped > 0 ? null : canonicalPlan(next);
        dispatch({ type: "replace", state: next });
      } else {
        backup();
        setNotice(
          !persistOkRef.current
            ? "Your saved plan couldn't be read and browser storage is full. Changes here won't be saved."
            : r.kind === "future"
              ? "Your saved plan is from a newer version of this site, so a new one was started. Reload to update. A backup is kept."
              : "Your saved plan couldn't be read, so a new one was started. A backup is kept in this browser.",
        );
      }
    }
    setHydrated(true);
  }, []);

  /** Show the server's copy. `conflict` adds the notice when it differs from what is on screen. */
  const adoptServer = useCallback((body: { state?: unknown; version?: unknown }, conflict: boolean | "lost") => {
    const s = sanitizeState(body.state);
    versionRef.current = typeof body.version === "number" ? body.version : s ? 0 : null;
    writeSyncVersion(versionRef.current);
    if (!s) return;
    const next = normalize(s);
    const json = canonicalPlan(next);
    serverJsonRef.current = json;
    if (json !== canonicalPlan(stateRef.current)) {
      dispatch({ type: "replace", state: next });
      if (conflict) setNotice(conflict === "lost" ? LOST_CHANGE_NOTICE : CONFLICT_NOTICE);
    }
  }, []);

  /** Queues one PUT of the latest state; saves run one at a time so a tab never conflicts with itself. */
  const queueSave = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      if (!signedInRef.current) return true;
      const s = stateRef.current;
      const json = canonicalPlan(s);
      if (json === serverJsonRef.current) {
        if (!timerRef.current) setSync("saved");
        return true;
      }
      try {
        const r = await fetch("/api/plan", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: s, baseVersion: versionRef.current ?? null }),
        });
        const body = await r.json().catch(() => null);
        if (!signedInRef.current) return true;
        if (r.status === 409 && body) {
          adoptServer(body, "lost");
          setSync("saved");
          return true;
        }
        if (!r.ok) {
          if (r.status === 401) window.dispatchEvent(new Event("ccc:session-ended"));
          setSync("error");
          return false;
        }
        versionRef.current = typeof body?.version === "number" ? body.version : versionRef.current;
        writeSyncVersion(versionRef.current ?? null);
        serverJsonRef.current = json;
        setSync(timerRef.current || canonicalPlan(stateRef.current) !== json ? "saving" : "saved");
        return true;
      } catch {
        setSync("error");
        return false;
      }
    };
    const p = chainRef.current.then(run, run);
    chainRef.current = p;
    return p;
  }, [adoptServer]);

  // ---- persist locally, and schedule an account save for real changes ----
  useEffect(() => {
    if (!hydrated) return;
    const json = canonicalPlan(state);
    if (persistOkRef.current && json !== localJsonRef.current) {
      if (lsSet(LS_KEY, JSON.stringify(state))) localJsonRef.current = json;
    }
    if (!signedIn || json === serverJsonRef.current) return;
    setSync("saving");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void queueSave();
    }, SAVE_DELAY_MS);
  }, [state, hydrated, signedIn, queueSave]);

  useEffect(() => {
    const timers = timerRef;
    return () => {
      if (timers.current) clearTimeout(timers.current);
    };
  }, []);

  // ---- other tabs: adopt their newer state; their writes never echo back ----
  useEffect(() => {
    if (!hydrated) return;
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea && e.storageArea !== window.localStorage) return;
      if (e.key === LS_SYNC_KEY && e.newValue) {
        try {
          const v = (JSON.parse(e.newValue) as { version?: unknown }).version;
          if (typeof v === "number" && v > (versionRef.current ?? -1) && signedInRef.current) versionRef.current = v;
        } catch {
          /* ignore */
        }
        return;
      }
      if (e.key !== LS_KEY && e.key !== null) return;
      let next: PlannerState;
      if (e.newValue === null || e.key === null) {
        // Another tab cleared the plan (e.g. signed out on a shared computer).
        if (e.key === null && lsGet(LS_KEY)) return;
        next = EMPTY_STATE;
      } else {
        const r = readStored(e.newValue);
        if (r.kind !== "ok") return; // garbage or a newer app version: leave this tab alone
        next = normalize(r.state);
      }
      const json = canonicalPlan(next);
      localJsonRef.current = json;
      if (json !== canonicalPlan(stateRef.current)) dispatch({ type: "replace", state: next });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrated]);

  // ---- signed in: pick up changes from other devices when the tab comes back ----
  useEffect(() => {
    if (!signedIn) return;
    const refetch = async () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchRef.current < REFETCH_MIN_GAP_MS) return;
      // Unsaved edits here go out first; a stale base version then gets a 409 and the latest copy.
      if (timerRef.current || canonicalPlan(stateRef.current) !== serverJsonRef.current) return;
      lastFetchRef.current = Date.now();
      await chainRef.current;
      try {
        const r = await fetch("/api/plan", { cache: "no-store" });
        if (!signedInRef.current) return;
        if (r.status === 401) {
          window.dispatchEvent(new Event("ccc:session-ended"));
          return;
        }
        if (!r.ok) return;
        const body = (await r.json()) as { state?: unknown; version?: number | null };
        if (timerRef.current || canonicalPlan(stateRef.current) !== serverJsonRef.current) return;
        if (typeof body.version === "number" && body.version !== versionRef.current) adoptServer(body, true);
      } catch {
        /* offline: try again next time */
      }
    };
    const onVis = () => void refetch();
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [signedIn, adoptServer]);

  const connectAccount = useCallback(
    async (isSignedIn: boolean) => {
      if (!isSignedIn) {
        signedInRef.current = false;
        versionRef.current = undefined;
        serverJsonRef.current = null;
        setSignedIn(false);
        setSync("local");
        return;
      }
      try {
        const r = await fetch("/api/plan", { cache: "no-store" });
        if (!r.ok) {
          setSync("error");
          return;
        }
        const body = (await r.json()) as { state?: unknown; version?: number | null };
        const server = sanitizeState(body.state);
        const local = stateRef.current;
        const localHasWork = local.majorIds.length > 0 || local.taken.length > 0;
        signedInRef.current = true;
        lastFetchRef.current = Date.now();
        if (server && !(localHasWork && isEmptyPlan(server))) {
          adoptServer(body, false);
          setSync("saved");
        } else {
          versionRef.current = typeof body.version === "number" ? body.version : server ? 0 : null;
          serverJsonRef.current = server ? canonicalPlan(normalize(server)) : localHasWork ? null : canonicalPlan(local);
          setSync(localHasWork ? "saving" : "saved");
          if (localHasWork) void queueSave(); // push what we have
        }
        setSignedIn(true);
      } catch {
        setSync("error");
      }
    },
    [adoptServer, queueSave],
  );

  const flushSave = useCallback(async () => {
    if (!signedInRef.current) return true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await chainRef.current.catch(() => false);
    return queueSave();
  }, [queueSave]);

  const disconnectAccount = useCallback(({ keepLocal }: { keepLocal: boolean }) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    signedInRef.current = false;
    versionRef.current = undefined;
    serverJsonRef.current = null;
    setSignedIn(false);
    setSync("local");
    lsRemove(LS_SYNC_KEY);
    if (!keepLocal) {
      lsRemove(LS_KEY);
      localJsonRef.current = canonicalPlan(EMPTY_STATE);
      dispatch({ type: "replace", state: EMPTY_STATE });
    }
  }, []);

  const value = useMemo(
    () => ({ state, dispatch, hydrated, sync, connectAccount, flushSave, retrySave: flushSave, disconnectAccount }),
    [state, hydrated, sync, connectAccount, flushSave, disconnectAccount],
  );
  return (
    <PlannerContext.Provider value={value}>
      {children}
      {(notice || sync === "error") && (
        <div className="pointer-events-none fixed inset-x-0 top-[64px] z-[29] flex flex-col items-center gap-2 px-4">
          {notice && (
            <div role="status" className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg">
              <span className="min-w-0 flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="-my-1 shrink-0 rounded-lg px-2 py-1 font-medium text-cal-gold hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cal-gold"
              >
                OK
              </button>
            </div>
          )}
          {sync === "error" && (
            <div role="alert" className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-rose-700 px-4 py-2.5 text-sm text-white shadow-lg">
              <span className="min-w-0 flex-1">Couldn&apos;t save to your account. Changes are kept on this device.</span>
              <button
                type="button"
                onClick={() => void flushSave()}
                className="-my-1 shrink-0 rounded-lg bg-white/15 px-3 py-1 font-medium hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </PlannerContext.Provider>
  );
}

function isEmptyPlan(s: PlannerState) {
  return !s.majorIds?.length && !s.taken?.length;
}

export function usePlanner(): Ctx {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error("usePlanner must be used inside PlannerProvider");
  return ctx;
}
