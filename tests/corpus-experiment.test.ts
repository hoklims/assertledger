import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
  AgenticCorpusAllocationCommitment,
  AgenticCorpusAllocationReveal,
  AgenticCorpusExperimentPlan,
  AgenticCorpusExperimentRequest,
  ObservationOutcome,
} from "../src/contracts/index.js";
import {
  parseAgenticCorpusAllocationRequest,
  parseAgenticCorpusTrustPolicy,
} from "../src/contracts/index.js";
import {
  agenticCorpusAllocationCommitmentDigest,
  agenticCorpusAllocationCommitmentSigningBytes,
  agenticCorpusAllocationFinalSeedDigest,
  agenticCorpusAllocationRevealDigest,
  agenticCorpusAllocationShareCommitmentDigest,
  agenticCorpusExperimentArtifactDigest,
  agenticCorpusExperimentCommandDigest,
  agenticCorpusExperimentPlanDigest,
  agenticCorpusExperimentSelectedSuiteDigest,
  canonicalize,
  createAgenticCorpusAllocation,
  createAgenticCorpusExperimentArtifact,
  replayAgenticCorpusExperimentPlan,
  sha256Canonical,
} from "../src/core/index.js";
import {
  agenticCorpusProvenanceDigest,
  agenticCorpusProvenanceSigningBytes,
  agenticCorpusTrustPolicyDigest,
} from "../src/evaluation/agentic-corpus.js";
import { createTestForgeServer } from "../src/mcp/index.js";
import { runCli } from "../src/cli.js";
import { TestForge } from "../src/sdk/index.js";

const SOURCE_IDENTITY_DIGEST = `sha256:${"c".repeat(64)}`;
const SOURCE_B_IDENTITY_DIGEST = `sha256:${"2".repeat(64)}`;
const SOURCE_REVISION = `sha256:${"d".repeat(64)}`;
const DIGEST = (character: string) => `sha256:${character.repeat(64)}`;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function rawDigest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalBytes(value: unknown): Uint8Array {
  return bytes(`${canonicalize(value)}\n`);
}

function trustFixture() {
  const author = generateKeyPairSync("ed25519");
  const reviewer = generateKeyPairSync("ed25519");
  const record = (pair: typeof author, subjectId: string, role: "AUTHOR" | "REVIEWER") => {
    const der = pair.publicKey.export({ format: "der", type: "spki" });
    return {
      keyId: `sha256:${createHash("sha256").update(der).digest("hex")}`,
      subjectId,
      roles: [role],
      publicKey: {
        algorithm: "Ed25519" as const,
        format: "SPKI_DER_BASE64URL" as const,
        data: der.toString("base64url"),
      },
    };
  };
  const authorRecord = record(author, "synthetic-author", "AUTHOR");
  const reviewerRecord = record(reviewer, "synthetic-reviewer", "REVIEWER");
  const unsigned = {
    schemaVersion: "1.0.0" as const,
    policyId: "synthetic-h3-policy",
    keys: [authorRecord, reviewerRecord],
    sources: [
      {
        sourceId: "synthetic-source",
        sourceIdentityDigest: SOURCE_IDENTITY_DIGEST,
        authorizedAuthorSubjectIds: [authorRecord.subjectId],
        authorizedReviewerSubjectIds: [reviewerRecord.subjectId],
      },
      {
        sourceId: "synthetic-source-b",
        sourceIdentityDigest: SOURCE_B_IDENTITY_DIGEST,
        authorizedAuthorSubjectIds: [authorRecord.subjectId],
        authorizedReviewerSubjectIds: [reviewerRecord.subjectId],
      },
    ],
  };
  return {
    author,
    reviewer,
    authorRecord,
    reviewerRecord,
    policy: { ...unsigned, policyDigest: agenticCorpusTrustPolicyDigest(unsigned) },
  };
}

type Trust = ReturnType<typeof trustFixture>;

function sealCase(caseDocument: Record<string, unknown>, trust: Trust) {
  const sourceIdentityDigest =
    caseDocument.sourceId === "synthetic-source"
      ? SOURCE_IDENTITY_DIGEST
      : SOURCE_B_IDENTITY_DIGEST;
  const execution = {
    status: "EXECUTED" as const,
    protocolId: "synthetic-source-replay",
    evidenceDigests: [DIGEST("e")],
    receiptDigest: sha256Canonical({
      protocolId: "synthetic-source-replay",
      evidenceDigests: [DIGEST("e")],
    }),
  };
  const unsigned = {
    schemaVersion: "1.0.0" as const,
    domain: "TESTFORGE_AGENTIC_CORPUS_CASE_V1" as const,
    trustPolicyDigest: trust.policy.policyDigest,
    caseId: String(caseDocument.caseId),
    caseDigest: sha256Canonical(caseDocument),
    source: {
      sourceId: String(caseDocument.sourceId),
      sourceRevision: SOURCE_REVISION,
      sourceIdentityDigest,
    },
    execution,
    author: { keyId: trust.authorRecord.keyId, signature: "AA" },
    reviewer: { keyId: trust.reviewerRecord.keyId, signature: "AA" },
    provenanceDigest: DIGEST("0"),
  };
  const signingBytes = agenticCorpusProvenanceSigningBytes(unsigned);
  const signed = {
    ...unsigned,
    author: {
      ...unsigned.author,
      signature: sign(null, signingBytes, trust.author.privateKey).toString("base64url"),
    },
    reviewer: {
      ...unsigned.reviewer,
      signature: sign(null, signingBytes, trust.reviewer.privateKey).toString("base64url"),
    },
  };
  return { ...signed, provenanceDigest: agenticCorpusProvenanceDigest(signed) };
}

