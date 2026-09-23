import * as z from "zod";
import { sha256Canonical } from "../core/index.js";
import {
  type AssuranceClaim,
  AssuranceClaimSchema,
  type AssuranceLevel,
  type AttributionBasis,
  BOUNDARIES,
  type Boundary,
  type ChangeImpact,
  ChangeImpactSchema,
  compareOrdinal,
  EVIDENCE_SUBJECTS,
  type EvidenceBinding,
  type EvidenceKindSpec,
  type EvidenceSubject,
  type EvidenceWeight,
  INFRASTRUCTURE_SIGNALS,
  levelAt,
  levelIndex,
  PRODUCT_SIGNALS,
  type ProductSignal,
  PROOF_PLANNER_SCHEMA_VERSION,
  ProofPlannerError,
  type ProofSignal,
  ProofSignalSchema,
  type SignalName,
  type Surface,
  type SurfaceRole,
  sortedUnique,
  subjectOfRole,
} from "./model.js";
import {
  type AssurancePolicy,
  assurancePolicyDigest,
  DEFAULT_ASSURANCE_POLICY,
  evidenceKindSemanticDigest,
  type FactId,
  parseAssurancePolicy,
} from "./policy.js";

export type ImpactBound =
  | "no-product-runtime"
  | "bounded-confident"
  | "bounded-uncertain"
  | "unbounded";
export type PlanStatus = "PROVE" | "HOLD" | "BLOCKED";
export type SignalClassificationName =
  | "product"
  | "proof-infrastructure"
  | "unattributed"
  | "pre-existing"
  | "absorbed"
  | "other-revision";

export interface PlannerFact {
  id: FactId;
  subject: EvidenceSubject;
  surfaces: string[];
  refs: string[];
  detail: string;
}

export interface EvidenceRequirement {
  kind: string;
  title: string;
  weight: EvidenceWeight;
  binding: EvidenceBinding;
  verification: EvidenceKindSpec["verification"];
  subjects: EvidenceSubject[];
  semanticDigest: string;
  /** Surfaces the evidence is about; empty for revision-wide evidence. */
  surfaces: string[];
  /** Fact ids or `baseline:<level>:<subject>` entries that made this evidence necessary. */
  because: string[];
}

export interface ActivationCondition {
  /** Policy triggers that would have required or recommended the kind. */
  triggers: { fact: FactId; effect: "require" | "recommend" }[];
  /** Level baselines that would have required the kind. */
  baselines: {
    level: AssuranceLevel;
    subjects: { subject: EvidenceSubject; level: AssuranceLevel | null }[];
  }[];
}

export interface NotRequiredEvidence {
  requirement: EvidenceRequirement;
  rationale: string;
  activation: ActivationCondition;
  evaluatedAgainst: "actual-change" | "worst-case";
}

export interface UndeterminedEvidence {
  requirement: EvidenceRequirement;
  rationale: string;
}

export interface EscalationCondition {
  signal: SignalName;
  variant: "product" | "infrastructure-attributed" | "infrastructure-unattributed";
  classification: SignalClassificationName;
  resultingLevel: AssuranceLevel;
  resultingStatus: PlanStatus;
  addsRequired: string[];
  rationale: string;
}

export interface PlannerDecision {
  step: "impact" | "claim" | "signal" | "floor" | "raise" | "level" | "status";
  subject: EvidenceSubject | null;
  fact: FactId | null;
  level: AssuranceLevel | null;
  detail: string;
}

export interface Uncertainty {
  id: string;
  statement: string;
  mitigatedBy: string[];
}

export interface SignalClassification {
  id: string;
  signal: SignalName;
  classification: SignalClassificationName;
  exercises: "yes" | "no" | "unknown";
  basis: AttributionBasis[];
  surfaces: string[];
  reason: string;
}

export interface PlanSurface {
  id: string;
  role: SurfaceRole;
  reach: Surface["reach"];
  contentDigest: string | null;
  exercises: string[] | null;
}

export interface AssurancePlan {
  schemaVersion: typeof PROOF_PLANNER_SCHEMA_VERSION;
  status: PlanStatus;
  level: AssuranceLevel;
  levelBySubject: { subject: EvidenceSubject; level: AssuranceLevel }[];
  impactBound: ImpactBound;
  subject: {
    revision: string;
    baseline: string;
    runtimeTreeDigest: string | null;
    surfaces: PlanSurface[];
  };
  requiredEvidence: EvidenceRequirement[];
  recommendedEvidence: EvidenceRequirement[];
  explicitlyNotRequired: NotRequiredEvidence[];
  undeterminedEvidence: UndeterminedEvidence[];
  escalations: EscalationCondition[];
  rationale: PlannerDecision[];
  facts: PlannerFact[];
  signals: SignalClassification[];
  unaffectedClaims: { id: string; reason: string }[];
  residualUncertainty: Uncertainty[];
  policy: { id: string; version: string; digest: string };
  inputDigest: string;
  planDigest: string;
}

export interface PlanAssuranceInput {
  impact: z.input<typeof ChangeImpactSchema>;
  claims?: z.input<typeof AssuranceClaimSchema>[];
  signals?: z.input<typeof ProofSignalSchema>[];
  policy?: AssurancePolicy;
}

interface NormalizedInput {
  impact: ChangeImpact;
  claims: AssuranceClaim[];
  signals: ProofSignal[];
  policy: AssurancePolicy;
  policyDigest: string;
}

interface CoreResult {
  status: PlanStatus;
  level: AssuranceLevel;
  levelBySubject: Map<EvidenceSubject, number>;
  bound: ImpactBound;
  boundReasons: string[];
  facts: PlannerFact[];
  factIds: Set<FactId>;
  signals: SignalClassification[];
  unaffectedClaims: { id: string; reason: string }[];
  claimsOutsideImpact: string[];
  required: Map<string, Accumulator>;
  recommended: Map<string, Accumulator>;
  rationale: PlannerDecision[];
}

interface Accumulator {
  surfaces: Set<string>;
  because: Set<string>;
}

const PRODUCT_RUNTIME_ROLES: ReadonlySet<SurfaceRole> = new Set([
  "product",
  "execution-context",
  "evaluation",
]);
const EVALUATION_BOUNDARIES: ReadonlySet<Boundary> = new Set(["benchmark", "holdout"]);
/** Boundaries that keep their weight when declared on a test or a proof-infrastructure surface. */
const SENSITIVE_BOUNDARIES: ReadonlySet<Boundary> = new Set(["security", "admission", "decision"]);
const PRE_EXISTING_CAPABLE: ReadonlySet<SignalName> = new Set([
  "UNEXPECTED_BEHAVIOR",
  "CORPUS_DIVERGENCE",
  "REGRESSION",
]);
const SIGNAL_FACTS: Record<ProductSignal, FactId> = {
  UNEXPECTED_BEHAVIOR: "observed:unexpected-behavior",
  UNPLANNED_IMPACT: "observed:unplanned-impact",
  UNKNOWN_DEPENDENCY: "observed:unknown-dependency",
  LIVE_RUNTIME_TOUCHED: "observed:live-runtime",
  CORPUS_DIVERGENCE: "observed:corpus-divergence",
  WITNESS_NOT_CAUSAL: "observed:witness-not-causal",
  REGRESSION: "observed:regression",
};
const HYPOTHETICAL_PREFIX = "hypothetical.";

