import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type CliIo, runCli } from "../src/cli.js";
import type { RepositoryInitResult } from "../src/contracts/index.js";
import { parseRuntimeDoctorResult } from "../src/contracts/runtime-doctor.js";
import { runNodeTestRuntimePreflight } from "../src/engine/adapters/node-test-runtime.js";
import { initializeRepository, runProcess } from "../src/engine/index.js";
import {
  type RuntimeDoctorDependencies,
  runRuntimeDoctorChecks,
} from "../src/engine/runtime-doctor.js";
import { createAssertLedgerServer } from "../src/mcp/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function staticResult(status: RepositoryInitResult["status"] = "UNCHANGED"): RepositoryInitResult {
  return {
    schemaVersion: "1.0.0",
    status,
    reasonCodes: status === "CONFLICT" ? ["LOCK_INVALID"] : [],
    detections: {
      packageManager: "pnpm",
      framework: "node:test",
      testCommand: { executable: "node", arguments: ["--test"] },
      ciProviders: [],
      adapterRecommendation: "node-test",
      reasonCodes: status === "CONFLICT" ? ["LOCK_INVALID"] : [],
    },
    actions:
      status === "WOULD_CREATE" ? [{ kind: "REGENERATE", path: "assertledger.lock.json" }] : [],
    files: [],
    requiredOperatorInputs: ["worlds", "candidates"],
    nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
  } as RepositoryInitResult;
}

function dependencies(overrides: Partial<RuntimeDoctorDependencies> = {}) {
  const calls: string[] = [];
  const value: RuntimeDoctorDependencies = {
    inspectConfiguration: async () => {
      calls.push("configuration");
      return staticResult();
    },
    probeExecutable: async () => {
      calls.push("executable");
      return { nodeVersion: "22.15.0" };
    },
    probeDependencies: async () => {
      calls.push("dependencies");
    },
    probeTemporaryWorkspace: async () => {
      calls.push("temporary-workspace");
    },
    runSyntheticPreflight: async () => {
      calls.push("preflight");
    },
    ...overrides,
  };
  return { calls, value };
}

