import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseEvidenceManifest } from "../src/contracts/index.js";
import { verifyManifestIntegrity } from "../src/core/index.js";

type EngineApi = {
  analyzeRepository(root: string): Promise<any>;
  runProcess(input: unknown): Promise<any>;
  verifyCampaign(request: unknown): Promise<any>;
};

async function loadEngine(): Promise<EngineApi> {
  try {
    return (await import("../src/engine/index.js")) as EngineApi;
  } catch {
    return {
      analyzeRepository: async () => ({ fileCount: -1, languages: [], repositoryDigest: "" }),
      runProcess: async () => ({ outcome: "UNIMPLEMENTED", output: {} }),
      verifyCampaign: async () => ({ decision: { status: "ENGINE_ERROR" } }),
    };
  }
}

const engine = await loadEngine();
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ),
  );
});

async function createFixtureRepository(): Promise<string> {
  const root = await temporaryDirectory("testforge-fixture-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", scripts: { test: "node --test" } }),
  );
  await writeFile(
    path.join(root, "src", "is-even.js"),
    "export function isEven(value) { return value % 2 === 0; }\n",
  );
  await writeFile(
    path.join(root, "tests", "base.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("fixture baseline", () => assert.equal(1 + 1, 2));',
      "",
    ].join("\n"),
  );
  return root;
}

function verificationRequest(root: string) {
  return {
    schemaVersion: "1.0.0",
    repository: {
      root,
      exclude: ["node_modules", ".git", ".testforge"],
    },
    adapter: {
      kind: "node-test",
      executable: process.execPath,
      baseTestFiles: ["tests/base.test.js"],
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 4,
      maximumWorlds: 4,
      maximumExecutions: 24,
      maximumRepositoryFiles: 10_000,
      maximumRepositoryBytes: 100_000_000,
      maximumWorldOverlayBytes: 1_000_000,
      maximumCandidateBytes: 16_384,
      maximumTotalCandidateBytes: 65_536,
      timeoutMsPerExecution: 5_000,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
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
        provenance: "fixture:correct",
        files: [],
      },
      {
        id: "target-parity-inversion",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "fixture:known-fault",
        files: [
          {
            path: "src/is-even.js",
            content: "export function isEven(value) { return value % 2 === 1; }\n",
          },
        ],
      },
      {
        id: "neutral-equivalent-refactor",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "fixture:equivalent",
        files: [
          {
            path: "src/is-even.js",
            content: "export function isEven(value) { return (value & 1) === 0; }\n",
          },
        ],
      },
    ],
    candidates: [
      {
        id: "strong",
        files: [
          {
            path: "tests/candidates/strong.test.js",
            content: [
              'import test from "node:test";',
              'import assert from "node:assert/strict";',
              'import { isEven } from "../../src/is-even.js";',
              'test("two is even", () => assert.equal(isEven(2), true));',
              "",
            ].join("\n"),
          },
        ],
      },
      {
        id: "weak",
        files: [
          {
            path: "tests/candidates/weak.test.js",
            content: [
              'import test from "node:test";',
              'import assert from "node:assert/strict";',
              'import { isEven } from "../../src/is-even.js";',
              'test("returns a boolean", () => assert.equal(typeof isEven(2), "boolean"));',
              "",
            ].join("\n"),
          },
        ],
      },
    ],
  };
}