/**
 * Decide which evidence is proportionate for a change. Pure and deterministic: no clock, no
 * randomness, no I/O. The plan states requirements; it never claims that evidence exists.
 */
export function planAssurance(input: PlanAssuranceInput): AssurancePlan {
  const normalized = normalizeInput(input);
  const core = planCore(normalized);
  const catalog = normalized.policy.evidence;

  const required = materialize(core.required, catalog);
  const recommended = materialize(core.recommended, catalog);
  const partition = partitionCatalog(normalized, core);
  const escalations = computeEscalations(normalized, core);
  const residualUncertainty = computeUncertainty(normalized, core, partition.notRequired);

  const plan: Omit<AssurancePlan, "planDigest"> = {
    schemaVersion: PROOF_PLANNER_SCHEMA_VERSION,
    status: core.status,
    level: core.level,
    levelBySubject: EVIDENCE_SUBJECTS.filter((subject) => core.levelBySubject.has(subject)).map(
      (subject) => ({ subject, level: levelAt(core.levelBySubject.get(subject) ?? 0) }),
    ),
    impactBound: core.bound,
    subject: {
      revision: normalized.impact.revision.id,
      baseline: normalized.impact.revision.baseline,
      runtimeTreeDigest: normalized.impact.revision.runtimeTreeDigest ?? null,
      surfaces: normalized.impact.surfaces.map((surface) => ({
        id: surface.id,
        role: surface.role,
        reach: surface.reach,
        contentDigest: surface.contentDigest ?? null,
        exercises: surface.exercises ?? null,
      })),
    },
    requiredEvidence: required,
    recommendedEvidence: [
      ...recommended,
      ...materialize(partition.worstCaseRecommended, catalog),
    ].sort((left, right) => compareOrdinal(left.kind, right.kind)),
    explicitlyNotRequired: partition.notRequired,
    undeterminedEvidence: partition.undetermined,
    escalations,
    rationale: core.rationale,
    facts: core.facts,
    signals: core.signals,
    unaffectedClaims: core.unaffectedClaims,
    residualUncertainty,
    policy: {
      id: normalized.policy.id,
      version: normalized.policy.version,
      digest: normalized.policyDigest,
    },
    inputDigest: sha256Canonical({
      impact: normalized.impact,
      claims: normalized.claims,
      signals: normalized.signals,
      policyDigest: normalized.policyDigest,
    }),
  };
  return { ...plan, planDigest: sha256Canonical(plan) };
}

function normalizeInput(input: PlanAssuranceInput): NormalizedInput {
  const impactResult = ChangeImpactSchema.safeParse(input.impact);
  if (!impactResult.success) {
    throw new ProofPlannerError("PROOF_PLANNER_INPUT_INVALID", z.prettifyError(impactResult.error));
  }
  const claimsResult = z
    .array(AssuranceClaimSchema)
    .max(1_024)
    .safeParse(input.claims ?? []);
  if (!claimsResult.success) {
    throw new ProofPlannerError("PROOF_PLANNER_INPUT_INVALID", z.prettifyError(claimsResult.error));
  }
  const signalsResult = z
    .array(ProofSignalSchema)
    .max(256)
    .safeParse(input.signals ?? []);
  if (!signalsResult.success) {
    throw new ProofPlannerError(
      "PROOF_PLANNER_INPUT_INVALID",
      z.prettifyError(signalsResult.error),
    );
  }
  const policy = parseAssurancePolicy(input.policy ?? DEFAULT_ASSURANCE_POLICY);
  const raw = impactResult.data;
  const impact: ChangeImpact = {
    schemaVersion: raw.schemaVersion,
    revision: {
      id: raw.revision.id,
      baseline: raw.revision.baseline,
      ...(raw.revision.runtimeTreeDigest === undefined
        ? {}
        : { runtimeTreeDigest: raw.revision.runtimeTreeDigest }),
    },
    surfaces: raw.surfaces
      .map((surface) => ({
        id: surface.id,
        role: surface.role,
        reach: surface.reach,
        runtime: surface.runtime,
        boundaries: sortedUnique(surface.boundaries),
        behaviorChange: surface.behaviorChange,
        coverage: surface.coverage,
        environmentSensitive: surface.environmentSensitive,
        ...(surface.contentDigest === undefined ? {} : { contentDigest: surface.contentDigest }),
        ...(surface.exercises === undefined ? {} : { exercises: sortedUnique(surface.exercises) }),
      }))
      .sort((left, right) => compareOrdinal(left.id, right.id)),
    analysis: {
      method: raw.analysis.method,
      completeness: raw.analysis.completeness,
      uncertainty: raw.analysis.uncertainty,
      unknowns: raw.analysis.unknowns
        .map((unknown) => ({
          description: unknown.description,
          surfaces: sortedUnique(unknown.surfaces),
        }))
        .sort(
          (left, right) =>
            compareOrdinal(left.description, right.description) ||
            compareOrdinal(left.surfaces.join("\u0000"), right.surfaces.join("\u0000")),
        ),
      omittedSurfaceCount: raw.analysis.omittedSurfaceCount,
    },
    reversibility: raw.reversibility,
    causalWitness: raw.causalWitness,
  };
  assertUniqueIds(impact.surfaces, "surface");
  const claims = claimsResult.data
    .map((claim) => ({ ...claim, surfaces: sortedUnique(claim.surfaces) }))
    .sort((left, right) => compareOrdinal(left.id, right.id));
  assertUniqueIds(claims, "claim");
  const signals = signalsResult.data
    .map((signal) => ({
      ...signal,
      surfaces: sortedUnique(signal.surfaces),
      attribution: sortedUnique(signal.attribution),
    }))
    .sort((left, right) => compareOrdinal(left.id, right.id));
  assertUniqueIds(signals, "signal");
  for (const [label, items] of [
    ["surface", impact.surfaces],
    ["claim", claims],
    ["signal", signals],
  ] as const) {
    for (const item of items) {
      if (item.id.startsWith(HYPOTHETICAL_PREFIX)) {
        throw new ProofPlannerError(
          "PROOF_PLANNER_INPUT_INCONSISTENT",
          `${label} id prefix ${HYPOTHETICAL_PREFIX} is reserved: ${item.id}`,
        );
      }
    }
  }
  return { impact, claims, signals, policy, policyDigest: assurancePolicyDigest(policy) };
}

function assertUniqueIds(items: ReadonlyArray<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new ProofPlannerError(
        "PROOF_PLANNER_INPUT_INCONSISTENT",
        `duplicate ${label} ${item.id}`,
      );
    }
    seen.add(item.id);
  }
}

