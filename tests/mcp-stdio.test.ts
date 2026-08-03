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

  it("starts read-only by default and calls a TestForge tool", {
    timeout: 15_000,
  }, async () => {
    const { client, stderr } = await connect(["src/mcp/stdio.ts"]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "testforge_analyze",
        "testforge_replay",
        "testforge_schema",
      ]);
      assert.ok(listed.tools.find((tool) => tool.name === "testforge_analyze")?.outputSchema);
      assert.ok(listed.tools.find((tool) => tool.name === "testforge_replay")?.outputSchema);

      const result = await client.callTool({
        name: "testforge_schema",
        arguments: { name: "verification-request" },
      });
      assert.equal(result.isError, undefined, stderr.join(""));
      assert.ok(result.structuredContent);
      assert.equal(
        (result.structuredContent as Record<string, unknown>).$id,
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
        "testforge_analyze",
        "testforge_replay",
        "testforge_schema",
        "testforge_verify",
      ]);
      const verify = listed.tools.find((tool) => tool.name === "testforge_verify");
      assert.ok(verify);
      assert.ok(verify.outputSchema);
      assert.deepEqual(verify.inputSchema.required, ["request"]);
      assert.equal(verify.inputSchema.properties?.allowUnsafeExecution, undefined);
      assert.deepEqual(verify.annotations, {
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
      assert.ok(listed.tools.some((tool) => tool.name === "testforge_verify"));
    } finally {
      await client.close();
    }
  });
});
