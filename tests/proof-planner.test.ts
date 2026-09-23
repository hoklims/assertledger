import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type AssuranceClaim,
  type AssurancePlan,
  type AssurancePolicy,
  carryOverEvidence,
  DEFAULT_ASSURANCE_POLICY,
  type EvidenceCarryOver,
  INFRASTRUCTURE_SIGNALS,
  PRODUCT_SIGNALS,
  type PlanAssuranceInput,
  type ProofSignal,
  ProofPlannerError,
  parseAssurancePolicy,
  planAssurance,
  renderAssurancePlan,
  type SignalName,
  type Surface,
} from "../src/proof-planner/index.js";

const BASE = "0".repeat(40);
const R1 = "1".repeat(40);
const R2 = "2".repeat(40);
const R3 = "3".repeat(40);
const digest = (label: string) => `sha256:${createHash("sha256").update(label).digest("hex")}`;

type ImpactInput = PlanAssuranceInput["impact"];

function surface(id: string, overrides: Partial<Surface> = {}): Surface {
  return {
    id,
    role: "product",
    reach: "direct",
    runtime: "offline-analysis",
    boundaries: [],
    behaviorChange: "none",
    coverage: "tested",
    environmentSensitive: false,
    contentDigest: digest(`${id}@1`),
    ...overrides,
  };
}

function impact(surfaces: Surface[], overrides: Partial<ImpactInput> = {}): ImpactInput {
  return {
    schemaVersion: "1.0.0",
    revision: { id: R1, baseline: BASE, runtimeTreeDigest: digest("tree@1") },
    surfaces,
    analysis: {
      method: "static-graph",
      completeness: "complete",
      uncertainty: "low",
      unknowns: [],
      omittedSurfaceCount: 0,
    },
    reversibility: "reversible",
    causalWitness: "available",
    ...overrides,
  };
}

function analysis(overrides: Partial<ImpactInput["analysis"]>): ImpactInput["analysis"] {
  return {
    method: "static-graph",
    completeness: "complete",
    uncertainty: "low",
    unknowns: [],
    omittedSurfaceCount: 0,
    ...overrides,
  };
}

function claim(
  id: string,
  surfaces: string[],
  overrides: Partial<AssuranceClaim> = {},
): AssuranceClaim {
  return {
    id,
    statement: `claim ${id}`,
    kind: "behavior",
    criticality: "standard",
    scope: "local",
    surfaces,
    ...overrides,
  };
}

function signal(id: string, name: SignalName, overrides: Partial<ProofSignal> = {}): ProofSignal {
  return {
    id,
    revision: R1,
    signal: name,
    surfaces: [],
    exercisesImpactedSurfaces: "no",
    attribution: [],
    detail: "observed in CI",
    ...overrides,
  };
}

const kinds = (entries: ReadonlyArray<{ kind: string }>) => entries.map((entry) => entry.kind);
const notRequired = (plan: AssurancePlan) =>
  plan.explicitlyNotRequired.map((entry) => entry.requirement.kind);
const undetermined = (plan: AssurancePlan) =>
  plan.undeterminedEvidence.map((entry) => entry.requirement.kind);
const productRequired = (plan: AssurancePlan) =>
  plan.requiredEvidence
    .filter((entry) => entry.subjects.includes("product"))
    .map((entry) => `${entry.kind}:${entry.surfaces.join(",")}`);

const BROAD_AND_CEREMONY = DEFAULT_ASSURANCE_POLICY.evidence
  .filter((spec) => spec.weight !== "targeted")
  .map((spec) => spec.id);

function assertIncludes(actual: readonly string[], expected: readonly string[]): void {
  const missing = expected.filter((entry) => !actual.includes(entry));
  assert.deepEqual(missing, [], `missing ${missing.join(", ")} in [${actual.join(", ")}]`);
}

function assertExcludes(actual: readonly string[], forbidden: readonly string[]): void {
  const present = forbidden.filter((entry) => actual.includes(entry));
  assert.deepEqual(present, [], `unexpected ${present.join(", ")}`);
}

// Scenario inputs A-G, shared by the decision tests and the property tests.
const DOCS_ONLY: PlanAssuranceInput = {
  impact: impact([surface("docs/guide.md", { role: "documentation", runtime: "none" })]),
};
const LOCAL_REFACTOR: PlanAssuranceInput = {
  impact: impact([surface("lib/duration-format")]),
  claims: [claim("duration-format-equivalence", ["lib/duration-format"], { kind: "equivalence" })],
};
const LOCAL_BUGFIX: PlanAssuranceInput = {
  impact: impact([
    surface("billing/rounding", { behaviorChange: "fix" }),
    surface("billing/rounding.test", {
      role: "test",
      runtime: "build",
      exercises: ["billing/rounding"],
    }),
  ]),
  claims: [claim("rounding-half-even", ["billing/rounding"])],
};
const REPLAY_FIX_SURFACES = [
  surface("channel/replay-safe-keys", { boundaries: ["replay"], behaviorChange: "fix" }),
  surface("channel/replay-fold", {
    reach: "transitive",
    boundaries: ["replay", "analysis"],
    behaviorChange: "suspected",
  }),
  surface("channel/replay-safe-keys.test", {
    role: "test",
    runtime: "build",
    exercises: ["channel/replay-safe-keys", "channel/replay-fold"],
  }),
  surface("docs/live-active-status.md", { role: "documentation", runtime: "none" }),
];
const REPLAY_CLAIMS = [
  claim("replay-keeps-carrier-epochs", ["channel/replay-safe-keys"]),
  claim("fold-decodes-achievements", ["channel/replay-fold"]),
  claim("live-decoder-pins-unchanged", ["channel/live-pins"], {
    kind: "invariant",
    criticality: "critical",
    scope: "system",
  }),
];
const REPLAY_BOUNDED: PlanAssuranceInput = {
  impact: impact(REPLAY_FIX_SURFACES),
  claims: REPLAY_CLAIMS,
};
const LIVE_DECODER: PlanAssuranceInput = {
  impact: impact([
    surface("protocol/live-decoder", {
      runtime: "live",
      boundaries: ["protocol"],
      behaviorChange: "fix",
    }),
  ]),
};
const TACTICAL_DECISION: PlanAssuranceInput = {
  impact: impact([
    surface("decision/tactics", {
      runtime: "live",
      boundaries: ["decision"],
      behaviorChange: "feature",
    }),
  ]),
};
const BENCHMARK_CLAIM: PlanAssuranceInput = {
  impact: impact([
    surface("benchmarks/holdout-evaluator", {
      role: "evaluation",
      boundaries: ["benchmark", "holdout"],
      behaviorChange: "feature",
    }),
  ]),
  claims: [
    claim("detection-gain", ["benchmarks/holdout-evaluator"], {
      kind: "empirical",
      criticality: "high",
      scope: "system",
    }),
  ],
};
const CEILING_REPAIR: PlanAssuranceInput = {
  impact: impact([
    surface("mechanics/catalog-prefix.property.test", {
      role: "test",
      runtime: "build",
      behaviorChange: "fix",
      environmentSensitive: true,
      exercises: ["mechanics/catalog"],
    }),
  ]),
};

const SCENARIOS: Record<string, PlanAssuranceInput> = {
  A_DOCS_ONLY: DOCS_ONLY,
  B_LOCAL_REFACTOR: LOCAL_REFACTOR,
  C_LOCAL_BUGFIX: LOCAL_BUGFIX,
  D_REPLAY_BOUNDED: REPLAY_BOUNDED,
  E_LIVE_DECODER: LIVE_DECODER,
  E_TACTICAL_DECISION: TACTICAL_DECISION,
  F_BENCHMARK_CLAIM: BENCHMARK_CLAIM,
  G_CEILING_REPAIR: CEILING_REPAIR,
};

describe("proof planner decisions", () => {
  it("A: keeps a documentation-only change at P0 and justifies every heavy exemption", () => {
    const plan = planAssurance(DOCS_ONLY);
    assert.equal(plan.level, "P0");
    assert.equal(plan.status, "PROVE");
    assert.equal(plan.impactBound, "no-product-runtime");
    assert.deepEqual(kinds(plan.requiredEvidence), ["DOCUMENTATION_CHECK"]);
    assert.deepEqual(kinds(plan.recommendedEvidence), []);
    assertIncludes(notRequired(plan), BROAD_AND_CEREMONY);
    assert.deepEqual([...BROAD_AND_CEREMONY].sort(), [
      "BENCHMARK_PROTOCOL",
      "CONTAMINATION_CHECK",
      "FULL_CORPUS",
      "FULL_TEST_SUITE",
      "HOLDOUT_EVALUATION",
      "INDEPENDENT_REVIEW",
      "LIVE_SHADOW",
      "MULTI_ENVIRONMENT",
      "PREREGISTRATION",
      "PROVENANCE_ATTESTATION",
      "SYSTEM_REQUALIFICATION",
    ]);
    for (const entry of plan.explicitlyNotRequired) {
      assert.equal(entry.evaluatedAgainst, "actual-change");
      assert.match(entry.rationale, /^Not required: /);
    }
  });

  it("B: asks a local refactor for static checks and affected tests only", () => {
    const plan = planAssurance(LOCAL_REFACTOR);
    assert.equal(plan.level, "P1");
    assert.deepEqual(kinds(plan.requiredEvidence), ["AFFECTED_TESTS", "STATIC_CHECKS"]);
    assertIncludes(notRequired(plan), [
      "CAUSAL_WITNESS",
      "TARGETED_REGRESSION",
      ...BROAD_AND_CEREMONY,
    ]);

    const untested = planAssurance({
      ...LOCAL_REFACTOR,
      impact: impact([surface("lib/duration-format", { coverage: "untested" })]),
    });
    assert.deepEqual(kinds(untested.requiredEvidence), [
      "AFFECTED_TESTS",
      "CHARACTERIZATION_TESTS",
      "STATIC_CHECKS",
    ]);
  });

  it("C: asks a local behavioral fix for a causal witness and local regression", () => {
    const plan = planAssurance(LOCAL_BUGFIX);
    assert.equal(plan.level, "P2");
    assert.deepEqual(kinds(plan.requiredEvidence), [
      "AFFECTED_TESTS",
      "CAUSAL_WITNESS",
      "REVISION_IDENTITY",
      "STATIC_CHECKS",
      "TARGETED_REGRESSION",
    ]);
    const witness = plan.requiredEvidence.find((entry) => entry.kind === "CAUSAL_WITNESS");
    assert.deepEqual(witness?.surfaces, ["billing/rounding"]);
    assert.deepEqual(witness?.because, ["product:fix"]);
    assertIncludes(notRequired(plan), ["TARGETED_INTEGRATION", ...BROAD_AND_CEREMONY]);
  });

  it("C: deepens proof on the claims a fix reaches, by criticality and reach", () => {
    const withClaim = (criticality: AssuranceClaim["criticality"], surfaceId: string) =>
      planAssurance({
        impact: impact([
          ...LOCAL_BUGFIX.impact.surfaces,
          surface("billing/ledger", { reach: "transitive", behaviorChange: "none" }),
        ]),
        claims: [claim("ledger-balances", [surfaceId], { kind: "invariant", criticality })],
      });
    const standard = withClaim("standard", "billing/rounding");
    assert.equal(standard.level, "P2");
    assertExcludes(kinds(standard.requiredEvidence), ["INVARIANT_CHECK"]);
    const highTransitive = withClaim("high", "billing/ledger");
    assert.equal(highTransitive.level, "P2");
    assertIncludes(kinds(highTransitive.requiredEvidence), ["INVARIANT_CHECK"]);
    const highDirect = withClaim("high", "billing/rounding");
    assert.equal(highDirect.level, "P3");
    assertIncludes(kinds(highDirect.requiredEvidence), ["INVARIANT_CHECK", "TARGETED_INTEGRATION"]);
    const criticalDirect = withClaim("critical", "billing/rounding");
    assert.equal(criticalDirect.level, "P4");
    assertIncludes(kinds(criticalDirect.requiredEvidence), [
      "INDEPENDENT_REVIEW",
      "INVARIANT_CHECK",
    ]);
    assertExcludes(kinds(criticalDirect.requiredEvidence), ["FULL_TEST_SUITE"]);
  });

  it("D: gives a bounded replay fix real integration and a targeted corpus, not a system audit", () => {
    const plan = planAssurance(REPLAY_BOUNDED);
    assert.equal(plan.level, "P3");
    assert.equal(plan.impactBound, "bounded-confident");
    assert.deepEqual(kinds(plan.requiredEvidence), [
      "AFFECTED_TESTS",
      "CAUSAL_WITNESS",
      "DOCUMENTATION_CHECK",
      "PRODUCTION_PATH_TEST",
      "REVISION_IDENTITY",
      "STATIC_CHECKS",
      "TARGETED_CORPUS",
      "TARGETED_INTEGRATION",
      "TARGETED_REGRESSION",
    ]);
    assertIncludes(notRequired(plan), BROAD_AND_CEREMONY);
    const fullCorpus = plan.explicitlyNotRequired.find(
      (entry) => entry.requirement.kind === "FULL_CORPUS",
    );
    assert.deepEqual(
      fullCorpus?.activation.triggers.map((entry) => entry.fact),
      [
        "boundary:decision:behavior",
        "impact:unbounded",
        "observed:corpus-divergence",
        "observed:live-runtime",
        "runtime:live:behavior",
      ],
    );
    assert.deepEqual(
      plan.unaffectedClaims.map((entry) => entry.id),
      ["live-decoder-pins-unchanged"],
    );
  });

  it("D: turns declared uncertainty into recommendations bounded by the worst case", () => {
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ uncertainty: "medium" }) }),
    });
    assert.equal(plan.impactBound, "bounded-uncertain");
    assert.equal(plan.level, "P3");
    // The worst case adds characterization tests; the critical claim outside the impact earns a
    // recommended invariant check, not a floor.
    assert.deepEqual(kinds(plan.recommendedEvidence), [
      "CHARACTERIZATION_TESTS",
      "INVARIANT_CHECK",
    ]);
    assert.deepEqual(
      plan.recommendedEvidence.find((entry) => entry.kind === "INVARIANT_CHECK")?.because,
      ["claim:outside-impact"],
    );
    assertIncludes(notRequired(plan), BROAD_AND_CEREMONY);
    for (const entry of plan.explicitlyNotRequired) {
      assert.equal(entry.evaluatedAgainst, "worst-case");
      assert.match(entry.rationale, /worst case/);
    }
  });

  it("D: evaluates exemptions against a worst case that is never weaker than the plan", () => {
    const refactor = planAssurance({
      ...LOCAL_REFACTOR,
      impact: impact([surface("lib/duration-format")], {
        analysis: analysis({ uncertainty: "medium" }),
      }),
    });
    assert.equal(refactor.level, "P1");
    // A declared "no behavior change" becomes "suspected" in the worst case.
    assert.deepEqual(kinds(refactor.recommendedEvidence), [
      "CHARACTERIZATION_TESTS",
      "REVISION_IDENTITY",
      "TARGETED_REGRESSION",
    ]);
    const review = refactor.explicitlyNotRequired.find(
      (entry) => entry.requirement.kind === "INDEPENDENT_REVIEW",
    );
    assert.deepEqual(review?.activation.baselines, [
      {
        level: "P4",
        subjects: [
          { subject: "product", level: "P2" },
          { subject: "evaluation", level: null },
        ],
      },
    ]);

    const decision = planAssurance({
      impact: impact(
        [
          surface("lib/duration-format", { behaviorChange: "fix" }),
          surface("decision/tactics", { reach: "transitive", boundaries: ["decision"] }),
        ],
        { analysis: analysis({ uncertainty: "medium" }) },
      ),
    });
    assert.equal(decision.level, "P2");
    assertIncludes(kinds(decision.recommendedEvidence), [
      "FULL_CORPUS",
      "INDEPENDENT_REVIEW",
      "SYSTEM_REQUALIFICATION",
    ]);

    // A worst case that is itself unbounded cannot justify any exemption.
    const context = planAssurance({
      impact: impact(
        [
          surface("lib/duration-format", { behaviorChange: "fix" }),
          surface("config/runtime.json", {
            role: "execution-context",
            reach: "transitive",
            runtime: "build",
          }),
        ],
        { analysis: analysis({ uncertainty: "medium" }) },
      ),
    });
    assert.equal(context.impactBound, "bounded-uncertain");
    assert.deepEqual(notRequired(context), []);
    assertIncludes(kinds(context.recommendedEvidence), ["FULL_TEST_SUITE"]);
    assert.match(context.undeterminedEvidence[0]?.rationale ?? "", /worst case .* not bounded/);
  });

  it("D: never exempts broad evidence when the impact is not bounded", () => {
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ completeness: "partial" }) }),
    });
    assert.equal(plan.impactBound, "unbounded");
    assert.equal(plan.level, "P3");
    // The untouched critical claim is treated as reached: its invariant must be checked.
    assert.deepEqual(
      [...kinds(plan.requiredEvidence)].sort(),
      [
        ...kinds(planAssurance(REPLAY_BOUNDED).requiredEvidence),
        "FULL_TEST_SUITE",
        "INVARIANT_CHECK",
      ].sort(),
    );
    assert.deepEqual(kinds(plan.recommendedEvidence), ["FULL_CORPUS", "INDEPENDENT_REVIEW"]);
    assert.deepEqual(notRequired(plan), []);
    assertIncludes(undetermined(plan), ["LIVE_SHADOW", "SYSTEM_REQUALIFICATION"]);
    // The claim outside the impact can no longer be declared unaffected.
    assert.deepEqual(plan.unaffectedClaims, []);
    assert.ok(plan.facts.some((fact) => fact.id === "claim:critical:transitive"));

    const declared = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ method: "declared" }) }),
    });
    assert.equal(declared.impactBound, "bounded-uncertain");
    assert.equal(declared.level, "P3");
    assert.deepEqual(
      kinds(declared.requiredEvidence),
      kinds(planAssurance(REPLAY_BOUNDED).requiredEvidence),
    );
    assert.deepEqual(kinds(declared.recommendedEvidence), [
      "CHARACTERIZATION_TESTS",
      "FULL_TEST_SUITE",
      "INVARIANT_CHECK",
    ]);
    assertExcludes(notRequired(declared), ["FULL_TEST_SUITE"]);
    assert.ok(declared.explicitlyNotRequired.length > 0);
    for (const entry of declared.explicitlyNotRequired) {
      assert.equal(entry.evaluatedAgainst, "worst-case");
      assert.match(entry.rationale, /worst case/);
    }
  });

  it("E: escalates a live decoder fix and a tactical decision change strongly", () => {
    const decoder = planAssurance(LIVE_DECODER);
    assert.equal(decoder.level, "P4");
    assert.deepEqual(kinds(decoder.requiredEvidence), [
      "AFFECTED_TESTS",
      "BOUNDARY_COMPATIBILITY",
      "CAUSAL_WITNESS",
      "FULL_CORPUS",
      "INDEPENDENT_REVIEW",
      "LIVE_SHADOW",
      "PRODUCTION_PATH_TEST",
      "REVISION_IDENTITY",
      "ROLLBACK_PLAN",
      "STATIC_CHECKS",
      "TARGETED_INTEGRATION",
      "TARGETED_REGRESSION",
    ]);
    // A decoder fix is not a decision change: no system requalification, no full suite.
    assertIncludes(notRequired(decoder), [
      "BENCHMARK_PROTOCOL",
      "FULL_TEST_SUITE",
      "HOLDOUT_EVALUATION",
      "MULTI_ENVIRONMENT",
      "SYSTEM_REQUALIFICATION",
    ]);

    const decision = planAssurance(TACTICAL_DECISION);
    assert.equal(decision.level, "P4");
    assert.deepEqual(kinds(decision.requiredEvidence), [
      "ACCEPTANCE_TEST",
      "AFFECTED_TESTS",
      "FULL_CORPUS",
      "INDEPENDENT_REVIEW",
      "LIVE_SHADOW",
      "PRODUCTION_PATH_TEST",
      "REVISION_IDENTITY",
      "ROLLBACK_PLAN",
      "STATIC_CHECKS",
      "SYSTEM_REQUALIFICATION",
      "TARGETED_INTEGRATION",
      "TARGETED_REGRESSION",
    ]);
    assertIncludes(notRequired(decision), [
      "BENCHMARK_PROTOCOL",
      "FULL_TEST_SUITE",
      "HOLDOUT_EVALUATION",
      "MULTI_ENVIRONMENT",
    ]);
  });

  it("F: puts an experimental claim at P5 with evaluation evidence, not product ceremony", () => {
    const plan = planAssurance(BENCHMARK_CLAIM);
    assert.equal(plan.level, "P5");
    assert.deepEqual(plan.levelBySubject, [{ subject: "evaluation", level: "P5" }]);
    assert.deepEqual(kinds(plan.requiredEvidence), [
      "AFFECTED_TESTS",
      "BENCHMARK_PROTOCOL",
      "CONTAMINATION_CHECK",
      "HOLDOUT_EVALUATION",
      "INDEPENDENT_REVIEW",
      "PREREGISTRATION",
      "PROVENANCE_ATTESTATION",
      "REVISION_IDENTITY",
      "STATIC_CHECKS",
    ]);
    assertExcludes(kinds(plan.requiredEvidence), [
      "CAUSAL_WITNESS",
      "INVARIANT_CHECK",
      "LIVE_SHADOW",
      "PRODUCTION_PATH_TEST",
      "SYSTEM_REQUALIFICATION",
      "TARGETED_INTEGRATION",
    ]);
    assertIncludes(notRequired(plan), [
      "FULL_CORPUS",
      "FULL_TEST_SUITE",
      "LIVE_SHADOW",
      "SYSTEM_REQUALIFICATION",
    ]);
  });

  it("G: repairs a timeout ceiling without any functional requalification", () => {
    for (const role of ["test", "proof-infrastructure"] as const) {
      const plan = planAssurance({
        impact: impact([
          surface("mechanics/catalog-prefix.property.test", {
            role,
            runtime: "build",
            behaviorChange: "fix",
            environmentSensitive: true,
            exercises: ["mechanics/catalog"],
          }),
        ]),
      });
      assert.equal(plan.level, "P1", role);
      assert.deepEqual(
        kinds(plan.requiredEvidence),
        ["AFFECTED_JOB_RERUN", "GATE_DELTA_REVIEW", "STATIC_CHECKS"],
        role,
      );
      assertIncludes(notRequired(plan), [
        "CAUSAL_WITNESS",
        "TARGETED_CORPUS",
        "MULTI_ENVIRONMENT",
        ...BROAD_AND_CEREMONY,
      ]);
    }
  });

  it("G: holds, without escalating, on a timeout that may exercise the change", () => {
    const quiet = planAssurance(LOCAL_BUGFIX);
    const plan = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("perf-guard", "TIMEOUT", {
          surfaces: ["billing/rounding.test"],
          exercisesImpactedSurfaces: "yes",
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(plan.status, "HOLD");
    assert.equal(plan.level, quiet.level);
    assert.equal(plan.signals[0]?.classification, "unattributed");
    assertIncludes(kinds(plan.requiredEvidence), ["FAILURE_ATTRIBUTION"]);
    assertExcludes(kinds(plan.requiredEvidence), ["FULL_TEST_SUITE", "SYSTEM_REQUALIFICATION"]);
  });
});

