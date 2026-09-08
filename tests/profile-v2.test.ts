import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AgenticBenchmarkRequest,
  parseAgenticProfileReportV2,
  parseAgenticProfileRequestV2,
  parseEvidenceManifest,
} from "../src/contracts/index.js";
import {
  createAgenticBenchmark,
  createAgenticProfileV2,
  decideEvidence,
  replayAgenticProfileV2,
  sealManifestArtifact,
  sha256Canonical,
} from "../src/core/index.js";

function digest(label: string): string {
  return sha256Canonical({ label });
}

type CandidateSpec = {
  id: string;
  targets: string[];
  sizeBytes?: number;
  warm?: number[];
  cold?: number[];
  warmFailure?: boolean;
  coldFailure?: boolean;
};

function complete(
  candidateId: string,
  candidateDigest: string,
  regime: "COLD" | "WARM",
  role: "WARMUP" | "MEASUREMENT",
  ordinal: number,
  totalUs: number,
) {
  return {
    candidateId,
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
    cpuTimeUs: Number.MAX_SAFE_INTEGER,
  };
}

function incomplete(
  candidateId: string,
  candidateDigest: string,
  regime: "COLD" | "WARM",
  ordinal: number,
) {
  return {
    candidateId,
    candidateDigest,
    regime,
    role: "MEASUREMENT" as const,
    ordinal,
    status: "INCOMPLETE" as const,
    outcome: "PROCESS_CRASH" as const,
    phases: null,
    totalUs: null,
    cpuTimeUs: null,
  };
}

