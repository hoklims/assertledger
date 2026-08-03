#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ContractError } from "./contracts/index.js";
import { createTestForgeServer } from "./mcp/index.js";
import { TestForge } from "./sdk/index.js";

export interface CliIo {
  cwd: string;
  readStdin(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const USAGE = `Usage: testforge <command> [arguments] [--json]

Commands:
  analyze [repository]                         Analyze a repository
  schema <verification-request|repository-analysis|evidence-manifest|replay-result>
                                               Print a JSON Schema
  verify [request.json|-] --allow-unsafe-execution
                                               Execute a trusted-local campaign
  replay [manifest.json|-]                     Verify an evidence digest
  mcp [--allow-unsafe-execution]               Serve MCP v2 over stdio (read-only by default)
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

const VALIDATION_ERROR_CODES = new Set([
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
    (VALIDATION_ERROR_CODES.has(error.message) || BOUNDARY_VALIDATION_MESSAGES.has(error.message))
  ) {
    return 4;
  }
  return 5;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const testforge = new TestForge();
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const command = positional[0];

  try {
    switch (command) {
      case "analyze": {
        const root = path.resolve(io.cwd, positional[1] ?? ".");
        writeJson(io, await testforge.analyze(root));
        return 0;
      }
      case "schema": {
        const name = positional[1];
        if (
          name !== "verification-request" &&
          name !== "repository-analysis" &&
          name !== "evidence-manifest" &&
          name !== "replay-result"
        ) {
          io.writeStderr(USAGE);
          return 64;
        }
        writeJson(io, testforge.schema(name));
        return 0;
      }
      case "verify": {
        const request = await readJsonInput(positional[1], io);
        if (!argv.includes("--allow-unsafe-execution")) {
          io.writeStderr("Refusing trusted-local execution without --allow-unsafe-execution.\n");
          return 4;
        }
        const result = await testforge.verify(authorizeTrustedLocalExecution(request));
        writeJson(io, result);
        return decisionExitCode(result);
      }
      case "replay": {
        const result = testforge.replay(await readJsonInput(positional[1], io));
        writeJson(io, result);
        return result.valid ? 0 : 4;
      }
      case "mcp":
        serveStdio(
          () =>
            createTestForgeServer({
              allowUnsafeExecution: argv.includes("--allow-unsafe-execution"),
              allowedRepositoryRoots: [io.cwd],
            }),
          {
            onerror(error) {
              io.writeStderr(`TestForge MCP error: ${error.message}\n`);
            },
          },
        );
        return 0;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2), defaultIo);
}