describe("product evidence versus proof-infrastructure evidence", () => {
  it("attributes a peripheral timeout outside a confident impact to the proof infrastructure", () => {
    const quiet = planAssurance(REPLAY_BOUNDED);
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("t1", "TIMEOUT", {
          surfaces: ["mechanics/catalog-prefix.property.test"],
          attribution: ["PASSES_ON_SAME_REVISION", "OUTSIDE_IMPACT"],
        }),
      ],
    });
    assert.equal(plan.signals[0]?.classification, "proof-infrastructure");
    assert.equal(plan.level, quiet.level);
    assert.equal(plan.status, "PROVE");
    assert.deepEqual(productRequired(plan), productRequired(quiet));
    const rerun = plan.requiredEvidence.find((entry) => entry.kind === "AFFECTED_JOB_RERUN");
    assert.deepEqual(rerun?.surfaces, ["mechanics/catalog-prefix.property.test"]);
  });

  it("never lets a retry or a declaration launder a failure on the changed surfaces", () => {
    const retried = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("slow", "TIMEOUT", {
          surfaces: ["channel/replay-safe-keys.test"],
          exercisesImpactedSurfaces: "no",
          attribution: ["PASSES_ON_SAME_REVISION", "OUTSIDE_IMPACT", "DECLARED_ENVIRONMENT_FACTOR"],
        }),
      ],
    });
    assert.equal(retried.signals[0]?.exercises, "yes");
    assert.equal(retried.signals[0]?.classification, "unattributed");
    assert.equal(retried.status, "HOLD");

    const reproduced = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("slow", "TIMEOUT", {
          surfaces: ["channel/replay-safe-keys.test"],
          exercisesImpactedSurfaces: "yes",
          attribution: ["REPRODUCES_ON_BASELINE"],
        }),
      ],
    });
    assert.equal(reproduced.signals[0]?.classification, "proof-infrastructure");
    assert.equal(reproduced.status, "PROVE");
    // The reproduction is itself evidence the plan must ask for.
    const attribution = reproduced.requiredEvidence.find(
      (entry) => entry.kind === "FAILURE_ATTRIBUTION",
    );
    assert.deepEqual(attribution?.because, ["observed:baseline-reproduction"]);
    assert.deepEqual(attribution?.surfaces, ["channel/replay-safe-keys.test"]);

    // A failure that names no surface cannot be checked against the impact.
    const anonymous = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("job", "TIMEOUT", {
          exercisesImpactedSurfaces: "no",
          attribution: ["PASSES_ON_SAME_REVISION", "OUTSIDE_IMPACT"],
        }),
      ],
    });
    assert.equal(anonymous.signals[0]?.exercises, "unknown");
    assert.equal(anonymous.signals[0]?.classification, "unattributed");
    assert.equal(anonymous.status, "HOLD");
  });

  it("treats a failing proof surface that exercises the change as exercising it", () => {
    const outside = { attribution: ["OUTSIDE_IMPACT", "PASSES_ON_SAME_REVISION"] as const };
    const unlisted = planAssurance({
      impact: impact([
        ...LOCAL_BUGFIX.impact.surfaces,
        surface("billing/suite.test", { role: "test", runtime: "build", behaviorChange: "fix" }),
      ]),
      signals: [
        signal("t", "TIMEOUT", {
          surfaces: ["billing/suite.test"],
          attribution: [...outside.attribution],
        }),
      ],
    });
    assert.equal(unlisted.signals[0]?.exercises, "yes");
    assert.equal(unlisted.signals[0]?.classification, "unattributed");
    assert.equal(unlisted.status, "HOLD");

    const harness = planAssurance({
      impact: impact([
        ...LOCAL_BUGFIX.impact.surfaces,
        surface("billing/harness", {
          role: "proof-infrastructure",
          runtime: "build",
          exercises: ["billing/rounding"],
        }),
      ]),
      signals: [
        signal("t", "TIMEOUT", {
          surfaces: ["billing/harness"],
          attribution: [...outside.attribution],
        }),
      ],
    });
    assert.equal(harness.signals[0]?.exercises, "yes");
    assert.equal(harness.status, "HOLD");
  });

  it("classifies infrastructure signals only once product signals have reopened the bound", () => {
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("u", "UNPLANNED_IMPACT", {
          surfaces: ["channel/live-pins"],
          exercisesImpactedSurfaces: "yes",
        }),
        signal("t1", "TIMEOUT", {
          surfaces: ["mechanics/catalog-prefix.property.test"],
          attribution: ["OUTSIDE_IMPACT", "PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(plan.impactBound, "unbounded");
    const timeout = plan.signals.find((entry) => entry.id === "t1");
    assert.equal(timeout?.exercises, "unknown");
    assert.equal(timeout?.classification, "unattributed");
    assertIncludes(kinds(plan.requiredEvidence), ["FAILURE_ATTRIBUTION", "FULL_TEST_SUITE"]);
  });

  it("does not widen product evidence to the jobs of an unattributed failure", () => {
    const quiet = planAssurance(REPLAY_BOUNDED);
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("t", "TIMEOUT", {
          surfaces: ["mechanics/catalog-prefix.property.test", "decision/coarse-opponent.test"],
          exercisesImpactedSurfaces: "unknown",
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(plan.status, "HOLD");
    assert.equal(plan.level, quiet.level);
    const withoutAttribution = (entries: string[]) =>
      entries.filter((entry) => !entry.startsWith("FAILURE_ATTRIBUTION:"));
    assert.deepEqual(withoutAttribution(productRequired(plan)), productRequired(quiet));
    assert.deepEqual(
      plan.requiredEvidence.find((entry) => entry.kind === "FAILURE_ATTRIBUTION")?.surfaces,
      ["decision/coarse-opponent.test", "mechanics/catalog-prefix.property.test"],
    );
    // Same when the failing job is a changed test of the impact: it stays out of product scope.
    const onChangedTest = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("slow", "TIMEOUT", {
          surfaces: ["channel/replay-safe-keys.test"],
          exercisesImpactedSurfaces: "yes",
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(onChangedTest.status, "HOLD");
    assert.deepEqual(withoutAttribution(productRequired(onChangedTest)), productRequired(quiet));

    // A failing job that is itself a product surface of the impact joins the product scope.
    const withIndex: PlanAssuranceInput = {
      ...REPLAY_BOUNDED,
      impact: impact([
        ...REPLAY_FIX_SURFACES,
        surface("channel/replay-index", { reach: "transitive" }),
      ]),
    };
    const scoped = (input: PlanAssuranceInput) =>
      planAssurance(input).requiredEvidence.find((entry) => entry.kind === "TARGETED_REGRESSION")
        ?.surfaces ?? [];
    assertExcludes(scoped(withIndex), ["channel/replay-index"]);
    assertIncludes(
      scoped({
        ...withIndex,
        signals: [
          signal("idx", "TIMEOUT", {
            surfaces: ["channel/replay-index"],
            attribution: ["PASSES_ON_SAME_REVISION"],
          }),
        ],
      }),
      ["channel/replay-index"],
    );
  });

  it("does not trust an outside-impact attribution when the impact is uncertain", () => {
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ method: "declared" }) }),
      signals: [
        signal("t1", "TIMEOUT", {
          surfaces: ["mechanics/catalog-prefix.property.test"],
          attribution: ["OUTSIDE_IMPACT"],
        }),
      ],
    });
    assert.equal(plan.signals[0]?.exercises, "unknown");
    assert.equal(plan.signals[0]?.classification, "unattributed");
    assert.equal(plan.status, "HOLD");
  });

  it("blocks on a regression, unless the regression reproduces on the baseline", () => {
    const blocked = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [signal("r", "REGRESSION", { surfaces: ["billing/rounding"] })],
    });
    assert.equal(blocked.status, "BLOCKED");
    const excused = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("r", "REGRESSION", {
          surfaces: ["billing/rounding"],
          attribution: ["PASSES_ON_SAME_REVISION", "OUTSIDE_IMPACT", "DECLARED_ENVIRONMENT_FACTOR"],
        }),
      ],
    });
    assert.equal(excused.status, "BLOCKED");
    assert.equal(excused.signals[0]?.classification, "product");
    // A defect that reproduces on the baseline neither blocks nor escalates, but must be shown.
    const quiet = planAssurance(LOCAL_BUGFIX);
    for (const name of ["REGRESSION", "UNEXPECTED_BEHAVIOR", "CORPUS_DIVERGENCE"] as const) {
      const preExisting = planAssurance({
        ...LOCAL_BUGFIX,
        signals: [
          signal("r", name, {
            surfaces: ["billing/rounding"],
            attribution: ["REPRODUCES_ON_BASELINE"],
          }),
        ],
      });
      assert.equal(preExisting.status, "PROVE", name);
      assert.equal(preExisting.level, quiet.level, name);
      assert.equal(preExisting.signals[0]?.classification, "pre-existing", name);
      assert.ok(
        preExisting.residualUncertainty.some((entry) => entry.id === "signal.r.pre-existing"),
        name,
      );
      assert.deepEqual(
        preExisting.requiredEvidence.find((entry) => entry.kind === "FAILURE_ATTRIBUTION")
          ?.surfaces,
        ["billing/rounding"],
        name,
      );
    }
    // Only defects can pre-exist: an unplanned impact is about this change's reach.
    const unplanned = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("u", "UNPLANNED_IMPACT", {
          surfaces: ["billing/ledger"],
          attribution: ["REPRODUCES_ON_BASELINE"],
        }),
      ],
    });
    assert.equal(unplanned.signals[0]?.classification, "product");
    assert.equal(unplanned.impactBound, "unbounded");
  });

  it("absorbs an unplanned impact once the impact names the observed surfaces", () => {
    const reopened = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [signal("u", "UNPLANNED_IMPACT", { surfaces: ["channel/live-pins"] })],
    });
    assert.equal(reopened.impactBound, "unbounded");
    assert.equal(reopened.status, "HOLD");
    const absorbed = planAssurance({
      impact: impact([
        ...REPLAY_FIX_SURFACES,
        surface("channel/live-pins", { reach: "transitive", runtime: "live" }),
      ]),
      claims: REPLAY_CLAIMS,
      signals: [signal("u", "UNPLANNED_IMPACT", { surfaces: ["channel/live-pins"] })],
    });
    assert.equal(absorbed.signals[0]?.classification, "absorbed");
    assert.equal(absorbed.status, "PROVE");
    const unnamed = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [signal("u", "UNPLANNED_IMPACT", { exercisesImpactedSurfaces: "yes" })],
    });
    assert.equal(unnamed.signals[0]?.classification, "product");
    assert.equal(unnamed.impactBound, "unbounded");
  });

  it("absorbs a live-runtime observation on a surface already declared live, and only there", () => {
    const refactor: PlanAssuranceInput = {
      impact: impact([
        surface("protocol/live-decoder", { runtime: "live", boundaries: ["protocol"] }),
      ]),
    };
    const quiet = planAssurance(refactor);
    assert.equal(quiet.level, "P3");
    const confirmed = planAssurance({
      ...refactor,
      signals: [
        signal("l", "LIVE_RUNTIME_TOUCHED", {
          surfaces: ["protocol/live-decoder"],
          exercisesImpactedSurfaces: "yes",
        }),
      ],
    });
    assert.equal(confirmed.signals[0]?.classification, "absorbed");
    assert.equal(confirmed.level, "P3");
    assert.deepEqual(kinds(confirmed.requiredEvidence), kinds(quiet.requiredEvidence));
    const surprise = planAssurance({
      ...REPLAY_BOUNDED,
      signals: [
        signal("l", "LIVE_RUNTIME_TOUCHED", {
          surfaces: ["channel/replay-safe-keys"],
          exercisesImpactedSurfaces: "yes",
        }),
      ],
    });
    assert.equal(surprise.signals[0]?.classification, "product");
    assert.equal(surprise.level, "P4");
    assertIncludes(kinds(surprise.requiredEvidence), ["LIVE_SHADOW", "ROLLBACK_PLAN"]);
  });

  it("ignores signals observed on another revision", () => {
    const plan = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [signal("old", "REGRESSION", { revision: R2, surfaces: ["billing/rounding"] })],
    });
    assert.equal(plan.status, "PROVE");
    assert.equal(plan.signals[0]?.classification, "other-revision");
  });

  it("keeps an unresolved signal of another revision while the product is byte-identical", () => {
    const sameProduct = { revision: R2, baseline: BASE, runtimeTreeDigest: digest("tree@1") };
    const regression = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [signal("old", "REGRESSION", { ...sameProduct, surfaces: ["billing/rounding"] })],
    });
    assert.equal(regression.status, "BLOCKED");
    assert.equal(regression.signals[0]?.classification, "product");
    assert.match(regression.signals[0]?.reason ?? "", /^carried from revision 2+/);

    const moved = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("old", "REGRESSION", {
          ...sameProduct,
          runtimeTreeDigest: digest("tree@0"),
          surfaces: ["billing/rounding"],
        }),
      ],
    });
    assert.equal(moved.status, "PROVE");
    assert.equal(moved.signals[0]?.classification, "other-revision");

    const slow = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("slow", "TIMEOUT", {
          ...sameProduct,
          surfaces: ["billing/rounding.test"],
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(slow.status, "HOLD");
    assert.equal(slow.signals[0]?.classification, "unattributed");

    const resolved = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("peripheral", "TIMEOUT", {
          ...sameProduct,
          surfaces: ["elsewhere/job"],
          attribution: ["OUTSIDE_IMPACT"],
        }),
      ],
    });
    assert.equal(resolved.status, "PROVE");
    assert.equal(resolved.signals[0]?.classification, "other-revision");
    assertExcludes(kinds(resolved.requiredEvidence), ["AFFECTED_JOB_RERUN"]);
  });
});

