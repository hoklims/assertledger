import * as z from "zod";
import { sha256Canonical } from "../core/index.js";
import {
  ASSURANCE_LEVELS,
  ATTRIBUTION_BASES,
  type AssuranceLevel,
  BOUNDARIES,
  type Boundary,
  EvidenceKindIdSchema,
  type EvidenceKindSpec,
  EvidenceKindSpecSchema,
  levelIndex,
  PROOF_PLANNER_SCHEMA_VERSION,
  ProofPlannerError,
} from "./model.js";

/**
 * The closed fact vocabulary is the only interface between fact derivation (code) and the
 * assurance policy (data). A policy can only map facts to levels, raises, evidence and status.
 */
export const STATIC_FACT_IDS = [
  "documentation:changed",
  "tests:only",
  "oracle:changed",
  "proof-infrastructure:changed",
  "execution-context:changed",
  "evaluation:touched",
  "product:refactor",
  "product:behavior-change",
  "product:behavior-suspected",
  "product:fix",
  "product:new-behavior",
  "runtime:live:touched",
  "runtime:live:behavior",
  "coverage:missing",
  "witness:infeasible",
  "environment:sensitive",
  "reversibility:costly",
  "reversibility:irreversible",
  "claim:high:transitive",
  "claim:high:direct",
  "claim:critical:transitive",
  "claim:critical:direct",
  "claim:scope:component",
  "claim:scope:system",
  "claim:empirical",
  "claim:empirical:transitive",
  "impact:unbounded",
  "impact:bounded-uncertain",
  "impact:declared",
  "impact:localized-unknowns",
  "uncertainty:high",
  "observed:unexpected-behavior",
  "observed:unplanned-impact",
  "observed:unknown-dependency",
  "observed:live-runtime",
  "observed:corpus-divergence",
  "observed:witness-not-causal",
  "observed:regression",
  "observed:infrastructure-failure",
  "observed:unattributed-failure",
] as const;
export const BOUNDARY_FACT_QUALIFIERS = ["touched", "behavior", "transitive"] as const;
export type FactId =
  | (typeof STATIC_FACT_IDS)[number]
  | `boundary:${Boundary}:${(typeof BOUNDARY_FACT_QUALIFIERS)[number]}`;

export const FACT_IDS: readonly FactId[] = [
  ...STATIC_FACT_IDS,
  ...BOUNDARIES.flatMap((boundary) =>
    BOUNDARY_FACT_QUALIFIERS.map((qualifier) => `boundary:${boundary}:${qualifier}` as FactId),
  ),
];
const FACT_ID_SET = new Set<string>(FACT_IDS);

export function isFactId(value: string): value is FactId {
  return FACT_ID_SET.has(value);
}

const FactIdSchema = z.string().refine(isFactId, { message: "unknown fact id" });
const LevelSchema = z.enum(ASSURANCE_LEVELS);

export const AssurancePolicySchema = z.strictObject({
  schemaVersion: z.literal(PROOF_PLANNER_SCHEMA_VERSION),
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9.-]*$/),
  version: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  evidence: z.array(EvidenceKindSpecSchema).min(1).max(128),
  /** Level baselines: a kind listed at level L applies to each of its subjects whose level >= L. */
  baselines: z.array(z.strictObject({ level: LevelSchema, kind: EvidenceKindIdSchema })).max(256),
  floors: z.array(z.strictObject({ fact: FactIdSchema, level: LevelSchema })).max(512),
  /** Each listed fact raises the level of its subject by one step, once, never above the cap. */
  raises: z.strictObject({ facts: z.array(FactIdSchema).max(64), cap: LevelSchema }),
  triggers: z
    .array(
      z.strictObject({
        fact: FactIdSchema,
        require: z.array(EvidenceKindIdSchema).max(32),
        recommend: z.array(EvidenceKindIdSchema).max(32),
      }),
    )
    .max(512),
  status: z.strictObject({
    hold: z.array(FactIdSchema).max(64),
    block: z.array(FactIdSchema).max(64),
  }),
  /** Bases that can attribute a failure to the proof infrastructure when it runs outside the impact. */
  attribution: z.strictObject({
    admissibleOutsideImpact: z.array(z.enum(ATTRIBUTION_BASES)).max(ATTRIBUTION_BASES.length),
  }),
});
export type AssurancePolicy = z.infer<typeof AssurancePolicySchema>;

