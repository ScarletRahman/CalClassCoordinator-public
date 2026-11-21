"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ClipboardPaste,
  FileUp,
  LoaderCircle,
  Lock,
  Pencil,
  RotateCcw,
  ScanText,
  TriangleAlert,
} from "lucide-react";
import { normalizeCourseId, resolveCourseId } from "@/lib/courseId";
import { NOT_BERKELEY, parseTranscriptText, termSortKey, type ParsedCourse, type ParsedTranscript } from "@/lib/transcript/parse";
import type { PdfReadProgress } from "@/lib/transcript/pdf";

type Bucket = "done" | "ip" | "skip";

interface Row {
  key: string;
  bucket: Bucket;
  course: ParsedCourse;
  /** Why a no-credit attempt is not counted. */
  reason?: string;
  /** Term of the attempt that is counted instead. */
  retakenIn?: string;
  /** The id was fixed by hand in this dialog. */
  edited?: boolean;
}
interface Group {
  id: string;
  title: string;
  hint?: string;
  rows: Row[];
}

const isCreditId = (id: string) => /^(AP|IB) /.test(id);

function rowsOf(r: ParsedTranscript): Row[] {
  let n = 0;
  return [
    ...r.courses.map((c) => ({ key: `r${n++}`, bucket: "done" as const, course: c })),
    ...r.inProgress.map((c) => ({ key: `r${n++}`, bucket: "ip" as const, course: c })),
    ...(r.skipped ?? []).map(({ reason, retakenIn, ...c }) => ({ key: `r${n++}`, bucket: "skip" as const, course: c, reason, retakenIn })),
  ];
}

function groupRows(rows: Row[]): Group[] {
  const byGroup = new Map<string, Row[]>();
  const add = (g: string, row: Row) => byGroup.set(g, [...(byGroup.get(g) ?? []), row]);
  for (const row of rows) {
    const c = row.course;
    if (c.source === "ap") add("ap", row);
    else if (c.source === "transfer") add("transfer", row);
    else if (c.term) add(c.term, row);
    else add("other", row);
  }
  const termIds = [...byGroup.keys()].filter((k) => /^\d{4} /.test(k)).sort((a, b) => termSortKey(a) - termSortKey(b));
  const order = ["ap", "transfer", ...termIds, "other"];
  return order
    .filter((id) => byGroup.has(id))
    .map((id) => ({
      id,
      title: id === "ap" ? "Test credit (AP / IB)" : id === "transfer" ? "Transfer credit" : id === "other" ? "Classes" : termTitle(id),
      hint:
        id === "transfer"
          ? "Check that each one maps to the right Berkeley class."
          : undefined,
      rows: byGroup.get(id)!,
    }));
}