describe("proof planner properties", () => {
  const canonicalSignal = (input: PlanAssuranceInput, name: SignalName): ProofSignal => {
    const direct = (input.impact.surfaces ?? [])
      .filter((entry) => entry.reach === "direct")
      .map((entry) => entry.id);
    return signal(`probe.${name}`, name, {
      surfaces:
        name === "UNPLANNED_IMPACT"
          ? ["probe.unplanned"]
          : name === "UNKNOWN_DEPENDENCY"
            ? []
            : direct,
      exercisesImpactedSurfaces: "yes",
    });
  };
  const signature = (plan: AssurancePlan) =>
    JSON.stringify([
      plan.level,
      plan.status,
      kinds(plan.requiredEvidence),
      kinds(plan.recommendedEvidence),
    ]);

  it("partitions the whole evidence catalog into exactly one status per kind", () => {
    for (const [name, input] of Object.entries(SCENARIOS)) {
      for (const plan of [
        planAssurance(input),
        planAssurance({
          ...input,
          impact: { ...input.impact, analysis: analysis({ uncertainty: "medium" }) },
        }),
        planAssurance({
          ...input,
          impact: { ...input.impact, analysis: analysis({ completeness: "unknown" }) },
        }),
      ]) {
        const statuses = [
          ...kinds(plan.requiredEvidence),
          ...kinds(plan.recommendedEvidence),
          ...notRequired(plan),
          ...undetermined(plan),
        ].sort();
        assert.deepEqual(
          statuses,
          DEFAULT_ASSURANCE_POLICY.evidence.map((spec) => spec.id).sort(),
          name,
        );
      }
    }
  });

  it("reacts to every product signal in every scenario", () => {
    for (const [name, input] of Object.entries(SCENARIOS)) {
      const quiet = signature(planAssurance(input));
      for (const product of PRODUCT_SIGNALS) {
        const loud = planAssurance({ ...input, signals: [canonicalSignal(input, product)] });
        // A live-runtime observation on surfaces already declared live confirms the impact.
        const confirmation =
          product === "LIVE_RUNTIME_TOUCHED" &&
          loud.signals[0]?.classification === "absorbed" &&
          loud.facts.some((fact) => fact.id === "runtime:live:touched");
        if (confirmation) continue;
        assert.notEqual(signature(loud), quiet, `${name} ignores ${product}`);
      }
    }
  });

  it("never lowers the level or drops a requirement when a signal is added", () => {
    for (const [name, input] of Object.entries(SCENARIOS)) {
      const quiet = planAssurance(input);
      const probes: ProofSignal[] = [
        ...PRODUCT_SIGNALS.map((product) => canonicalSignal(input, product)),
        ...INFRASTRUCTURE_SIGNALS.flatMap((infrastructure) => [
          signal(`probe.${infrastructure}.outside`, infrastructure, {
            surfaces: ["elsewhere/job"],
            attribution: ["OUTSIDE_IMPACT"],
          }),
          signal(`probe.${infrastructure}.inside`, infrastructure, {
            exercisesImpactedSurfaces: "yes",
            attribution: ["PASSES_ON_SAME_REVISION"],
          }),
        ]),
      ];
      for (const probe of probes) {
        const loud = planAssurance({ ...input, signals: [probe] });
        assert.ok(loud.level >= quiet.level, `${name} ${probe.id} lowered the level`);
        assertIncludes(kinds(loud.requiredEvidence), kinds(quiet.requiredEvidence));
      }
    }
  });

  it("leaves level, status and the changed surfaces' evidence alone for an attributed infrastructure failure", () => {
    for (const [name, input] of Object.entries(SCENARIOS)) {
      const quiet = planAssurance(input);
      for (const infrastructure of INFRASTRUCTURE_SIGNALS) {
        for (const basis of ["OUTSIDE_IMPACT", "REPRODUCES_ON_BASELINE"] as const) {
          const label = `${name} ${infrastructure} ${basis}`;
          const loud = planAssurance({
            ...input,
            signals: [
              signal("peripheral", infrastructure, {
                surfaces: ["elsewhere/job"],
                attribution: [basis],
              }),
            ],
          });
          assert.equal(loud.signals[0]?.classification, "proof-infrastructure", label);
          assert.equal(loud.level, quiet.level, label);
          assert.equal(loud.status, quiet.status, label);
          // A reproduction on the baseline is the only basis that must itself be evidenced, and
          // that evidence may concern the product: only the failing job gets it.
          assert.deepEqual(
            [...productRequired(loud)].sort(),
            [
              ...productRequired(quiet),
              ...(basis === "REPRODUCES_ON_BASELINE" ? ["FAILURE_ATTRIBUTION:elsewhere/job"] : []),
            ].sort(),
            label,
          );
          assert.deepEqual(
            kinds(
              loud.requiredEvidence.filter((entry) => entry.surfaces.includes("elsewhere/job")),
            ),
            basis === "REPRODUCES_ON_BASELINE"
              ? ["AFFECTED_JOB_RERUN", "FAILURE_ATTRIBUTION"]
              : ["AFFECTED_JOB_RERUN"],
            label,
          );
        }
      }
    }
  });

  it("precomputes escalations consistently with a replan, pinned row by row", () => {
    const quiet = planAssurance(REPLAY_BOUNDED);
    for (const escalation of quiet.escalations.filter((entry) => entry.variant === "product")) {
      const replanned = planAssurance({
        ...REPLAY_BOUNDED,
        signals: [
          signal("replay", escalation.signal, {
            surfaces:
              escalation.signal === "UNPLANNED_IMPACT"
                ? ["hypothetical-surface"]
                : escalation.signal === "UNKNOWN_DEPENDENCY"
                  ? []
                  : ["channel/replay-safe-keys"],
            exercisesImpactedSurfaces: "yes",
          }),
        ],
      });
      assert.equal(escalation.resultingLevel, replanned.level, escalation.signal);
      assert.equal(escalation.resultingStatus, replanned.status, escalation.signal);
      assert.deepEqual(
        escalation.addsRequired,
        kinds(replanned.requiredEvidence).filter(
          (kind) => !kinds(quiet.requiredEvidence).includes(kind),
        ),
        escalation.signal,
      );
    }
    // Expected values derived from the default policy by hand, not from the planner output.
    assert.deepEqual(
      quiet.escalations.map((entry) => [
        entry.signal,
        entry.variant,
        entry.classification,
        entry.resultingLevel,
        entry.resultingStatus,
        entry.addsRequired,
      ]),
      [
        [
          "UNEXPECTED_BEHAVIOR",
          "product",
          "product",
          "P4",
          "HOLD",
          ["CHARACTERIZATION_TESTS", "FAILURE_ATTRIBUTION", "INDEPENDENT_REVIEW"],
        ],
        [
          "UNPLANNED_IMPACT",
          "product",
          "product",
          "P3",
          "HOLD",
          ["FULL_TEST_SUITE", "INVARIANT_CHECK"],
        ],
        [
          "UNKNOWN_DEPENDENCY",
          "product",
          "product",
          "P3",
          "HOLD",
          ["FULL_TEST_SUITE", "INVARIANT_CHECK"],
        ],
        [
          "LIVE_RUNTIME_TOUCHED",
          "product",
          "product",
          "P4",
          "PROVE",
          ["FULL_CORPUS", "INDEPENDENT_REVIEW", "LIVE_SHADOW", "ROLLBACK_PLAN"],
        ],
        [
          "CORPUS_DIVERGENCE",
          "product",
          "product",
          "P4",
          "PROVE",
          ["FAILURE_ATTRIBUTION", "FULL_CORPUS", "INDEPENDENT_REVIEW"],
        ],
        ["WITNESS_NOT_CAUSAL", "product", "product", "P4", "HOLD", ["INDEPENDENT_REVIEW"]],
        ["REGRESSION", "product", "product", "P3", "BLOCKED", []],
        [
          "TIMEOUT",
          "infrastructure-attributed",
          "proof-infrastructure",
          "P3",
          "PROVE",
          ["AFFECTED_JOB_RERUN", "FAILURE_ATTRIBUTION"],
        ],
        [
          "TIMEOUT",
          "infrastructure-unattributed",
          "unattributed",
          "P3",
          "HOLD",
          ["FAILURE_ATTRIBUTION"],
        ],
      ],
    );
  });

  it("counts one source of uncertainty once and never raises into P5", () => {
    const refactor = planAssurance({
      ...LOCAL_REFACTOR,
      impact: impact([surface("lib/duration-format")], {
        analysis: analysis({ uncertainty: "high" }),
      }),
    });
    assert.equal(refactor.level, "P2");
    const decision = planAssurance({
      ...TACTICAL_DECISION,
      impact: impact(TACTICAL_DECISION.impact.surfaces, {
        analysis: analysis({ uncertainty: "high" }),
      }),
    });
    assert.equal(decision.level, "P4");
  });

  it("ignores untouched claims only when the impact is bounded with confidence", () => {
    const registry = [
      ...REPLAY_CLAIMS,
      claim("persistence-roundtrip", ["storage/ledger"], { criticality: "critical" }),
      claim("win-rate", ["benchmarks/arena"], { kind: "empirical", criticality: "high" }),
    ];
    const bounded = planAssurance({ ...REPLAY_BOUNDED, claims: registry });
    assert.equal(bounded.level, planAssurance(REPLAY_BOUNDED).level);
    assert.deepEqual(
      kinds(bounded.requiredEvidence),
      kinds(planAssurance(REPLAY_BOUNDED).requiredEvidence),
    );
    const uncertain = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ uncertainty: "medium" }) }),
      claims: registry,
    });
    // Outside a bounded but uncertain impact, criticality earns a recommendation, not a floor,
    // and the claim's surfaces never enter the baselines of the change.
    assert.equal(uncertain.level, bounded.level);
    assertIncludes(kinds(uncertain.recommendedEvidence), ["INVARIANT_CHECK", "BENCHMARK_PROTOCOL"]);
    assertExcludes(kinds(uncertain.requiredEvidence), [
      "INVARIANT_CHECK",
      "PREREGISTRATION",
      "HOLDOUT_EVALUATION",
    ]);
    for (const entry of uncertain.requiredEvidence) {
      assertExcludes(entry.surfaces, ["channel/live-pins", "storage/ledger", "benchmarks/arena"]);
    }
    assert.deepEqual(uncertain.unaffectedClaims, []);
    const unbounded = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ omittedSurfaceCount: 3 }) }),
      claims: registry,
    });
    assertIncludes(kinds(unbounded.requiredEvidence), ["INVARIANT_CHECK", "FULL_TEST_SUITE"]);
  });

  it("is deterministic and insensitive to input order and duplicates", () => {
    const shuffled: PlanAssuranceInput = {
      impact: impact(
        [...REPLAY_FIX_SURFACES].reverse().map((entry) => ({
          ...entry,
          boundaries: [...entry.boundaries, ...entry.boundaries].reverse(),
        })),
      ),
      claims: [...REPLAY_CLAIMS].reverse(),
    };
    const plan = planAssurance(REPLAY_BOUNDED);
    assert.deepEqual(planAssurance(shuffled), plan);
    assert.deepEqual(planAssurance(REPLAY_BOUNDED), plan);
    assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/);

    const unknowns = [
      { description: "dynamic dispatch", surfaces: ["channel/replay-safe-keys"] },
      { description: "dynamic dispatch", surfaces: ["channel/replay-fold"] },
    ];
    const withUnknowns = (order: typeof unknowns) =>
      planAssurance({
        ...REPLAY_BOUNDED,
        impact: impact(REPLAY_FIX_SURFACES, {
          analysis: analysis({ completeness: "partial", unknowns: order }),
        }),
      });
    assert.equal(
      withUnknowns(unknowns).planDigest,
      withUnknowns([...unknowns].reverse()).planDigest,
    );
  });
});

