import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

type IntegrationApi = {
  TestForge: new () => {
    analyze(root: string): Promise<any>;
    replay(manifest: unknown): {
      valid: boolean;
      schemaValid: boolean;
      decisionDigestValid: boolean;
      artifactDigestValid: boolean;
      decisionSemanticsValid: boolean;
    };
    profile(request: unknown): any;
    replayProfile(report: unknown): any;
    benchmark(request: unknown): any;
    replayBenchmark(artifact: unknown): any;
    profileV2(request: unknown): any;
    replayProfileV2(report: unknown): any;
  };
  runCli(
    argv: string[],
    io: {
      cwd: string;
      readStdin(): Promise<string>;
      writeStdout(text: string): void;
      writeStderr(text: string): void;
    },
  ): Promise<number>;
  createTestForgeServer(options?: {
    allowUnsafeExecution?: boolean;
    allowedRepositoryRoots?: string[];
  }): any;
  decideEvidence(input: unknown): any;
  sealManifestArtifact(input: unknown): any;
};

async function loadIntegration(): Promise<IntegrationApi> {
  try {
    const [
      { TestForge },
      { runCli },
      { createTestForgeServer },
      { decideEvidence, sealManifestArtifact },
    ] = await Promise.all([
      import("../src/sdk/index.js"),
      import("../src/cli.js"),
      import("../src/mcp/index.js"),
      import("../src/core/index.js"),
    ]);
    return {
      TestForge,
      runCli,
      createTestForgeServer,
      decideEvidence,
      sealManifestArtifact,
    } as IntegrationApi;
  } catch {
    return {
      TestForge: class {
        async analyze() {
          return { fileCount: -1 };
        }
        replay() {
          return {
            valid: false,
            schemaValid: false,
            decisionDigestValid: false,
            artifactDigestValid: false,
            decisionSemanticsValid: false,
          };
        }
        profile() {
          return undefined;
        }
        replayProfile() {
          return undefined;
        }
        benchmark() {
          return undefined;
        }
        replayBenchmark() {
          return undefined;
        }
        profileV2() {
          return undefined;
        }
        replayProfileV2() {
          return undefined;
        }
      },
      runCli: async () => 99,
      createTestForgeServer: () => undefined,
      decideEvidence: () => undefined,
      sealManifestArtifact: () => undefined,
    };
  }
}

const integration = await loadIntegration();
const temporaryDirectories: string[] = [];

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "testforge-integration-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","type":"module"}\n');
  await writeFile(path.join(root, "src", "index.js"), "export const ready = true;\n");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function captureIo(cwd: string) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      readStdin: async () => "",
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function verificationRequest(
  root: string,
  options: {
    acknowledgedUnsafeExecution?: boolean;
    candidatePath?: string;
    budgetOverrides?: Record<string, number>;
  } = {},
) {
  return {
    schemaVersion: "1.0.0",
    repository: { root, exclude: [] },
    adapter: {
      kind: "node-test",
      executable: process.execPath,
      baseTestFiles: ["base.test.js"],
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: options.acknowledgedUnsafeExecution ?? true,
      environmentAllowlist: [],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 6,
      maximumRepositoryFiles: 10_000,
      maximumRepositoryBytes: 10_000_000,
      maximumWorldOverlayBytes: 10_000_000,
      maximumCandidateBytes: 1_024,
      maximumTotalCandidateBytes: 1_024,
      timeoutMsPerExecution: 1_000,
      maximumOutputBytes: 1_024,
      ...options.budgetOverrides,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: "test",
        files: [],
      },
      { id: "target", kind: "TARGET", required: true, weight: 1, provenance: "test", files: [] },
      { id: "neutral", kind: "NEUTRAL", required: true, weight: 0, provenance: "test", files: [] },
    ],
    candidates: [
      {
        id: "candidate",
        files: [
          {
            path: options.candidatePath ?? "tests/candidates/candidate.test.js",
            content: "test('candidate', () => {});\n",
          },
        ],
      },
    ],
  };
}