function planCore(input: NormalizedInput): CoreResult {
  const { impact, policy } = input;
  const facts = new FactSet();
  const rationale: PlannerDecision[] = [];
  const productRuntimeTouched = impact.surfaces.some((surface) =>
    PRODUCT_RUNTIME_ROLES.has(surface.role),
  );

  deriveSurfaceFacts(impact, facts);

  // 1. Product signals first: they can reopen the impact bound. A signal observed on another
  // revision still counts while it is unresolved and the product it observed is byte-identical.
  const classifications: SignalClassification[] = [];
  const infrastructureSignals: ProofSignal[] = [];
  const record = ({ classification, facts: observed, source }: SignalOutcome) => {
    const carried = source.revision !== impact.revision.id;
    if (carried && !isUnresolvedSignal(classification)) {
      classifications.push(
        otherRevision(source, `observed on revision ${source.revision} and resolved there`),
      );
      return;
    }
    for (const fact of observed) {
      facts.add(fact.id, fact.subject, fact.surfaces, fact.refs, fact.detail);
    }
    classifications.push(
      carried
        ? {
            ...classification,
            reason: `carried from revision ${source.revision}, same baseline and runtime tree: ${classification.reason}`,
          }
        : classification,
    );
  };
  for (const signal of input.signals) {
    if (signal.revision !== impact.revision.id && !observedSameProduct(signal, impact)) {
      classifications.push(
        otherRevision(
          signal,
          `observed on revision ${signal.revision}, not on the planned revision`,
        ),
      );
      continue;
    }
    const name = signal.signal;
    if (!isProductSignal(name)) {
      infrastructureSignals.push(signal);
      continue;
    }
    record(classifyProductSignal(signal, name, impact));
  }

  // 2. Impact bound, after product signals.
  const boundResult = computeBound(input, productRuntimeTouched, facts);
  rationale.push({
    step: "impact",
    subject: null,
    fact: null,
    level: null,
    detail: `${boundResult.bound}${boundResult.reasons.length > 0 ? `: ${boundResult.reasons.join("; ")}` : ""}`,
  });

  // 3. Claims, which need the bound to decide whether an untouched claim is unaffected.
  const claimOutcome = deriveClaimFacts(input, boundResult.bound, facts);
  for (const note of [...claimOutcome.unaffected, ...claimOutcome.throughProof]) {
    rationale.push({
      step: "claim",
      subject: null,
      fact: null,
      level: null,
      detail: `${note.id}: ${note.reason}`,
    });
  }

  // 4. Infrastructure signals last, with the final bound.
  for (const signal of infrastructureSignals) {
    record(classifyInfrastructureSignal(signal, input, boundResult.bound));
  }
  classifications.sort((left, right) => compareOrdinal(left.id, right.id));
  for (const classification of classifications) {
    rationale.push({
      step: "signal",
      subject: null,
      fact: null,
      level: null,
      detail: `${classification.id} (${classification.signal}) -> ${classification.classification}: ${classification.reason}`,
    });
  }

  // 5. Levels per subject.
  const floors = new Map<EvidenceSubject, number>();
  for (const fact of facts.list()) {
    for (const floor of policy.floors.filter((entry) => entry.fact === fact.id)) {
      const index = levelIndex(floor.level);
      floors.set(fact.subject, Math.max(floors.get(fact.subject) ?? 0, index));
      rationale.push({
        step: "floor",
        subject: fact.subject,
        fact: fact.id,
        level: floor.level,
        detail: fact.detail,
      });
    }
    if (!floors.has(fact.subject)) floors.set(fact.subject, 0);
  }
  const raised = new Set<EvidenceSubject>();
  for (const fact of facts.list()) {
    if (policy.raises.facts.includes(fact.id)) {
      raised.add(fact.subject);
      rationale.push({
        step: "raise",
        subject: fact.subject,
        fact: fact.id,
        level: null,
        detail: `${fact.detail}; raises ${fact.subject} by one step, capped at ${policy.raises.cap}`,
      });
    }
  }
  const levelBySubject = new Map<EvidenceSubject, number>();
  for (const subject of EVIDENCE_SUBJECTS) {
    const floor = floors.get(subject);
    if (floor === undefined) continue;
    const level = raised.has(subject)
      ? Math.max(floor, Math.min(levelIndex(policy.raises.cap), floor + 1))
      : floor;
    levelBySubject.set(subject, level);
    rationale.push({
      step: "level",
      subject,
      fact: null,
      level: levelAt(level),
      detail: `${subject}: highest floor ${levelAt(floor)}${raised.has(subject) ? ", raised" : ""}`,
    });
  }
  const overall = Math.max(0, ...levelBySubject.values());

  // 6. Evidence from level baselines and fact triggers.
  const required = new Map<string, Accumulator>();
  const recommended = new Map<string, Accumulator>();
  const catalog = new Map(policy.evidence.map((spec) => [spec.id, spec]));
  // Evidence bound to the exact revision is revision-wide: it carries no surface scope.
  const scoped = (kind: string, surfaces: Iterable<string>): Iterable<string> =>
    catalog.get(kind)?.binding === "exact-revision" ? [] : surfaces;
  for (const baseline of policy.baselines) {
    const spec = catalog.get(baseline.kind);
    if (!spec) continue;
    const subjects = spec.subjects.filter(
      (subject) => (levelBySubject.get(subject) ?? -1) >= levelIndex(baseline.level),
    );
    for (const subject of subjects) {
      accumulate(
        required,
        baseline.kind,
        scoped(baseline.kind, subjectSurfaces(impact, facts, subject)),
        `baseline:${baseline.level}:${subject}`,
      );
    }
  }
  for (const fact of facts.list()) {
    for (const entry of policy.triggers.filter((candidate) => candidate.fact === fact.id)) {
      for (const kind of entry.require) {
        accumulate(required, kind, scoped(kind, fact.surfaces), fact.id);
      }
      for (const kind of entry.recommend) {
        accumulate(recommended, kind, scoped(kind, fact.surfaces), fact.id);
      }
    }
  }
  for (const kind of required.keys()) recommended.delete(kind);

  // 7. Status.
  const blocking = sortedUnique(
    facts.list().flatMap((fact) => (policy.status.block.includes(fact.id) ? [fact.id] : [])),
  );
  const holding = sortedUnique(
    facts.list().flatMap((fact) => (policy.status.hold.includes(fact.id) ? [fact.id] : [])),
  );
  const status: PlanStatus =
    blocking.length > 0 ? "BLOCKED" : holding.length > 0 ? "HOLD" : "PROVE";
  rationale.push({
    step: "status",
    subject: null,
    fact: null,
    level: null,
    detail:
      status === "PROVE"
        ? "no blocking or holding fact"
        : `${status}: ${[...blocking, ...holding].join(", ")}`,
  });

  return {
    status,
    level: levelAt(overall),
    levelBySubject,
    bound: boundResult.bound,
    boundReasons: boundResult.reasons,
    facts: facts.list(),
    factIds: new Set(facts.list().map((fact) => fact.id)),
    signals: classifications,
    unaffectedClaims: claimOutcome.unaffected,
    claimsOutsideImpact: claimOutcome.outsideImpact,
    required,
    recommended,
    rationale,
  };
}

/** Facts keyed by id and subject: one observation can concern several subjects. */
class FactSet {
  private readonly facts = new Map<string, PlannerFact>();

  add(
    id: FactId,
    subject: EvidenceSubject,
    surfaces: Iterable<string>,
    refs: Iterable<string>,
    detail: string,
  ): void {
    const key = `${id}|${subject}`;
    const existing = this.facts.get(key);
    if (existing) {
      existing.surfaces = sortedUnique([...existing.surfaces, ...surfaces]);
      existing.refs = sortedUnique([...existing.refs, ...refs]);
      return;
    }
    this.facts.set(key, {
      id,
      subject,
      surfaces: sortedUnique(surfaces),
      refs: sortedUnique(refs),
      detail,
    });
  }

  has(id: FactId): boolean {
    return [...this.facts.values()].some((fact) => fact.id === id);
  }

  list(): PlannerFact[] {
    return [...this.facts.values()].sort(
      (left, right) =>
        compareOrdinal(left.id, right.id) || compareOrdinal(left.subject, right.subject),
    );
  }
}

function ids(surfaces: ReadonlyArray<Surface>): string[] {
  return surfaces.map((surface) => surface.id);
}