describe("impact bound", () => {
  const perturbed = (
    analysisPatch: Partial<ImpactInput["analysis"]>,
    extra: Surface[] = [],
    claims: AssuranceClaim[] = REPLAY_CLAIMS,
  ): PlanAssuranceInput => ({
    impact: impact([...REPLAY_FIX_SURFACES, ...extra], { analysis: analysis(analysisPatch) }),
    claims,
  });
  const UNBOUNDED: Record<string, PlanAssuranceInput> = {
    "completeness unknown": perturbed({ completeness: "unknown" }),
    "omitted surfaces": perturbed({ omittedSurfaceCount: 1 }),
    "partial without unknowns": perturbed({ completeness: "partial" }),
    "unlocalized unknown": perturbed({
      completeness: "partial",
      unknowns: [{ description: "dynamic dispatch", surfaces: [] }],
    }),
    "unknown on a critical claim": perturbed({
      unknowns: [{ description: "reflection", surfaces: ["channel/live-pins"] }],
    }),
    "unknown on a live surface": perturbed(
      { unknowns: [{ description: "reflection", surfaces: ["channel/live-feed"] }] },
      [surface("channel/live-feed", { reach: "transitive", runtime: "live" })],
      [],
    ),
    "execution context": perturbed({}, [
      surface("pnpm-lock.yaml", { role: "execution-context", runtime: "build" }),
    ]),
    "unknown dependency": {
      ...REPLAY_BOUNDED,
      signals: [signal("d", "UNKNOWN_DEPENDENCY", { exercisesImpactedSurfaces: "yes" })],
    },
    "unplanned impact": {
      ...REPLAY_BOUNDED,
      signals: [signal("u", "UNPLANNED_IMPACT", { surfaces: ["storage/ledger"] })],
    },
  };

  it("treats every incomplete or reopened analysis as unbounded", () => {
    for (const [name, input] of Object.entries(UNBOUNDED)) {
      const plan = planAssurance(input);
      assert.equal(plan.impactBound, "unbounded", name);
      assertIncludes(kinds(plan.requiredEvidence), ["FULL_TEST_SUITE"]);
      assert.deepEqual(notRequired(plan), [], name);
      assert.ok(plan.level >= "P3", name);
    }
    const context = planAssurance(UNBOUNDED["execution context"] as PlanAssuranceInput);
    assert.ok(context.facts.some((fact) => fact.id === "execution-context:changed"));
    assertIncludes(kinds(context.recommendedEvidence), ["MULTI_ENVIRONMENT"]);
  });

  it("applies each unbounded rule alone to a proof-only change", () => {
    const proofOnly = (patchAnalysis: Partial<ImpactInput["analysis"]>) =>
      planAssurance({
        impact: impact(CEILING_REPAIR.impact.surfaces, { analysis: analysis(patchAnalysis) }),
      });
    for (const [name, patchAnalysis] of Object.entries({
      "completeness unknown": { completeness: "unknown" },
      "omitted surfaces": { omittedSurfaceCount: 1 },
      "partial without unknowns": { completeness: "partial" },
      "unlocalized unknown": {
        completeness: "partial",
        unknowns: [{ description: "generated code", surfaces: [] }],
      },
    } satisfies Record<string, Partial<ImpactInput["analysis"]>>)) {
      const plan = proofOnly(patchAnalysis);
      assert.equal(plan.impactBound, "unbounded", name);
      assertIncludes(kinds(plan.requiredEvidence), ["FULL_TEST_SUITE"]);
      assert.deepEqual(notRequired(plan), [], name);
    }
    // An unknown about what the repaired test exercises is sensitive once a high claim covers it.
    const unknownUnder = (criticality: AssuranceClaim["criticality"]) =>
      planAssurance({
        impact: impact(CEILING_REPAIR.impact.surfaces, {
          analysis: analysis({
            completeness: "partial",
            unknowns: [{ description: "reflection", surfaces: ["mechanics/catalog"] }],
          }),
        }),
        claims: [claim("catalog-prefixes", ["mechanics/catalog"], { criticality })],
      });
    assert.equal(unknownUnder("high").impactBound, "unbounded");
    assertIncludes(kinds(unknownUnder("high").requiredEvidence), ["FULL_TEST_SUITE"]);
    assert.notEqual(unknownUnder("standard").impactBound, "unbounded");
    const highClaim = planAssurance({
      ...perturbed(
        { unknowns: [{ description: "reflection", surfaces: ["storage/ledger"] }] },
        [],
        [claim("ledger-balances", ["storage/ledger"], { criticality: "high" })],
      ),
    });
    assert.equal(highClaim.impactBound, "unbounded");
  });

  it("never grants a confident bound to an incomplete analysis of a proof-only change", () => {
    const plan = planAssurance({
      impact: impact(
        [
          surface("ci/runner-config", {
            role: "proof-infrastructure",
            runtime: "build",
            behaviorChange: "fix",
          }),
        ],
        {
          analysis: analysis({
            method: "declared",
            completeness: "unknown",
            uncertainty: "high",
            unknowns: [{ description: "the provider could not resolve the diff", surfaces: [] }],
            omittedSurfaceCount: 40,
          }),
        },
      ),
      claims: [
        claim("ledger-balances", ["billing/ledger"], {
          kind: "invariant",
          criticality: "critical",
          scope: "system",
        }),
      ],
      signals: [signal("t", "TIMEOUT", { attribution: ["DECLARED_ENVIRONMENT_FACTOR"] })],
    });
    assert.equal(plan.impactBound, "unbounded");
    assertIncludes(kinds(plan.requiredEvidence), ["FULL_TEST_SUITE", "INVARIANT_CHECK"]);
    assert.deepEqual(notRequired(plan), []);
    assert.deepEqual(plan.unaffectedClaims, []);
    assert.equal(plan.signals[0]?.classification, "unattributed");
    assert.equal(plan.status, "HOLD");

    const declared = planAssurance({
      impact: impact(CEILING_REPAIR.impact.surfaces, {
        analysis: analysis({ method: "declared" }),
      }),
    });
    assert.equal(declared.impactBound, "bounded-uncertain");
    assert.equal(declared.level, "P1");
    assertIncludes(kinds(declared.recommendedEvidence), ["FULL_TEST_SUITE"]);
  });

  it("raises the subjects an uncertain analysis is about, not a phantom product", () => {
    const plan = planAssurance({
      impact: impact([surface("benchmarks/report", { role: "evaluation" })], {
        analysis: analysis({ method: "declared", uncertainty: "high" }),
      }),
    });
    assert.deepEqual(plan.levelBySubject, [{ subject: "evaluation", level: "P2" }]);
    assertIncludes(kinds(plan.requiredEvidence), ["REVISION_IDENTITY"]);
  });
});

describe("facts beyond the scenario defaults", () => {
  it("scopes reversibility to the changed runtime surfaces and escalates with its cost", () => {
    const costly = planAssurance({
      ...LOCAL_BUGFIX,
      impact: impact(LOCAL_BUGFIX.impact.surfaces, { reversibility: "costly" }),
    });
    assert.equal(costly.level, "P3");
    const irreversible = planAssurance({
      ...LOCAL_BUGFIX,
      impact: impact(LOCAL_BUGFIX.impact.surfaces, { reversibility: "irreversible" }),
    });
    assert.equal(irreversible.level, "P4");
    const rollback = irreversible.requiredEvidence.find((entry) => entry.kind === "ROLLBACK_PLAN");
    assert.deepEqual(rollback?.surfaces, ["billing/rounding"]);
  });

  it("replaces an infeasible causal witness with production-path and corpus evidence", () => {
    const plan = planAssurance({
      ...LOCAL_BUGFIX,
      impact: impact(LOCAL_BUGFIX.impact.surfaces, { causalWitness: "infeasible" }),
    });
    assert.equal(plan.level, "P3");
    assertIncludes(kinds(plan.requiredEvidence), ["PRODUCTION_PATH_TEST", "TARGETED_CORPUS"]);
    assertExcludes(kinds(plan.requiredEvidence), ["CAUSAL_WITNESS"]);
    assertIncludes(kinds(plan.recommendedEvidence), ["INDEPENDENT_REVIEW"]);
    assert.ok(plan.residualUncertainty.some((entry) => entry.id === "witness.infeasible"));
  });

  it("asks environment-sensitive behavior for every supported environment", () => {
    const plan = planAssurance({
      impact: impact([
        surface("sched/clock", { behaviorChange: "fix", environmentSensitive: true }),
      ]),
    });
    assertIncludes(kinds(plan.requiredEvidence), ["MULTI_ENVIRONMENT"]);
    const refactor = planAssurance({
      impact: impact([surface("sched/clock", { environmentSensitive: true })]),
    });
    assertExcludes(kinds(refactor.requiredEvidence), ["MULTI_ENVIRONMENT"]);
  });

  it("recommends regression tests for localized unknowns and flags unknown coverage", () => {
    const localized = planAssurance({
      ...LOCAL_REFACTOR,
      impact: impact([surface("lib/duration-format")], {
        analysis: analysis({
          completeness: "partial",
          unknowns: [{ description: "string formatting table", surfaces: ["lib/duration-format"] }],
        }),
      }),
    });
    assert.equal(localized.impactBound, "bounded-uncertain");
    assertIncludes(kinds(localized.recommendedEvidence), ["TARGETED_REGRESSION"]);
    assert.ok(localized.facts.some((fact) => fact.id === "impact:localized-unknowns"));

    const unknownCoverage = planAssurance({
      impact: impact([surface("lib/duration-format", { coverage: "unknown" })]),
    });
    assert.ok(unknownCoverage.residualUncertainty.some((entry) => entry.id === "coverage.unknown"));
    const unknownFix = planAssurance({
      impact: impact([
        surface("lib/duration-format", { coverage: "unknown", behaviorChange: "fix" }),
      ]),
    });
    assertIncludes(kinds(unknownFix.requiredEvidence), ["CHARACTERIZATION_TESTS"]);
  });

  it("reruns changed tests that no product evidence runs, whatever else changed", () => {
    const plan = planAssurance({
      impact: impact([
        surface("billing/rounding.test", { role: "test", runtime: "build" }),
        surface("docs/billing.md", { role: "documentation", runtime: "none" }),
      ]),
    });
    assert.equal(plan.level, "P1");
    assert.deepEqual(kinds(plan.requiredEvidence), [
      "AFFECTED_JOB_RERUN",
      "DOCUMENTATION_CHECK",
      "STATIC_CHECKS",
    ]);
  });
});

describe("claims, boundaries and the subject they concern", () => {
  const PINS_CLAIM = claim("live-decoder-pins-unchanged", ["channel/live-pins"], {
    kind: "invariant",
    criticality: "critical",
    scope: "system",
  });
  const pinsTest = (overrides: Partial<Surface> = {}) =>
    surface("channel/live-pins.test", {
      role: "test",
      runtime: "build",
      behaviorChange: "fix",
      exercises: ["channel/live-pins"],
      ...overrides,
    });

  it("witnesses the oracle of a high or critical claim whose proof changed", () => {
    const critical = planAssurance({ impact: impact([pinsTest()]), claims: [PINS_CLAIM] });
    assert.equal(critical.level, "P3");
    assert.deepEqual(critical.levelBySubject, [{ subject: "proof-infrastructure", level: "P3" }]);
    assert.deepEqual(kinds(critical.requiredEvidence), [
      "AFFECTED_JOB_RERUN",
      "GATE_DELTA_REVIEW",
      "INDEPENDENT_REVIEW",
      "ORACLE_WITNESS",
      "REVISION_IDENTITY",
      "STATIC_CHECKS",
    ]);
    assert.deepEqual(critical.unaffectedClaims, []);

    const high = planAssurance({
      impact: impact([pinsTest()]),
      claims: [{ ...PINS_CLAIM, criticality: "high" }],
    });
    assert.equal(high.level, "P2");
    assertIncludes(kinds(high.requiredEvidence), ["ORACLE_WITNESS"]);
    assertExcludes(kinds(high.requiredEvidence), ["INDEPENDENT_REVIEW"]);

    const standard = planAssurance({
      impact: impact([pinsTest()]),
      claims: [{ ...PINS_CLAIM, criticality: "standard" }],
    });
    assert.equal(standard.level, "P1");
    assertExcludes(kinds(standard.requiredEvidence), ["ORACLE_WITNESS"]);
    assert.deepEqual(standard.unaffectedClaims, []);

    const additive = planAssurance({
      impact: impact([pinsTest({ behaviorChange: "none" })]),
      claims: [PINS_CLAIM],
    });
    assertExcludes(kinds(additive.requiredEvidence), ["ORACLE_WITNESS"]);

    // A test that names nothing reaches the claims that list it, and says so.
    const { exercises: _unnamed, ...unnamedTest } = pinsTest();
    const listed = planAssurance({
      impact: impact([unnamedTest]),
      claims: [{ ...PINS_CLAIM, surfaces: ["channel/live-pins", "channel/live-pins.test"] }],
    });
    assertIncludes(kinds(listed.requiredEvidence), ["INDEPENDENT_REVIEW", "ORACLE_WITNESS"]);
    assert.ok(listed.residualUncertainty.some((entry) => entry.id === "proof.exercises-unknown"));
    const notListed = planAssurance({ impact: impact([unnamedTest]), claims: [PINS_CLAIM] });
    assertExcludes(kinds(notListed.requiredEvidence), ["ORACLE_WITNESS"]);
    assert.ok(
      notListed.residualUncertainty.some((entry) => entry.id === "proof.exercises-unknown"),
    );

    const harness = planAssurance({
      impact: impact([
        surface("channel/pins-harness", {
          role: "proof-infrastructure",
          runtime: "build",
          behaviorChange: "fix",
          exercises: ["channel/live-pins"],
        }),
      ]),
      claims: [PINS_CLAIM],
    });
    assertIncludes(kinds(harness.requiredEvidence), ["INDEPENDENT_REVIEW", "ORACLE_WITNESS"]);
  });

  it("never turns a claim reached only through its tests into product requalification", () => {
    const quiet = planAssurance(LOCAL_BUGFIX);
    const plan = planAssurance({
      impact: impact([
        ...LOCAL_BUGFIX.impact.surfaces,
        surface("channel/replay.property.test", {
          role: "test",
          runtime: "build",
          behaviorChange: "fix",
          exercises: ["channel/replay"],
        }),
      ]),
      claims: [
        ...(LOCAL_BUGFIX.claims ?? []),
        claim("replay-determinism", ["channel/replay", "channel/replay.property.test"], {
          kind: "invariant",
          criticality: "critical",
          scope: "system",
        }),
      ],
    });
    assert.deepEqual(plan.levelBySubject, [
      { subject: "product", level: "P2" },
      { subject: "proof-infrastructure", level: "P3" },
    ]);
    assertExcludes(kinds(plan.requiredEvidence), [
      "INVARIANT_CHECK",
      "SYSTEM_REQUALIFICATION",
      "TARGETED_INTEGRATION",
    ]);
    const oracleScoped = ["channel/replay.property.test"];
    assert.deepEqual(
      plan.requiredEvidence.find((entry) => entry.kind === "INDEPENDENT_REVIEW")?.surfaces,
      oracleScoped,
    );
    const quietKinds = kinds(quiet.requiredEvidence);
    for (const entry of plan.requiredEvidence.filter((item) => quietKinds.includes(item.kind))) {
      assert.deepEqual(
        entry.surfaces,
        quiet.requiredEvidence.find((item) => item.kind === entry.kind)?.surfaces,
        entry.kind,
      );
    }
  });

  it("checks a documentation claim when the documented behavior changes", () => {
    const readme = claim("readme-exit-code-table", ["cli/exit-codes"], {
      kind: "documentation",
      criticality: "high",
      scope: "system",
    });
    const feature = impact([
      surface("cli/exit-codes", { behaviorChange: "feature", boundaries: ["public-api"] }),
    ]);
    const changed = planAssurance({ impact: feature, claims: [readme] });
    assertIncludes(kinds(changed.requiredEvidence), ["DOCUMENTATION_CHECK"]);
    assert.deepEqual(changed.unaffectedClaims, []);
    assert.equal(changed.level, planAssurance({ impact: feature }).level);
    const refactor = planAssurance({
      impact: impact([surface("cli/exit-codes")]),
      claims: [readme],
    });
    assertExcludes(kinds(refactor.requiredEvidence), ["DOCUMENTATION_CHECK"]);
    assert.deepEqual(
      refactor.unaffectedClaims.map((entry) => entry.id),
      ["readme-exit-code-table"],
    );
  });

  it("keeps evaluation evidence for an evaluation boundary, whatever role carries it", () => {
    const plan = planAssurance({
      impact: impact([
        surface("bench/holdout-evaluator", {
          role: "evaluation",
          boundaries: ["holdout"],
          behaviorChange: "feature",
        }),
        surface("lib/holdout-loader", { boundaries: ["holdout"], behaviorChange: "fix" }),
      ]),
    });
    assert.deepEqual(plan.levelBySubject, [
      { subject: "product", level: "P2" },
      { subject: "evaluation", level: "P5" },
    ]);
    assertIncludes(kinds(plan.requiredEvidence), [
      "CONTAMINATION_CHECK",
      "HOLDOUT_EVALUATION",
      "PREREGISTRATION",
      "PROVENANCE_ATTESTATION",
    ]);

    const transitive = planAssurance({
      impact: impact([
        surface("lib/scoring", { behaviorChange: "fix" }),
        surface("bench/arena", {
          role: "evaluation",
          reach: "transitive",
          boundaries: ["benchmark"],
          behaviorChange: "suspected",
        }),
      ]),
    });
    assert.equal(transitive.level, "P2");
    assertIncludes(kinds(transitive.recommendedEvidence), ["BENCHMARK_PROTOCOL"]);
  });

  it("keeps security, admission and decision boundaries on proof surfaces", () => {
    const release = planAssurance({
      impact: impact([
        surface("github/workflows/release.yml", {
          role: "proof-infrastructure",
          runtime: "build",
          boundaries: ["security", "admission"],
          behaviorChange: "feature",
        }),
      ]),
    });
    assert.equal(release.level, "P4");
    assertIncludes(kinds(release.requiredEvidence), [
      "INDEPENDENT_REVIEW",
      "SYSTEM_REQUALIFICATION",
    ]);
    const additiveTest = planAssurance({
      impact: impact([
        surface("auth/session.test", { role: "test", runtime: "build", boundaries: ["security"] }),
      ]),
    });
    assert.equal(additiveTest.level, "P1");
  });

  it("raises a product refactor by the scope of a direct claim and by a security boundary", () => {
    const parser = (overrides: Partial<Surface> = {}) =>
      impact([surface("core/parser", overrides)]);
    const scoped = (scope: AssuranceClaim["scope"]) =>
      planAssurance({ impact: parser(), claims: [claim("parses", ["core/parser"], { scope })] });
    assert.deepEqual(scoped("local").levelBySubject, [{ subject: "product", level: "P1" }]);
    assert.deepEqual(scoped("component").levelBySubject, [{ subject: "product", level: "P2" }]);
    assertExcludes(kinds(scoped("component").requiredEvidence), ["SYSTEM_REQUALIFICATION"]);
    assert.deepEqual(scoped("system").levelBySubject, [{ subject: "product", level: "P4" }]);
    assertIncludes(kinds(scoped("system").requiredEvidence), ["SYSTEM_REQUALIFICATION"]);

    const security = planAssurance({ impact: parser({ boundaries: ["security"] }) });
    assert.deepEqual(security.levelBySubject, [{ subject: "product", level: "P3" }]);
    assertIncludes(kinds(security.requiredEvidence), ["INDEPENDENT_REVIEW"]);
    const plain = planAssurance({ impact: parser() });
    assertExcludes(kinds(plain.requiredEvidence), ["INDEPENDENT_REVIEW"]);
  });
});