function agenticProfileRequest() {
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target", kind: "TARGET", required: true, weight: 1 },
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
      durationMs: 1,
    },
    {
      runId: `candidate:${world.id}:1`,
      candidateId: "candidate",
      worldId: world.id,
      attempt: 1,
      outcome: world.kind === "TARGET" ? "ASSERTION_FAILURE" : "PASS",
      testsDiscovered: 2,
      candidateTestsDiscovered: 1,
      attributed: true,
      durationMs: world.kind === "REFERENCE" ? 10 : 1,
    },
  ]);
  const decided = integration.decideEvidence({
    schemaVersion: "1.0.0",
    repositoryDigest: `sha256:${"a".repeat(64)}`,
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: process.versions.node,
        configuration: { kind: "node-test" },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: [],
        budgets: {},
        candidateRoots: ["tests/candidates"],
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: "integration-test",
        digest: `sha256:${"b".repeat(64)}`,
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
    candidates: [{ id: "candidate", digest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 }],
    observations,
  });
  const manifest = integration.sealManifestArtifact({
    ...decided,
    adapter: { kind: "node-test" },
    isolation: {
      kind: "trusted-local",
      level: "UNSANDBOXED",
      acknowledgedUnsafeExecution: true,
    },
    limitations: ["integration fixture"],
  });
  return {
    schemaVersion: "1.0.0",
    manifest,
    policy: {
      profileVersion: "1.0.0",
      profileId: "integration/default",
      mode: "HARDENING",
      minimumTimingSamples: 1,
      lanes: [{ id: "loop", maximumReferenceP95Ms: 100 }],
    },
  };
}

function agenticBenchmarkRequest() {
  const sourceManifest = agenticProfileRequest().manifest;
  const candidateDigest = sourceManifest.candidates[0].digest;
  const completeRun = (
    regime: "COLD" | "WARM",
    role: "WARMUP" | "MEASUREMENT",
    ordinal: number,
    executionUs: number,
  ) => ({
    candidateId: "candidate",
    candidateDigest,
    regime,
    role,
    ordinal,
    status: "COMPLETE",
    outcome: "PASS",
    phases: [
      { phase: "PREPARATION", durationUs: 1 },
      { phase: "STARTUP", durationUs: 1 },
      { phase: "COMPILE_OR_COLLECTION", durationUs: 1 },
      { phase: "EXECUTION", durationUs: executionUs },
    ],
    totalUs: executionUs + 3,
  });
  return {
    schemaVersion: "1.0.0",
    sourceManifest,
    referenceWorldId: "reference",
    policy: {
      benchmarkVersion: "1.0.0",
      minimumMeasuredSamplesPerRegime: 1,
      coldMeasuredSamples: 1,
      warmupSamples: 1,
      warmMeasuredSamples: 1,
      maximumExecutions: 3,
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
      environmentId: "integration-environment",
      os: { platform: "fixture", release: "fixture", arch: "x64" },
      cpu: { arch: "x64", model: "fixture", logicalCores: 1 },
      logicalCpuLimit: 1,
      memoryLimitBytes: null,
      executionBoundary: "UNSANDBOXED",
      tools: [
        {
          role: "runtime",
          name: "node",
          version: process.versions.node,
          digest: `sha256:${"d".repeat(64)}`,
          configurationDigest: `sha256:${"e".repeat(64)}`,
        },
      ],
      dependencyGraphDigest: `sha256:${"f".repeat(64)}`,
      phaseReporterDigest: `sha256:${"1".repeat(64)}`,
    },
    runs: [
      completeRun("COLD", "MEASUREMENT", 1, 100),
      completeRun("WARM", "WARMUP", 1, 50),
      completeRun("WARM", "MEASUREMENT", 1, 20),
    ],
  };
}

function agenticProfileV2Request() {
  const benchmarkArtifact = new integration.TestForge().benchmark(agenticBenchmarkRequest());
  return {
    schemaVersion: "2.0.0",
    benchmarkArtifact,
    policy: {
      profileVersion: "2.0.0",
      profileId: "integration/hardening-v2",
      mode: "HARDENING",
      requiredComparisonScopeDigest: benchmarkArtifact.comparisonScopeDigest,
      costBasis: {
        regime: "WARM",
        measure: "WALL",
        aggregation: "TOTAL",
        statistic: "P95",
        unit: "MICROSECOND",
        portfolioAggregation: "SUM_OF_INDIVIDUAL_P95",
      },
      lanes: [{ id: "fast", maximumWarmTotalWallP95Us: 23 }],
    },
  };
}