describe("repository analysis", () => {
  it("returns deterministic structured context for an agent", async () => {
    const root = await createFixtureRepository();

    const first = await engine.analyzeRepository(root);
    const second = await engine.analyzeRepository(root);

    assert.equal(first.fileCount, 3);
    assert.deepEqual(first.languages, [{ name: "JavaScript", files: 2 }]);
    assert.ok(first.detectedTestFrameworks.includes("node:test"));
    assert.equal(first.repositoryDigest, second.repositoryDigest);
    assert.match(first.repositoryDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.capabilities.canExecuteCandidates, true);
    assert.deepEqual(first.capabilities.supportedAdapters, ["node-test", "testforge-command"]);
  });

  it("rejects repository symlinks instead of omitting them from the digest", async (context) => {
    const root = await createFixtureRepository();
    try {
      await symlink(
        path.join(root, "src", "is-even.js"),
        path.join(root, "src", "linked-is-even.js"),
        "file",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code))
      ) {
        context.skip(`symlink creation is unavailable: ${String(error.code)}`);
        return;
      }
      throw error;
    }

    await assert.rejects(engine.analyzeRepository(root), /UNSUPPORTED_REPOSITORY_SYMLINK/);
    await assert.rejects(
      engine.verifyCampaign(verificationRequest(root)),
      /UNSUPPORTED_REPOSITORY_SYMLINK/,
    );
  });

  it("normalizes missing and non-directory repository roots", async () => {
    const parent = await temporaryDirectory("testforge-invalid-root-");
    const missingRoot = path.join(parent, "missing");
    const regularFile = path.join(parent, "regular-file");
    await writeFile(regularFile, "not a repository\n");

    for (const root of [missingRoot, regularFile]) {
      const stableRootError = (error: unknown): boolean =>
        error instanceof TypeError && error.message === "INVALID_REPOSITORY_ROOT";

      await assert.rejects(engine.analyzeRepository(root), stableRootError);
      await assert.rejects(engine.verifyCampaign(verificationRequest(root)), stableRootError);
    }
  });
});

describe("bounded process execution", () => {
  it("classifies timeout separately from a test failure", async () => {
    const root = await temporaryDirectory("testforge-process-");

    const result = await engine.runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      environment: {},
      timeoutMs: 100,
      maximumOutputBytes: 1_024,
    });

    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.timedOut, true);
  });

  it("truncates captured output while preserving a full-stream digest", async () => {
    const root = await temporaryDirectory("testforge-output-");

    const result = await engine.runProcess({
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(10_000))'],
      cwd: root,
      environment: {},
      timeoutMs: 2_000,
      maximumOutputBytes: 128,
    });

    assert.equal(result.outcome, "PASS");
    assert.equal(result.stdout.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout.text) <= 128);
    assert.equal(result.stdout.totalBytes, 10_000);
    assert.match(result.stdout.digest, /^sha256:[a-f0-9]{64}$/);
  });

  it("enforces a hard deadline when a detached descendant keeps output pipes open", async () => {
    const root = await temporaryDirectory("testforge-process-tree-");
    const startedAt = Date.now();

    const result = await engine.runProcess({
      executable: process.execPath,
      args: [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {',
          "  detached: true,",
          '  cwd: require("node:os").tmpdir(),',
          '  stdio: ["ignore", process.stdout, process.stderr],',
          "});",
          "child.unref();",
        ].join("\n"),
      ],
      cwd: root,
      environment: {},
      timeoutMs: 100,
      maximumOutputBytes: 1_024,
    });

    assert.equal(result.outcome, "TIMEOUT");
    assert.ok(Date.now() - startedAt < 1_500, "hard deadline exceeded its bounded grace period");
  });
});

