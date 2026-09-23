import * as z from "zod";

export const PROOF_PLANNER_SCHEMA_VERSION = "1.0.0" as const;

export class ProofPlannerError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ProofPlannerError";
    this.code = code;
  }
}

export const ASSURANCE_LEVELS = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export const SURFACE_ROLES = [
  "product",
  "execution-context",
  "evaluation",
  "test",
  "proof-infrastructure",
  "documentation",
] as const;
export type SurfaceRole = (typeof SURFACE_ROLES)[number];
export const SURFACE_REACHES = ["direct", "transitive"] as const;
export const SURFACE_RUNTIMES = ["none", "build", "offline-analysis", "live"] as const;
export const BOUNDARIES = [
  "protocol",
  "persistence",
  "replay",
  "analysis",
  "decision",
  "admission",
  "security",
  "public-api",
  "benchmark",
  "holdout",
] as const;
export type Boundary = (typeof BOUNDARIES)[number];
export const BEHAVIOR_CHANGES = ["none", "suspected", "fix", "feature"] as const;
export const COVERAGES = ["tested", "untested", "unknown"] as const;

export const CLAIM_KINDS = [
  "behavior",
  "equivalence",
  "invariant",
  "compatibility",
  "empirical",
  "documentation",
] as const;
export const CLAIM_CRITICALITIES = ["low", "standard", "high", "critical"] as const;
export const CLAIM_SCOPES = ["local", "component", "system"] as const;

export const PRODUCT_SIGNALS = [
  "UNEXPECTED_BEHAVIOR",
  "UNPLANNED_IMPACT",
  "UNKNOWN_DEPENDENCY",
  "LIVE_RUNTIME_TOUCHED",
  "CORPUS_DIVERGENCE",
  "WITNESS_NOT_CAUSAL",
  "REGRESSION",
] as const;
export const INFRASTRUCTURE_SIGNALS = [
  "TIMEOUT",
  "ENVIRONMENT_FAILURE",
  "TOOLING_FAILURE",
] as const;
export type ProductSignal = (typeof PRODUCT_SIGNALS)[number];
export type InfrastructureSignal = (typeof INFRASTRUCTURE_SIGNALS)[number];
export type SignalName = ProductSignal | InfrastructureSignal;
export const ATTRIBUTION_BASES = [
  "REPRODUCES_ON_BASELINE",
  "PASSES_ON_SAME_REVISION",
  "OUTSIDE_IMPACT",
  "INFRASTRUCTURE_ERROR_REPORTED",
  "DECLARED_ENVIRONMENT_FACTOR",
] as const;
export type AttributionBasis = (typeof ATTRIBUTION_BASES)[number];

/** What a piece of evidence is about. Surface roles map onto these subjects. */
export const EVIDENCE_SUBJECTS = [
  "product",
  "evaluation",
  "proof-infrastructure",
  "documentation",
] as const;
export type EvidenceSubject = (typeof EVIDENCE_SUBJECTS)[number];
export const EVIDENCE_WEIGHTS = ["targeted", "broad", "ceremony"] as const;
export type EvidenceWeight = (typeof EVIDENCE_WEIGHTS)[number];
/**
 * What a piece of evidence stays valid for.
 * - exact-revision: only the revision it was produced on.
 * - surface-content: each scoped surface, while that surface, the tests that exercise it, the
 *   baseline and (for product and evaluation evidence) the runtime tree keep their digests.
 * - runtime-tree: any revision with the same baseline and runtime tree digest.
 */
