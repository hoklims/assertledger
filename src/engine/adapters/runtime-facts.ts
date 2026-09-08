// Pure runtime-fact normalizer shared by every in-process official profile (node:test today;
// vitest/jest/bun/pytest are prepared for but not wired in this slice). No filesystem, process,
// network, clock, or candidate-selection logic belongs here.

export const RUNTIME_FACTS_VERSION = "1.0.0" as const;

export type RuntimeOutcome =
  | "PASS"
  | "ASSERTION_FAILURE"
  | "COLLECTION_FAILURE"
  | "COMPILE_FAILURE"
  | "PROCESS_CRASH"
  | "INFRA_ERROR"
  | "NO_TEST_DISCOVERED";

export interface RuntimeFacts {
  factsVersion: typeof RUNTIME_FACTS_VERSION;
  /** False when the report is missing, malformed, or the process reported infrastructure failure. */
  reportValid: boolean;
  hasCandidate: boolean;
  processExitedZero: boolean;
  candidateTestsDiscovered: number;
  nonCandidateFailureCount: number;
  candidateCollectionFailureCount: number;
  candidateCompileFailureCount: number;
  candidateFailureCount: number;
  candidateFailuresAllAssertions: boolean;
}

export interface NormalizedRuntimeOutcome {
  outcome: RuntimeOutcome;
  attributed: boolean;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fail-closed priority: infrastructure/invalid report, collection, compilation,
 * crash/non-assertion/non-candidate, pure candidate assertion, no test discovered, pass.
 * TIMEOUT is engine-authoritative and is never produced here.
 */
export function normalizeRuntimeFacts(facts: RuntimeFacts): NormalizedRuntimeOutcome {
  if (facts.factsVersion !== RUNTIME_FACTS_VERSION) {
    throw new TypeError(`Unsupported runtime facts version: ${facts.factsVersion}`);
  }

  if (!facts.reportValid) return { outcome: "INFRA_ERROR", attributed: false };

  const counts = [
    facts.candidateTestsDiscovered,
    facts.nonCandidateFailureCount,
    facts.candidateCollectionFailureCount,
    facts.candidateCompileFailureCount,
    facts.candidateFailureCount,
  ];
  if (!counts.every(nonNegativeSafeInteger)) {
    return { outcome: "INFRA_ERROR", attributed: false };
  }

  const candidateFailureFacts =
    facts.candidateCollectionFailureCount +
    facts.candidateCompileFailureCount +
    facts.candidateFailureCount;
  if (
    (!facts.hasCandidate && (facts.candidateTestsDiscovered > 0 || candidateFailureFacts > 0)) ||
    (facts.processExitedZero && (candidateFailureFacts > 0 || facts.nonCandidateFailureCount > 0))
  ) {
    return { outcome: "INFRA_ERROR", attributed: false };
  }

  if (!facts.hasCandidate) {
    const controlClean = facts.processExitedZero && facts.nonCandidateFailureCount === 0;
    return { outcome: controlClean ? "PASS" : "PROCESS_CRASH", attributed: false };
  }

  if (facts.candidateTestsDiscovered === 0) {
    if (facts.candidateCollectionFailureCount > 0) {
      return { outcome: "COLLECTION_FAILURE", attributed: false };
    }
    if (facts.candidateCompileFailureCount > 0) {
      return { outcome: "COMPILE_FAILURE", attributed: false };
    }
    const crashLike =
      facts.candidateFailureCount > 0 ||
      facts.nonCandidateFailureCount > 0 ||
      !facts.processExitedZero;
    return { outcome: crashLike ? "PROCESS_CRASH" : "NO_TEST_DISCOVERED", attributed: false };
  }

  if (facts.candidateCollectionFailureCount > 0) {
    return { outcome: "COLLECTION_FAILURE", attributed: false };
  }
  if (facts.candidateCompileFailureCount > 0) {
    return { outcome: "COMPILE_FAILURE", attributed: false };
  }
  if (facts.nonCandidateFailureCount > 0) {
    return { outcome: "PROCESS_CRASH", attributed: false };
  }
  if (facts.candidateFailureCount > 0) {
    const assertionOnly = facts.candidateFailuresAllAssertions;
    return {
      outcome: assertionOnly ? "ASSERTION_FAILURE" : "PROCESS_CRASH",
      attributed: assertionOnly,
    };
  }
  return {
    outcome: facts.processExitedZero ? "PASS" : "PROCESS_CRASH",
    attributed: facts.processExitedZero,
  };
}
