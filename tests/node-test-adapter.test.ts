import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { replayEvidenceManifest } from "../src/core/index.js";
import { runProcess, verifyCampaign } from "../src/engine/index.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-node-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(root, "src", "subject.js"), "export const subject = () => true;\n");
  await writeFile(
    path.join(root, "tests", "base.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("base", () => assert.equal(1, 1));',
      "",
    ].join("\n"),
  );
  return root;
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

function request(
  root: string,
  candidateContent: string,
  timeoutMsPerExecution = 5_000,
  requiredAttempts = 1,
) {
  return {
    schemaVersion: "1.0.0",
    repository: { root, exclude: ["node_modules", ".git", ".testforge"] },
    adapter: {
      kind: "node-test" as const,
      executable: process.execPath,
      baseTestFiles: ["tests/base.test.js"],
    },
    isolation: {
      kind: "trusted-local" as const,
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 6 * requiredAttempts,
      maximumRepositoryFiles: 1_000,
      maximumRepositoryBytes: 10_000_000,
      maximumWorldOverlayBytes: 10_000,
      maximumCandidateBytes: 10_000,
      maximumTotalCandidateBytes: 10_000,
      timeoutMsPerExecution,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE" as const,
        required: true,
        weight: 0,
        provenance: "fixture:reference",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET" as const,
        required: true,
        weight: 1,
        provenance: "fixture:target",
        files: [{ path: "src/subject.js", content: "export const subject = () => false;\n" }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL" as const,
        required: true,
        weight: 0,
        provenance: "fixture:neutral",
        files: [],
      },
    ],
    candidates: [
      {
        id: "candidate",
        files: [{ path: "tests/candidates/candidate.test.js", content: candidateContent }],
      },
    ],
  };
}

interface NodeObservation {
  candidateId: string | null;
  worldId: string;
  attempt: number;
  outcome: string;
  attributed: boolean;
  candidateTestsDiscovered: number;
}

interface NodeManifest {
  decision: { status: string };
  observations: NodeObservation[];
  evidenceContext: {
    adapter: {
      configuration: {
        profile: {
          capabilities: { detectsCollectionFailure: boolean; detectsCompileFailure: boolean };
        };
        runtimePreflight: Record<string, unknown>;
      };
    };
  };
}

async function verifyNodeCampaign(value: unknown): Promise<NodeManifest> {
  return (await verifyCampaign(value)) as NodeManifest;
}

function candidateObservations(manifest: NodeManifest) {
  return manifest.observations.filter(
    (observation: { candidateId: string | null }) => observation.candidateId === "candidate",
  );
}

