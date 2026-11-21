import type { Course, CourseId } from "./types";

/**
 * Cross-listed classes ("DATA C100", "STAT C100", "COMPSCI C100") are one class offered under
 * several subject codes. Everything the student sees should treat the family as a single class.
 */

const familyCache = new WeakMap<Map<CourseId, Course>, Map<CourseId, CourseId[]>>();

/** Union of all cross-list links, in both directions (the data has some one-way links). */
function families(idx: Map<CourseId, Course>): Map<CourseId, CourseId[]> {
  const hit = familyCache.get(idx);
  if (hit) return hit;
  const parent = new Map<CourseId, CourseId>();
  const find = (x: CourseId): CourseId => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: CourseId, b: CourseId) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [key, rec] of idx) {
    union(key, rec.id);
    for (const x of rec.crossListed ?? []) union(rec.id, x);
    // The same class under an old or new number (MATH 1A = MATH 51) is one class too.
    for (const x of rec.sameAs ?? []) union(rec.id, x);
  }
  const byRoot = new Map<CourseId, CourseId[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    byRoot.set(r, [...(byRoot.get(r) ?? []), id]);
  }
  const out = new Map<CourseId, CourseId[]>();
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    members.sort();
    for (const m of members) out.set(m, members);
  }
  familyCache.set(idx, out);
  return out;
}

/** Every id in the cross-list family of `id`, the given id first. Unknown ids return [id]. */
export function familyOf(id: CourseId, idx: Map<CourseId, Course>): CourseId[] {
  const members = families(idx).get(id);
  return members ? [id, ...members.filter((m) => m !== id)] : [id];
}

/** Stable key for a family: its alphabetically first id. Equal for all members. */
export function familyKey(id: CourseId, idx: Map<CourseId, Course>): CourseId {
  return [...familyOf(id, idx)].sort()[0];
}

export function sameFamily(a: CourseId, b: CourseId, idx: Map<CourseId, Course>): boolean {
  return a === b || familyOf(a, idx).includes(b);
}

export interface FamilyEntry {
  /** The id to show and act on: the first member that appeared in the input list. */
  id: CourseId;
  /** Other members of the family, whether or not they were in the input. */
  also: CourseId[];
}

/**
 * Collapse a list of course ids so each cross-list family appears once, keeping input order.
 * `prefer` picks which member represents the family (e.g. the one the student took, or one in
 * the student's own department); by default the first member seen in `ids`.
 */
export function collapseFamilies(
  ids: CourseId[],
  idx: Map<CourseId, Course>,
  prefer?: (members: CourseId[]) => CourseId | undefined,
): FamilyEntry[] {
  const out: FamilyEntry[] = [];
  const done = new Set<CourseId>();
  for (const id of ids) {
    if (done.has(id)) continue;
    const members = familyOf(id, idx);
    members.forEach((m) => done.add(m));
    const rep = prefer?.(members) ?? id;
    out.push({ id: rep, also: members.filter((m) => m !== rep).sort() });
  }
  return out;
}

/** "DATA C100" + ["COMPSCI C100", "STAT C100"] -> "DATA C100 / COMPSCI C100 / STAT C100". */
export function familyLabel(entry: FamilyEntry, max = 3): string {
  const all = [entry.id, ...entry.also];
  return all.length <= max ? all.join(" / ") : `${all.slice(0, max).join(" / ")} +${all.length - max}`;
}

export type SiblingRelation = "crossListed" | "formerly" | "now" | "sameAs";

export interface FamilySibling {
  id: CourseId;
  /**
   * How it relates to the class being shown: offered under another subject at the same time
   * ("crossListed"), its old number ("formerly"), its new number ("now"), or a renumbering
   * where we cannot tell which is newer ("sameAs").
   */
  relation: SiblingRelation;
}

const numberOf = (id: CourseId) => id.split(" ").pop() ?? "";

/** Every other member of the family of `id`, with how it relates to `id`. */
export function siblingsOf(id: CourseId, idx: Map<CourseId, Course>): FamilySibling[] {
  const me = idx.get(id);
  const meRec = me && me.id === id ? me : undefined;
  return familyOf(id, idx)
    .slice(1)
    .sort()
    .map((sib) => {
      const rec = idx.get(sib);
      const sibRec = rec && rec.id === sib ? rec : undefined;
      const linked = (a: Course | undefined, b: CourseId, key: "crossListed" | "sameAs") => !!a?.[key]?.includes(b);
      const cross = linked(meRec, sib, "crossListed") || linked(sibRec, id, "crossListed");
      const renumbered = linked(meRec, sib, "sameAs") || linked(sibRec, id, "sameAs");
      // Linked only through a third class: the same number under another subject is a cross-listing.
      const isCross = cross || (!renumbered && numberOf(sib) === numberOf(id));
      if (isCross) return { id: sib, relation: "crossListed" as const };
      if (sibRec?.retired && !meRec?.retired) return { id: sib, relation: "formerly" as const };
      if (meRec?.retired && !sibRec?.retired) return { id: sib, relation: "now" as const };
      return { id: sib, relation: "sameAs" as const };
    });
}

/** "Also listed as STAT C100. Formerly MATH 1A." Empty string when the class has no siblings. */
export function siblingText(id: CourseId, idx: Map<CourseId, Course>): string {
  const sibs = siblingsOf(id, idx);
  const of = (r: SiblingRelation) => sibs.filter((s) => s.relation === r).map((s) => s.id).join(", ");
  const parts = [
    of("crossListed") && `Also listed as ${of("crossListed")}`,
    of("now") && `Now ${of("now")}`,
    of("formerly") && `Formerly ${of("formerly")}`,
    of("sameAs") && `Same class as ${of("sameAs")}`,
  ].filter(Boolean);
  return parts.join(". ");
}