function describe(surfaces: ReadonlyArray<Surface>, what: string): string {
  return `${ids(surfaces).join(", ")}: ${what}`;
}

function deriveSurfaceFacts(impact: ChangeImpact, facts: FactSet): void {
  const direct = impact.surfaces.filter((surface) => surface.reach === "direct");
  const directOf = (...roles: SurfaceRole[]) =>
    direct.filter((surface) => roles.includes(surface.role));
  const add = (
    id: FactId,
    subject: EvidenceSubject,
    surfaces: ReadonlyArray<Surface>,
    what: string,
  ) => {
    if (surfaces.length > 0) facts.add(id, subject, ids(surfaces), [], describe(surfaces, what));
  };
  const runtime = impact.surfaces.filter((surface) => PRODUCT_RUNTIME_ROLES.has(surface.role));
  const directRuntime = runtime.filter((surface) => surface.reach === "direct");
  const directRuntimeIds = new Set(ids(directRuntime));

  add("documentation:changed", "documentation", directOf("documentation"), "documentation changed");
  add(
    "tests:changed",
    "proof-infrastructure",
    directOf("test").filter(
      (surface) => !(surface.exercises?.some((id) => directRuntimeIds.has(id)) ?? false),
    ),
    "tests changed that the product evidence does not run",
  );
  add(
    "oracle:changed",
    "proof-infrastructure",
    directOf("test").filter((surface) => surface.behaviorChange !== "none"),
    "an existing test oracle, budget or selection changed",
  );
  add(
    "proof-infrastructure:changed",
    "proof-infrastructure",
    directOf("proof-infrastructure"),
    "proof infrastructure changed",
  );
  add(
    "execution-context:changed",
    "product",
    directOf("execution-context"),
    "execution context (dependencies, build or runtime configuration) changed",
  );
  add("evaluation:touched", "evaluation", directOf("evaluation"), "evaluation surface changed");

  const product = directOf("product");
  if (product.length > 0 && product.every((surface) => surface.behaviorChange === "none")) {
    add("product:refactor", "product", product, "product changed without declared behavior change");
  }
  const behavioral = product.filter((surface) => surface.behaviorChange !== "none");
  add("product:behavior-change", "product", behavioral, "product behavior may change");
  add(
    "product:behavior-suspected",
    "product",
    product.filter((surface) => surface.behaviorChange === "suspected"),
    "behavior may change without intent",
  );
  const fixes = product.filter((surface) => surface.behaviorChange === "fix");
  if (impact.causalWitness === "infeasible") {
    add("witness:infeasible", "product", fixes, "fix declared without a reproducible witness");
  } else {
    add("product:fix", "product", fixes, "behavioral fix");
  }
  add(
    "product:new-behavior",
    "product",
    product.filter((surface) => surface.behaviorChange === "feature"),
    "new behavior",
  );

  const liveCapable = impact.surfaces.filter(
    (surface) =>
      (surface.role === "product" || surface.role === "execution-context") &&
      surface.runtime === "live",
  );
  add(
    "runtime:live:touched",
    "product",
    liveCapable.filter((surface) => surface.reach === "direct"),
    "live runtime surface changed",
  );
  add(
    "runtime:live:behavior",
    "product",
    liveCapable.filter((surface) => surface.behaviorChange !== "none"),
    "live runtime behavior may change",
  );

  for (const boundary of BOUNDARIES) {
    const evaluationBoundary = EVALUATION_BOUNDARIES.has(boundary);
    // Security, admission and decision boundaries keep their weight on a changed gate or oracle.
    const withBoundary = impact.surfaces.filter(
      (surface) =>
        surface.boundaries.includes(boundary) &&
        (PRODUCT_RUNTIME_ROLES.has(surface.role) ||
          (SENSITIVE_BOUNDARIES.has(boundary) &&
            (surface.role === "proof-infrastructure" ||
              (surface.role === "test" && surface.behaviorChange !== "none")))),
    );
    // Evaluation boundaries call for evaluation evidence, whatever role carries them.
    const bySubject = (id: FactId, surfaces: ReadonlyArray<Surface>, what: string) => {
      for (const subject of EVIDENCE_SUBJECTS) {
        add(
          id,
          subject,
          surfaces.filter(
            (surface) =>
              (evaluationBoundary ? "evaluation" : subjectOfRole(surface.role)) === subject,
          ),
          what,
        );
      }
    };
    bySubject(
      `boundary:${boundary}:touched`,
      withBoundary.filter((surface) => surface.reach === "direct"),
      `${boundary} boundary changed`,
    );
    bySubject(
      `boundary:${boundary}:behavior`,
      withBoundary.filter(
        (surface) =>
          surface.behaviorChange !== "none" && (surface.reach === "direct" || !evaluationBoundary),
      ),
      `${boundary} behavior may change`,
    );
    bySubject(
      `boundary:${boundary}:transitive`,
      withBoundary.filter(
        (surface) =>
          surface.reach === "transitive" &&
          (surface.behaviorChange === "none" || evaluationBoundary),
      ),
      `${boundary} boundary reached transitively`,
    );
  }

  add(
    "coverage:missing",
    "product",
    product.filter(
      (surface) =>
        surface.coverage === "untested" ||
        (surface.coverage === "unknown" && surface.behaviorChange !== "none"),
    ),
    "no test covers a changed product surface",
  );
  add(
    "environment:sensitive",
    "product",
    product.filter(
      (surface) =>
        surface.environmentSensitive &&
        surface.behaviorChange !== "none" &&
        (surface.runtime === "offline-analysis" || surface.runtime === "live"),
    ),
    "environment-sensitive behavior may change",
  );
  // Scoped to the runtime surfaces, so that a later proof-only commit keeps the rollback plan.
  const reversibilityScope = directRuntime.length > 0 ? directRuntime : runtime;
  if (impact.reversibility === "costly") {
    add("reversibility:costly", "product", reversibilityScope, "the change is costly to reverse");
  }
  if (impact.reversibility === "irreversible") {
    add("reversibility:irreversible", "product", reversibilityScope, "the change is irreversible");
  }
}

function isProductSignal(signal: SignalName): signal is ProductSignal {
  return (PRODUCT_SIGNALS as readonly string[]).includes(signal);
}

interface SignalOutcome {
  source: ProofSignal;
  classification: SignalClassification;
  facts: PlannerFact[];
}

function observedSameProduct(signal: ProofSignal, impact: ChangeImpact): boolean {
  return (
    signal.baseline === impact.revision.baseline &&
    signal.runtimeTreeDigest !== undefined &&
    signal.runtimeTreeDigest === impact.revision.runtimeTreeDigest
  );
}

/** Evidence about the product, or a failure that may still be about the change. */
export function isUnresolvedSignal(classification: SignalClassification): boolean {
  return (
    classification.classification === "product" ||
    (classification.classification === "unattributed" && classification.exercises !== "no")
  );
}

function otherRevision(signal: ProofSignal, reason: string): SignalClassification {
  return {
    id: signal.id,
    signal: signal.signal,
    classification: "other-revision",
    exercises: signal.exercisesImpactedSurfaces,
    basis: [],
    surfaces: signal.surfaces,
    reason,
  };
}

function observedFact(
  id: FactId,
  subject: EvidenceSubject,
  signal: ProofSignal,
  detail: string,
): PlannerFact {
  return { id, subject, surfaces: signal.surfaces, refs: [signal.id], detail };
}

