import { realpath } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  AgenticBenchmarkAcquisitionReplayResultSchema,
  AgenticBenchmarkAcquisitionRequestSchema,
  AgenticBenchmarkAcquisitionResultSchema,
  AgenticBenchmarkArtifactSchema,
  AgenticBenchmarkReplayResultSchema,
  AgenticBenchmarkRequestSchema,
  AgenticCorpusAllocationReplayResultSchema,
  AgenticCorpusAllocationRequestSchema,
  AgenticCorpusAllocationSchema,
  AgenticProfileReplayResultSchema,
  AgenticProfileReplayResultV2Schema,
  AgenticProfileReportSchema,
  AgenticProfileReportV2Schema,
  AgenticProfileRequestSchema,
  AgenticProfileRequestV2Schema,
  EvidenceManifestSchema,
  ReplayResultSchema,
  RepositoryAnalysisSchema,
  RepositoryInitResultSchema,
  VerificationRequestSchema,
} from "../contracts/index.js";
import { AssertLedger } from "../sdk/index.js";
import { ASSERTLEDGER_VERSION } from "../version.js";

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

export interface AssertLedgerServerOptions {
  /** Operator-owned capability. Candidate code execution is unavailable unless explicitly enabled. */
  allowUnsafeExecution?: boolean;
  /** Repository roots this MCP instance may inspect or execute within. */
  allowedRepositoryRoots?: string[];
}

/** @deprecated Use `AssertLedgerServerOptions`. Alias retained for v1 compatibility. */
export type TestForgeServerOptions = AssertLedgerServerOptions;

