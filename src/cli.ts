#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ContractError } from "./contracts/index.js";
import { renderDiagnostics } from "./diagnostics.js";
import { type ConnectionClient, connectClient, disconnectClient } from "./engine/connection.js";
import { renderGitRegressionSummary } from "./engine/git-regression.js";
import {
  AgenticCorpusError,
  evaluateAgenticCorpusHoldout,
  evaluateAgenticCorpusPublic,
  inspectAgenticCorpus,
} from "./evaluation/agentic-corpus.js";
import { createAssertLedgerServer } from "./mcp/index.js";
import { AssertLedger } from "./sdk/index.js";
import { ASSERTLEDGER_VERSION } from "./version.js";

export interface CliIo {
  cwd: string;
  readStdin(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const USAGE = `Usage: assertledger <command> [arguments] [--json]
       (legacy alias: testforge <command> [arguments] [--json])

Commands:
  explain CODE [CODE ...] [--json]             Explain reason codes and safe next actions
  check [repository] --before REF [--after REF] --neutral REF --neutral-reason TEXT
        --test PATH --base-test PATH [--base-test PATH ...] --out RELATIVE_DIRECTORY
        --allow-unsafe-execution                Qualify one committed node:test regression
  doctor [repository] [--json]                Inspect static repository readiness without writing
  doctor [repository] --runtime --allow-unsafe-execution [--json]
                                               Run controlled trusted-local runtime probes
  connect [repository] --client <codex|claude-code> [--write]
                                               Preview or install project-local client integration
  connect [repository] --client mcp            Emit a generic stdio descriptor as JSON
  disconnect [repository] --client <codex|claude-code> [--write]
                                               Preview or remove exact AssertLedger-owned artifacts
  analyze [repository]                         Analyze a repository
  init [repository] [--dry-run] [--adapter-config PATH] [--package-manager ID]
       [--framework ID] [--test-command-json PATH]
                                               Detect and write portable initialization files
  audit [repository] [--verification-request PATH] [--emit-verification-request] [--no-git]
                                               Produce a static audit and campaign cost projection
  schema <verification-request|repository-analysis|repository-audit|repository-init-config|
          repository-init-lock|repository-init-result|evidence-manifest|replay-result|
          agentic-profile-request|agentic-profile-report|agentic-profile-replay-result|
           agentic-profile-request-v2|agentic-profile-report-v2|agentic-profile-replay-result-v2|
          agentic-benchmark-request|agentic-benchmark-artifact|agentic-benchmark-replay-result|
          agentic-benchmark-acquisition-request|agentic-benchmark-acquisition-result|
          agentic-benchmark-acquisition-replay-result|agentic-corpus-allocation-request|
          agentic-corpus-allocation|agentic-corpus-allocation-replay-result|
          agentic-corpus-allocation-commitment|agentic-corpus-allocation-reveal|
          agentic-corpus-allocation-commitment-replay-result|agentic-corpus-experiment-plan|
          agentic-corpus-experiment-plan-replay-result|
          agentic-corpus-experiment-request|agentic-corpus-experiment-artifact|
          agentic-corpus-experiment-replay-request|agentic-corpus-experiment-replay-result>
                                               Print a JSON Schema
  verify [request.json|-] --allow-unsafe-execution
                                               Execute a trusted-local campaign
  replay [manifest.json|-]                     Verify an evidence digest
  profile [request.json|-]                     Derive an Agentic Test Profile
  profile-replay [report.json|-]               Replay an Agentic Test Profile
  profile-v2 [request.json|-]                  Derive a benchmark-backed Agentic Test Profile v2
  profile-v2-replay [report.json|-]            Replay an Agentic Test Profile v2
  benchmark [request.json|-]                   Derive an Agentic Benchmark Artifact
  benchmark-replay [artifact.json|-]           Replay an Agentic Benchmark Artifact
  benchmark-acquire [request.json|-] --allow-unsafe-execution
                                               Run fresh verification and phase-aware acquisition
  benchmark-acquire-replay [result.json|-]     Replay benchmark acquisition evidence
  corpus-allocate [request.json|-]             Create a deterministic corpus allocation
  corpus-allocation-replay [allocation.json|-] Replay a corpus allocation
  corpus-experiment-replay [artifact.json|-] --trust-policy PATH --trust-policy-digest DIGEST
    --allocation-commitment PATH --allocation-commitment-digest DIGEST --allocation-reveal PATH
    --allocation PATH --experiment-plan PATH --experiment-plan-digest DIGEST
    --subject-evidence PATH --evidence-contents PATH
                                               Replay externally anchored H3 evidence
  corpus-status [corpus-root]                  Check H1-H4 corpus readiness
  corpus-evaluate-public [corpus-root]         Evaluate the public corpus with feedback
  corpus-evaluate-holdout [corpus-root]        Evaluate holdout aggregates without leakage
  mcp [--root PATH] [--allow-unsafe-execution] Serve MCP v2 over stdio (read-only by default)
`;

const MAXIMUM_JSON_INPUT_BYTES = 16 * 1024 * 1024;

function writeJson(io: CliIo, value: unknown): void {
  io.writeStdout(`${JSON.stringify(value)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorizeTrustedLocalExecution(request: unknown): unknown {
  if (!isRecord(request) || !isRecord(request.isolation)) return request;
  return {
    ...request,
    isolation: {
      ...request.isolation,
      acknowledgedUnsafeExecution: true,
    },
  };
}

function authorizeBenchmarkAcquisition(request: unknown): unknown {
  if (!isRecord(request) || !isRecord(request.verificationRequest)) return request;
  return {
    ...request,
    verificationRequest: authorizeTrustedLocalExecution(request.verificationRequest),
  };
}

async function readJsonInput(argument: string | undefined, io: CliIo): Promise<unknown> {
  let text: string;
  if (argument === undefined || argument === "-") {
    text = await io.readStdin();
  } else {
    const inputPath = path.resolve(io.cwd, argument);
    if ((await stat(inputPath)).size > MAXIMUM_JSON_INPUT_BYTES) {
      throw new TypeError("JSON_INPUT_TOO_LARGE");
    }
    text = await readFile(inputPath, "utf8");
  }
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_JSON_INPUT_BYTES) {
    throw new TypeError("JSON_INPUT_TOO_LARGE");
  }
  if (text.trim().length === 0) throw new SyntaxError("JSON input is required");
  return JSON.parse(text) as unknown;
}

function requiredFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new TypeError(`MISSING_${name.slice(2).toUpperCase().replaceAll("-", "_")}`);
  return value;
}

function optionalFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new TypeError(`MISSING_${name.slice(2).toUpperCase().replaceAll("-", "_")}`);
  return value;
}

interface CheckArguments {
  repository: string;
  before: string;
  after?: string;
  neutral: string;
  neutralReason: string;
  test: string;
  baseTests: string[];
  out: string;
}

interface ClientArguments {
  root: string;
  client: ConnectionClient;
  write: boolean;
}

function parseClientArguments(
  argv: readonly string[],
  cwd: string,
  operation: "connect" | "disconnect",
): ClientArguments | undefined {
  let client: string | undefined;
  let rootArgument = ".";
  let rootSeen = false;
  let clientSeen = false;
  let writeSeen = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--client") {
      if (clientSeen) return undefined;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      client = value;
      clientSeen = true;
      index += 1;
    } else if (argument === "--write") {
      if (writeSeen) return undefined;
      writeSeen = true;
    } else if (argument.startsWith("-") || rootSeen) {
      return undefined;
    } else {
      rootArgument = argument;
      rootSeen = true;
    }
  }
  if (!(["codex", "claude-code", "mcp"] as string[]).includes(client ?? "")) return undefined;
  if (operation === "disconnect" && client === "mcp") return undefined;
  if (client === "mcp" && writeSeen) return undefined;
  return {
    root: path.resolve(cwd, rootArgument),
    client: client as ConnectionClient,
    write: writeSeen,
  };
}

function parseCheckArguments(argv: readonly string[], cwd: string): CheckArguments {
  const values = new Map<string, string[]>();
  let repository = ".";
  let repositorySeen = false;
  const valueFlags = new Set([
    "--before",
    "--after",
    "--neutral",
    "--neutral-reason",
    "--test",
    "--base-test",
    "--out",
  ]);
  const booleanFlags = new Set(["--allow-unsafe-execution", "--json"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new TypeError(`MISSING_${argument.slice(2).toUpperCase().replaceAll("-", "_")}`);
      const existing = values.get(argument) ?? [];
      existing.push(value);
      values.set(argument, existing);
      index += 1;
    } else if (!booleanFlags.has(argument) && !argument.startsWith("--") && !repositorySeen) {
      repository = argument;
      repositorySeen = true;
    } else if (!booleanFlags.has(argument)) {
      throw new TypeError("GIT_REGRESSION_ARGUMENT_INVALID");
    }
  }
  const exactlyOne = (name: string): string => {
    const found = values.get(name) ?? [];
    if (found.length !== 1)
      throw new TypeError(
        found.length === 0
          ? `MISSING_${name.slice(2).toUpperCase().replaceAll("-", "_")}`
          : "GIT_REGRESSION_ARGUMENT_INVALID",
      );
    return found[0] as string;
  };
  const afterValues = values.get("--after") ?? [];
  if (afterValues.length > 1) throw new TypeError("GIT_REGRESSION_ARGUMENT_INVALID");
  const baseTests = values.get("--base-test") ?? [];
  if (baseTests.length === 0) throw new TypeError("MISSING_BASE_TEST");
  return {
    repository: path.resolve(cwd, repository),
    before: exactlyOne("--before"),
    ...(afterValues[0] === undefined ? {} : { after: afterValues[0] }),
    neutral: exactlyOne("--neutral"),
    neutralReason: exactlyOne("--neutral-reason"),
    test: exactlyOne("--test"),
    baseTests,
    out: exactlyOne("--out"),
  };
}

function evidenceContentMap(value: unknown): Map<string, Uint8Array> {
  if (!Array.isArray(value)) throw new TypeError("EVIDENCE_CONTENTS_INVALID");
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.digest !== "string" ||
      entry.encoding !== "BASE64URL" ||
      typeof entry.content !== "string"
    ) {
      throw new TypeError("EVIDENCE_CONTENTS_INVALID");
    }
    return [entry.digest, new Uint8Array(Buffer.from(entry.content, "base64url"))] as const;
  });
  if (new Set(entries.map(([digest]) => digest)).size !== entries.length)
    throw new TypeError("EVIDENCE_CONTENTS_INVALID");
  return new Map(entries);
}

function decisionExitCode(result: unknown): number {
  if (!isRecord(result) || !isRecord(result.decision)) return 5;
  switch (result.decision.status) {
    case "VERIFIED":
      return 0;
    case "REJECTED":
      return 2;
    case "INCONCLUSIVE":
      return 3;
    default:
      return 5;
  }
}

function profileExitCode(result: unknown): number {
  if (!isRecord(result)) return 5;
  switch (result.status) {
    case "QUALIFIED":
      return 0;
    case "NOT_QUALIFIED":
    case "BUDGET_MISSED":
      return 2;
    case "INSUFFICIENT_TIMING_EVIDENCE":
      return 3;
    case "OBSERVED_BENCHMARK_FAILURE":
    case "COMPARISON_SCOPE_MISMATCH":
      return 4;
    default:
      return 5;
  }
}

function benchmarkExitCode(result: unknown): number {
  if (!isRecord(result) || !Array.isArray(result.summaries)) return 5;
  const statuses = result.summaries.map((summary) =>
    isRecord(summary) ? summary.status : undefined,
  );
  if (statuses.every((status) => status === "MEASURED")) return 0;
  if (statuses.some((status) => status === "OBSERVED_RUN_FAILURE")) return 2;
  if (statuses.some((status) => status === "INSUFFICIENT_SAMPLES")) return 3;
  return 5;
}

function benchmarkAcquisitionExitCode(result: unknown): number {
  if (!isRecord(result)) return 5;
  switch (result.status) {
    case "COMPLETE":
      return 0;
    case "SOURCE_NOT_VERIFIED":
    case "OBSERVED_RUN_FAILURE":
      return 2;
    case "INSUFFICIENT_SAMPLES":
      return 3;
    default:
      return 5;
  }
}

async function runCorpusCommand(
  action: "STATUS" | "PUBLIC" | "HOLDOUT",
  root: string,
  io: CliIo,
): Promise<number> {
  try {
    const result =
      action === "STATUS"
        ? await inspectAgenticCorpus(root)
        : action === "PUBLIC"
          ? await evaluateAgenticCorpusPublic(root)
          : await evaluateAgenticCorpusHoldout(root);
    writeJson(io, result);
    return result.status === "NOT_READY" ? 3 : 0;
  } catch (error) {
    writeJson(io, {
      schemaVersion: "1.0.0",
      status: "INVALID_CORPUS",
      reasonCodes: [error instanceof AgenticCorpusError ? error.code : "CORPUS_IO_ERROR"],
    });
    return 4;
  }
}

const VALIDATION_ERROR_CODES = new Set([
  "DIAGNOSTIC_CODES_INVALID",
  "CANDIDATE_BUDGET_EXCEEDED",
  "CANDIDATE_BYTES_EXCEEDED",
  "DUPLICATE_BASE_TEST_FILE",
  "DUPLICATE_CANDIDATE_FILE_PATH",
  "DUPLICATE_CANDIDATE_ID",
  "DUPLICATE_CANDIDATE_ROOT",
  "DUPLICATE_ENVIRONMENT_ALLOWLIST_ENTRY",
  "DUPLICATE_WORLD_FILE_PATH",
  "DUPLICATE_WORLD_ID",
  "EXECUTION_BUDGET_EXCEEDED",
  "FORBIDDEN_CANDIDATE_PATH",
  "FORBIDDEN_WORLD_PATH",
  "INVALID_ACCEPTED_TARGET_OUTCOMES",
  "INVALID_ADAPTER",
  "INVALID_ADAPTER_ARGUMENTS",
  "INVALID_ADAPTER_EXECUTABLE",
  "INVALID_BASE_TEST_FILES",
  "INVALID_BUDGETS",
  "INVALID_CANDIDATE",
  "INVALID_CAMPAIGN_COLLECTIONS",
  "INVALID_CANDIDATE_FILES",
  "INVALID_CANDIDATE_ID",
  "INVALID_CANDIDATE_ROOTS",
  "INVALID_ENVIRONMENT_ALLOWLIST",
  "INVALID_ENVIRONMENT_ALLOWLIST_ENTRY",
  "INVALID_FILE_OVERLAY",
  "INVALID_ISOLATION",
  "INVALID_MAXIMUM_CANDIDATE_BYTES",
  "INVALID_MAXIMUM_CANDIDATES",
  "INVALID_MAXIMUM_EXECUTIONS",
  "INVALID_MAXIMUM_OUTPUT_BYTES",
  "INVALID_MAXIMUM_REPOSITORY_BYTES",
  "INVALID_MAXIMUM_REPOSITORY_FILES",
  "INVALID_MAXIMUM_SELECTED_CANDIDATES",
  "INVALID_MAXIMUM_TOTAL_CANDIDATE_BYTES",
  "INVALID_MAXIMUM_WORLD_OVERLAY_BYTES",
  "INVALID_MAXIMUM_WORLDS",
  "INVALID_MINIMUM_TARGET_WEIGHT_PERMILLE",
  "INVALID_OVERLAY_CONTENT",
  "INVALID_OVERLAY_PATH",
  "INVALID_POLICY",
  "INVALID_POLICY_VERSION",
  "INVALID_REPOSITORY",
  "INVALID_REPOSITORY_EXCLUDE",
  "INVALID_REPOSITORY_ROOT",
  "INVALID_REQUIRED_ATTEMPTS",
  "INVALID_SCHEMA_VERSION",
  "INVALID_TIMEOUT_MS_PER_EXECUTION",
  "INVALID_WORLD",
  "INVALID_WORLD_FILES",
  "INVALID_WORLD_ID",
  "INVALID_WORLD_KIND",
  "INVALID_WORLD_REQUIRED",
  "INVALID_WORLD_WEIGHT",
  "INVALID_WORLDS",
  "JSON_INPUT_TOO_LARGE",
  "AGENTIC_PROFILE_SOURCE_INVALID",
  "AGENTIC_BENCHMARK_REFERENCE_WORLD_INVALID",
  "AGENTIC_BENCHMARK_SOURCE_INVALID",
  "AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID",
  "AGENTIC_BENCHMARK_ACQUISITION_REQUEST_INVALID",
  "AGENTIC_BENCHMARK_ACQUISITION_IDENTITY_INVALID",
  "BENCHMARK_PHASE_ACQUISITION_UNSUPPORTED_NODE_TEST",
  "AGENTIC_PROFILE_V2_BENCHMARK_INVALID",
  "AGENTIC_PROFILE_V2_COHORT_INVALID",
  "NODE_TEST_EXECUTABLE_PROBE_FAILED",
  "NODE_TEST_VERSION_UNSUPPORTED",
  "PORTABLE_PATH_COLLISION",
  "REPOSITORY_BYTES_BUDGET_EXCEEDED",
  "REPOSITORY_FILE_BUDGET_EXCEEDED",
  "RESERVED_ENVIRONMENT_VARIABLE",
  "SYMLINK_OVERLAY_PATH",
  "TOTAL_CANDIDATE_BYTES_EXCEEDED",
  "UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED",
  "UNSAFE_NODE_TEST_ARGUMENT",
  "UNSUPPORTED_ADAPTER",
  "UNSUPPORTED_ISOLATION",
  "UNSUPPORTED_REPOSITORY_SYMLINK",
  "VERIFICATION_REQUEST_REPOSITORY_MISMATCH",
  "WORLD_BUDGET_EXCEEDED",
  "WORLD_OVERLAY_BYTES_EXCEEDED",
]);

const BOUNDARY_VALIDATION_MESSAGES = new Set([
  "Absolute paths and Windows ADS are forbidden",
  "Ambiguous Unicode path segment must use NFC",
  "Ambiguous Windows path segment",
  "At least one safe root is required",
  "Control or Windows-forbidden filename character",
  "Path escapes the allowed roots",
  "Path must be a non-empty relative path",
  "Path traversal or ambiguous segments are forbidden",
  "Reserved Windows device name",
  "Safe roots must be strings",
]);

function classifyError(error: unknown): number {
  if (error instanceof SyntaxError || error instanceof ContractError) {
    return 4;
  }
  if (
    error instanceof Error &&
    (VALIDATION_ERROR_CODES.has(error.message) ||
      BOUNDARY_VALIDATION_MESSAGES.has(error.message) ||
      error.message.startsWith("MISSING_") ||
      error.message.startsWith("GIT_") ||
      error.message === "EVIDENCE_CONTENTS_INVALID" ||
      error.message === "SUBJECT_EVIDENCE_INVALID")
  ) {
    return 4;
  }
  return 5;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const ledger = new AssertLedger();
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const command = ["--help", "-h", "--version", "-v"].includes(argv[0] ?? "")
    ? argv[0]
    : positional[0];

  try {
    switch (command) {
      case "explain": {
        const codes = argv.slice(1).filter((argument) => argument !== "--json");
        if (
          codes.length === 0 ||
          codes.some((code) => code.startsWith("-")) ||
          argv.filter((argument) => argument === "--json").length > 1
        ) {
          io.writeStderr(USAGE);
          return 64;
        }
        const report = ledger.explain(codes);
        if (argv.includes("--json")) writeJson(io, report);
        else io.writeStdout(`${renderDiagnostics(codes)}\n`);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        if (argv.length !== 1) {
          io.writeStderr(USAGE);
          return 64;
        }
        io.writeStdout(USAGE);
        return 0;
      case "version":
      case "--version":
      case "-v":
        if (argv.length !== 1) {
          io.writeStderr(USAGE);
          return 64;
        }
        io.writeStdout(`assertledger ${ASSERTLEDGER_VERSION}\n`);
        return 0;
      case "doctor": {
        const allowedFlags = new Set(["--json", "--runtime", "--allow-unsafe-execution"]);
        const rootArguments = argv.slice(1).filter((argument) => !argument.startsWith("-"));
        const runtime = argv.includes("--runtime");
        const allowUnsafeExecution = argv.includes("--allow-unsafe-execution");
        if (
          rootArguments.length > 1 ||
          [...allowedFlags].some(
            (flag) => argv.filter((argument) => argument === flag).length > 1,
          ) ||
          (allowUnsafeExecution && !runtime) ||
          argv.slice(1).some((argument) => argument.startsWith("-") && !allowedFlags.has(argument))
        ) {
          io.writeStderr(USAGE);
          return 64;
        }
        const root = path.resolve(io.cwd, rootArguments[0] ?? ".");
        if (runtime) {
          const runtimeResult = await ledger.doctorRuntime(root, { allowUnsafeExecution });
          if (argv.includes("--json")) {
            writeJson(io, runtimeResult);
          } else {
            const reasons =
              runtimeResult.reasonCodes.length === 0
                ? "none"
                : runtimeResult.reasonCodes.join(", ");
            io.writeStdout(
              [
                `Runtime status: ${runtimeResult.status}`,
                `Execution mode: ${runtimeResult.executionMode}`,
                `Adapter: ${runtimeResult.adapter ?? "not checked"}`,
                `Node.js: ${runtimeResult.nodeVersion ?? "not checked"}`,
                `Reason codes: ${reasons}`,
                ...runtimeResult.checks.map(
                  (check) =>
                    `${check.status} ${check.id}: ${check.summary}${check.nextAction ? ` Next: ${check.nextAction}` : ""}`,
                ),
                ...runtimeResult.limitations.map((limitation) => `Limit: ${limitation}`),
                "",
              ].join("\n"),
            );
          }
          return runtimeResult.status === "READY" ? 0 : 3;
        }
        const result = await ledger.doctor(root);
        if (argv.includes("--json")) {
          writeJson(io, result);
        } else {
          const reasons = result.reasonCodes.length === 0 ? "none" : result.reasonCodes.join(", ");
          io.writeStdout(
            [
              `Status: ${result.status}`,
              `Reason codes: ${reasons}`,
              `Required operator inputs: ${result.requiredOperatorInputs.join(", ")}`,
              renderDiagnostics(result.reasonCodes),
              `Next safe action: ${result.nextCommands[0]?.executable ?? "assertledger"} ${(result.nextCommands[0]?.arguments ?? []).join(" ")}`,
              "Execution limit: verification remains UNSANDBOXED trusted-local and requires explicit operator authorization.",
              "This static diagnostic does not prove campaign evidence or MCP connectivity.",
              "",
            ].join("\n"),
          );
        }
        if (result.status === "BLOCKED") return 3;
        if (result.status === "CONFLICT") return 4;
        return 0;
      }
      case "connect": {
        const parsed = parseClientArguments(argv, io.cwd, "connect");
        if (parsed === undefined) {
          io.writeStderr(USAGE);
          return 64;
        }
        const currentEntry = fileURLToPath(import.meta.url);
        if (
          path.basename(currentEntry) !== "cli.js" ||
          path.basename(path.dirname(currentEntry)) !== "dist"
        ) {
          io.writeStderr("CONNECT_BUILD_REQUIRED: run `pnpm build` and invoke dist/cli.js.\n");
          return 3;
        }
        const result = await connectClient(parsed.root, currentEntry, parsed.client, parsed.write);
        if (parsed.client === "mcp") {
          io.writeStdout(result.artifacts[0]?.content ?? "");
          return 0;
        }
        if (result.status === "CONFLICT") {
          io.writeStderr(
            `CONFLICT: ${result.artifacts.map((artifact) => artifact.path).join(", ")} includes different operator-owned content; no files changed.\n`,
          );
          return 4;
        }
        for (const artifact of result.artifacts) {
          io.writeStdout(`${result.status}: ${artifact.path}\n`);
          if (result.status === "EMITTED") {
            const label = artifact.kind.toUpperCase();
            io.writeStdout(`--- BEGIN ASSERTLEDGER ${label} ---\n`);
            io.writeStdout(artifact.content);
            if (!artifact.content.endsWith("\n")) io.writeStdout("\n");
            io.writeStdout(`--- END ASSERTLEDGER ${label} ---\n`);
          }
        }
        if (result.status === "EMITTED") {
          io.writeStdout("No files changed. Re-run with --write to install these artifacts.\n");
        }
        return 0;
      }
      case "disconnect": {
        const parsed = parseClientArguments(argv, io.cwd, "disconnect");
        if (parsed === undefined || parsed.client === "mcp") {
          io.writeStderr(USAGE);
          return 64;
        }
        const currentEntry = fileURLToPath(import.meta.url);
        if (
          path.basename(currentEntry) !== "cli.js" ||
          path.basename(path.dirname(currentEntry)) !== "dist"
        ) {
          io.writeStderr("CONNECT_BUILD_REQUIRED: run `pnpm build` and invoke dist/cli.js.\n");
          return 3;
        }
        const result = await disconnectClient(
          parsed.root,
          currentEntry,
          parsed.client,
          parsed.write,
        );
        if (result.status === "CONFLICT") {
          io.writeStderr(
            `CONFLICT: ${result.artifacts.map((artifact) => artifact.path).join(", ")} includes content AssertLedger does not own byte-for-byte; no files changed.\n`,
          );
          return 4;
        }
        for (const artifact of result.artifacts) {
          io.writeStdout(`${result.status}: ${artifact.path}\n`);
        }
        if (result.status === "EMITTED") {
          io.writeStdout(
            "No files changed. Re-run with --write to remove only byte-identical AssertLedger artifacts.\n",
          );
        }
        return 0;
      }
      case "analyze": {
        const root = path.resolve(io.cwd, positional[1] ?? ".");
        writeJson(io, await ledger.analyze(root));
        return 0;
      }
      case "init": {
        const valueFlags = new Set([
          "--adapter-config",
          "--package-manager",
          "--framework",
          "--test-command-json",
        ]);
        const booleanFlags = new Set(["--dry-run", "--json"]);
        let rootArgument = ".";
        let rootSeen = false;
        for (let index = 1; index < argv.length; index += 1) {
          const argument = argv[index] ?? "";
          if (valueFlags.has(argument)) {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith("--")) {
              io.writeStderr(USAGE);
              return 64;
            }
            index += 1;
          } else if (!booleanFlags.has(argument)) {
            if (!argument.startsWith("--") && !rootSeen) {
              rootArgument = argument;
              rootSeen = true;
            } else {
              io.writeStderr(USAGE);
              return 64;
            }
          }
        }
        const root = path.resolve(io.cwd, rootArgument);
        const commandPath = optionalFlag(argv, "--test-command-json");
        const adapterConfigPath = optionalFlag(argv, "--adapter-config");
        const packageManager = optionalFlag(argv, "--package-manager");
        const framework = optionalFlag(argv, "--framework");
        const result = await ledger.init(root, {
          dryRun: argv.includes("--dry-run"),
          ...(adapterConfigPath === undefined ? {} : { adapterConfigPath }),
          ...(packageManager === undefined ? {} : { packageManager }),
          ...(framework === undefined ? {} : { framework }),
          ...(commandPath === undefined
            ? {}
            : {
                testCommand: (await readJsonInput(commandPath, io)) as {
                  executable: string;
                  arguments: string[];
                },
              }),
        });
        writeJson(io, result);
        if (result.status === "BLOCKED") return 3;
        if (result.status === "CONFLICT") return 4;
        return 0;
      }
      case "audit": {
        const rootArgument = argv[1] && !argv[1].startsWith("--") ? argv[1] : ".";
        const root = path.resolve(io.cwd, rootArgument);
        const explicitRequest = optionalFlag(argv, "--verification-request");
        let request: unknown | undefined;
        if (explicitRequest !== undefined) request = await readJsonInput(explicitRequest, io);
        else {
          try {
            request = JSON.parse(
              await readFile(path.join(root, "assertledger.request.json"), "utf8"),
            ) as unknown;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw error;
          }
        }
        const result = await ledger.audit(root, {
          noGit: argv.includes("--no-git"),
          verificationRequest: request,
        });
        if (argv.includes("--emit-verification-request")) {
          if (result.verificationRequest === null) return 3;
          writeJson(io, result.verificationRequest);
          return 0;
        }
        writeJson(io, result);
        return 0;
      }
      case "check": {
        if (!argv.includes("--allow-unsafe-execution")) {
          io.writeStderr("Refusing trusted-local execution without --allow-unsafe-execution.\n");
          return 4;
        }
        const options = parseCheckArguments(argv, io.cwd);
        const result = await ledger.checkGitRegression({
          ...options,
          allowUnsafeExecution: true,
        });
        if (argv.includes("--json")) writeJson(io, result);
        else
          io.writeStdout(
            renderGitRegressionSummary(result, { ...options, allowUnsafeExecution: true }),
          );
        return decisionExitCode(result);
      }
      case "schema": {
        const name = positional[1];
        if (
          name !== "verification-request" &&
          name !== "repository-analysis" &&
          name !== "repository-audit" &&
          name !== "repository-init-config" &&
          name !== "repository-init-lock" &&
          name !== "repository-init-result" &&
          name !== "evidence-manifest" &&
          name !== "replay-result" &&
          name !== "agentic-benchmark-request" &&
          name !== "agentic-benchmark-artifact" &&
          name !== "agentic-benchmark-replay-result" &&
          name !== "agentic-benchmark-acquisition-request" &&
          name !== "agentic-benchmark-acquisition-result" &&
          name !== "agentic-benchmark-acquisition-replay-result" &&
          name !== "agentic-profile-request" &&
          name !== "agentic-profile-report" &&
          name !== "agentic-profile-replay-result" &&
          name !== "agentic-profile-request-v2" &&
          name !== "agentic-profile-report-v2" &&
          name !== "agentic-profile-replay-result-v2" &&
          name !== "agentic-corpus-allocation-request" &&
          name !== "agentic-corpus-allocation" &&
          name !== "agentic-corpus-allocation-replay-result" &&
          name !== "agentic-corpus-allocation-commitment" &&
          name !== "agentic-corpus-allocation-reveal" &&
          name !== "agentic-corpus-allocation-commitment-replay-result" &&
          name !== "agentic-corpus-experiment-plan" &&
          name !== "agentic-corpus-experiment-plan-replay-result" &&
          name !== "agentic-corpus-experiment-request" &&
          name !== "agentic-corpus-experiment-artifact" &&
          name !== "agentic-corpus-experiment-replay-request" &&
          name !== "agentic-corpus-experiment-replay-result"
        ) {
          io.writeStderr(USAGE);
          return 64;
        }
        writeJson(io, ledger.schema(name));
        return 0;
      }
      case "verify": {
        const request = await readJsonInput(positional[1], io);
        if (!argv.includes("--allow-unsafe-execution")) {
          io.writeStderr("Refusing trusted-local execution without --allow-unsafe-execution.\n");
          return 4;
        }
        const result = await ledger.verify(authorizeTrustedLocalExecution(request));
        writeJson(io, result);
        return decisionExitCode(result);
      }
      case "replay": {
        const result = ledger.replay(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "profile": {
        const result = ledger.profile(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return profileExitCode(result);
      }
      case "profile-replay": {
        const result = ledger.replayProfile(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "profile-v2": {
        const result = ledger.profileV2(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return profileExitCode(result);
      }
      case "profile-v2-replay": {
        const result = ledger.replayProfileV2(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "benchmark": {
        const result = ledger.benchmark(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return benchmarkExitCode(result);
      }
      case "benchmark-replay": {
        const result = ledger.replayBenchmark(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "benchmark-acquire": {
        const request = await readJsonInput(positional[1], io);
        if (!argv.includes("--allow-unsafe-execution")) {
          io.writeStderr("Refusing trusted-local execution without --allow-unsafe-execution.\n");
          return 4;
        }
        const result = await ledger.acquireBenchmark(authorizeBenchmarkAcquisition(request));
        writeJson(io, result);
        return benchmarkAcquisitionExitCode(result);
      }
      case "benchmark-acquire-replay": {
        const result = ledger.replayBenchmarkAcquisition(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "corpus-allocate": {
        const result = ledger.allocateCorpus(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return 0;
      }
      case "corpus-allocation-replay": {
        const result = ledger.replayCorpusAllocation(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "corpus-experiment-replay": {
        const artifact = await readJsonInput(positional[1], io);
        const trustPolicy = await readJsonInput(requiredFlag(argv, "--trust-policy"), io);
        const allocationCommitment = await readJsonInput(
          requiredFlag(argv, "--allocation-commitment"),
          io,
        );
        const allocationReveal = await readJsonInput(requiredFlag(argv, "--allocation-reveal"), io);
        const allocation = await readJsonInput(requiredFlag(argv, "--allocation"), io);
        const experimentPlan = await readJsonInput(requiredFlag(argv, "--experiment-plan"), io);
        const subjectEvidence = await readJsonInput(requiredFlag(argv, "--subject-evidence"), io);
        if (!Array.isArray(subjectEvidence)) throw new TypeError("SUBJECT_EVIDENCE_INVALID");
        const evidenceContents = evidenceContentMap(
          await readJsonInput(requiredFlag(argv, "--evidence-contents"), io),
        );
        const result = ledger.replayCorpusExperiment(artifact, {
          expectedTrustPolicyDigest: requiredFlag(argv, "--trust-policy-digest"),
          expectedAllocationCommitmentDigest: requiredFlag(argv, "--allocation-commitment-digest"),
          expectedExperimentPlanDigest: requiredFlag(argv, "--experiment-plan-digest"),
          trustPolicy,
          allocationCommitment,
          allocationReveal,
          allocation,
          experimentPlan,
          subjectEvidence,
          evidenceContents,
        });
        writeJson(io, result);
        if (!result.valid) return 4;
        const parsedArtifact = artifact as { result?: { status?: string } };
        switch (parsedArtifact.result?.status) {
          case "SUPPORTED":
            return 0;
          case "NOT_SUPPORTED":
            return 2;
          case "INSUFFICIENT":
            return 3;
          default:
            return 4;
        }
      }
      case "corpus-status":
        return runCorpusCommand(
          "STATUS",
          path.resolve(io.cwd, positional[1] ?? "benchmarks/agentic-profile"),
          io,
        );
      case "corpus-evaluate-public":
        return runCorpusCommand(
          "PUBLIC",
          path.resolve(io.cwd, positional[1] ?? "benchmarks/agentic-profile"),
          io,
        );
      case "corpus-evaluate-holdout":
        return runCorpusCommand(
          "HOLDOUT",
          path.resolve(io.cwd, positional[1] ?? "benchmarks/agentic-profile"),
          io,
        );
      case "mcp": {
        const allowedFlags = new Set(["--allow-unsafe-execution", "--root"]);
        let rootSeen = false;
        let unsafeSeen = false;
        for (let index = 1; index < argv.length; index += 1) {
          const argument = argv[index] ?? "";
          if (!allowedFlags.has(argument)) {
            io.writeStderr(USAGE);
            return 64;
          }
          if (argument === "--root") {
            if (rootSeen) {
              io.writeStderr(USAGE);
              return 64;
            }
            const value = argv[index + 1];
            if (value === undefined || value.startsWith("-")) {
              io.writeStderr(USAGE);
              return 64;
            }
            rootSeen = true;
            index += 1;
          } else if (unsafeSeen) {
            io.writeStderr(USAGE);
            return 64;
          } else {
            unsafeSeen = true;
          }
        }
        const requestedRoot = optionalFlag(argv, "--root");
        const root =
          requestedRoot === undefined
            ? io.cwd
            : await realpath(path.resolve(io.cwd, requestedRoot));
        if (!(await stat(root)).isDirectory()) throw new Error("MCP_ROOT_NOT_DIRECTORY");
        serveStdio(
          () =>
            createAssertLedgerServer({
              allowUnsafeExecution: argv.includes("--allow-unsafe-execution"),
              allowedRepositoryRoots: [root],
            }),
          {
            onerror(error) {
              io.writeStderr(`AssertLedger MCP error: ${error.message}\n`);
            },
          },
        );
        return 0;
      }
      default:
        io.writeStderr(USAGE);
        return 64;
    }
  } catch (error) {
    io.writeStderr(`${errorMessage(error)}\n`);
    return classifyError(error);
  }
}

const defaultIo: CliIo = {
  cwd: process.cwd(),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAXIMUM_JSON_INPUT_BYTES) throw new TypeError("JSON_INPUT_TOO_LARGE");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

async function isDirectInvocation(
  moduleUrl: string,
  entryPath: string | undefined,
): Promise<boolean> {
  if (entryPath === undefined) return false;
  try {
    return (await realpath(fileURLToPath(moduleUrl))) === (await realpath(path.resolve(entryPath)));
  } catch {
    return false;
  }
}

if (await isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2), defaultIo);
}
