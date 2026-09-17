import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { explainReasonCodes } from "../src/diagnostics.js";
import { runProcess } from "../src/engine/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const FAKE_RUNTIME = fileURLToPath(
  new URL("./support/fake-container-runtime.mjs", import.meta.url),
);
const IMAGE = `node@sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function cli(argv: string[], cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    readStdin: async () => "",
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

async function runGit(root: string, args: string[]): Promise<string> {
  const result = await runProcess({
    executable: "git",
    args,
    cwd: root,
    environment: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    timeoutMs: 5_000,
    maximumOutputBytes: 65_536,
  });
  assert.equal(result.outcome, "PASS", result.stderr.text);
  return result.stdout.text.trim();
}

async function commit(root: string, message: string): Promise<string> {
  await runGit(root, ["add", "."]);
  await runGit(root, [
    "-c",
    "user.name=AssertLedger Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

async function gitFixture() {
  const root = await temporaryDirectory("assertledger-container-git-");
  await runGit(root, ["init"]);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "subject.js"), "export const total = () => 1;\n");
  await writeFile(
    path.join(root, "base.test.js"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("base",()=>assert.equal(1,1));\n',
  );
  const before = await commit(root, "bug");
  await writeFile(path.join(root, "subject.js"), "export const total = () => 2;\n");
  await commit(root, "fix");
  await writeFile(
    path.join(root, "candidate.test.js"),
    'import test from "node:test"; import assert from "node:assert/strict"; import { total } from "./subject.js"; test("regression",()=>assert.equal(total(),2));\n',
  );
  const after = await commit(root, "candidate");
  return { root, before, after };
}

function checkArguments(value: { root: string; before: string; after: string }): string[] {
  return [
    "check",
    value.root,
    "--before",
    value.before,
    "--after",
    value.after,
    "--neutral",
    value.after,
    "--neutral-reason",
    "explicit repeated control",
    "--test",
    "candidate.test.js",
    "--base-test",
    "base.test.js",
    "--out",
    ".assertledger/evidence",
  ];
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function fakeRuntime(scenario: Record<string, unknown> = {}) {
  const state = await temporaryDirectory("assertledger-fake-runtime-");
  await writeFile(path.join(state, "scenario.json"), JSON.stringify(scenario));
  return { state, command: [process.execPath, FAKE_RUNTIME, state] };
}

async function recordedCalls(state: string): Promise<string[][]> {
  try {
    return (await readFile(path.join(state, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

async function structuredContainerRequest(isolation?: Record<string, unknown>) {
  const root = await temporaryDirectory("assertledger-container-verify-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "value.js"), "export const value = 1;\n");
  const request = {
    schemaVersion: "2.0.0",
    repository: { root, exclude: [] },
    adapter: {
      kind: "testforge-command",
      executable: "fake-adapter",
      arguments: [],
      protocolVersion: "1.0.0",
    },
    isolation: isolation ?? {
      kind: "container",
      image: IMAGE,
      environment: [],
      limits: {
        memoryBytes: 268_435_456,
        cpuMillicores: 1_000,
        pids: 64,
        temporaryDirectoryBytes: 8_388_608,
      },
    },
    candidateRoots: ["tests"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 6,
      maximumRepositoryFiles: 100,
      maximumRepositoryBytes: 1_000_000,
      maximumWorldOverlayBytes: 100_000,
      maximumCandidateBytes: 10_000,
      maximumTotalCandidateBytes: 10_000,
      timeoutMsPerExecution: 20_000,
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
      { id: "fixed", kind: "REFERENCE", required: true, weight: 0, provenance: "f", files: [] },
      {
        id: "bug",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "b",
        files: [{ path: "src/value.js", content: "// BUG\n" }],
      },
      { id: "neutral", kind: "NEUTRAL", required: true, weight: 0, provenance: "n", files: [] },
    ],
    candidates: [{ id: "candidate", files: [{ path: "tests/value.test.js", content: "// t\n" }] }],
  };
  const requestPath = path.join(root, "request.json");
  await writeFile(requestPath, JSON.stringify(request));
  return { root, requestPath };
}

describe("container isolation through the CLI", () => {
  it("refuses a Git check without an isolation choice and names both safe options", async () => {
    const value = await gitFixture();
    const result = await cli(checkArguments(value));
    assert.equal(result.code, 4);
    assert.match(
      result.stderr,
      /Refusing trusted-local execution without --allow-unsafe-execution/,
    );
    assert.match(result.stderr, /--container-image NAME@sha256:DIGEST/);
    assert.equal(await exists(path.join(value.root, ".assertledger")), false);
  });

  it("refuses conflicting isolation modes before touching Git", async () => {
    const value = await gitFixture();
    const result = await cli([
      ...checkArguments(value),
      "--allow-unsafe-execution",
      "--container-image",
      IMAGE,
    ]);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /ISOLATION_MODE_CONFLICT/);
    assert.equal(await exists(path.join(value.root, ".assertledger")), false);
  });

  it("stops a containerized Git check with a diagnostic when no backend is available", async () => {
    const value = await gitFixture();
    const missing = path.join(os.tmpdir(), `assertledger-missing-runtime-${randomUUID()}`);
    const result = await cli([
      ...checkArguments(value),
      "--container-image",
      IMAGE,
      "--container-runtime",
      JSON.stringify([missing]),
    ]);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /CONTAINER_RUNTIME_NOT_FOUND/);
    assert.match(result.stderr, /Next action: /);
    assert.equal(await exists(path.join(value.root, ".assertledger", "evidence")), false);
  });

  it("accepts only a JSON argv array as the runtime command", async () => {
    const value = await gitFixture();
    for (const runtime of ["docker ps", "[]", '["docker", 1]', '[""]']) {
      const result = await cli([
        ...checkArguments(value),
        "--container-image",
        IMAGE,
        "--container-runtime",
        runtime,
      ]);
      assert.equal(result.code, 4, runtime);
      assert.match(result.stderr, /CONTAINER_RUNTIME_COMMAND_INVALID/, runtime);
    }
  });

  it("verifies a v2 container request without trusted-local authorization", async () => {
    const { requestPath } = await structuredContainerRequest();
    const runtime = await fakeRuntime();
    const result = await cli([
      "verify",
      requestPath,
      "--container-runtime",
      JSON.stringify(runtime.command),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.schemaVersion, "2.0.0");
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.isolation, {
      kind: "container",
      level: "CONTAINER",
      runtimeCommand: runtime.command,
    });
    assert.equal(new AssertLedger().replay(manifest).valid, true);
  });

  it("refuses to combine a container request with trusted-local authorization", async () => {
    const { requestPath } = await structuredContainerRequest();
    const runtime = await fakeRuntime();
    const result = await cli([
      "verify",
      requestPath,
      "--allow-unsafe-execution",
      "--container-runtime",
      JSON.stringify(runtime.command),
    ]);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /ISOLATION_MODE_CONFLICT/);
    assert.deepEqual(await recordedCalls(runtime.state), []);
  });

  it("keeps v2 trusted-local requests behind the explicit authorization flag", async () => {
    const { requestPath } = await structuredContainerRequest({
      kind: "trusted-local",
      acknowledgedUnsafeExecution: false,
      environmentAllowlist: [],
    });
    const result = await cli(["verify", requestPath]);
    assert.equal(result.code, 4);
    assert.match(
      result.stderr,
      /Refusing trusted-local execution without --allow-unsafe-execution/,
    );
  });
});

describe("container isolation through the SDK", () => {
  it("requires exactly one explicit isolation mode for Git checks", async () => {
    const value = await gitFixture();
    const ledger = new AssertLedger();
    const base = {
      repository: value.root,
      before: value.before,
      after: value.after,
      neutral: value.after,
      neutralReason: "explicit repeated control",
      test: "candidate.test.js",
      baseTests: ["base.test.js"],
      out: ".assertledger/evidence",
    };
    await assert.rejects(
      ledger.checkGitRegression({ ...base, allowUnsafeExecution: false }),
      /GIT_REGRESSION_UNSAFE_EXECUTION_NOT_ALLOWED/,
    );
    await assert.rejects(
      ledger.checkGitRegression({
        ...base,
        allowUnsafeExecution: true,
        container: { image: IMAGE },
      }),
      /ISOLATION_MODE_CONFLICT/,
    );
    const missing = path.join(os.tmpdir(), `assertledger-missing-runtime-${randomUUID()}`);
    await assert.rejects(
      ledger.checkGitRegression({
        ...base,
        allowUnsafeExecution: false,
        container: { image: IMAGE, runtimeCommand: [missing] },
      }),
      /CONTAINER_RUNTIME_NOT_FOUND/,
    );
    assert.equal(await exists(path.join(value.root, ".assertledger", "evidence")), false);
  });

  it("passes the operator runtime command to verify without reading it from the request", async () => {
    const { requestPath } = await structuredContainerRequest();
    const runtime = await fakeRuntime();
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const manifest = await new AssertLedger().verify(request, {
      containerRuntime: { command: runtime.command },
    });
    assert.equal(manifest.schemaVersion, "2.0.0");
    assert.equal(manifest.isolation.kind, "container");
  });
});

describe("container diagnostics", () => {
  it("explains every container stop with a safe next action", () => {
    const codes = [
      "CONTAINER_CLEANUP_FAILED",
      "CONTAINER_IMAGE_DIGEST_MISMATCH",
      "CONTAINER_IMAGE_NOT_PRESENT",
      "CONTAINER_IMAGE_PLATFORM_UNSUPPORTED",
      "CONTAINER_RUNTIME_COMMAND_INVALID",
      "CONTAINER_RUNTIME_NOT_FOUND",
      "CONTAINER_RUNTIME_PLATFORM_UNSUPPORTED",
      "CONTAINER_RUNTIME_UNAVAILABLE",
      "ISOLATION_MODE_CONFLICT",
    ];
    const report = explainReasonCodes(codes);
    assert.deepEqual(
      report.diagnostics.map((item) => [item.code, item.known]),
      codes.map((code) => [code, true]),
    );
    const image = report.diagnostics.find((item) => item.code === "CONTAINER_IMAGE_NOT_PRESENT");
    assert.match(image?.nextAction ?? "", /pull/);
    assert.match(image?.nextAction ?? "", /digest/);
  });
});
