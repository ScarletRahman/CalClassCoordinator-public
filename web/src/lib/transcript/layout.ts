/**
 * Turns positioned text (PDF text items, or words from OCR) into lines of text, top to bottom.
 * Pure (no pdf.js), so it is unit-tested and also runs in Node.
 *
 *  - Items are grouped into lines by their y coordinate and sorted by x. Wide gaps become 4 spaces
 *    so the parser can tell table cells apart.
 *  - Under a "Class  Title  Un. ..." or "Course  Description  Attempted ..." header the columns
 *    are known, so a cell that wraps onto a second line ("PBHLTH 126 (Session" / "A)") is put
 *    back together and the class, title and number cells are always separated.
 *  - Pages laid out in two newspaper-style columns are read left column first, then right.
 */

export interface TextItem {
  str: string;
  /** Left edge, in PDF points. */
  x: number;
  /** Baseline, in PDF points (larger is higher on the page). */
  y: number;
  w: number;
  h: number;
  /** OCR confidence 0-100, when the text was recognized from an image. */
  conf?: number;
}

export interface LayoutLine {
  text: string;
  /** Lowest OCR confidence of the words on the line (undefined for real text). */
  conf?: number;
}

/** Column positions of the current class table, carried from page to page. */
export interface LayoutState {
  cols?: { left: number; title: number; nums: number };
}

/** A line that starts a transcript block: a class row or a term heading. */
const ROW_START_RE =
  /^(?:[A-Z][A-Z&,]*(?: [A-Z&][A-Z&,]*){0,3} [A-Z]{0,2}\d{1,3}[A-Z]{0,3}(?: |$)|(?:Fall|Spring|Summer|Winter) \d{4}\b|\d{4} (?:Fall|Spring|Summer|Winter)\b)/;
const TERM_HEADING_RE = /^(?:(?:Fall|Spring|Summer|Winter) \d{4}|\d{4} (?:Fall|Spring|Summer|Winter))\b/i;
const VALUE_RE = /^(?:\d{1,3}(?:\.\d{1,3})?|[A-DFPSUIW][+-]?|NP|IP|NR|[-–—_]+)$/;

