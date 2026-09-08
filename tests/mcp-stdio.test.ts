import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
        "assertledger_profile",
        "assertledger_profile_replay",
        "assertledger_profile_v2",
        "assertledger_profile_v2_replay",
        "assertledger_replay",
        "assertledger_schema",
        "testforge_analyze",
        "testforge_benchmark",
        "testforge_benchmark_acquire_replay",
        "testforge_benchmark_replay",
        "testforge_corpus_allocate",
        "testforge_corpus_allocation_replay",
        "testforge_profile",
        "testforge_profile_replay",
        "testforge_profile_v2",
        "testforge_profile_v2_replay",
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
        "assertledger_corpus_allocate",
        "assertledger_corpus_allocation_replay",
        "assertledger_profile",
        "assertledger_profile_replay",
        "assertledger_profile_v2",
        "assertledger_profile_v2_replay",
        "assertledger_replay",
        "assertledger_schema",
        "assertledger_verify",
        "testforge_analyze",
        "testforge_benchmark",
        "testforge_benchmark_acquire",
        "testforge_benchmark_acquire_replay",
        "testforge_benchmark_replay",
        "testforge_corpus_allocate",
        "testforge_corpus_allocation_replay",
        "testforge_profile",
        "testforge_profile_replay",
        "testforge_profile_v2",
        "testforge_profile_v2_replay",
        "testforge_replay",
        "testforge_schema",
        "testforge_verify",
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
