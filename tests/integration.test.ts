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
};

async function loadIntegration(): Promise<IntegrationApi> {
  try {
    const [{ TestForge }, { runCli }, { createTestForgeServer }, { decideEvidence }] =
      await Promise.all([
        import("../src/sdk/index.js"),
        import("../src/cli.js"),
        import("../src/mcp/index.js"),
        import("../src/core/index.js"),
      ]);
    return { TestForge, runCli, createTestForgeServer, decideEvidence } as IntegrationApi;
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
      },
      runCli: async () => 99,
      createTestForgeServer: () => undefined,
      decideEvidence: () => undefined,
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

  it("uses a stable usage exit code for unknown commands", async () => {
    const capture = captureIo(process.cwd());

    const code = await integration.runCli(["unknown"], capture.io);

    assert.equal(code, 64);
    assert.match(capture.stderr(), /Usage: testforge/);
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

      assert.equal(exitCode, 4);
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
    for (const tool of ["testforge_analyze", "testforge_replay", "testforge_schema"]) {
      assert.ok(server.toolInputSchemaJson(tool), `missing MCP tool ${tool}`);
    }
    assert.equal(server.toolInputSchemaJson("testforge_verify"), undefined);
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

  it("publishes strict output schemas and all four public schema names", async () => {
    const { client } = await connectServer({ allowUnsafeExecution: true });
    const server = integration.createTestForgeServer({ allowUnsafeExecution: true });
    const listed = await client.listTools();
    for (const tool of ["testforge_analyze", "testforge_verify", "testforge_replay"]) {
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
      "verification-request",
      "repository-analysis",
      "evidence-manifest",
      "replay-result",
    ]);
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