describe("official node:test adapter qualification", () => {
  it("verifies a pure candidate assertion failure and replays every integrity rail", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(
      request(
        root,
        [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { subject } from "../../src/subject.js";',
          'test("subject remains true", () => assert.equal(subject(), true));',
          "",
        ].join("\n"),
        5_000,
        2,
      ),
    );

    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(
      candidateObservations(manifest).map(
        (observation: {
          worldId: string;
          attempt: number;
          outcome: string;
          attributed: boolean;
        }) => ({
          worldId: observation.worldId,
          attempt: observation.attempt,
          outcome: observation.outcome,
          attributed: observation.attributed,
        }),
      ),
      [
        { worldId: "neutral", attempt: 1, outcome: "PASS", attributed: true },
        { worldId: "neutral", attempt: 2, outcome: "PASS", attributed: true },
        { worldId: "reference", attempt: 1, outcome: "PASS", attributed: true },
        { worldId: "reference", attempt: 2, outcome: "PASS", attributed: true },
        { worldId: "target", attempt: 1, outcome: "ASSERTION_FAILURE", attributed: true },
        { worldId: "target", attempt: 2, outcome: "ASSERTION_FAILURE", attributed: true },
      ],
    );
    const target = candidateObservations(manifest).find(
      (observation: { worldId: string }) => observation.worldId === "target",
    );
    assert(target);
    assert.deepEqual(
      { outcome: target.outcome, attributed: target.attributed },
      { outcome: "ASSERTION_FAILURE", attributed: true },
    );
    const replay = replayEvidenceManifest(manifest);
    assert.equal(replay.decisionDigestValid, true);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.decisionSemanticsValid, true);
    assert.equal(replay.valid, true);
  });

  it("attributes PASS only after a candidate test is discovered", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(
      request(root, ['import test from "node:test";', 'test("passes", () => {});', ""].join("\n")),
    );

    assert.ok(
      candidateObservations(manifest).every(
        (observation: { outcome: string; attributed: boolean; candidateTestsDiscovered: number }) =>
          observation.outcome === "PASS" &&
          observation.attributed === true &&
          observation.candidateTestsDiscovered === 1,
      ),
    );
  });

  it("classifies a generic throw as PROCESS_CRASH and never as a kill", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(
      request(
        root,
        [
          'import test from "node:test";',
          'test("crashes", () => { throw new Error("boom"); });',
          "",
        ].join("\n"),
      ),
    );

    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.ok(
      candidateObservations(manifest).every(
        (observation: { outcome: string; attributed: boolean }) =>
          observation.outcome === "PROCESS_CRASH" && observation.attributed === false,
      ),
    );
  });

  it("keeps candidate syntax errors as non-attributed PROCESS_CRASH", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(
      request(root, ['import test from "node:test";', 'test("broken", () => {', ""].join("\n")),
    );

    assert.deepEqual(
      candidateObservations(manifest).map(
        (observation: { outcome: string; attributed: boolean }) => ({
          outcome: observation.outcome,
          attributed: observation.attributed,
        }),
      ),
      Array.from({ length: 3 }, () => ({ outcome: "PROCESS_CRASH", attributed: false })),
    );
  });

  it("rejects generic errors whose nested cause looks like an assertion or syntax failure", async () => {
    for (const nestedCause of [
      'new assert.AssertionError({ message: "nested assertion" })',
      'new SyntaxError("nested syntax")',
    ]) {
      const root = await fixture();
      const manifest = await verifyNodeCampaign(
        request(
          root,
          [
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            `test("nested", () => { throw new Error("outer", { cause: ${nestedCause} }); });`,
            "",
          ].join("\n"),
        ),
      );

      assert.ok(
        candidateObservations(manifest).every(
          (observation: { outcome: string; attributed: boolean }) =>
            observation.outcome === "PROCESS_CRASH" && observation.attributed === false,
        ),
      );
    }
  });

  it("classifies a candidate file without a test as NO_TEST_DISCOVERED", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(request(root, "export {};\n"));

    assert.ok(
      candidateObservations(manifest).every(
        (observation: { outcome: string; attributed: boolean }) =>
          observation.outcome === "NO_TEST_DISCOVERED" && observation.attributed === false,
      ),
    );
  });

  it("keeps the engine deadline authoritative for TIMEOUT", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(
      request(
        root,
        [
          'import test from "node:test";',
          'test("waits", async () => new Promise((resolve) => setTimeout(resolve, 10_000)));',
          "",
        ].join("\n"),
        2_000,
      ),
    );

    assert.ok(
      candidateObservations(manifest).every(
        (observation: { outcome: string; attributed: boolean }) =>
          observation.outcome === "TIMEOUT" && observation.attributed === false,
      ),
    );
  });

  it("makes a mixed base and candidate failure a non-attributed PROCESS_CRASH", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "tests", "base.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { subject } from "../src/subject.js";',
        'test("base", () => assert.equal(subject(), true));',
        "",
      ].join("\n"),
    );
    const manifest = await verifyNodeCampaign(
      request(
        root,
        [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { subject } from "../../src/subject.js";',
          'test("candidate", () => assert.equal(subject(), true));',
          "",
        ].join("\n"),
      ),
    );
    const target = candidateObservations(manifest).find(
      (observation: { worldId: string }) => observation.worldId === "target",
    );
    assert(target);

    assert.deepEqual(
      { outcome: target.outcome, attributed: target.attributed },
      { outcome: "PROCESS_CRASH", attributed: false },
    );
  });

  it("keeps import and load failures as PROCESS_CRASH with no collection claim", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(request(root, 'import "./missing-module.js";\n'));

    assert.ok(
      candidateObservations(manifest).every(
        (observation: { outcome: string; attributed: boolean }) =>
          observation.outcome === "PROCESS_CRASH" && observation.attributed === false,
      ),
    );
    assert.equal(
      manifest.evidenceContext.adapter.configuration.profile.capabilities.detectsCollectionFailure,
      false,
    );
    assert.equal(
      manifest.evidenceContext.adapter.configuration.profile.capabilities.detectsCompileFailure,
      false,
    );
  });

  it("binds a deterministic successful runtime preflight into evidence", async () => {
    const root = await fixture();
    const manifest = await verifyNodeCampaign(
      request(root, ['import test from "node:test";', 'test("passes", () => {});', ""].join("\n")),
    );
    const preflight = manifest.evidenceContext.adapter.configuration.runtimePreflight;

    assert.deepEqual(preflight, {
      protocolVersion: "1.0.0",
      assertionProbe: {
        outcome: "ASSERTION_FAILURE",
        attributed: true,
        candidateTestsDiscovered: 1,
        testsDiscovered: 2,
        candidateFailureCount: 1,
        nonCandidateFailureCount: 0,
        candidateSyntaxFailureCount: 0,
        candidateFailuresAllAssertions: true,
        processExitedNonZero: true,
      },
      genericThrowProbe: {
        outcome: "PROCESS_CRASH",
        attributed: false,
        candidateTestsDiscovered: 1,
        testsDiscovered: 2,
        candidateFailureCount: 1,
        nonCandidateFailureCount: 0,
        candidateSyntaxFailureCount: 0,
        candidateFailuresAllAssertions: false,
        processExitedNonZero: true,
      },
    });
    assert.equal("timestamp" in preflight, false);
  });

  it("rejects executable identity output that exceeds the caller capture budget", async () => {
    const root = await fixture();
    const runtimeDirectory = path.join(root, "runtime", "long-runtime-path-".repeat(8));
    await mkdir(runtimeDirectory, { recursive: true });
    const executable = path.join(
      runtimeDirectory,
      process.platform === "win32" ? "node.exe" : "node",
    );
    await copyFile(process.execPath, executable);
    const input = request(root, 'import test from "node:test"; test("candidate", () => {});');
    input.adapter.executable = executable;
    input.repository.exclude.push("runtime");
    input.budgets.maximumOutputBytes = 128;

    await assert.rejects(verifyCampaign(input), /NODE_TEST_EXECUTABLE_PROBE_FAILED/);
  });

  it("fails closed with one stable code when a runtime preflight cannot execute", async () => {
    const { runNodeTestRuntimePreflight } = await import(
      "../src/engine/adapters/node-test-runtime.js"
    );

    await assert.rejects(
      runNodeTestRuntimePreflight({
        executable: path.join(await fixture(), "missing-node"),
        reporterSource: "export default async function* () {}",
        environment: {},
        timeoutMs: 1_000,
        maximumOutputBytes: 65_536,
        processRunner: runProcess,
      }),
      /NODE_TEST_PROFILE_PREFLIGHT_FAILED/,
    );

    const contradictoryReporter = [
      "export default async function* () {",
      "  yield JSON.stringify({",
      '    protocolVersion: "1.0.0",',
      "    testsDiscovered: 2,",
      "    candidateTestsDiscovered: 1,",
      "    candidateFailureCount: 1,",
      "    nonCandidateFailureCount: 0,",
      "    candidateSyntaxFailureCount: 0,",
      "    candidateFailuresAllAssertions: true,",
      '  }) + "\\n";',
      "}",
      "",
    ].join("\n");
    await assert.rejects(
      runNodeTestRuntimePreflight({
        executable: process.execPath,
        reporterSource: contradictoryReporter,
        environment: Object.fromEntries(
          ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeoutMs: 5_000,
        maximumOutputBytes: 65_536,
        processRunner: runProcess,
      }),
      /NODE_TEST_PROFILE_PREFLIGHT_FAILED/,
    );
  });

  it("uses the central runner with the exact sub-second deadline and fails timeout closed", async () => {
    const { runNodeTestRuntimePreflight } = await import(
      "../src/engine/adapters/node-test-runtime.js"
    );
    let observedTimeoutMs: number | undefined;

    await assert.rejects(
      runNodeTestRuntimePreflight({
        executable: "must-not-spawn",
        reporterSource: "export default async function* () {}",
        environment: {},
        timeoutMs: 237,
        maximumOutputBytes: 65_536,
        processRunner: async (input) => {
          observedTimeoutMs = input.timeoutMs;
          return { outcome: "TIMEOUT", exitCode: null };
        },
      }),
      /NODE_TEST_PROFILE_PREFLIGHT_FAILED/,
    );
    assert.equal(observedTimeoutMs, 237);
  });

  it("rejects an oversized preflight report after a bounded read", async () => {
    const { runNodeTestRuntimePreflight } = await import(
      "../src/engine/adapters/node-test-runtime.js"
    );

    let runnerInvoked = false;
    await assert.rejects(
      runNodeTestRuntimePreflight({
        executable: process.execPath,
        reporterSource: "export default async function* () {}",
        environment: {},
        timeoutMs: 5_000,
        maximumOutputBytes: 65_536,
        processRunner: async (input) => {
          runnerInvoked = true;
          const destination = input.args.find((argument) =>
            argument.startsWith("--test-reporter-destination="),
          );
          assert(destination);
          await writeFile(
            destination.slice("--test-reporter-destination=".length),
            "x".repeat(64 * 1024 + 1),
          );
          return { outcome: "PROCESS_CRASH", exitCode: 1 };
        },
      }),
      /NODE_TEST_PROFILE_PREFLIGHT_FAILED/,
    );
    assert.equal(runnerInvoked, true);
  });

  it("does not cache runtime preflight across calls", async () => {
    const { runNodeTestRuntimePreflight } = await import(
      "../src/engine/adapters/node-test-runtime.js"
    );
    const probeRoots: string[] = [];
    const outputLimits: number[] = [];
    const processRunner = async (input: {
      args: string[];
      cwd: string;
      maximumOutputBytes: number;
    }): Promise<{ outcome: "PROCESS_CRASH"; exitCode: 1 }> => {
      probeRoots.push(input.cwd);
      outputLimits.push(input.maximumOutputBytes);
      const destination = input.args.find((argument) =>
        argument.startsWith("--test-reporter-destination="),
      );
      assert(destination);
      const assertionProbe = input.args.some((argument) => argument.endsWith("assertion.test.mjs"));
      await writeFile(
        destination.slice("--test-reporter-destination=".length),
        JSON.stringify({
          protocolVersion: "1.0.0",
          testsDiscovered: 2,
          candidateTestsDiscovered: 1,
          candidateFailureCount: 1,
          nonCandidateFailureCount: 0,
          candidateSyntaxFailureCount: 0,
          candidateFailuresAllAssertions: assertionProbe,
        }),
      );
      return { outcome: "PROCESS_CRASH", exitCode: 1 };
    };
    const input = {
      executable: "stubbed-node",
      reporterSource: "export default async function* () {}",
      environment: {},
      timeoutMs: 5_000,
      maximumOutputBytes: 128,
      processRunner,
    };

    await runNodeTestRuntimePreflight(input);
    await runNodeTestRuntimePreflight(input);

    assert.equal(probeRoots.length, 4);
    assert.equal(probeRoots[0], probeRoots[1]);
    assert.equal(probeRoots[2], probeRoots[3]);
    assert.deepEqual(outputLimits, [128, 128, 128, 128]);
    assert.notEqual(probeRoots[0], probeRoots[2]);
    assert.equal(new Set(probeRoots).size, 2);

    await runNodeTestRuntimePreflight({ ...input, maximumOutputBytes: 128 * 1024 });
    assert.deepEqual(outputLimits.slice(4), [65_536, 65_536]);
    assert.equal(new Set(probeRoots).size, 3);
  });
});