type FixtureOptions = {
  firstBaselineOutcome?: ObservationOutcome;
  contradictoryBaseline?: boolean;
  commandSuffix?: string;
  oversizedOutput?: boolean;
  profileDetects?: boolean;
  baselineDetectedCaseIds?: string[];
  profileDetectedCaseIds?: string[];
  baselineDetectedSourceIdentityDigests?: string[];
  profileDetectedSourceIdentityDigests?: string[];
  firstBaselineProcess?: { exitCode: number | null; timedOut: boolean };
};

function fixture(options: FixtureOptions = {}) {
  const trust = trustFixture();
  const caseDocuments = [
    "synthetic-a",
    "synthetic-b",
    "synthetic-c",
    "synthetic-d",
    "synthetic-e",
    "synthetic-f",
    "synthetic-g",
    "synthetic-h",
  ].map((caseId, index) => ({
    schemaVersion: "1.0.0" as const,
    caseId,
    sourceId: index < 4 ? "synthetic-source" : "synthetic-source-b",
    sourceRevision: SOURCE_REVISION,
  }));
  const provenances = caseDocuments.map((item) => sealCase(item, trust));
  const caseSet = caseDocuments.map((item, index) => ({
    caseId: item.caseId,
    caseDigest: sha256Canonical(item),
    provenanceDigest: provenances[index]?.provenanceDigest as string,
    sourceId: item.sourceId,
    sourceIdentityDigest:
      item.sourceId === "synthetic-source" ? SOURCE_IDENTITY_DIGEST : SOURCE_B_IDENTITY_DIGEST,
  }));
  const authorSecret = Buffer.alloc(32, 1).toString("base64url");
  const reviewerSecret = Buffer.alloc(32, 2).toString("base64url");
  const unsignedCommitment = {
    schemaVersion: "1.0.0" as const,
    commitmentVersion: "1.0.0" as const,
    commitmentId: "synthetic-two-party-commitment",
    allocationId: "synthetic-private-allocation",
    trustPolicyDigest: trust.policy.policyDigest,
    caseSet,
    strata: [
      {
        sourceId: "synthetic-source",
        sourceIdentityDigest: SOURCE_IDENTITY_DIGEST,
        calibrationCount: 2,
      },
      {
        sourceId: "synthetic-source-b",
        sourceIdentityDigest: SOURCE_B_IDENTITY_DIGEST,
        calibrationCount: 2,
      },
    ],
    signers: [
      {
        keyId: trust.authorRecord.keyId,
        role: "AUTHOR" as const,
        shareCommitmentDigest: agenticCorpusAllocationShareCommitmentDigest(
          trust.authorRecord.keyId,
          authorSecret,
        ),
        signature: "AA",
      },
      {
        keyId: trust.reviewerRecord.keyId,
        role: "REVIEWER" as const,
        shareCommitmentDigest: agenticCorpusAllocationShareCommitmentDigest(
          trust.reviewerRecord.keyId,
          reviewerSecret,
        ),
        signature: "AA",
      },
    ] as AgenticCorpusAllocationCommitment["signers"],
    commitmentDigest: DIGEST("0"),
  };
  const commitmentSigningBytes = agenticCorpusAllocationCommitmentSigningBytes(unsignedCommitment);
  const signedCommitment = {
    ...unsignedCommitment,
    signers: [
      {
        ...unsignedCommitment.signers[0],
        signature: sign(null, commitmentSigningBytes, trust.author.privateKey).toString(
          "base64url",
        ),
      },
      {
        ...unsignedCommitment.signers[1],
        signature: sign(null, commitmentSigningBytes, trust.reviewer.privateKey).toString(
          "base64url",
        ),
      },
    ] as AgenticCorpusAllocationCommitment["signers"],
  };
  const commitment: AgenticCorpusAllocationCommitment = {
    ...signedCommitment,
    commitmentDigest: agenticCorpusAllocationCommitmentDigest(signedCommitment),
  };
  const unsignedReveal = {
    schemaVersion: "1.0.0" as const,
    revealVersion: "1.0.0" as const,
    commitmentDigest: commitment.commitmentDigest,
    shares: [
      { keyId: trust.authorRecord.keyId, secret: authorSecret },
      { keyId: trust.reviewerRecord.keyId, secret: reviewerSecret },
    ] as AgenticCorpusAllocationReveal["shares"],
  };
  const reveal = {
    ...unsignedReveal,
    revealDigest: agenticCorpusAllocationRevealDigest(unsignedReveal),
  };
  const allocation = createAgenticCorpusAllocation({
    schemaVersion: "1.0.0",
    allocationId: commitment.allocationId,
    seedDigest: agenticCorpusAllocationFinalSeedDigest(reveal),
    strata: commitment.strata.map((stratum) => ({
      ...stratum,
      caseIds: caseSet
        .filter((item) => item.sourceId === stratum.sourceId)
        .map((item) => item.caseId),
    })),
  });
  const subjectByCase = new Map(
    caseDocuments.map((item, index) => [item.caseId, { item, provenance: provenances[index] }]),
  );
  const subjects = allocation.holdoutCaseIds.map((caseId) => {
    const source = subjectByCase.get(caseId);
    assert.ok(source?.provenance);
    return {
      caseId,
      caseDigest: sha256Canonical(source.item),
      provenanceDigest: source.provenance.provenanceDigest,
      sourceId: String(source.item.sourceId),
      sourceIdentityDigest:
        source.item.sourceId === "synthetic-source"
          ? SOURCE_IDENTITY_DIGEST
          : SOURCE_B_IDENTITY_DIGEST,
      buggyRevisionDigest: DIGEST("4"),
      fixedRevisionDigest: DIGEST("5"),
      reconstructionDigest: DIGEST("6"),
      requiredSuiteDigest: DIGEST("7"),
      qualificationReceiptDigest: DIGEST("8"),
    };
  });
  const arms = ["BASELINE", "PROFILE"] as const;
  const candidateBytes = {
    baseline: bytes("synthetic baseline candidate bytes"),
    profile: bytes("synthetic profile candidate bytes"),
  };
  const candidateUniverse = [
    { candidateId: "baseline", candidateDigest: rawDigest(candidateBytes.baseline) },
    { candidateId: "profile", candidateDigest: rawDigest(candidateBytes.profile) },
  ];
  const selectedCandidates = {
    BASELINE: [candidateUniverse[0] as (typeof candidateUniverse)[number]],
    PROFILE: [candidateUniverse[1] as (typeof candidateUniverse)[number]],
  };
  const selectedSuiteDigests = {
    BASELINE: agenticCorpusExperimentSelectedSuiteDigest(selectedCandidates.BASELINE),
    PROFILE: agenticCorpusExperimentSelectedSuiteDigest(selectedCandidates.PROFILE),
  };
  const states = ["BUGGY", "FIXED", "REQUIRED_SUITE"] as const;
  const commands = arms.flatMap((arm) =>
    states.map((subjectState) => ({
      commandId: `${arm.toLowerCase()}-${subjectState.toLowerCase().replaceAll("_", "-")}`,
      adapterId: "synthetic-h3-adapter",
      arm,
      executableIdentityDigest: DIGEST("9"),
      executable: `synthetic-runner${options.commandSuffix ?? ""}`,
      arguments: [arm.toLowerCase(), subjectState.toLowerCase()],
      subjectState,
      testSuiteDigest: subjectState === "REQUIRED_SUITE" ? DIGEST("7") : selectedSuiteDigests[arm],
      timeoutMs: 5_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    })),
  );
  const schedule = subjects.flatMap((subject) =>
    arms.flatMap((arm) =>
      [1, 2].flatMap((attemptOrdinal) =>
        states.map((subjectState) => ({
          runId: `run-${subject.caseId}-${arm.toLowerCase()}-${attemptOrdinal}-${subjectState.toLowerCase().replaceAll("_", "-")}`,
          caseId: subject.caseId,
          arm,
          attemptOrdinal,
          subjectState,
          commandId: `${arm.toLowerCase()}-${subjectState.toLowerCase().replaceAll("_", "-")}`,
        })),
      ),
    ),
  );
  const unsignedPlan = {
    schemaVersion: "1.0.0" as const,
    planVersion: "1.0.0" as const,
    experimentId: "synthetic-h3-experiment",
    hypothesis: "H3" as const,
    partition: "HOLDOUT" as const,
    trustPolicyDigest: trust.policy.policyDigest,
    allocationCommitmentDigest: commitment.commitmentDigest,
    allocationDigest: allocation.allocationDigest,
    protocol: {
      protocolId: "synthetic-h3-predeclared",
      protocolVersion: "1.0.0" as const,
      minimumStableAttempts: 2,
      taxonomy: "TESTFORGE_OBSERVATION_V1" as const,
      detectionRule: "ATTRIBUTED_ASSERTION_FAILURE_ON_BUGGY_PASS_ON_FIXED" as const,
      nonEvidenceRule: "ERRORS_ARE_INSUFFICIENT_NOT_DETECTIONS" as const,
      maximumDetectionDeficitCases: 0,
    },
    subjects,
    adapters: [
      {
        adapterId: "synthetic-h3-adapter",
        adapterVersion: "1.0.0" as const,
        identityDigest: DIGEST("b"),
        resultProtocol: "TESTFORGE_H3_STRUCTURED_RESULT_V1" as const,
      },
    ],
    arms: {
      baseline: {
        candidateUniverse,
        selectedCandidates: selectedCandidates.BASELINE,
        selectedSuiteDigest: selectedSuiteDigests.BASELINE,
      },
      profile: {
        candidateUniverse,
        selectedCandidates: selectedCandidates.PROFILE,
        selectedSuiteDigest: selectedSuiteDigests.PROFILE,
      },
    },
    commands,
    schedule,
    budget: {
      unit: "PLANNED_PROCESS_EXECUTION" as const,
      baselinePlannedProcessExecutions: schedule.filter((item) => item.arm === "BASELINE").length,
      profilePlannedProcessExecutions: schedule.filter((item) => item.arm === "PROFILE").length,
      equalPlannedProcessExecutions: true,
      baselinePlannedTimeoutMs: schedule
        .filter((item) => item.arm === "BASELINE")
        .reduce(
          (total, item) =>
            total +
            (commands.find((command) => command.commandId === item.commandId)?.timeoutMs ?? 0),
          0,
        ),
      profilePlannedTimeoutMs: schedule
        .filter((item) => item.arm === "PROFILE")
        .reduce(
          (total, item) =>
            total +
            (commands.find((command) => command.commandId === item.commandId)?.timeoutMs ?? 0),
          0,
        ),
      equalPlannedTimeoutBudget: true,
    },
    limitations: ["Synthetic conformance evidence does not establish empirical H3 support."],
  };
  const plan: AgenticCorpusExperimentPlan = {
    ...unsignedPlan,
    planDigest: agenticCorpusExperimentPlanDigest(unsignedPlan),
  };
  const evidenceContents = new Map<string, Uint8Array>();
  evidenceContents.set(rawDigest(candidateBytes.baseline), candidateBytes.baseline);
  evidenceContents.set(rawDigest(candidateBytes.profile), candidateBytes.profile);
  const evidenceBindings: AgenticCorpusExperimentRequest["evidenceBindings"] = [];
  const observationByRun = new Map<string, { outcome: ObservationOutcome; attributed: boolean }>();
  const defaultBaselineDetected = new Set(
    [...new Set(subjects.map((subject) => subject.sourceIdentityDigest))].map(
      (sourceIdentityDigest) =>
        subjects.find((subject) => subject.sourceIdentityDigest === sourceIdentityDigest)
          ?.caseId as string,
    ),
  );
  const baselineDetected = new Set(options.baselineDetectedCaseIds ?? defaultBaselineDetected);
  const profileDetected = new Set(
    options.profileDetectedCaseIds ??
      (options.profileDetects === false ? [] : subjects.map((item) => item.caseId)),
  );
  for (const scheduled of plan.schedule) {
    const subject = subjects.find((item) => item.caseId === scheduled.caseId);
    const command = commands.find((item) => item.commandId === scheduled.commandId);
    assert.ok(subject && command);
    const firstCase = scheduled.caseId === subjects[0]?.caseId;
    const detected =
      scheduled.arm === "PROFILE"
        ? profileDetected.has(scheduled.caseId) ||
          (options.profileDetectedSourceIdentityDigests?.includes(subject.sourceIdentityDigest) ??
            false)
        : baselineDetected.has(scheduled.caseId) ||
          (options.baselineDetectedSourceIdentityDigests?.includes(subject.sourceIdentityDigest) ??
            false);
    let outcome: ObservationOutcome =
      scheduled.subjectState === "BUGGY" ? (detected ? "ASSERTION_FAILURE" : "PASS") : "PASS";
    if (scheduled.arm === "BASELINE" && firstCase && scheduled.subjectState === "BUGGY") {
      if (options.firstBaselineOutcome !== undefined) outcome = options.firstBaselineOutcome;
      if (options.contradictoryBaseline && scheduled.attemptOrdinal === 2) outcome = "PASS";
    }
    const attributed = outcome === "ASSERTION_FAILURE";
    const structuredBytes = canonicalBytes({
      schemaVersion: "1.0.0",
      protocol: "TESTFORGE_H3_STRUCTURED_RESULT_V1",
      outcome,
      attributed,
    });
    const stdoutBytes = bytes(
      options.oversizedOutput ? "x".repeat(5_000) : `stdout ${scheduled.runId}`,
    );
    const stderrBytes = bytes(`stderr ${scheduled.runId}`);
    const structuredResultDigest = rawDigest(structuredBytes);
    const stdoutDigest = rawDigest(stdoutBytes);
    const stderrDigest = rawDigest(stderrBytes);
    evidenceContents.set(structuredResultDigest, structuredBytes);
    evidenceContents.set(stdoutDigest, stdoutBytes);
    evidenceContents.set(stderrDigest, stderrBytes);
    let process = {
      exitCode: outcome === "PROCESS_CRASH" ? null : outcome === "PASS" ? 0 : 1,
      timedOut: outcome === "TIMEOUT",
      stdoutDigest,
      stderrDigest,
    };
    if (
      options.firstBaselineProcess !== undefined &&
      scheduled.arm === "BASELINE" &&
      firstCase &&
      scheduled.subjectState === "BUGGY"
    ) {
      process = { ...process, ...options.firstBaselineProcess };
    }
    const receiptProjection = {
      schemaVersion: "1.0.0" as const,
      receiptVersion: "1.0.0" as const,
      runId: scheduled.runId,
      planDigest: plan.planDigest,
      commandId: command.commandId,
      commandDigest: agenticCorpusExperimentCommandDigest(command),
      caseId: scheduled.caseId,
      arm: scheduled.arm,
      attemptOrdinal: scheduled.attemptOrdinal,
      subjectState: scheduled.subjectState,
      repositoryDigest:
        scheduled.subjectState === "BUGGY"
          ? subject.buggyRevisionDigest
          : subject.fixedRevisionDigest,
      testSuiteDigest: command.testSuiteDigest,
      appliedTimeoutMs: command.timeoutMs,
      process,
      structuredResultDigest,
    };
    const receipt = { ...receiptProjection, receiptDigest: sha256Canonical(receiptProjection) };
    const receiptBytes = canonicalBytes(receipt);
    const receiptContentDigest = rawDigest(receiptBytes);
    evidenceContents.set(receiptContentDigest, receiptBytes);
    evidenceBindings.push({
      runId: scheduled.runId,
      receiptDigest: receipt.receiptDigest,
      receiptContentDigest,
    });
    observationByRun.set(scheduled.runId, { outcome, attributed });
  }
  const payload = {
    cases: subjects.map((subject) => {
      const attempts = (arm: "BASELINE" | "PROFILE") =>
        [1, 2].map((ordinal) => {
          const runId = (state: "BUGGY" | "FIXED" | "REQUIRED_SUITE") =>
            plan.schedule.find(
              (item) =>
                item.caseId === subject.caseId &&
                item.arm === arm &&
                item.attemptOrdinal === ordinal &&
                item.subjectState === state,
            )?.runId as string;
          const buggy = runId("BUGGY");
          const fixed = runId("FIXED");
          const requiredSuite = runId("REQUIRED_SUITE");
          return {
            ordinal,
            buggy: observationByRun.get(buggy) as {
              outcome: ObservationOutcome;
              attributed: boolean;
            },
            fixed: observationByRun.get(fixed) as {
              outcome: ObservationOutcome;
              attributed: boolean;
            },
            requiredSuite: observationByRun.get(requiredSuite) as {
              outcome: ObservationOutcome;
              attributed: boolean;
            },
            runIds: { buggy, fixed, requiredSuite },
          };
        });
      return {
        caseId: subject.caseId,
        baselineAttempts: attempts("BASELINE"),
        profileAttempts: attempts("PROFILE"),
      };
    }),
  };
  const request: AgenticCorpusExperimentRequest = {
    schemaVersion: "1.0.0",
    experimentVersion: "1.0.0",
    experimentId: plan.experimentId,
    hypothesis: "H3",
    partition: "HOLDOUT",
    planDigest: plan.planDigest,
    allocationDigest: allocation.allocationDigest,
    trustPolicyDigest: trust.policy.policyDigest,
    evidenceBindings,
    payloadSchemaId: "https://testforge.dev/payloads/agentic-corpus-experiment-h3.v1.json",
    payload,
    limitations: ["Synthetic conformance evidence does not establish empirical H3 support."],
  };
  const artifact = createAgenticCorpusExperimentArtifact(request, plan);
  const subjectEvidence = subjects.map((subject) => {
    const source = subjectByCase.get(subject.caseId);
    assert.ok(source?.provenance);
    return { caseDocument: source.item, provenance: source.provenance };
  });
  const replayOptions = {
    expectedTrustPolicyDigest: trust.policy.policyDigest,
    expectedAllocationCommitmentDigest: commitment.commitmentDigest,
    expectedExperimentPlanDigest: plan.planDigest,
    trustPolicy: trust.policy,
    allocationCommitment: commitment,
    allocationReveal: reveal,
    allocation,
    experimentPlan: plan,
    subjectEvidence,
    evidenceContents,
  };
  return { trust, commitment, reveal, allocation, plan, request, artifact, replayOptions };
}