function kind(
  id: string,
  title: string,
  description: string,
  weight: EvidenceKindSpec["weight"],
  binding: EvidenceKindSpec["binding"],
  subjects: EvidenceKindSpec["subjects"],
  verification: EvidenceKindSpec["verification"],
): EvidenceKindSpec {
  return { id, title, description, weight, binding, subjects, verification, semanticsVersion: 1 };
}

function trigger(
  fact: FactId,
  require: string[],
  recommend: string[] = [],
): AssurancePolicy["triggers"][number] {
  return { fact, require, recommend };
}

const BEHAVIOR_BOUNDARIES_P3: Boundary[] = [
  "protocol",
  "persistence",
  "replay",
  "analysis",
  "public-api",
];
const COMPATIBILITY_BOUNDARIES: Boundary[] = ["protocol", "persistence", "public-api"];

export const DEFAULT_ASSURANCE_POLICY: AssurancePolicy = {
  schemaVersion: PROOF_PLANNER_SCHEMA_VERSION,
  id: "assertledger.default-assurance",
  version: "1.0.0",
  evidence: [
    kind(
      "STATIC_CHECKS",
      "Static checks",
      "Typecheck, lint and format checks on the exact revision.",
      "targeted",
      "exact-revision",
      ["product", "evaluation", "proof-infrastructure"],
      "executed",
    ),
    kind(
      "REVISION_IDENTITY",
      "Revision identity",
      "The delivered revision is the planned revision, and every reused piece of evidence is bound to digests that the delivered revision still has.",
      "targeted",
      "exact-revision",
      ["product", "evaluation", "proof-infrastructure"],
      "executed",
    ),
    kind(
      "DOCUMENTATION_CHECK",
      "Documentation check",
      "Format, link and rendering checks on the changed documentation.",
      "targeted",
      "surface-content",
      ["documentation"],
      "executed",
    ),
    kind(
      "AFFECTED_TESTS",
      "Affected tests",
      "Existing tests of the directly changed packages or modules.",
      "targeted",
      "surface-content",
      ["product", "evaluation"],
      "executed",
    ),
    kind(
      "CHARACTERIZATION_TESTS",
      "Characterization tests",
      "Tests that pin the current behavior of surfaces whose behavior may change without intent or lacks coverage.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "CAUSAL_WITNESS",
      "Causal red-to-green witness",
      "A test that fails on the baseline for the declared defect and passes on the revision (an AssertLedger TARGET/REFERENCE/NEUTRAL campaign).",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "ACCEPTANCE_TEST",
      "Acceptance test",
      "A test that specifies the new behavior, fails on the baseline and passes on the revision.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "PRODUCTION_PATH_TEST",
      "Production-path test",
      "A test that reaches the changed surface through the real production entry point, without mocking the changed unit.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "TARGETED_REGRESSION",
      "Targeted regression",
      "Regression tests of the changed surfaces and their direct neighbours.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "TARGETED_INTEGRATION",
      "Targeted integration",
      "Integration across the boundary the change crosses, limited to the scoped surfaces.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "TARGETED_CORPUS",
      "Targeted corpus slice",
      "The replay or analysis corpus cases that exercise the scoped surfaces; divergences outside the declared fix are signals.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "BOUNDARY_COMPATIBILITY",
      "Boundary compatibility",
      "Previously written messages, records or API calls are still accepted, and round-trips hold.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "INVARIANT_CHECK",
      "Invariant check",
      "Targeted checks of the high or critical claims the change reaches.",
      "targeted",
      "surface-content",
      ["product"],
      "executed",
    ),
    kind(
      "GATE_DELTA_REVIEW",
      "Gate delta review",
      "Classifies each changed gate, oracle, budget or test selection as strengthen, neutral or relax. A relax needs a bounded justification: observed durations on the same revision and a named defect still detected by a negative witness.",
      "targeted",
      "surface-content",
      ["proof-infrastructure"],
      "attested",
    ),
    kind(
      "AFFECTED_JOB_RERUN",
      "Affected job rerun",
      "Rerun of the jobs whose tests or gates changed or failed, in the environment where they ran.",
      "targeted",
      "surface-content",
      ["proof-infrastructure"],
      "executed",
    ),
    kind(
      "FAILURE_ATTRIBUTION",
      "Failure attribution",
      "Evidence that attributes a failure or an unexpected behavior to its cause, such as a reproduction on the baseline.",
      "targeted",
      "surface-content",
      ["product", "proof-infrastructure"],
      "executed",
    ),
    kind(
      "ROLLBACK_PLAN",
      "Rollback plan",
      "A tested way back, or forward, for a change that is costly to reverse or reaches live runtime.",
      "targeted",
      "surface-content",
      ["product"],
      "attested",
    ),
    kind(
      "FULL_TEST_SUITE",
      "Full test suite",
      "Every test of the repository against the runtime tree.",
      "broad",
      "runtime-tree",
      ["product"],
      "executed",
    ),
    kind(
      "FULL_CORPUS",
      "Full corpus",
      "The complete replay, tactical or analysis corpus.",
      "broad",
      "runtime-tree",
      ["product"],
      "executed",
    ),
    kind(
      "INDEPENDENT_REVIEW",
      "Independent review",
      "A fresh, independent, read-only review of the scoped surfaces.",
      "broad",
      "surface-content",
      ["product", "evaluation"],
      "attested",
    ),
    kind(
      "MULTI_ENVIRONMENT",
      "Multi-environment run",
      "The affected tests on every supported operating system and runtime.",
      "broad",
      "runtime-tree",
      ["product"],
      "executed",
    ),
    kind(
      "LIVE_SHADOW",
      "Live shadow run",
      "The revision observed in shadow or canary on the live runtime before it decides anything.",
      "broad",
      "runtime-tree",
      ["product"],
      "executed",
    ),
    kind(
      "SYSTEM_REQUALIFICATION",
      "System requalification",
      "The full system-level qualification gate.",
      "ceremony",
      "runtime-tree",
      ["product"],
      "executed",
    ),
    kind(
      "BENCHMARK_PROTOCOL",
      "Benchmark protocol",
      "A fingerprinted benchmark with a pre-declared comparison scope.",
      "ceremony",
      "runtime-tree",
      ["evaluation"],
      "executed",
    ),
    kind(
      "PREREGISTRATION",
      "Preregistration",
      "Hypotheses, thresholds and protocol pinned by digest before any result is seen.",
      "ceremony",
      "surface-content",
      ["evaluation"],
      "attested",
    ),
    kind(
      "HOLDOUT_EVALUATION",
      "Holdout evaluation",
      "Evaluation on a holdout kept under independent custody.",
      "ceremony",
      "runtime-tree",
      ["evaluation"],
      "executed",
    ),
    kind(
      "CONTAMINATION_CHECK",
      "Contamination check",
      "Evidence that holdout members were not used for calibration, tuning or prompts.",
      "ceremony",
      "surface-content",
      ["evaluation"],
      "attested",
    ),
    kind(
      "PROVENANCE_ATTESTATION",
      "Provenance attestation",
      "Signed provenance of cases and results by distinct principals.",
      "ceremony",
      "surface-content",
      ["evaluation"],
      "attested",
    ),
  ],
  baselines: [
    { level: "P1", kind: "STATIC_CHECKS" },
    { level: "P1", kind: "AFFECTED_TESTS" },
    { level: "P2", kind: "TARGETED_REGRESSION" },
    { level: "P2", kind: "REVISION_IDENTITY" },
    { level: "P3", kind: "TARGETED_INTEGRATION" },
    { level: "P3", kind: "PRODUCTION_PATH_TEST" },
    { level: "P4", kind: "INDEPENDENT_REVIEW" },
    { level: "P5", kind: "PREREGISTRATION" },
    { level: "P5", kind: "PROVENANCE_ATTESTATION" },
  ],
  floors: [
    { fact: "documentation:changed", level: "P0" },
    { fact: "tests:only", level: "P1" },
    { fact: "oracle:changed", level: "P1" },
    { fact: "proof-infrastructure:changed", level: "P1" },
    { fact: "evaluation:touched", level: "P1" },
    { fact: "product:refactor", level: "P1" },
    { fact: "product:behavior-change", level: "P2" },
    { fact: "product:new-behavior", level: "P2" },
    { fact: "execution-context:changed", level: "P2" },
    ...COMPATIBILITY_BOUNDARIES.map((boundary) => ({
      fact: `boundary:${boundary}:touched` as FactId,
      level: "P2" as const,
    })),
    ...BEHAVIOR_BOUNDARIES_P3.map((boundary) => ({
      fact: `boundary:${boundary}:behavior` as FactId,
      level: "P3" as const,
    })),
    { fact: "boundary:security:touched", level: "P3" },
    { fact: "boundary:decision:behavior", level: "P4" },
    { fact: "boundary:admission:behavior", level: "P4" },
    { fact: "boundary:security:behavior", level: "P4" },
    { fact: "runtime:live:touched", level: "P3" },
    { fact: "runtime:live:behavior", level: "P4" },
    { fact: "claim:high:transitive", level: "P2" },
    { fact: "claim:high:direct", level: "P3" },
    { fact: "claim:critical:transitive", level: "P3" },
    { fact: "claim:critical:direct", level: "P4" },
    { fact: "claim:scope:component", level: "P2" },
    { fact: "claim:scope:system", level: "P4" },
    { fact: "claim:empirical", level: "P5" },
    { fact: "boundary:benchmark:behavior", level: "P5" },
    { fact: "boundary:holdout:behavior", level: "P5" },
    { fact: "reversibility:costly", level: "P3" },
    { fact: "reversibility:irreversible", level: "P4" },
    { fact: "impact:unbounded", level: "P3" },
    { fact: "observed:live-runtime", level: "P4" },
    { fact: "observed:corpus-divergence", level: "P4" },
  ],
  raises: {
    facts: [
      "uncertainty:high",
      "witness:infeasible",
      "observed:unexpected-behavior",
      "observed:witness-not-causal",
    ],
    cap: "P4",
  },
  triggers: [
    trigger("documentation:changed", ["DOCUMENTATION_CHECK"]),
    trigger("tests:only", ["AFFECTED_JOB_RERUN"]),
    trigger("oracle:changed", ["GATE_DELTA_REVIEW", "AFFECTED_JOB_RERUN"]),
    trigger("proof-infrastructure:changed", ["GATE_DELTA_REVIEW", "AFFECTED_JOB_RERUN"]),
    trigger("product:fix", ["CAUSAL_WITNESS"]),
    trigger("product:new-behavior", ["ACCEPTANCE_TEST"]),
    trigger("product:behavior-suspected", ["CHARACTERIZATION_TESTS"]),
    trigger("coverage:missing", ["CHARACTERIZATION_TESTS"]),
    ...COMPATIBILITY_BOUNDARIES.flatMap((boundary) => [
      trigger(`boundary:${boundary}:touched`, ["BOUNDARY_COMPATIBILITY"]),
      trigger(`boundary:${boundary}:behavior`, ["BOUNDARY_COMPATIBILITY"]),
    ]),
    trigger("boundary:replay:behavior", ["TARGETED_CORPUS"]),
    trigger("boundary:analysis:behavior", ["TARGETED_CORPUS"]),
    ...BOUNDARIES.map((boundary) =>
      trigger(`boundary:${boundary}:transitive`, [], ["TARGETED_INTEGRATION"]),
    ),
    trigger("runtime:live:behavior", ["LIVE_SHADOW", "ROLLBACK_PLAN", "FULL_CORPUS"]),
    trigger("observed:live-runtime", ["LIVE_SHADOW", "ROLLBACK_PLAN", "FULL_CORPUS"]),
    trigger("boundary:decision:behavior", ["FULL_CORPUS", "SYSTEM_REQUALIFICATION"]),
    trigger("boundary:admission:behavior", ["SYSTEM_REQUALIFICATION"]),
    trigger("boundary:security:touched", ["INDEPENDENT_REVIEW"]),
    trigger("claim:high:transitive", ["INVARIANT_CHECK"]),
    trigger("claim:high:direct", ["INVARIANT_CHECK"]),
    trigger("claim:critical:transitive", ["INVARIANT_CHECK"]),
    trigger("claim:critical:direct", ["INVARIANT_CHECK"]),
    trigger("claim:scope:system", ["SYSTEM_REQUALIFICATION"]),
    trigger("claim:empirical", [
      "BENCHMARK_PROTOCOL",
      "PREREGISTRATION",
      "PROVENANCE_ATTESTATION",
      "HOLDOUT_EVALUATION",
      "CONTAMINATION_CHECK",
    ]),
    trigger("claim:empirical:transitive", [], ["BENCHMARK_PROTOCOL"]),
    trigger("boundary:benchmark:behavior", [
      "BENCHMARK_PROTOCOL",
      "PREREGISTRATION",
      "PROVENANCE_ATTESTATION",
    ]),
    trigger("boundary:holdout:behavior", ["HOLDOUT_EVALUATION", "CONTAMINATION_CHECK"]),
    trigger("impact:unbounded", ["FULL_TEST_SUITE"], ["FULL_CORPUS", "INDEPENDENT_REVIEW"]),
    trigger("impact:declared", [], ["FULL_TEST_SUITE"]),
    trigger("impact:localized-unknowns", [], ["TARGETED_REGRESSION"]),
    trigger("execution-context:changed", ["FULL_TEST_SUITE"], ["MULTI_ENVIRONMENT"]),
    trigger("environment:sensitive", ["MULTI_ENVIRONMENT"]),
    trigger("reversibility:costly", ["ROLLBACK_PLAN"]),
    trigger("reversibility:irreversible", ["ROLLBACK_PLAN"]),
    trigger(
      "witness:infeasible",
      ["PRODUCTION_PATH_TEST", "TARGETED_CORPUS"],
      ["INDEPENDENT_REVIEW"],
    ),
    trigger("observed:unexpected-behavior", ["CHARACTERIZATION_TESTS", "FAILURE_ATTRIBUTION"]),
    trigger("observed:corpus-divergence", ["FULL_CORPUS", "FAILURE_ATTRIBUTION"]),
    trigger("observed:witness-not-causal", ["CAUSAL_WITNESS"]),
    trigger("observed:regression", ["TARGETED_REGRESSION"]),
    trigger("observed:unplanned-impact", ["TARGETED_REGRESSION"]),
    trigger("observed:unknown-dependency", ["TARGETED_REGRESSION"]),
    trigger("observed:infrastructure-failure", ["AFFECTED_JOB_RERUN"]),
    trigger("observed:unattributed-failure", ["FAILURE_ATTRIBUTION"]),
  ],
  status: {
    hold: [
      "observed:unattributed-failure",
      "observed:unexpected-behavior",
      "observed:witness-not-causal",
      "observed:unplanned-impact",
      "observed:unknown-dependency",
    ],
    block: ["observed:regression"],
  },
  attribution: {
    admissibleOutsideImpact: [
      "REPRODUCES_ON_BASELINE",
      "PASSES_ON_SAME_REVISION",
      "OUTSIDE_IMPACT",
      "INFRASTRUCTURE_ERROR_REPORTED",
      "DECLARED_ENVIRONMENT_FACTOR",
    ],
  },
};

