/**
 * Browser-side transcript PDF reading. Nothing leaves the browser: pdf.js, its worker and (only
 * when needed) the OCR engine and its English model are all served from this site.
 *
 *  1. Read the PDF's own text (pdf.js). Line and column reconstruction lives in ./layout.
 *  2. If that text has no class rows, the PDF is a picture of the page: a scan, or a print made
 *     with a driver that turns letters into shapes (PDF-XChange, some "print to PDF" tools), often
 *     with nothing selectable but a watermark. The pages are then drawn and read with OCR (./ocr).
 *
 * pdf.js is imported lazily so this module is safe to import from client components. The
 * "legacy" build is used on purpose: the default build calls Promise.withResolvers and other
 * 2024 APIs with no fallback, which throws on Safari before 17.4 and Chrome before 119.
 */
import { pageLayout, type LayoutLine, type LayoutState, type TextItem } from "./layout";

export class PdfTextError extends Error {
  constructor(
    message: string,
    public readonly code: "not-pdf" | "no-text" | "password" | "unreadable",
  ) {
    super(message);
    this.name = "PdfTextError";
  }
}

export interface PdfReadProgress {
  /** "text": reading the PDF. "ocr-load": getting the reader ready. "ocr": reading a page image. */
  stage: "text" | "ocr-load" | "ocr";
  page?: number;
  pages?: number;
  /** 0 to 1 within the OCR work, when known. */
  fraction?: number;
}

export interface PdfReadResult {
  text: string;
  /** How the text was obtained. */
  method: "text" | "ocr";
  /** OCR confidence per line (0 to 100), for flagging rows that were hard to read. */
  lineConfidence?: Map<string, number>;
  /** Time the OCR took, in milliseconds. */
  ocrMs?: number;
  pages: number;
}

export type PdfJs = typeof import("pdfjs-dist");
export type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
export type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJs>).then((pdfjs) => {
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      }
      return pdfjs;
    });
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

function isPdfBytes(bytes: Uint8Array): boolean {
  // "%PDF" may be preceded by a little junk; check the first 1KB
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF");
}

async function openPdf(file: File | Blob | ArrayBuffer): Promise<{ pdfjs: PdfJs; doc: PdfDocument }> {
  const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (!isPdfBytes(bytes)) throw new PdfTextError("That file isn't a PDF.", "not-pdf");

  let pdfjs: PdfJs;
  try {
    pdfjs = await loadPdfJs();
  } catch {
    throw new PdfTextError("The PDF reader could not load in this browser.", "unreadable");
  }
  try {
    // pdf.js transfers the buffer to its worker, so hand it a copy
    const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    return { pdfjs, doc };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfTextError("This PDF is password-protected.", "password");
    throw new PdfTextError("We couldn't read that PDF.", "unreadable");
  }
}

async function textOf(doc: PdfDocument): Promise<string> {
  const pages: string[] = [];
  const state: LayoutState = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const str = raw.str.replace(/\s+/g, " ");
      if (!str.trim()) continue;
      const [, , , d, x, y] = raw.transform as number[];
      items.push({ str, x, y, w: raw.width, h: raw.height || Math.abs(d) || 10 });
    }
    pages.push(
      pageLayout(items, state)
        .map((l) => l.text)
        .join("\n"),
    );
    page.cleanup();
  }
  return pages.join("\n\n");
}

/** The PDF's own text, in reading order. Throws PdfTextError("no-text") when there is none. */
export async function extractPdfText(file: File | Blob | ArrayBuffer): Promise<string> {
  const { doc } = await openPdf(file);
  try {
    const text = await textOf(doc);
    if (text.replace(/\s/g, "").length < 20) {
      throw new PdfTextError("This PDF has no selectable text (it may be a scan). Paste your transcript text instead.", "no-text");
    }
    return text;
  } finally {
    void doc.destroy();
  }
}

/**
 * Reads a transcript PDF. `hasClasses` decides whether the PDF's own text is usable; a count of
 * characters is not enough, because image-only PDFs often carry a selectable watermark or page
 * footer. When it is not usable, the pages are read with OCR.
 */
export async function readTranscriptPdf(
  file: File | Blob | ArrayBuffer,
  options: { hasClasses: (text: string) => boolean; onProgress?: (p: PdfReadProgress) => void },
): Promise<PdfReadResult> {
  const { pdfjs, doc } = await openPdf(file);
  try {
    options.onProgress?.({ stage: "text", pages: doc.numPages });
    const text = await textOf(doc);
    if (options.hasClasses(text)) return { text, method: "text", pages: doc.numPages };

    const started = Date.now();
    let lines: LayoutLine[][];
    try {
      const { ocrPdfPages } = await import("./ocr");
      lines = await ocrPdfPages(pdfjs, doc, options.onProgress);
    } catch (e) {
      if (e instanceof PdfTextError) throw e;
      throw new PdfTextError(
        "This PDF is a picture of your transcript, and we couldn't read it in this browser. Paste the text from CalCentral instead.",
        "no-text",
      );
    }
    const lineConfidence = new Map<string, number>();
    for (const l of lines.flat()) {
      if (l.conf === undefined) continue;
      const key = l.text.trim();
      lineConfidence.set(key, Math.min(lineConfidence.get(key) ?? 100, l.conf));
    }
    return {
      text: lines.map((pg) => pg.map((l) => l.text).join("\n")).join("\n\n"),
      method: "ocr",
      lineConfidence,
      ocrMs: Date.now() - started,
      pages: doc.numPages,
    };
  } finally {
    void doc.destroy();
  }
}