function classifyProductSignal(
  signal: ProofSignal,
  name: ProductSignal,
  impact: ChangeImpact,
): SignalOutcome {
  const base = {
    id: signal.id,
    signal: name,
    exercises: signal.exercisesImpactedSurfaces,
    basis: [] as AttributionBasis[],
    surfaces: signal.surfaces,
  };
  if (PRE_EXISTING_CAPABLE.has(name) && signal.attribution.includes("REPRODUCES_ON_BASELINE")) {
    return {
      source: signal,
      classification: {
        ...base,
        classification: "pre-existing",
        basis: ["REPRODUCES_ON_BASELINE"],
        reason: "reproduces on the baseline: a product defect this change did not introduce",
      },
      // The reproduction is itself evidence that must exist.
      facts: [
        observedFact(
          "observed:baseline-reproduction",
          "product",
          signal,
          `${name} attributed to the baseline: ${signal.detail}`,
        ),
      ],
    };
  }
  const byId = new Map(impact.surfaces.map((surface) => [surface.id, surface]));
  const declared = signal.surfaces.map((id) => byId.get(id));
  const allDeclared = declared.length > 0 && declared.every((surface) => surface !== undefined);
  if (name === "UNPLANNED_IMPACT" && allDeclared) {
    return {
      source: signal,
      classification: {
        ...base,
        classification: "absorbed",
        reason: "the impact already contains every observed surface",
      },
      facts: [],
    };
  }
  if (
    name === "LIVE_RUNTIME_TOUCHED" &&
    allDeclared &&
    declared.every(
      (surface) =>
        surface?.runtime === "live" &&
        (surface.role === "product" || surface.role === "execution-context"),
    )
  ) {
    return {
      source: signal,
      classification: {
        ...base,
        classification: "absorbed",
        reason: "the impact already declares every observed surface as live runtime",
      },
      facts: [],
    };
  }
  return {
    source: signal,
    classification: {
      ...base,
      classification: "product",
      reason: "new evidence about the product",
    },
    facts: [
      observedFact(SIGNAL_FACTS[name], "product", signal, `${name} observed: ${signal.detail}`),
    ],
  };
}

function classifyInfrastructureSignal(
  signal: ProofSignal,
  input: NormalizedInput,
  bound: ImpactBound,
): SignalOutcome {
  const { impact } = input;
  // Only a changed runtime surface, or a proof surface that exercises one, can make a job fail
  // because of the change. A changed test that exercises nothing changed stays proof evidence.
  const runtimeIds = new Set(
    impact.surfaces
      .filter((surface) => PRODUCT_RUNTIME_ROLES.has(surface.role))
      .map((surface) => surface.id),
  );
  const exercisingChange = new Set([
    ...runtimeIds,
    ...impact.surfaces
      .filter(
        (surface) =>
          (surface.role === "test" || surface.role === "proof-infrastructure") &&
          (surface.exercises === undefined
            ? surface.role === "test" && runtimeIds.size > 0
            : surface.exercises.some((id) => runtimeIds.has(id))),
      )
      .map((surface) => surface.id),
  ]);
  const overlapping = signal.surfaces.filter((surface) => exercisingChange.has(surface));
  const trustsImpact = bound === "bounded-confident" || bound === "no-product-runtime";
  let exercises: "yes" | "no" | "unknown";
  let note = "";
  if (overlapping.length > 0) {
    exercises = "yes";
    if (signal.exercisesImpactedSurfaces === "no") {
      note = "; declared outside the impact but its surfaces exercise the change";
    }
  } else if (signal.exercisesImpactedSurfaces === "no") {
    if (signal.surfaces.length === 0) {
      exercises = "unknown";
      note = "; the failure names no surface to check against the impact";
    } else {
      exercises = trustsImpact ? "no" : "unknown";
      if (!trustsImpact) note = "; the impact is not bounded with confidence";
    }
  } else {
    exercises = signal.exercisesImpactedSurfaces;
  }

  let basis: AttributionBasis[] = [];
  if (exercises === "no") {
    basis = signal.attribution.filter((entry) =>
      input.policy.attribution.admissibleOutsideImpact.includes(entry),
    );
  } else if (signal.attribution.includes("REPRODUCES_ON_BASELINE")) {
    basis = ["REPRODUCES_ON_BASELINE"];
  }
  const base = {
    id: signal.id,
    signal: signal.signal,
    exercises,
    surfaces: signal.surfaces,
  };
  if (basis.length > 0) {
    const facts = [
      observedFact(
        "observed:infrastructure-failure",
        "proof-infrastructure",
        signal,
        `${signal.signal} attributed to the proof infrastructure: ${signal.detail}`,
      ),
    ];
    if (basis.every((entry) => entry === "REPRODUCES_ON_BASELINE")) {
      facts.push(
        observedFact(
          "observed:baseline-reproduction",
          "proof-infrastructure",
          signal,
          `${signal.signal} attributed only by a reproduction on the baseline: ${signal.detail}`,
        ),
      );
    }
    return {
      source: signal,
      classification: {
        ...base,
        classification: "proof-infrastructure",
        basis,
        reason: `new evidence about the proof infrastructure (${basis.join(", ")})${note}`,
      },
      facts,
    };
  }
  return {
    source: signal,
    classification: {
      ...base,
      classification: "unattributed",
      basis: [],
      reason:
        exercises === "no"
          ? `no admissible attribution basis${note}`
          : `the failing job may exercise the change; only REPRODUCES_ON_BASELINE can attribute it${note}`,
    },
    facts: [
      observedFact(
        "observed:unattributed-failure",
        exercises === "no" ? "proof-infrastructure" : "product",
        signal,
        `${signal.signal} not attributed: ${signal.detail}`,
      ),
    ],
  };
}

