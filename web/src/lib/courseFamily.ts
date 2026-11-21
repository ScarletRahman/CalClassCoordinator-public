import { familyOf } from "./crossList";
import type { Course, CourseId } from "./types";

/**
 * Cross-listed classes ("DATA C100", "STAT C100", "COMPSCI C100") are one class. This file is
 * the planner's family-aware layer on top of crossList.ts (which owns the family definition):
 * lookups that fall back to a sibling's data, and a registry for code that has no course index
 * at hand (the plan reducer).
 */

/** Every id of the class `id` belongs to, the given id first. Unknown ids return [id]. */
export function familyMembers(id: CourseId, idx: Map<CourseId, Course>): CourseId[] {
  return familyOf(id, idx);
}

/** The other codes of a class, sorted: "DATA C100" -> ["COMPSCI C100", "STAT C100"]. */
export function alsoListedAs(id: CourseId, idx: Map<CourseId, Course>): CourseId[] {
  return familyMembers(id, idx).slice(1);
}

export function sameClass(a: CourseId, b: CourseId, idx: Map<CourseId, Course>): boolean {
  return a === b || familyMembers(a, idx).includes(b);
}

/**
 * Look a class up in data keyed by course id (predictions, seats, insights), falling back to the
 * other members of its family: predictions.json may list DATA C100 under STAT C100. Returns the
 * id the data was found under so the UI can say so.
 */
export function familyLookup<T>(
  map: { get(id: CourseId): T | undefined },
  id: CourseId,
  idx: Map<CourseId, Course>,
): { value: T; via: CourseId } | undefined {
  for (const m of familyMembers(id, idx)) {
    const v = map.get(m);
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) return { value: v, via: m };
  }
  return undefined;
}

/** Is any code of this class in the set? */
export function familyHas(set: { has(id: CourseId): boolean }, id: CourseId, idx: Map<CourseId, Course>): boolean {
  return familyMembers(id, idx).some((m) => set.has(m));
}

/** Drop later codes of a class already seen, keeping order: one entry per class. */
export function uniqueClasses<T>(items: T[], idOf: (t: T) => CourseId, idx: Map<CourseId, Course>): T[] {
  const seen = new Set<CourseId>();
  return items.filter((it) => {
    const fam = familyMembers(idOf(it), idx);
    if (fam.some((m) => seen.has(m))) return false;
    fam.forEach((m) => seen.add(m));
    return true;
  });
}

// ---- registry for the reducer ----

let registry: Map<CourseId, Course> = new Map();

/** Called once by the planner with the catalog index. Until then every class is its own family. */
export function registerCourseFamilies(idx: Map<CourseId, Course>): void {
  registry = idx;
}

/** Every id of the class (itself first), using the registered index. */
export function familyIds(id: CourseId): CourseId[] {
  return familyMembers(id, registry);
}

/** True when the two ids are the same class (equal or cross-listed), using the registered index. */
export function isSameClass(a: CourseId, b: CourseId): boolean {
  return sameClass(a, b, registry);
}
