/**
 * OCR for transcript PDFs that have no usable text. Loaded only when needed (about 7 MB: the
 * Tesseract engine and its compact English model), from this site, and run in a worker in the
 * browser. The transcript is never uploaded.
 *
 * Pages are drawn at 3x and read word by word; the word boxes go through the same layout code as
 * real PDF text, so both paths produce the same lines for the parser.
 */
import { pageLayout, type LayoutLine, type LayoutState, type TextItem } from "./layout";
import type { PdfDocument, PdfJs, PdfPage, PdfReadProgress } from "./pdf";

/** Pixels per PDF point. 3 is about 216 dpi, where 9 pt text reads reliably. */
const SCALE = 3;
const MAX_SIDE = 3000;

interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface OcrLine {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  words: OcrWord[];
}
interface OcrData {
  blocks?: { paragraphs: { lines: OcrLine[] }[] }[] | null;
}

/** Share of the progress bar given to getting the engine and model ready. */
const LOAD_SHARE = 0.25;
/** Start and end of each start-up step within that share, by the engine's status text. */
const LOAD_STEPS: Record<string, [number, number]> = {
  "loading tesseract core": [0, 0.35],
  "initializing tesseract": [0.35, 0.45],
  "loading language traineddata": [0.45, 0.85],
  "loaded language traineddata": [0.85, 0.85],
  "initializing api": [0.85, 1],
  "initialized api": [1, 1],
};

/** WebAssembly SIMD makes recognition about twice as fast; every current browser has it. */
function hasSimd(): boolean {
  try {
    // (module (func (result v128) i32.const 0 i8x16.splat))
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}

/**
 * Draws a page that is made only of filled shapes (text turned into outlines by a print driver).
 * Unlike pdf.js's own renderer this can leave things out: content the PDF marks as an artifact
 * (the driver's watermark stamp, which otherwise covers class rows), and hairline rectangles
 * (link underlines and table borders, which make letters harder to read).
 * Returns false when the page is not of that kind (a scan) and needs the full renderer.
 */
function drawOutlinedPage(
  pdfjs: PdfJs,
  ops: { fnArray: number[]; argsArray: unknown[] },
  ctx: CanvasRenderingContext2D,
  base: number[],
  scale: number,
): boolean {
  const O = pdfjs.OPS;
  // Is the page written in shapes? Count filled paths outside artifacts (the watermark). A scan
  // has a handful at most; a page of outlined text has one per letter. A logo image on such a
  // page is simply left out.
  let artifact = 0;
  const stack: boolean[] = [];
  let fills = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === O.beginMarkedContent || fn === O.beginMarkedContentProps) {
      const isArtifact = (ops.argsArray[i] as unknown[] | null)?.[0] === "Artifact";
      stack.push(isArtifact);
      if (isArtifact) artifact++;
    } else if (fn === O.endMarkedContent) {
      if (stack.pop()) artifact--;
    } else if (artifact === 0 && (fn === O.fill || fn === O.eoFill)) fills++;
  }
  if (fills < 150) return false;

  ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.beginPath();
  artifact = 0;
  stack.length = 0;
  let pathOpen = false;
  const color = (a: unknown[]) =>
    typeof a[0] === "string" ? (a[0] as string) : `rgb(${a[0] as number},${a[1] as number},${a[2] as number})`;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = (ops.argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case O.beginMarkedContent:
      case O.beginMarkedContentProps: {
        const isArtifact = a[0] === "Artifact";
        stack.push(isArtifact);
        if (isArtifact) artifact++;
        break;
      }
      case O.endMarkedContent:
        if (stack.pop()) artifact--;
        break;
      case O.save:
        ctx.save();
        break;
      case O.restore:
        ctx.restore();
        break;
      case O.transform:
        ctx.transform(a[0] as number, a[1] as number, a[2] as number, a[3] as number, a[4] as number, a[5] as number);
        break;
      case O.paintFormXObjectBegin: {
        ctx.save();
        const m = a[0] as number[] | null;
        if (Array.isArray(m) && m.length === 6) ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        break;
      }
      case O.paintFormXObjectEnd:
        ctx.restore();
        break;
      case O.setFillRGBColor:
        ctx.fillStyle = color(a);
        break;
      case O.setStrokeRGBColor:
        ctx.strokeStyle = color(a);
        break;
      case O.setLineWidth:
        ctx.lineWidth = a[0] as number;
        break;
      case O.constructPath: {
        if (!pathOpen) {
          ctx.beginPath();
          pathOpen = true;
        }
        const sub = a[0] as number[];
        const c = a[1] as number[];
        const t = ctx.getTransform();
        const unit = Math.hypot(t.a, t.b) / scale; // page points per path unit
        let j = 0;
        let x = 0;
        let y = 0;
        for (const op of sub) {
          if (op === O.rectangle) {
            x = c[j++];
            y = c[j++];
            const w = c[j++];
            const h = c[j++];
            // Hairlines: link underlines and table borders. Letters such as "l" and "I" are thin
            // rectangles too, but short; a dash is thin and narrow.
            const thin = Math.min(Math.abs(w), Math.abs(h)) * unit < 1.3;
            const long = Math.max(Math.abs(w), Math.abs(h)) * unit;
            if (thin && long > (Math.abs(w) > Math.abs(h) ? 12 : 16)) continue;
            ctx.rect(x, y, w, h);
          } else if (op === O.moveTo) {
            x = c[j++];
            y = c[j++];
            ctx.moveTo(x, y);
          } else if (op === O.lineTo) {
            x = c[j++];
            y = c[j++];
            ctx.lineTo(x, y);
          } else if (op === O.curveTo) {
            ctx.bezierCurveTo(c[j], c[j + 1], c[j + 2], c[j + 3], c[j + 4], c[j + 5]);
            x = c[j + 4];
            y = c[j + 5];
            j += 6;
          } else if (op === O.curveTo2) {
            ctx.bezierCurveTo(x, y, c[j], c[j + 1], c[j + 2], c[j + 3]);
            x = c[j + 2];
            y = c[j + 3];
            j += 4;
          } else if (op === O.curveTo3) {
            ctx.bezierCurveTo(c[j], c[j + 1], c[j + 2], c[j + 3], c[j + 2], c[j + 3]);
            x = c[j + 2];
            y = c[j + 3];
            j += 4;
          } else if (op === O.closePath) {
            ctx.closePath();
          }
        }
        break;
      }
      case O.fill:
      case O.eoFill:
      case O.fillStroke:
      case O.eoFillStroke:
      case O.closeFillStroke:
      case O.closeEOFillStroke:
        if (artifact === 0) ctx.fill(fn === O.eoFill || fn === O.eoFillStroke || fn === O.closeEOFillStroke ? "evenodd" : "nonzero");
        pathOpen = false;
        break;
      case O.stroke:
      case O.closeStroke:
        // strokes on these pages are rules and borders, never letters
        pathOpen = false;
        break;
      case O.endPath:
        pathOpen = false;
        break;
      default:
        break;
    }
  }
  return true;
}

