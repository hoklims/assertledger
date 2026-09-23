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
    assert.deepEqual(kinds(plan.recommendedEvidence), ["CHARACTERIZATION_TESTS"]);
    assertIncludes(notRequired(plan), BROAD_AND_CEREMONY);
    for (const entry of plan.explicitlyNotRequired) {
      assert.equal(entry.evaluatedAgainst, "worst-case");
      assert.match(entry.rationale, /worst case/);
    }
  });

  it("D: never exempts broad evidence when the impact is not bounded", () => {
    const plan = planAssurance({
      ...REPLAY_BOUNDED,
      impact: impact(REPLAY_FIX_SURFACES, { analysis: analysis({ completeness: "partial" }) }),
    });
    assert.equal(plan.impactBound, "unbounded");
    assertIncludes(kinds(plan.requiredEvidence), ["FULL_TEST_SUITE"]);
    assertIncludes(kinds(plan.recommendedEvidence), ["FULL_CORPUS", "INDEPENDENT_REVIEW"]);
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
    assertIncludes(kinds(declared.recommendedEvidence), ["FULL_TEST_SUITE"]);
    assertExcludes(notRequired(declared), ["FULL_TEST_SUITE"]);
  });

  it("E: escalates a live decoder fix and a tactical decision change strongly", () => {
    const decoder = planAssurance(LIVE_DECODER);
    assert.equal(decoder.level, "P4");
    assertIncludes(kinds(decoder.requiredEvidence), [
      "BOUNDARY_COMPATIBILITY",
      "CAUSAL_WITNESS",
      "FULL_CORPUS",
      "INDEPENDENT_REVIEW",
      "LIVE_SHADOW",
      "PRODUCTION_PATH_TEST",
      "ROLLBACK_PLAN",
      "TARGETED_INTEGRATION",
    ]);
    assertIncludes(notRequired(decoder), ["BENCHMARK_PROTOCOL", "HOLDOUT_EVALUATION"]);

    const decision = planAssurance(TACTICAL_DECISION);
    assert.equal(decision.level, "P4");
    assertIncludes(kinds(decision.requiredEvidence), [
      "ACCEPTANCE_TEST",
      "FULL_CORPUS",
      "LIVE_SHADOW",
      "ROLLBACK_PLAN",
      "SYSTEM_REQUALIFICATION",
    ]);
  });

  it("F: puts an experimental claim at P5 with evaluation evidence, not product ceremony", () => {
    const plan = planAssurance(BENCHMARK_CLAIM);
    assert.equal(plan.level, "P5");
    assert.deepEqual(plan.levelBySubject, [{ subject: "evaluation", level: "P5" }]);
    assertIncludes(kinds(plan.requiredEvidence), [
      "BENCHMARK_PROTOCOL",
      "CONTAMINATION_CHECK",
      "HOLDOUT_EVALUATION",
      "INDEPENDENT_REVIEW",
      "PREREGISTRATION",
      "PROVENANCE_ATTESTATION",
    ]);
    assertExcludes(kinds(plan.requiredEvidence), [
      "CAUSAL_WITNESS",
      "INVARIANT_CHECK",
      "LIVE_SHADOW",
      "PRODUCTION_PATH_TEST",
      "SYSTEM_REQUALIFICATION",
      "TARGETED_INTEGRATION",
    ]);
    assertIncludes(notRequired(plan), ["LIVE_SHADOW", "SYSTEM_REQUALIFICATION"]);
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
    const preExisting = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [
        signal("r", "REGRESSION", {
          surfaces: ["billing/rounding"],
          attribution: ["REPRODUCES_ON_BASELINE"],
        }),
      ],
    });
    assert.equal(preExisting.status, "PROVE");
    assert.equal(preExisting.signals[0]?.classification, "pre-existing");
    assert.ok(
      preExisting.residualUncertainty.some((entry) => entry.id === "signal.r.pre-existing"),
    );
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
  });

  it("ignores signals observed on another revision", () => {
    const plan = planAssurance({
      ...LOCAL_BUGFIX,
      signals: [signal("old", "REGRESSION", { revision: R2, surfaces: ["billing/rounding"] })],
    });
    assert.equal(plan.status, "PROVE");
    assert.equal(plan.signals[0]?.classification, "other-revision");
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
        const redundant =
          product === "LIVE_RUNTIME_TOUCHED" &&
          loud.facts.some((fact) => fact.id === "runtime:live:behavior");
        if (redundant) continue;
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

  it("leaves level, status and product evidence unchanged for an attributed infrastructure failure", () => {
    for (const [name, input] of Object.entries(SCENARIOS)) {
      const quiet = planAssurance(input);
      for (const infrastructure of INFRASTRUCTURE_SIGNALS) {
        const loud = planAssurance({
          ...input,
          signals: [
            signal("peripheral", infrastructure, {
              surfaces: ["elsewhere/job"],
              attribution: ["OUTSIDE_IMPACT"],
            }),
          ],
        });
        assert.equal(loud.signals[0]?.classification, "proof-infrastructure", name);
        assert.equal(loud.level, quiet.level, name);
        assert.equal(loud.status, quiet.status, name);
        assert.deepEqual(productRequired(loud), productRequired(quiet), name);
      }
    }
  });

  it("precomputes each escalation exactly as an independent replan", () => {
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
    const infrastructure = quiet.escalations.filter((entry) => entry.variant !== "product");
    assert.deepEqual(
      infrastructure.map((entry) => [entry.variant, entry.resultingLevel, entry.resultingStatus]),
      [
        ["infrastructure-attributed", "P3", "PROVE"],
        ["infrastructure-unattributed", "P3", "HOLD"],
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
    assertIncludes(kinds(uncertain.requiredEvidence), ["INVARIANT_CHECK"]);
    assertExcludes(kinds(uncertain.requiredEvidence), ["PREREGISTRATION", "HOLDOUT_EVALUATION"]);
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
  it("accepts the default policy and pins its digest", () => {
    assert.deepEqual(parseAssurancePolicy(DEFAULT_ASSURANCE_POLICY), DEFAULT_ASSURANCE_POLICY);
    assert.equal(
      planAssurance(DOCS_ONLY).policy.digest,
      "sha256:af945bb44a54fa28e1792e273d1f2dbf7d356de6029d58ddf4555775efe56c93",
    );
  });

  it("rejects unknown kinds and policies below the non-negotiable minimum", () => {
    assert.throws(
      () =>
        parseAssurancePolicy({
          ...DEFAULT_ASSURANCE_POLICY,
          baselines: [{ level: "P1", kind: "NOT_A_KIND" }],
        }),
      /PROOF_PLANNER_POLICY_INVALID/,
    );
    const looser = (patch: Partial<AssurancePolicy>) => () =>
      parseAssurancePolicy({ ...DEFAULT_ASSURANCE_POLICY, ...patch });
    assert.throws(
      looser({
        floors: DEFAULT_ASSURANCE_POLICY.floors.filter(
          (entry) => entry.fact !== "runtime:live:behavior",
        ),
      }),
      /PROOF_PLANNER_POLICY_BELOW_MINIMUM: .*floor runtime:live:behavior/,
    );
    assert.throws(
      looser({ status: { hold: [], block: [] } }),
      /PROOF_PLANNER_POLICY_BELOW_MINIMUM: .*status blocks on observed:regression/,
    );
    assert.throws(
      looser({
        triggers: DEFAULT_ASSURANCE_POLICY.triggers.filter(
          (entry) => entry.fact !== "observed:infrastructure-failure",
        ),
      }),
      /observation fact observed:infrastructure-failure has no requirement/,
    );
    assert.throws(looser({ raises: { facts: [], cap: "P5" } }), /raise cap/);
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
      /PROOF_PLANNER_INPUT_INCONSISTENT: .*reserved/,
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
  });
});