describe("campaign orchestration", () => {
  it("verifies only the stable candidate with incremental assertion evidence", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);

    const manifest = await engine.verifyCampaign(request);

    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["strong"]);
    assert.equal(
      manifest.candidates.find((candidate: any) => candidate.id === "weak").status,
      "WEAK_ORACLE",
    );
    assert.equal(manifest.isolation.level, "UNSANDBOXED");
    assert.ok(manifest.limitations.some((item: string) => item.includes("hostile")));
    assert.equal(verifyManifestIntegrity(manifest).valid, true);
    assert.equal(manifest.evidenceContext.adapter.version, process.versions.node);
    assert.equal(manifest.evidenceContext.adapter.configuration.kind, "node-test");
    assert.equal(
      manifest.evidenceContext.adapter.configuration.requestedExecutable,
      process.execPath,
    );
    assert.equal(
      manifest.evidenceContext.adapter.configuration.resolvedExecutable,
      await realpath(process.execPath),
    );
    assert.match(
      manifest.evidenceContext.adapter.configuration.executableDigest,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(manifest.evidenceContext.adapter.configuration.nodeVersion, process.versions.node);
    assert.deepEqual(manifest.evidenceContext.adapter.configuration.arguments, [
      "--test",
      "--",
      "tests/base.test.js",
    ]);
    assert.doesNotThrow(() => parseEvidenceManifest(manifest));
    await assert.rejects(readFile(path.join(root, "tests", "candidates", "strong.test.js")));
  });

  it("enforces repository file and byte budgets before campaign copying", async () => {
    const cases: Array<{
      mutate(request: ReturnType<typeof verificationRequest>): void;
      code: RegExp;
    }> = [
      {
        mutate: (request) => {
          request.budgets.maximumRepositoryFiles = 1;
        },
        code: /REPOSITORY_FILE_BUDGET_EXCEEDED/,
      },
      {
        mutate: (request) => {
          request.budgets.maximumRepositoryBytes = 1;
        },
        code: /REPOSITORY_BYTES_BUDGET_EXCEEDED/,
      },
    ];

    for (const testCase of cases) {
      const root = await createFixtureRepository();
      const request = verificationRequest(root);
      testCase.mutate(request);

      await assert.rejects(engine.verifyCampaign(request), testCase.code);
    }
  });

  it("keeps controlled reporter evidence independent from the log-output budget", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.candidates = [request.candidates[0] as (typeof request.candidates)[number]];
    request.budgets.maximumOutputBytes = 128;

    const manifest = await engine.verifyCampaign(request);

    assert.equal(manifest.decision.status, "VERIFIED");
  });

  it("rejects a non-Node node-test executable before candidate execution", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.adapter.executable =
      process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";

    await assert.rejects(engine.verifyCampaign(request), /NODE_TEST_EXECUTABLE_PROBE_FAILED/);
  });

  it("resolves a portable node executable through the allowlisted PATH", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.adapter.executable = "node";
    request.candidates = [request.candidates[0] as (typeof request.candidates)[number]];

    const manifest = await engine.verifyCampaign(request);

    assert.equal(manifest.decision.status, "VERIFIED");
    assert.equal(manifest.evidenceContext.adapter.configuration.requestedExecutable, "node");
    assert.equal(
      manifest.evidenceContext.adapter.configuration.resolvedExecutable,
      await realpath(process.execPath),
    );
  });

  it("never accepts printed assertion-like text or a test-like comment as kill evidence", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.candidates = [
      {
        id: "forged-output",
        files: [
          {
            path: "tests/candidates/forged-output.test.js",
            content: [
              'import { readFileSync } from "node:fs";',
              "// test( this comment is not a declared test",
              'const implementation = readFileSync(new URL("../../src/is-even.js", import.meta.url), "utf8");',
              'if (implementation.includes("% 2 === 1")) {',
              '  console.log("AssertionError actual: false expected: true");',
              "  process.exitCode = 1;",
              "}",
              "",
            ].join("\n"),
          },
        ],
      },
    ];

    const manifest = await engine.verifyCampaign(request);

    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some(
        (observation: { candidateId: string | null; outcome: string }) =>
          observation.candidateId === "forged-output" &&
          observation.outcome === "ASSERTION_FAILURE",
      ),
      false,
    );
  });

  it("does not count an empty candidate file wrapper as a discovered test", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.candidates = [
      {
        id: "empty-candidate",
        files: [{ path: "tests/candidates/empty.test.js", content: "export {};\n" }],
      },
    ];

    const manifest = await engine.verifyCampaign(request);
    const candidate = manifest.candidates.find(
      (item: { id: string }) => item.id === "empty-candidate",
    );

    assert.equal(candidate.status, "INVALID");
    assert.ok(candidate.reasonCodes.includes("CANDIDATE_DISCOVERY_INVALID"));
    assert.equal(
      manifest.observations
        .filter(
          (observation: { candidateId: string | null }) =>
            observation.candidateId === "empty-candidate",
        )
        .every(
          (observation: { candidateTestsDiscovered: number }) =>
            observation.candidateTestsDiscovered === 0,
        ),
      true,
    );
  });

  it("never treats candidate syntax failure as a target kill", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.candidates = [
      {
        id: "syntax-error",
        files: [
          {
            path: "tests/candidates/syntax-error.test.js",
            content: ['import test from "node:test";', 'test("broken", () => {', ""].join("\n"),
          },
        ],
      },
    ];

    const manifest = await engine.verifyCampaign(request);

    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some(
        (observation: { candidateId: string | null; outcome: string }) =>
          observation.candidateId === "syntax-error" && observation.outcome === "ASSERTION_FAILURE",
      ),
      false,
    );
  });

  it("blocks attribution when a base control file also fails", async () => {
    const root = await createFixtureRepository();
    await writeFile(
      path.join(root, "tests", "base.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { isEven } from "../src/is-even.js";',
        'test("base control checks parity", () => assert.equal(isEven(2), true));',
        "",
      ].join("\n"),
    );
    const request = verificationRequest(root);
    request.candidates = [request.candidates[0] as (typeof request.candidates)[number]];

    const manifest = await engine.verifyCampaign(request);

    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations
        .filter(
          (observation: { candidateId: string | null; worldId: string }) =>
            observation.candidateId === "strong" &&
            observation.worldId === "target-parity-inversion",
        )
        .every((observation: { attributed: boolean }) => observation.attributed === false),
      true,
    );
  });

  it("rejects node-test arguments that can replace evidence or reduce completeness", async () => {
    const forbiddenArguments = [
      "--test-reporter=spec",
      "--test-reporter-destination=report.txt",
      "--test-name-pattern=selected",
      "--test-only",
      "--test-shard=1/2",
      "--watch",
      "--test-isolation=none",
      "--experimental-test-isolation=none",
      "--import=./preload.mjs",
      "--require=./preload.cjs",
    ];

    for (const forbiddenArgument of forbiddenArguments) {
      const root = await createFixtureRepository();
      const request = verificationRequest(root);
      (request.adapter as { extraArguments?: string[] }).extraArguments = [forbiddenArgument];

      await assert.rejects(engine.verifyCampaign(request), /UNSAFE_NODE_TEST_ARGUMENT/);
    }
  });

  it("does not allow a base test path token to inject a test filter", async () => {
    const root = await createFixtureRepository();
    await writeFile(
      path.join(root, "tests", "base.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("base must fail", () => assert.fail("control failure"));',
        "",
      ].join("\n"),
    );
    const request = verificationRequest(root);
    request.adapter.baseTestFiles = ["--test-name-pattern=two is even", "tests/base.test.js"];
    request.candidates = [request.candidates[0] as (typeof request.candidates)[number]];

    const manifest = await engine.verifyCampaign(request);

    assert.notEqual(manifest.decision.status, "VERIFIED");
  });

  it("rejects reserved environment variables before execution", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.isolation.environmentAllowlist.push("node_options");

    await assert.rejects(engine.verifyCampaign(request), /RESERVED_ENVIRONMENT_VARIABLE/);
  });

  it("rejects portable path collisions in campaign inputs", async () => {
    const cases: Array<(request: ReturnType<typeof verificationRequest>) => void> = [
      (request) => {
        request.worlds[0]?.files.push(
          { path: "src/case.js", content: "export const value = 1;\n" },
          { path: "src/Case.js", content: "export const value = 2;\n" },
        );
      },
      (request) => {
        request.candidates[0]?.files.push({
          path: "tests/CANDIDATES/strong.test.js",
          content: "export {};\n",
        });
      },
      (request) => {
        request.adapter.baseTestFiles.push("tests/BASE.test.js");
      },
      (request) => {
        request.candidateRoots.push("tests/CANDIDATES");
      },
    ];

    for (const mutate of cases) {
      const root = await createFixtureRepository();
      const request = verificationRequest(root);
      mutate(request);

      await assert.rejects(engine.verifyCampaign(request), /PORTABLE_PATH_COLLISION/);
    }
  });

  it("rejects an overlay whose spelling collides with the repository snapshot", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    const target = request.worlds.find((world) => world.id === "target-parity-inversion");
    assert.ok(target);
    target.files[0] = {
      path: "src/IS-EVEN.js",
      content: "export function isEven(value) { return value % 2 === 1; }\n",
    };

    await assert.rejects(engine.verifyCampaign(request), /PORTABLE_PATH_COLLISION/);
  });

  it("makes overlay ordering irrelevant to execution and decision digests", async () => {
    const root = await createFixtureRepository();
    const first = verificationRequest(root);
    first.candidates = [first.candidates[0] as (typeof first.candidates)[number]];
    first.candidates[0]?.files.push({
      path: "tests/candidates/helper.js",
      content: "export const helper = true;\n",
    });
    for (const world of first.worlds) {
      world.files.push({
        path: "src/world-marker.js",
        content: `export const world = ${JSON.stringify(world.id)};\n`,
      });
    }
    const second = structuredClone(first);
    second.candidates[0]?.files.reverse();
    for (const world of second.worlds) world.files.reverse();

    const firstManifest = await engine.verifyCampaign(first);
    const secondManifest = await engine.verifyCampaign(second);

    assert.equal(firstManifest.decision.status, "VERIFIED");
    assert.equal(secondManifest.decision.status, "VERIFIED");
    assert.equal(firstManifest.decisionDigest, secondManifest.decisionDigest);
  });

  it("never executes default-excluded files when request exclusions are empty", async () => {
    const root = await createFixtureRepository();
    await mkdir(path.join(root, ".testforge"), { recursive: true });
    await writeFile(path.join(root, ".testforge", "sentinel"), "must not execute\n");
    await writeFile(
      path.join(root, "runner.mjs"),
      [
        'import { access, readFile, writeFile } from "node:fs/promises";',
        "const resultPath = process.env.TESTFORGE_RESULT_FILE;",
        'const candidateFiles = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");',
        "let excludedFileWasCopied = true;",
        'try { await access(".testforge/sentinel"); } catch { excludedFileWasCopied = false; }',
        'const implementation = await readFile("src/is-even.js", "utf8");',
        'const candidate = candidateFiles.length === 0 ? "" : await readFile(candidateFiles[0], "utf8");',
        'const killed = !excludedFileWasCopied && candidate.includes("two is even") && implementation.includes("% 2 === 1");',
        'const outcome = excludedFileWasCopied ? "PROCESS_CRASH" : killed ? "ASSERTION_FAILURE" : "PASS";',
        "await writeFile(resultPath, JSON.stringify({",
        '  protocolVersion: "1.0.0", outcome,',
        "  testsDiscovered: candidateFiles.length === 0 ? 1 : 2,",
        "  candidateTestsDiscovered: candidateFiles.length === 0 ? 0 : 1,",
        "  attributed: candidateFiles.length > 0 && !excludedFileWasCopied,",
        "}));",
        'process.exitCode = outcome === "PASS" ? 0 : 1;',
        "",
      ].join("\n"),
    );
    const request = verificationRequest(root);
    request.repository.exclude = [];
    request.candidates = [request.candidates[0] as (typeof request.candidates)[number]];
    request.adapter = {
      kind: "testforge-command",
      executable: process.execPath,
      arguments: ["runner.mjs"],
      protocolVersion: "1.0.0",
    } as any;

    const manifest = await engine.verifyCampaign(request);

    assert.equal(manifest.decision.status, "VERIFIED");
  });

  it("refuses local execution without an explicit unsafe-execution acknowledgement", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.isolation.acknowledgedUnsafeExecution = false;

    await assert.rejects(engine.verifyCampaign(request), /UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED/);
  });

  it("rejects candidate traversal before running any command", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    const candidate = request.candidates[0];
    const candidateFile = candidate?.files[0];
    assert.ok(candidateFile);
    candidateFile.path = "../escaped.test.js";

    await assert.rejects(engine.verifyCampaign(request), /FORBIDDEN_CANDIDATE_PATH/);
    await assert.rejects(readFile(path.join(root, "..", "escaped.test.js")));
  });

  it("enforces the versioned contract instead of accepting unsafe target outcomes", async () => {
    const root = await createFixtureRepository();
    const request = verificationRequest(root);
    request.policy.acceptedTargetOutcomes = ["TIMEOUT"];

    await assert.rejects(engine.verifyCampaign(request), /UNSAFE_TARGET_OUTCOME/);

    request.policy.acceptedTargetOutcomes = ["ASSERTION_FAILURE"];
    request.schemaVersion = "2.0.0";
    await assert.rejects(engine.verifyCampaign(request), /SCHEMA_VERSION_UNSUPPORTED/);
  });

  it("supports a framework-independent structured command adapter", async () => {
    const root = await createFixtureRepository();
    await writeFile(
      path.join(root, "runner.mjs"),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        "const resultPath = process.env.TESTFORGE_RESULT_FILE;",
        'const candidateFiles = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");',
        'const implementation = await readFile("src/is-even.js", "utf8");',
        'const candidate = candidateFiles.length === 0 ? "" : await readFile(candidateFiles[0], "utf8");',
        'const isStrong = candidate.includes("two is even");',
        'const killed = isStrong && implementation.includes("% 2 === 1");',
        'const outcome = killed ? "ASSERTION_FAILURE" : "PASS";',
        "await writeFile(resultPath, JSON.stringify({",
        '  protocolVersion: "1.0.0",',
        "  outcome,",
        "  testsDiscovered: candidateFiles.length === 0 ? 1 : 2,",
        "  candidateTestsDiscovered: candidateFiles.length === 0 ? 0 : 1,",
        "  attributed: candidateFiles.length > 0,",
        "}));",
        "process.exitCode = killed ? 1 : 0;",
        "",
      ].join("\n"),
    );
    const request = verificationRequest(root);
    request.adapter = {
      kind: "testforge-command",
      executable: process.execPath,
      arguments: ["runner.mjs"],
      protocolVersion: "1.0.0",
    } as any;

    const manifest = await engine.verifyCampaign(request);

    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["strong"]);
    assert.equal(manifest.adapter.kind, "testforge-command");
    assert.equal(manifest.adapter.protocolVersion, "1.0.0");
  });

  it("executes every observation from one immutable campaign snapshot", async () => {
    const root = await createFixtureRepository();
    await writeFile(
      path.join(root, "runner.mjs"),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        'import path from "node:path";',
        "const resultPath = process.env.TESTFORGE_RESULT_FILE;",
        "const sourceRoot = process.env.SOURCE_ROOT_FOR_TEST;",
        'const candidateFiles = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");',
        'const implementation = await readFile("src/is-even.js", "utf8");',
        'const candidate = candidateFiles.length === 0 ? "" : await readFile(candidateFiles[0], "utf8");',
        'await writeFile(path.join(sourceRoot, "src", "is-even.js"), "export function isEven(value) { return value % 2 === 1; }\\n");',
        'const killed = candidate.includes("two is even") && implementation.includes("% 2 === 1");',
        'const outcome = killed ? "ASSERTION_FAILURE" : "PASS";',
        "await writeFile(resultPath, JSON.stringify({",
        '  protocolVersion: "1.0.0",',
        "  outcome,",
        "  testsDiscovered: candidateFiles.length === 0 ? 1 : 2,",
        "  candidateTestsDiscovered: candidateFiles.length === 0 ? 0 : 1,",
        "  attributed: candidateFiles.length > 0,",
        "}));",
        "process.exitCode = killed ? 1 : 0;",
        "",
      ].join("\n"),
    );
    const request = verificationRequest(root);
    request.adapter = {
      kind: "testforge-command",
      executable: process.execPath,
      arguments: ["runner.mjs"],
      protocolVersion: "1.0.0",
    } as any;
    request.isolation.environmentAllowlist.push("SOURCE_ROOT_FOR_TEST");
    const previousSourceRoot = process.env.SOURCE_ROOT_FOR_TEST;
    process.env.SOURCE_ROOT_FOR_TEST = root;

    try {
      const manifest = await engine.verifyCampaign(request);

      assert.equal(manifest.decision.status, "VERIFIED");
      assert.deepEqual(manifest.decision.selectedCandidateIds, ["strong"]);
      assert.match(await readFile(path.join(root, "src", "is-even.js"), "utf8"), /=== 1/);
    } finally {
      if (previousSourceRoot === undefined) delete process.env.SOURCE_ROOT_FOR_TEST;
      else process.env.SOURCE_ROOT_FOR_TEST = previousSourceRoot;
    }
  });

  it("rejects an oversized structured-command result before parsing it", async () => {
    const root = await createFixtureRepository();
    await writeFile(
      path.join(root, "runner.mjs"),
      [
        'import { writeFile } from "node:fs/promises";',
        "const report = {",
        '  protocolVersion: "1.0.0",',
        '  outcome: "PASS",',
        "  testsDiscovered: 1,",
        "  candidateTestsDiscovered: 0,",
        "  attributed: false,",
        "};",
        'await writeFile(process.env.TESTFORGE_RESULT_FILE, JSON.stringify(report) + " ".repeat(70000));',
        "",
      ].join("\n"),
    );
    const request = verificationRequest(root);
    request.adapter = {
      kind: "testforge-command",
      executable: process.execPath,
      arguments: ["runner.mjs"],
      protocolVersion: "1.0.0",
    } as any;
    request.budgets.maximumOutputBytes = 128;

    const manifest = await engine.verifyCampaign(request);

    assert.ok(
      manifest.observations.every(
        (observation: { outcome: string }) => observation.outcome === "INFRA_ERROR",
      ),
    );
  });
});
