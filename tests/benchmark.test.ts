import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AgenticBenchmarkRequest,
  parseAgenticBenchmarkRequest,
  parseEvidenceManifest,
} from "../src/contracts/index.js";
import {
  createAgenticBenchmark,
  decideEvidence,
  replayAgenticBenchmark,
  sealManifestArtifact,
  sha256Canonical,
} from "../src/core/index.js";

function digest(label: string): string {
  return sha256Canonical({ label });
}

function sourceManifest(options: { strong?: boolean; secondCandidate?: boolean } = {}) {
  const strong = options.strong ?? true;
  const candidates = [
    { id: "candidate", digest: digest("candidate"), sizeBytes: 100 },
    ...(options.secondCandidate ? [{ id: "other", digest: digest("other"), sizeBytes: 200 }] : []),
  ];
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target", kind: "TARGET", required: true, weight: 10 },
    { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
  ];
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
    },
    ...candidates.map((candidate) => ({
      runId: `${candidate.id}:${world.id}:1`,
      candidateId: candidate.id,
      worldId: world.id,
      attempt: 1,
      outcome: world.kind === "TARGET" && strong ? "ASSERTION_FAILURE" : "PASS",
      testsDiscovered: 2,
      candidateTestsDiscovered: 1,
      attributed: true,
    })),
  ]);
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
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates,
    observations,
  });
  return parseEvidenceManifest(
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
  );
}

function completeRun(
  candidateDigest: string,
  regime: "COLD" | "WARM",
  role: "WARMUP" | "MEASUREMENT",
  ordinal: number,
  totalUs: number,
  cpuTimeUs?: number,
) {
  return {
    candidateId: "candidate",
    candidateDigest,
    regime,
    role,
    ordinal,
    status: "COMPLETE" as const,
    outcome: "PASS" as const,
    phases: [
      { phase: "PREPARATION" as const, durationUs: 0 },
      { phase: "STARTUP" as const, durationUs: 0 },
      { phase: "COMPILE_OR_COLLECTION" as const, durationUs: 0 },
      { phase: "EXECUTION" as const, durationUs: totalUs },
    ],
    totalUs,
    ...(cpuTimeUs === undefined ? {} : { cpuTimeUs }),
  };
}

function benchmarkRequest(
  options: { minimum?: number; offset?: number } = {},
): AgenticBenchmarkRequest {
  const source = sourceManifest();
  const candidateDigest = source.candidates[0]?.digest as string;
  const offset = options.offset ?? 0;
  return {
    schemaVersion: "1.0.0" as const,
    sourceManifest: source,
    referenceWorldId: "reference",
    policy: {
      benchmarkVersion: "1.0.0" as const,
      minimumMeasuredSamplesPerRegime: options.minimum ?? 5,
      coldMeasuredSamples: 5,
      warmupSamples: 1,
      warmMeasuredSamples: 5,
      maximumExecutions: 11,
    },
    protocol: {
      protocolVersion: "1.0.0" as const,
      clock: "MONOTONIC" as const,
      unit: "MICROSECOND" as const,
      quantile: "NEAREST_RANK" as const,
      phases: ["PREPARATION", "STARTUP", "COMPILE_OR_COLLECTION", "EXECUTION"] as const,
      coldDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RESET_DECLARED_CACHES" as const,
      warmDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RETAIN_DECLARED_CACHES" as const,
    },
    fingerprint: {
      environmentId: "local-machine-class-a",
      os: { platform: "win32", release: "fixture", arch: "x64" },
      cpu: { arch: "x64", model: "fixture-cpu", logicalCores: 8 },
      logicalCpuLimit: null,
      memoryLimitBytes: null,
      executionBoundary: "UNSANDBOXED" as const,
      tools: [
        {
          role: "runtime",
          name: "node",
          version: process.versions.node,
          digest: digest("node"),
          configurationDigest: digest("node-config"),
        },
      ],
      dependencyGraphDigest: digest("dependencies"),
      phaseReporterDigest: digest("reporter"),
    },
    runs: [
      ...[1, 2, 3, 4, 100].map((value, index) =>
        completeRun(candidateDigest, "COLD", "MEASUREMENT", index + 1, value + offset),
      ),
      completeRun(candidateDigest, "WARM", "WARMUP", 1, 50 + offset),
      ...[10, 20, 30, 40, 50].map((value, index) =>
        completeRun(candidateDigest, "WARM", "MEASUREMENT", index + 1, value + offset),
      ),
    ],
  };
}

function resealArtifact<T extends { artifactDigest: string }>(artifact: T): T {
  const { artifactDigest: _artifactDigest, ...projection } = artifact;
  return { ...artifact, artifactDigest: sha256Canonical(projection) };
}

type CompleteBenchmarkRun = Extract<
  AgenticBenchmarkRequest["runs"][number],
  { status: "COMPLETE" }
>;

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined);
  return item;
}

