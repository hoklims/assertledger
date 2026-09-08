import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgenticProfileReport, parseAgenticProfileRequest } from "../src/contracts/index.js";
import {
  createAgenticProfile,
  decideEvidence,
  replayAgenticProfile,
  replayEvidenceManifest,
  sealManifestArtifact,
  sha256Canonical,
} from "../src/core/index.js";

function digest(label: string): string {
  return sha256Canonical({ label });
}

function evidence(strong = true, unstable = false) {
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target", kind: "TARGET", required: true, weight: 10 },
    { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
  ];
  const observations = worlds.flatMap((world) =>
    [1, 2, 3].flatMap((attempt) => [
      {
        runId: `control:${world.id}:${attempt}`,
        candidateId: null,
        worldId: world.id,
        attempt,
        outcome: "PASS",
        testsDiscovered: 1,
        candidateTestsDiscovered: 0,
        attributed: false,
        durationMs: 5,
      },
      {
        runId: `candidate:${world.id}:${attempt}`,
        candidateId: "candidate",
        worldId: world.id,
        attempt,
        outcome:
          world.kind === "TARGET" && strong && !(unstable && attempt === 3)
            ? "ASSERTION_FAILURE"
            : "PASS",
        testsDiscovered: 2,
        candidateTestsDiscovered: 1,
        attributed: true,
        durationMs: world.kind === "REFERENCE" ? attempt * 100 : 20,
      },
    ]),
  );
  const manifest = decideEvidence({
    schemaVersion: "1.0.0",
    repositoryDigest: digest("repository"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: process.versions.node,
        configuration: { kind: "node-test", executable: process.execPath },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: [],
        budgets: {},
        candidateRoots: ["tests"],
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: `fixture:${world.id}`,
        digest: digest(world.id),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 3,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: [{ id: "candidate", digest: digest("candidate"), sizeBytes: 100 }],
    observations,
  });
  return sealManifestArtifact({
    ...manifest,
    adapter: { kind: "node-test" as const },
    isolation: {
      kind: "trusted-local" as const,
      level: "UNSANDBOXED" as const,
      acknowledgedUnsafeExecution: true as const,
    },
    limitations: ["UNSANDBOXED fixture."],
  });
}

function request(manifest = evidence(true), minimumTimingSamples = 3) {
  return {
    schemaVersion: "1.0.0",
    manifest,
    policy: {
      profileVersion: "1.0.0",
      profileId: "example/default",
      mode: "HARDENING",
      minimumTimingSamples,
      lanes: [
        { id: "instant", maximumReferenceP95Ms: 250 },
        { id: "loop", maximumReferenceP95Ms: 500 },
      ],
    },
  };
}

function portfolioRequest(
  options: { dominantStrong?: boolean; reverseCandidates?: boolean; tie?: boolean } = {},
) {
  const targets = [
    { id: "target-required", kind: "TARGET", required: true, weight: 1 },
    { id: "target-a", kind: "TARGET", required: false, weight: 6 },
    { id: "target-b", kind: "TARGET", required: false, weight: 4 },
    { id: "target-c", kind: "TARGET", required: false, weight: options.tie ? 4 : 3 },
  ];
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    ...targets,
    { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
  ];
  const candidates = [
    {
      id: "candidate-a",
      targetId: "target-a",
      referenceMs: options.dominantStrong ? 10 : 60,
      sizeBytes: options.dominantStrong ? 5 : 30,
    },
    {
      id: "candidate-b",
      targetId: "target-b",
      referenceMs: options.tie ? 20 : 30,
      sizeBytes: options.tie ? 10 : 20,
    },
    { id: "candidate-c", targetId: "target-c", referenceMs: 20, sizeBytes: 10 },
  ];
  if (options.reverseCandidates) candidates.reverse();
  const observations = worlds.flatMap((world) => [
    {
      runId: `control:${world.id}:1`,
      candidateId: null,
      worldId: world.id,
      attempt: 1,
      outcome: "PASS",
      testsDiscovered: 1,
      candidateTestsDiscovered: 0,
      attributed: false,
      durationMs: 1,
    },
    ...candidates.map((candidate) => ({
      runId: `${candidate.id}:${world.id}:1`,
      candidateId: candidate.id,
      worldId: world.id,
      attempt: 1,
      outcome:
        world.id === "target-required" || world.id === candidate.targetId
          ? "ASSERTION_FAILURE"
          : "PASS",
      testsDiscovered: 2,
      candidateTestsDiscovered: 1,
      attributed: true,
      durationMs: world.kind === "REFERENCE" ? candidate.referenceMs : 1,
    })),
  ]);
  const manifest = decideEvidence({
    schemaVersion: "1.0.0",
    repositoryDigest: digest("portfolio-repository"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: process.versions.node,
        configuration: { kind: "node-test", executable: process.execPath },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: [],
        budgets: {},
        candidateRoots: ["tests"],
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: `fixture:${world.id}`,
        digest: digest(world.id),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1,
      maximumSelectedCandidates: 3,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      digest: digest(candidate.id),
      sizeBytes: candidate.sizeBytes,
    })),
    observations,
  });
  return request(
    sealManifestArtifact({
      ...manifest,
      adapter: { kind: "node-test" as const },
      isolation: {
        kind: "trusted-local" as const,
        level: "UNSANDBOXED" as const,
        acknowledgedUnsafeExecution: true as const,
      },
      limitations: ["UNSANDBOXED fixture."],
    }),
    1,
  );
}

