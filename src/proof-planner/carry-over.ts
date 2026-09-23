import { compareOrdinal, type EvidenceBinding, sortedUnique } from "./model.js";
import {
  type AssurancePlan,
  type EvidenceRequirement,
  isUnresolvedSignal,
  type PlanSurface,
  type SignalClassification,
} from "./plan.js";

export interface CarryOverEntry {
  kind: string;
  binding: EvidenceBinding;
  surfaces: string[];
  reason: string;
}

/**
 * Which required evidence of `next` may reuse evidence produced for `previous`, and which must be
 * produced again. The planner states the admissibility rule; AssertLedger must still check that
 * the reused evidence exists and carries the listed digests.
 */
export interface EvidenceCarryOver {
  previousRevision: string;
  nextRevision: string;
  reusable: CarryOverEntry[];
  mustProduce: CarryOverEntry[];
}

export function carryOverEvidence(previous: AssurancePlan, next: AssurancePlan): EvidenceCarryOver {
  const reusable: CarryOverEntry[] = [];
  const mustProduce: CarryOverEntry[] = [];
  const sameBaseline = previous.subject.baseline === next.subject.baseline;
  const sameRevision = previous.subject.revision === next.subject.revision;
  const runtimeTree = sameRuntimeTree(previous, next);
  // Evidence never crosses to another revision on the surfaces that a signal unresolved on either
  // side may concern: one observed beside it, or one that contradicts it on the next revision.
  // The planner uses the same notion of "unresolved".
  const unresolved = sameRevision
    ? []
    : [previous, next].flatMap((plan) =>
        plan.signals.filter(isUnresolvedSignal).map((signal) => ({
          id: signal.id,
          surfaces: concernedSurfaces(plan, signal),
        })),
      );
  const unresolvedOn = (surface: string | null): string | null => {
    const blocking = unresolved.filter(
      (entry) => surface === null || entry.surfaces === null || entry.surfaces.has(surface),
    );
    return blocking.length > 0
      ? `a signal is unresolved (${sortedUnique(blocking.map((entry) => entry.id)).join(", ")})`
      : null;
  };

  for (const requirement of next.requiredEvidence) {
    const earlier = previous.requiredEvidence.find(
      (candidate) =>
        candidate.kind === requirement.kind &&
        candidate.semanticDigest === requirement.semanticDigest,
    );
    const entry = (surfaces: string[], reason: string): CarryOverEntry => ({
      kind: requirement.kind,
      binding: requirement.binding,
      surfaces: sortedUnique(surfaces),
      reason,
    });
    if (!earlier) {
      mustProduce.push(entry(requirement.surfaces, "not required with the same meaning before"));
      continue;
    }
    if (!sameBaseline) {
      mustProduce.push(entry(requirement.surfaces, "the merge-base changed"));
      continue;
    }
    if (requirement.binding === "runtime-tree") {
      const blocker = runtimeTree ? unresolvedOn(null) : "runtime tree changed or unknown";
      if (blocker === null) reusable.push(entry(requirement.surfaces, "runtime tree unchanged"));
      else mustProduce.push(entry(requirement.surfaces, blocker));
      continue;
    }
    // Revision-wide evidence: exact-revision kinds, and surface-content kinds without a scope.
    if (requirement.binding === "exact-revision" || requirement.surfaces.length === 0) {
      if (sameRevision) reusable.push(entry(requirement.surfaces, "same revision"));
      else mustProduce.push(entry(requirement.surfaces, "bound to the exact revision"));
      continue;
    }
    const kept: string[] = [];
    const changed = new Map<string, string[]>();
    for (const surface of requirement.surfaces) {
      const reason =
        surfaceReuseBlocker(previous, next, requirement, earlier, surface, runtimeTree) ??
        unresolvedOn(surface);
      if (reason === null) kept.push(surface);
      else changed.set(reason, [...(changed.get(reason) ?? []), surface]);
    }
    if (kept.length > 0) reusable.push(entry(kept, "scoped surfaces and their tests unchanged"));
    for (const [reason, surfaces] of changed) mustProduce.push(entry(surfaces, reason));
  }
  const order = (left: CarryOverEntry, right: CarryOverEntry) =>
    compareOrdinal(`${left.kind}|${left.reason}`, `${right.kind}|${right.reason}`);
  return {
    previousRevision: previous.subject.revision,
    nextRevision: next.subject.revision,
    reusable: reusable.sort(order),
    mustProduce: mustProduce.sort(order),
  };
}