/** "2025 Fall" -> "Fall 2025", the way students say it. */
const termTitle = (t: string) => t.replace(/^(\d{4}) (\w+)$/, "$2 $1");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function TranscriptImport({
  onImport,
  knownCourseIds,
  courseTitles,
}: {
  onImport: (r: ParsedTranscript) => void;
  knownCourseIds?: Set<string>;
  /** Catalog title for a course id. Shown in the review step and used to double-check scanned PDFs. */
  courseTitles?: (id: string) => string | undefined;
}) {
  const uid = useId();
  const [mode, setMode] = useState<"pdf" | "paste">("pdf");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PdfReadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ParsedTranscript | null>(null);
  const [usedOcr, setUsedOcr] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; value: string; error?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const parse = useCallback(
    (text: string, extra: Partial<Parameters<typeof parseTranscriptText>[1]> = {}) =>
      parseTranscriptText(text, { knownCourseIds, titleOf: courseTitles, ...extra }),
    [knownCourseIds, courseTitles],
  );

  const groups = useMemo(() => groupRows(rows), [rows]);
  const isUnknown = useCallback(
    (c: ParsedCourse) => !!knownCourseIds && !isCreditId(c.course) && !knownCourseIds.has(c.course),
    [knownCourseIds],
  );

  const fail = useCallback((message: string, toPaste = false) => {
    setResult(null);
    setRows([]);
    setError(message);
    if (toPaste) setMode("paste");
  }, []);

  const accept = useCallback(
    (r: ParsedTranscript, ocr: boolean) => {
      const all = rowsOf(r);
      if (!all.length) {
        fail(
          ocr
            ? "No classes found in this scanned PDF. Copy your My Academics page from CalCentral and paste it below."
            : "No classes found. Paste your CalCentral Academic Summary, or type one class per line, like COMPSCI 61A.",
          true,
        );
        return;
      }
      setError(null);
      setResult(r);
      setUsedOcr(ocr);
      setRows(all);
      setSelected(new Set(all.filter((x) => x.bucket !== "skip").map((x) => x.key)));
      setShowWarnings(false);
      setEditing(null);
    },
    [fail],
  );

  // Move focus to whatever just appeared, so keyboard and screen-reader users are not left behind.
  useEffect(() => {
    if (result) reviewRef.current?.focus();
  }, [result]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setResult(null);
      setRows([]);
      setFileName(file.name);
      const looksPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!looksPdf) {
        if (file.type.startsWith("text/") || /\.txt$/i.test(file.name)) {
          accept(parse(await file.text()), false);
          return;
        }
        fail(
          file.type.startsWith("image/")
            ? "That's an image. Choose the PDF, or paste the text from CalCentral below."
            : "Choose a PDF of your transcript, or paste its text below.",
          true,
        );
        return;
      }
      setBusy(true);
      setProgress({ stage: "text" });
      try {
        const { readTranscriptPdf } = await import("@/lib/transcript/pdf");
        const read = await readTranscriptPdf(file, {
          hasClasses: (text) => {
            const r = parse(text);
            return r.inProgress.length + r.skipped.length + r.courses.filter((c) => c.source !== "ap").length > 0;
          },
          onProgress: setProgress,
        });
        accept(parse(read.text, read.method === "ocr" ? { ocr: true, lineConfidence: read.lineConfidence } : {}), read.method === "ocr");
      } catch (e) {
        const code = (e as { code?: string })?.code;
        const msg = e instanceof Error ? e.message : "";
        if (code === "password") fail("This PDF is password-protected. Save a copy without a password, or paste the text below.", true);
        else if (code === "not-pdf") fail("That file isn't a PDF. Download it from CalCentral again, or paste the text below.", true);
        else if (code === "no-text") fail(msg, true);
        else fail("Couldn't open that PDF. Download it from CalCentral again, or paste the text below.", true);
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [accept, fail, parse],
  );

  const parsePasted = () => {
    setFileName(null);
    if (!pasted.trim()) {
      setError("Paste your transcript or a list of classes.");
      return;
    }
    accept(parse(pasted), false);
  };

  const reset = () => {
    setResult(null);
    setRows([]);
    setError(null);
    setFileName(null);
    setSelected(new Set());
    setEditing(null);
  };

  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const saveEdit = () => {
    if (!editing) return;
    const typed = editing.value.trim();
    const id = (knownCourseIds && resolveCourseId(typed, knownCourseIds)) || normalizeCourseId(typed);
    if (!id) {
      setEditing({ ...editing, error: "That doesn't look like a class. Type it like COMPSCI 61A or DATA C100." });
      return;
    }
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== editing.key) return r;
        const { needsReview: _n, unknown: _u, printedAs: _p, assumedDone: _a, ...rest } = r.course;
        void _a;
        void _n;
        void _u;
        void _p;
        return { ...r, edited: true, course: { ...rest, course: id } };
      }),
    );
    setEditing(null);
  };

  // counts over what is ticked
  const picked = rows.filter((r) => selected.has(r.key));
  // A class with no grade in a term after this one is planned, not in progress.
  const nowKey = result ? termSortKey(result.currentTerm) : 0;
  const isPlanned = (r: Row) => r.bucket === "ip" && !!r.course.term && termSortKey(r.course.term) > nowKey;
  const isOtherSchool = (c: ParsedCourse) => c.source === "transfer" && c.needsReview === NOT_BERKELEY;
  const nDone = picked.filter((r) => r.bucket !== "ip").length;
  const nPlanned = picked.filter(isPlanned).length;
  const nIp = picked.filter((r) => r.bucket === "ip").length - nPlanned;
  const nSkipped = rows.filter((r) => r.bucket === "skip" && !selected.has(r.key)).length;
  const nUnknown = picked.filter((r) => isUnknown(r.course) && !isOtherSchool(r.course)).length;
  const nCheck = picked.filter((r) => r.course.needsReview && !isOtherSchool(r.course)).length;
  const count = picked.length;

  const submit = () => {
    if (!result) return;
    const clean = ({ needsReview: _n, unknown: _u, printedAs: _p, assumedDone: _a, ...c }: ParsedCourse): ParsedCourse => {
      void _a;
      void _n;
      void _u;
      void _p;
      return c;
    };
    // one entry per class: a row fixed by hand may now repeat another
    const seen = new Set<string>();
    const take = (list: Row[]) =>
      list
        .filter((r) => selected.has(r.key) && !seen.has(r.course.course) && seen.add(r.course.course))
        .map((r) => clean(r.course));
    const courses = take(rows.filter((r) => r.bucket !== "ip"));
    const inProgress = take(rows.filter((r) => r.bucket === "ip"));
    onImport({
      ...result,
      courses,
      inProgress,
      skipped: result.skipped.filter((s) => !courses.some((c) => c.course === s.course && c.term === s.term)),
    });
  };

  const busyText = !progress || progress.stage === "text"
    ? `Reading ${fileName ?? "your transcript"}…`
    : progress.stage === "ocr-load"
      ? "Scanned PDF. Loading text recognition (about 10 seconds the first time)…"
      : (progress.pages ?? 1) > 1
        ? `Reading page ${progress.page ?? 1} of ${progress.pages}…`
        : "Reading the page…";
  const pct = progress?.fraction !== undefined ? Math.round(progress.fraction * 100) : undefined;

  return (
    <div className="text-slate-800">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-slate-600">
          {result ? "Nothing is added until you confirm below." : "Upload your Academic Summary or unofficial transcript from CalCentral."}
        </p>
        {result && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40"
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            Start over
          </button>
        )}
      </div>

      {!result && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Lock className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
          Read in your browser, never uploaded. Only the classes you add are saved.
        </p>
      )}

      {error && (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 focus:outline-none"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {!result && (
        <div className="mt-4">
          {mode === "pdf" ? (
            <div
              role="button"
              tabIndex={busy ? -1 : 0}
              aria-label="Choose your transcript PDF"
              aria-disabled={busy}
              onClick={() => !busy && inputRef.current?.click()}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !busy) {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f && !busy) void handleFile(f);
              }}
              className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-9 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40 ${
                busy ? "cursor-progress border-slate-300 bg-slate-50/60" : "cursor-pointer"
              } ${
                dragging ? "border-[#FDB515] bg-[#FDB515]/10" : "border-slate-300 bg-slate-50/60 hover:border-[#002676]/50 hover:bg-[#002676]/[0.03]"
              }`}
            >
              {busy ? (
                <div role="status" aria-live="polite" className="flex w-full max-w-sm flex-col items-center gap-2">
                  <LoaderCircle className="h-8 w-8 animate-spin text-[#002676] motion-reduce:animate-none" aria-hidden />
                  <p className="text-sm font-medium text-slate-700">{busyText}</p>
                  {progress && progress.stage !== "text" && (
                    <div
                      role="progressbar"
                      aria-label="Reading progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct ?? 0}
                      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
                    >
                      <div className="h-full rounded-full bg-[#002676] transition-[width] duration-300" style={{ width: `${Math.max(4, pct ?? 4)}%` }} />
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#002676]/10">
                    <FileUp className="h-6 w-6 text-[#002676]" aria-hidden />
                  </span>
                  <p className="text-sm font-medium text-slate-800">
                    Drop your PDF here, or <span className="text-[#002676] underline underline-offset-2">choose a file</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    CalCentral: My Academics → Academic Summary → Print → Save as PDF
                  </p>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf,text/plain,.txt"
                className="hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleFile(f);
                }}
              />
            </div>
          ) : (
            <div>
              <label htmlFor={`${uid}-paste`} className="block text-sm font-medium text-slate-800">
                Paste your classes
              </label>
              <p id={`${uid}-paste-help`} className="mt-0.5 text-xs text-slate-500">
                Copy your CalCentral My Academics page, or type a list like the example.
              </p>
              <textarea
                id={`${uid}-paste`}
                aria-describedby={`${uid}-paste-help`}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={8}
                placeholder={"Fall 2025: CS 61A, MATH 1B, ENGLISH R1A\nSpring 2026: CS 61B A-, DATA C8 B+\nAP Calculus BC 5"}
                className="mt-2 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-800 placeholder:text-slate-400 focus:border-[#002676] focus:outline-none focus:ring-2 focus:ring-[#002676]/20"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={parsePasted}
                  className="rounded-lg bg-[#002676] px-4 py-2 text-sm font-semibold text-white hover:bg-[#001a52] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FDB515] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!pasted.trim()}
                >
                  Find my classes
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode(mode === "pdf" ? "paste" : "pdf");
              setError(null);
            }}
            className="mt-3 inline-flex items-center gap-1.5 rounded text-sm font-medium text-[#002676] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40 disabled:opacity-50"
          >
            {mode === "pdf" ? (
              <>
                <ClipboardPaste className="h-4 w-4" aria-hidden /> Paste text instead
              </>
            ) : (
              <>
                <FileUp className="h-4 w-4" aria-hidden /> Upload a PDF instead
              </>
            )}
          </button>
        </div>
      )}

      {result && rows.length > 0 && (
        <div className="mt-4">
          <h3 ref={reviewRef} tabIndex={-1} className="text-sm font-semibold text-slate-900 focus:outline-none">
            Review classes
            {result.studentName && <span className="font-normal text-slate-500"> for {result.studentName}</span>}
          </h3>
          <p className="mt-0.5 text-sm text-slate-600" aria-live="polite">
            <strong className="font-semibold text-slate-900">{plural(nDone, "class", "classes")}</strong> will be marked done
            {nIp > 0 && (
              <>
                , <strong className="font-semibold text-slate-900">{nIp}</strong> in progress
              </>
            )}
            {nPlanned > 0 && (
              <>
                , <strong className="font-semibold text-slate-900">{nPlanned}</strong> planned
              </>
            )}
            {nSkipped > 0 && <>, {nSkipped} not counted</>}
            {result.totalUnits !== undefined && <span className="text-slate-500"> ({result.totalUnits} units on record)</span>}.
          </p>

          {(nCheck > 0 || nUnknown > 0 || usedOcr) && (
            <ul className="mt-2 space-y-1.5 text-xs">
              {usedOcr && (
                <li className="flex items-start gap-2 rounded-lg bg-[#002676]/[0.06] px-3 py-2 text-slate-700">
                  <ScanText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#002676]" aria-hidden />
                  <span>Scanned PDF. Double-check each class, grade and unit count.</span>
                </li>
              )}
              {nCheck > 0 && (
                <li className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {plural(nCheck, "row")} marked <strong className="font-semibold">Check this</strong>.
                  </span>
                </li>
              )}
              {nUnknown > 0 && (
                <li className="flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2 text-slate-700">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
                  <span>
                    {plural(nUnknown, "class", "classes")} not in the catalog. Units still count, but {nUnknown === 1 ? "it" : "they"} may not fill a requirement.
                  </span>
                </li>
              )}
            </ul>
          )}

          {result.unreadLines && result.unreadLines.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-medium">Couldn&apos;t read {plural(result.unreadLines.length, "line")}. Add {result.unreadLines.length === 1 ? "it" : "them"} by hand:</p>
              <ul className="mt-1 space-y-0.5 font-mono">
                {result.unreadLines.map((l, i) => (
                  <li key={i} className="break-words">{l.replace(/\s{2,}/g, "  ")}</li>
                ))}
              </ul>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-700">
              <button
                type="button"
                onClick={() => setShowWarnings((v) => !v)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40"
                aria-expanded={showWarnings}
                aria-controls={`${uid}-notes`}
              >
                <span className="flex-1">{plural(result.warnings.length, "note")}</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${showWarnings ? "rotate-180" : ""}`} aria-hidden />
              </button>
              <ul id={`${uid}-notes`} hidden={!showWarnings} className="list-disc space-y-1 px-8 pb-3 text-xs">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 flex items-center justify-end gap-4 text-xs">
            <button type="button" className="rounded text-[#002676] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40" onClick={() => toggle(rows.filter((r) => r.bucket !== "skip").map((r) => r.key), true)}>
              Select all
            </button>
            <button type="button" className="rounded text-slate-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40" onClick={() => toggle(rows.map((r) => r.key), false)}>
              Select none
            </button>
          </div>

          <div className="mt-1.5 max-h-[26rem] overflow-y-auto rounded-xl border border-slate-200">
            {groups.map((g) => {
              const selectable = g.rows.filter((r) => r.bucket !== "skip").map((r) => r.key);
              const onCount = g.rows.filter((r) => selected.has(r.key)).length;
              const all = selectable.length > 0 && selectable.every((k) => selected.has(k));
              return (
                <section key={g.id} aria-labelledby={`${uid}-g-${g.id}`} className="border-b border-slate-200 last:border-b-0">
                  <header className="sticky top-0 z-10 flex items-center gap-3 bg-slate-50/95 px-3 py-2 backdrop-blur">
                    <input
                      type="checkbox"
                      aria-label={`Select all in ${g.title}`}
                      checked={all}
                      disabled={selectable.length === 0}
                      ref={(el) => {
                        if (el) el.indeterminate = onCount > 0 && !all;
                      }}
                      onChange={() => toggle(selectable, !all)}
                      className="h-4 w-4 shrink-0 rounded border-slate-300 accent-[#002676]"
                    />
                    <h4 id={`${uid}-g-${g.id}`} className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                      {g.title}
                    </h4>
                    <span className="ml-auto text-xs tabular-nums text-slate-500">
                      {onCount} of {g.rows.length}
                    </span>
                  </header>
                  {g.hint && <p className="px-3 pb-1 pt-1.5 text-xs text-slate-500">{g.hint}</p>}
                  <ul>
                    {g.rows.map((row) => {
                      const c = row.course;
                      const on = selected.has(row.key);
                      const other = isOtherSchool(c);
                      const unknown = isUnknown(c) && !other;
                      const planned = isPlanned(row);
                      const catalogTitle = courseTitles?.(c.course);
                      const desc = c.title || catalogTitle || (c.label && c.label !== c.course ? c.label : undefined);
                      const isEditing = editing?.key === row.key;
                      const canEdit = !isCreditId(c.course);
                      const cbId = `${uid}-${row.key}`;
                      const notes: string[] = [];
                      if (row.bucket === "skip") notes.push(row.retakenIn ? `${row.reason}. Your ${termTitle(row.retakenIn)} retake is counted instead.` : `${row.reason}.`);
                      if (c.assumedDone && row.bucket === "done") notes.push("No grade listed. Counted as finished since the term is over.");
                      if (c.needsReview) notes.push(c.needsReview);
                      else if (c.printedAs && c.printedAs !== c.course) notes.push(`Your transcript says ${c.printedAs}. The catalog lists it as ${c.course}.`);
                      if (unknown) notes.push("Not in the catalog. Fix the code with the pencil if it's wrong.");
                      return (
                        <li key={row.key} className={`border-t border-slate-100 px-3 py-2 first:border-t-0 ${on ? "" : "bg-slate-50/60"}`}>
                          <div className="flex items-start gap-3">
                            <input
                              id={cbId}
                              type="checkbox"
                              checked={on}
                              disabled={row.bucket === "skip" && !!row.retakenIn}
                              onChange={() => toggle([row.key], !on)}
                              aria-describedby={notes.length ? `${cbId}-notes` : undefined}
                              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-[#002676]"
                            />
                            <div className="min-w-0 flex-1">
                              {isEditing ? (
                                <form
                                  className="flex flex-wrap items-center gap-2"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    saveEdit();
                                  }}
                                >
                                  <label htmlFor={`${cbId}-edit`} className="sr-only">
                                    Class code for this row
                                  </label>
                                  <input
                                    id={`${cbId}-edit`}
                                    autoFocus
                                    value={editing.value}
                                    onChange={(e) => setEditing({ key: row.key, value: e.target.value })}
                                    onKeyDown={(e) => {
                                      if (e.key === "Escape") {
                                        e.stopPropagation();
                                        setEditing(null);
                                      }
                                    }}
                                    aria-invalid={!!editing.error}
                                    aria-describedby={editing.error ? `${cbId}-edit-err` : undefined}
                                    autoCapitalize="characters"
                                    autoComplete="off"
                                    spellCheck={false}
                                    className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm font-semibold uppercase text-slate-900 focus:border-[#002676] focus:outline-none focus:ring-2 focus:ring-[#002676]/20"
                                  />
                                  <button type="submit" className="rounded-md bg-[#002676] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[#001a52] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FDB515]">
                                    Save
                                  </button>
                                  <button type="button" onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40">
                                    Cancel
                                  </button>
                                  {editing.error && (
                                    <p id={`${cbId}-edit-err`} role="alert" className="w-full text-xs text-red-700">
                                      {editing.error}
                                    </p>
                                  )}
                                </form>
                              ) : (
                                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                  <label htmlFor={cbId} className={`cursor-pointer font-semibold ${on ? "text-slate-900" : "text-slate-500"}`}>
                                    {c.course}
                                  </label>
                                  {canEdit && (
                                    <button
                                      type="button"
                                      onClick={() => setEditing({ key: row.key, value: c.course })}
                                      aria-label={`Fix the class code for ${c.course}`}
                                      title="Fix the class code"
                                      className="-my-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-[#002676] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002676]/40"
                                    >
                                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                                    </button>
                                  )}
                                  {row.bucket === "ip" && !planned && (
                                    <span className="rounded-full bg-[#FDB515]/25 px-2 py-0.5 text-[11px] font-medium text-[#7a5600]">In progress</span>
                                  )}
                                  {planned && (
                                    <span className="rounded-full bg-[#002676]/10 px-2 py-0.5 text-[11px] font-medium text-[#002676]">
                                      Planned for {termTitle(c.term!)}
                                    </span>
                                  )}
                                  {other && (
                                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-300">Other school</span>
                                  )}
                                  {row.bucket === "skip" && (
                                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">Not counted</span>
                                  )}
                                  {c.needsReview && !other && (
                                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">Check this</span>
                                  )}
                                  {unknown && (
                                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-300">Not in catalog</span>
                                  )}
                                  {row.edited && !unknown && (
                                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">Fixed</span>
                                  )}
                                </div>
                              )}
                              {desc && <div className="mt-0.5 break-words text-xs text-slate-500">{desc}</div>}
                              {notes.length > 0 && (
                                <p id={`${cbId}-notes`} className="mt-0.5 text-xs text-slate-600">
                                  {notes.join(" ")}
                                </p>
                              )}
                            </div>
                            <div className="shrink-0 text-right text-xs tabular-nums text-slate-500">
                              {c.grade && (
                                <span className="inline-block min-w-[2rem] rounded-md bg-slate-100 px-1.5 py-0.5 text-center font-medium text-slate-700">
                                  <span className="sr-only">Grade </span>
                                  {c.grade}
                                </span>
                              )}
                              {c.units !== undefined && (
                                <div className="mt-0.5">
                                  {c.units} {c.units === 1 ? "unit" : "units"}
                                </div>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-500">You can edit classes later.</p>
            <button
              type="button"
              onClick={submit}
              disabled={count === 0}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#002676] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#001a52] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FDB515] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-4 w-4" aria-hidden />
              {count === 0 ? "Nothing selected" : `Add ${plural(count, "class", "classes")}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