function fixture(
  specs: CandidateSpec[],
  options: { minimum?: number; maximumSelected?: number } = {},
) {
  const targetIds = [...new Set(["required", ...specs.flatMap((spec) => spec.targets)])].sort();
  const worlds = [
    { id: "reference", kind: "REFERENCE" as const, required: true, weight: 0 },
    ...targetIds.map((id, index) => ({
      id,
      kind: "TARGET" as const,
      required: id === "required",
      weight: index + 1,
    })),
    { id: "neutral", kind: "NEUTRAL" as const, required: true, weight: 0 },
  ];
  const manifest = parseEvidenceManifest(
    sealManifestArtifact({
      ...decideEvidence({
        schemaVersion: "1.0.0",
        repositoryDigest: digest("repository"),
        evidenceContext: {
          engine: { name: "testforge", version: "0.1.0" },
          adapter: {
            name: "node-test",
            version: process.versions.node,
            configuration: { kind: "node-test" as const, executable: process.execPath },
          },
          execution: {
            isolation: "UNSANDBOXED" as const,
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
          maximumSelectedCandidates: options.maximumSelected ?? specs.length,
          acceptedTargetOutcomes: ["ASSERTION_FAILURE" as const],
        },
        worlds,
        candidates: specs.map((spec) => ({
          id: spec.id,
          digest: digest(spec.id),
          sizeBytes: spec.sizeBytes ?? 100,
        })),
        observations: worlds.flatMap((world) => [
          {
            runId: `control:${world.id}:1`,
            candidateId: null,
            worldId: world.id,
            attempt: 1,
            outcome: "PASS" as const,
            testsDiscovered: 1,
            candidateTestsDiscovered: 0,
            attributed: false,
          },
          ...specs.map((spec) => ({
            runId: `${spec.id}:${world.id}:1`,
            candidateId: spec.id,
            worldId: world.id,
            attempt: 1,
            outcome:
              world.kind === "TARGET" &&
              (world.id === "required" || spec.targets.includes(world.id))
                ? ("ASSERTION_FAILURE" as const)
                : ("PASS" as const),
            testsDiscovered: 2,
            candidateTestsDiscovered: 1,
            attributed: true,
          })),
        ]),
      }),
      adapter: { kind: "node-test" as const },
      isolation: {
        kind: "trusted-local" as const,
        level: "UNSANDBOXED" as const,
        acknowledgedUnsafeExecution: true as const,
      },
      limitations: ["fixture"],
    }),
  );
  const selected = manifest.decision.selectedCandidateIds;
  const measured = 3;
  const runs: AgenticBenchmarkRequest["runs"] = [];
  for (const id of selected) {
    const spec = specs.find((item) => item.id === id) as CandidateSpec;
    const candidateDigest = manifest.candidates.find((candidate) => candidate.id === id)
      ?.digest as string;
    const cold = spec.cold ?? [1, 2, 3];
    const warm = spec.warm ?? [10, 20, 30];
    for (let index = 0; index < measured; index += 1) {
      runs.push(
        spec.coldFailure && index === measured - 1
          ? incomplete(id, candidateDigest, "COLD", index + 1)
          : complete(id, candidateDigest, "COLD", "MEASUREMENT", index + 1, cold[index] as number),
      );
    }
    runs.push(complete(id, candidateDigest, "WARM", "WARMUP", 1, 999_999));
    for (let index = 0; index < measured; index += 1) {
      runs.push(
        spec.warmFailure && index === measured - 1
          ? incomplete(id, candidateDigest, "WARM", index + 1)
          : complete(id, candidateDigest, "WARM", "MEASUREMENT", index + 1, warm[index] as number),
      );
    }
  }
  return createAgenticBenchmark({
    schemaVersion: "1.0.0",
    sourceManifest: manifest,
    referenceWorldId: "reference",
    policy: {
      benchmarkVersion: "1.0.0",
      minimumMeasuredSamplesPerRegime: options.minimum ?? measured,
      coldMeasuredSamples: measured,
      warmupSamples: 1,
      warmMeasuredSamples: measured,
      maximumExecutions: Math.max(1, selected.length * (measured * 2 + 1)),
    },
    protocol: {
      protocolVersion: "1.0.0",
      clock: "MONOTONIC",
      unit: "MICROSECOND",
      quantile: "NEAREST_RANK",
      phases: ["PREPARATION", "STARTUP", "COMPILE_OR_COLLECTION", "EXECUTION"],
      coldDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RESET_DECLARED_CACHES",
      warmDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RETAIN_DECLARED_CACHES",
    },
    fingerprint: {
      environmentId: "fixture-environment",
      os: { platform: "win32", release: "fixture", arch: "x64" },
      cpu: { arch: "x64", model: "fixture", logicalCores: 8 },
      logicalCpuLimit: null,
      memoryLimitBytes: null,
      executionBoundary: "UNSANDBOXED",
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
    runs,
  });
}

function request(benchmark = fixture([{ id: "candidate", targets: ["target"] }]), budget = 30) {
  return {
    schemaVersion: "2.0.0" as const,
    benchmarkArtifact: benchmark,
    policy: {
      profileVersion: "2.0.0" as const,
      profileId: "hardening-v2",
      mode: "HARDENING" as const,
      requiredComparisonScopeDigest: benchmark.comparisonScopeDigest,
      costBasis: {
        regime: "WARM" as const,
        measure: "WALL" as const,
        aggregation: "TOTAL" as const,
        statistic: "P95" as const,
        unit: "MICROSECOND" as const,
        portfolioAggregation: "SUM_OF_INDIVIDUAL_P95" as const,
      },
      lanes: [{ id: "fast", maximumWarmTotalWallP95Us: budget }],
    },
  };
}

function reseal<T extends { reportDigest: string }>(report: T): T {
  const { reportDigest: _digest, ...projection } = report;
  return { ...report, reportDigest: sha256Canonical(projection) };
}

describe("Agentic Test Profile v2", () => {
  it("consumes only replay-valid benchmark evidence and preserves VERIFIED", () => {
    const input = request();
    const sourceDecision = structuredClone(input.benchmarkArtifact.sourceManifest.decision);
    const report = createAgenticProfileV2(parseAgenticProfileRequestV2(input));
    assert.deepEqual(report.benchmarkArtifact.sourceManifest.decision, sourceDecision);
    assert.equal(report.status, "QUALIFIED");
    assert.equal(replayAgenticProfileV2(report).valid, true);

    const invalid = request();
    invalid.benchmarkArtifact.artifactDigest = digest("tampered");
    assert.throws(() => createAgenticProfileV2(invalid), /BENCHMARK_INVALID/);
  });

  it("produces replay-valid scope mismatch without frontier or portfolio", () => {
    const input = request();
    input.policy.requiredComparisonScopeDigest = digest("other-scope");
    const report = createAgenticProfileV2(input);
    assert.equal(report.status, "COMPARISON_SCOPE_MISMATCH");
    assert.deepEqual(report.portfolios, []);
    assert.deepEqual(
      report.candidates.map((candidate) => candidate.paretoStatus),
      ["NOT_EVALUATED"],
    );
    assert.equal(replayAgenticProfileV2(report).valid, true);
  });

  it("uses only warm total wall p95 despite extreme cold, p50, phases, CPU, and warmup", () => {
    const benchmark = fixture([
      {
        id: "candidate",
        targets: ["target"],
        cold: [8_000_000, 8_000_001, 8_000_002],
        warm: [1, 2, 100],
      },
    ]);
    const report = createAgenticProfileV2(request(benchmark, 99));
    assert.equal(report.status, "BUDGET_MISSED");
    assert.equal(report.candidates[0]?.cost.p95Us, 100);
    assert.deepEqual(report.portfolios[0]?.selectedCandidateIds, []);
  });

  it("applies exact dominance and an inclusive budget boundary", () => {
    const benchmark = fixture([
      { id: "strong", targets: ["b", "c"], warm: [20, 20, 20] },
      { id: "weak", targets: ["a"], warm: [20, 20, 20] },
    ]);
    const report = createAgenticProfileV2(request(benchmark, 20));
    assert.equal(
      report.candidates.find((candidate) => candidate.id === "strong")?.paretoStatus,
      "ON_FRONTIER",
    );
    assert.equal(
      report.candidates.find((candidate) => candidate.id === "weak")?.paretoStatus,
      "DOMINATED",
    );
    assert.deepEqual(report.portfolios[0]?.selectedCandidateIds, ["strong"]);
    assert.equal(report.portfolios[0]?.sumIndividualWarmTotalWallP95Us, 20);
  });

  it("blocks the cohort on warm failure or insufficiency but not cold failure", () => {
    const failed = createAgenticProfileV2(
      request(fixture([{ id: "candidate", targets: ["target"], warmFailure: true }])),
    );
    assert.equal(failed.status, "OBSERVED_BENCHMARK_FAILURE");
    assert.deepEqual(failed.portfolios, []);
    assert.equal(failed.candidates[0]?.cost.p95Us, null);

    const insufficient = createAgenticProfileV2(
      request(fixture([{ id: "candidate", targets: ["target"] }], { minimum: 4 })),
    );
    assert.equal(insufficient.status, "INSUFFICIENT_TIMING_EVIDENCE");
    assert.deepEqual(insufficient.portfolios, []);

    const coldFailure = createAgenticProfileV2(
      request(fixture([{ id: "candidate", targets: ["target"], coldFailure: true }])),
    );
    assert.equal(coldFailure.status, "QUALIFIED");
    assert.equal(coldFailure.candidates[0]?.cost.p95Us, 30);
  });

  it("is invariant to benchmark raw-run permutations", () => {
    const benchmark = fixture([
      { id: "a", targets: ["a"], warm: [4, 4, 4] },
      { id: "b", targets: ["b"], warm: [5, 5, 5] },
    ]);
    const left = createAgenticProfileV2(request(benchmark, 9));
    const normalized = createAgenticBenchmark({
      schemaVersion: "1.0.0",
      sourceManifest: benchmark.sourceManifest,
      referenceWorldId: benchmark.referenceWorldId,
      policy: benchmark.policy,
      protocol: benchmark.protocol,
      fingerprint: benchmark.fingerprint,
      runs: [...benchmark.runs].reverse(),
    });
    assert.deepEqual(left, createAgenticProfileV2(request(normalized, 9)));
  });

  it("uses BigInt ratio ordering near safe limits and prioritizes zero cost gain", () => {
    const near = Number.MAX_SAFE_INTEGER - 100;
    const benchmark = fixture([
      { id: "zero", targets: ["z"], warm: [0, 0, 0], sizeBytes: 500 },
      { id: "large-a", targets: ["a"], warm: [near - 2, near - 2, near - 2] },
      { id: "large-b", targets: ["b"], warm: [near - 1, near - 1, near - 1] },
    ]);
    const report = createAgenticProfileV2(request(benchmark, near));
    assert.equal(report.portfolios[0]?.steps[0]?.candidateId, "zero");
    assert.equal(report.portfolios[0]?.steps[1]?.candidateId, "large-b");
    assert.ok((report.portfolios[0]?.sumIndividualWarmTotalWallP95Us ?? 0) <= near);
  });

  it("recomputes marginal gain and omits a candidate made redundant by incumbents", () => {
    const benchmark = fixture([
      { id: "expensive", targets: ["a", "b"], warm: [100, 100, 100] },
      { id: "left", targets: ["a", "c"], warm: [1, 1, 1] },
      { id: "right", targets: ["b", "d"], warm: [1, 1, 1] },
    ]);
    const steps = createAgenticProfileV2(request(benchmark, 102)).portfolios[0]?.steps ?? [];
    assert.equal(steps.length, 2);
    assert.equal(
      steps.some((step) => step.candidateId === "expensive"),
      false,
    );
    assert.equal(steps[0]?.marginalTargetIds.includes("required"), true);
    assert.equal(steps[1]?.marginalTargetIds.includes("required"), false);
    assert.deepEqual(
      steps.map((step) => step.ordinal),
      [1, 2],
    );
  });

  it("states selected-only universe and lists excluded eligible candidates", () => {
    const benchmark = fixture(
      [
        { id: "a", targets: ["a"] },
        { id: "b", targets: ["b"] },
        { id: "redundant", targets: ["a"] },
      ],
      { maximumSelected: 2 },
    );
    const report = createAgenticProfileV2(request(benchmark, 100));
    const eligible = benchmark.sourceManifest.candidates
      .filter((candidate) => candidate.status === "ELIGIBLE")
      .map((candidate) => candidate.id)
      .sort();
    assert.deepEqual(
      [
        ...report.candidateUniverse.candidateIds,
        ...report.candidateUniverse.excludedEligibleCandidateIds,
      ].sort(),
      eligible,
    );
    assert.ok(report.candidateUniverse.excludedEligibleCandidateIds.length > 0);
  });

  it("rejects invented metrics and detects semantic tampering after redigest", () => {
    const input = request() as unknown as Record<string, unknown>;
    (input.policy as Record<string, unknown>).apfdc = 1;
    assert.throws(() => parseAgenticProfileRequestV2(input), /REQUEST_INVALID/);

    const report = createAgenticProfileV2(request());
    (report.candidates[0] as unknown as Record<string, unknown>).compositeStabilityScore = 1;
    assert.throws(() => parseAgenticProfileReportV2(report), /REPORT_INVALID/);

    const valid = createAgenticProfileV2(request());
    const firstCandidate = valid.candidates[0];
    assert.ok(firstCandidate !== undefined);
    valid.candidates[0] = { ...firstCandidate, paretoStatus: "DOMINATED" };
    const replay = replayAgenticProfileV2(reseal(valid));
    assert.equal(replay.reportDigestValid, true);
    assert.equal(replay.semanticsValid, false);
    assert.equal(replay.valid, false);
  });

  it("uses exact summed-cost naming and never calls it portfolio p95", () => {
    const serialized = JSON.stringify(createAgenticProfileV2(request()));
    assert.match(serialized, /sumIndividualWarmTotalWallP95Us/);
    assert.doesNotMatch(serialized, /portfolioP95|apfdc|APFDc/);
  });
});
