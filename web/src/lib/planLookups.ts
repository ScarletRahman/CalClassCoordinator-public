import { familyLookup } from "./courseFamily";
import { forecastAdvice, isoDay, type ForecastAdvice, type LiveSeats } from "./forecast";
import { seatsForInstructor, summarizeInstructors, type InstructorSummary } from "./professors";
import { seatSummary, type PlanData } from "./usePlanData";
import type { CourseId, CourseInsight, Phase, Prediction, SectionSeats } from "./types";

/**
 * Family-aware reads of the per-course data in PlanData. A class added as DATA C100 still gets
 * the forecast, seats and insights filed under STAT C100 or COMPSCI C100 when its own code has
 * none. `via` is the code the data came from.
 */
export function predictionsFor(data: PlanData, id: CourseId): { list: Prediction[]; via: CourseId } {
  const hit = familyLookup(data.predictionsByCourse, id, data.courseIndex);
  return { list: hit?.value ?? [], via: hit?.via ?? id };
}

export function seatsFor(data: PlanData, id: CourseId): { list: SectionSeats[]; via: CourseId } {
  const hit = familyLookup(data.seatsByCourse, id, data.courseIndex);
  return { list: hit?.value ?? [], via: hit?.via ?? id };
}

export function insightFor(data: PlanData, id: CourseId): CourseInsight | undefined {
  return familyLookup(data.insightByCourse, id, data.courseIndex)?.value;
}

/** The instructor picture for a class in the plan: chosen instructor's forecast, or the honest range. */
export function forecastFor(data: PlanData, course: CourseId, professor?: string): InstructorSummary {
  return summarizeInstructors(predictionsFor(data, course).list, professor);
}

/**
 * Time-aware forecast copy for one class, bound to the catalog's phase table and today's date.
 * Live seats for the class (or for the chosen instructor's sections) override the guess.
 */
export type Advisor = (p: Prediction | undefined, course?: CourseId) => ForecastAdvice | null;

export function makeAdvisor(data: PlanData, phases: Phase[] | undefined, today = isoDay(new Date())): Advisor {
  return (p, course) => {
    if (!p) return null;
    let live: LiveSeats | null = null;
    if (course) {
      const sections = seatsFor(data, course).list;
      const mine = p.professor ? seatsForInstructor(sections, p.professor) : null;
      const all = seatSummary(sections);
      live = mine ? { open: mine.open, waitlisted: mine.waitlisted } : all ? { open: all.open, waitlisted: all.waitlisted } : null;
    }
    return forecastAdvice(p, phases ?? [], today, live);
  };
}
