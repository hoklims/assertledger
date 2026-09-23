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
  claimsTreatedTransitive: string[];
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
        .sort((left, right) => compareOrdinal(left.description, right.description)),
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
  for (const signal of signals) {
    if (signal.id.startsWith(HYPOTHETICAL_PREFIX)) {
      throw new ProofPlannerError(
        "PROOF_PLANNER_INPUT_INCONSISTENT",
        `signal id prefix ${HYPOTHETICAL_PREFIX} is reserved`,
      );
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
  const impactIds = new Set(impact.surfaces.map((surface) => surface.id));
  const productRuntimeTouched = impact.surfaces.some((surface) =>
    PRODUCT_RUNTIME_ROLES.has(surface.role),
  );

  deriveSurfaceFacts(impact, productRuntimeTouched, facts);

  // 1. Product signals first: they can reopen the impact bound.
  const current = input.signals.filter((signal) => signal.revision === impact.revision.id);
  const classifications: SignalClassification[] = input.signals
    .filter((signal) => signal.revision !== impact.revision.id)
    .map((signal) => ({
      id: signal.id,
      signal: signal.signal,
      classification: "other-revision" as const,
      exercises: signal.exercisesImpactedSurfaces,
      basis: [],
      reason: `observed on revision ${signal.revision}, not on the planned revision`,
    }));
  for (const signal of current) {
    const name = signal.signal;
    if (!isProductSignal(name)) continue;
    classifications.push(classifyProductSignal(signal, name, impactIds, facts));
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
  for (const claim of claimOutcome.unaffected) {
    rationale.push({
      step: "claim",
      subject: null,
      fact: null,
      level: null,
      detail: `${claim.id}: ${claim.reason}`,
    });
  }

  // 4. Infrastructure signals last, with the final bound.
  for (const signal of current) {
    if (isProductSignal(signal.signal)) continue;
    classifications.push(classifyInfrastructureSignal(signal, input, boundResult.bound, facts));
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
  const blocking = facts.list().filter((fact) => policy.status.block.includes(fact.id));
  const holding = facts.list().filter((fact) => policy.status.hold.includes(fact.id));
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
        : `${status}: ${[...blocking, ...holding].map((fact) => fact.id).join(", ")}`,
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
    claimsTreatedTransitive: claimOutcome.treatedTransitive,
    required,
    recommended,
    rationale,
  };
}

class FactSet {
  private readonly facts = new Map<FactId, PlannerFact>();

  add(
    id: FactId,
    subject: EvidenceSubject,
    surfaces: Iterable<string>,
    refs: Iterable<string>,
    detail: string,
  ): void {
    const existing = this.facts.get(id);
    if (existing) {
      existing.surfaces = sortedUnique([...existing.surfaces, ...surfaces]);
      existing.refs = sortedUnique([...existing.refs, ...refs]);
      if (subject === "product") existing.subject = "product";
      return;
    }
    this.facts.set(id, {
      id,
      subject,
      surfaces: sortedUnique(surfaces),
      refs: sortedUnique(refs),
      detail,
    });
  }

  has(id: FactId): boolean {
    return this.facts.has(id);
  }

  get(id: FactId): PlannerFact | undefined {
    return this.facts.get(id);
  }

  list(): PlannerFact[] {
    return [...this.facts.values()].sort((left, right) => compareOrdinal(left.id, right.id));
  }
}

function ids(surfaces: ReadonlyArray<Surface>): string[] {
  return surfaces.map((surface) => surface.id);
}

function describe(surfaces: ReadonlyArray<Surface>, what: string): string {
  return `${ids(surfaces).join(", ")}: ${what}`;
}

function deriveSurfaceFacts(
  impact: ChangeImpact,
  productRuntimeTouched: boolean,
  facts: FactSet,
): void {
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

  add("documentation:changed", "documentation", directOf("documentation"), "documentation changed");
  if (direct.length > 0 && direct.every((surface) => surface.role === "test")) {
    add("tests:only", "proof-infrastructure", direct, "only tests changed");
  }
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

  const runtimeSurfaces = impact.surfaces.filter((surface) =>
    PRODUCT_RUNTIME_ROLES.has(surface.role),
  );
  for (const boundary of BOUNDARIES) {
    const withBoundary = runtimeSurfaces.filter((surface) => surface.boundaries.includes(boundary));
    const subject = (surfaces: ReadonlyArray<Surface>): EvidenceSubject =>
      surfaces.some((surface) => subjectOfRole(surface.role) === "product")
        ? "product"
        : "evaluation";
    const touched = withBoundary.filter((surface) => surface.reach === "direct");
    add(`boundary:${boundary}:touched`, subject(touched), touched, `${boundary} boundary changed`);
    const behavior = withBoundary.filter(
      (surface) =>
        surface.behaviorChange !== "none" &&
        (surface.reach === "direct" || !EVALUATION_BOUNDARIES.has(boundary)),
    );
    add(
      `boundary:${boundary}:behavior`,
      subject(behavior),
      behavior,
      `${boundary} behavior may change`,
    );
    const transitive = withBoundary.filter(
      (surface) => surface.reach === "transitive" && surface.behaviorChange === "none",
    );
    add(
      `boundary:${boundary}:transitive`,
      subject(transitive),
      transitive,
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
  if (productRuntimeTouched && impact.reversibility === "costly") {
    facts.add("reversibility:costly", "product", [], [], "the change is costly to reverse");
  }
  if (productRuntimeTouched && impact.reversibility === "irreversible") {
    facts.add("reversibility:irreversible", "product", [], [], "the change is irreversible");
  }
}

function isProductSignal(signal: SignalName): signal is ProductSignal {
  return (PRODUCT_SIGNALS as readonly string[]).includes(signal);
}

function classifyProductSignal(
  signal: ProofSignal,
  name: ProductSignal,
  impactIds: ReadonlySet<string>,
  facts: FactSet,
): SignalClassification {
  const base = {
    id: signal.id,
    signal: name,
    exercises: signal.exercisesImpactedSurfaces,
    basis: [] as AttributionBasis[],
  };
  if (PRE_EXISTING_CAPABLE.has(name) && signal.attribution.includes("REPRODUCES_ON_BASELINE")) {
    return {
      ...base,
      classification: "pre-existing",
      basis: ["REPRODUCES_ON_BASELINE"],
      reason: "reproduces on the baseline: a product defect this change did not introduce",
    };
  }
  if (
    name === "UNPLANNED_IMPACT" &&
    signal.surfaces.length > 0 &&
    signal.surfaces.every((surface) => impactIds.has(surface))
  ) {
    return {
      ...base,
      classification: "absorbed",
      reason: "the impact already contains every observed surface",
    };
  }
  facts.add(
    SIGNAL_FACTS[name],
    "product",
    signal.surfaces,
    [signal.id],
    `${name} observed: ${signal.detail}`,
  );
  return { ...base, classification: "product", reason: "new evidence about the product" };
}

function classifyInfrastructureSignal(
  signal: ProofSignal,
  input: NormalizedInput,
  bound: ImpactBound,
  facts: FactSet,
): SignalClassification {
  const impactIds = new Set(input.impact.surfaces.map((surface) => surface.id));
  const overlapping = signal.surfaces.filter((surface) => impactIds.has(surface));
  const trustsImpact = bound === "bounded-confident" || bound === "no-product-runtime";
  let exercises: "yes" | "no" | "unknown";
  let note = "";
  if (overlapping.length > 0) {
    exercises = "yes";
    if (signal.exercisesImpactedSurfaces === "no") {
      note = "; declared outside the impact but its surfaces intersect it";
    }
  } else if (signal.exercisesImpactedSurfaces === "no") {
    exercises = trustsImpact ? "no" : "unknown";
    if (!trustsImpact) note = "; the impact is not bounded with confidence";
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
  if (basis.length > 0) {
    facts.add(
      "observed:infrastructure-failure",
      "proof-infrastructure",
      signal.surfaces,
      [signal.id],
      `${signal.signal} attributed to the proof infrastructure: ${signal.detail}`,
    );
    return {
      id: signal.id,
      signal: signal.signal,
      classification: "proof-infrastructure",
      exercises,
      basis,
      reason: `new evidence about the proof infrastructure (${basis.join(", ")})${note}`,
    };
  }
  facts.add(
    "observed:unattributed-failure",
    exercises === "no" ? "proof-infrastructure" : "product",
    signal.surfaces,
    [signal.id],
    `${signal.signal} not attributed: ${signal.detail}`,
  );
  return {
    id: signal.id,
    signal: signal.signal,
    classification: "unattributed",
    exercises,
    basis: [],
    reason:
      exercises === "no"
        ? `no admissible attribution basis${note}`
        : `the failing job may exercise the change; only REPRODUCES_ON_BASELINE can attribute it${note}`,
  };
}

function computeBound(
  input: NormalizedInput,
  productRuntimeTouched: boolean,
  facts: FactSet,
): { bound: ImpactBound; reasons: string[] } {
  const { impact, claims } = input;
  const { analysis } = impact;
  const unbounded: string[] = [];
  if (facts.has("observed:unknown-dependency"))
    unbounded.push("an unknown dependency was observed");
  if (facts.has("observed:unplanned-impact")) {
    unbounded.push("an impact outside the analysis was observed");
  }
  if (!productRuntimeTouched && unbounded.length === 0) {
    return {
      bound: "no-product-runtime",
      reasons: ["no product, execution-context or evaluation surface changed"],
    };
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
    facts.add("impact:unbounded", "product", [], [], `impact not bounded: ${unbounded.join("; ")}`);
    if (analysis.uncertainty === "high") {
      facts.add(
        "uncertainty:high",
        "product",
        [],
        [],
        "the impact analysis reports high uncertainty",
      );
    }
    return { bound: "unbounded", reasons: unbounded };
  }

  const uncertain: string[] = [];
  if (analysis.method === "declared") {
    uncertain.push("the impact is declared, not derived");
    facts.add(
      "impact:declared",
      "product",
      [],
      [],
      "the surface list is declared by the caller; surfaces it omits are not bounded",
    );
  }
  if (analysis.completeness === "partial") uncertain.push("the analysis is partial");
  if (analysis.uncertainty !== "low")
    uncertain.push(`analysis uncertainty is ${analysis.uncertainty}`);
  if (localized.size > 0) {
    uncertain.push("localized unknowns remain");
    facts.add(
      "impact:localized-unknowns",
      "product",
      localized,
      [],
      `unknowns localized to ${[...localized].sort(compareOrdinal).join(", ")}`,
    );
  }
  if (analysis.uncertainty === "high") {
    facts.add(
      "uncertainty:high",
      "product",
      [],
      [],
      "the impact analysis reports high uncertainty",
    );
  }
  if (uncertain.length > 0) {
    facts.add(
      "impact:bounded-uncertain",
      "product",
      [],
      [],
      `impact bounded with uncertainty: ${uncertain.join("; ")}`,
    );
    return { bound: "bounded-uncertain", reasons: uncertain };
  }
  return { bound: "bounded-confident", reasons: ["static analysis, complete, low uncertainty"] };
}

function deriveClaimFacts(
  input: NormalizedInput,
  bound: ImpactBound,
  facts: FactSet,
): { unaffected: { id: string; reason: string }[]; treatedTransitive: string[] } {
  const reachById = new Map(input.impact.surfaces.map((surface) => [surface.id, surface.reach]));
  const unaffected: { id: string; reason: string }[] = [];
  const treatedTransitive: string[] = [];
  const trustsImpact = bound === "bounded-confident" || bound === "no-product-runtime";
  for (const claim of input.claims) {
    if (claim.kind === "documentation") {
      unaffected.push({
        id: claim.id,
        reason: "documentation claims are covered by the documentation check",
      });
      continue;
    }
    const inImpact = claim.surfaces.filter((surface) => reachById.has(surface));
    let reach: "direct" | "transitive";
    let surfaces = inImpact;
    if (inImpact.length === 0) {
      if (trustsImpact) {
        unaffected.push({
          id: claim.id,
          reason: "none of its surfaces is in an impact bounded with confidence",
        });
        continue;
      }
      reach = "transitive";
      surfaces = claim.surfaces;
      treatedTransitive.push(claim.id);
    } else {
      reach = inImpact.some((surface) => reachById.get(surface) === "direct")
        ? "direct"
        : "transitive";
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
    if (claim.criticality === "high" || claim.criticality === "critical") {
      facts.add(`claim:${claim.criticality}:${reach}`, "product", surfaces, [claim.id], detail);
    }
    if (reach === "direct" && claim.scope !== "local") {
      facts.add(`claim:scope:${claim.scope}`, "product", surfaces, [claim.id], detail);
    }
  }
  return { unaffected, treatedTransitive };
}

function subjectSurfaces(impact: ChangeImpact, facts: FactSet, subject: EvidenceSubject): string[] {
  return sortedUnique([
    ...impact.surfaces
      .filter((surface) => surface.reach === "direct" && subjectOfRole(surface.role) === subject)
      .map((surface) => surface.id),
    ...facts
      .list()
      .filter((fact) => fact.subject === subject)
      .flatMap((fact) => fact.surfaces),
  ]);
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
      analysis: {
        method: "static-graph",
        completeness: "complete",
        uncertainty: "low",
        unknowns: [],
        omittedSurfaceCount: 0,
      },
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
  let evaluation: CoreResult = core;
  let evaluatedAgainst: NotRequiredEvidence["evaluatedAgainst"] = "actual-change";
  if (core.bound === "bounded-uncertain") {
    const worst = planCore(worstCaseInput(input));
    for (const source of [worst.required, worst.recommended]) {
      for (const [kind, entry] of source) {
        if (selected.has(kind)) continue;
        for (const reason of entry.because) {
          accumulate(worstCaseRecommended, kind, entry.surfaces, `worst-case:${reason}`);
        }
      }
    }
    for (const kind of worstCaseRecommended.keys()) selected.add(kind);
    evaluation = worst;
    evaluatedAgainst = "worst-case";
  }

  const notRequired: NotRequiredEvidence[] = [];
  const undetermined: UndeterminedEvidence[] = [];
  for (const spec of input.policy.evidence) {
    if (selected.has(spec.id)) continue;
    const requirement = requirementOf(spec, [], []);
    if (core.bound === "unbounded") {
      undetermined.push({
        requirement,
        rationale: `Undetermined: the impact is not bounded (${core.boundReasons.join("; ")}), so its absence cannot be justified.`,
      });
      continue;
    }
    const activation = activationOf(spec, input.policy, evaluation);
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
  evaluation: CoreResult,
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
        const level = evaluation.levelBySubject.get(subject);
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
      rationale: `${classification === "proof-infrastructure" ? "Evidence about the proof infrastructure" : classification === "unattributed" ? "Unattributed failure" : "Evidence about the product"}: level ${levelChange}, status ${next.status}${addsRequired.length > 0 ? `, adds ${addsRequired.join(", ")}` : ", adds nothing"}.`,
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
  for (const claim of core.claimsTreatedTransitive) {
    entries.push({
      id: `claim.${claim}.outside-impact`,
      statement: `Claim ${claim} references surfaces outside an impact that is not bounded with confidence; it is treated as transitively reached.`,
      mitigatedBy: [],
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
        mitigatedBy: signal.classification === "unattributed" ? ["FAILURE_ATTRIBUTION"] : [],
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