describe("SDK facade", () => {
  it("exposes repository analysis without any model or harness dependency", async () => {
    const root = await fixtureRepository();
    const sdk = new integration.TestForge();

    const analysis = await sdk.analyze(root);

    assert.equal(analysis.fileCount, 2);
    assert.match(analysis.repositoryDigest, /^sha256:[a-f0-9]{64}$/);
  });

  it("replays both the deterministic decision seal and the complete artifact seal", () => {
    const observations = ["reference", "target", "neutral"].flatMap((worldId) => [
      {
        runId: `control:${worldId}:1`,
        candidateId: null,
        worldId,
        attempt: 1,
        outcome: "PASS",
        testsDiscovered: 1,
        candidateTestsDiscovered: 0,
        attributed: false,
        durationMs: 1,
      },
      {
        runId: `candidate:${worldId}:1`,
        candidateId: "candidate",
        worldId,
        attempt: 1,
        outcome: worldId === "target" ? "ASSERTION_FAILURE" : "PASS",
        testsDiscovered: 2,
        candidateTestsDiscovered: 1,
        attributed: true,
        durationMs: 1,
      },
    ]);
    const manifest = integration.decideEvidence({
      schemaVersion: "1.0.0",
      repositoryDigest: `sha256:${"a".repeat(64)}`,
      evidenceContext: {
        engine: { name: "testforge", version: "0.1.0" },
        adapter: {
          name: "node-test",
          version: process.versions.node,
          configuration: { kind: "node-test" },
        },
        execution: {
          isolation: "UNSANDBOXED",
          environmentAllowlist: [],
          budgets: {},
          candidateRoots: ["tests/candidates"],
        },
        worlds: ["reference", "target", "neutral"].map((id) => ({
          id,
          provenance: "integration-test",
          digest: `sha256:${"b".repeat(64)}`,
        })),
      },
      policy: {
        policyVersion: "1.0.0",
        requiredAttempts: 1,
        minimumTargetWeightPermille: 1_000,
        maximumSelectedCandidates: 1,
        acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
      },
      worlds: [
        { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
        { id: "target", kind: "TARGET", required: true, weight: 1 },
        { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
      ],
      candidates: [{ id: "candidate", digest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 }],
      observations,
    });
    const completeManifest = {
      ...manifest,
      adapter: { kind: "node-test" },
      isolation: {
        kind: "trusted-local",
        level: "UNSANDBOXED",
        acknowledgedUnsafeExecution: true,
      },
      limitations: ["integration fixture"],
    };
    completeManifest.observations[0].durationMs = 2;

    const replay = new integration.TestForge().replay(completeManifest);

    assert.deepEqual(replay, {
      valid: false,
      schemaValid: true,
      decisionDigestValid: true,
      artifactDigestValid: false,
      decisionSemanticsValid: true,
    });
  });

  it("rejects an out-of-schema manifest before semantic replay", () => {
    assert.deepEqual(new integration.TestForge().replay({}), {
      valid: false,
      schemaValid: false,
      decisionDigestValid: false,
      artifactDigestValid: false,
      decisionSemanticsValid: false,
    });
  });

  it("derives and replays a self-contained agentic test profile", () => {
    const sdk = new integration.TestForge();
    const report = sdk.profile(agenticProfileRequest());

    assert.equal(report.status, "QUALIFIED");
    assert.equal(report.candidates[0].bestLaneId, "loop");
    assert.equal(sdk.replayProfile(report).valid, true);
  });

  it("derives and replays a self-contained agentic benchmark", () => {
    const sdk = new integration.TestForge();
    const artifact = sdk.benchmark(agenticBenchmarkRequest());

    assert.equal(artifact.summaries[0].wall.total.p95Us, 103);
    assert.equal(artifact.summaries[1].wall.total.p95Us, 23);
    assert.equal(sdk.replayBenchmark(artifact).valid, true);
  });

  it("derives and replays a benchmark-backed agentic profile v2", () => {
    const sdk = new integration.TestForge();
    const report = sdk.profileV2(agenticProfileV2Request());

    assert.equal(report.status, "QUALIFIED");
    assert.equal(report.candidates[0].cost.p95Us, 23);
    assert.equal(sdk.replayProfileV2(report).valid, true);
  });
});

describe("JSON CLI", () => {
  it("runs when its entry path traverses a directory link", async (context) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "testforge-linked-entry-"));
    temporaryDirectories.push(temporaryRoot);
    const linkedRoot = path.join(temporaryRoot, "project");
    try {
      await symlink(process.cwd(), linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code))
      ) {
        context.skip(`directory links are unavailable: ${String(error.code)}`);
        return;
      }
      throw error;
    }

    const tsxEntrypoint = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const cliEntrypoint = path.join(linkedRoot, "src", "cli.ts");
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [tsxEntrypoint, cliEntrypoint, "schema", "replay-result", "--json"],
          {
            cwd: process.cwd(),
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.notEqual(result.stdout, "", "linked CLI entrypoint emitted no schema");
    assert.equal(
      JSON.parse(result.stdout).$id,
      "https://testforge.dev/schemas/replay-result.v1.json",
    );
  });

  it("prints one machine-readable schema document to stdout", async () => {
    const capture = captureIo(process.cwd());

    const code = await integration.runCli(["schema", "verification-request", "--json"], capture.io);

    assert.equal(code, 0);
    assert.equal(capture.stderr(), "");
    const document = JSON.parse(capture.stdout());
    assert.equal(document.$id, "https://testforge.dev/schemas/verification-request.v1.json");
  });

  it("analyzes a repository with clean JSON stdout", async () => {
    const root = await fixtureRepository();
    const capture = captureIo(root);

    const code = await integration.runCli(["analyze", root, "--json"], capture.io);

    assert.equal(code, 0);
    assert.equal(capture.stderr(), "");
    assert.equal(JSON.parse(capture.stdout()).fileCount, 2);
  });

  it("derives and replays an agentic profile through JSON stdin", async () => {
    const profileCapture = captureIo(process.cwd());
    profileCapture.io.readStdin = async () => JSON.stringify(agenticProfileRequest());

    const profileCode = await integration.runCli(["profile", "-", "--json"], profileCapture.io);
    assert.equal(profileCode, 0, profileCapture.stderr());
    const report = JSON.parse(profileCapture.stdout());
    assert.equal(report.status, "QUALIFIED");

    const replayCapture = captureIo(process.cwd());
    replayCapture.io.readStdin = async () => JSON.stringify(report);
    const replayCode = await integration.runCli(
      ["profile-replay", "-", "--json"],
      replayCapture.io,
    );
    assert.equal(replayCode, 0, replayCapture.stderr());
    assert.equal(JSON.parse(replayCapture.stdout()).valid, true);
  });

  it("derives and replays an agentic benchmark through JSON stdin", async () => {
    const benchmarkCapture = captureIo(process.cwd());
    benchmarkCapture.io.readStdin = async () => JSON.stringify(agenticBenchmarkRequest());
    const benchmarkCode = await integration.runCli(
      ["benchmark", "-", "--json"],
      benchmarkCapture.io,
    );
    assert.equal(benchmarkCode, 0, benchmarkCapture.stderr());
    const artifact = JSON.parse(benchmarkCapture.stdout());

    const replayCapture = captureIo(process.cwd());
    replayCapture.io.readStdin = async () => JSON.stringify(artifact);
    const replayCode = await integration.runCli(
      ["benchmark-replay", "-", "--json"],
      replayCapture.io,
    );
    assert.equal(replayCode, 0, replayCapture.stderr());
    assert.equal(JSON.parse(replayCapture.stdout()).valid, true);
  });

  it("derives and replays an agentic profile v2 through JSON stdin", async () => {
    const profileCapture = captureIo(process.cwd());
    profileCapture.io.readStdin = async () => JSON.stringify(agenticProfileV2Request());
    const profileCode = await integration.runCli(["profile-v2", "-", "--json"], profileCapture.io);
    assert.equal(profileCode, 0, profileCapture.stderr());
    const report = JSON.parse(profileCapture.stdout());
    assert.equal(report.status, "QUALIFIED");

    const replayCapture = captureIo(process.cwd());
    replayCapture.io.readStdin = async () => JSON.stringify(report);
    const replayCode = await integration.runCli(
      ["profile-v2-replay", "-", "--json"],
      replayCapture.io,
    );
    assert.equal(replayCode, 0, replayCapture.stderr());
    assert.equal(JSON.parse(replayCapture.stdout()).valid, true);
  });

  it("classifies a replay-invalid Profile v2 benchmark as invalid input", async () => {
    const request = agenticProfileV2Request();
    request.benchmarkArtifact.artifactDigest = `sha256:${"0".repeat(64)}`;
    const capture = captureIo(process.cwd());
    capture.io.readStdin = async () => JSON.stringify(request);

    const code = await integration.runCli(["profile-v2", "-", "--json"], capture.io);

    assert.equal(code, 4);
    assert.match(capture.stderr(), /AGENTIC_PROFILE_V2_BENCHMARK_INVALID/);
    assert.equal(capture.stdout(), "");
  });

  it("reports corpus readiness with the native deterministic exit code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "testforge-corpus-cli-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "public"), { recursive: true });
    await mkdir(path.join(root, "private"), { recursive: true });
    const capture = captureIo(process.cwd());

    const code = await integration.runCli(["corpus-status", root, "--json"], capture.io);

    assert.equal(code, 3, capture.stderr());
    assert.equal(JSON.parse(capture.stdout()).status, "NOT_READY");
  });

  it("uses a stable usage exit code for unknown commands", async () => {
    const capture = captureIo(process.cwd());

    const code = await integration.runCli(["unknown"], capture.io);

    assert.equal(code, 64);
    assert.match(capture.stderr(), /Usage: assertledger/);
    assert.match(capture.stderr(), /legacy alias: testforge/);
    assert.equal(capture.stdout(), "");
  });

  it("refuses trusted-local execution without the external authorization flag", async () => {
    const root = await fixtureRepository();
    const capture = captureIo(root);
    capture.io.readStdin = async () => JSON.stringify(verificationRequest(root));

    const code = await integration.runCli(["verify", "-", "--json"], capture.io);

    assert.equal(code, 4);
    assert.match(capture.stderr(), /--allow-unsafe-execution/);
    assert.equal(capture.stdout(), "");
  });

  it("uses the external authorization flag instead of JSON self-attestation", async () => {
    const root = await fixtureRepository();
    const capture = captureIo(root);
    capture.io.readStdin = async () =>
      JSON.stringify(
        verificationRequest(root, {
          acknowledgedUnsafeExecution: false,
          candidatePath: "../escaped.test.js",
        }),
      );

    const code = await integration.runCli(
      ["verify", "-", "--allow-unsafe-execution", "--json"],
      capture.io,
    );

    assert.equal(code, 4);
    assert.match(capture.stderr(), /FORBIDDEN_CANDIDATE_PATH/);
    assert.doesNotMatch(capture.stderr(), /UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED/);
  });

  it("classifies candidate path traversal as a validation error", async () => {
    const root = await fixtureRepository();
    const capture = captureIo(root);
    capture.io.readStdin = async () =>
      JSON.stringify(verificationRequest(root, { candidatePath: "../escaped.test.js" }));

    const code = await integration.runCli(
      ["verify", "-", "--allow-unsafe-execution", "--json"],
      capture.io,
    );

    assert.equal(code, 4);
    assert.match(capture.stderr(), /FORBIDDEN_CANDIDATE_PATH/);
  });

  for (const [code, budgetOverrides] of [
    ["REPOSITORY_FILE_BUDGET_EXCEEDED", { maximumRepositoryFiles: 1 }],
    ["REPOSITORY_BYTES_BUDGET_EXCEEDED", { maximumRepositoryBytes: 1 }],
  ] as const) {
    it(`classifies ${code} as a validation error`, async () => {
      const root = await fixtureRepository();
      const capture = captureIo(root);
      capture.io.readStdin = async () =>
        JSON.stringify(verificationRequest(root, { budgetOverrides }));

      const exitCode = await integration.runCli(
        ["verify", "-", "--allow-unsafe-execution", "--json"],
        capture.io,
      );

      assert.equal(exitCode, 4, capture.stderr());
      assert.equal(capture.stderr(), `${code}\n`);
      assert.equal(capture.stdout(), "");
    });

    it(`rejects ${code} before probing an unavailable runtime`, async () => {
      const root = await fixtureRepository();
      const capture = captureIo(root);
      const request = verificationRequest(root, { budgetOverrides });
      request.adapter.executable = path.join(root, "unavailable-node-runtime");
      capture.io.readStdin = async () => JSON.stringify(request);

      const exitCode = await integration.runCli(
        ["verify", "-", "--allow-unsafe-execution", "--json"],
        capture.io,
      );

      assert.equal(exitCode, 4, capture.stderr());
      assert.equal(capture.stderr(), `${code}\n`);
      assert.equal(capture.stdout(), "");
    });
  }

  it("rejects JSON input larger than 16 MiB with a stable validation error", async () => {
    const capture = captureIo(process.cwd());
    capture.io.readStdin = async () => `{"padding":"${"x".repeat(16 * 1024 * 1024)}"}`;

    const code = await integration.runCli(["replay", "-", "--json"], capture.io);

    assert.equal(code, 4);
    assert.equal(capture.stderr(), "JSON_INPUT_TOO_LARGE\n");
    assert.equal(capture.stdout(), "");
  });

  it("rejects an oversized JSON file before parsing it", async () => {
    const root = await fixtureRepository();
    await writeFile(path.join(root, "oversized.json"), Buffer.alloc(16 * 1024 * 1024 + 1));
    const capture = captureIo(root);

    const code = await integration.runCli(["replay", "oversized.json", "--json"], capture.io);

    assert.equal(code, 4);
    assert.equal(capture.stderr(), "JSON_INPUT_TOO_LARGE\n");
  });
});