export function createAssertLedgerServer(options: AssertLedgerServerOptions = {}): McpServer {
  const assertLedger = new AssertLedger();
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
    { name: "assertledger", version: ASSERTLEDGER_VERSION },
    { capabilities: { tools: {} } },
  );

  const analyzeInputSchema = z.strictObject({ root: z.string().min(1) });
  const analyzeConfig = {
    title: "Analyze a repository",
    description: "Produce deterministic repository context for test generation.",
    inputSchema: analyzeInputSchema,
    outputSchema: RepositoryAnalysisSchema,
  };
  const analyzeHandler = async ({ root }: z.infer<typeof analyzeInputSchema>) =>
    jsonResult(await assertLedger.analyze(await confinedRepositoryRoot(root)));
  server.registerTool("assertledger_analyze", analyzeConfig, analyzeHandler);
  server.registerTool("testforge_analyze", analyzeConfig, analyzeHandler);

  const doctorInputSchema = z.strictObject({ root: z.string().min(1) });
  const doctorConfig = {
    title: "Inspect repository readiness",
    description:
      "Return a static AssertLedger initialization plan without writing files or executing repository code.",
    inputSchema: doctorInputSchema,
    outputSchema: RepositoryInitResultSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const doctorHandler = async ({ root }: z.infer<typeof doctorInputSchema>) =>
    jsonResult(await assertLedger.doctor(await confinedRepositoryRoot(root)));
  server.registerTool("assertledger_doctor", doctorConfig, doctorHandler);
  server.registerTool("testforge_doctor", doctorConfig, doctorHandler);

  if (options.allowUnsafeExecution === true) {
    const verifyInputSchema = z.strictObject({ request: VerificationRequestSchema });
    const verifyConfig = {
      title: "Verify candidate tests",
      description:
        "DANGEROUS: execute untrusted candidate code locally, then deterministically evaluate the evidence. This tool exists only when enabled by the server operator.",
      inputSchema: verifyInputSchema,
      outputSchema: EvidenceManifestSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
    };
    const verifyHandler = async ({ request }: z.infer<typeof verifyInputSchema>) => {
      const root = await confinedRepositoryRoot(request.repository.root);
      return jsonResult(
        await assertLedger.verify({
          ...request,
          repository: { ...request.repository, root },
          isolation: {
            ...request.isolation,
            acknowledgedUnsafeExecution: true,
          },
        }),
      );
    };
    server.registerTool("assertledger_verify", verifyConfig, verifyHandler);
    server.registerTool("testforge_verify", verifyConfig, verifyHandler);

    const benchmarkAcquireInputSchema = z.strictObject({
      request: AgenticBenchmarkAcquisitionRequestSchema,
    });
    const benchmarkAcquireConfig = {
      title: "Acquire phase-aware benchmark evidence",
      description:
        "DANGEROUS: execute a fresh verification campaign and strict phase-aware benchmark runs in UNSANDBOXED trusted-local workspaces. This tool exists only when enabled by the server operator.",
      inputSchema: benchmarkAcquireInputSchema,
      outputSchema: AgenticBenchmarkAcquisitionResultSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
    };
    const benchmarkAcquireHandler = async ({
      request,
    }: z.infer<typeof benchmarkAcquireInputSchema>) => {
      const root = await confinedRepositoryRoot(request.verificationRequest.repository.root);
      return jsonResult(
        await assertLedger.acquireBenchmark({
          ...request,
          verificationRequest: {
            ...request.verificationRequest,
            repository: { ...request.verificationRequest.repository, root },
            isolation: {
              ...request.verificationRequest.isolation,
              acknowledgedUnsafeExecution: true,
            },
          },
        }),
      );
    };
    server.registerTool(
      "assertledger_benchmark_acquire",
      benchmarkAcquireConfig,
      benchmarkAcquireHandler,
    );
    server.registerTool(
      "testforge_benchmark_acquire",
      benchmarkAcquireConfig,
      benchmarkAcquireHandler,
    );
  }

  const replayInputSchema = z.strictObject({ manifest: EvidenceManifestSchema });
  const replayConfig = {
    title: "Replay evidence",
    description:
      "Strictly validate an evidence manifest, then independently replay its integrity seals and deterministic decision semantics.",
    inputSchema: replayInputSchema,
    outputSchema: ReplayResultSchema,
  };
  const replayHandler = ({ manifest }: z.infer<typeof replayInputSchema>) =>
    jsonResult(assertLedger.replay(manifest));
  server.registerTool("assertledger_replay", replayConfig, replayHandler);
  server.registerTool("testforge_replay", replayConfig, replayHandler);

  const benchmarkInputSchema = z.strictObject({ request: AgenticBenchmarkRequestSchema });
  const benchmarkConfig = {
    title: "Derive an Agentic Benchmark Artifact",
    description:
      "Deterministically summarize declared cold/warm phased measurements without changing the source VERIFIED decision.",
    inputSchema: benchmarkInputSchema,
    outputSchema: AgenticBenchmarkArtifactSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const benchmarkHandler = ({ request }: z.infer<typeof benchmarkInputSchema>) =>
    jsonResult(assertLedger.benchmark(request));
  server.registerTool("assertledger_benchmark", benchmarkConfig, benchmarkHandler);
  server.registerTool("testforge_benchmark", benchmarkConfig, benchmarkHandler);

  const benchmarkReplayInputSchema = z.strictObject({ artifact: AgenticBenchmarkArtifactSchema });
  const benchmarkReplayConfig = {
    title: "Replay an Agentic Benchmark Artifact",
    description:
      "Strictly validate and independently replay benchmark source binding, digests, scope, and summary semantics.",
    inputSchema: benchmarkReplayInputSchema,
    outputSchema: AgenticBenchmarkReplayResultSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const benchmarkReplayHandler = ({ artifact }: z.infer<typeof benchmarkReplayInputSchema>) =>
    jsonResult(assertLedger.replayBenchmark(artifact));
  server.registerTool(
    "assertledger_benchmark_replay",
    benchmarkReplayConfig,
    benchmarkReplayHandler,
  );
  server.registerTool("testforge_benchmark_replay", benchmarkReplayConfig, benchmarkReplayHandler);

  const benchmarkAcquireReplayInputSchema = z.strictObject({
    result: AgenticBenchmarkAcquisitionResultSchema,
  });
  const benchmarkAcquireReplayConfig = {
    title: "Replay benchmark acquisition evidence",
    description:
      "Strictly replay the acquisition source, artifact, context, digest, and status bindings without executing code.",
    inputSchema: benchmarkAcquireReplayInputSchema,
    outputSchema: AgenticBenchmarkAcquisitionReplayResultSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const benchmarkAcquireReplayHandler = ({
    result,
  }: z.infer<typeof benchmarkAcquireReplayInputSchema>) =>
    jsonResult(assertLedger.replayBenchmarkAcquisition(result));
  server.registerTool(
    "assertledger_benchmark_acquire_replay",
    benchmarkAcquireReplayConfig,
    benchmarkAcquireReplayHandler,
  );
  server.registerTool(
    "testforge_benchmark_acquire_replay",
    benchmarkAcquireReplayConfig,
    benchmarkAcquireReplayHandler,
  );

  const corpusAllocateInputSchema = z.strictObject({
    request: AgenticCorpusAllocationRequestSchema,
  });
  const corpusAllocateConfig = {
    title: "Create a deterministic corpus allocation",
    description:
      "Assign declared case identifiers to calibration and holdout partitions using the versioned SHA-256 allocation algorithm.",
    inputSchema: corpusAllocateInputSchema,
    outputSchema: AgenticCorpusAllocationSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const corpusAllocateHandler = ({ request }: z.infer<typeof corpusAllocateInputSchema>) =>
    jsonResult(assertLedger.allocateCorpus(request));
  server.registerTool("assertledger_corpus_allocate", corpusAllocateConfig, corpusAllocateHandler);
  server.registerTool("testforge_corpus_allocate", corpusAllocateConfig, corpusAllocateHandler);

  const corpusAllocationReplayInputSchema = z.strictObject({
    allocation: AgenticCorpusAllocationSchema,
  });
  const corpusAllocationReplayConfig = {
    title: "Replay a corpus allocation",
    description:
      "Strictly recompute the allocation digest, source ordering, assignment scores, and partition semantics.",
    inputSchema: corpusAllocationReplayInputSchema,
    outputSchema: AgenticCorpusAllocationReplayResultSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const corpusAllocationReplayHandler = ({
    allocation,
  }: z.infer<typeof corpusAllocationReplayInputSchema>) =>
    jsonResult(assertLedger.replayCorpusAllocation(allocation));
  server.registerTool(
    "assertledger_corpus_allocation_replay",
    corpusAllocationReplayConfig,
    corpusAllocationReplayHandler,
  );
  server.registerTool(
    "testforge_corpus_allocation_replay",
    corpusAllocationReplayConfig,
    corpusAllocationReplayHandler,
  );

  const profileInputSchema = z.strictObject({ request: AgenticProfileRequestSchema });
  const profileConfig = {
    title: "Derive an Agentic Test Profile",
    description:
      "Derive a deterministic hardening-test evidence and latency profile from a replay-valid AssertLedger manifest.",
    inputSchema: profileInputSchema,
    outputSchema: AgenticProfileReportSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const profileHandler = ({ request }: z.infer<typeof profileInputSchema>) =>
    jsonResult(assertLedger.profile(request));
  server.registerTool("assertledger_profile", profileConfig, profileHandler);
  server.registerTool("testforge_profile", profileConfig, profileHandler);

  const profileReplayInputSchema = z.strictObject({ report: AgenticProfileReportSchema });
  const profileReplayConfig = {
    title: "Replay an Agentic Test Profile",
    description:
      "Strictly validate and independently replay a self-contained Agentic Test Profile report.",
    inputSchema: profileReplayInputSchema,
    outputSchema: AgenticProfileReplayResultSchema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const profileReplayHandler = ({ report }: z.infer<typeof profileReplayInputSchema>) =>
    jsonResult(assertLedger.replayProfile(report));
  server.registerTool("assertledger_profile_replay", profileReplayConfig, profileReplayHandler);
  server.registerTool("testforge_profile_replay", profileReplayConfig, profileReplayHandler);

  const profileV2InputSchema = z.strictObject({ request: AgenticProfileRequestV2Schema });
  const profileV2Config = {
    title: "Derive an Agentic Test Profile v2",
    description:
      "Derive a deterministic strength and warm-cost profile from a replay-valid benchmark artifact without changing VERIFIED.",
    inputSchema: profileV2InputSchema,
    outputSchema: AgenticProfileReportV2Schema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const profileV2Handler = ({ request }: z.infer<typeof profileV2InputSchema>) =>
    jsonResult(assertLedger.profileV2(request));
  server.registerTool("assertledger_profile_v2", profileV2Config, profileV2Handler);
  server.registerTool("testforge_profile_v2", profileV2Config, profileV2Handler);

  const profileV2ReplayInputSchema = z.strictObject({ report: AgenticProfileReportV2Schema });
  const profileV2ReplayConfig = {
    title: "Replay an Agentic Test Profile v2",
    description:
      "Strictly validate and replay benchmark binding, policy, report digest, and Profile v2 semantics.",
    inputSchema: profileV2ReplayInputSchema,
    outputSchema: AgenticProfileReplayResultV2Schema,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  };
  const profileV2ReplayHandler = ({ report }: z.infer<typeof profileV2ReplayInputSchema>) =>
    jsonResult(assertLedger.replayProfileV2(report));
  server.registerTool(
    "assertledger_profile_v2_replay",
    profileV2ReplayConfig,
    profileV2ReplayHandler,
  );
  server.registerTool("testforge_profile_v2_replay", profileV2ReplayConfig, profileV2ReplayHandler);

  const schemaInputSchema = z.strictObject({
    name: z.enum([
      "agentic-corpus-allocation-request",
      "agentic-corpus-allocation",
      "agentic-corpus-allocation-replay-result",
      "agentic-corpus-allocation-commitment",
      "agentic-corpus-allocation-reveal",
      "agentic-corpus-allocation-commitment-replay-result",
      "agentic-corpus-experiment-plan",
      "agentic-corpus-experiment-plan-replay-result",
      "agentic-corpus-experiment-request",
      "agentic-corpus-experiment-artifact",
      "agentic-corpus-experiment-replay-request",
      "agentic-corpus-experiment-replay-result",
      "agentic-benchmark-request",
      "agentic-benchmark-artifact",
      "agentic-benchmark-replay-result",
      "agentic-benchmark-acquisition-request",
      "agentic-benchmark-acquisition-result",
      "agentic-benchmark-acquisition-replay-result",
      "agentic-profile-request",
      "agentic-profile-report",
      "agentic-profile-replay-result",
      "agentic-profile-request-v2",
      "agentic-profile-report-v2",
      "agentic-profile-replay-result-v2",
      "verification-request",
      "repository-analysis",
      "evidence-manifest",
      "replay-result",
    ]),
  });
  const schemaConfig = {
    title: "Get an AssertLedger schema",
    description: "Return a versioned JSON Schema used by AssertLedger.",
    inputSchema: schemaInputSchema,
  };
  const schemaHandler = ({ name }: z.infer<typeof schemaInputSchema>) =>
    jsonResult(assertLedger.schema(name));
  server.registerTool("assertledger_schema", schemaConfig, schemaHandler);
  server.registerTool("testforge_schema", schemaConfig, schemaHandler);

  return server;
}

/** @deprecated Use `createAssertLedgerServer`. Alias retained for v1 compatibility. */
export const createTestForgeServer = createAssertLedgerServer;