function computeBound(
  input: NormalizedInput,
  productRuntimeTouched: boolean,
  facts: FactSet,
): { bound: ImpactBound; reasons: string[] } {
  const { impact, claims } = input;
  const { analysis } = impact;
  // Facts about the analysis concern the runtime subjects it reaches, otherwise what changed.
  const analysisSubjects: EvidenceSubject[] = sortedUnique(
    impact.surfaces
      .filter((surface) =>
        productRuntimeTouched
          ? PRODUCT_RUNTIME_ROLES.has(surface.role)
          : surface.reach === "direct",
      )
      .map((surface) => subjectOfRole(surface.role)),
  );
  const addAnalysisFact = (id: FactId, surfaces: Iterable<string>, detail: string) => {
    for (const subject of analysisSubjects) facts.add(id, subject, surfaces, [], detail);
  };
  const highUncertainty = "the impact analysis reports high uncertainty";

  // An incomplete analysis is unbounded whatever it enumerates: the omitted part may be product.
  const unbounded: string[] = [];
  if (facts.has("observed:unknown-dependency"))
    unbounded.push("an unknown dependency was observed");
  if (facts.has("observed:unplanned-impact")) {
    unbounded.push("an impact outside the analysis was observed");
  }
  if (analysis.completeness === "unknown") unbounded.push("analysis completeness is unknown");
  if (analysis.omittedSurfaceCount > 0) {
    unbounded.push(`${analysis.omittedSurfaceCount} impacted surfaces were omitted`);
  }
  if (analysis.unknowns.some((unknown) => unknown.surfaces.length === 0)) {
    unbounded.push("an unknown is not localized to named surfaces");
  }
  if (analysis.completeness === "partial" && analysis.unknowns.length === 0) {
    unbounded.push("the analysis is partial without naming what it misses");
  }
  if (facts.has("execution-context:changed")) {
    unbounded.push("the execution context changed, which static analysis cannot bound");
  }
  const localized = new Set(analysis.unknowns.flatMap((unknown) => unknown.surfaces));
  const sensitive = new Set([
    ...impact.surfaces.filter((surface) => surface.runtime === "live").map((surface) => surface.id),
    ...claims
      .filter((claim) => claim.criticality === "high" || claim.criticality === "critical")
      .flatMap((claim) => claim.surfaces),
  ]);
  if ([...localized].some((surface) => sensitive.has(surface))) {
    unbounded.push("an unknown touches a live surface or a high or critical claim");
  }
  if (unbounded.length > 0) {
    // An unbounded impact may reach the product, whatever was enumerated.
    facts.add("impact:unbounded", "product", [], [], `impact not bounded: ${unbounded.join("; ")}`);
    if (analysis.uncertainty === "high")
      facts.add("uncertainty:high", "product", [], [], highUncertainty);
    return { bound: "unbounded", reasons: unbounded };
  }

  const uncertain: string[] = [];
  if (analysis.method === "declared") uncertain.push("the impact is declared, not derived");
  if (analysis.completeness === "partial") uncertain.push("the analysis is partial");
  if (analysis.uncertainty !== "low")
    uncertain.push(`analysis uncertainty is ${analysis.uncertainty}`);
  if (localized.size > 0) uncertain.push("localized unknowns remain");
  if (uncertain.length === 0) {
    return productRuntimeTouched
      ? { bound: "bounded-confident", reasons: ["static analysis, complete, low uncertainty"] }
      : {
          bound: "no-product-runtime",
          reasons: [
            "no product, execution-context or evaluation surface changed, per a complete static analysis",
          ],
        };
  }
  if (analysis.method === "declared") {
    addAnalysisFact(
      "impact:declared",
      [],
      "the surface list is declared by the caller; surfaces it omits are not bounded",
    );
  }
  if (localized.size > 0) {
    addAnalysisFact(
      "impact:localized-unknowns",
      localized,
      `unknowns localized to ${[...localized].sort(compareOrdinal).join(", ")}`,
    );
  }
  if (analysis.uncertainty === "high") addAnalysisFact("uncertainty:high", [], highUncertainty);
  addAnalysisFact(
    "impact:bounded-uncertain",
    [],
    `impact bounded with uncertainty: ${uncertain.join("; ")}`,
  );
  return { bound: "bounded-uncertain", reasons: uncertain };
}

interface ClaimNote {
  id: string;
  reason: string;
}

function deriveClaimFacts(
  input: NormalizedInput,
  bound: ImpactBound,
  facts: FactSet,
): { unaffected: ClaimNote[]; throughProof: ClaimNote[]; outsideImpact: string[] } {
  const { impact } = input;
  const runtimeById = new Map(
    impact.surfaces
      .filter((surface) => PRODUCT_RUNTIME_ROLES.has(surface.role))
      .map((surface) => [surface.id, surface]),
  );
  // A modified oracle, budget, selection or gate can stop protecting the claims it checks.
  const changedProof = impact.surfaces.filter(
    (surface) =>
      surface.reach === "direct" &&
      (surface.role === "test" || surface.role === "proof-infrastructure") &&
      surface.behaviorChange !== "none",
  );
  const unaffected: ClaimNote[] = [];
  const throughProof: ClaimNote[] = [];
  const outsideImpact: string[] = [];
  const trustsImpact = bound === "bounded-confident" || bound === "no-product-runtime";
  for (const claim of input.claims) {
    const critical = claim.criticality === "high" || claim.criticality === "critical";
    if (claim.kind === "documentation") {
      const stale = claim.surfaces.flatMap((id) => {
        const surface = runtimeById.get(id);
        return surface && surface.behaviorChange !== "none" ? [id] : [];
      });
      if (stale.length > 0) {
        facts.add(
          "claim:documentation",
          "documentation",
          stale,
          [claim.id],
          `documentation claim ${claim.id} describes ${stale.join(", ")}, whose behavior may change`,
        );
      } else {
        unaffected.push({
          id: claim.id,
          reason: "no surface it documents changes behavior within the impact",
        });
      }
      continue;
    }
    const protectors = changedProof.filter(
      (surface) =>
        claim.surfaces.includes(surface.id) ||
        (surface.exercises?.some((id) => claim.surfaces.includes(id)) ?? false),
    );
    if (protectors.length > 0 && critical) {
      facts.add(
        `claim:${claim.criticality === "critical" ? "critical" : "high"}:oracle`,
        "proof-infrastructure",
        ids(protectors),
        [claim.id],
        `claim ${claim.id} (${claim.criticality}) is checked by changed proof surfaces ${ids(protectors).join(", ")}`,
      );
    }
    const inImpact = claim.surfaces.filter((id) => runtimeById.has(id));
    let reach: "direct" | "transitive";
    let surfaces: string[];
    if (inImpact.length > 0) {
      reach = inImpact.some((id) => runtimeById.get(id)?.reach === "direct")
        ? "direct"
        : "transitive";
      surfaces = inImpact;
    } else if (trustsImpact) {
      if (protectors.length > 0) {
        throughProof.push({
          id: claim.id,
          reason: `its runtime surfaces are unchanged; only its proof changed (${ids(protectors).join(", ")})`,
        });
      } else {
        unaffected.push({
          id: claim.id,
          reason: "none of its runtime surfaces is in an impact bounded with confidence",
        });
      }
      continue;
    } else {
      outsideImpact.push(claim.id);
      if (bound === "bounded-uncertain" && claim.kind !== "empirical") {
        // Criticality deepens the proof of what the change reaches; under a bounded but
        // uncertain impact, a claim outside it earns a recommendation, not a floor.
        if (critical) {
          facts.add(
            "claim:outside-impact",
            "product",
            claim.surfaces,
            [claim.id],
            `claim ${claim.id} (${claim.criticality}) lies outside an impact bounded with uncertainty`,
          );
        }
        continue;
      }
      reach = "transitive";
      surfaces = claim.surfaces;
    }
    const detail = `claim ${claim.id} (${claim.criticality}, ${claim.scope}, ${claim.kind}) reached ${reach}ly`;
    // An empirical claim is proved by evaluation evidence; its criticality and scope do not
    // turn into product requirements.
    if (claim.kind === "empirical") {
      facts.add(
        reach === "direct" ? "claim:empirical" : "claim:empirical:transitive",
        "evaluation",
        surfaces,
        [claim.id],
        detail,
      );
      continue;
    }
    for (const subject of ["product", "evaluation"] as const) {
      const scoped = surfaces.filter((id) => {
        const surface = runtimeById.get(id);
        return (surface ? subjectOfRole(surface.role) : "product") === subject;
      });
      if (scoped.length === 0) continue;
      if (claim.criticality === "high" || claim.criticality === "critical") {
        facts.add(`claim:${claim.criticality}:${reach}`, subject, scoped, [claim.id], detail);
      }
      if (reach === "direct" && claim.scope !== "local") {
        facts.add(`claim:scope:${claim.scope}`, subject, scoped, [claim.id], detail);
      }
    }
  }
  return { unaffected, throughProof, outsideImpact };
}