describe("MCP facade", () => {
  async function connectServer(options: {
    allowUnsafeExecution?: boolean;
    allowedRepositoryRoots?: string[];
  }) {
    const server = integration.createTestForgeServer(options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "testforge-integration-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  }

  it("is read-only by default and does not register the execution tool", () => {
    const server = integration.createTestForgeServer();

    assert.ok(server);
    for (const tool of [
      "testforge_analyze",
      "testforge_benchmark",
      "testforge_benchmark_replay",
      "testforge_corpus_allocate",
      "testforge_corpus_allocation_replay",
      "testforge_profile",
      "testforge_profile_replay",
      "testforge_profile_v2",
      "testforge_profile_v2_replay",
      "testforge_replay",
      "testforge_schema",
    ]) {
      assert.ok(server.toolInputSchemaJson(tool), `missing MCP tool ${tool}`);
    }
    assert.equal(server.toolInputSchemaJson("testforge_verify"), undefined);
    assert.equal(server.toolInputSchemaJson("testforge_benchmark_acquire"), undefined);
  });

  it("registers verify only when the operator grants unsafe execution", () => {
    const schema = integration
      .createTestForgeServer({ allowUnsafeExecution: true })
      .toolInputSchemaJson("testforge_verify");

    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["request"]);
    assert.equal(schema.properties.allowUnsafeExecution, undefined);
    const requestReference = schema.properties.request.$ref as string;
    const requestDefinition = schema.$defs[requestReference.replace("#/$defs/", "")];
    assert.equal(requestDefinition.additionalProperties, false);
    assert.ok(requestDefinition.properties.schemaVersion);
    assert.ok(requestDefinition.properties.isolation);
  });

  it("publishes strict output schemas and all twenty-eight facade schema names", async () => {
    const { client } = await connectServer({ allowUnsafeExecution: true });
    const server = integration.createTestForgeServer({ allowUnsafeExecution: true });
    const listed = await client.listTools();
    for (const tool of [
      "testforge_analyze",
      "testforge_verify",
      "testforge_replay",
      "testforge_benchmark",
      "testforge_benchmark_replay",
      "testforge_benchmark_acquire",
      "testforge_benchmark_acquire_replay",
      "testforge_corpus_allocate",
      "testforge_corpus_allocation_replay",
      "testforge_profile",
      "testforge_profile_replay",
      "testforge_profile_v2",
      "testforge_profile_v2_replay",
    ]) {
      assert.ok(
        listed.tools.find((candidate) => candidate.name === tool)?.outputSchema,
        `missing output schema for ${tool}`,
      );
    }
    const replayInput = server.toolInputSchemaJson("testforge_replay");
    const manifestReference = replayInput.properties.manifest.$ref as string;
    const manifestDefinition = replayInput.$defs[manifestReference.replace("#/$defs/", "")];
    assert.ok(manifestDefinition.properties.artifactDigest);

    const schemaInput = server.toolInputSchemaJson("testforge_schema");
    assert.deepEqual(schemaInput.properties.name.enum, [
      "agentic-corpus-allocation-request",
      "agentic-corpus-allocation",
      "agentic-corpus-allocation-replay-result",
      "agentic-corpus-allocation-commitment",
      "agentic-corpus-allocation-reveal",
      "agentic-corpus-allocation-commitment-replay-result",
      "agentic-corpus-experiment-plan",
      "agentic-corpus-experiment-plan-replay-result",
      "agentic-corpus-experiment-request",
      "agentic-corpus-experiment-artifact",
      "agentic-corpus-experiment-replay-request",
      "agentic-corpus-experiment-replay-result",
      "agentic-benchmark-request",
      "agentic-benchmark-artifact",
      "agentic-benchmark-replay-result",
      "agentic-benchmark-acquisition-request",
      "agentic-benchmark-acquisition-result",
      "agentic-benchmark-acquisition-replay-result",
      "agentic-profile-request",
      "agentic-profile-report",
      "agentic-profile-replay-result",
      "agentic-profile-request-v2",
      "agentic-profile-report-v2",
      "agentic-profile-replay-result-v2",
      "verification-request",
      "repository-analysis",
      "evidence-manifest",
      "replay-result",
    ]);
    const profiled = await client.callTool({
      name: "testforge_profile",
      arguments: { request: agenticProfileRequest() },
    });
    assert.equal(profiled.isError, undefined);
    const replayed = await client.callTool({
      name: "testforge_profile_replay",
      arguments: { report: profiled.structuredContent },
    });
    assert.equal(replayed.isError, undefined);
    assert.equal((replayed.structuredContent as Record<string, unknown>).valid, true);
    const benchmarked = await client.callTool({
      name: "testforge_benchmark",
      arguments: { request: agenticBenchmarkRequest() },
    });
    assert.equal(benchmarked.isError, undefined);
    const benchmarkReplayed = await client.callTool({
      name: "testforge_benchmark_replay",
      arguments: { artifact: benchmarked.structuredContent },
    });
    assert.equal(benchmarkReplayed.isError, undefined);
    assert.equal((benchmarkReplayed.structuredContent as Record<string, unknown>).valid, true);
    const profiledV2 = await client.callTool({
      name: "testforge_profile_v2",
      arguments: { request: agenticProfileV2Request() },
    });
    assert.equal(profiledV2.isError, undefined);
    const replayedV2 = await client.callTool({
      name: "testforge_profile_v2_replay",
      arguments: { report: profiledV2.structuredContent },
    });
    assert.equal(replayedV2.isError, undefined);
    assert.equal((replayedV2.structuredContent as Record<string, unknown>).valid, true);
    await client.close();
  });

  it("confines repository access to operator-allowed real paths", async () => {
    const allowed = await fixtureRepository();
    const forbidden = await fixtureRepository();
    const { client, server } = await connectServer({
      allowUnsafeExecution: true,
      allowedRepositoryRoots: [allowed],
    });

    try {
      const accepted = await client.callTool({
        name: "testforge_analyze",
        arguments: { root: allowed },
      });
      assert.equal(accepted.isError, undefined);

      const rejected = await client.callTool({
        name: "testforge_analyze",
        arguments: { root: forbidden },
      });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /MCP_REPOSITORY_ROOT_FORBIDDEN/);

      const verifyRejected = await client.callTool({
        name: "testforge_verify",
        arguments: { request: verificationRequest(forbidden) },
      });
      assert.equal(verifyRejected.isError, true);
      assert.match(JSON.stringify(verifyRejected.content), /MCP_REPOSITORY_ROOT_FORBIDDEN/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