// Abstract reproduction of an observed pull request: a three-line replay-adapter fix, legitimate
// targeted proof, then two peripheral wall-clock ceilings that timed out one after the other.
describe("evidence carry-over across a localized fix and two peripheral timeouts", () => {
  const MECHANICS_CEILING = "mechanics/catalog-prefix.property.test";
  const DECISION_GUARD = "decision/coarse-opponent.test";
  const ceiling = (id: string, role: "test" | "proof-infrastructure", exercises?: string[]) =>
    surface(id, {
      role,
      runtime: "build",
      behaviorChange: "fix",
      environmentSensitive: true,
      ...(exercises === undefined ? {} : { exercises }),
    });
  const revision = (
    id: string,
    extra: Surface[],
    overrides: Partial<ImpactInput["revision"]> = {},
  ): PlanAssuranceInput => ({
    impact: impact([...REPLAY_FIX_SURFACES, ...extra], {
      revision: { id, baseline: BASE, runtimeTreeDigest: digest("tree@1"), ...overrides },
    }),
    claims: REPLAY_CLAIMS,
  });
  const sequence = (role: "test" | "proof-infrastructure", policy?: AssurancePolicy) => {
    const withPolicy = (input: PlanAssuranceInput) =>
      policy === undefined ? input : { ...input, policy };
    const mechanics = ceiling(MECHANICS_CEILING, role, ["mechanics/catalog"]);
    const decision = ceiling(DECISION_GUARD, role, ["decision/coarse-opponent"]);
    const r1 = planAssurance(
      withPolicy({
        ...revision(R1, []),
        signals: [
          signal("t1", "TIMEOUT", {
            surfaces: [MECHANICS_CEILING],
            attribution: ["PASSES_ON_SAME_REVISION", "OUTSIDE_IMPACT"],
            detail: "10,000-prefix property at 30.4s for a 30s ceiling; 12.2s on the same tree",
          }),
        ],
      }),
    );
    const r2 = planAssurance(
      withPolicy({
        ...revision(R2, [mechanics]),
        signals: [
          signal("t2", "TIMEOUT", {
            revision: R2,
            surfaces: [DECISION_GUARD],
            attribution: ["OUTSIDE_IMPACT", "DECLARED_ENVIRONMENT_FACTOR"],
            detail: "perf guard at 2.78s for 1.5s, literal not routed to the CI latency factor",
          }),
        ],
      }),
    );
    const r3 = planAssurance(withPolicy(revision(R3, [mechanics, decision])));
    return { r1, r2, r3 };
  };
  const mustProduceKinds = (carry: EvidenceCarryOver) =>
    [...new Set(carry.mustProduce.map((entry) => entry.kind))].sort();

  it("keeps the legitimate targeted proof and exempts the global ceremony at r1", () => {
    const { r1 } = sequence("test");
    assert.equal(r1.level, "P3");
    assert.equal(r1.status, "PROVE");
    assertIncludes(kinds(r1.requiredEvidence), [
      "CAUSAL_WITNESS",
      "PRODUCTION_PATH_TEST",
      "TARGETED_REGRESSION",
      "TARGETED_CORPUS",
      "REVISION_IDENTITY",
    ]);
    assertIncludes(notRequired(r1), [
      "FULL_TEST_SUITE",
      "FULL_CORPUS",
      "SYSTEM_REQUALIFICATION",
      "INDEPENDENT_REVIEW",
      "MULTI_ENVIRONMENT",
      "BENCHMARK_PROTOCOL",
      "HOLDOUT_EVALUATION",
    ]);
    assert.equal(r1.signals[0]?.classification, "proof-infrastructure");
  });

  it("re-produces only revision-bound and gate evidence after each ceiling repair", () => {
    for (const role of ["test", "proof-infrastructure"] as const) {
      const { r1, r2, r3 } = sequence(role);
      assert.equal(r2.level, "P3", role);
      assert.equal(r3.level, "P3", role);
      assert.equal(
        r2.signals.find((entry) => entry.id === "t2")?.classification,
        "proof-infrastructure",
      );
      const first = carryOverEvidence(r1, r2);
      const second = carryOverEvidence(r2, r3);
      const expected = [
        "AFFECTED_JOB_RERUN",
        "GATE_DELTA_REVIEW",
        "REVISION_IDENTITY",
        "STATIC_CHECKS",
      ];
      assert.deepEqual(mustProduceKinds(first), expected, role);
      assert.deepEqual(mustProduceKinds(second), expected, role);
      assertIncludes(kinds(second.reusable), [
        "AFFECTED_TESTS",
        "CAUSAL_WITNESS",
        "DOCUMENTATION_CHECK",
        "PRODUCTION_PATH_TEST",
        "TARGETED_CORPUS",
        "TARGETED_INTEGRATION",
        "TARGETED_REGRESSION",
      ]);
      // Job reruns follow the failing and the repaired jobs, never the product surfaces.
      const reruns = (carry: EvidenceCarryOver) =>
        carry.mustProduce
          .filter((entry) => entry.kind === "AFFECTED_JOB_RERUN")
          .flatMap((entry) => entry.surfaces)
          .sort();
      assert.deepEqual(reruns(first), [DECISION_GUARD, MECHANICS_CEILING], role);
      assert.deepEqual(reruns(second), [DECISION_GUARD], role);
      const gate = second.mustProduce.find((entry) => entry.kind === "GATE_DELTA_REVIEW");
      assert.deepEqual(gate?.surfaces, [DECISION_GUARD], role);
      const reusedGate = second.reusable.find((entry) => entry.kind === "GATE_DELTA_REVIEW");
      assert.deepEqual(reusedGate?.surfaces, [MECHANICS_CEILING], role);
    }
  });

  it("costs far less than a revision-bound global policy while keeping the same product proof", () => {
    const revisionBound: AssurancePolicy = {
      ...DEFAULT_ASSURANCE_POLICY,
      id: "model.revision-bound-global",
      version: "0.0.1",
      evidence: DEFAULT_ASSURANCE_POLICY.evidence.map((spec) => ({
        ...spec,
        binding: "exact-revision" as const,
      })),
      baselines: [
        ...DEFAULT_ASSURANCE_POLICY.baselines,
        { level: "P3", kind: "FULL_TEST_SUITE" },
        { level: "P3", kind: "INDEPENDENT_REVIEW" },
      ],
    };
    const before = sequence("test", revisionBound);
    const after = sequence("test");
    const cost = (plans: { r1: AssurancePlan; r2: AssurancePlan; r3: AssurancePlan }) =>
      plans.r1.requiredEvidence.length +
      mustProduceKinds(carryOverEvidence(plans.r1, plans.r2)).length +
      mustProduceKinds(carryOverEvidence(plans.r2, plans.r3)).length;
    assert.equal(before.r1.level, "P3");
    assert.equal(before.r1.requiredEvidence.length, 12);
    assert.equal(after.r1.requiredEvidence.length, 10);
    assert.equal(mustProduceKinds(carryOverEvidence(before.r1, before.r2)).length, 13);
    assert.equal(mustProduceKinds(carryOverEvidence(before.r2, before.r3)).length, 13);
    assert.equal(cost(after), after.r1.requiredEvidence.length + 8);
    assert.ok(cost(after) < cost(before), `${cost(after)} >= ${cost(before)}`);
    assert.deepEqual(
      mustProduceKinds(carryOverEvidence(before.r1, before.r2)),
      kinds(before.r2.requiredEvidence),
    );
    assertIncludes(
      kinds(after.r3.requiredEvidence),
      kinds(before.r1.requiredEvidence).filter(
        (kind) => kind !== "FULL_TEST_SUITE" && kind !== "INDEPENDENT_REVIEW",
      ),
    );
  });

  it("stays conservative when a repair is not what it claims to be", () => {
    const { r1 } = sequence("test");
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const productKinds = ["CAUSAL_WITNESS", "TARGETED_CORPUS", "PRODUCTION_PATH_TEST"];

    const rebased = planAssurance(revision(R2, [mechanics], { baseline: "4".repeat(40) }));
    assert.deepEqual(carryOverEvidence(r1, rebased).reusable, []);

    const treeMoved = planAssurance(
      revision(R2, [mechanics], { runtimeTreeDigest: digest("tree@2") }),
    );
    assertIncludes(mustProduceKinds(carryOverEvidence(r1, treeMoved)), productKinds);

    const unscopedTest = planAssurance(revision(R2, [ceiling(MECHANICS_CEILING, "test")]));
    assertIncludes(mustProduceKinds(carryOverEvidence(r1, unscopedTest)), productKinds);

    const smuggled = planAssurance({
      impact: impact(
        [
          ...REPLAY_FIX_SURFACES.map((entry) =>
            entry.id === "channel/replay-safe-keys"
              ? { ...entry, contentDigest: digest("channel/replay-safe-keys@2") }
              : entry,
          ),
          mechanics,
        ],
        { revision: { id: R2, baseline: BASE, runtimeTreeDigest: digest("tree@1") } },
      ),
      claims: REPLAY_CLAIMS,
    });
    const smuggledCarry = carryOverEvidence(r1, smuggled);
    assert.ok(
      smuggledCarry.mustProduce.some(
        (entry) => entry.kind === "CAUSAL_WITNESS" && entry.reason === "surface content changed",
      ),
    );

    const diverged = planAssurance({
      ...revision(R1, []),
      signals: [signal("d", "CORPUS_DIVERGENCE", { surfaces: ["channel/replay-fold"] })],
    });
    assert.equal(diverged.level, "P4");
    const sameRevision = carryOverEvidence(r1, diverged);
    assertIncludes(mustProduceKinds(sameRevision), ["FULL_CORPUS", "INDEPENDENT_REVIEW"]);
    assertIncludes(kinds(sameRevision.reusable), ["CAUSAL_WITNESS", "STATIC_CHECKS"]);

    const touchingReplay = planAssurance({
      ...revision(R1, []),
      signals: [
        signal("t", "TIMEOUT", {
          surfaces: ["channel/replay-safe-keys.test"],
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(touchingReplay.status, "HOLD");
  });

  it("forces re-production whenever a digest it relies on is missing", () => {
    const { r1 } = sequence("test");
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const withoutDigest = (id: string) =>
      REPLAY_FIX_SURFACES.map((entry) => {
        if (entry.id !== id) return entry;
        const { contentDigest: _dropped, ...rest } = entry;
        return rest;
      });
    const plansWithout = (id: string) => {
      const input = (revisionId: string, extra: Surface[]): PlanAssuranceInput => ({
        impact: impact([...withoutDigest(id), ...extra], {
          revision: { id: revisionId, baseline: BASE, runtimeTreeDigest: digest("tree@1") },
        }),
        claims: REPLAY_CLAIMS,
      });
      return carryOverEvidence(planAssurance(input(R1, [])), planAssurance(input(R2, [mechanics])));
    };
    const surfaceUnknown = plansWithout("channel/replay-safe-keys");
    assert.ok(
      surfaceUnknown.mustProduce.some(
        (entry) => entry.kind === "CAUSAL_WITNESS" && entry.reason === "surface digest unknown",
      ),
    );
    const testUnknown = plansWithout("channel/replay-safe-keys.test");
    assert.ok(
      testUnknown.mustProduce.some(
        (entry) =>
          entry.kind === "CAUSAL_WITNESS" &&
          entry.reason === "a test or proof surface exercising the surface changed",
      ),
    );

    const noTree = (revisionId: string, extra: Surface[]): PlanAssuranceInput => ({
      impact: impact([...REPLAY_FIX_SURFACES, ...extra], {
        revision: { id: revisionId, baseline: BASE },
      }),
      claims: REPLAY_CLAIMS,
    });
    const treeUnknown = carryOverEvidence(
      planAssurance(noTree(R1, [])),
      planAssurance(noTree(R2, [mechanics])),
    );
    assert.ok(
      treeUnknown.mustProduce.some(
        (entry) =>
          entry.kind === "CAUSAL_WITNESS" && entry.reason === "runtime tree changed or unknown",
      ),
    );
    assertIncludes(kinds(treeUnknown.reusable), ["DOCUMENTATION_CHECK"]);
    assert.ok(
      kinds(carryOverEvidence(r1, sequence("test").r2).reusable).includes("CAUSAL_WITNESS"),
    );
  });

  it("invalidates evidence whose proof harness or measured code changed, whatever its role", () => {
    const { r1 } = sequence("test");
    for (const role of ["test", "proof-infrastructure"] as const) {
      const harness = surface("channel/replay-corpus-harness", {
        role,
        runtime: "build",
        behaviorChange: "fix",
        exercises: ["channel/replay-safe-keys"],
      });
      const next = planAssurance(revision(R2, [harness]));
      const carry = carryOverEvidence(r1, next);
      assert.ok(
        carry.mustProduce.some(
          (entry) =>
            entry.kind === "CAUSAL_WITNESS" && entry.surfaces.includes("channel/replay-safe-keys"),
        ),
        role,
      );
    }
    // A gate delta review justifies a budget with durations measured on the code the gate runs.
    const { r2 } = sequence("test");
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const moved = planAssurance(revision(R3, [mechanics], { runtimeTreeDigest: digest("tree@2") }));
    const gate = carryOverEvidence(r2, moved).mustProduce.find(
      (entry) => entry.kind === "GATE_DELTA_REVIEW",
    );
    assert.equal(gate?.reason, "runtime tree changed or unknown");

    // A changed harness that names nothing it exercises re-runs its own review only, and the plan
    // reports what it cannot know.
    const unlisted = (id: string, version: string) =>
      planAssurance(
        revision(id, [
          surface("ci/harness", {
            role: "proof-infrastructure",
            runtime: "build",
            behaviorChange: "fix",
            contentDigest: digest(`ci/harness@${version}`),
          }),
        ]),
      );
    const afterHarness = unlisted(R2, "2");
    const harnessCarry = carryOverEvidence(unlisted(R1, "1"), afterHarness);
    assertIncludes(kinds(harnessCarry.reusable), ["CAUSAL_WITNESS", "TARGETED_REGRESSION"]);
    assert.deepEqual(
      harnessCarry.mustProduce.find((entry) => entry.kind === "GATE_DELTA_REVIEW")?.surfaces,
      ["ci/harness"],
    );
    assert.ok(
      afterHarness.residualUncertainty.some((entry) => entry.id === "proof.exercises-unknown"),
    );
  });

  it("reuses runtime-tree and rollback evidence across a proof-only commit", () => {
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const unbounded = (id: string, extra: Surface[]): PlanAssuranceInput => ({
      impact: impact([...REPLAY_FIX_SURFACES, ...extra], {
        revision: { id, baseline: BASE, runtimeTreeDigest: digest("tree@1") },
        analysis: analysis({ completeness: "partial" }),
        reversibility: "costly",
      }),
      claims: REPLAY_CLAIMS,
    });
    const r1 = planAssurance(unbounded(R1, []));
    assertIncludes(kinds(r1.requiredEvidence), ["FULL_TEST_SUITE", "ROLLBACK_PLAN"]);
    const carry = carryOverEvidence(r1, planAssurance(unbounded(R2, [mechanics])));
    assertIncludes(kinds(carry.reusable), ["FULL_TEST_SUITE", "ROLLBACK_PLAN"]);
    assertExcludes(mustProduceKinds(carry), ["FULL_TEST_SUITE", "ROLLBACK_PLAN"]);
  });

  it("never carries evidence past an unresolved product signal", () => {
    const blocked = planAssurance({
      ...revision(R1, []),
      signals: [signal("reg", "REGRESSION", { surfaces: ["channel/replay-safe-keys"] })],
    });
    assert.equal(blocked.status, "BLOCKED");
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const next = planAssurance(revision(R2, [mechanics]));
    const carry = carryOverEvidence(blocked, next);
    for (const kind of ["CAUSAL_WITNESS", "TARGETED_REGRESSION", "TARGETED_CORPUS"]) {
      assert.ok(
        carry.mustProduce.some(
          (entry) =>
            entry.kind === kind &&
            entry.surfaces.includes("channel/replay-safe-keys") &&
            /unresolved \(reg\)/.test(entry.reason),
        ),
        kind,
      );
    }
    assertIncludes(kinds(carry.reusable), ["DOCUMENTATION_CHECK"]);

    // Reported under a name the impact does not know, the regression may concern anything.
    const misnamed = planAssurance({
      ...revision(R1, []),
      signals: [signal("reg-job", "REGRESSION", { surfaces: ["ci/e2e-job"] })],
    });
    assert.equal(misnamed.status, "BLOCKED");
    const misnamedCarry = carryOverEvidence(misnamed, next);
    assert.deepEqual(misnamedCarry.reusable, []);
    assert.ok(
      misnamedCarry.mustProduce.some(
        (entry) =>
          entry.kind === "CAUSAL_WITNESS" &&
          entry.surfaces.includes("channel/replay-safe-keys") &&
          /unresolved \(reg-job\)/.test(entry.reason),
      ),
    );
  });

  it("blocks runtime-tree evidence and unmapped surfaces behind an unresolved signal", () => {
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const partial = (id: string, extra: Surface[], signals: ProofSignal[] = []) =>
      planAssurance({
        impact: impact([...REPLAY_FIX_SURFACES, ...extra], {
          revision: { id, baseline: BASE, runtimeTreeDigest: digest("tree@1") },
          analysis: analysis({ completeness: "partial" }),
        }),
        claims: REPLAY_CLAIMS,
        signals,
      });
    const regressed = partial(
      R1,
      [],
      [signal("reg", "REGRESSION", { surfaces: ["channel/replay-safe-keys"] })],
    );
    assertIncludes(kinds(regressed.requiredEvidence), ["FULL_TEST_SUITE"]);
    const suite = carryOverEvidence(regressed, partial(R2, [mechanics])).mustProduce.find(
      (entry) => entry.kind === "FULL_TEST_SUITE",
    );
    assert.match(suite?.reason ?? "", /unresolved \(reg\)/);

    const unnamed = planAssurance({
      ...revision(R1, []),
      signals: [signal("odd", "UNEXPECTED_BEHAVIOR", { exercisesImpactedSurfaces: "yes" })],
    });
    const unnamedCarry = carryOverEvidence(unnamed, planAssurance(revision(R2, [mechanics])));
    assert.ok(
      unnamedCarry.mustProduce.some(
        (entry) => entry.kind === "CAUSAL_WITNESS" && /unresolved \(odd\)/.test(entry.reason),
      ),
    );

    // An unattributed failure of the changed test concerns what that test exercises.
    const slow = planAssurance({
      ...revision(R1, []),
      signals: [
        signal("slow", "TIMEOUT", {
          surfaces: ["channel/replay-safe-keys.test"],
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(slow.status, "HOLD");
    const slowCarry = carryOverEvidence(slow, planAssurance(revision(R2, [mechanics])));
    assert.ok(
      slowCarry.mustProduce.some(
        (entry) =>
          entry.kind === "CAUSAL_WITNESS" &&
          entry.surfaces.includes("channel/replay-safe-keys") &&
          /unresolved \(slow\)/.test(entry.reason),
      ),
    );
    assertIncludes(kinds(slowCarry.reusable), ["DOCUMENTATION_CHECK"]);

    // A failure that may exercise the change on a job the impact cannot map concerns everything.
    const unmapped = planAssurance({
      ...revision(R1, []),
      signals: [
        signal("elsewhere", "TIMEOUT", {
          surfaces: ["channel/replay.e2e.test"],
          exercisesImpactedSurfaces: "yes",
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(unmapped.status, "HOLD");
    const unmappedCarry = carryOverEvidence(unmapped, planAssurance(revision(R2, [mechanics])));
    assert.ok(
      unmappedCarry.mustProduce.some(
        (entry) => entry.kind === "CAUSAL_WITNESS" && /unresolved \(elsewhere\)/.test(entry.reason),
      ),
    );
  });

  it("treats a failure that names no surface as unresolved, unlike one confidently outside", () => {
    const next = planAssurance(revision(R2, []));
    const unnamed = planAssurance({
      ...revision(R1, []),
      signals: [signal("t", "TIMEOUT", { attribution: ["PASSES_ON_SAME_REVISION"] })],
    });
    assert.equal(unnamed.status, "HOLD");
    assert.equal(unnamed.signals[0]?.classification, "unattributed");
    assert.equal(unnamed.signals[0]?.exercises, "unknown");
    const unnamedCarry = carryOverEvidence(unnamed, next);
    assert.deepEqual(unnamedCarry.reusable, []);
    assert.ok(
      unnamedCarry.mustProduce.some(
        (entry) =>
          entry.kind === "CAUSAL_WITNESS" &&
          entry.surfaces.includes("channel/replay-safe-keys") &&
          /unresolved \(t\)/.test(entry.reason),
      ),
    );

    // Without an admissible basis the failing job still holds its own revision, but a job the
    // bounded impact places outside the change concerns no product evidence.
    const outside = planAssurance({
      ...revision(R1, []),
      signals: [signal("lint", "TIMEOUT", { surfaces: ["tools/lint-job"] })],
    });
    assert.equal(outside.status, "HOLD");
    assert.equal(outside.signals[0]?.classification, "unattributed");
    assert.equal(outside.signals[0]?.exercises, "no");
    const outsideCarry = carryOverEvidence(outside, next);
    assertIncludes(kinds(outsideCarry.reusable), ["CAUSAL_WITNESS", "TARGETED_REGRESSION"]);
    assert.ok(
      outsideCarry.mustProduce.every((entry) => entry.reason === "bound to the exact revision"),
    );
  });

  it("maps an unresolved failure of a proof surface to what it lists, or to everything", () => {
    const carryPast = (id: string, proof: Surface, overrides: Partial<ProofSignal> = {}) => {
      const previous = planAssurance({
        ...revision(R1, [proof]),
        signals: [
          signal(id, "TIMEOUT", {
            surfaces: [proof.id],
            attribution: ["PASSES_ON_SAME_REVISION"],
            ...overrides,
          }),
        ],
      });
      assert.equal(previous.status, "HOLD");
      assert.equal(previous.signals[0]?.classification, "unattributed");
      return carryOverEvidence(previous, planAssurance(revision(R2, [proof])));
    };
    const blockedOn = (carry: EvidenceCarryOver, kind: string, id: string) =>
      carry.mustProduce.find(
        (entry) => entry.kind === kind && entry.reason.includes(`unresolved (${id})`),
      )?.surfaces;

    // A harness that lists what it exercises concerns that, and only that.
    const listed = carryPast(
      "runner",
      surface("harness/replay-runner", {
        role: "proof-infrastructure",
        runtime: "build",
        exercises: ["channel/replay-fold"],
      }),
    );
    assert.deepEqual(blockedOn(listed, "TARGETED_REGRESSION", "runner"), ["channel/replay-fold"]);
    assert.deepEqual(
      listed.reusable.find((entry) => entry.kind === "TARGETED_REGRESSION")?.surfaces,
      ["channel/replay-safe-keys"],
    );
    assertIncludes(kinds(listed.reusable), ["CAUSAL_WITNESS", "DOCUMENTATION_CHECK"]);

    // A harness that does not list what it exercises is taken not to exercise the change when its
    // failure is classified, so a declared outside-impact attribution stands.
    const harness = surface("ci/harness", { role: "proof-infrastructure", runtime: "build" });
    const declaredOutside = planAssurance({
      ...revision(R1, [harness]),
      signals: [
        signal("harness", "TIMEOUT", {
          surfaces: ["ci/harness"],
          attribution: ["PASSES_ON_SAME_REVISION"],
        }),
      ],
    });
    assert.equal(declaredOutside.signals[0]?.classification, "proof-infrastructure");
    assert.equal(declaredOutside.status, "PROVE");

    // Once such a failure is unresolved, a harness or a test that does not list what it
    // exercises may exercise anything.
    const unlisted = {
      harness: carryPast("harness", harness, { exercisesImpactedSurfaces: "yes" }),
      extra: carryPast("extra", surface("channel/extra.test", { role: "test", runtime: "build" })),
    };
    for (const [id, carry] of Object.entries(unlisted)) {
      assert.deepEqual(carry.reusable, [], id);
      assert.deepEqual(blockedOn(carry, "CAUSAL_WITNESS", id), ["channel/replay-safe-keys"], id);
      assert.deepEqual(
        blockedOn(carry, "DOCUMENTATION_CHECK", id),
        ["docs/live-active-status.md"],
        id,
      );
    }
  });

  it("treats an execution context and a signal of the next revision as unresolved too", () => {
    const lockfile = surface("pnpm-lock.yaml", { role: "execution-context", runtime: "build" });
    const locked = planAssurance({
      ...revision(R1, [lockfile]),
      signals: [signal("lock", "REGRESSION", { surfaces: ["pnpm-lock.yaml"] })],
    });
    assert.equal(locked.status, "BLOCKED");
    // An execution context reaches what static analysis cannot bound.
    assert.deepEqual(
      carryOverEvidence(locked, planAssurance(revision(R2, [lockfile]))).reusable,
      [],
    );

    // A divergence observed on the next revision voids the earlier corpus run on its surfaces.
    const diverged = planAssurance({
      ...revision(R2, []),
      signals: [
        signal("div", "CORPUS_DIVERGENCE", { revision: R2, surfaces: ["channel/replay-fold"] }),
      ],
    });
    assert.equal(diverged.status, "PROVE");
    const carry = carryOverEvidence(planAssurance(revision(R1, [])), diverged);
    assert.deepEqual(
      carry.mustProduce.find(
        (entry) => entry.kind === "TARGETED_CORPUS" && entry.reason.includes("unresolved (div)"),
      )?.surfaces,
      ["channel/replay-fold"],
    );
    assert.deepEqual(carry.reusable.find((entry) => entry.kind === "TARGETED_CORPUS")?.surfaces, [
      "channel/replay-safe-keys",
    ]);

    // Within one revision, a signal the next plan newly observes contradicts the earlier run too,
    // even when it neither holds nor blocks the plan.
    const divergedNow = planAssurance({
      ...revision(R1, []),
      signals: [signal("div", "CORPUS_DIVERGENCE", { surfaces: ["channel/replay-fold"] })],
    });
    assert.equal(divergedNow.status, "PROVE");
    assert.deepEqual(
      carryOverEvidence(planAssurance(revision(R1, [])), divergedNow).mustProduce.find(
        (entry) => entry.kind === "TARGETED_CORPUS",
      )?.surfaces,
      ["channel/replay-fold"],
    );
    // Evidence produced beside a signal answers it: within one revision it is reused.
    assert.deepEqual(carryOverEvidence(divergedNow, divergedNow).mustProduce, []);
    const blocked = planAssurance({
      ...revision(R1, []),
      signals: [signal("reg", "REGRESSION", { surfaces: ["channel/replay-safe-keys"] })],
    });
    assert.deepEqual(carryOverEvidence(blocked, blocked).mustProduce, []);
  });

  it("never reuses evidence for a surface it was not produced for", () => {
    const readme = claim("readme-exit-code-table", ["cli/exit-codes"], { kind: "documentation" });
    const at = (id: string, behaviorChange: Surface["behaviorChange"]) =>
      planAssurance({
        impact: impact(
          [
            surface("cli/exit-codes", { behaviorChange }),
            surface("docs/exit-codes.md", { role: "documentation", runtime: "none" }),
          ],
          { revision: { id, baseline: BASE, runtimeTreeDigest: digest("tree@1") } },
        ),
        claims: [readme],
      });
    // Same digests and tree: only the scope of the documentation check grew.
    const carry = carryOverEvidence(at(R1, "none"), at(R2, "feature"));
    const check = carry.mustProduce.find((entry) => entry.kind === "DOCUMENTATION_CHECK");
    assert.deepEqual(check?.surfaces, ["cli/exit-codes"]);
    assert.equal(check?.reason, "surface newly in scope");
    assert.deepEqual(
      carry.reusable.find((entry) => entry.kind === "DOCUMENTATION_CHECK")?.surfaces,
      ["docs/exit-codes.md"],
    );
  });

  it("accounts for every required kind and surface of the next plan", () => {
    const unnamedAt = (id: string) =>
      planAssurance({
        ...revision(id, []),
        signals: [
          signal("t", "TIMEOUT", { revision: id, attribution: ["PASSES_ON_SAME_REVISION"] }),
        ],
      });
    const { r1, r2, r3 } = sequence("test");
    const pairs: [AssurancePlan, AssurancePlan][] = [
      [r1, r2],
      [r2, r3],
      [r1, r1],
      [unnamedAt(R1), unnamedAt(R2)],
    ];
    for (const [previous, next] of pairs) {
      const carry = carryOverEvidence(previous, next);
      const entries = [...carry.reusable, ...carry.mustProduce];
      assert.deepEqual(
        [...new Set(entries.map((entry) => entry.kind))].sort(),
        [...new Set(kinds(next.requiredEvidence))].sort(),
      );
      for (const requirement of next.requiredEvidence) {
        assert.deepEqual(
          entries
            .filter((entry) => entry.kind === requirement.kind)
            .flatMap((entry) => entry.surfaces)
            .sort(),
          [...requirement.surfaces].sort(),
          requirement.kind,
        );
      }
    }
    // Attribution of a failure that names no surface is revision-wide evidence.
    const unscoped = carryOverEvidence(unnamedAt(R1), unnamedAt(R2)).mustProduce.find(
      (entry) => entry.kind === "FAILURE_ATTRIBUTION",
    );
    assert.deepEqual(unscoped?.surfaces, []);
    assert.equal(unscoped?.reason, "bound to the exact revision");
  });

  it("re-checks a documentation claim on a runtime surface when the runtime tree changes", () => {
    const readme = claim("readme-exit-code-table", ["cli/exit-codes"], { kind: "documentation" });
    const documented = [
      surface("cli/exit-codes", { behaviorChange: "feature" }),
      surface("docs/exit-codes.md", { role: "documentation", runtime: "none" }),
    ];
    const at = (id: string, tree: string, extra: Surface[] = []) =>
      planAssurance({
        impact: impact([...documented, ...extra], {
          revision: { id, baseline: BASE, runtimeTreeDigest: digest(tree) },
        }),
        claims: [readme],
      });
    const r1 = at(R1, "tree@1");
    const docCheck = (entries: ReadonlyArray<{ kind: string; surfaces: string[] }>) =>
      entries.find((entry) => entry.kind === "DOCUMENTATION_CHECK");
    assert.deepEqual(docCheck(r1.requiredEvidence)?.surfaces, [
      "cli/exit-codes",
      "docs/exit-codes.md",
    ]);
    // The documented surface keeps its digest while code it depends on changes.
    const moved = carryOverEvidence(
      r1,
      at(R2, "tree@2", [surface("lib/exit-mapping", { behaviorChange: "fix" })]),
    );
    assert.deepEqual(docCheck(moved.mustProduce)?.surfaces, ["cli/exit-codes"]);
    assert.equal(
      moved.mustProduce.find((entry) => entry.kind === "DOCUMENTATION_CHECK")?.reason,
      "runtime tree changed or unknown",
    );
    // A documentation file is checked against its own text.
    assert.deepEqual(docCheck(moved.reusable)?.surfaces, ["docs/exit-codes.md"]);
    assert.deepEqual(docCheck(carryOverEvidence(r1, at(R2, "tree@1")).reusable)?.surfaces, [
      "cli/exit-codes",
      "docs/exit-codes.md",
    ]);

    // Evidence about a documentation file that is not documentation-only still follows the tree.
    const linkCheck = (id: string, tree: string) =>
      planAssurance({
        impact: impact(documented, {
          revision: { id, baseline: BASE, runtimeTreeDigest: digest(tree) },
        }),
        claims: [readme],
        signals: [
          signal("links", "TIMEOUT", {
            revision: id,
            surfaces: ["docs/exit-codes.md"],
            attribution: ["REPRODUCES_ON_BASELINE"],
          }),
        ],
      });
    const attribution = carryOverEvidence(
      linkCheck(R1, "tree@1"),
      linkCheck(R2, "tree@2"),
    ).mustProduce.find((entry) => entry.kind === "FAILURE_ATTRIBUTION");
    assert.deepEqual(attribution?.surfaces, ["docs/exit-codes.md"]);
    assert.equal(attribution?.reason, "runtime tree changed or unknown");
  });

  it("binds evidence that answers a signal to that observation, not to its kind", () => {
    const harness = surface("harness/ci-job", {
      role: "proof-infrastructure",
      runtime: "build",
      exercises: [],
    });
    const failingAt = (id: string, signalId: string) =>
      planAssurance({
        ...revision(id, [harness]),
        signals: [signal(signalId, "TIMEOUT", { revision: id, surfaces: ["harness/ci-job"] })],
      });
    const first = failingAt(R1, "a");
    assert.equal(first.signals[0]?.classification, "unattributed");
    assert.equal(first.signals[0]?.exercises, "no");
    assert.equal(first.signals[0]?.revision, R1);
    // Same baseline, tree and digests: only the failure differs.
    const attribution = carryOverEvidence(first, failingAt(R2, "b")).mustProduce.find(
      (entry) => entry.kind === "FAILURE_ATTRIBUTION",
    );
    assert.deepEqual(attribution?.surfaces, ["harness/ci-job"]);
    assert.match(attribution?.reason ?? "", /answers an observation/);
    // A job failing again under the same name on another revision is another observation.
    assert.ok(
      carryOverEvidence(first, failingAt(R2, "a")).mustProduce.some(
        (entry) =>
          entry.kind === "FAILURE_ATTRIBUTION" && /answers an observation/.test(entry.reason),
      ),
    );

    // A stricter policy may answer an observation with runtime-tree evidence: same rule.
    const suiteOnFailure: AssurancePolicy = {
      ...DEFAULT_ASSURANCE_POLICY,
      id: "example.suite-on-infrastructure-failure",
      triggers: DEFAULT_ASSURANCE_POLICY.triggers.map((entry) =>
        entry.fact === "observed:infrastructure-failure"
          ? { ...entry, require: [...entry.require, "FULL_TEST_SUITE"] }
          : entry,
      ),
    };
    const attributedAt = (id: string, signalId: string) =>
      planAssurance({
        ...revision(id, []),
        policy: suiteOnFailure,
        signals: [
          signal(signalId, "TIMEOUT", {
            revision: id,
            surfaces: ["elsewhere/job"],
            attribution: ["OUTSIDE_IMPACT"],
          }),
        ],
      });
    const suite = carryOverEvidence(attributedAt(R1, "a"), attributedAt(R2, "b")).mustProduce.find(
      (entry) => entry.kind === "FULL_TEST_SUITE",
    );
    assert.match(suite?.reason ?? "", /answers an observation/);

    // An unscoped observation stays behind every surface, even when a scoped observation of the
    // same fact names one.
    const preExisting = signal("p", "REGRESSION", {
      surfaces: ["channel/replay-safe-keys"],
      attribution: ["REPRODUCES_ON_BASELINE"],
    });
    const sibling = signal("c", "TIMEOUT", {
      surfaces: ["harness/x"],
      attribution: ["REPRODUCES_ON_BASELINE"],
    });
    const unscopedRepro = signal("a", "TIMEOUT", { attribution: ["REPRODUCES_ON_BASELINE"] });
    const merged = carryOverEvidence(
      planAssurance({ ...revision(R1, []), signals: [preExisting, sibling] }),
      planAssurance({ ...revision(R1, []), signals: [preExisting, sibling, unscopedRepro] }),
    );
    assertIncludes(
      merged.mustProduce
        .filter((entry) => entry.kind === "FAILURE_ATTRIBUTION")
        .flatMap((entry) => entry.surfaces),
      ["channel/replay-safe-keys"],
    );
    // Within one revision, unscoped evidence answers only the observations it was produced for.
    const lone = signal("t", "TIMEOUT");
    const answeredLater = carryOverEvidence(
      planAssurance({ ...revision(R1, []), signals: [lone] }),
      planAssurance({ ...revision(R1, []), signals: [lone, unscopedRepro] }),
    ).mustProduce.find((entry) => entry.kind === "FAILURE_ATTRIBUTION");
    assert.deepEqual(answeredLater?.surfaces, []);
    assert.match(answeredLater?.reason ?? "", /answers an observation/);

    // A regression reproduced on the baseline pre-exists; its reproduction is not another's.
    const preExistingAt = (id: string, signalId: string) =>
      planAssurance({
        ...revision(id, []),
        signals: [
          signal(signalId, "REGRESSION", {
            revision: id,
            surfaces: ["channel/replay-safe-keys"],
            attribution: ["REPRODUCES_ON_BASELINE"],
          }),
        ],
      });
    const reproduced = carryOverEvidence(
      preExistingAt(R1, "reg-a"),
      preExistingAt(R2, "reg-b"),
    ).mustProduce.find((entry) => entry.kind === "FAILURE_ATTRIBUTION");
    assert.deepEqual(reproduced?.surfaces, ["channel/replay-safe-keys"]);

    // Within one revision, a new unscoped observation voids unscoped evidence too.
    const unnamed = signal("t", "TIMEOUT", { attribution: ["PASSES_ON_SAME_REVISION"] });
    const withT = planAssurance({ ...revision(R1, []), signals: [unnamed] });
    const withTU = planAssurance({
      ...revision(R1, []),
      signals: [unnamed, signal("u", "UNEXPECTED_BEHAVIOR")],
    });
    const unscoped = carryOverEvidence(withT, withTU).mustProduce.find(
      (entry) => entry.kind === "FAILURE_ATTRIBUTION",
    );
    assert.deepEqual(unscoped?.surfaces, []);
    assert.match(unscoped?.reason ?? "", /unresolved \(u\)/);
    // Exact-revision evidence is a property of the revision itself.
    assertIncludes(kinds(carryOverEvidence(withT, withTU).reusable), [
      "REVISION_IDENTITY",
      "STATIC_CHECKS",
    ]);
  });

  it("matches a signal already answered by what it observed, not by its id", () => {
    const divergence = (surfaces: string[]) =>
      planAssurance({
        ...revision(R1, []),
        signals: [signal("ci", "CORPUS_DIVERGENCE", { surfaces })],
      });
    // The same id now reports a divergence on every surface.
    const widened = carryOverEvidence(divergence(["channel/replay-fold"]), divergence([]));
    assert.deepEqual(
      widened.mustProduce.find(
        (entry) => entry.kind === "TARGETED_CORPUS" && entry.reason.includes("unresolved (ci)"),
      )?.surfaces,
      ["channel/replay-fold", "channel/replay-safe-keys"],
    );
    assert.deepEqual(
      carryOverEvidence(divergence(["channel/replay-fold"]), divergence(["channel/replay-fold"]))
        .mustProduce,
      [],
    );
  });

  it("tells observations apart by every component it recorded", () => {
    // The same divergence, now declared to exercise the impacted surfaces, is another observation.
    const divergence = (exercisesImpactedSurfaces: ProofSignal["exercisesImpactedSurfaces"]) =>
      planAssurance({
        ...revision(R1, []),
        signals: [
          signal("ci", "CORPUS_DIVERGENCE", {
            surfaces: ["channel/replay-fold"],
            exercisesImpactedSurfaces,
          }),
        ],
      });
    assert.deepEqual(carryOverEvidence(divergence("no"), divergence("no")).mustProduce, []);
    const redeclared = carryOverEvidence(divergence("no"), divergence("yes")).mustProduce;
    assert.deepEqual(
      redeclared.find((entry) => entry.kind === "TARGETED_CORPUS"),
      {
        kind: "TARGETED_CORPUS",
        binding: "surface-content",
        surfaces: ["channel/replay-fold"],
        reason: "a signal is unresolved (ci)",
      },
    );

    // The same infrastructure failure, attributed on another basis, needs its own rerun.
    const harness = surface("ci/harness", { role: "proof-infrastructure", runtime: "build" });
    const attributed = (attribution: ProofSignal["attribution"]) =>
      planAssurance({
        ...revision(R1, [harness]),
        signals: [signal("harness", "TIMEOUT", { surfaces: ["ci/harness"], attribution })],
      });
    const passes = attributed(["PASSES_ON_SAME_REVISION"]);
    assert.equal(passes.signals[0]?.classification, "proof-infrastructure");
    assert.deepEqual(carryOverEvidence(passes, passes).mustProduce, []);
    assert.deepEqual(
      carryOverEvidence(passes, attributed(["PASSES_ON_SAME_REVISION", "OUTSIDE_IMPACT"]))
        .mustProduce,
      [
        {
          kind: "AFFECTED_JOB_RERUN",
          binding: "surface-content",
          surfaces: ["ci/harness"],
          reason: "it answers an observation the earlier evidence did not",
        },
      ],
    );

    // A stored plan may record another classification for the same report.
    const stored = divergence("yes");
    const reclassified: AssurancePlan = {
      ...stored,
      signals: stored.signals.map((entry) => ({ ...entry, classification: "unattributed" })),
    };
    assert.deepEqual(carryOverEvidence(stored, stored).mustProduce, []);
    assertIncludes(
      carryOverEvidence(stored, reclassified).mustProduce.map((entry) => entry.reason),
      ["a signal is unresolved (ci)"],
    );
  });

  it("refuses reuse behind a fact that names a signal the plan does not list", () => {
    const plan = planAssurance({
      ...revision(R1, []),
      signals: [signal("ci", "CORPUS_DIVERGENCE", { surfaces: ["channel/replay-fold"] })],
    });
    const ghost: AssurancePlan = {
      ...plan,
      facts: plan.facts.map((fact) =>
        fact.id.startsWith("observed:") ? { ...fact, refs: [...fact.refs, "ghost"] } : fact,
      ),
    };
    assert.deepEqual(carryOverEvidence(plan, plan).mustProduce, []);
    // What such a plan observed cannot be compared, on either side, for evidence about the whole
    // runtime tree as for evidence scoped to a surface.
    const unlisted = (carry: EvidenceCarryOver) =>
      carry.mustProduce
        .filter((entry) => entry.reason === "an observation behind it is not in the plan")
        .map((entry) => `${entry.kind}:${entry.binding}:${entry.surfaces.join(",")}`);
    for (const [previous, next] of [
      [ghost, ghost],
      [plan, ghost],
      [ghost, plan],
    ] as const) {
      assert.deepEqual(unlisted(carryOverEvidence(previous, next)), [
        "FAILURE_ATTRIBUTION:surface-content:channel/replay-fold",
        "FULL_CORPUS:runtime-tree:channel/replay-fold",
      ]);
    }
  });

  it("reads what a signal concerns in both plans, and a role in both plans", () => {
    // A surface the next plan declares an execution context widens a signal the previous plan
    // observed on it, as if the previous plan had known.
    const config = (role: Surface["role"]) =>
      surface("config/runtime.env", { role, runtime: "build" });
    const regressed = planAssurance({
      ...revision(R1, [config("product")]),
      signals: [signal("r", "REGRESSION", { surfaces: ["config/runtime.env"] })],
    });
    const reclassified = planAssurance(revision(R2, [config("execution-context")]));
    const widened = carryOverEvidence(regressed, reclassified);
    assert.deepEqual(widened.reusable, []);
    assertIncludes(
      widened.mustProduce.map(
        (entry) => `${entry.kind}:${entry.surfaces.join(",")}:${entry.reason}`,
      ),
      [
        "TARGETED_REGRESSION:channel/replay-fold,channel/replay-safe-keys,config/runtime.env:a signal is unresolved (r)",
      ],
    );
    // Without that regression, the same evidence is reused on every surface.
    assertIncludes(
      carryOverEvidence(
        planAssurance(revision(R1, [config("product")])),
        reclassified,
      ).reusable.map((entry) => `${entry.kind}:${entry.surfaces.join(",")}`),
      ["TARGETED_REGRESSION:channel/replay-fold,channel/replay-safe-keys,config/runtime.env"],
    );
    // A failure observed while a harness listed nothing it exercised may concern anything, even
    // once the next plan lists what it exercises.
    const runner = (exercises?: string[]) =>
      surface("harness/replay-runner", {
        role: "proof-infrastructure",
        runtime: "build",
        ...(exercises === undefined ? {} : { exercises }),
      });
    const unlisted = planAssurance({
      ...revision(R1, [runner()]),
      signals: [
        signal("runner", "TIMEOUT", {
          surfaces: ["harness/replay-runner"],
          attribution: ["PASSES_ON_SAME_REVISION"],
          exercisesImpactedSurfaces: "yes",
        }),
      ],
    });
    assert.equal(unlisted.signals[0]?.classification, "unattributed");
    const listing = planAssurance(revision(R2, [runner(["channel/replay-fold"])]));
    assert.deepEqual(carryOverEvidence(unlisted, listing).reusable, []);
    // Without that failure, evidence on a surface the harness never exercised is reused.
    assertIncludes(
      carryOverEvidence(planAssurance(revision(R1, [runner()])), listing).reusable.map(
        (entry) => `${entry.kind}:${entry.surfaces.join(",")}`,
      ),
      ["TARGETED_REGRESSION:channel/replay-safe-keys"],
    );

    // A documented surface reclassified as documentation keeps depending on the tree.
    const readme = claim("readme-exit-code-table", ["cli/exit-codes"], { kind: "documentation" });
    const exitCodes = (id: string, tree: string, role: Surface["role"]) =>
      planAssurance({
        impact: impact(
          [
            surface("cli/exit-codes", {
              role,
              runtime: role === "documentation" ? "none" : "offline-analysis",
              behaviorChange: "feature",
            }),
          ],
          { revision: { id, baseline: BASE, runtimeTreeDigest: digest(tree) } },
        ),
        claims: [readme],
      });
    const check = carryOverEvidence(
      exitCodes(R1, "tree@1", "product"),
      exitCodes(R2, "tree@2", "documentation"),
    ).mustProduce.find((entry) => entry.kind === "DOCUMENTATION_CHECK");
    assert.equal(check?.reason, "runtime tree changed or unknown");
    // And documentation reclassified as a runtime surface starts depending on it.
    const promoted = carryOverEvidence(
      exitCodes(R1, "tree@1", "documentation"),
      exitCodes(R2, "tree@2", "product"),
    ).mustProduce.find((entry) => entry.kind === "DOCUMENTATION_CHECK");
    assert.equal(promoted?.reason, "runtime tree changed or unknown");
  });

  it("attributes a flake of a repaired ceiling to the proof infrastructure", () => {
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const plan = planAssurance({
      ...revision(R2, [mechanics]),
      signals: [
        signal("rerun-flake", "TIMEOUT", {
          revision: R2,
          surfaces: [MECHANICS_CEILING],
          attribution: ["PASSES_ON_SAME_REVISION", "DECLARED_ENVIRONMENT_FACTOR"],
        }),
      ],
    });
    assert.equal(plan.signals[0]?.exercises, "no");
    assert.equal(plan.signals[0]?.classification, "proof-infrastructure");
    assert.equal(plan.status, "PROVE");
  });

  it("keys reuse on what a kind means, not on its wording", () => {
    const { r1, r2 } = sequence("test");
    const reworded: AssurancePolicy = {
      ...DEFAULT_ASSURANCE_POLICY,
      evidence: DEFAULT_ASSURANCE_POLICY.evidence.map((spec) =>
        spec.id === "CAUSAL_WITNESS" ? { ...spec, title: "Causal witness (reworded)" } : spec,
      ),
    };
    const redefined: AssurancePolicy = {
      ...DEFAULT_ASSURANCE_POLICY,
      evidence: DEFAULT_ASSURANCE_POLICY.evidence.map((spec) =>
        spec.id === "CAUSAL_WITNESS" ? { ...spec, semanticsVersion: 2 } : spec,
      ),
    };
    const mechanics = ceiling(MECHANICS_CEILING, "test", ["mechanics/catalog"]);
    const rewordedPlan = planAssurance({ ...revision(R2, [mechanics]), policy: reworded });
    const redefinedPlan = planAssurance({ ...revision(R2, [mechanics]), policy: redefined });
    assert.ok(kinds(carryOverEvidence(r1, rewordedPlan).reusable).includes("CAUSAL_WITNESS"));
    assert.ok(mustProduceKinds(carryOverEvidence(r1, redefinedPlan)).includes("CAUSAL_WITNESS"));
    assert.ok(kinds(carryOverEvidence(r1, r2).reusable).includes("CAUSAL_WITNESS"));
  });
});

describe("assurance policy governance", () => {
  const POLICY = DEFAULT_ASSURANCE_POLICY;
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refused = (policy: unknown, pattern: string) => {
    assert.throws(
      () => parseAssurancePolicy(policy),
      (error: unknown) =>
        error instanceof ProofPlannerError &&
        error.code === "PROOF_PLANNER_POLICY_BELOW_MINIMUM" &&
        new RegExp(escapeRegExp(pattern)).test(error.message),
      pattern,
    );
  };

  it("accepts the default policy and pins its digest", () => {
    assert.deepEqual(parseAssurancePolicy(POLICY), POLICY);
    assert.equal(
      planAssurance(DOCS_ONLY).policy.digest,
      "sha256:c923203022390ffbc8726f2da3680a367e541b42383155b718dc95146f645073",
    );
  });

  it("keeps the non-negotiable rules in the default policy", () => {
    // An oracle independent of the planner: loosening the default must fail here, not only
    // move the relational minimum along with it.
    const floor = (fact: string) =>
      Math.max(
        -1,
        ...POLICY.floors
          .filter((entry) => entry.fact === fact)
          .map((entry) => Number(entry.level.slice(1))),
      );
    for (const [fact, level] of [
      ["runtime:live:behavior", 4],
      ["boundary:decision:behavior", 4],
      ["boundary:admission:behavior", 4],
      ["boundary:security:behavior", 4],
      ["claim:critical:direct", 4],
      ["claim:empirical", 5],
      ["impact:unbounded", 3],
      ["product:behavior-change", 2],
      ["execution-context:changed", 2],
    ] as const) {
      assert.ok(floor(fact) >= level, `${fact} >= P${level}`);
    }
    for (const [fact, kind] of [
      ["runtime:live:behavior", "LIVE_SHADOW"],
      ["runtime:live:behavior", "ROLLBACK_PLAN"],
      ["runtime:live:behavior", "FULL_CORPUS"],
      ["impact:unbounded", "FULL_TEST_SUITE"],
      ["execution-context:changed", "FULL_TEST_SUITE"],
      ["product:fix", "CAUSAL_WITNESS"],
      ["product:new-behavior", "ACCEPTANCE_TEST"],
      ["claim:empirical", "PREREGISTRATION"],
      ["claim:empirical", "HOLDOUT_EVALUATION"],
      ["claim:critical:oracle", "ORACLE_WITNESS"],
      ["boundary:security:touched", "INDEPENDENT_REVIEW"],
      ["proof-infrastructure:changed", "GATE_DELTA_REVIEW"],
      ["oracle:changed", "GATE_DELTA_REVIEW"],
      ["observed:unattributed-failure", "FAILURE_ATTRIBUTION"],
      ["observed:baseline-reproduction", "FAILURE_ATTRIBUTION"],
    ] as const) {
      assert.ok(
        POLICY.triggers.some((entry) => entry.fact === fact && entry.require.includes(kind)),
        `${fact} requires ${kind}`,
      );
    }
    for (const [kind, level] of [
      ["STATIC_CHECKS", "P1"],
      ["TARGETED_REGRESSION", "P2"],
      ["INDEPENDENT_REVIEW", "P4"],
      ["PREREGISTRATION", "P5"],
    ] as const) {
      assert.ok(
        POLICY.baselines.some((entry) => entry.kind === kind && entry.level <= level),
        `${kind}@${level}`,
      );
    }
    for (const fact of [
      "observed:unattributed-failure",
      "observed:unexpected-behavior",
      "observed:witness-not-causal",
      "observed:unplanned-impact",
      "observed:unknown-dependency",
    ] as const) {
      assert.ok(POLICY.status.hold.includes(fact), fact);
    }
    assert.ok(POLICY.status.block.includes("observed:regression"));
    assert.equal(POLICY.raises.cap, "P4");
    // Every observation of the fact vocabulary has an effect, named one by one with the evidence
    // it must at least require.
    const requiringObservations = new Set(
      POLICY.triggers
        .filter((entry) => entry.fact.startsWith("observed:") && entry.require.length > 0)
        .map((entry) => entry.fact),
    );
    const OBSERVATIONS: Record<string, readonly string[]> = {
      "observed:unexpected-behavior": ["CHARACTERIZATION_TESTS", "FAILURE_ATTRIBUTION"],
      "observed:unplanned-impact": ["TARGETED_REGRESSION"],
      "observed:unknown-dependency": ["TARGETED_REGRESSION"],
      "observed:live-runtime": ["LIVE_SHADOW", "ROLLBACK_PLAN", "FULL_CORPUS"],
      "observed:corpus-divergence": ["FULL_CORPUS", "FAILURE_ATTRIBUTION"],
      "observed:witness-not-causal": ["CAUSAL_WITNESS"],
      "observed:regression": ["TARGETED_REGRESSION"],
      "observed:infrastructure-failure": ["AFFECTED_JOB_RERUN"],
      "observed:unattributed-failure": ["FAILURE_ATTRIBUTION"],
      "observed:baseline-reproduction": ["FAILURE_ATTRIBUTION"],
    };
    for (const [fact, required] of Object.entries(OBSERVATIONS)) {
      for (const kind of required) {
        assert.ok(
          POLICY.triggers.some((entry) => entry.fact === fact && entry.require.includes(kind)),
          `${fact} requires ${kind}`,
        );
      }
    }
    assert.deepEqual([...requiringObservations].sort(), Object.keys(OBSERVATIONS).sort());
    for (const [fact, level] of [
      ["claim:high:oracle", 2],
      ["claim:critical:oracle", 3],
      ["observed:live-runtime", 4],
      ["observed:corpus-divergence", 4],
    ] as const) {
      assert.ok(floor(fact) >= level, `${fact} >= P${level}`);
    }
    for (const [fact, kind] of [
      ["claim:high:oracle", "ORACLE_WITNESS"],
      ["claim:critical:oracle", "INDEPENDENT_REVIEW"],
      ["observed:live-runtime", "LIVE_SHADOW"],
      ["observed:live-runtime", "ROLLBACK_PLAN"],
      ["observed:corpus-divergence", "FULL_CORPUS"],
    ] as const) {
      assert.ok(
        POLICY.triggers.some((entry) => entry.fact === fact && entry.require.includes(kind)),
        `${fact} requires ${kind}`,
      );
    }
    for (const fact of [
      "uncertainty:high",
      "witness:infeasible",
      "observed:unexpected-behavior",
      "observed:witness-not-causal",
    ] as const) {
      assert.ok(POLICY.raises.facts.includes(fact), `raise on ${fact}`);
    }
  });

  it("refuses every policy that drops or weakens a rule of the default", () => {
    POLICY.evidence.forEach((spec, index) => {
      // Removed together with every reference to it, so the policy stays well-formed.
      refused(
        {
          ...POLICY,
          evidence: POLICY.evidence.filter((_, other) => other !== index),
          baselines: POLICY.baselines.filter((entry) => entry.kind !== spec.id),
          triggers: POLICY.triggers.map((entry) => ({
            ...entry,
            require: entry.require.filter((kind) => kind !== spec.id),
            recommend: entry.recommend.filter((kind) => kind !== spec.id),
          })),
        },
        `kind ${spec.id} is missing`,
      );
      const redefine = (patch: Partial<typeof spec>) => ({
        ...POLICY,
        evidence: POLICY.evidence.map((entry, other) =>
          other === index ? { ...entry, ...patch } : entry,
        ),
      });
      if (spec.verification === "executed") {
        refused(redefine({ verification: "attested" }), `kind ${spec.id} verification weakened`);
      }
      for (const binding of ["surface-content", "runtime-tree"] as const) {
        if (binding !== spec.binding) {
          refused(redefine({ binding }), `kind ${spec.id} binding weakened`);
        }
      }
      const other = spec.subjects.includes("documentation") ? "product" : "documentation";
      refused(redefine({ subjects: [other] }), `kind ${spec.id} subjects narrowed`);
    });
    POLICY.baselines.forEach((baseline, index) => {
      refused(
        { ...POLICY, baselines: POLICY.baselines.filter((_, other) => other !== index) },
        `baseline ${baseline.kind}@${baseline.level}`,
      );
    });
    refused(
      {
        ...POLICY,
        baselines: POLICY.baselines.map((entry) =>
          entry.kind === "INDEPENDENT_REVIEW" ? { ...entry, level: "P5" as const } : entry,
        ),
      },
      "baseline INDEPENDENT_REVIEW@P4",
    );
    POLICY.floors.forEach((floor, index) => {
      refused(
        { ...POLICY, floors: POLICY.floors.filter((_, other) => other !== index) },
        `floor ${floor.fact} >= ${floor.level}`,
      );
    });
    refused(
      {
        ...POLICY,
        floors: POLICY.floors.map((entry) =>
          entry.fact === "claim:high:direct" ? { ...entry, level: "P2" as const } : entry,
        ),
      },
      "floor claim:high:direct >= P3",
    );
    const facts = [...new Set(POLICY.triggers.map((entry) => entry.fact))];
    for (const fact of facts) {
      const entries = POLICY.triggers.filter((entry) => entry.fact === fact);
      for (const effect of ["require", "recommend"] as const) {
        for (const kind of new Set(entries.flatMap((entry) => entry[effect]))) {
          const loosened = {
            ...POLICY,
            triggers: POLICY.triggers.map((entry) =>
              entry.fact === fact
                ? {
                    ...entry,
                    require: entry.require.filter((item) => item !== kind),
                    recommend: entry.recommend.filter((item) => item !== kind),
                  }
                : entry,
            ),
          };
          refused(
            loosened,
            `trigger ${fact} ${effect === "require" ? "requires" : "recommends"} ${kind}`,
          );
        }
      }
    }
    // Downgrades are refusals too: a requirement kept only as a recommendation, a block kept
    // only as a hold.
    for (const entry of POLICY.triggers) {
      for (const kind of entry.require) {
        refused(
          {
            ...POLICY,
            triggers: POLICY.triggers.map((other) =>
              other.fact === entry.fact
                ? {
                    ...other,
                    require: other.require.filter((item) => item !== kind),
                    recommend: [...new Set([...other.recommend, kind])],
                  }
                : other,
            ),
          },
          `trigger ${entry.fact} requires ${kind}`,
        );
      }
    }
    for (const fact of POLICY.status.block) {
      refused(
        {
          ...POLICY,
          status: {
            hold: [...POLICY.status.hold, fact],
            block: POLICY.status.block.filter((item) => item !== fact),
          },
        },
        `status blocks on ${fact}`,
      );
    }
    for (const fact of POLICY.raises.facts) {
      refused(
        {
          ...POLICY,
          raises: { ...POLICY.raises, facts: POLICY.raises.facts.filter((f) => f !== fact) },
        },
        `raise on ${fact}`,
      );
    }
    for (const cap of ["P3", "P5"] as const) {
      refused({ ...POLICY, raises: { ...POLICY.raises, cap } }, "raise cap = P4");
    }
    for (const fact of POLICY.status.hold) {
      refused(
        {
          ...POLICY,
          status: { ...POLICY.status, hold: POLICY.status.hold.filter((f) => f !== fact) },
        },
        `status holds on ${fact}`,
      );
    }
    for (const fact of POLICY.status.block) {
      refused(
        {
          ...POLICY,
          status: { ...POLICY.status, block: POLICY.status.block.filter((f) => f !== fact) },
        },
        `status blocks on ${fact}`,
      );
    }
  });

  it("accepts stricter policies", () => {
    const stricter: AssurancePolicy = {
      ...POLICY,
      id: "example.stricter",
      evidence: POLICY.evidence.map((spec) =>
        spec.id === "TARGETED_REGRESSION" ? { ...spec, binding: "exact-revision" as const } : spec,
      ),
      baselines: POLICY.baselines.map((entry) =>
        entry.kind === "INDEPENDENT_REVIEW" ? { ...entry, level: "P3" as const } : entry,
      ),
      floors: [...POLICY.floors, { fact: "documentation:changed", level: "P1" }],
      triggers: POLICY.triggers.map((entry) =>
        entry.fact === "impact:declared"
          ? { ...entry, require: [...entry.require, ...entry.recommend], recommend: [] }
          : entry,
      ),
      status: {
        hold: POLICY.status.hold.filter((fact) => fact !== "observed:witness-not-causal"),
        block: [...POLICY.status.block, "observed:witness-not-causal"],
      },
    };
    assert.deepEqual(parseAssurancePolicy(stricter), stricter);
    assert.equal(planAssurance({ ...DOCS_ONLY, policy: stricter }).level, "P1");
    assert.throws(
      () =>
        parseAssurancePolicy({
          ...POLICY,
          baselines: [{ level: "P1", kind: "NOT_A_KIND" }],
        }),
      /PROOF_PLANNER_POLICY_INVALID/,
    );
  });

  it("rejects malformed and inconsistent inputs with stable codes", () => {
    assert.throws(
      () =>
        planAssurance({
          impact: { ...DOCS_ONLY.impact, revision: { id: "main", baseline: BASE } },
        }),
      (error: unknown) =>
        error instanceof ProofPlannerError && error.code === "PROOF_PLANNER_INPUT_INVALID",
    );
    assert.throws(
      () => planAssurance({ impact: impact([surface("a"), surface("a")]) }),
      /PROOF_PLANNER_INPUT_INCONSISTENT: duplicate surface a/,
    );
    assert.throws(
      () =>
        planAssurance({
          ...LOCAL_BUGFIX,
          signals: [signal("hypothetical.x", "TIMEOUT")],
        }),
      /PROOF_PLANNER_INPUT_INCONSISTENT: signal id prefix .*reserved/,
    );
    assert.throws(
      () =>
        planAssurance({
          impact: impact([
            ...REPLAY_FIX_SURFACES,
            surface("hypothetical.unplanned-surface", { role: "documentation", runtime: "none" }),
          ]),
        }),
      /PROOF_PLANNER_INPUT_INCONSISTENT: surface id prefix .*reserved/,
    );
    assert.throws(
      () =>
        planAssurance({
          ...LOCAL_BUGFIX,
          claims: [claim("hypothetical.claim", ["billing/rounding"])],
        }),
      /PROOF_PLANNER_INPUT_INCONSISTENT: claim id prefix .*reserved/,
    );
  });
});

describe("proof planner isolation and presentation", () => {
  it("depends only on zod, its own files and the public core digest functions", async () => {
    const directory = path.join("src", "proof-planner");
    for (const file of await readdir(directory)) {
      const source = await readFile(path.join(directory, file), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const specifier of imports) {
        assert.ok(
          specifier === "zod" ||
            specifier === "../core/index.js" ||
            /^\.\/[a-z-]+\.js$/.test(specifier),
          `${file} imports ${specifier}`,
        );
      }
      if (source.includes("../core/index.js")) {
        assert.match(source, /import \{ sha256Canonical \} from "\.\.\/core\/index\.js";/, file);
      }
    }
    for (const entry of ["index.ts", "sdk/index.ts", "cli.ts", "mcp/index.ts", "core/index.ts"]) {
      const source = await readFile(path.join("src", entry), "utf8");
      assert.doesNotMatch(source, /proof-planner/, entry);
    }
  });

  it("renders the machine-readable plan for a human reader", () => {
    const text = renderAssurancePlan(planAssurance(REPLAY_BOUNDED));
    for (const heading of [
      "WHY",
      "REQUIRED",
      "NOT REQUIRED",
      "ESCALATE IF",
      "RESIDUAL UNCERTAINTY",
    ]) {
      assert.match(text, new RegExp(`^${heading}$`, "m"));
    }
    assert.match(text, /^AssurancePlan P3 PROVE/);
    assert.match(text, /- FULL_CORPUS: Not required: the policy asks for FULL_CORPUS when/);
    assert.match(
      text,
      /TIMEOUT \(infrastructure-attributed\): Evidence about the proof infrastructure: level stays P3/,
    );
    // The lines the documentation quotes from this rendering.
    const lines = text.split("\n");
    for (const line of [
      "  - TARGETED_CORPUS (surface-content) [channel/replay-fold, channel/replay-safe-keys] <- boundary:analysis:behavior, boundary:replay:behavior",
      "  - CORPUS_DIVERGENCE (product): Evidence about the product: level moves P3 -> P4, status PROVE, adds FAILURE_ATTRIBUTION, FULL_CORPUS, INDEPENDENT_REVIEW.",
      "  - REGRESSION (product): Evidence about the product: level stays P3, status BLOCKED, adds nothing.",
      "  - TIMEOUT (infrastructure-attributed): Evidence about the proof infrastructure: level stays P3, status PROVE, adds AFFECTED_JOB_RERUN, FAILURE_ATTRIBUTION.",
      "  - TIMEOUT (infrastructure-unattributed): Unattributed failure: level stays P3, status HOLD, adds FAILURE_ATTRIBUTION.",
    ]) {
      assert.ok(lines.includes(line), line);
    }
  });
});