describe("Agentic Benchmark Artifact v1", () => {
  it("keeps the VERIFIED source verdict unchanged and uses nearest-rank quantiles", () => {
    const request = benchmarkRequest();
    const sourceDecision = structuredClone(request.sourceManifest.decision);
    const artifact = createAgenticBenchmark(request);

    assert.deepEqual(artifact.sourceManifest.decision, sourceDecision);
    assert.equal(artifact.sourceManifest.decision.status, "VERIFIED");
    const cold = artifact.summaries.find((summary) => summary.regime === "COLD");
    assert.equal(cold?.wall.total?.p50Us, 3);
    assert.equal(cold?.wall.total?.p95Us, 100);
    assert.equal(replayAgenticBenchmark(artifact).valid, true);
  });

  it("rejects invalid, non-VERIFIED, unselected, and digest-mismatched subjects", () => {
    const invalid = benchmarkRequest();
    invalid.sourceManifest.artifactDigest = digest("tampered");
    assert.throws(() => createAgenticBenchmark(invalid), /AGENTIC_BENCHMARK_SOURCE_INVALID/);

    const nonVerified = benchmarkRequest();
    nonVerified.sourceManifest = sourceManifest({ strong: false });
    nonVerified.runs = [];
    assert.throws(
      () => createAgenticBenchmark(nonVerified),
      /AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID/,
    );

    const unselected = benchmarkRequest();
    unselected.sourceManifest = sourceManifest({ secondCandidate: true });
    const other = unselected.sourceManifest.candidates.find(
      (candidate) => candidate.id === "other",
    );
    assert.equal(other?.status, "ELIGIBLE");
    unselected.runs = unselected.runs.map((run) => ({
      ...run,
      candidateId: "other",
      candidateDigest: other?.digest as string,
    }));
    assert.throws(() => createAgenticBenchmark(unselected), /AGENTIC_BENCHMARK_SUBJECT_INVALID/);

    const mismatch = benchmarkRequest();
    mismatch.runs[0] = { ...itemAt(mismatch.runs, 0), candidateDigest: digest("wrong") };
    assert.throws(
      () => createAgenticBenchmark(mismatch),
      /AGENTIC_BENCHMARK_CANDIDATE_DIGEST_MISMATCH/,
    );

    const wrongReference = benchmarkRequest();
    wrongReference.referenceWorldId = "target";
    assert.throws(
      () => createAgenticBenchmark(wrongReference),
      /AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID/,
    );
  });

  it("is invariant to raw-run permutations", () => {
    const left = benchmarkRequest();
    const right = benchmarkRequest();
    right.runs.reverse();
    assert.deepEqual(createAgenticBenchmark(left), createAgenticBenchmark(right));
  });

  it("rejects duplicate, gapped, and otherwise non-contiguous ordinals", () => {
    for (const ordinal of [1, 7]) {
      const request = benchmarkRequest();
      request.runs[1] = { ...itemAt(request.runs, 1), ordinal };
      assert.throws(() => parseAgenticBenchmarkRequest(request), /ORDINALS_INVALID/);
    }
  });

  it("rejects cold warmups and warm measurements without the exact warmup plan", () => {
    const coldWarmup = benchmarkRequest();
    coldWarmup.runs[0] = { ...itemAt(coldWarmup.runs, 0), role: "WARMUP" };
    assert.throws(() => createAgenticBenchmark(coldWarmup), /COLD_WARMUP_FORBIDDEN/);

    const missingWarmup = benchmarkRequest();
    missingWarmup.runs = missingWarmup.runs.filter((run) => run.role !== "WARMUP");
    assert.throws(() => createAgenticBenchmark(missingWarmup), /RUN_PLAN_INVALID/);
  });

  it("enforces the execution budget and a privacy-preserving unique-role fingerprint", () => {
    const overBudget = benchmarkRequest();
    overBudget.policy.maximumExecutions = 10;
    assert.throws(() => createAgenticBenchmark(overBudget), /EXECUTION_BUDGET_EXCEEDED/);

    const duplicateRole = benchmarkRequest();
    duplicateRole.fingerprint.tools.push({ ...itemAt(duplicateRole.fingerprint.tools, 0) });
    assert.throws(() => createAgenticBenchmark(duplicateRole), /DUPLICATE_TOOL_ROLE/);

    const leakingField = structuredClone(benchmarkRequest()) as unknown as Record<string, unknown>;
    const fingerprint = leakingField.fingerprint as Record<string, unknown>;
    fingerprint.hostname = "forbidden-hostname";
    assert.throws(() => parseAgenticBenchmarkRequest(leakingField), /REQUEST_INVALID/);

    const ambiguousEnvironment = benchmarkRequest();
    ambiguousEnvironment.fingerprint.environmentId = "../host/path";
    assert.throws(() => parseAgenticBenchmarkRequest(ambiguousEnvironment), /REQUEST_INVALID/);
  });

  it("binds an explicit portable cold/warm protocol version", () => {
    const protocol = benchmarkRequest().protocol as unknown as Record<string, unknown>;
    assert.deepEqual(protocol, {
      protocolVersion: "1.0.0",
      clock: "MONOTONIC",
      unit: "MICROSECOND",
      quantile: "NEAREST_RANK",
      phases: ["PREPARATION", "STARTUP", "COMPILE_OR_COLLECTION", "EXECUTION"],
      coldDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RESET_DECLARED_CACHES",
      warmDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RETAIN_DECLARED_CACHES",
    });
  });

  it("reports insufficient samples without upgrading the regime", () => {
    const artifact = createAgenticBenchmark(benchmarkRequest({ minimum: 6 }));
    assert.deepEqual(
      artifact.summaries.map((summary) => summary.status),
      ["INSUFFICIENT_SAMPLES", "INSUFFICIENT_SAMPLES"],
    );
    assert.equal(replayAgenticBenchmark(artifact).valid, true);
  });

  it("rejects phase sum mismatches, fractions, and unsafe integers", () => {
    const sum = benchmarkRequest();
    sum.runs[0] = { ...(sum.runs[0] as CompleteBenchmarkRun), totalUs: 2 };
    assert.throws(() => createAgenticBenchmark(sum), /TIMING_INVALID/);

    const fraction = benchmarkRequest();
    fraction.runs[0] = { ...(fraction.runs[0] as CompleteBenchmarkRun), totalUs: 1.5 };
    assert.throws(() => createAgenticBenchmark(fraction), /REQUEST_INVALID/);

    const unsafe = benchmarkRequest();
    unsafe.runs[0] = {
      ...(unsafe.runs[0] as CompleteBenchmarkRun),
      totalUs: Number.MAX_SAFE_INTEGER + 1,
    };
    assert.throws(() => createAgenticBenchmark(unsafe), /REQUEST_INVALID/);
  });

  it("keeps failures visible and excludes them from quantiles", () => {
    const request = benchmarkRequest();
    request.runs[4] = {
      candidateId: "candidate",
      candidateDigest: request.runs[4]?.candidateDigest as string,
      regime: "COLD",
      role: "MEASUREMENT",
      ordinal: 5,
      status: "INCOMPLETE",
      outcome: "PROCESS_CRASH",
      phases: null,
      totalUs: null,
      cpuTimeUs: null,
    };
    const artifact = createAgenticBenchmark(request);
    const cold = artifact.summaries[0];
    assert.equal(cold?.status, "OBSERVED_RUN_FAILURE");
    assert.deepEqual(cold?.counters, {
      planned: 5,
      recorded: 5,
      accepted: 4,
      failed: 1,
      warmup: 0,
    });
    assert.equal(cold?.wall.total?.maximumUs, 4);
    assert.equal(replayAgenticBenchmark(artifact).valid, true);
  });

  it("distinguishes unavailable and partial CPU evidence without zero substitution", () => {
    const unavailable = createAgenticBenchmark(benchmarkRequest());
    assert.deepEqual(unavailable.summaries[0]?.cpu, {
      availability: "UNAVAILABLE",
      quantiles: null,
    });

    const partialRequest = benchmarkRequest();
    partialRequest.runs[0] = {
      ...(partialRequest.runs[0] as CompleteBenchmarkRun),
      cpuTimeUs: 1,
    };
    const partial = createAgenticBenchmark(partialRequest);
    assert.deepEqual(partial.summaries[0]?.cpu, {
      availability: "PARTIAL",
      quantiles: null,
    });
  });

  it("changes comparison scope when the declared fingerprint changes", () => {
    const left = createAgenticBenchmark(benchmarkRequest());
    const changed = benchmarkRequest();
    changed.fingerprint.environmentId = "local-machine-class-b";
    const right = createAgenticBenchmark(changed);
    assert.notEqual(left.comparisonScopeDigest, right.comparisonScopeDigest);
  });

  it("detects a tampered summary even when the artifact is re-digested", () => {
    const artifact = createAgenticBenchmark(benchmarkRequest());
    artifact.summaries[0] = {
      ...itemAt(artifact.summaries, 0),
      status: "INSUFFICIENT_SAMPLES",
    };
    const tampered = resealArtifact(artifact);
    const replay = replayAgenticBenchmark(tampered);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.summarySemanticsValid, false);
    assert.equal(replay.valid, false);
  });

  it("allows reruns in one comparison scope to differ while remaining replay-valid", () => {
    const left = createAgenticBenchmark(benchmarkRequest());
    const right = createAgenticBenchmark(benchmarkRequest({ offset: 1 }));
    assert.equal(left.comparisonScopeDigest, right.comparisonScopeDigest);
    assert.notEqual(left.artifactDigest, right.artifactDigest);
    assert.notDeepEqual(left.summaries, right.summaries);
    assert.equal(replayAgenticBenchmark(left).valid, true);
    assert.equal(replayAgenticBenchmark(right).valid, true);
  });
});