/** Impact surfaces a baseline of `subject` is about: its direct ones and those its facts name. */
function subjectSurfaces(impact: ChangeImpact, facts: FactSet, subject: EvidenceSubject): string[] {
  const named = new Set(
    facts
      .list()
      .filter((fact) => fact.subject === subject)
      .flatMap((fact) => fact.surfaces),
  );
  return impact.surfaces
    .filter(
      (surface) =>
        subjectOfRole(surface.role) === subject &&
        (surface.reach === "direct" || named.has(surface.id)),
    )
    .map((surface) => surface.id);
}

function accumulate(
  target: Map<string, Accumulator>,
  kind: string,
  surfaces: Iterable<string>,
  because: string,
): void {
  const entry = target.get(kind) ?? { surfaces: new Set<string>(), because: new Set<string>() };
  for (const surface of surfaces) entry.surfaces.add(surface);
  entry.because.add(because);
  target.set(kind, entry);
}

function requirementOf(
  spec: EvidenceKindSpec,
  surfaces: Iterable<string>,
  because: Iterable<string>,
): EvidenceRequirement {
  return {
    kind: spec.id,
    title: spec.title,
    weight: spec.weight,
    binding: spec.binding,
    verification: spec.verification,
    subjects: [...spec.subjects],
    semanticDigest: evidenceKindSemanticDigest(spec),
    surfaces: sortedUnique(surfaces),
    because: sortedUnique(because),
  };
}

function materialize(
  entries: ReadonlyMap<string, Accumulator>,
  catalog: ReadonlyArray<EvidenceKindSpec>,
): EvidenceRequirement[] {
  return catalog
    .filter((spec) => entries.has(spec.id))
    .map((spec) => {
      const entry = entries.get(spec.id);
      return requirementOf(spec, entry?.surfaces ?? [], entry?.because ?? []);
    })
    .sort((left, right) => compareOrdinal(left.kind, right.kind));
}

/**
 * Worst case of the declared uncertainty over enumerated surfaces: every transitive runtime surface
 * becomes direct, every "no change" becomes "suspected", every unknown coverage becomes untested.
 * The analysis itself is kept, so the worst case is never more trusting than the actual plan.
 */
function worstCaseInput(input: NormalizedInput): NormalizedInput {
  return {
    ...input,
    impact: {
      ...input.impact,
      surfaces: input.impact.surfaces.map((surface) => {
        if (!PRODUCT_RUNTIME_ROLES.has(surface.role)) return surface;
        return {
          ...surface,
          reach: "direct" as const,
          behaviorChange: surface.behaviorChange === "none" ? "suspected" : surface.behaviorChange,
          coverage: surface.coverage === "unknown" ? "untested" : surface.coverage,
        };
      }),
    },
  };
}

function partitionCatalog(
  input: NormalizedInput,
  core: CoreResult,
): {
  notRequired: NotRequiredEvidence[];
  undetermined: UndeterminedEvidence[];
  worstCaseRecommended: Map<string, Accumulator>;
} {
  const selected = new Set([...core.required.keys(), ...core.recommended.keys()]);
  const worstCaseRecommended = new Map<string, Accumulator>();
  let worst: CoreResult | null = null;
  if (core.bound === "bounded-uncertain") {
    worst = planCore(worstCaseInput(input));
    for (const source of [worst.required, worst.recommended]) {
      for (const [kind, entry] of source) {
        if (selected.has(kind)) continue;
        for (const reason of entry.because) {
          accumulate(worstCaseRecommended, kind, entry.surfaces, `worst-case:${reason}`);
        }
      }
    }
    for (const kind of worstCaseRecommended.keys()) selected.add(kind);
  }
  const evaluatedAgainst: NotRequiredEvidence["evaluatedAgainst"] = worst
    ? "worst-case"
    : "actual-change";
  // Activation values report the stricter of the actual plan and its worst case.
  const levels = new Map<EvidenceSubject, number>();
  for (const subject of EVIDENCE_SUBJECTS) {
    const values = [core.levelBySubject.get(subject), worst?.levelBySubject.get(subject)].filter(
      (value): value is number => value !== undefined,
    );
    if (values.length > 0) levels.set(subject, Math.max(...values));
  }
  const unbounded =
    core.bound === "unbounded"
      ? `the impact is not bounded (${core.boundReasons.join("; ")})`
      : worst?.bound === "unbounded"
        ? `the worst case of the declared uncertainty is not bounded (${worst.boundReasons.join("; ")})`
        : null;

  const notRequired: NotRequiredEvidence[] = [];
  const undetermined: UndeterminedEvidence[] = [];
  for (const spec of input.policy.evidence) {
    if (selected.has(spec.id)) continue;
    const requirement = requirementOf(spec, [], []);
    if (unbounded !== null) {
      undetermined.push({
        requirement,
        rationale: `Undetermined: ${unbounded}, so its absence cannot be justified.`,
      });
      continue;
    }
    const activation = activationOf(spec, input.policy, levels);
    notRequired.push({
      requirement,
      rationale: notRequiredRationale(spec, activation, core, evaluatedAgainst),
      activation,
      evaluatedAgainst,
    });
  }
  const byKind = <T extends { requirement: EvidenceRequirement }>(left: T, right: T) =>
    compareOrdinal(left.requirement.kind, right.requirement.kind);
  return {
    notRequired: notRequired.sort(byKind),
    undetermined: undetermined.sort(byKind),
    worstCaseRecommended,
  };
}

function activationOf(
  spec: EvidenceKindSpec,
  policy: AssurancePolicy,
  levels: ReadonlyMap<EvidenceSubject, number>,
): ActivationCondition {
  const triggers = policy.triggers
    .flatMap((entry) => [
      ...(entry.require.includes(spec.id)
        ? [{ fact: entry.fact, effect: "require" as const }]
        : []),
      ...(entry.recommend.includes(spec.id)
        ? [{ fact: entry.fact, effect: "recommend" as const }]
        : []),
    ])
    .sort((left, right) =>
      compareOrdinal(`${left.fact}|${left.effect}`, `${right.fact}|${right.effect}`),
    );
  const baselines = policy.baselines
    .filter((baseline) => baseline.kind === spec.id)
    .map((baseline) => ({
      level: baseline.level,
      subjects: spec.subjects.map((subject) => {
        const level = levels.get(subject);
        return { subject, level: level === undefined ? null : levelAt(level) };
      }),
    }));
  return { triggers, baselines };
}

function notRequiredRationale(
  spec: EvidenceKindSpec,
  activation: ActivationCondition,
  core: CoreResult,
  evaluatedAgainst: NotRequiredEvidence["evaluatedAgainst"],
): string {
  const conditions: string[] = [];
  if (activation.triggers.length > 0) {
    conditions.push(`one of [${activation.triggers.map((entry) => entry.fact).join(", ")}] holds`);
  }
  for (const baseline of activation.baselines) {
    const current = baseline.subjects
      .map((entry) => `${entry.subject} ${entry.level ?? "absent"}`)
      .join(", ");
    conditions.push(
      `a subject among [${baseline.subjects.map((entry) => entry.subject).join(", ")}] reaches ${baseline.level} (now ${current})`,
    );
  }
  if (conditions.length === 0) return `Not required: no rule of this policy asks for ${spec.id}.`;
  const scope =
    evaluatedAgainst === "worst-case"
      ? "even in the worst case of the declared uncertainty"
      : core.bound === "no-product-runtime"
        ? "for this change, which touches no product, execution-context or evaluation surface"
        : "for this change, whose impact is bounded with confidence";
  return `Not required: the policy asks for ${spec.id} when ${conditions.join(" or ")}; none holds ${scope}.`;
}

