import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseRepositoryInitResult } from "../src/contracts/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP 2026 stdio transport", () => {
  async function connect(args: string[]) {
    const root = process.cwd();
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), ...args],
      cwd: root,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const client = new Client(
      { name: "testforge-transport-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
          probe: { timeoutMs: 5_000 },
        },
      },
    );

    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    return { client, stderr };
  }

  async function connectBuilt(cwd: string) {
    const sourceRoot = process.cwd();
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(sourceRoot, "dist", "mcp", "stdio.js")],
      cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const client = new Client(
      { name: "assertledger-built-transport-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: { pin: "2026-07-28" },
          probe: { timeoutMs: 5_000 },
        },
      },
    );
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    return { client, stderr };
  }

  it("starts read-only by default and calls an AssertLedger tool", {
    timeout: 15_000,
  }, async () => {
    const { client, stderr } = await connect(["src/mcp/stdio.ts"]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "assertledger_analyze",
        "assertledger_benchmark",
        "assertledger_benchmark_acquire_replay",
        "assertledger_benchmark_replay",
        "assertledger_corpus_allocate",
        "assertledger_corpus_allocation_replay",
        "assertledger_doctor",
        "assertledger_explain",
        "assertledger_export",
        "assertledger_export_replay",
        "assertledger_profile",
        "assertledger_profile_replay",
        "assertledger_profile_v2",
        "assertledger_profile_v2_replay",
        "assertledger_provider",
        "assertledger_replay",
        "assertledger_schema",
        "testforge_analyze",
        "testforge_benchmark",
        "testforge_benchmark_acquire_replay",
        "testforge_benchmark_replay",
        "testforge_corpus_allocate",
        "testforge_corpus_allocation_replay",
        "testforge_doctor",
        "testforge_explain",
        "testforge_export",
        "testforge_export_replay",
        "testforge_profile",
        "testforge_profile_replay",
        "testforge_profile_v2",
        "testforge_profile_v2_replay",
        "testforge_provider",
        "testforge_replay",
        "testforge_schema",
      ]);
      assert.ok(listed.tools.find((tool) => tool.name === "assertledger_analyze")?.outputSchema);
      assert.ok(listed.tools.find((tool) => tool.name === "assertledger_replay")?.outputSchema);
      assert.ok(listed.tools.find((tool) => tool.name === "testforge_analyze")?.outputSchema);
      assert.ok(listed.tools.find((tool) => tool.name === "testforge_replay")?.outputSchema);

      const preferred = await client.callTool({
        name: "assertledger_schema",
        arguments: { name: "verification-request" },
      });
      const legacy = await client.callTool({
        name: "testforge_schema",
        arguments: { name: "verification-request" },
      });
      assert.equal(preferred.isError, undefined, stderr.join(""));
      assert.equal(legacy.isError, undefined, stderr.join(""));
      assert.ok(preferred.structuredContent);
      assert.deepEqual(preferred.structuredContent, legacy.structuredContent);
      assert.equal(
        (preferred.structuredContent as Record<string, unknown>).$id,
        "https://testforge.dev/schemas/verification-request.v1.json",
      );
    } finally {
      await client.close();
    }
  });

  it("serves the static doctor through the built read-only stdio entrypoint", {
    timeout: 15_000,
  }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-mcp-doctor-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "test"));
    const packagePath = path.join(root, "package.json");
    await writeFile(
      packagePath,
      JSON.stringify({
        name: "fixture",
        packageManager: "pnpm@11.0.0",
        scripts: { test: "node --test test/*.test.js" },
      }),
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const executionSentinel = path.join(root, "doctor-executed.txt");
    await writeFile(
      path.join(root, "test", "base.test.js"),
      "import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../doctor-executed.txt', import.meta.url), 'executed');\n",
    );
    const beforePackage = await readFile(packagePath, "utf8");
    const { client, stderr } = await connectBuilt(root);

    try {
      const listed = await client.listTools();
      assert.equal(
        listed.tools.some((tool) => tool.name === "assertledger_verify"),
        false,
      );
      assert.equal(
        listed.tools.some((tool) => tool.name === "testforge_verify"),
        false,
      );
      assert.equal(
        listed.tools.some((tool) => tool.name === "assertledger_benchmark_acquire"),
        false,
      );
      assert.equal(
        listed.tools.some((tool) => tool.name === "testforge_benchmark_acquire"),
        false,
      );

      const preferred = await client.callTool({
        name: "assertledger_doctor",
        arguments: { root },
      });
      const legacy = await client.callTool({ name: "testforge_doctor", arguments: { root } });
      assert.equal(preferred.isError, undefined, stderr.join(""));
      assert.equal(legacy.isError, undefined, stderr.join(""));
      assert.deepEqual(preferred.structuredContent, legacy.structuredContent);
      assert.equal(parseRepositoryInitResult(preferred.structuredContent).status, "WOULD_CREATE");
      assert.equal(await readFile(packagePath, "utf8"), beforePackage);
      await assert.rejects(
        readFile(path.join(root, "assertledger.config.json"), "utf8"),
        /ENOENT/u,
      );
      await assert.rejects(readFile(path.join(root, "assertledger.lock.json"), "utf8"), /ENOENT/u);
      await assert.rejects(readFile(executionSentinel, "utf8"), /ENOENT/u);
    } finally {
      await client.close();
    }
  });

  it("reports an undeclared link and accepts declared exclusions through the static doctor", {
    timeout: 15_000,
  }, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-mcp-exclude-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "test"));
    await mkdir(path.join(root, ".local-tools"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        packageManager: "pnpm@11.0.0",
        scripts: { test: "node --test test/*.test.js" },
      }),
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(root, "test", "base.test.js"), "import test from 'node:test';\n");
    try {
      await symlink(
        path.join(root, "test", "base.test.js"),
        path.join(root, ".local-tools", "linked.test.js"),
        "file",
      );
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (!["EACCES", "EPERM", "UNKNOWN"].includes(code)) throw error;
      context.skip(`symlink creation is unavailable: ${code}`);
      return;
    }
    const { client, stderr } = await connectBuilt(root);

    try {
      const undeclared = await client.callTool({
        name: "assertledger_doctor",
        arguments: { root },
      });
      assert.equal(undeclared.isError, undefined, stderr.join(""));
      assert.deepEqual(parseRepositoryInitResult(undeclared.structuredContent).reasonCodes, [
        "UNSUPPORTED_REPOSITORY_SYMLINK",
      ]);
      const declared = await client.callTool({
        name: "assertledger_doctor",
        arguments: { root, exclude: [".local-tools"] },
      });
      assert.equal(declared.isError, undefined, stderr.join(""));
      assert.equal(parseRepositoryInitResult(declared.structuredContent).status, "WOULD_CREATE");
      for (const exclude of [["nested/name"], [""]]) {
        const invalid = await client.callTool({
          name: "assertledger_doctor",
          arguments: { root, exclude },
        });
        assert.equal(invalid.isError, undefined, stderr.join(""));
        assert.deepEqual(parseRepositoryInitResult(invalid.structuredContent).reasonCodes, [
          "INVALID_REPOSITORY_EXCLUDE",
        ]);
      }

      assert.equal(
        (await new AssertLedger().init(root, { exclude: [".local-tools"] })).status,
        "CREATED",
      );
      const inherited = await client.callTool({ name: "assertledger_doctor", arguments: { root } });
      assert.equal(parseRepositoryInitResult(inherited.structuredContent).status, "UNCHANGED");
      const emptied = await client.callTool({
        name: "assertledger_doctor",
        arguments: { root, exclude: [] },
      });
      assert.deepEqual(parseRepositoryInitResult(emptied.structuredContent).reasonCodes, [
        "UNSUPPORTED_REPOSITORY_SYMLINK",
      ]);
    } finally {
      await client.close();
    }
  });

  it("exposes verify only in an operator-authorized child process", {
    timeout: 15_000,
  }, async () => {
    const { client } = await connect(["src/mcp/stdio.ts", "--allow-unsafe-execution"]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "assertledger_analyze",
        "assertledger_benchmark",
        "assertledger_benchmark_acquire",
        "assertledger_benchmark_acquire_replay",
        "assertledger_benchmark_replay",
        "assertledger_check",
        "assertledger_corpus_allocate",
        "assertledger_corpus_allocation_replay",
        "assertledger_doctor",
        "assertledger_doctor_runtime",
        "assertledger_explain",
        "assertledger_export",
        "assertledger_export_replay",
        "assertledger_profile",
        "assertledger_profile_replay",
        "assertledger_profile_v2",
        "assertledger_profile_v2_replay",
        "assertledger_provider",
        "assertledger_replay",
        "assertledger_schema",
        "assertledger_verify",
        "assertledger_verify_v3",
        "testforge_analyze",
        "testforge_benchmark",
        "testforge_benchmark_acquire",
        "testforge_benchmark_acquire_replay",
        "testforge_benchmark_replay",
        "testforge_check",
        "testforge_corpus_allocate",
        "testforge_corpus_allocation_replay",
        "testforge_doctor",
        "testforge_doctor_runtime",
        "testforge_explain",
        "testforge_export",
        "testforge_export_replay",
        "testforge_profile",
        "testforge_profile_replay",
        "testforge_profile_v2",
        "testforge_profile_v2_replay",
        "testforge_provider",
        "testforge_replay",
        "testforge_schema",
        "testforge_verify",
        "testforge_verify_v3",
      ]);
      const preferredVerify = listed.tools.find((tool) => tool.name === "assertledger_verify");
      const legacyVerify = listed.tools.find((tool) => tool.name === "testforge_verify");
      assert.ok(preferredVerify);
      assert.ok(legacyVerify);
      assert.ok(preferredVerify.outputSchema);
      assert.deepEqual(preferredVerify.inputSchema, legacyVerify.inputSchema);
      assert.deepEqual(preferredVerify.outputSchema, legacyVerify.outputSchema);
      assert.deepEqual(preferredVerify.annotations, legacyVerify.annotations);
      assert.deepEqual(preferredVerify.inputSchema.required, ["request"]);
      assert.equal(preferredVerify.inputSchema.properties?.allowUnsafeExecution, undefined);
      assert.deepEqual(preferredVerify.annotations, {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      });
    } finally {
      await client.close();
    }
  });

  it("forwards the CLI authorization flag to the MCP server factory", {
    timeout: 15_000,
  }, async () => {
    const { client } = await connect(["src/cli.ts", "mcp", "--allow-unsafe-execution"]);

    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "assertledger_verify"));
      assert.ok(listed.tools.some((tool) => tool.name === "testforge_verify"));
    } finally {
      await client.close();
    }
  });
});
