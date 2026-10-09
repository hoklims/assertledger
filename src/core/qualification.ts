import {
  parseQualificationPlan,
  QualificationObservationSchema,
  QualificationProvenanceSchema,
  QualificationReceiptSchema,
  type QualificationObservation,
  type QualificationPlan,
  type QualificationReceipt,
  type QualificationReplayResult,
} from "../contracts/qualification.js";
import { canonicalize, sha256Canonical } from "./index.js";

export function sealQualificationPlan(value: unknown): {
  plan: QualificationPlan;
  planDigest: string;
} {
  const plan = parseQualificationPlan(value);
  return { plan, planDigest: sha256Canonical(plan) };
}

export function qualificationBinding(
  planDigest: string,
  candidateDigest: string,
  worldId: string,
  attempt: number,
  actionId: string,
): string {
  return sha256Canonical({
    schemaVersion: "1.0.0",
    planDigest,
    candidateDigest,
    worldId,
    attempt,
    actionId,
  });
}

function fieldValue(facts: QualificationObservation["facts"], field: string): unknown {
  if (Object.hasOwn(facts, field)) return facts[field];
  let current: unknown = facts;
  for (const part of field.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matches(actual: unknown, expected: unknown): boolean {
  return actual !== undefined && canonicalize(actual) === canonicalize(expected);
}

function observationIssues(
  plan: QualificationPlan,
  planDigest: string,
  candidateDigest: string,
  observations: QualificationObservation[],
): string[] {
  const issues: string[] = [];
  const expected = new Set<string>();
  for (const world of plan.worlds)
    for (let attempt = 1; attempt <= plan.requiredAttempts; attempt++)
      for (const action of plan.actions) expected.add(`${world.id}/${attempt}/${action.id}`);
  const seen = new Set<string>();
  for (const observation of observations) {
    const key = `${observation.worldId}/${observation.attempt}/${observation.actionId}`;
    if (!expected.has(key)) issues.push(`UNEXPECTED_OBSERVATION:${key}`);
    if (seen.has(key)) issues.push(`DUPLICATE_OBSERVATION:${key}`);
    seen.add(key);
    const action = plan.actions.find((item) => item.id === observation.actionId);
    if (
      observation.state === "COMPLETED" &&
      (action?.adapter === "node-test" || action?.adapter === "bun-native")
    ) {
      const { testOutcome, exitCode } = observation.facts;
      if (
        (testOutcome !== "PASS" && testOutcome !== "ASSERTION_FAILURE") ||
        (testOutcome === "PASS" && exitCode !== 0) ||
        (testOutcome === "ASSERTION_FAILURE" &&
          (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode <= 0))
      )
        issues.push(`CONTRADICTORY_TEST_FACTS:${key}`);
    }
    if (
      observation.bindingDigest !==
      qualificationBinding(
        planDigest,
        candidateDigest,
        observation.worldId,
        observation.attempt,
        observation.actionId,
      )
    )
      issues.push(`INVALID_BINDING:${key}`);
  }
  for (const key of expected) if (!seen.has(key)) issues.push(`MISSING_OBSERVATION:${key}`);
  return issues;
}

export type CreateQualificationReceiptInput = Pick<
  QualificationReceipt,
  "plan" | "planDigest" | "candidateDigest" | "observations" | "provenance" | "externalCi"
>;

export function createQualificationReceipt(
  input: CreateQualificationReceiptInput,
): QualificationReceipt {
  const plan = parseQualificationPlan(input.plan);
  if (sha256Canonical(plan) !== input.planDigest)
    throw new Error("Qualification plan digest mismatch");
  if (input.candidateDigest !== plan.subject.candidateDigest)
    throw new Error("Qualification candidate digest mismatch");
  const observations = input.observations.map((observation) =>
    QualificationObservationSchema.parse(observation),
  );
  const provenance = QualificationProvenanceSchema.parse(input.provenance);
  const globalIssues = observationIssues(
    plan,
    input.planDigest,
    input.candidateDigest,
    observations,
  );
  const missingAdapterVersions = plan.actions.filter(
    (action) => !Object.hasOwn(provenance.adapterVersions, action.adapter),
  );
  for (const action of missingAdapterVersions)
    globalIssues.push(`MISSING_ADAPTER_VERSION:${action.adapter}`);
  const assessments: QualificationReceipt["assessments"] = plan.obligations.map((obligation) => {
    const reasons: string[] = [...globalIssues];
    for (const suite of plan.suites) {
      if (!plan.obligations.some((item) => item.suiteIds.includes(suite.id)))
        reasons.push(`UNASSIGNED_SUITE:${suite.id}`);
    }
    const mismatches = new Set<string>();
    let rejected = globalIssues.length > 0;
    for (const suiteId of obligation.suiteIds) {
      const suite = plan.suites.find((item) => item.id === suiteId);
      if (suite?.extraction !== "COMPLETE" || suite.files.length === 0)
        reasons.push(`SUITE_NOT_EXTRACTED:${suiteId}`);
    }
    if (obligation.kind === "ci-live") reasons.push("LIVE_CI_INDEPENDENT_ADMISSION_UNAVAILABLE");
    const targets = plan.worlds.filter(
      (world) =>
        world.kind === "TARGET" &&
        world.discriminants.some((item) => item.obligationId === obligation.id),
    );
    if (targets.length === 0) reasons.push("MISSING_TARGET_DISCRIMINANT");
    for (const world of plan.worlds) {
      if (world.kind === "TARGET" && !targets.some((target) => target.id === world.id)) continue;
      const discriminant = world.discriminants.find((item) => item.obligationId === obligation.id);
      const signatures: string[] = [];
      for (let attempt = 1; attempt <= plan.requiredAttempts; attempt++) {
        const failed = new Set<string>();
        const checkedValues: unknown[] = [];
        let operational = false;
        for (const check of obligation.checks) {
          const observation = observations.find(
            (item) =>
              item.worldId === world.id &&
              item.attempt === attempt &&
              item.actionId === check.actionId,
          );
          const action = plan.actions.find((item) => item.id === check.actionId);
          if (!observation) {
            operational = true;
            continue;
          }
          const testsRequired =
            action?.adapter === "node-test" ||
            action?.adapter === "bun-native" ||
            obligation.kind === "tests";
          if (
            observation.state !== "COMPLETED" ||
            (testsRequired &&
              (typeof observation.facts.testsDiscovered !== "number" ||
                observation.facts.testsDiscovered <= 0)) ||
            [
              "COLLECTION_FAILURE",
              "COMPILE_FAILURE",
              "PROCESS_CRASH",
              "TIMEOUT",
              "INFRA_ERROR",
              "NO_TEST_DISCOVERED",
            ].includes(String(observation.facts.testOutcome))
          ) {
            operational = true;
            reasons.push(`OPERATIONAL_FAILURE:${world.id}:${attempt}:${check.actionId}`);
          }
          const actual = fieldValue(observation.facts, check.field);
          checkedValues.push(actual === undefined ? { absent: check.field } : actual);
          if (actual === undefined) {
            operational = true;
            reasons.push(`MISSING_FACT:${world.id}:${attempt}:${check.id}`);
          }
          if (!matches(actual, check.expected)) {
            failed.add(check.id);
            mismatches.add(check.id);
          }
        }
        signatures.push(canonicalize({ operational, checkedValues }));
        if (operational) continue;
        if (world.kind !== "TARGET" && failed.size > 0) {
          rejected = true;
          reasons.push(`BASELINE_MISMATCH:${world.id}:${attempt}`);
        }
        if (world.kind === "TARGET") {
          const discriminating = discriminant?.checkIds.some((id) => failed.has(id));
          if (!discriminating) reasons.push(`FAULT_NOT_DETECTED:${world.id}:${attempt}`);
          if ([...failed].some((id) => !discriminant?.checkIds.includes(id)))
            reasons.push(`UNDECLARED_MISMATCH:${world.id}:${attempt}`);
        }
      }
      if (new Set(signatures).size !== 1) reasons.push(`UNSTABLE_OBSERVATIONS:${world.id}`);
    }
    return {
      obligationId: obligation.id,
      kind: obligation.kind,
      required: obligation.required,
      status: rejected ? "REJECTED" : reasons.length > 0 ? "OPEN" : "COVERED",
      reasons: [...new Set(reasons)].sort(),
      mismatchCheckIds: [...mismatches].sort(),
    };
  });
  const coveredGuaranteeIds = assessments
    .filter((item) => item.status === "COVERED")
    .map((item) => item.obligationId);
  const openGuaranteeIds = assessments
    .filter((item) => item.status !== "COVERED")
    .map((item) => item.obligationId);
  const required = assessments.filter((item) => item.required);
  const decision =
    globalIssues.length > 0 || required.some((item) => item.status === "REJECTED")
      ? "REJECTED"
      : required.some((item) => item.status !== "COVERED")
        ? "OPEN"
        : "QUALIFIED";
  const decisionProjection = {
    planDigest: input.planDigest,
    candidateDigest: input.candidateDigest,
    assessments,
    coveredGuaranteeIds,
    openGuaranteeIds,
    decision,
  };
  const artifact = {
    schemaVersion: "1.0.0" as const,
    plan,
    ...decisionProjection,
    observations,
    provenance,
    externalCi: input.externalCi,
    decisionDigest: sha256Canonical(decisionProjection),
  };
  return QualificationReceiptSchema.parse({
    ...artifact,
    artifactDigest: sha256Canonical(artifact),
  });
}

export type QualificationExpectedDomain = {
  planDigest: string;
  candidateDigest: string;
  inputDigest: string;
  commit: string;
  baseCommit: string;
};

export function replayQualificationReceipt(
  value: unknown,
  expectedDomain?: QualificationExpectedDomain,
): QualificationReplayResult {
  const result: QualificationReplayResult = {
    valid: false,
    integrityValid: false,
    semanticsValid: false,
    domainValid: false,
    reexecuted: false,
    producerAuthenticated: false,
  };
  try {
    const receipt = QualificationReceiptSchema.parse(value);
    const { artifactDigest, ...artifact } = receipt;
    const {
      assessments,
      coveredGuaranteeIds,
      openGuaranteeIds,
      decision,
      planDigest,
      candidateDigest,
    } = receipt;
    result.integrityValid =
      artifactDigest === sha256Canonical(artifact) &&
      receipt.decisionDigest ===
        sha256Canonical({
          planDigest,
          candidateDigest,
          assessments,
          coveredGuaranteeIds,
          openGuaranteeIds,
          decision,
        });
    const computed = createQualificationReceipt(receipt);
    result.semanticsValid =
      observationIssues(receipt.plan, planDigest, candidateDigest, receipt.observations).length ===
        0 && canonicalize(computed) === canonicalize(receipt);
    result.domainValid =
      expectedDomain === undefined ||
      (expectedDomain.planDigest === planDigest &&
        expectedDomain.candidateDigest === candidateDigest &&
        expectedDomain.inputDigest === receipt.plan.subject.inputDigest &&
        expectedDomain.commit === receipt.plan.subject.commit &&
        expectedDomain.baseCommit === receipt.plan.subject.baseCommit);
    result.valid = result.integrityValid && result.semanticsValid && result.domainValid;
  } catch {
    /* Strict parsing or recomputation failure is a failed replay. */
  }
  return result;
}