/**
 * Non-negotiable minima. A caller may supply a stricter policy, never a looser one: the planner
 * must not become a way to reduce proof in order to go faster.
 */
const MINIMUM_FLOORS: ReadonlyArray<readonly [FactId, AssuranceLevel]> = [
  ["runtime:live:behavior", "P4"],
  ["boundary:decision:behavior", "P4"],
  ["boundary:admission:behavior", "P4"],
  ["boundary:security:behavior", "P4"],
  ["claim:critical:direct", "P4"],
  ["claim:empirical", "P5"],
  ["impact:unbounded", "P3"],
  ["product:behavior-change", "P2"],
  ["execution-context:changed", "P2"],
];
const MINIMUM_REQUIREMENTS: ReadonlyArray<readonly [FactId, string]> = [
  ["runtime:live:behavior", "LIVE_SHADOW"],
  ["runtime:live:behavior", "ROLLBACK_PLAN"],
  ["impact:unbounded", "FULL_TEST_SUITE"],
  ["execution-context:changed", "FULL_TEST_SUITE"],
  ["product:fix", "CAUSAL_WITNESS"],
  ["product:new-behavior", "ACCEPTANCE_TEST"],
  ["claim:empirical", "PREREGISTRATION"],
  ["claim:empirical", "HOLDOUT_EVALUATION"],
  ["observed:unattributed-failure", "FAILURE_ATTRIBUTION"],
  ["proof-infrastructure:changed", "GATE_DELTA_REVIEW"],
  ["oracle:changed", "GATE_DELTA_REVIEW"],
];
const MINIMUM_HOLDS: readonly FactId[] = [
  "observed:unattributed-failure",
  "observed:unplanned-impact",
  "observed:unknown-dependency",
];
const MINIMUM_BLOCKS: readonly FactId[] = ["observed:regression"];
const PRODUCT_OBSERVATION_FACTS: readonly FactId[] = STATIC_FACT_IDS.filter((fact) =>
  fact.startsWith("observed:"),
);

