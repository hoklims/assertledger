import { realpath } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  EvidenceManifestSchema,
  ReplayResultSchema,
  RepositoryAnalysisSchema,
  VerificationRequestSchema,
} from "../contracts/index.js";
import { TestForge } from "../sdk/index.js";

function jsonResult(value: unknown) {
  const structuredContent =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

export interface TestForgeServerOptions {
  /** Operator-owned capability. Candidate code execution is unavailable unless explicitly enabled. */
  allowUnsafeExecution?: boolean;
  /** Repository roots this MCP instance may inspect or execute within. */
  allowedRepositoryRoots?: string[];
}

export function createTestForgeServer(options: TestForgeServerOptions = {}): McpServer {
  const testforge = new TestForge();
  const allowedRepositoryRoots = options.allowedRepositoryRoots ?? [process.cwd()];

  async function confinedRepositoryRoot(requestedRoot: string): Promise<string> {
    const [requested, ...allowed] = await Promise.all([
      realpath(requestedRoot),
      ...allowedRepositoryRoots.map((root) => realpath(root)),
    ]);
    const permitted = allowed.some((root) => {
      const relative = path.relative(root, requested);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    });
    if (!permitted) throw new Error("MCP_REPOSITORY_ROOT_FORBIDDEN");
    return requested;
  }

  const server = new McpServer(
    { name: "testforge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "testforge_analyze",
    {
      title: "Analyze a repository",
      description: "Produce deterministic repository context for test generation.",
      inputSchema: z.strictObject({ root: z.string().min(1) }),
      outputSchema: RepositoryAnalysisSchema,
    },
    async ({ root }) => jsonResult(await testforge.analyze(await confinedRepositoryRoot(root))),
  );

  if (options.allowUnsafeExecution === true) {
    server.registerTool(
      "testforge_verify",
      {
        title: "Verify candidate tests",
        description:
          "DANGEROUS: execute untrusted candidate code locally, then deterministically evaluate the evidence. This tool exists only when enabled by the server operator.",
        inputSchema: z.strictObject({ request: VerificationRequestSchema }),
        outputSchema: EvidenceManifestSchema,
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
      },
      async ({ request }) => {
        const root = await confinedRepositoryRoot(request.repository.root);
        return jsonResult(
          await testforge.verify({
            ...request,
            repository: { ...request.repository, root },
            isolation: {
              ...request.isolation,
              acknowledgedUnsafeExecution: true,
            },
          }),
        );
      },
    );
  }

  server.registerTool(
    "testforge_replay",
    {
      title: "Replay evidence",
      description:
        "Strictly validate an evidence manifest, then independently replay its integrity seals and deterministic decision semantics.",
      inputSchema: z.strictObject({ manifest: EvidenceManifestSchema }),
      outputSchema: ReplayResultSchema,
    },
    async ({ manifest }) => jsonResult(testforge.replay(manifest)),
  );

  server.registerTool(
    "testforge_schema",
    {
      title: "Get a TestForge schema",
      description: "Return a versioned JSON Schema used by TestForge.",
      inputSchema: z.strictObject({
        name: z.enum([
          "verification-request",
          "repository-analysis",
          "evidence-manifest",
          "replay-result",
        ]),
      }),
    },
    async ({ name }) => jsonResult(testforge.schema(name)),
  );

  return server;
}