function captureIo(cwd: string): { io: CliIo; stdout(): string; stderr(): string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      readStdin: async () => "",
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-runtime-doctor-"));
  temporaryDirectories.push(root);
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@11.1.2",
      scripts: { test: "node --test base.test.js" },
    })}\n`,
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    path.join(root, "base.test.js"),
    'import test from "node:test";\ntest("base", () => {});\n',
  );
  assert.equal((await initializeRepository(root)).status, "CREATED");
  return root;
}

describe("runtime doctor", () => {
  it("keeps runtime MCP opt-in and matches SDK diagnostics within the allowed root", async () => {
    const root = await realpath(await fixtureRepository());
    const outside = await fixtureRepository();
    assert.equal(
      createAssertLedgerServer().toolInputSchemaJson("assertledger_doctor_runtime"),
      undefined,
    );
    const server = createAssertLedgerServer({
      allowUnsafeExecution: true,
      allowedRepositoryRoots: [root],
    });
    const schema = server.toolInputSchemaJson("assertledger_doctor_runtime");
    assert.ok(schema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(server.toolInputSchemaJson("testforge_doctor_runtime"), schema);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "runtime-doctor-client", version: "1.0.0" });
    await server.connect(st);
    await client.connect(ct);
    try {
      const refused = await client.callTool({
        name: "assertledger_doctor_runtime",
        arguments: { root: outside },
      });
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused.content), /MCP_REPOSITORY_ROOT_FORBIDDEN/);
      const expected = await new AssertLedger().doctorRuntime(root, { allowUnsafeExecution: true });
      const observed = await client.callTool({
        name: "assertledger_doctor_runtime",
        arguments: { root },
      });
      assert.notEqual(observed.isError, true);
      assert.deepEqual(observed.structuredContent, expected);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("blocks before all executable probes when trusted-local execution is not acknowledged", async () => {
    const fixture = dependencies();
    const result = await runRuntimeDoctorChecks("C:/fixture", false, fixture.value);

    parseRuntimeDoctorResult(result);
    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(result.reasonCodes, ["RUNTIME_EXECUTION_NOT_AUTHORIZED"]);
    assert.deepEqual(fixture.calls, []);
    assert.equal(result.executionMode, "UNSANDBOXED_TRUSTED_LOCAL");
    const stringCapability = await runRuntimeDoctorChecks(
      "C:/fixture",
      "true" as unknown as boolean,
      fixture.value,
    );
    assert.equal(stringCapability.status, "BLOCKED");
    assert.deepEqual(fixture.calls, []);
    assert.throws(() => parseRuntimeDoctorResult({ ...result, extra: true }));
    assert.throws(() =>
      parseRuntimeDoctorResult({
        ...result,
        checks: result.checks.map((entry, index) =>
          index === 0 ? { ...entry, status: "PASS" } : entry,
        ),
      }),
    );
  });

  it("reports READY only after every supported runtime boundary passes", async () => {
    const fixture = dependencies();
    const result = await runRuntimeDoctorChecks("C:/fixture", true, fixture.value);

    assert.equal(result.status, "READY");
    assert.deepEqual(fixture.calls, [
      "configuration",
      "executable",
      "dependencies",
      "temporary-workspace",
      "preflight",
    ]);
    assert.equal(result.checks.at(-1)?.status, "LIMITATION");
    assert.match(result.limitations.join(" "), /does not run repository tests/iu);
    assert.throws(
      () =>
        parseRuntimeDoctorResult({
          ...result,
          checks: [result.checks[0], result.checks.at(-1)],
        }),
      /RUNTIME_DOCTOR_RESULT_INVALID/u,
    );
  });

  it("fails closed on stale configuration before executing probes", async () => {
    const fixture = dependencies({
      inspectConfiguration: async () => staticResult("WOULD_CREATE"),
    });
    const result = await runRuntimeDoctorChecks("C:/fixture", true, fixture.value);

    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(result.reasonCodes, ["RUNTIME_CONFIGURATION_STALE"]);
    assert.deepEqual(fixture.calls, []);
  });

  it("distinguishes missing executables and dependencies", async () => {
    const missingExecutable = dependencies({
      probeExecutable: async () => {
        throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
      },
    });
    const executableResult = await runRuntimeDoctorChecks(
      "C:/fixture",
      true,
      missingExecutable.value,
    );
    assert.deepEqual(executableResult.reasonCodes, ["RUNTIME_EXECUTABLE_UNAVAILABLE"]);

    const missingDependency = dependencies({
      probeDependencies: async () => {
        throw new Error("NODE_TEST_DEPENDENCY_UNAVAILABLE");
      },
    });
    const dependencyResult = await runRuntimeDoctorChecks(
      "C:/fixture",
      true,
      missingDependency.value,
    );
    assert.deepEqual(dependencyResult.reasonCodes, ["RUNTIME_DEPENDENCY_UNAVAILABLE"]);
  });

  it("blocks generated-unsupported and operator-supplied adapters", async () => {
    const unsupportedAdapter = dependencies({
      inspectConfiguration: async () => ({
        ...staticResult(),
        detections: {
          ...staticResult().detections,
          framework: "vitest",
          adapterRecommendation: "unavailable",
        },
      }),
    });
    const adapterResult = await runRuntimeDoctorChecks(
      "C:/fixture",
      true,
      unsupportedAdapter.value,
    );
    assert.deepEqual(adapterResult.reasonCodes, ["RUNTIME_ADAPTER_UNSUPPORTED"]);

    const operatorSupplied = dependencies({
      inspectConfiguration: async () => ({
        ...staticResult(),
        detections: {
          ...staticResult().detections,
          adapterRecommendation: "operator-supplied",
        },
      }),
    });
    const operatorResult = await runRuntimeDoctorChecks("C:/fixture", true, operatorSupplied.value);
    assert.deepEqual(operatorResult.reasonCodes, ["RUNTIME_ADAPTER_UNSUPPORTED"]);
  });

  it("maps a denied temporary-workspace probe without claiming a real permission change", async () => {
    const deniedTemporaryWorkspace = dependencies({
      probeTemporaryWorkspace: async () => {
        throw new Error("TEMPORARY_WORKSPACE_PROBE_FAILED");
      },
    });
    const workspaceResult = await runRuntimeDoctorChecks(
      "C:/fixture",
      true,
      deniedTemporaryWorkspace.value,
    );
    assert.deepEqual(workspaceResult.reasonCodes, ["RUNTIME_TEMPORARY_WORKSPACE_UNAVAILABLE"]);
  });

  it("fails closed when the reporter is malformed or discovers no controlled tests", async () => {
    const reporterSources = [
      'export default async function* reporter() { yield "not-json"; }\n',
      [
        "export default async function* reporter(source) {",
        "  for await (const _event of source) {}",
        "  yield JSON.stringify({",
        '    protocolVersion: "1.0.0",',
        "    testsDiscovered: 0,",
        "    candidateTestsDiscovered: 0,",
        "    candidateFailureCount: 0,",
        "    nonCandidateFailureCount: 0,",
        "    candidateSyntaxFailureCount: 0,",
        "    candidateFailuresAllAssertions: false,",
        "  });",
        "}",
        "",
      ].join("\n"),
    ];
    for (const reporterSource of reporterSources) {
      const fixture = dependencies({
        runSyntheticPreflight: async () => {
          await runNodeTestRuntimePreflight({
            executable: process.execPath,
            reporterSource,
            environment: {},
            timeoutMs: 5_000,
            maximumOutputBytes: 64 * 1024,
            processRunner: runProcess,
          });
        },
      });
      const result = await runRuntimeDoctorChecks("C:/fixture", true, fixture.value);
      assert.deepEqual(result.reasonCodes, ["RUNTIME_PREFLIGHT_FAILED"]);
      assert.equal(result.status, "BLOCKED");
    }
  });

  it("runs the real SDK probes without changing repository files", {
    timeout: 20_000,
  }, async () => {
    const root = await fixtureRepository();
    const before = await Promise.all(
      [
        "package.json",
        "pnpm-lock.yaml",
        "base.test.js",
        "assertledger.config.json",
        "assertledger.lock.json",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    );

    const result = await new AssertLedger().doctorRuntime(root, { allowUnsafeExecution: true });

    assert.equal(result.status, "READY");
    assert.deepEqual(
      await Promise.all(
        [
          "package.json",
          "pnpm-lock.yaml",
          "base.test.js",
          "assertledger.config.json",
          "assertledger.lock.json",
        ].map((file) => readFile(path.join(root, file), "utf8")),
      ),
      before,
    );
  });

  it("exposes strict CLI flags and a stable denied result", async () => {
    const root = await fixtureRepository();
    const denied = captureIo(root);
    assert.equal(await runCli(["doctor", ".", "--runtime", "--json"], denied.io), 3);
    assert.equal(parseRuntimeDoctorResult(JSON.parse(denied.stdout())).status, "BLOCKED");
    assert.equal(denied.stderr(), "");

    const authorized = captureIo(root);
    assert.equal(
      await runCli(
        ["doctor", ".", "--runtime", "--allow-unsafe-execution", "--json"],
        authorized.io,
      ),
      0,
    );
    assert.equal(parseRuntimeDoctorResult(JSON.parse(authorized.stdout())).status, "READY");
    assert.equal(authorized.stderr(), "");

    const ledgerWithUntypedInput = new AssertLedger() as unknown as {
      doctorRuntime(
        requestedRoot: string,
        options: { allowUnsafeExecution: unknown },
      ): Promise<unknown>;
    };
    const sdkStringCapability = parseRuntimeDoctorResult(
      await ledgerWithUntypedInput.doctorRuntime(root, { allowUnsafeExecution: "true" }),
    );
    assert.equal(sdkStringCapability.status, "BLOCKED");

    for (const argv of [
      ["doctor", ".", "--allow-unsafe-execution"],
      ["doctor", ".", "--runtime", "--runtime"],
      ["doctor", ".", "--runtime", "--allow-unsafe-execution", "--allow-unsafe-execution"],
      ["doctor", ".", "--runtime", "--unknown"],
    ]) {
      const capture = captureIo(root);
      assert.equal(await runCli(argv, capture.io), 64);
      assert.equal(capture.stdout(), "");
      assert.match(capture.stderr(), /Usage: assertledger/u);
    }
  });
});