function computeEscalations(input: NormalizedInput, core: CoreResult): EscalationCondition[] {
  const directProduct = input.impact.surfaces
    .filter((surface) => surface.reach === "direct" && subjectOfRole(surface.role) === "product")
    .map((surface) => surface.id);
  const directAll = input.impact.surfaces
    .filter((surface) => surface.reach === "direct")
    .map((surface) => surface.id);
  const productSurfaces = directProduct.length > 0 ? directProduct : directAll;
  const rows: EscalationCondition[] = [];
  const hypothetical = (
    signal: SignalName,
    variant: EscalationCondition["variant"],
    surfaces: string[],
    attribution: AttributionBasis[],
  ): EscalationCondition => {
    const synthetic: ProofSignal = {
      id: `${HYPOTHETICAL_PREFIX}${signal}`,
      revision: input.impact.revision.id,
      signal,
      surfaces,
      exercisesImpactedSurfaces: "yes",
      attribution,
      detail: "hypothetical signal used to precompute the escalation",
    };
    const next = planCore({ ...input, signals: [...input.signals, synthetic] });
    const classification =
      next.signals.find((entry) => entry.id === synthetic.id)?.classification ?? "product";
    const label: Record<SignalClassificationName, string> = {
      product: "Evidence about the product",
      "proof-infrastructure": "Evidence about the proof infrastructure",
      unattributed: "Unattributed failure",
      "pre-existing": "Attributed to the baseline",
      absorbed: "Absorbed by the declared impact",
      "other-revision": "Observed on another revision",
    };
    const addsRequired = [...next.required.keys()]
      .filter((kind) => !core.required.has(kind))
      .sort(compareOrdinal);
    const levelChange =
      next.level === core.level ? `stays ${core.level}` : `moves ${core.level} -> ${next.level}`;
    return {
      signal,
      variant,
      classification,
      resultingLevel: next.level,
      resultingStatus: next.status,
      addsRequired,
      rationale: `${label[classification]}: level ${levelChange}, status ${next.status}${addsRequired.length > 0 ? `, adds ${addsRequired.join(", ")}` : ", adds nothing"}.`,
    };
  };
  for (const signal of PRODUCT_SIGNALS) {
    const surfaces =
      signal === "UNPLANNED_IMPACT"
        ? [`${HYPOTHETICAL_PREFIX}unplanned-surface`]
        : signal === "UNKNOWN_DEPENDENCY"
          ? []
          : productSurfaces;
    rows.push(hypothetical(signal, "product", surfaces, []));
  }
  const infrastructure = INFRASTRUCTURE_SIGNALS[0];
  rows.push(
    hypothetical(infrastructure, "infrastructure-attributed", [], ["REPRODUCES_ON_BASELINE"]),
  );
  rows.push(hypothetical(infrastructure, "infrastructure-unattributed", [], []));
  return rows;
}

function computeUncertainty(
  input: NormalizedInput,
  core: CoreResult,
  notRequired: ReadonlyArray<NotRequiredEvidence>,
): Uncertainty[] {
  const entries: Uncertainty[] = [];
  const { impact } = input;
  if (impact.analysis.method === "declared") {
    entries.push({
      id: "impact.declared",
      statement:
        "Surfaces, roles and boundaries are declared by the caller, not derived; exemptions are limited to what holds in the worst case of that declaration.",
      mitigatedBy: [],
    });
  }
  if (core.bound === "unbounded" || core.bound === "bounded-uncertain") {
    entries.push({
      id: `impact.${core.bound}`,
      statement: `Impact ${core.bound}: ${core.boundReasons.join("; ")}.`,
      mitigatedBy: core.bound === "unbounded" ? ["FULL_TEST_SUITE"] : [],
    });
  }
  impact.analysis.unknowns.forEach((unknown, index) => {
    entries.push({
      id: `impact.unknown.${index + 1}`,
      statement: `${unknown.description}${unknown.surfaces.length > 0 ? ` (${unknown.surfaces.join(", ")})` : ""}.`,
      mitigatedBy: unknown.surfaces.length > 0 ? ["TARGETED_REGRESSION"] : ["FULL_TEST_SUITE"],
    });
  });
  const unknownCoverage = impact.surfaces.filter(
    (surface) =>
      surface.role === "product" &&
      surface.reach === "direct" &&
      surface.coverage === "unknown" &&
      surface.behaviorChange === "none",
  );
  if (unknownCoverage.length > 0) {
    entries.push({
      id: "coverage.unknown",
      statement: `Existing coverage of ${ids(unknownCoverage).join(", ")} is unknown; a refactor there is only as safe as the tests that happen to exist.`,
      mitigatedBy: ["AFFECTED_TESTS"],
    });
  }
  if (core.factIds.has("witness:infeasible")) {
    entries.push({
      id: "witness.infeasible",
      statement:
        "The fix has no reproducible witness: the defect is not causally demonstrated, only observed through substitutes.",
      mitigatedBy: ["PRODUCTION_PATH_TEST", "TARGETED_CORPUS"],
    });
  }
  for (const claim of core.claimsOutsideImpact) {
    entries.push({
      id: `claim.${claim}.outside-impact`,
      statement:
        core.bound === "unbounded"
          ? `Claim ${claim} references surfaces outside an unbounded impact; it is treated as transitively reached.`
          : `Claim ${claim} references surfaces outside an impact bounded with uncertainty; a high or critical one earns a recommended invariant check.`,
      mitigatedBy: core.bound === "unbounded" ? ["INVARIANT_CHECK"] : [],
    });
  }
  const unnamed = impact.surfaces.filter(
    (surface) =>
      surface.reach === "direct" &&
      (surface.role === "test" || surface.role === "proof-infrastructure") &&
      surface.behaviorChange !== "none" &&
      surface.exercises === undefined,
  );
  if (unnamed.length > 0) {
    entries.push({
      id: "proof.exercises-unknown",
      statement: `Changed proof surfaces ${ids(unnamed).join(", ")} name no exercised surface; only the claims that list them are known to depend on them.`,
      mitigatedBy: ["GATE_DELTA_REVIEW"],
    });
  }
  if (core.factIds.has("claim:empirical:transitive")) {
    entries.push({
      id: "claim.empirical.transitive",
      statement:
        "An empirical claim depends on changed code; results established before this revision may not hold for it.",
      mitigatedBy: ["BENCHMARK_PROTOCOL"],
    });
  }
  for (const signal of core.signals) {
    if (signal.classification === "unattributed" || signal.classification === "pre-existing") {
      entries.push({
        id: `signal.${signal.id}.${signal.classification}`,
        statement: `${signal.signal} ${signal.id}: ${signal.reason}.`,
        mitigatedBy: ["FAILURE_ATTRIBUTION"],
      });
    }
  }
  const broadExempted = notRequired.filter((entry) => entry.requirement.weight !== "targeted");
  if (core.bound === "bounded-confident" && broadExempted.length > 0) {
    entries.push({
      id: "exemptions.rely-on-impact",
      statement: `${broadExempted.length} broad or ceremonial kinds are not required because the impact analysis bounds the change; an UNPLANNED_IMPACT or UNKNOWN_DEPENDENCY signal reopens them.`,
      mitigatedBy: [],
    });
  }
  return entries.sort((left, right) => compareOrdinal(left.id, right.id));
}
