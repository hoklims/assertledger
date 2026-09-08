import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  parseAgenticBenchmarkAcquisitionRequest,
  parseAgenticBenchmarkAcquisitionReplayResult,
  parseAgenticBenchmarkAcquisitionResult,
} from "../src/contracts/index.js";
import {
  createAgenticBenchmark,
  replayAgenticBenchmark,
  replayAgenticBenchmarkAcquisition,
  replayEvidenceManifest,
  sealManifestArtifact,
  sha256Canonical,
} from "../src/core/index.js";
import { acquireAgenticBenchmark, benchmarkCacheDirectoryKey } from "../src/engine/index.js";
import { runCli } from "../src/cli.js";
import { createTestForgeServer } from "../src/mcp/index.js";
import { TestForge } from "../src/sdk/index.js";

const temporaryDirectories: string[] = [];

async function withAliasedTemporaryDirectory<T>(run: () => Promise<T>): Promise<T> {
  const outer = await mkdtemp(path.join(os.tmpdir(), "assertledger-temp-alias-"));
  const realRoot = path.join(outer, "real");
  const aliasRoot = path.join(outer, "alias");
  await mkdir(realRoot);
  await symlink(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  const names = ["TEMP", "TMP", "TMPDIR"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = aliasRoot;
    return await run();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "testforge-acquire-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(path.join(root, "src", "value.js"), "export const value = 1;\n");
  await writeFile(
    path.join(root, "phase-adapter.mjs"),
    [
      'import { access, readFile, writeFile } from "node:fs/promises";',
      'const candidates = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");',
      'const implementation = await readFile("src/value.js", "utf8");',
      'const candidate = candidates.length ? await readFile(candidates[0], "utf8") : "";',
      'const killed = candidate.includes("value equals one") && implementation.includes("value = 2");',
      "if (!process.env.TESTFORGE_BENCHMARK_RESULT_FILE) {",
      '  const outcome = killed ? "ASSERTION_FAILURE" : "PASS";',
      '  await writeFile(process.env.TESTFORGE_RESULT_FILE, JSON.stringify({ protocolVersion: "1.0.0", outcome, testsDiscovered: candidates.length ? 2 : 1, candidateTestsDiscovered: candidates.length ? 1 : 0, attributed: candidates.length > 0 }));',
      "  process.exitCode = killed ? 1 : 0;",
      "} else {",
      '  const cacheMarker = process.env.TESTFORGE_BENCHMARK_CACHE_DIR + "/marker";',
      "  let cachePresent = true; try { await access(cacheMarker); } catch { cachePresent = false; }",
      "  const regime = process.env.TESTFORGE_BENCHMARK_REGIME;",
      "  const role = process.env.TESTFORGE_BENCHMARK_ROLE;",
      "  const ordinal = Number(process.env.TESTFORGE_BENCHMARK_ORDINAL);",
      '  const cacheValid = regime === "COLD" ? !cachePresent : role === "WARMUP" ? !cachePresent : cachePresent;',
      '  if (regime === "WARM" && role === "WARMUP") await writeFile(cacheMarker, "warm");',
      '  const report = cacheValid ? { protocolVersion: "1.0.0", outcome: "PASS", testsDiscovered: 1, candidateTestsDiscovered: 1, attributed: true, phases: [{ phase: "STARTUP", durationUs: 10 + ordinal }, { phase: "COMPILE_OR_COLLECTION", durationUs: 20 }, { phase: "EXECUTION", durationUs: 30 }], cpuTimeUs: null } : { protocolVersion: "1.0.0", outcome: "INFRA_ERROR", testsDiscovered: 0, candidateTestsDiscovered: 0, attributed: false, phases: null, cpuTimeUs: null };',
      "  await writeFile(process.env.TESTFORGE_BENCHMARK_RESULT_FILE, JSON.stringify(report));",
      "  process.exitCode = cacheValid ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function request(root: string) {
  return {
    schemaVersion: "1.0.0",
    verificationRequest: {
      schemaVersion: "1.0.0",
      repository: { root, exclude: [] },
      adapter: {
        kind: "testforge-command",
        executable: process.execPath,
        arguments: ["phase-adapter.mjs"],
        protocolVersion: "1.0.0",
      },
      isolation: {
        kind: "trusted-local",
        acknowledgedUnsafeExecution: true,
        environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
      },
      candidateRoots: ["tests/candidates"],
      budgets: {
        maximumCandidates: 2,
        maximumWorlds: 3,
        maximumExecutions: 9,
        maximumRepositoryFiles: 1_000,
        maximumRepositoryBytes: 10_000_000,
        maximumWorldOverlayBytes: 1_000_000,
        maximumCandidateBytes: 10_000,
        maximumTotalCandidateBytes: 20_000,
        timeoutMsPerExecution: 5_000,
        maximumOutputBytes: 65_536,
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
          provenance: "fixture:reference",
          files: [],
        },
        {
          id: "target",
          kind: "TARGET",
          required: true,
          weight: 1,
          provenance: "fixture:target",
          files: [{ path: "src/value.js", content: "export const value = 2;\n" }],
        },
        {
          id: "neutral",
          kind: "NEUTRAL",
          required: true,
          weight: 0,
          provenance: "fixture:neutral",
          files: [{ path: "src/value.js", content: "const one = 1; export { one as value };\n" }],
        },
      ],
      candidates: [
        {
          id: "strong",
          files: [{ path: "tests/candidates/strong.test.js", content: "// value equals one\n" }],
        },
        {
          id: "weak",
          files: [{ path: "tests/candidates/weak.test.js", content: "// type only\n" }],
        },
      ],
    },
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
    environment: { environmentId: "fixture", logicalCpuLimit: null, memoryLimitBytes: null },
    identityFiles: { phaseReporter: "phase-adapter.mjs", dependencyGraph: ["package-lock.json"] },
  } as const;
}

describe("benchmark acquisition", () => {
  it("resolves acquisition identity through an aliased temporary directory", async () => {
    await withAliasedTemporaryDirectory(async () => {
      const root = await fixtureRepository();
      const result = await acquireAgenticBenchmark(request(root));

      assert.equal(result.status, "COMPLETE");
      assert.equal(replayAgenticBenchmarkAcquisition(result).valid, true);
    });
  });

  it("acquires a replay-valid artifact only for source-selected eligible candidates", async () => {
    const root = await fixtureRepository();
    const result = await acquireAgenticBenchmark(request(root));

    assert.equal(result.status, "COMPLETE");
    assert.equal(replayEvidenceManifest(result.sourceManifest).valid, true);
    assert.equal(result.sourceManifest.decision.status, "VERIFIED");
    assert.ok(result.benchmarkArtifact);
    assert.equal(replayAgenticBenchmark(result.benchmarkArtifact).valid, true);
    assert.deepEqual(
      [
        ...new Set(
          result.benchmarkArtifact.runs.map((run: { candidateId: string }) => run.candidateId),
        ),
      ],
      ["strong"],
    );
    assert.ok(
      result.benchmarkArtifact.runs.every((run: { status: string }) => run.status === "COMPLETE"),
    );
    assert.match(result.requestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(result.resultDigest, /^sha256:[a-f0-9]{64}$/);
  });

  it("refuses node-test before executing any benchmark process", async () => {
    const root = await fixtureRepository();
    const value = request(root) as any;
    value.verificationRequest.adapter = {
      kind: "node-test",
      executable: process.execPath,
      baseTestFiles: ["base.test.js"],
    };
    await assert.rejects(
      acquireAgenticBenchmark(value),
      /BENCHMARK_PHASE_ACQUISITION_UNSUPPORTED_NODE_TEST/,
    );
  });

  it("does not benchmark a source campaign that is not VERIFIED", async () => {
    const root = await fixtureRepository();
    const value = request(root) as any;
    value.verificationRequest.policy.minimumTargetWeightPermille = 999;
    value.verificationRequest.candidates = [value.verificationRequest.candidates[1]];
    value.verificationRequest.budgets.maximumExecutions = 6;

    const result = await acquireAgenticBenchmark(value);
    assert.equal(result.status, "SOURCE_NOT_VERIFIED");
    assert.equal(result.benchmarkArtifact, null);
    assert.notEqual(result.sourceManifest.decision.status, "VERIFIED");
    const replay = replayAgenticBenchmarkAcquisition(result);
    assert.equal(replay.sourceManifestValid, true);
    assert.equal(replay.statusSemanticsValid, true);
    assert.equal(replay.resultDigestValid, true);
    assert.equal(replay.contextBindingValid, false);
    assert.equal(replay.valid, false);

    const redigest = (value: any) => {
      const { resultDigest: _ignored, ...projection } = value;
      return { ...projection, resultDigest: sha256Canonical(projection) };
    };
    for (const tamper of [
      (value: any) => {
        value.acquisitionContext.adapter.identityFilePath = "alternate-adapter.mjs";
      },
      (value: any) => {
        value.acquisitionContext.adapter.identityDigest = `sha256:${"0".repeat(64)}`;
      },
      (value: any) => {
        value.acquisitionContext.dependencyGraphDigest = `sha256:${"0".repeat(64)}`;
      },
    ]) {
      const changed = structuredClone(result) as any;
      tamper(changed);
      assert.equal(replayAgenticBenchmarkAcquisition(redigest(changed)).valid, false);
    }
  });

  it("turns missing, misordered, and overflowing phase evidence into non-proof runs", async () => {
    const rewrites = [
      (source: string) =>
        source.replace(
          "await writeFile(process.env.TESTFORGE_BENCHMARK_RESULT_FILE, JSON.stringify(report));",
          "// deliberately omit the benchmark report",
        ),
      (source: string) =>
        source.replace(
          'phases: [{ phase: "STARTUP", durationUs: 10 + ordinal }, { phase: "COMPILE_OR_COLLECTION", durationUs: 20 }, { phase: "EXECUTION", durationUs: 30 }]',
          'phases: [{ phase: "EXECUTION", durationUs: 1 }]',
        ),
      (source: string) => source.replace("durationUs: 30", "durationUs: Number.MAX_SAFE_INTEGER"),
    ];
    for (const rewrite of rewrites) {
      const root = await fixtureRepository();
      const adapterPath = path.join(root, "phase-adapter.mjs");
      const source = await (await import("node:fs/promises")).readFile(adapterPath, "utf8");
      await writeFile(adapterPath, rewrite(source));

      const result = await acquireAgenticBenchmark(request(root));
      assert.equal(result.sourceManifest.decision.status, "VERIFIED");
      assert.equal(result.status, "OBSERVED_RUN_FAILURE");
      assert.ok(result.benchmarkArtifact);
      assert.ok(
        result.benchmarkArtifact.runs.every(
          (run: { status: string }) => run.status === "INCOMPLETE",
        ),
      );
      assert.equal(result.sourceManifest.decision.status, "VERIFIED");
    }
  });

  it("binds adapter and dependency identity into the comparison scope and result", async () => {
    const root = await fixtureRepository();
    const first = await acquireAgenticBenchmark(request(root));
    await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
    const second = await acquireAgenticBenchmark(request(root));

    assert.notEqual(
      first.acquisitionContext.dependencyGraphDigest,
      second.acquisitionContext.dependencyGraphDigest,
    );
    assert.notEqual(
      first.benchmarkArtifact?.comparisonScopeDigest,
      second.benchmarkArtifact?.comparisonScopeDigest,
    );
    assert.notEqual(first.resultDigest, second.resultDigest);
  });

  it("strictly parses acquisition request and result contracts", async () => {
    const root = await fixtureRepository();
    assert.equal(parseAgenticBenchmarkAcquisitionRequest(request(root)).schemaVersion, "1.0.0");
    const result = await acquireAgenticBenchmark(request(root));
    assert.equal(parseAgenticBenchmarkAcquisitionResult(result).status, "COMPLETE");
    assert.throws(
      () => parseAgenticBenchmarkAcquisitionRequest({ ...request(root), extra: true }),
      /AGENTIC_BENCHMARK_ACQUISITION_REQUEST_INVALID/,
    );
  });

  it("replays every acquisition binding and rejects re-digested semantic tampering", async () => {
    const root = await fixtureRepository();
    const result = await acquireAgenticBenchmark(request(root));
    assert.equal(
      parseAgenticBenchmarkAcquisitionReplayResult(replayAgenticBenchmarkAcquisition(result)).valid,
      true,
    );

    const redigest = (value: any) => {
      const { resultDigest: _ignored, ...projection } = value;
      return { ...projection, resultDigest: sha256Canonical(projection) };
    };
    const reasonTamper = redigest({
      ...structuredClone(result),
      reasonCodes: ["INSUFFICIENT_SAMPLES"],
    });
    assert.equal(replayAgenticBenchmarkAcquisition(reasonTamper).statusSemanticsValid, false);
    const statusTamper = redigest({ ...structuredClone(result), status: "INSUFFICIENT_SAMPLES" });
    assert.equal(replayAgenticBenchmarkAcquisition(statusTamper).statusSemanticsValid, false);
    const contextTamper = structuredClone(result) as any;
    contextTamper.acquisitionContext.adapter.identityDigest = `sha256:${"0".repeat(64)}`;
    assert.equal(
      replayAgenticBenchmarkAcquisition(redigest(contextTamper)).contextBindingValid,
      false,
    );
    const identityPathTamper = structuredClone(result) as any;
    identityPathTamper.acquisitionContext.adapter.identityFilePath = "alternate-adapter.mjs";
    assert.equal(
      replayAgenticBenchmarkAcquisition(redigest(identityPathTamper)).contextBindingValid,
      false,
    );
    const sourceTamper = structuredClone(result) as any;
    sourceTamper.sourceManifest.limitations.push("tampered");
    assert.equal(
      replayAgenticBenchmarkAcquisition(redigest(sourceTamper)).sourceManifestValid,
      false,
    );

    const artifactTamper = structuredClone(result) as any;
    const alteredSource = sealManifestArtifact({
      ...artifactTamper.benchmarkArtifact.sourceManifest,
      observations: artifactTamper.benchmarkArtifact.sourceManifest.observations.map(
        (observation: any, index: number) =>
          index === 0 ? { ...observation, durationMs: observation.durationMs + 1 } : observation,
      ),
    });
    artifactTamper.benchmarkArtifact = createAgenticBenchmark({
      schemaVersion: "1.0.0",
      sourceManifest: alteredSource,
      referenceWorldId: artifactTamper.benchmarkArtifact.referenceWorldId,
      policy: artifactTamper.benchmarkArtifact.policy,
      protocol: artifactTamper.benchmarkArtifact.protocol,
      fingerprint: artifactTamper.benchmarkArtifact.fingerprint,
      runs: artifactTamper.benchmarkArtifact.runs,
    });
    assert.equal(
      replayAgenticBenchmarkAcquisition(redigest(artifactTamper)).sourceBindingValid,
      false,
    );

    const digestTamper = { ...structuredClone(result), resultDigest: `sha256:${"0".repeat(64)}` };
    assert.equal(replayAgenticBenchmarkAcquisition(digestTamper).resultDigestValid, false);
  });

  it("derives portable collision-proof private cache keys for case-colliding candidate IDs", () => {
    const upper = benchmarkCacheDirectoryKey("CaseCollision", 1, "WARM", 1);
    const lower = benchmarkCacheDirectoryKey("casecollision", 2, "WARM", 1);
    assert.notEqual(upper.toLowerCase(), lower.toLowerCase());
    assert.doesNotMatch(upper.toLowerCase(), /casecollision/u);
    assert.doesNotMatch(lower.toLowerCase(), /casecollision/u);
  });

  it("enforces outer snapshot repository budgets", async () => {
    const root = await fixtureRepository();
    const value = request(root) as any;
    value.verificationRequest.budgets.maximumRepositoryFiles = 1;
    await assert.rejects(acquireAgenticBenchmark(value), /REPOSITORY_FILE_BUDGET_EXCEEDED/);
  });

  it("exposes equivalent unsafe SDK, CLI, and MCP acquisition facades", async () => {
    const root = await fixtureRepository();
    const sdk = new TestForge() as any;
    const sdkResult = await sdk.acquireBenchmark(request(root));
    assert.equal(sdkResult.status, "COMPLETE");
    assert.equal(sdk.replayBenchmarkAcquisition(sdkResult).valid, true);

    let stdout = "";
    let stderr = "";
    let stdin = JSON.stringify(request(root));
    const io = {
      cwd: root,
      readStdin: async () => stdin,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    };
    assert.equal(await runCli(["benchmark-acquire", "-", "--json"], io), 4);
    assert.match(stderr, /--allow-unsafe-execution/);
    stdout = "";
    stderr = "";
    assert.equal(
      await runCli(["benchmark-acquire", "-", "--allow-unsafe-execution", "--json"], io),
      0,
      stderr,
    );
    const cliResult = JSON.parse(stdout);
    assert.equal(cliResult.status, "COMPLETE");
    stdout = "";
    stdin = JSON.stringify(cliResult);
    assert.equal(await runCli(["benchmark-acquire-replay", "-", "--json"], io), 0);
    assert.equal(JSON.parse(stdout).valid, true);

    const disabledServer = createTestForgeServer({ allowedRepositoryRoots: [root] });
    const disabledPair = InMemoryTransport.createLinkedPair();
    await disabledServer.connect(disabledPair[1]);
    const disabledClient = new Client({ name: "test", version: "1.0.0" });
    await disabledClient.connect(disabledPair[0]);
    assert.ok(
      !(await disabledClient.listTools()).tools.some(
        (tool) => tool.name === "testforge_benchmark_acquire",
      ),
    );
    const replayed = await disabledClient.callTool({
      name: "testforge_benchmark_acquire_replay",
      arguments: { result: sdkResult },
    });
    assert.equal((replayed.structuredContent as Record<string, unknown>).valid, true);
    await disabledClient.close();
    await disabledServer.close();

    const server = createTestForgeServer({
      allowUnsafeExecution: true,
      allowedRepositoryRoots: [root],
    });
    const pair = InMemoryTransport.createLinkedPair();
    await server.connect(pair[1]);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(pair[0]);
    const acquired = await client.callTool({
      name: "testforge_benchmark_acquire",
      arguments: { request: request(root) },
    });
    assert.equal(acquired.isError, undefined);
    assert.equal((acquired.structuredContent as Record<string, unknown>).status, "COMPLETE");
    await client.close();
    await server.close();
  });
});