/**
 * Surfaces an unresolved signal may concern, or null for all of them. A failing proof surface
 * concerns what it exercises; a failure that cannot be mapped, an execution context, or a proof
 * surface that does not list what it exercises, concerns everything.
 */
function concernedSurfaces(plan: AssurancePlan, signal: SignalClassification): Set<string> | null {
  if (signal.surfaces.length === 0) return null;
  const concerned = new Set(signal.surfaces);
  for (const id of signal.surfaces) {
    const known = plan.subject.surfaces.find((entry) => entry.id === id);
    if (!known || known.role === "execution-context") return null;
    if (known.role !== "test" && known.role !== "proof-infrastructure") continue;
    if (known.exercises === null) return null;
    for (const exercised of known.exercises) concerned.add(exercised);
  }
  return concerned;
}

function sameRuntimeTree(previous: AssurancePlan, next: AssurancePlan): boolean {
  const before = previous.subject.runtimeTreeDigest;
  const after = next.subject.runtimeTreeDigest;
  return before !== null && after !== null && before === after;
}

/**
 * Only documentation-only evidence about a documentation surface ignores the runtime tree. A gate
 * delta review justifies a budget with durations measured on the code the gate runs, and a
 * documentation claim scoped to a runtime surface describes that surface's behavior.
 */
function dependsOnRuntimeTree(requirement: EvidenceRequirement, surface: PlanSurface): boolean {
  return (
    surface.role !== "documentation" ||
    !requirement.subjects.every((subject) => subject === "documentation")
  );
}

function surfaceReuseBlocker(
  previous: AssurancePlan,
  next: AssurancePlan,
  requirement: EvidenceRequirement,
  earlier: EvidenceRequirement,
  surface: string,
  runtimeTree: boolean,
): string | null {
  if (!earlier.surfaces.includes(surface)) return "surface newly in scope";
  const before = previous.subject.surfaces.find((entry) => entry.id === surface);
  const after = next.subject.surfaces.find((entry) => entry.id === surface);
  if (!before?.contentDigest || !after?.contentDigest) return "surface digest unknown";
  if (before.contentDigest !== after.contentDigest) return "surface content changed";
  if (dependsOnRuntimeTree(requirement, after) && !runtimeTree) {
    return "runtime tree changed or unknown";
  }
  const testsBefore = exercisers(previous.subject.surfaces, surface);
  const testsAfter = exercisers(next.subject.surfaces, surface);
  const key = (tests: PlanSurface[]) =>
    tests.map((test) => `${test.id}=${test.contentDigest ?? "unknown"}`).join("|");
  if (
    [...testsBefore, ...testsAfter].some((test) => test.contentDigest === null) ||
    key(testsBefore) !== key(testsAfter)
  ) {
    return "a test or proof surface exercising the surface changed";
  }
  return null;
}

/**
 * Proof surfaces that exercise `surface`: a test without an `exercises` list exercises everything;
 * a proof-infrastructure surface counts where it names the surface.
 */
function exercisers(surfaces: ReadonlyArray<PlanSurface>, surface: string): PlanSurface[] {
  return surfaces
    .filter(
      (entry) =>
        (entry.role === "test" &&
          (entry.exercises === null || entry.exercises.includes(surface))) ||
        (entry.role === "proof-infrastructure" &&
          entry.exercises !== null &&
          entry.exercises.includes(surface)),
    )
    .sort((left, right) => compareOrdinal(left.id, right.id));
}