export const EVIDENCE_BINDINGS = ["exact-revision", "surface-content", "runtime-tree"] as const;
export type EvidenceBinding = (typeof EVIDENCE_BINDINGS)[number];
export const EVIDENCE_VERIFICATIONS = ["executed", "attested"] as const;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/);
const TextSchema = z.string().min(1).max(1_024);
/** A git commit or tree object id, or a sha256 content digest. */
const RevisionIdSchema = z.string().regex(/^([a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/);
/** An explicitly typed content identity, so that two formats can never compare equal. */
const ContentDigestSchema = z
  .string()
  .regex(/^(sha256:[a-f0-9]{64}|git:[a-f0-9]{40}|git:[a-f0-9]{64})$/);
export const EvidenceKindIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export const SurfaceSchema = z.strictObject({
  id: IdentifierSchema,
  role: z.enum(SURFACE_ROLES),
  reach: z.enum(SURFACE_REACHES),
  runtime: z.enum(SURFACE_RUNTIMES),
  boundaries: z.array(z.enum(BOUNDARIES)).max(BOUNDARIES.length),
  /**
   * For product, execution-context and evaluation surfaces: the declared behavior change.
   * For test and proof-infrastructure surfaces: "none" means purely additive; any other value
   * means an existing oracle, budget, selection or gate is modified.
   */
  behaviorChange: z.enum(BEHAVIOR_CHANGES),
  coverage: z.enum(COVERAGES),
  environmentSensitive: z.boolean(),
  contentDigest: ContentDigestSchema.optional(),
  /** Test surfaces only: identifiers of the surfaces this test exercises. Absent means all. */
  exercises: z.array(IdentifierSchema).max(512).optional(),
});
export type Surface = z.infer<typeof SurfaceSchema>;

export const ChangeImpactSchema = z.strictObject({
  schemaVersion: z.literal(PROOF_PLANNER_SCHEMA_VERSION),
  revision: z.strictObject({
    id: RevisionIdSchema,
    /** Merge-base the impact is computed against; the impact is cumulative from it. */
    baseline: RevisionIdSchema,
    /** Digest of every path that is not test, proof infrastructure or documentation. */
    runtimeTreeDigest: ContentDigestSchema.optional(),
  }),
  surfaces: z.array(SurfaceSchema).min(1).max(512),
  analysis: z.strictObject({
    method: z.enum(["static-graph", "declared"]),
    completeness: z.enum(["complete", "partial", "unknown"]),
    uncertainty: z.enum(["low", "medium", "high"]),
    unknowns: z
      .array(
        z.strictObject({
          description: TextSchema,
          surfaces: z.array(IdentifierSchema).max(64),
        }),
      )
      .max(64),
    omittedSurfaceCount: z.int().min(0).max(1_000_000),
  }),
  reversibility: z.enum(["trivial", "reversible", "costly", "irreversible"]),
  causalWitness: z.enum(["available", "feasible", "infeasible", "not-applicable"]),
});
export type ChangeImpact = z.infer<typeof ChangeImpactSchema>;

export const AssuranceClaimSchema = z.strictObject({
  id: IdentifierSchema,
  statement: TextSchema,
  kind: z.enum(CLAIM_KINDS),
  criticality: z.enum(CLAIM_CRITICALITIES),
  scope: z.enum(CLAIM_SCOPES),
  surfaces: z.array(IdentifierSchema).min(1).max(512),
});
export type AssuranceClaim = z.infer<typeof AssuranceClaimSchema>;

export const ProofSignalSchema = z.strictObject({
  id: IdentifierSchema,
  /** Signals only count for the revision they were observed on. */
  revision: RevisionIdSchema,
  signal: z.enum([...PRODUCT_SIGNALS, ...INFRASTRUCTURE_SIGNALS]),
  surfaces: z.array(IdentifierSchema).max(512),
  exercisesImpactedSurfaces: z.enum(["yes", "no", "unknown"]),
  attribution: z.array(z.enum(ATTRIBUTION_BASES)).max(ATTRIBUTION_BASES.length),
  detail: TextSchema,
});
export type ProofSignal = z.infer<typeof ProofSignalSchema>;

export const EvidenceKindSpecSchema = z.strictObject({
  id: EvidenceKindIdSchema,
  title: TextSchema,
  description: TextSchema,
  weight: z.enum(EVIDENCE_WEIGHTS),
  binding: z.enum(EVIDENCE_BINDINGS),
  subjects: z.array(z.enum(EVIDENCE_SUBJECTS)).min(1).max(EVIDENCE_SUBJECTS.length),
  verification: z.enum(EVIDENCE_VERIFICATIONS),
  /** Bump when the meaning of the kind changes; title and description edits do not count. */
  semanticsVersion: z.int().min(1).max(1_000),
});
export type EvidenceKindSpec = z.infer<typeof EvidenceKindSpecSchema>;

export function subjectOfRole(role: SurfaceRole): EvidenceSubject {
  switch (role) {
    case "product":
    case "execution-context":
      return "product";
    case "evaluation":
      return "evaluation";
    case "test":
    case "proof-infrastructure":
      return "proof-infrastructure";
    case "documentation":
      return "documentation";
  }
}

export function levelIndex(level: AssuranceLevel): number {
  return ASSURANCE_LEVELS.indexOf(level);
}

export function levelAt(index: number): AssuranceLevel {
  const bounded = Math.max(0, Math.min(ASSURANCE_LEVELS.length - 1, index));
  return ASSURANCE_LEVELS[bounded] ?? "P0";
}

/** Ordinal (UTF-16 code unit) comparison; never locale-dependent. */
export function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(compareOrdinal);
}