describe("agentic test profile", () => {
  it("qualifies only replay-valid selected hardening evidence within a declared lane", () => {
    const report = parseAgenticProfileReport(
      createAgenticProfile(parseAgenticProfileRequest(request())),
    );

    assert.equal(report.status, "QUALIFIED");
    assert.deepEqual(report.qualifiedCandidateIds, ["candidate"]);
    assert.equal(report.candidates[0]?.classification, "QUALIFIED");
    assert.equal(report.candidates[0]?.bestLaneId, "loop");
    assert.deepEqual(report.candidates[0]?.satisfiedLaneIds, ["loop"]);
    assert.equal(report.candidates[0]?.targetWeightPermille, 1_000);
    assert.equal(report.candidates[0]?.consistency.claim, "OBSERVED_CONSISTENT");
    assert.equal(report.candidates[0]?.consistency.attempts, 3);
    assert.deepEqual(report.candidates[0]?.latency, {
      kind: "RECORDED_REFERENCE_WALL_TIME",
      samples: 3,
      minimumMs: 100,
      p50Ms: 200,
      p95Ms: 300,
      maximumMs: 300,
      totalCandidateDurationMs: 720,
    });
  });

  it("never lets speed compensate for weak target evidence", () => {
    const report = createAgenticProfile(parseAgenticProfileRequest(request(evidence(false))));

    assert.equal(report.status, "NOT_QUALIFIED");
    assert.equal(report.qualifiedCandidateIds.length, 0);
    assert.equal(report.candidates[0]?.classification, "NOT_QUALIFIED");
    assert.equal(report.candidates[0]?.bestLaneId, null);
  });

  it("reports insufficient timing evidence without weakening the evidence decision", () => {
    const report = createAgenticProfile(parseAgenticProfileRequest(request(evidence(true), 5)));

    assert.equal(report.sourceManifest.decision.status, "VERIFIED");
    assert.equal(report.status, "INSUFFICIENT_TIMING_EVIDENCE");
    assert.equal(report.candidates[0]?.classification, "INSUFFICIENT_TIMING_EVIDENCE");
    assert.equal(report.candidates[0]?.paretoFrontier, false);
  });

  it("reports contradictory attempts as observed inconsistent", () => {
    const report = createAgenticProfile(parseAgenticProfileRequest(request(evidence(true, true))));

    assert.equal(report.sourceManifest.decision.status, "INCONCLUSIVE");
    assert.equal(report.candidates[0]?.evidenceStatus, "UNSTABLE");
    assert.equal(report.candidates[0]?.classification, "NOT_QUALIFIED");
    assert.deepEqual(report.candidates[0]?.consistency, {
      claim: "OBSERVED_INCONSISTENT",
      attempts: 3,
    });
  });

  it("replays a self-contained report and rejects metric tampering", () => {
    const report = createAgenticProfile(parseAgenticProfileRequest(request()));
    assert.deepEqual(replayAgenticProfile(report), {
      valid: true,
      schemaValid: true,
      sourceManifestValid: true,
      policyDigestValid: true,
      reportDigestValid: true,
      semanticsValid: true,
    });

    const tampered = structuredClone(report);
    const tamperedCandidate = tampered.candidates[0];
    assert.ok(tamperedCandidate);
    tamperedCandidate.latency.p95Ms = 1;
    const replay = replayAgenticProfile(tampered);
    assert.equal(replay.valid, false);
    assert.equal(replay.reportDigestValid, false);
    assert.equal(replay.semanticsValid, false);
  });

  it("rejects ambiguous lane policies", () => {
    const invalid = request();
    invalid.policy.lanes.reverse();
    assert.throws(() => parseAgenticProfileRequest(invalid), /AGENTIC_PROFILE_POLICY_INVALID/);
  });

  it("rejects invalid lane policies at the public direct creator boundary", () => {
    const invalid = parseAgenticProfileRequest(request());
    invalid.policy.lanes = [
      { id: "duplicate", maximumReferenceP95Ms: 250 },
      { id: "duplicate", maximumReferenceP95Ms: 500 },
    ];

    assert.throws(() => createAgenticProfile(invalid), /AGENTIC_PROFILE_POLICY_INVALID/);
  });

  it("fails replay closed when a re-digested report contains an invalid lane policy", () => {
    const report = createAgenticProfile(parseAgenticProfileRequest(request()));
    report.policy.lanes = [
      { id: "duplicate", maximumReferenceP95Ms: 250 },
      { id: "duplicate", maximumReferenceP95Ms: 500 },
    ];
    report.policyDigest = sha256Canonical(report.policy);
    const { reportDigest: _oldDigest, ...projection } = report;
    report.reportDigest = sha256Canonical(projection);

    const replay = replayAgenticProfile(report);
    assert.equal(replay.valid, false);
    assert.equal(replay.schemaValid, false);
  });

  it("rejects unknown request and report fields", () => {
    const invalidRequest = request();
    Object.assign(invalidRequest.policy, { compensatingScore: 100 });
    assert.throws(
      () => parseAgenticProfileRequest(invalidRequest),
      /AGENTIC_PROFILE_REQUEST_INVALID/,
    );

    const invalidReport = createAgenticProfile(parseAgenticProfileRequest(request()));
    Object.assign(invalidReport, { certification: "universal" });
    const replay = replayAgenticProfile(invalidReport);
    assert.equal(replay.valid, false);
    assert.equal(replay.schemaValid, false);
  });

  it("selects a deterministic maximum-value greedy portfolio for each lane budget", () => {
    const input = portfolioRequest();
    input.policy.lanes = [{ id: "loop", maximumReferenceP95Ms: 70 }];
    assert.deepEqual(replayEvidenceManifest(input.manifest), {
      valid: true,
      decisionDigestValid: true,
      artifactDigestValid: true,
      decisionSemanticsValid: true,
    });

    const report = createAgenticProfile(parseAgenticProfileRequest(input));

    assert.deepEqual(report.portfolios, [
      {
        laneId: "loop",
        budgetMs: 70,
        selectedCandidateIds: ["candidate-c", "candidate-b"],
        totalReferenceP95Ms: 50,
        targetWeight: 8,
        targetWeightPermille: 571,
        requiredTargetsKilled: 1,
        requiredTargetsTotal: 1,
      },
    ]);
    assert.equal(replayAgenticProfile(report).valid, true);
  });

  it("keeps profile and portfolio output invariant under candidate input permutations", () => {
    const left = portfolioRequest();
    const right = portfolioRequest({ reverseCandidates: true });
    left.policy.lanes = [{ id: "loop", maximumReferenceP95Ms: 70 }];
    right.policy.lanes = [{ id: "loop", maximumReferenceP95Ms: 70 }];

    assert.deepEqual(
      createAgenticProfile(parseAgenticProfileRequest(left)),
      createAgenticProfile(parseAgenticProfileRequest(right)),
    );
  });

  it("supports finite fractional adapter durations in portfolio selection", () => {
    const input = portfolioRequest();
    input.policy.lanes = [{ id: "loop", maximumReferenceP95Ms: 70 }];
    const observation = input.manifest.observations.find(
      (candidateObservation) =>
        candidateObservation.candidateId === "candidate-c" &&
        candidateObservation.worldId === "reference",
    );
    assert.ok(observation);
    observation.durationMs = 20.5;
    input.manifest = sealManifestArtifact(input.manifest);

    const report = createAgenticProfile(parseAgenticProfileRequest(input));
    assert.deepEqual(report.portfolios[0]?.selectedCandidateIds, ["candidate-c", "candidate-b"]);
    assert.equal(report.portfolios[0]?.totalReferenceP95Ms, 50.5);
  });

  it("marks candidates dominated on strength and cost outside the Pareto frontier", () => {
    const input = portfolioRequest({ dominantStrong: true });
    input.policy.lanes = [{ id: "loop", maximumReferenceP95Ms: 70 }];

    const report = createAgenticProfile(parseAgenticProfileRequest(input));
    assert.deepEqual(
      report.candidates.map((candidate) => [candidate.id, candidate.paretoFrontier]),
      [
        ["candidate-a", true],
        ["candidate-b", false],
        ["candidate-c", false],
      ],
    );
  });

  it("breaks equal portfolio value and cost ties by digest", () => {
    const input = portfolioRequest({ tie: true });
    input.policy.lanes = [{ id: "loop", maximumReferenceP95Ms: 20 }];
    const expected = ["candidate-b", "candidate-c"].sort((left, right) => {
      const leftDigest = digest(left);
      const rightDigest = digest(right);
      return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0;
    })[0];

    const report = createAgenticProfile(parseAgenticProfileRequest(input));
    assert.deepEqual(report.portfolios[0]?.selectedCandidateIds, [expected]);
  });
});