export function parseAssurancePolicy(input: unknown): AssurancePolicy {
  const parsed = AssurancePolicySchema.safeParse(input);
  if (!parsed.success) {
    throw new ProofPlannerError("PROOF_PLANNER_POLICY_INVALID", z.prettifyError(parsed.error));
  }
  const policy = parsed.data;
  const kinds = new Set<string>();
  for (const spec of policy.evidence) {
    if (kinds.has(spec.id)) {
      throw new ProofPlannerError(
        "PROOF_PLANNER_POLICY_INVALID",
        `duplicate evidence kind ${spec.id}`,
      );
    }
    kinds.add(spec.id);
  }
  const references = [
    ...policy.baselines.map((baseline) => baseline.kind),
    ...policy.triggers.flatMap((entry) => [...entry.require, ...entry.recommend]),
  ];
  for (const reference of references) {
    if (!kinds.has(reference)) {
      throw new ProofPlannerError(
        "PROOF_PLANNER_POLICY_INVALID",
        `unknown evidence kind ${reference}`,
      );
    }
  }
  assertPolicyMinimum(policy);
  return policy;
}

function assertPolicyMinimum(policy: AssurancePolicy): void {
  const violations: string[] = [];
  for (const [fact, level] of MINIMUM_FLOORS) {
    const floor = Math.max(
      -1,
      ...policy.floors
        .filter((entry) => entry.fact === fact)
        .map((entry) => levelIndex(entry.level)),
    );
    if (floor < levelIndex(level)) violations.push(`floor ${fact} >= ${level}`);
  }
  for (const [fact, required] of MINIMUM_REQUIREMENTS) {
    const present = policy.triggers.some(
      (entry) => entry.fact === fact && entry.require.includes(required),
    );
    if (!present) violations.push(`trigger ${fact} requires ${required}`);
  }
  for (const fact of MINIMUM_HOLDS) {
    if (!policy.status.hold.includes(fact) && !policy.status.block.includes(fact)) {
      violations.push(`status holds on ${fact}`);
    }
  }
  for (const fact of MINIMUM_BLOCKS) {
    if (!policy.status.block.includes(fact)) violations.push(`status blocks on ${fact}`);
  }
  for (const fact of PRODUCT_OBSERVATION_FACTS) {
    const consumed =
      policy.triggers.some((entry) => entry.fact === fact && entry.require.length > 0) ||
      policy.status.hold.includes(fact) ||
      policy.status.block.includes(fact);
    if (!consumed) violations.push(`observation fact ${fact} has no requirement or status effect`);
  }
  if (levelIndex(policy.raises.cap) > levelIndex("P4")) {
    violations.push("raise cap <= P4 (a raise never creates an empirical claim)");
  }
  if (violations.length > 0) {
    throw new ProofPlannerError("PROOF_PLANNER_POLICY_BELOW_MINIMUM", violations.join("; "));
  }
}

/** Digest of what a kind means. Title and description edits never invalidate evidence. */
export function evidenceKindSemanticDigest(spec: EvidenceKindSpec): string {
  return sha256Canonical({
    id: spec.id,
    weight: spec.weight,
    binding: spec.binding,
    subjects: [...spec.subjects].sort(),
    verification: spec.verification,
    semanticsVersion: spec.semanticsVersion,
  });
}

export function assurancePolicyDigest(policy: AssurancePolicy): string {
  return sha256Canonical(policy);
}