describe("externally anchored H3 experiment v1", () => {
  it("replays a complete artifact only with separate external anchors and bytes", () => {
    const value = fixture();
    const replay = new TestForge().replayCorpusExperiment(value.artifact, value.replayOptions);
    assert.equal(replay.valid, true, JSON.stringify(replay));
    assert.equal(value.artifact.result.status, "SUPPORTED");
    assert.equal(replay.externalTrustAnchorValid, true);
    assert.equal(replay.externalCommitmentAnchorValid, true);
    assert.equal(replay.externalPlanAnchorValid, true);
    assert.equal(replay.candidateEvidenceValid, true);
    assert.equal(replay.outputBytesResolved, true);
  });

  it("rejects complete trust, commitment, and plan substitution against external pins", () => {
    const pinned = fixture();
    const substituted = fixture({ commandSuffix: "-substituted" });
    const replay = new TestForge().replayCorpusExperiment(substituted.artifact, {
      ...substituted.replayOptions,
      expectedTrustPolicyDigest: pinned.replayOptions.expectedTrustPolicyDigest,
      expectedAllocationCommitmentDigest: pinned.replayOptions.expectedAllocationCommitmentDigest,
      expectedExperimentPlanDigest: pinned.replayOptions.expectedExperimentPlanDigest,
    });
    assert.equal(replay.valid, false);
    assert.equal(replay.externalTrustAnchorValid, false);
    assert.equal(replay.externalCommitmentAnchorValid, false);
    assert.equal(replay.externalPlanAnchorValid, false);
    const planOnlySubstitution = new TestForge().replayCorpusExperiment(substituted.artifact, {
      ...substituted.replayOptions,
      expectedExperimentPlanDigest: pinned.replayOptions.expectedExperimentPlanDigest,
    });
    assert.equal(planOnlySubstitution.externalTrustAnchorValid, true);
    assert.equal(planOnlySubstitution.externalCommitmentAnchorValid, true);
    assert.equal(planOnlySubstitution.externalPlanAnchorValid, false);
    assert.equal(planOnlySubstitution.valid, false);
  });

  it("rejects wrong shares and allocation changes after commitment", () => {
    const value = fixture();
    const wrongShare = structuredClone(value.reveal);
    wrongShare.shares[0].secret = Buffer.alloc(32, 3).toString("base64url");
    wrongShare.revealDigest = agenticCorpusAllocationRevealDigest(wrongShare);
    assert.equal(
      new TestForge().replayCorpusAllocationCommitment({
        commitment: value.commitment,
        reveal: wrongShare,
        allocation: value.allocation,
        trustPolicy: value.trust.policy,
        expectedTrustPolicyDigest: value.trust.policy.policyDigest,
        expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
      }).revealValid,
      false,
    );
    const missingShare = { ...value.reveal, shares: [value.reveal.shares[0]] };
    assert.equal(
      new TestForge().replayCorpusAllocationCommitment({
        commitment: value.commitment,
        reveal: missingShare,
        allocation: value.allocation,
        trustPolicy: value.trust.policy,
        expectedTrustPolicyDigest: value.trust.policy.policyDigest,
        expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
      }).schemaValid,
      false,
    );
    const onePrincipal = structuredClone(value.commitment);
    onePrincipal.signers[1].keyId = onePrincipal.signers[0].keyId;
    onePrincipal.commitmentDigest = agenticCorpusAllocationCommitmentDigest(onePrincipal);
    assert.equal(
      new TestForge().replayCorpusAllocationCommitment({
        commitment: onePrincipal,
        reveal: value.reveal,
        allocation: value.allocation,
        trustPolicy: value.trust.policy,
        expectedTrustPolicyDigest: value.trust.policy.policyDigest,
        expectedAllocationCommitmentDigest: onePrincipal.commitmentDigest,
      }).schemaValid,
      false,
    );
    const changedCount = structuredClone(value.commitment);
    const firstStratum = changedCount.strata[0];
    assert.ok(firstStratum);
    firstStratum.calibrationCount = 1;
    changedCount.commitmentDigest = agenticCorpusAllocationCommitmentDigest(changedCount);
    const countReplay = new TestForge().replayCorpusAllocationCommitment({
      commitment: changedCount,
      reveal: value.reveal,
      allocation: value.allocation,
      trustPolicy: value.trust.policy,
      expectedTrustPolicyDigest: value.trust.policy.policyDigest,
      expectedAllocationCommitmentDigest: changedCount.commitmentDigest,
    });
    assert.equal(countReplay.commitmentDigestValid, true);
    assert.equal(countReplay.commitmentSignaturesValid, false);
    assert.equal(countReplay.valid, false);
    const changedCaseSet = structuredClone(value.commitment);
    const firstCommittedCase = changedCaseSet.caseSet[0];
    assert.ok(firstCommittedCase);
    firstCommittedCase.caseDigest = DIGEST("f");
    changedCaseSet.commitmentDigest = agenticCorpusAllocationCommitmentDigest(changedCaseSet);
    const caseSetReplay = new TestForge().replayCorpusAllocationCommitment({
      commitment: changedCaseSet,
      reveal: value.reveal,
      allocation: value.allocation,
      trustPolicy: value.trust.policy,
      expectedTrustPolicyDigest: value.trust.policy.policyDigest,
      expectedAllocationCommitmentDigest: changedCaseSet.commitmentDigest,
    });
    assert.equal(caseSetReplay.commitmentDigestValid, true);
    assert.equal(caseSetReplay.commitmentSignaturesValid, false);
    assert.equal(caseSetReplay.valid, false);
    const changedAllocation = structuredClone(value.allocation);
    [changedAllocation.calibrationCaseIds[0], changedAllocation.holdoutCaseIds[0]] = [
      changedAllocation.holdoutCaseIds[0] as string,
      changedAllocation.calibrationCaseIds[0] as string,
    ];
    assert.equal(
      new TestForge().replayCorpusAllocationCommitment({
        commitment: value.commitment,
        reveal: value.reveal,
        allocation: changedAllocation,
        trustPolicy: value.trust.policy,
        expectedTrustPolicyDigest: value.trust.policy.policyDigest,
        expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
      }).allocationBindingValid,
      false,
    );
  });

  it("rejects post-hoc commands, subjects, schedules, and plans even when redigested", () => {
    const value = fixture();
    const plan = structuredClone(value.plan);
    const firstCommand = plan.commands[0];
    const firstSubject = plan.subjects[0];
    const firstScheduleEntry = plan.schedule[0];
    assert.ok(firstCommand && firstSubject && firstScheduleEntry);
    firstCommand.arguments.push("post-hoc");
    firstSubject.buggyRevisionDigest = DIGEST("f");
    plan.schedule.push(structuredClone(firstScheduleEntry));
    plan.budget.baselinePlannedProcessExecutions += 1;
    plan.planDigest = agenticCorpusExperimentPlanDigest(plan);
    const planReplay = replayAgenticCorpusExperimentPlan(plan, plan.planDigest, {
      allocation: value.allocation,
      commitment: value.commitment,
      expectedTrustPolicyDigest: value.trust.policy.policyDigest,
      expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
    });
    assert.equal(planReplay.scheduleValid, false);
    assert.equal(planReplay.budgetValid, false);
    const replay = new TestForge().replayCorpusExperiment(value.artifact, {
      ...value.replayOptions,
      experimentPlan: plan,
    });
    assert.equal(replay.externalPlanAnchorValid, false);
    assert.equal(replay.valid, false);
  });

  it("rejects asymmetric planned timeout budgets even when the plan is redigested and repinned", () => {
    const value = fixture();
    const plan = structuredClone(value.plan);
    for (const command of plan.commands) {
      if (command.arm === "PROFILE") command.timeoutMs += 1_000;
    }
    plan.planDigest = agenticCorpusExperimentPlanDigest(plan);
    const replay = replayAgenticCorpusExperimentPlan(plan, plan.planDigest, {
      allocation: value.allocation,
      commitment: value.commitment,
      expectedTrustPolicyDigest: value.trust.policy.policyDigest,
      expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
    });
    assert.equal(replay.planDigestValid, true);
    assert.equal(replay.budgetValid, false);
    assert.equal(replay.valid, false);

    const receiptForgery = fixture();
    const forgedArtifact = structuredClone(receiptForgery.artifact);
    const contents = new Map(receiptForgery.replayOptions.evidenceContents);
    const firstBinding = forgedArtifact.evidenceBindings[0];
    assert.ok(firstBinding);
    const receiptBytes = contents.get(firstBinding.receiptContentDigest);
    assert.ok(receiptBytes);
    const receipt = JSON.parse(new TextDecoder().decode(receiptBytes)) as Record<string, unknown>;
    receipt.appliedTimeoutMs = 6_000;
    const { receiptDigest: _receiptDigest, ...receiptProjection } = receipt;
    receipt.receiptDigest = sha256Canonical(receiptProjection);
    const forgedReceiptBytes = canonicalBytes(receipt);
    const forgedReceiptContentDigest = rawDigest(forgedReceiptBytes);
    contents.delete(firstBinding.receiptContentDigest);
    contents.set(forgedReceiptContentDigest, forgedReceiptBytes);
    firstBinding.receiptDigest = String(receipt.receiptDigest);
    firstBinding.receiptContentDigest = forgedReceiptContentDigest;
    forgedArtifact.evidenceSetDigest = sha256Canonical(forgedArtifact.evidenceBindings);
    forgedArtifact.artifactDigest = agenticCorpusExperimentArtifactDigest(forgedArtifact);
    const receiptReplay = new TestForge().replayCorpusExperiment(forgedArtifact, {
      ...receiptForgery.replayOptions,
      evidenceContents: contents,
    });
    assert.equal(receiptReplay.receiptBindingsValid, false);
    assert.equal(receiptReplay.valid, false);
  });

  it("rejects candidate selection changes that are not reflected in the selected suite", () => {
    const value = fixture();
    const plan = structuredClone(value.plan);
    const profileCandidate = plan.arms.profile.selectedCandidates[0];
    assert.ok(profileCandidate);
    plan.arms.baseline.selectedCandidates = [profileCandidate];
    plan.planDigest = agenticCorpusExperimentPlanDigest(plan);
    const replay = replayAgenticCorpusExperimentPlan(plan, plan.planDigest, {
      allocation: value.allocation,
      commitment: value.commitment,
      expectedTrustPolicyDigest: value.trust.policy.policyDigest,
      expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
    });
    assert.equal(replay.planDigestValid, true);
    assert.equal(replay.armsValid, false);
    assert.equal(replay.valid, false);
  });

  it("permanently rejects a repinned selected candidate outside the frozen universe", () => {
    const value = fixture();
    const plan = structuredClone(value.plan);
    plan.arms.baseline.selectedCandidates = [
      { candidateId: "outsider", candidateDigest: DIGEST("f") },
    ];
    plan.arms.baseline.selectedSuiteDigest = agenticCorpusExperimentSelectedSuiteDigest(
      plan.arms.baseline.selectedCandidates,
    );
    plan.planDigest = agenticCorpusExperimentPlanDigest(plan);
    const replay = replayAgenticCorpusExperimentPlan(plan, plan.planDigest, {
      allocation: value.allocation,
      commitment: value.commitment,
      expectedTrustPolicyDigest: value.trust.policy.policyDigest,
      expectedAllocationCommitmentDigest: value.commitment.commitmentDigest,
    });
    assert.equal(replay.schemaValid, false);
    assert.equal(replay.valid, false);
  });

  it("rejects the legacy global allocation request because it cannot enforce source strata", () => {
    assert.throws(() =>
      parseAgenticCorpusAllocationRequest({
        schemaVersion: "1.0.0",
        allocationId: "unstratified-allocation",
        seedDigest: DIGEST("1"),
        calibrationCount: 2,
        caseIds: ["source-a-1", "source-a-2", "source-b-1", "source-b-2"],
      }),
    );
  });

  it("rejects trust policies with duplicate source identity digests", () => {
    const value = fixture();
    const policy = structuredClone(value.trust.policy);
    const source = policy.sources[0];
    assert.ok(source);
    policy.sources.push({ ...source, sourceId: "synthetic-source-alias" });
    policy.policyDigest = agenticCorpusTrustPolicyDigest(policy);
    assert.throws(() => parseAgenticCorpusTrustPolicy(policy));
  });

  it("rejects missing output bytes", () => {
    const value = fixture();
    const contents = new Map(value.replayOptions.evidenceContents);
    const receiptContentDigests = new Set(
      value.artifact.evidenceBindings.map((binding) => binding.receiptContentDigest),
    );
    const candidateDigests = new Set(
      value.plan.arms.baseline.candidateUniverse.map((candidate) => candidate.candidateDigest),
    );
    const firstOutputDigest = [...contents.keys()].find(
      (digest) => !receiptContentDigests.has(digest) && !candidateDigests.has(digest),
    );
    assert.ok(firstOutputDigest);
    contents.delete(firstOutputDigest);
    const replay = new TestForge().replayCorpusExperiment(value.artifact, {
      ...value.replayOptions,
      evidenceContents: contents,
    });
    assert.equal(replay.outputBytesResolved, false);
    assert.equal(replay.valid, false);
    const mismatched = new Map(value.replayOptions.evidenceContents);
    mismatched.set(firstOutputDigest, bytes("coherently claimed but wrong output bytes"));
    const mismatchReplay = new TestForge().replayCorpusExperiment(value.artifact, {
      ...value.replayOptions,
      evidenceContents: mismatched,
    });
    assert.equal(mismatchReplay.outputBytesResolved, false);
    assert.equal(mismatchReplay.valid, false);
    const oversized = fixture({ oversizedOutput: true });
    const oversizedReplay = new TestForge().replayCorpusExperiment(
      oversized.artifact,
      oversized.replayOptions,
    );
    assert.equal(oversizedReplay.outputBytesResolved, false);
    assert.equal(oversizedReplay.valid, false);
  });

  it("rejects candidate references whose bytes are absent from evidence contents", () => {
    const value = fixture();
    const candidateDigest = value.plan.arms.baseline.candidateUniverse[0]?.candidateDigest;
    assert.ok(candidateDigest);
    const missing = new Map(value.replayOptions.evidenceContents);
    missing.delete(candidateDigest);
    const missingReplay = new TestForge().replayCorpusExperiment(value.artifact, {
      ...value.replayOptions,
      evidenceContents: missing,
    });
    assert.equal(missingReplay.candidateEvidenceValid, false);
    assert.equal(missingReplay.valid, false);

    const tampered = new Map(value.replayOptions.evidenceContents);
    tampered.set(candidateDigest, bytes("tampered candidate bytes"));
    const tamperedReplay = new TestForge().replayCorpusExperiment(value.artifact, {
      ...value.replayOptions,
      evidenceContents: tampered,
    });
    assert.equal(tamperedReplay.candidateEvidenceValid, false);
    assert.equal(tamperedReplay.valid, false);
  });

  it("rejects structured outcomes that contradict process exit and timeout state", () => {
    const cases: Array<{
      outcome: ObservationOutcome;
      process: { exitCode: number | null; timedOut: boolean };
    }> = [
      { outcome: "PASS", process: { exitCode: 1, timedOut: false } },
      { outcome: "ASSERTION_FAILURE", process: { exitCode: 0, timedOut: false } },
      { outcome: "COMPILE_FAILURE", process: { exitCode: 0, timedOut: false } },
      { outcome: "COLLECTION_FAILURE", process: { exitCode: 0, timedOut: false } },
      { outcome: "INFRA_ERROR", process: { exitCode: 0, timedOut: false } },
      { outcome: "NO_TEST_DISCOVERED", process: { exitCode: 0, timedOut: false } },
      { outcome: "PROCESS_CRASH", process: { exitCode: 1, timedOut: false } },
      { outcome: "TIMEOUT", process: { exitCode: 1, timedOut: false } },
    ];
    for (const item of cases) {
      const value = fixture({
        firstBaselineOutcome: item.outcome,
        firstBaselineProcess: item.process,
      });
      const replay = new TestForge().replayCorpusExperiment(value.artifact, value.replayOptions);
      assert.equal(replay.structuredResultsValid, false, item.outcome);
      assert.equal(replay.valid, false, item.outcome);
    }
  });

  it("keeps all six operational outcomes replay-valid but H3-insufficient", () => {
    for (const outcome of [
      "COMPILE_FAILURE",
      "COLLECTION_FAILURE",
      "TIMEOUT",
      "PROCESS_CRASH",
      "INFRA_ERROR",
      "NO_TEST_DISCOVERED",
    ] as const) {
      const value = fixture({ firstBaselineOutcome: outcome });
      const replay = new TestForge().replayCorpusExperiment(value.artifact, value.replayOptions);
      const firstSubject = value.plan.subjects[0];
      assert.ok(firstSubject);
      assert.equal(replay.valid, true, outcome);
      assert.equal(value.artifact.result.status, "INSUFFICIENT", outcome);
      assert.equal(
        value.artifact.result.baselineDetectedCaseIds.includes(firstSubject.caseId),
        false,
      );
    }
  });

  it("keeps contradictory attempts replay-valid but insufficient", () => {
    const value = fixture({ contradictoryBaseline: true });
    assert.equal(
      new TestForge().replayCorpusExperiment(value.artifact, value.replayOptions).valid,
      true,
    );
    assert.equal(value.artifact.result.status, "INSUFFICIENT");
  });

  it("does not allow aggregate detections to compensate for a weaker source stratum", () => {
    const seed = fixture();
    const sources = [...new Set(seed.plan.subjects.map((subject) => subject.sourceIdentityDigest))];
    assert.equal(sources.length, 2);
    const sourceA = sources[0];
    const sourceB = sources[1];
    assert.ok(sourceA && sourceB);
    const value = fixture({
      baselineDetectedCaseIds: [],
      profileDetectedCaseIds: [],
      baselineDetectedSourceIdentityDigests: [sourceA],
      profileDetectedSourceIdentityDigests: [sourceB],
    });
    assert.equal(
      new TestForge().replayCorpusExperiment(value.artifact, value.replayOptions).valid,
      true,
    );
    assert.equal(
      value.artifact.result.baselineDetectedCount,
      value.artifact.result.profileDetectedCount,
    );
    assert.equal(value.artifact.result.nonInferior, false);
    assert.equal(value.artifact.result.status, "NOT_SUPPORTED");
    assert.equal(
      value.artifact.result.sourceResults.some((source) => !source.nonInferior),
      true,
    );
  });

  it("rejects result tampering after artifact redigest and malformed input", () => {
    const value = fixture();
    const forged = structuredClone(value.artifact);
    forged.result.profileDetectedCount = 0;
    forged.artifactDigest = agenticCorpusExperimentArtifactDigest(forged);
    const replay = new TestForge().replayCorpusExperiment(forged, value.replayOptions);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.resultSemanticsValid, false);
    assert.equal(replay.valid, false);
    const planBindingForgery = structuredClone(value.artifact);
    planBindingForgery.experimentId = "post-hoc-experiment";
    planBindingForgery.artifactDigest = agenticCorpusExperimentArtifactDigest(planBindingForgery);
    const planBindingReplay = new TestForge().replayCorpusExperiment(
      planBindingForgery,
      value.replayOptions,
    );
    assert.equal(planBindingReplay.artifactDigestValid, true);
    assert.equal(planBindingReplay.planSemanticsValid, false);
    assert.equal(planBindingReplay.valid, false);
    assert.equal(
      new TestForge().replayCorpusExperiment({}, value.replayOptions).schemaValid,
      false,
    );
  });

  it("requires external CLI files and returns 0 supported, 2 not-supported, or 3 insufficient", async () => {
    const run = async (value: ReturnType<typeof fixture>) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "testforge-h3-cli-"));
      try {
        const documents = {
          artifact: value.artifact,
          policy: value.replayOptions.trustPolicy,
          commitment: value.commitment,
          reveal: value.reveal,
          allocation: value.allocation,
          plan: value.plan,
          subjects: value.replayOptions.subjectEvidence,
          contents: [...value.replayOptions.evidenceContents].map(([digest, content]) => ({
            digest,
            encoding: "BASE64URL",
            content: Buffer.from(content).toString("base64url"),
          })),
        };
        for (const [name, document] of Object.entries(documents)) {
          await writeFile(path.join(root, `${name}.json`), JSON.stringify(document), "utf8");
        }
        const diagnostics: string[] = [];
        const code = await runCli(
          [
            "corpus-experiment-replay",
            "artifact.json",
            "--trust-policy",
            "policy.json",
            "--trust-policy-digest",
            value.replayOptions.expectedTrustPolicyDigest,
            "--allocation-commitment",
            "commitment.json",
            "--allocation-commitment-digest",
            value.replayOptions.expectedAllocationCommitmentDigest,
            "--allocation-reveal",
            "reveal.json",
            "--allocation",
            "allocation.json",
            "--experiment-plan",
            "plan.json",
            "--experiment-plan-digest",
            value.replayOptions.expectedExperimentPlanDigest,
            "--subject-evidence",
            "subjects.json",
            "--evidence-contents",
            "contents.json",
            "--json",
          ],
          {
            cwd: root,
            async readStdin() {
              return "";
            },
            writeStdout() {},
            writeStderr(text) {
              diagnostics.push(text);
            },
          },
        );
        if (code === 5) throw new Error(diagnostics.join(""));
        return code;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
    assert.equal(await run(fixture()), 0);
    assert.equal(await run(fixture({ profileDetects: false })), 2);
    assert.equal(await run(fixture({ firstBaselineOutcome: "INFRA_ERROR" })), 3);
    const value = fixture();
    assert.equal(
      await runCli(["corpus-experiment-replay", "-", "--json"], {
        cwd: process.cwd(),
        async readStdin() {
          return JSON.stringify(value.artifact);
        },
        writeStdout() {},
        writeStderr() {},
      }),
      4,
    );
  });

  it("does not expose H3 creation or replay as default MCP tools", async () => {
    const server = createTestForgeServer();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    assert.equal(Object.hasOwn(tools, "testforge_corpus_experiment"), false);
    assert.equal(Object.hasOwn(tools, "testforge_corpus_experiment_replay"), false);
    await server.close();
  });
});
