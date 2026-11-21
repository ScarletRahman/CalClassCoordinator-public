"use client";

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { CourseColor } from "./colors";
import { DAY_LONG, DAY_SHORT, componentName, formatRange, hourLabel, layoutDay, sectionNumber, type Block, type Conflict, type ScheduleSection } from "@/lib/schedule";
import type { CourseId } from "@/lib/types";

const HOUR_PX = 52;
const blockKey = (b: Block) => `${b.course}|${b.classNumber}|${b.section}|${b.day}|${b.startMin}`;

interface Drawn extends Block {
  ghost?: boolean;
}

export default function WeekGrid({
  blocks,
  ghosts,
  conflicts,
  untimed,
  colorOf,
  onBlockClick,
}: {
  blocks: Block[];
  /** Dashed preview of the option under the pointer. */
  ghosts: Block[];
  conflicts: Conflict[];
  untimed: { course: CourseId; section: ScheduleSection }[];
  colorOf: (course: CourseId) => CourseColor;
  onBlockClick: (b: Block) => void;
}) {
  const all: Drawn[] = useMemo(() => [...blocks, ...ghosts.map((g) => ({ ...g, ghost: true }))], [blocks, ghosts]);
  // 8 AM to 6 PM on weekdays, stretched only as far as the blocks (and any preview) need.
  const { days, startHour, endHour } = useMemo(() => {
    const days = [0, 1, 2, 3, 4];
    if (all.some((b) => b.day === 5 || b.day === 6)) days.push(5);
    if (all.some((b) => b.day === 6)) days.push(6);
    const startHour = Math.min(8, ...all.map((b) => Math.floor(b.startMin / 60)));
    const endHour = Math.max(18, ...all.map((b) => Math.ceil(b.endMin / 60)));
    return { days, startHour, endHour };
  }, [all]);
  const clashing = useMemo(() => new Set(conflicts.flatMap((c) => [blockKey(c.a), blockKey(c.b)])), [conflicts]);
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const height = hours.length * HOUR_PX;
  const y = (min: number) => ((min - startHour * 60) / 60) * HOUR_PX;

  return (
    <div>
      <div className="thin-scroll overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="min-w-[500px] [--gutter:2.5rem] sm:[--gutter:3.25rem]">
          <div className="grid border-b border-slate-200" style={{ gridTemplateColumns: `var(--gutter) repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map((d) => (
              <div key={d} className="border-l border-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600">
                <span className="hidden sm:inline">{DAY_LONG[d]}</span>
                <span className="sm:hidden">{DAY_SHORT[d]}</span>
              </div>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateColumns: `var(--gutter) repeat(${days.length}, minmax(0, 1fr))` }}>
            <div className="relative" style={{ height }} aria-hidden>
              {hours.map((h, i) => (
                <span key={h} className="absolute right-1 whitespace-nowrap text-[10px] font-medium tabular-nums text-slate-400 sm:right-1.5" style={{ top: i * HOUR_PX + 2 }}>
                  {hourLabel(h)}
                </span>
              ))}
            </div>
            {days.map((d) => {
              const placed = layoutDay(all.filter((b) => b.day === d));
              return (
                <div
                  key={d}
                  role="group"
                  aria-label={DAY_LONG[d]}
                  className="relative border-l border-slate-100"
                  style={{ height, backgroundImage: "linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)", backgroundSize: `100% ${HOUR_PX}px` }}
                >
                  {placed.map(({ block: b, col, cols }) => {
                    const color = colorOf(b.course);
                    const h = Math.max(20, y(b.endMin) - y(b.startMin) - 1);
                    const bad = !b.ghost && clashing.has(blockKey(b));
                    const narrow = cols > 1;
                    const style = { top: y(b.startMin), height: h, left: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)` };
                    const inner = (
                      <>
                        <span className="flex items-start gap-1">
                          <span className="min-w-0 flex-1 truncate font-semibold">{b.course}</span>
                          {bad && <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-rose-600" aria-hidden />}
                        </span>
                        {h >= 34 && (
                          <span className="block truncate opacity-90">
                            {b.component} {sectionNumber(b)}
                            {!narrow && <span className="hidden xl:inline"> · {formatRange(b.startMin, b.endMin)}</span>}
                          </span>
                        )}
                        {h >= 50 && <span className={`block truncate opacity-75 ${narrow ? "" : "xl:hidden"}`}>{formatRange(b.startMin, b.endMin)}</span>}
                        {h >= 62 && b.location && <span className="block truncate opacity-75">{b.location}</span>}
                      </>
                    );
                    if (b.ghost) {
                      return (
                        <div
                          key={`ghost-${blockKey(b)}`}
                          aria-hidden
                          className={`pointer-events-none absolute z-20 overflow-hidden rounded-md border-2 border-dashed px-1 py-0.5 text-left text-[10px] leading-[13px] tracking-tight sm:px-1.5 sm:text-[11px] sm:leading-[14px] sm:tracking-normal ${color.ghost}`}
                          style={style}
                        >
                          {inner}
                        </div>
                      );
                    }
                    return (
                      <button
                        key={blockKey(b)}
                        type="button"
                        onClick={() => onBlockClick(b)}
                        title={`${b.course} ${b.section}, ${formatRange(b.startMin, b.endMin)}${b.location ? `, ${b.location}` : ""}`}
                        aria-label={`${b.course} ${componentName(b.component)} ${sectionNumber(b)}, ${DAY_LONG[b.day]} ${formatRange(b.startMin, b.endMin, " to ")}${b.location ? `, ${b.location}` : ""}${bad ? ", conflicts with another class" : ""}. Show its options.`}
                        className={`absolute z-10 overflow-hidden rounded-md border-l-4 px-1 py-0.5 text-left text-[10px] leading-[13px] tracking-tight sm:px-1.5 sm:text-[11px] sm:leading-[14px] sm:tracking-normal shadow-sm transition hover:z-30 hover:shadow-md focus:outline-none focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-cal-blue ${color.block} ${bad ? "ring-2 ring-rose-500" : ""}`}
                        style={style}
                      >
                        {inner}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {untimed.length > 0 && (
        <div className="mt-3 rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
          <p className="mb-1 font-semibold text-slate-700">No set time</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {untimed.map(({ course, section }) => (
              <li key={course + section.classNumber + section.section} className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${colorOf(course).dot}`} aria-hidden />
                {course} {componentName(section.component)} {sectionNumber(section)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
