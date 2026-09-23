import { compareOrdinal, type EvidenceBinding, sortedUnique } from "./model.js";
import type { AssurancePlan, EvidenceRequirement, PlanSurface } from "./plan.js";

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
    if (requirement.binding === "exact-revision" || requirement.surfaces.length === 0) {
      if (sameRevision) reusable.push(entry(requirement.surfaces, "same revision"));
      else mustProduce.push(entry(requirement.surfaces, "bound to the exact revision"));
      continue;
    }
    if (requirement.binding === "runtime-tree") {
      if (runtimeTree) reusable.push(entry(requirement.surfaces, "runtime tree unchanged"));
      else mustProduce.push(entry(requirement.surfaces, "runtime tree changed or unknown"));
      continue;
    }
    const kept: string[] = [];
    const changed = new Map<string, string[]>();
    const needsRuntimeTree = dependsOnRuntimeTree(requirement);
    for (const surface of requirement.surfaces) {
      const reason = surfaceReuseBlocker(
        previous,
        next,
        earlier,
        surface,
        needsRuntimeTree,
        runtimeTree,
      );
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

function sameRuntimeTree(previous: AssurancePlan, next: AssurancePlan): boolean {
  const before = previous.subject.runtimeTreeDigest;
  const after = next.subject.runtimeTreeDigest;
  return before !== null && after !== null && before === after;
}

/** Attested reviews of proof infrastructure or documentation do not depend on product code. */
function dependsOnRuntimeTree(requirement: EvidenceRequirement): boolean {
  const onlyDocumentation = requirement.subjects.every((subject) => subject === "documentation");
  const onlyProofReview =
    requirement.verification === "attested" &&
    requirement.subjects.every(
      (subject) => subject === "proof-infrastructure" || subject === "documentation",
    );
  return !onlyDocumentation && !onlyProofReview;
}

function surfaceReuseBlocker(
  previous: AssurancePlan,
  next: AssurancePlan,
  earlier: EvidenceRequirement,
  surface: string,
  needsRuntimeTree: boolean,
  runtimeTree: boolean,
): string | null {
  if (!earlier.surfaces.includes(surface)) return "surface newly in scope";
  const before = previous.subject.surfaces.find((entry) => entry.id === surface);
  const after = next.subject.surfaces.find((entry) => entry.id === surface);
  if (!before?.contentDigest || !after?.contentDigest) return "surface digest unknown";
  if (before.contentDigest !== after.contentDigest) return "surface content changed";
  if (needsRuntimeTree && !runtimeTree) return "runtime tree changed or unknown";
  const testsBefore = exercisingTests(previous.subject.surfaces, surface);
  const testsAfter = exercisingTests(next.subject.surfaces, surface);
  const key = (tests: PlanSurface[]) =>
    tests.map((test) => `${test.id}=${test.contentDigest ?? "unknown"}`).join("|");
  if (
    [...testsBefore, ...testsAfter].some((test) => test.contentDigest === null) ||
    key(testsBefore) !== key(testsAfter)
  ) {
    return "a test exercising the surface changed";
  }
  return null;
}

/** Test surfaces that exercise `surface`; a test without an `exercises` list exercises everything. */
function exercisingTests(surfaces: ReadonlyArray<PlanSurface>, surface: string): PlanSurface[] {
  return surfaces
    .filter(
      (entry) =>
        entry.role === "test" && (entry.exercises === null || entry.exercises.includes(surface)),
    )
    .sort((left, right) => compareOrdinal(left.id, right.id));
}