async function renderPage(pdfjs: PdfJs, page: PdfPage): Promise<{ canvas: HTMLCanvasElement; scale: number; height: number }> {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(SCALE, MAX_SIDE / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let drawn = false;
  try {
    const ops = await page.getOperatorList();
    ctx.save();
    drawn = drawOutlinedPage(pdfjs, ops, ctx, viewport.transform as number[], scale);
    ctx.restore();
  } catch {
    drawn = false;
  }
  if (!drawn) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: "#fff" }).promise;
  }
  return { canvas, scale, height: canvas.height };
}

function wordsToItems(data: OcrData, scale: number, height: number): TextItem[] {
  const items: TextItem[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const lineH = Math.max(4, (line.bbox.y1 - line.bbox.y0) / scale);
        const y = (height - line.bbox.y1) / scale;
        for (const w of line.words ?? []) {
          // the stub of a link underline after a word reads as "_"
          const str = w.text.trim().replace(/([A-Za-z0-9)])_+$/, "$1");
          if (!str) continue;
          items.push({ str, x: w.bbox.x0 / scale, y, w: (w.bbox.x1 - w.bbox.x0) / scale, h: Math.min(lineH, 14), conf: w.confidence });
        }
      }
    }
  }
  return items;
}

/** Reads every page with OCR and returns the lines of each page. */
export async function ocrPdfPages(
  pdfjs: PdfJs,
  doc: PdfDocument,
  onProgress?: (p: PdfReadProgress) => void,
): Promise<LayoutLine[][]> {
  const pages = doc.numPages;
  onProgress?.({ stage: "ocr-load", pages, fraction: 0 });
  const { createWorker } = await import("tesseract.js");

  // All three files are emitted by the bundler and served from this origin.
  const workerPath = new URL("tesseract.js/dist/worker.min.js", import.meta.url).toString();
  const corePath = hasSimd()
    ? new URL("tesseract.js-core/tesseract-core-simd-lstm.wasm.js", import.meta.url).toString()
    : new URL("tesseract.js-core/tesseract-core-lstm.wasm.js", import.meta.url).toString();
  const model = new URL("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", import.meta.url).toString();

  let current = 0;
  let loaded = 0;
  const pageFraction = (page: number, within: number) => LOAD_SHARE + (1 - LOAD_SHARE) * ((page - 1 + Math.min(1, Math.max(0, within))) / pages);
  const worker = await createWorker("eng", 1, {
    workerPath,
    corePath,
    // The engine asks for `${langPath}/eng.traineddata.gz`. The bundler gives the model a hashed
    // file name, so the expected name is pushed into the query string, which the server ignores.
    langPath: `${model}?name=`,
    workerBlobURL: false,
    gzip: true,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") {
        if (current > 0) onProgress?.({ stage: "ocr", page: current, pages, fraction: pageFraction(current, m.progress) });
        return;
      }
      // getting ready: engine, then the English model (the download), then start-up
      const step = LOAD_STEPS[m.status];
      if (step) {
        loaded = Math.max(loaded, step[0] + (step[1] - step[0]) * Math.min(1, Math.max(0, m.progress || 0)));
        onProgress?.({ stage: "ocr-load", pages, fraction: loaded * LOAD_SHARE });
      }
    },
  });
  try {
    // One block of text, rows kept as the page has them.
    await worker.setParameters({ tessedit_pageseg_mode: "6" as never, preserve_interword_spaces: "1" });
    const out: LayoutLine[][] = [];
    const state: LayoutState = {};
    for (let p = 1; p <= pages; p++) {
      current = p;
      onProgress?.({ stage: "ocr", page: p, pages, fraction: pageFraction(p, 0) });
      const page = await doc.getPage(p);
      const { canvas, scale, height } = await renderPage(pdfjs, page);
      const result = await worker.recognize(canvas, {}, { text: false, blocks: true });
      out.push(pageLayout(wordsToItems(result.data as unknown as OcrData, scale, height), state));
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    onProgress?.({ stage: "ocr", page: pages, pages, fraction: 1 });
    return out;
  } finally {
    void worker.terminate();
  }
}
