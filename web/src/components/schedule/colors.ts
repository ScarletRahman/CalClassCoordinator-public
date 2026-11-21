/** One colour per class on the weekly calendar. Rose is left out: it marks conflicts. */
export interface CourseColor {
  /** Calendar block. */
  block: string;
  /** Dashed preview block. */
  ghost: string;
  /** Small dot and the card's left edge. */
  dot: string;
  edge: string;
}

export const COURSE_COLORS: CourseColor[] = [
  { block: "bg-blue-100 border-blue-600 text-blue-950", ghost: "bg-blue-50/80 border-blue-600 text-blue-900", dot: "bg-blue-600", edge: "border-l-blue-600" },
  { block: "bg-amber-100 border-amber-500 text-amber-950", ghost: "bg-amber-50/80 border-amber-500 text-amber-900", dot: "bg-amber-500", edge: "border-l-amber-500" },
  { block: "bg-emerald-100 border-emerald-600 text-emerald-950", ghost: "bg-emerald-50/80 border-emerald-600 text-emerald-900", dot: "bg-emerald-600", edge: "border-l-emerald-600" },
  { block: "bg-violet-100 border-violet-600 text-violet-950", ghost: "bg-violet-50/80 border-violet-600 text-violet-900", dot: "bg-violet-600", edge: "border-l-violet-600" },
  { block: "bg-pink-100 border-pink-600 text-pink-950", ghost: "bg-pink-50/80 border-pink-600 text-pink-900", dot: "bg-pink-600", edge: "border-l-pink-600" },
  { block: "bg-cyan-100 border-cyan-600 text-cyan-950", ghost: "bg-cyan-50/80 border-cyan-600 text-cyan-900", dot: "bg-cyan-600", edge: "border-l-cyan-600" },
  { block: "bg-orange-100 border-orange-600 text-orange-950", ghost: "bg-orange-50/80 border-orange-600 text-orange-900", dot: "bg-orange-600", edge: "border-l-orange-600" },
  { block: "bg-lime-100 border-lime-600 text-lime-950", ghost: "bg-lime-50/80 border-lime-600 text-lime-900", dot: "bg-lime-600", edge: "border-l-lime-600" },
];

export const colorAt = (index: number): CourseColor => COURSE_COLORS[((index % COURSE_COLORS.length) + COURSE_COLORS.length) % COURSE_COLORS.length];