function toRows(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    const tol = Math.max(2, Math.min(it.h || 10, row?.[0]?.h || 10) * 0.5);
    if (row && Math.abs(row[0].y - it.y) <= tol) row.push(it);
    else rows.push([it]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

function rowText(row: TextItem[]): string {
  let out = "";
  let prevEnd: number | null = null;
  let prevH = 10;
  for (const it of row) {
    const s = it.str;
    if (!s) continue;
    if (prevEnd !== null) {
      const gap = it.x - prevEnd;
      const fs = Math.max(4, Math.min(prevH, it.h || prevH));
      if (gap > fs * 1.2) out = out.trimEnd() + "    ";
      else if (gap > fs * 0.15 && !out.endsWith(" ") && !s.startsWith(" ")) out += " ";
    }
    out += s;
    prevEnd = it.x + it.w;
    prevH = it.h || prevH;
  }
  return out.trim();
}

const minConf = (row: TextItem[]): number | undefined => {
  const c = row.map((i) => i.conf).filter((v): v is number => v !== undefined);
  return c.length ? Math.min(...c) : undefined;
};

/** "Class  Title  Un.  Gr.  Pts." or "Course  Description  Attempted  Earned  Grade  Points". */
function headerColumns(row: TextItem[]): LayoutState["cols"] | null {
  const a = row.findIndex((i) => /^(class|course)$/i.test(i.str.trim()));
  if (a < 0) return null;
  const b = row.findIndex((i, k) => k > a && /^(title|description)$/i.test(i.str.trim()));
  if (b < 0 || !row[b + 1]) return null;
  return { left: row[a].x, title: row[b].x, nums: row[b + 1].x };
}

interface OpenRow {
  cls: string;
  title: string;
  nums: string[];
  conf?: number;
  /** y of the last line that was folded into this row. */
  y: number;
  h: number;
}

const openRowText = (r: OpenRow) => [r.cls, r.title, ...r.nums].filter((s) => s !== "").join("    ");

function linesOf(items: TextItem[], state: LayoutState): LayoutLine[] {
  const rows = toRows(items);

  // A second column (or a new page) has the same table, shifted sideways.
  if (state.cols) {
    const starts = items.filter((i) => ROW_START_RE.test(i.str.trim())).map((i) => i.x);
    if (starts.length) {
      const dx = Math.min(...starts) - state.cols.left;
      if (Math.abs(dx) > 3) state.cols = { left: state.cols.left + dx, title: state.cols.title + dx, nums: state.cols.nums + dx };
    }
  }

  const out: LayoutLine[] = [];
  let open: OpenRow | null = null;
  const flush = () => {
    if (open) out.push({ text: openRowText(open), ...(open.conf !== undefined ? { conf: open.conf } : {}) });
    open = null;
  };

  for (const row of rows) {
    const header = headerColumns(row);
    if (header) {
      flush();
      state.cols = header;
      out.push({ text: rowText(row) });
      continue;
    }
    const cols = state.cols;
    if (cols) {
      const titleX = cols.title - 2;
      const numX = cols.nums - Math.min(12, (cols.nums - cols.title) * 0.25);
      const cls = row.filter((i) => i.x < titleX);
      const title = row.filter((i) => i.x >= titleX && i.x < numX);
      const nums = row.filter((i) => i.x >= numX);
      const clsText = rowText(cls);
      // the class and the numbers are what must be right; a shaky word in the title is not
      const conf = minConf([...cls, ...nums]) ?? minConf(row);
      const y = row[0].y;
      const h = row[0].h || 10;

      if (cls.length && nums.length && nums.some((i) => VALUE_RE.test(i.str.trim())) && !TERM_HEADING_RE.test(clsText)) {
        // a table row
        flush();
        open = { cls: clsText, title: rowText(title), nums: nums.map((i) => i.str.trim()).filter(Boolean), conf, y, h };
        continue;
      }
      if (
        open &&
        nums.length === 0 &&
        // a wrapped cell stays inside its own column
        cls.every((i) => i.x + i.w <= titleX + 4) &&
        title.every((i) => i.x + i.w <= cols.nums + 4) &&
        open.y - y <= Math.max(open.h, h) * 2.1 &&
        !ROW_START_RE.test(clsText) &&
        !TERM_HEADING_RE.test(clsText) &&
        rowText(row).length <= 80
      ) {
        // the rest of a wrapped cell
        if (cls.length) open.cls = `${open.cls} ${clsText}`.trim();
        if (title.length) open.title = (/[a-z]-$/i.test(open.title) ? open.title + rowText(title) : `${open.title} ${rowText(title)}`).trim();
        if (conf !== undefined) open.conf = open.conf === undefined ? conf : Math.min(open.conf, conf);
        open.y = y;
        continue;
      }
    }
    flush();
    const text = rowText(row);
    if (text) out.push({ text, ...(minConf(row) !== undefined ? { conf: minConf(row) } : {}) });
  }
  flush();
  return out;
}

/** A class row, a term heading, or the first cell of a table header. */
const isColumnStart = (i: TextItem) => ROW_START_RE.test(i.str.trim()) || /^(class|course)$/i.test(i.str.trim());

/**
 * Looks for a vertical gutter near the middle of the page with class rows starting on both
 * sides of it. Returns the x position to split at, or null for a single-column page.
 */
export function findColumnSplit(items: TextItem[]): number | null {
  if (items.length < 16) return null;
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.w));
  const width = maxX - minX;
  if (width < 200) return null;

  // Every x where some line begins a class row or term heading is a candidate column start.
  const lo = minX + width * 0.3;
  const hi = minX + width * 0.7;
  const starts = new Map<number, number>();
  for (const it of items) {
    if (it.x < lo || it.x > hi) continue;
    if (!isColumnStart(it)) continue;
    const key = Math.round(it.x);
    starts.set(key, (starts.get(key) ?? 0) + 1);
  }
  let best: { x: number; n: number } | null = null;
  for (const x of starts.keys()) {
    // merge near-identical left edges
    let total = 0;
    for (const [x2, n2] of starts) if (Math.abs(x2 - x) <= 3) total += n2;
    if (!best || total > best.n) best = { x, n: total };
  }
  if (!best || best.n < 2) return null;
  const split = best.x - 2;

  // It is only a second column if (almost) nothing runs across the split, and the left side
  // has its own rows too.
  const crossing = items.filter((i) => i.x < split - 1 && i.x + i.w > split + 1).length;
  if (crossing > Math.max(3, items.length * 0.04)) return null;
  const leftStarts = items.filter((i) => i.x < split && i.x - minX < width * 0.1 && isColumnStart(i)).length;
  if (leftStarts < 2) return null;
  return split;
}

/** Lines of one page in reading order, with OCR confidence when the items carry it. */
export function pageLayout(items: TextItem[], state: LayoutState = {}): LayoutLine[] {
  const clean = items.filter((i) => i.str && i.str.trim());
  if (!clean.length) return [];
  const split = findColumnSplit(clean);
  if (split === null) return linesOf(clean, state);

  // Anything that runs across the gutter is a full-width heading or footer.
  const full: TextItem[] = [];
  const left: TextItem[] = [];
  const right: TextItem[] = [];
  for (const it of clean) {
    if (it.x < split - 1 && it.x + it.w > split + 1) full.push(it);
    else if (it.x < split) left.push(it);
    else right.push(it);
  }
  // Right-hand items above the first class row on the page belong to the page header (print
  // date, page number), not to the right column, so they are read first.
  const top = Math.max(...[...left, ...right].filter(isColumnStart).map((i) => i.y));
  const above = (i: TextItem) => i.y > top + Math.max(2, (i.h || 10) * 0.5);
  const plain: LayoutState = {};
  return [
    ...linesOf(full.filter(above), plain),
    ...linesOf(right.filter(above), plain),
    ...linesOf(left, state),
    ...linesOf(right.filter((i) => !above(i)), state),
    ...linesOf(full.filter((i) => !above(i)), plain),
  ].filter((l) => l.text);
}

/** Lines of one page in reading order. */
export function pageLines(items: TextItem[], state: LayoutState = {}): string[] {
  return pageLayout(items, state).map((l) => l.text);
}
