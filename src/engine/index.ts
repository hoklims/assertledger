import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import {
  type AgenticBenchmarkAcquisitionRequest,
  type AgenticBenchmarkAcquisitionResult,
  type AgenticBenchmarkRun,
  AdapterSchema,
  parseRepositoryInitConfig,
  parseRepositoryInitLock,
  parseRepositoryInitResult,
  parseAgenticBenchmarkAcquisitionRequest,
  parseAgenticBenchmarkAcquisitionResult,
  parseEvidenceManifest,
  parseRepositoryAudit,
  parseVerificationRequest,
  type RepositoryAudit,
  type RepositoryInitConfig,
  type RepositoryInitDetections,
  type RepositoryInitLock,
  type RepositoryInitResult,
  repositoryInitConfigDigest,
  repositoryInitLockDigest,
  type VerificationRequest as VerificationRequestContract,
} from "../contracts/index.js";
import {
  assertSafeRelativePath,
  canonicalize,
  createAgenticBenchmark,
  decideEvidence,
  portablePathKey,
  replayAgenticBenchmark,
  replayEvidenceManifest,
  sealManifestArtifact,
  sha256Canonical,
} from "../core/index.js";
import { NODE_TEST_ADAPTER_PROFILE } from "./adapters/node-test-profile.js";
import {
  type NodeTestRuntimePreflight,
  runNodeTestRuntimePreflight,
} from "./adapters/node-test-runtime.js";
import { normalizeRuntimeFacts, RUNTIME_FACTS_VERSION } from "./adapters/runtime-facts.js";
import { NODE_TEST_REPORTER_SOURCE } from "./node-test-reporter.js";

const DEFAULT_EXCLUDES = new Set([".git", ".testforge", "node_modules"]);
const SHA256_PREFIX = "sha256:";
const PROCESS_TERMINATION_GRACE_MS = 250;
const CONTROLLED_REPORT_MAXIMUM_BYTES = 64 * 1024;
const TEMPORARY_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

type JsonRecord = Record<string, unknown>;

const INIT_CONFIG_FILE = "assertledger.config.json" as const;
const INIT_LOCK_FILE = "assertledger.lock.json" as const;
const INIT_MANAGED_FILES = new Set([INIT_CONFIG_FILE, INIT_LOCK_FILE]);
const INIT_PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pip"] as const;
const INIT_FRAMEWORKS = ["node:test", "vitest", "jest", "bun:test", "pytest"] as const;

type InitPackageManager = (typeof INIT_PACKAGE_MANAGERS)[number];
type InitFramework = (typeof INIT_FRAMEWORKS)[number];

export interface RepositoryInitOptions {
  dryRun?: boolean;
  adapterConfigPath?: string;
  packageManager?: string;
  framework?: string;
  testCommand?: { executable: string; arguments: string[] };
  afterEvidenceSnapshot?: () => void | Promise<void>;
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, TEMPORARY_CLEANUP_OPTIONS);
}

export interface ProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maximumOutputBytes: number;
}

export type ProcessOutcome = "PASS" | "PROCESS_CRASH" | "TIMEOUT" | "INFRA_ERROR";

export interface CapturedOutput {
  text: string;
  totalBytes: number;
  truncated: boolean;
  digest: string;
}

export interface ProcessResult {
  outcome: ProcessOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  error?: string;
}

interface FileOverlay {
  path: string;
  content: string;
}

interface World {
  id: string;
  kind: "REFERENCE" | "TARGET" | "NEUTRAL";
  required: boolean;
  weight: number;
  provenance?: string;
  files: FileOverlay[];
}

interface Candidate {
  id: string;
  files: FileOverlay[];
}

interface VerificationRequest {
  schemaVersion: string;
  repository: { root: string; exclude: string[] };
  adapter:
    | {
        kind: "node-test";
        executable: string;
        baseTestFiles: string[];
        extraArguments?: string[];
      }
    | {
        kind: "testforge-command";
        executable: string;
        arguments: string[];
        protocolVersion: "1.0.0";
      };
  isolation: {
    kind: "trusted-local";
    acknowledgedUnsafeExecution: boolean;
    environmentAllowlist: string[];
  };
  candidateRoots: string[];
  budgets: {
    maximumCandidates: number;
    maximumWorlds: number;
    maximumExecutions: number;
    maximumRepositoryFiles: number;
    maximumRepositoryBytes: number;
    maximumWorldOverlayBytes: number;
    maximumCandidateBytes: number;
    maximumTotalCandidateBytes: number;
    timeoutMsPerExecution: number;
    maximumOutputBytes: number;
  };
  policy: {
    policyVersion: string;
    requiredAttempts: number;
    minimumTargetWeightPermille: number;
    maximumSelectedCandidates: number;
    acceptedTargetOutcomes: string[];
  };
  worlds: World[];
  candidates: Candidate[];
}

interface Observation {
  runId: string;
  candidateId: string | null;
  worldId: string;
  attempt: number;
  outcome:
    | "PASS"
    | "ASSERTION_FAILURE"
    | "COLLECTION_FAILURE"
    | "COMPILE_FAILURE"
    | "PROCESS_CRASH"
    | "TIMEOUT"
    | "INFRA_ERROR"
    | "NO_TEST_DISCOVERED";
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  attributed: boolean;
  durationMs: number;
  exitCode: number | null;
  stdoutDigest: string;
  stderrDigest: string;
}

class OutputAccumulator {
  readonly #hash = createHash("sha256");
  readonly #parts: Buffer[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  add(chunk: Buffer): void {
    this.#hash.update(chunk);
    this.#totalBytes += chunk.byteLength;
    const remaining = this.maximumBytes - this.#capturedBytes;
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining);
      this.#parts.push(captured);
      this.#capturedBytes += captured.byteLength;
    }
  }

  finish(): CapturedOutput {
    const captured = Buffer.concat(this.#parts);
    const decoded = captured.toString("utf8");
    let text = "";
    let encodedBytes = 0;
    for (const character of decoded) {
      const characterBytes = Buffer.byteLength(character);
      if (encodedBytes + characterBytes > this.maximumBytes) break;
      text += character;
      encodedBytes += characterBytes;
    }
    return {
      text,
      totalBytes: this.#totalBytes,
      truncated: this.#totalBytes > this.#capturedBytes,
      digest: `${SHA256_PREFIX}${this.#hash.digest("hex")}`,
    };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`INVALID_${name.toUpperCase()}`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`INVALID_${name.toUpperCase()}`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`INVALID_${name.toUpperCase()}`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`INVALID_${name.toUpperCase()}`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`INVALID_${name.toUpperCase()}`);
  }
  return value as number;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`INVALID_${name.toUpperCase()}`);
  }
  return value;
}

function parseNodeTestExtraArguments(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const arguments_ = requireStringArray(value, "extra_arguments");
  if (arguments_.length > 0) throw new Error("UNSAFE_NODE_TEST_ARGUMENT");
  return arguments_;
}

function parseProcessInput(value: unknown): ProcessInput {
  const input = requireRecord(value, "process_input");
  const environment = requireRecord(input.environment, "environment");
  const normalizedEnvironment: Record<string, string> = {};
  for (const [key, item] of Object.entries(environment)) {
    if (typeof item !== "string" || key.includes("=")) throw new TypeError("INVALID_ENVIRONMENT");
    normalizedEnvironment[key] = item;
  }
  const args = requireStringArray(input.args, "args");
  return {
    executable: requireString(input.executable, "executable"),
    args,
    cwd: requireString(input.cwd, "cwd"),
    environment: normalizedEnvironment,
    timeoutMs: requirePositiveInteger(input.timeoutMs, "timeout_ms"),
    maximumOutputBytes: requirePositiveInteger(input.maximumOutputBytes, "maximum_output_bytes"),
  };
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The child may already have exited between the timeout and termination.
    }
  }
}

export async function runProcess(value: unknown): Promise<ProcessResult> {
  const input = parseProcessInput(value);
  const cwd = await realpath(input.cwd);
  const cwdStats = await stat(cwd);
  if (!cwdStats.isDirectory()) throw new TypeError("INVALID_CWD");

  return new Promise<ProcessResult>((resolve) => {
    const startedAt = Date.now();
    const stdout = new OutputAccumulator(input.maximumOutputBytes);
    const stderr = new OutputAccumulator(input.maximumOutputBytes);
    let timedOut = false;
    let spawnError: Error | undefined;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const child = spawn(input.executable, input.args, {
      cwd,
      detached: process.platform !== "win32",
      env: input.environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.once("error", (error) => {
      spawnError = error;
    });

    const finish = (
      outcome: ProcessOutcome,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      resolve({
        outcome,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        ...(spawnError ? { error: spawnError.message } : {}),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited while a descendant keeps the pipes open.
      }
      void terminateProcessTree(child.pid);
      terminationTimer = setTimeout(() => {
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        child.stdout.destroy();
        child.stderr.destroy();
        finish("TIMEOUT", child.exitCode, child.signalCode);
      }, PROCESS_TERMINATION_GRACE_MS);
    }, input.timeoutMs);

    child.once("close", (exitCode, signal) => {
      const outcome: ProcessOutcome = timedOut
        ? "TIMEOUT"
        : spawnError
          ? "INFRA_ERROR"
          : exitCode === 0
            ? "PASS"
            : "PROCESS_CRASH";
      finish(outcome, exitCode, signal);
    });
  });
}

interface RepositoryInventory {
  files: string[];
  spellings: Map<string, string>;
  totalBytes: number;
}

function effectiveExcludes(requestExcludes: readonly string[]): Set<string> {
  return new Set([...DEFAULT_EXCLUDES, ...requestExcludes].map(portablePathKey));
}

function comparePortablePaths(left: string, right: string): number {
  const leftKey = portablePathKey(left);
  const rightKey = portablePathKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function registerPortablePath(spellings: Map<string, string>, relative: string): void {
  const key = portablePathKey(relative);
  const existing = spellings.get(key);
  if (existing !== undefined && existing !== relative) throw new Error("PORTABLE_PATH_COLLISION");
  spellings.set(key, relative);
}

async function walkFiles(
  root: string,
  excludes: ReadonlySet<string>,
): Promise<RepositoryInventory> {
  const files: string[] = [];
  const spellings = new Map<string, string>();
  let totalBytes = 0;
  async function visit(relativeDirectory: string): Promise<void> {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (excludes.has(portablePathKey(entry.name))) continue;
      const relative = path.posix.join(relativeDirectory.split(path.sep).join("/"), entry.name);
      const entryStats = await lstat(path.join(root, ...relative.split("/")));
      if (entryStats.isSymbolicLink()) throw new Error("UNSUPPORTED_REPOSITORY_SYMLINK");
      registerPortablePath(spellings, relative);
      if (entryStats.isDirectory()) await visit(relative);
      else if (entryStats.isFile()) {
        files.push(relative);
        totalBytes += entryStats.size;
      }
    }
  }
  await visit("");
  files.sort(comparePortablePaths);
  return { files, spellings, totalBytes };
}

function rawSha256(content: string | Uint8Array): string {
  return `${SHA256_PREFIX}${createHash("sha256").update(content).digest("hex")}`;
}

function initJsonBytes(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

function isInitPackageManager(value: string): value is InitPackageManager {
  return (INIT_PACKAGE_MANAGERS as readonly string[]).includes(value);
}

function isInitFramework(value: string): value is InitFramework {
  return (INIT_FRAMEWORKS as readonly string[]).includes(value);
}

function safeInitCommand(value: unknown): { executable: string; arguments: string[] } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("executable" in value) ||
    typeof value.executable !== "string" ||
    !("arguments" in value) ||
    !Array.isArray(value.arguments) ||
    !value.arguments.every((argument) => typeof argument === "string") ||
    value.executable.length === 0 ||
    value.executable.length > 512 ||
    value.arguments.length > 100 ||
    value.arguments.some((argument) => argument.length > 1_024) ||
    /^(?:[a-zA-Z]:|[\\/]{1,2})/u.test(value.executable) ||
    path.isAbsolute(value.executable) ||
    /[\s;&|<>`]/u.test(value.executable) ||
    [...value.executable].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    }) ||
    value.arguments.some(
      (argument) =>
        /^(?:[a-zA-Z]:|[\\/]{1,2})/u.test(argument) ||
        path.isAbsolute(argument) ||
        [...argument].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        }),
    )
  ) {
    return undefined;
  }
  return { executable: value.executable, arguments: [...value.arguments] };
}

function parseInitScript(script: unknown): { executable: string; arguments: string[] } | undefined {
  if (
    typeof script !== "string" ||
    script.trim() !== script ||
    script.length === 0 ||
    /[;&|<>`\r\n'"]/u.test(script)
  ) {
    return undefined;
  }
  const [executable, ...arguments_] = script.split(/\s+/u);
  return safeInitCommand({ executable, arguments: arguments_ });
}

function initPackageDocument(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function initDependencies(document: Record<string, unknown> | undefined): Set<string> {
  const result = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const value = document?.[field];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.keys(value)) result.add(key);
    }
  }
  return result;
}

function initCiProvider(file: string): RepositoryInitDetections["ciProviders"][number] | undefined {
  if (file.startsWith(".github/workflows/")) return "github-actions";
  if (file === ".gitlab-ci.yml") return "gitlab-ci";
  if (file === "azure-pipelines.yml") return "azure-pipelines";
  if (file === ".circleci/config.yml") return "circleci";
  return undefined;
}

function initEvidenceKind(
  file: string,
): RepositoryInitLock["evidence"][number]["kind"] | undefined {
  if (file === "package.json" || file === "pyproject.toml" || file === "requirements.txt")
    return "PACKAGE_MANIFEST";
  if (
    [
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "uv.lock",
      "poetry.lock",
      "Pipfile.lock",
    ].includes(file)
  )
    return "LOCKFILE";
  if (initCiProvider(file) !== undefined) return "CI_CONFIG";
  if (/((^|\/)test[^/]*|\.test|\.spec)\.(?:[cm]?[jt]s|tsx?|py)$/u.test(file)) return "TEST_SOURCE";
  return undefined;
}

function initNodeTestSource(file: string): boolean {
  return /(?:^|\/)[^/]+\.test\.[cm]?[jt]s$/u.test(file);
}

function initSafePathPattern(value: string): boolean {
  if (value.startsWith("-") || value.includes("\\")) return false;
  try {
    assertSafeRelativePath(value.replaceAll("*", "x").replaceAll("?", "x"), ["."]);
    return true;
  } catch {
    return false;
  }
}

function initPathPatternMatcher(pattern: string): (file: string) => boolean {
  if (!/[*?]/u.test(pattern)) {
    return (file) => file === pattern || file.startsWith(`${pattern}/`);
  }
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:[^/]+/)*";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  const matcher = new RegExp(`${expression}$`, "u");
  return (file) => matcher.test(file);
}

function initCommandPathMatchers(
  command: { executable: string; arguments: string[] },
  testSources: string[],
): Array<(file: string) => boolean> {
  const conventionalDirectories = new Set(["test", "tests", "spec", "specs", "__tests__"]);
  return command.arguments
    .filter(
      (argument) =>
        initSafePathPattern(argument) &&
        (/[*?]/u.test(argument) ||
          argument.includes("/") ||
          initNodeTestSource(argument) ||
          conventionalDirectories.has(argument) ||
          testSources.some((file) => file === argument || file.startsWith(`${argument}/`))),
    )
    .map(initPathPatternMatcher);
}

function initJavaScriptModuleSpecifiers(source: string): Set<string> {
  const tokens: Array<{ kind: SyntaxKind; text: string; value: string }> = [];
  const scanner = createScanner(true, undefined, source);
  const templateExpressionBraceDepths: number[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    const templateDepthIndex = templateExpressionBraceDepths.length - 1;
    if (
      kind === SyntaxKind.CloseBraceToken &&
      templateDepthIndex >= 0 &&
      templateExpressionBraceDepths[templateDepthIndex] === 0
    ) {
      kind = scanner.reScanTemplateToken(false);
      tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
      if (kind === SyntaxKind.TemplateTail) templateExpressionBraceDepths.pop();
      continue;
    }
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
    if (kind === SyntaxKind.TemplateHead) {
      templateExpressionBraceDepths.push(0);
    } else if (templateDepthIndex >= 0 && kind === SyntaxKind.OpenBraceToken) {
      templateExpressionBraceDepths[templateDepthIndex] =
        (templateExpressionBraceDepths[templateDepthIndex] ?? 0) + 1;
    } else if (templateDepthIndex >= 0 && kind === SyntaxKind.CloseBraceToken) {
      templateExpressionBraceDepths[templateDepthIndex] =
        (templateExpressionBraceDepths[templateDepthIndex] ?? 0) - 1;
    }
  }
  const specifiers = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (
      (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.RequireKeyword) &&
      token.text === "require" &&
      tokens[index - 1]?.kind !== SyntaxKind.DotToken &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken &&
      tokens[index + 2]?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.add(tokens[index + 2]?.value ?? "");
      continue;
    }
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) {
      continue;
    }
    if (tokens[index + 1]?.kind === SyntaxKind.StringLiteral) {
      specifiers.add(tokens[index + 1]?.value ?? "");
      continue;
    }
    if (
      token.kind === SyntaxKind.ImportKeyword &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken &&
      tokens[index + 2]?.kind === SyntaxKind.StringLiteral
    ) {
      specifiers.add(tokens[index + 2]?.value ?? "");
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (
        candidate?.kind === SyntaxKind.SemicolonToken ||
        candidate?.kind === SyntaxKind.ImportKeyword ||
        candidate?.kind === SyntaxKind.ExportKeyword
      ) {
        break;
      }
      if (candidate?.text === "from" && tokens[cursor + 1]?.kind === SyntaxKind.StringLiteral) {
        specifiers.add(tokens[cursor + 1]?.value ?? "");
        break;
      }
    }
  }
  specifiers.delete("");
  return specifiers;
}

async function atomicInitWrite(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  const temporary = path.join(root, `.${relative}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function initEmptyDetections(reasonCodes: string[]): RepositoryInitDetections {
  return {
    packageManager: null,
    framework: null,
    testCommand: null,
    ciProviders: [],
    adapterRecommendation: "unavailable",
    reasonCodes: [...reasonCodes].sort(),
  };
}

function initTerminalResult(
  status: "BLOCKED" | "CONFLICT",
  detections: RepositoryInitDetections,
  reasonCodes: string[],
): RepositoryInitResult {
  return parseRepositoryInitResult({
    schemaVersion: "1.0.0",
    status,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    detections: { ...detections, reasonCodes: [...new Set(detections.reasonCodes)].sort() },
    actions: [],
    files: [],
    requiredOperatorInputs: ["worlds", "candidates"],
    nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
  });
}

export async function initializeRepository(
  requestedRoot: string,
  options: RepositoryInitOptions = {},
): Promise<RepositoryInitResult> {
  let root: string;
  try {
    root = await realpath(requestedRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("REPOSITORY_ROOT_NOT_DIRECTORY");
  } catch {
    return initTerminalResult("CONFLICT", initEmptyDetections(["REPOSITORY_ROOT_INVALID"]), [
      "REPOSITORY_ROOT_INVALID",
    ]);
  }

  const candidateRoots = ["tests/candidates"] as const;
  const outsideCandidateRoots = (file: string): boolean =>
    !candidateRoots.some((candidateRoot) => {
      const rootKey = portablePathKey(candidateRoot);
      const fileKey = portablePathKey(file);
      return fileKey === rootKey || fileKey.startsWith(`${rootKey}/`);
    });
  const inventory = await walkFiles(root, effectiveExcludes([...INIT_MANAGED_FILES]));
  const inScopeFiles = inventory.files.filter(outsideCandidateRoots);
  const contents = new Map<string, string>();
  const evidenceBytes = new Map<string, Uint8Array>();
  for (const file of inScopeFiles) {
    const kind = initEvidenceKind(file);
    if (kind !== undefined || file === "package.json" || file === "pyproject.toml") {
      const bytes = await readFile(path.join(root, ...file.split("/")));
      evidenceBytes.set(file, bytes);
      contents.set(file, bytes.toString("utf8"));
    }
  }
  const packageDocument = initPackageDocument(contents.get("package.json"));
  if (contents.has("package.json") && packageDocument === undefined) {
    return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANIFEST_INVALID"]), [
      "PACKAGE_MANIFEST_INVALID",
    ]);
  }

  const managerFacts = new Set<InitPackageManager>();
  const packageManagerField = packageDocument?.packageManager;
  if (typeof packageManagerField === "string") {
    const id = packageManagerField.split("@")[0] ?? "";
    if (!isInitPackageManager(id)) {
      return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANAGER_INVALID"]), [
        "PACKAGE_MANAGER_INVALID",
      ]);
    }
    managerFacts.add(id);
  }
  const managerLockfiles: Array<[InitPackageManager, string[]]> = [
    ["pnpm", ["pnpm-lock.yaml"]],
    ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
    ["yarn", ["yarn.lock"]],
    ["bun", ["bun.lock", "bun.lockb"]],
    ["uv", ["uv.lock"]],
    ["poetry", ["poetry.lock"]],
    ["pip", ["Pipfile.lock", "requirements.txt"]],
  ];
  for (const [manager, files] of managerLockfiles) {
    if (files.some((file) => inScopeFiles.includes(file))) managerFacts.add(manager);
  }
  const pyproject = contents.get("pyproject.toml") ?? "";
  if (/\[tool\.uv\]/u.test(pyproject)) managerFacts.add("uv");
  if (/\[tool\.poetry\]/u.test(pyproject)) managerFacts.add("poetry");

  const managerOverride = options.packageManager;
  if (managerOverride !== undefined && !isInitPackageManager(managerOverride)) {
    return initTerminalResult(
      "CONFLICT",
      initEmptyDetections(["PACKAGE_MANAGER_OVERRIDE_INVALID"]),
      ["PACKAGE_MANAGER_OVERRIDE_INVALID"],
    );
  }
  if (
    managerFacts.size > 1 ||
    (managerOverride !== undefined && managerFacts.size === 1 && !managerFacts.has(managerOverride))
  ) {
    return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANAGER_AMBIGUOUS"]), [
      "PACKAGE_MANAGER_AMBIGUOUS",
    ]);
  }
  const packageManager = managerOverride ?? [...managerFacts][0];
  if (packageManager === undefined) {
    return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANAGER_UNDETECTED"]), [
      "PACKAGE_MANAGER_UNDETECTED",
    ]);
  }

  const frameworkFacts = new Set<InitFramework>();
  const dependencies = initDependencies(packageDocument);
  if (dependencies.has("vitest")) frameworkFacts.add("vitest");
  if (dependencies.has("jest") || dependencies.has("@jest/globals")) frameworkFacts.add("jest");
  if (dependencies.has("pytest")) frameworkFacts.add("pytest");
  for (const [file, content] of contents) {
    if (
      initEvidenceKind(file) !== "TEST_SOURCE" &&
      file !== "pyproject.toml" &&
      file !== "requirements.txt"
    )
      continue;
    if (/\.[cm]?[jt]sx?$/u.test(file)) {
      const specifiers = initJavaScriptModuleSpecifiers(content);
      if (specifiers.has("node:test")) frameworkFacts.add("node:test");
      if ([...specifiers].some((name) => name === "vitest" || name.startsWith("@vitest/"))) {
        frameworkFacts.add("vitest");
      }
      if ([...specifiers].some((name) => name === "jest" || name.startsWith("@jest/"))) {
        frameworkFacts.add("jest");
      }
      if (specifiers.has("bun:test")) frameworkFacts.add("bun:test");
    } else if (file.endsWith(".py") && /(^|\/)test[^/]*\.py$/u.test(file)) {
      frameworkFacts.add("pytest");
    }
  }
  const scripts = packageDocument?.scripts;
  const testScript =
    scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>).test
      : undefined;
  if (typeof testScript === "string") {
    if (/\bnode\s+--test\b/u.test(testScript)) frameworkFacts.add("node:test");
    if (/\bvitest\b/u.test(testScript)) frameworkFacts.add("vitest");
    if (/\bjest\b/u.test(testScript)) frameworkFacts.add("jest");
    if (/\bbun\s+test\b/u.test(testScript)) frameworkFacts.add("bun:test");
    if (/\bpytest\b/u.test(testScript)) frameworkFacts.add("pytest");
  }
  if (
    /\[tool\.pytest(?:\.|\])/u.test(pyproject) ||
    (contents.has("requirements.txt") &&
      /(^|\n)pytest(?:[=<>!~]|$)/u.test(contents.get("requirements.txt") ?? ""))
  )
    frameworkFacts.add("pytest");

  const frameworkOverride = options.framework;
  if (frameworkOverride !== undefined && !isInitFramework(frameworkOverride)) {
    const detections = initEmptyDetections(["FRAMEWORK_OVERRIDE_INVALID"]);
    detections.packageManager = packageManager;
    return initTerminalResult("CONFLICT", detections, ["FRAMEWORK_OVERRIDE_INVALID"]);
  }
  if (
    (frameworkFacts.size > 1 && frameworkOverride === undefined) ||
    (frameworkOverride !== undefined &&
      frameworkFacts.size > 0 &&
      !frameworkFacts.has(frameworkOverride))
  ) {
    const detections = initEmptyDetections(["FRAMEWORK_AMBIGUOUS"]);
    detections.packageManager = packageManager;
    return initTerminalResult("CONFLICT", detections, ["FRAMEWORK_AMBIGUOUS"]);
  }
  const framework = frameworkOverride ?? [...frameworkFacts][0];
  if (framework === undefined) {
    const detections = initEmptyDetections(["FRAMEWORK_UNDETECTED"]);
    detections.packageManager = packageManager;
    return initTerminalResult("CONFLICT", detections, ["FRAMEWORK_UNDETECTED"]);
  }

  let testCommand =
    options.testCommand === undefined ? undefined : safeInitCommand(options.testCommand);
  if (options.testCommand !== undefined && testCommand === undefined) {
    const detections = initEmptyDetections(["TEST_COMMAND_INVALID"]);
    detections.packageManager = packageManager;
    detections.framework = framework;
    return initTerminalResult("CONFLICT", detections, ["TEST_COMMAND_INVALID"]);
  }
  if (testCommand === undefined && testScript !== undefined)
    testCommand = parseInitScript(testScript);
  if (testCommand === undefined && testScript !== undefined) {
    const detections = initEmptyDetections(["TEST_COMMAND_UNSAFE_OR_AMBIGUOUS"]);
    detections.packageManager = packageManager;
    detections.framework = framework;
    return initTerminalResult("CONFLICT", detections, ["TEST_COMMAND_UNSAFE_OR_AMBIGUOUS"]);
  }
  testCommand ??=
    framework === "pytest"
      ? packageManager === "uv"
        ? { executable: "uv", arguments: ["run", "pytest"] }
        : packageManager === "poetry"
          ? { executable: "poetry", arguments: ["run", "pytest"] }
          : { executable: "python", arguments: ["-m", "pytest"] }
      : framework === "bun:test"
        ? { executable: "bun", arguments: ["test"] }
        : framework === "vitest"
          ? { executable: "vitest", arguments: ["run"] }
          : framework === "jest"
            ? { executable: "jest", arguments: [] }
            : { executable: "node", arguments: ["--test"] };

  const ciProviders = [
    ...new Set(
      inScopeFiles
        .map(initCiProvider)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
    ),
  ].sort();
  let adapter: RepositoryInitConfig["adapter"] | undefined;
  let adapterRecommendation: RepositoryInitDetections["adapterRecommendation"] = "unavailable";
  let adapterEvidencePath: string | undefined;
  if (options.adapterConfigPath !== undefined) {
    try {
      const resolvedAdapter = await realpath(path.resolve(root, options.adapterConfigPath));
      const relative = path.relative(root, resolvedAdapter).split(path.sep).join("/");
      if (relative.startsWith("../") || relative === "" || path.isAbsolute(relative))
        throw new Error("ADAPTER_CONFIG_OUTSIDE_REPOSITORY");
      const adapterBytes = await readFile(resolvedAdapter);
      const parsed = AdapterSchema.safeParse(JSON.parse(adapterBytes.toString("utf8")) as unknown);
      if (!parsed.success) throw new Error("ADAPTER_CONFIG_INVALID");
      if (
        safeInitCommand({
          executable: parsed.data.executable,
          arguments: parsed.data.kind === "testforge-command" ? parsed.data.arguments : [],
        }) === undefined
      ) {
        throw new Error("ADAPTER_CONFIG_INVALID");
      }
      if (parsed.data.kind === "node-test" && framework !== "node:test") {
        const incompatible: RepositoryInitDetections = {
          packageManager,
          framework,
          testCommand,
          ciProviders,
          adapterRecommendation: "unavailable",
          reasonCodes: ["ADAPTER_FRAMEWORK_INCOMPATIBLE"],
        };
        return initTerminalResult("CONFLICT", incompatible, ["ADAPTER_FRAMEWORK_INCOMPATIBLE"]);
      }
      adapter = parsed.data;
      adapterRecommendation = "operator-supplied";
      adapterEvidencePath = relative;
      evidenceBytes.set(relative, adapterBytes);
    } catch {
      const detections: RepositoryInitDetections = {
        packageManager,
        framework,
        testCommand,
        ciProviders,
        adapterRecommendation: "unavailable",
        reasonCodes: ["ADAPTER_CONFIG_INVALID"],
      };
      return initTerminalResult("CONFLICT", detections, ["ADAPTER_CONFIG_INVALID"]);
    }
  } else if (framework === "node:test") {
    const testSources = inScopeFiles.filter(initNodeTestSource);
    const pathMatchers = initCommandPathMatchers(testCommand, testSources);
    const baseTestFiles =
      pathMatchers.length === 0
        ? testSources
        : testSources.filter((file) => pathMatchers.some((matcher) => matcher(file)));
    if (baseTestFiles.length > 0) {
      adapter = { kind: "node-test", executable: "node", baseTestFiles };
      adapterRecommendation = "node-test";
    }
  }

  const reasonCodes =
    adapter === undefined
      ? [framework === "node:test" ? "BASE_TEST_FILES_UNAVAILABLE" : "OFFICIAL_ADAPTER_UNAVAILABLE"]
      : [];
  const detections: RepositoryInitDetections = {
    packageManager,
    framework,
    testCommand,
    ciProviders,
    adapterRecommendation,
    reasonCodes,
  };
  if (adapter === undefined) return initTerminalResult("BLOCKED", detections, reasonCodes);
  await options.afterEvidenceSnapshot?.();

  const config = parseRepositoryInitConfig({
    schemaVersion: "1.0.0",
    repository: { root: ".", exclude: [".git", ".testforge", "node_modules"] },
    packageManager,
    framework,
    testCommand,
    adapter,
    candidateRoots: [...candidateRoots],
  });
  const configContent = initJsonBytes(config);
  const configDigest = repositoryInitConfigDigest(config);
  const evidenceFiles = inScopeFiles.filter((file) => initEvidenceKind(file) !== undefined);
  if (adapterEvidencePath !== undefined && !evidenceFiles.includes(adapterEvidencePath))
    evidenceFiles.push(adapterEvidencePath);
  evidenceFiles.sort(comparePortablePaths);
  const evidence: RepositoryInitLock["evidence"] = [];
  for (const file of evidenceFiles) {
    const content = evidenceBytes.get(file);
    if (content === undefined) throw new Error("INIT_EVIDENCE_SNAPSHOT_INCONSISTENT");
    evidence.push({
      path: file,
      digest: rawSha256(content),
      kind:
        file === adapterEvidencePath
          ? "ADAPTER_CONFIG"
          : (initEvidenceKind(file) ?? "ADAPTER_CONFIG"),
    });
  }
  const lockBase: Omit<RepositoryInitLock, "lockDigest"> = {
    schemaVersion: "1.0.0",
    configDigest,
    detector: { name: "assertledger-init", version: "1.0.0" },
    evidence,
    detections,
  };
  const lock = parseRepositoryInitLock({
    ...lockBase,
    lockDigest: repositoryInitLockDigest(lockBase),
  });
  const lockContent = initJsonBytes(lock);
  const plannedFiles: RepositoryInitResult["files"] = [
    { path: INIT_CONFIG_FILE, digest: rawSha256(configContent), content: configContent },
    { path: INIT_LOCK_FILE, digest: rawSha256(lockContent), content: lockContent },
  ];

  let finalInScopeFiles: string[];
  try {
    const finalInventory = await walkFiles(root, effectiveExcludes([...INIT_MANAGED_FILES]));
    finalInScopeFiles = finalInventory.files.filter(outsideCandidateRoots);
  } catch {
    finalInScopeFiles = [];
  }
  let repositoryChanged = JSON.stringify(finalInScopeFiles) !== JSON.stringify(inScopeFiles);
  if (!repositoryChanged) {
    for (const [file, snapshot] of evidenceBytes) {
      try {
        const current = await readFile(path.join(root, ...file.split("/")));
        if (!current.equals(Buffer.from(snapshot))) {
          repositoryChanged = true;
          break;
        }
      } catch {
        repositoryChanged = true;
        break;
      }
    }
  }
  if (repositoryChanged) {
    return initTerminalResult(
      "CONFLICT",
      { ...detections, reasonCodes: ["REPOSITORY_CHANGED_DURING_INIT"] },
      ["REPOSITORY_CHANGED_DURING_INIT"],
    );
  }

  const readManaged = async (file: string): Promise<string | undefined> => {
    try {
      return await readFile(path.join(root, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const existingConfig = await readManaged(INIT_CONFIG_FILE);
  const existingLock = await readManaged(INIT_LOCK_FILE);
  if (existingConfig !== undefined && existingConfig !== configContent) {
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: ["CONFIG_CONFLICT"] }, [
      "CONFIG_CONFLICT",
    ]);
  }
  if (existingLock !== undefined) {
    let structural: RepositoryInitLock;
    try {
      const value = JSON.parse(existingLock) as unknown;
      structural = parseRepositoryInitLock(value);
    } catch {
      return initTerminalResult("CONFLICT", { ...detections, reasonCodes: ["LOCK_INVALID"] }, [
        "LOCK_INVALID",
      ]);
    }
    if (structural.configDigest !== configDigest) {
      return initTerminalResult(
        "CONFLICT",
        { ...detections, reasonCodes: ["LOCK_CONFIG_MISMATCH"] },
        ["LOCK_CONFIG_MISMATCH"],
      );
    }
  }
  if (existingConfig === configContent && existingLock === lockContent) {
    return parseRepositoryInitResult({
      schemaVersion: "1.0.0",
      status: "UNCHANGED",
      reasonCodes: [],
      detections,
      actions: [],
      files: plannedFiles,
      requiredOperatorInputs: ["worlds", "candidates"],
      nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
    });
  }
  const actions: RepositoryInitResult["actions"] = [];
  if (existingConfig === undefined) actions.push({ kind: "CREATE", path: INIT_CONFIG_FILE });
  if (existingLock === undefined) actions.push({ kind: "CREATE", path: INIT_LOCK_FILE });
  else if (existingLock !== lockContent) actions.push({ kind: "REGENERATE", path: INIT_LOCK_FILE });
  actions.sort((left, right) => left.path.localeCompare(right.path));
  const status = options.dryRun ? "WOULD_CREATE" : "CREATED";
  const result = parseRepositoryInitResult({
    schemaVersion: "1.0.0",
    status,
    reasonCodes: [],
    detections,
    actions,
    files: plannedFiles,
    requiredOperatorInputs: ["worlds", "candidates"],
    nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
  });
  if (!options.dryRun) {
    for (const action of actions) {
      const file = plannedFiles.find((candidate) => candidate.path === action.path);
      if (file === undefined) throw new Error("INIT_PLAN_INCONSISTENT");
      await atomicInitWrite(root, file.path, file.content);
    }
  }
  return result;
}

function languageForFile(file: string): string | undefined {
  const extension = path.extname(file).toLowerCase();
  return {
    ".js": "JavaScript",
    ".cjs": "JavaScript",
    ".mjs": "JavaScript",
    ".ts": "TypeScript",
    ".cts": "TypeScript",
    ".mts": "TypeScript",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
  }[extension];
}

function packageDependencyNames(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const document = parsed as Record<string, unknown>;
    const names: string[] = [];
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const dependencies = document[field];
      if (
        dependencies === null ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies)
      ) {
        continue;
      }
      names.push(...Object.keys(dependencies));
    }
    return names;
  } catch {
    return [];
  }
}

function isTestSourcePath(file: string): boolean {
  const segments = file.toLowerCase().split("/");
  const basename = segments.at(-1) ?? "";
  return (
    segments.some(
      (segment) => segment === "test" || segment === "tests" || segment === "__tests__",
    ) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(basename)
  );
}

interface JavaScriptToken {
  readonly kind: "identifier" | "string" | "punctuator";
  readonly value: string;
}

function javascriptTokens(source: string): JavaScriptToken[] {
  const tokens: JavaScriptToken[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index] as string;
    const next = source[index + 1];
    if (/\s/u.test(current)) {
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 2;
      continue;
    }
    if (
      current === "/" &&
      (tokens.length === 0 ||
        /^[([{,:;=!?&|+*%^~<>-]$/u.test(tokens.at(-1)?.value ?? "") ||
        [
          "await",
          "case",
          "delete",
          "in",
          "instanceof",
          "of",
          "return",
          "throw",
          "typeof",
          "void",
          "yield",
        ].includes(tokens.at(-1)?.value ?? ""))
    ) {
      index += 1;
      let inCharacterClass = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "[") inCharacterClass = true;
        if (source[index] === "]") inCharacterClass = false;
        if (source[index] === "/" && !inCharacterClass) {
          index += 1;
          while (index < source.length && /[A-Za-z]/u.test(source[index] as string)) index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 2;
          value = "";
          continue;
        }
        value += source[index];
        index += 1;
      }
      if (index >= source.length) break;
      tokens.push({ kind: "string", value });
      index += 1;
      continue;
    }
    if (current === "`") {
      index += 1;
      while (index < source.length && source[index] !== "`") {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/u.test(current)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index] as string)) {
        index += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuator", value: current });
    index += 1;
  }
  return tokens;
}

function importsNodeTest(text: string): boolean {
  const tokens = javascriptTokens(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token?.kind !== "identifier" || previous?.value === ".") continue;
    if (
      token.value === "require" &&
      tokens[index + 1]?.value === "(" &&
      tokens[index + 2]?.kind === "string" &&
      tokens[index + 2]?.value === "node:test"
    ) {
      return true;
    }
    if (token.value !== "import") continue;
    if (tokens[index + 1]?.kind === "string") {
      if (tokens[index + 1]?.value === "node:test") return true;
      continue;
    }
    if (tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string") {
      if (tokens[index + 2]?.value === "node:test") return true;
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate?.value === ";") break;
      if (candidate?.kind === "identifier" && candidate.value === "from") {
        if (tokens[cursor + 1]?.kind === "string" && tokens[cursor + 1]?.value === "node:test") {
          return true;
        }
        break;
      }
      if (
        candidate?.kind === "identifier" &&
        ["class", "const", "export", "function", "import", "let", "var"].includes(candidate.value)
      ) {
        break;
      }
    }
  }
  return false;
}

function dependencyArrayIncludesPytest(value: string): boolean {
  return [...value.matchAll(/["']([^"']+)["']/gu)].some((match) =>
    /^pytest(?:\[[^\]]+\])?(?:\s*[<>=!~].*)?$/iu.test(match[1]?.trim() ?? ""),
  );
}

function tomlArrayAssignments(body: string, keyPattern: string): string[] {
  const starts = new RegExp(`^\\s*${keyPattern}\\s*=\\s*\\[`, "gimu");
  const arrays: string[] = [];
  for (const match of body.matchAll(starts)) {
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    let quote: '"' | "'" | undefined;
    let depth = 1;
    while (index < body.length && depth > 0) {
      const current = body[index];
      if (quote !== undefined) {
        if (current === "\\" && quote === '"') index += 2;
        else {
          if (current === quote) quote = undefined;
          index += 1;
        }
        continue;
      }
      if (current === '"' || current === "'") quote = current;
      else if (current === "[") depth += 1;
      else if (current === "]") depth -= 1;
      index += 1;
    }
    if (depth === 0) arrays.push(body.slice(start, index - 1));
  }
  return arrays;
}

function pyprojectDeclaresPytest(text: string): boolean {
  const sections = [...text.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gmu)];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) continue;
    const name = (section[1] ?? "").trim().toLowerCase();
    if (name === "tool.pytest" || name.startsWith("tool.pytest.")) return true;
    const bodyStart = (section.index ?? 0) + section[0].length;
    const bodyEnd = sections[index + 1]?.index ?? text.length;
    const body = text.slice(bodyStart, bodyEnd);
    if (
      (name === "tool.poetry.dependencies" ||
        /^tool\.poetry\.group\.[^.]+\.dependencies$/u.test(name)) &&
      /^\s*pytest(?:\[[^\]]+\])?\s*=/imu.test(body)
    ) {
      return true;
    }
    const arrayKeyPattern =
      name === "project"
        ? "dependencies"
        : name === "project.optional-dependencies" ||
            name === "dependency-groups" ||
            name === "tool.pdm.dev-dependencies"
          ? "[A-Za-z0-9_-]+"
          : name === "tool.uv"
            ? "dev-dependencies"
            : undefined;
    if (
      arrayKeyPattern !== undefined &&
      tomlArrayAssignments(body, arrayKeyPattern).some(dependencyArrayIncludesPytest)
    ) {
      return true;
    }
  }
  return false;
}

function detectFrameworkEvidence(file: string, text: string, frameworks: Set<string>): void {
  const normalized = file.toLowerCase();
  const basename = path.posix.basename(normalized);

  if (basename === "package.json") {
    for (const dependency of packageDependencyNames(text)) {
      const name = dependency.toLowerCase();
      if (name === "vitest" || name.startsWith("@vitest/")) frameworks.add("vitest");
      if (name === "jest" || name.startsWith("@jest/")) frameworks.add("jest");
    }
  }
  if (/^vitest\.config\.(?:[cm]?[jt]s|json)$/u.test(basename)) frameworks.add("vitest");
  if (/^jest\.config\.(?:[cm]?[jt]s|json)$/u.test(basename)) frameworks.add("jest");

  if (basename === "pytest.ini") frameworks.add("pytest");
  if (
    (basename === "setup.cfg" && /^\s*\[tool:pytest\]\s*$/imu.test(text)) ||
    (basename === "tox.ini" && /^\s*\[pytest\]\s*$/imu.test(text)) ||
    (basename === "pyproject.toml" && pyprojectDeclaresPytest(text)) ||
    (/^requirements(?:[-_.][a-z0-9_-]+)?\.txt$/u.test(basename) &&
      /^\s*pytest(?:\[[^\]]+\])?\s*(?:[<>=!~].*)?(?:#.*)?$/imu.test(text))
  ) {
    frameworks.add("pytest");
  }

  if (isTestSourcePath(normalized) && importsNodeTest(text)) frameworks.add("node:test");
}

async function resolveRepositoryRoot(rootInput: unknown): Promise<string> {
  const requestedRoot = requireString(rootInput, "repository_root");
  try {
    const root = await realpath(requestedRoot);
    if (!(await stat(root)).isDirectory()) throw new TypeError("not a directory");
    return root;
  } catch {
    throw new TypeError("INVALID_REPOSITORY_ROOT");
  }
}

export async function analyzeRepository(rootInput: string): Promise<unknown> {
  const root = await resolveRepositoryRoot(rootInput);
  const { files } = await walkFiles(root, effectiveExcludes([]));
  const digest = createHash("sha256");
  const languageCounts = new Map<string, number>();
  const frameworks = new Set<string>();

  for (const file of files) {
    const content = await readFile(path.join(root, ...file.split("/")));
    digest.update(Buffer.from(`${file}\0${content.byteLength}\0`, "utf8"));
    digest.update(content);
    const language = languageForFile(file);
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    const text = content.toString("utf8");
    detectFrameworkEvidence(file, text, frameworks);
  }

  return {
    root,
    fileCount: files.length,
    files,
    languages: [...languageCounts.entries()]
      .map(([name, count]) => ({ name, files: count }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    detectedTestFrameworks: [...frameworks].sort(),
    repositoryDigest: `${SHA256_PREFIX}${digest.digest("hex")}`,
    capabilities: {
      canExecuteCandidates: true,
      supportedAdapters: ["node-test", "testforge-command"],
      isolationLevels: ["UNSANDBOXED"],
    },
  };
}

export interface RepositoryAuditOptions {
  noGit?: boolean;
  verificationRequest?: unknown;
  afterInitialInventory?: () => Promise<void>;
}

type AuditFile = RepositoryAudit["files"][number];
type WeakAssertionCategory =
  | "TRUTHINESS_ONLY"
  | "CONSTANT_BOOLEAN_EQUALITY"
  | "DEFINEDNESS_ONLY"
  | "NON_THROW_ONLY"
  | "TYPE_ONLY";

function isAuditJavaScript(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/u.test(file);
}

function isAuditTest(file: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
  );
}

function auditAst(text: string): {
  decisionPoints: number;
  exports: string[];
  identifiers: Set<string>;
  weak: Map<WeakAssertionCategory, number>;
} {
  let decisionPoints = 0;
  const exports = new Set<string>();
  const identifiers = new Set<string>();
  const weak = new Map<WeakAssertionCategory, number>();
  const lexicalTokens: string[] = [];
  const addWeak = (category: WeakAssertionCategory) =>
    weak.set(category, (weak.get(category) ?? 0) + 1);
  const scanner = createScanner(true, undefined, text);
  const decisionKinds = new Set([
    SyntaxKind.IfKeyword,
    SyntaxKind.ForKeyword,
    SyntaxKind.WhileKeyword,
    SyntaxKind.DoKeyword,
    SyntaxKind.CatchKeyword,
    SyntaxKind.CaseKeyword,
    SyntaxKind.QuestionToken,
    SyntaxKind.AmpersandAmpersandToken,
    SyntaxKind.BarBarToken,
    SyntaxKind.QuestionQuestionToken,
  ]);
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.Identifier) identifiers.add(scanner.getTokenValue());
    if (decisionKinds.has(kind)) decisionPoints += 1;
    lexicalTokens.push(
      kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        kind === SyntaxKind.TemplateHead ||
        kind === SyntaxKind.TemplateMiddle ||
        kind === SyntaxKind.TemplateTail
        ? '"__LITERAL__"'
        : scanner.getTokenText(),
    );
  }
  const lexicalText = lexicalTokens.join(" ");
  for (const match of lexicalText.matchAll(
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    if (match[1]) exports.add(match[1]);
  }
  for (const match of lexicalText.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const item of (match[1] ?? "").split(",")) {
      const name = item
        .trim()
        .split(/\s+as\s+/u)
        .at(-1);
      if (name && /^[A-Za-z_$][\w$]*$/u.test(name)) exports.add(name);
    }
  }
  if (/\bexport\s+default\b/u.test(lexicalText)) exports.add("default");
  for (const _ of lexicalText.matchAll(
    /(?:\bassert(?:\s*\.\s*ok)?|\bexpect\s*\([^;]*?\)\s*\.\s*(?:toBeTruthy|toBeFalsy))\s*\(/gu,
  ))
    addWeak("TRUTHINESS_ONLY");
  for (const _ of lexicalText.matchAll(
    /(?:\bassert\s*\.\s*doesNotThrow\s*\(|\bexpect\s*\([^;]*?\)\s*\.\s*not\s*\.\s*toThrow\s*\()/gu,
  ))
    addWeak("NON_THROW_ONLY");
  for (const _ of lexicalText.matchAll(/\bexpect\s*\([^;]*?\)\s*\.\s*toBeDefined\s*\(/gu))
    addWeak("DEFINEDNESS_ONLY");
  for (const _ of lexicalText.matchAll(
    /(?:\bassert\s*\.\s*(?:equal|strictEqual)\s*\(\s*typeof\b[^,]+,\s*"__LITERAL__"|\bexpect\s*\(\s*typeof\b[^)]*\)\s*\.\s*toBe\s*\(\s*"__LITERAL__")/gu,
  ))
    addWeak("TYPE_ONLY");
  for (const _ of lexicalText.matchAll(
    /(?:\bassert\s*\.\s*(?:equal|strictEqual)\s*\([^,]+,\s*(?:true|false)|\bexpect\s*\([^)]*\)\s*\.\s*toBe\s*\(\s*(?:true|false))/gu,
  ))
    addWeak("CONSTANT_BOOLEAN_EQUALITY");
  return { decisionPoints, exports: [...exports].sort(), identifiers, weak };
}

async function auditGit(root: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, stdout: Buffer.concat(chunks).toString("utf8").trim() }),
    );
  });
}

function associatedAuditTests(source: string, tests: readonly string[]): string[] {
  const basename = path.posix.basename(source).replace(/\.[^.]+$/u, "");
  return tests
    .filter(
      (test) => path.posix.basename(test).replace(/\.(?:test|spec)?\.[^.]+$/u, "") === basename,
    )
    .sort();
}

function auditModulePrefix(file: string): string {
  const segments = file.split("/");
  return segments.length > 2 ? segments.slice(0, 2).join("/") : (segments[0] ?? file);
}

export async function auditRepository(
  rootInput: string,
  options: RepositoryAuditOptions = {},
): Promise<RepositoryAudit> {
  const root = await resolveRepositoryRoot(rootInput);
  const initial = (await analyzeRepository(root)) as { repositoryDigest: string; files: string[] };
  const fileContents = new Map<string, Buffer>();
  let repositoryBytes = 0;
  for (const file of initial.files) {
    const content = await readFile(path.join(root, ...file.split("/")));
    fileContents.set(file, content);
    repositoryBytes += content.byteLength;
  }
  await options.afterInitialInventory?.();

  const testIdentifiers = new Set<string>();
  const astByFile = new Map<string, ReturnType<typeof auditAst>>();
  for (const [file, content] of fileContents) {
    if (!isAuditJavaScript(file)) continue;
    const ast = auditAst(content.toString("utf8"));
    astByFile.set(file, ast);
    if (isAuditTest(file))
      for (const identifier of ast.identifiers) testIdentifiers.add(identifier);
  }

  const reasonCodes = new Set<string>();
  let gitSupported = false;
  let headTimestamp: number | null = null;
  let shallow: boolean | null = null;
  let truncated: boolean | null = null;
  const commitCounts = new Map<string, number>();
  const fixCounts = new Map<string, number>();
  const latestTimes = new Map<string, number>();
  let trackedFiles: Set<string> | null = null;
  if (options.noGit) reasonCodes.add("GIT_DISABLED");
  else {
    const worktree = await auditGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!worktree.ok || worktree.stdout !== "true") reasonCodes.add("GIT_UNAVAILABLE");
    else {
      const head = await auditGit(root, ["show", "-s", "--format=%ct", "HEAD"]);
      const shallowResult = await auditGit(root, ["rev-parse", "--is-shallow-repository"]);
      if (head.ok && /^\d+$/u.test(head.stdout) && shallowResult.ok) {
        headTimestamp = Number(head.stdout);
        shallow = shallowResult.stdout === "true";
        if (shallow) reasonCodes.add("GIT_HISTORY_SHALLOW");
        else {
          gitSupported = true;
          const tracked = await auditGit(root, ["ls-files", "-z"]);
          if (tracked.ok) {
            trackedFiles = new Set(
              tracked.stdout
                .split("\0")
                .filter(Boolean)
                .map((file) => file.replaceAll("\\", "/")),
            );
          } else {
            gitSupported = false;
            reasonCodes.add("GIT_INDEX_UNAVAILABLE");
          }
          const since = String(headTimestamp - 90 * 24 * 60 * 60);
          const history = await auditGit(root, [
            "log",
            "-n",
            "1001",
            `--since=@${since}`,
            "--format=@@%ct%x09%s",
            "--name-only",
            "--",
          ]);
          if (!history.ok) {
            gitSupported = false;
            reasonCodes.add("GIT_HISTORY_UNAVAILABLE");
          } else {
            const commits = history.stdout.split(/^@@/mu).filter(Boolean);
            truncated = commits.length > 1000;
            if (truncated) reasonCodes.add("GIT_HISTORY_TRUNCATED");
            for (const block of commits.slice(0, 1000)) {
              const [header = "", ...changed] = block.split(/\r?\n/u).filter(Boolean);
              const separator = header.indexOf("\t");
              const message = separator < 0 ? header : header.slice(separator + 1);
              const fix = /(?:^|\b)(?:fix|bug|repair|hotfix|regression)(?:\b|:)/iu.test(message);
              for (const file of new Set(changed.map((entry) => entry.replaceAll("\\", "/")))) {
                commitCounts.set(file, (commitCounts.get(file) ?? 0) + 1);
                if (fix) fixCounts.set(file, (fixCounts.get(file) ?? 0) + 1);
              }
            }
            const latestHistory = await auditGit(root, [
              "log",
              "-n",
              "1001",
              "--format=@@%ct",
              "--name-only",
              "--",
            ]);
            if (!latestHistory.ok) reasonCodes.add("GIT_LATEST_HISTORY_UNAVAILABLE");
            else {
              const latestCommits = latestHistory.stdout.split(/^@@/mu).filter(Boolean);
              if (latestCommits.length > 1000) {
                truncated = true;
                reasonCodes.add("GIT_HISTORY_TRUNCATED");
              }
              for (const block of latestCommits.slice(0, 1000)) {
                const [timestamp = "", ...changed] = block.split(/\r?\n/u).filter(Boolean);
                if (!/^\d+$/u.test(timestamp)) continue;
                for (const file of new Set(changed.map((entry) => entry.replaceAll("\\", "/")))) {
                  if (!latestTimes.has(file)) latestTimes.set(file, Number(timestamp));
                }
              }
            }
            if (truncated) gitSupported = false;
          }
        }
      } else reasonCodes.add("GIT_HEAD_UNAVAILABLE");
    }
  }

  const testFiles = initial.files.filter(isAuditTest);
  const files: AuditFile[] = initial.files.map((file) => {
    const ast = astByFile.get(file);
    const associatedTests = isAuditTest(file) ? [] : associatedAuditTests(file, testFiles);
    const sourceTime = latestTimes.get(file);
    const testTimes = associatedTests
      .map((test) => latestTimes.get(test))
      .filter((value): value is number => value !== undefined);
    return {
      path: file,
      language: languageForFile(file) ?? null,
      supported: ast !== undefined,
      bytes: fileContents.get(file)?.byteLength ?? 0,
      decisionPoints: ast?.decisionPoints ?? null,
      declaredExports: ast?.exports ?? null,
      noObservedTestReference: ast
        ? ast.exports.filter((name) => name !== "default" && !testIdentifiers.has(name))
        : null,
      associatedTests,
      sourceChangedAfterAssociatedTest:
        !gitSupported || sourceTime === undefined || testTimes.length === 0
          ? null
          : sourceTime > Math.max(...testTimes),
      commitsInWindow:
        gitSupported && trackedFiles?.has(file) ? (commitCounts.get(file) ?? 0) : null,
      fixCommitsInWindow:
        gitSupported && trackedFiles?.has(file) ? (fixCounts.get(file) ?? 0) : null,
      weakAssertions: ast
        ? [...ast.weak.entries()]
            .map(([category, count]) => ({ category, count }))
            .sort((left, right) =>
              left.category < right.category ? -1 : left.category > right.category ? 1 : 0,
            )
        : null,
    };
  });

  const moduleMap = new Map<string, AuditFile[]>();
  for (const file of files) {
    const prefix = auditModulePrefix(file.path);
    moduleMap.set(prefix, [...(moduleMap.get(prefix) ?? []), file]);
  }
  const ranked = [...moduleMap]
    .map(([pathPrefix, members]) => ({
      pathPrefix,
      files: members.length,
      factualTuple: [
        members.reduce((sum, file) => sum + (file.decisionPoints ?? 0), 0),
        members.reduce((sum, file) => sum + (file.noObservedTestReference?.length ?? 0), 0),
        members.reduce((sum, file) => sum + (file.fixCommitsInWindow ?? 0), 0),
        members.reduce((sum, file) => sum + (file.commitsInWindow ?? 0), 0),
        members.filter((file) => file.sourceChangedAfterAssociatedTest === true).length,
        members.reduce(
          (sum, file) =>
            sum + (file.weakAssertions ?? []).reduce((inner, item) => inner + item.count, 0),
          0,
        ),
      ] as [number, number, number, number, number, number],
    }))
    .sort((left, right) => {
      for (let index = 0; index < left.factualTuple.length; index += 1) {
        const delta = (right.factualTuple[index] ?? 0) - (left.factualTuple[index] ?? 0);
        if (delta !== 0) return delta;
      }
      const leftKey = portablePathKey(left.pathPrefix);
      const rightKey = portablePathKey(right.pathPrefix);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((module, index) => ({ ...module, rank: index + 1 }));

  let verificationRequest: VerificationRequestContract | null = null;
  if (options.verificationRequest !== undefined) {
    verificationRequest = parseVerificationRequest(options.verificationRequest);
    const requestRoot = await resolveRepositoryRoot(
      path.isAbsolute(verificationRequest.repository.root)
        ? verificationRequest.repository.root
        : path.resolve(root, verificationRequest.repository.root),
    );
    if (requestRoot !== root) throw new TypeError("VERIFICATION_REQUEST_REPOSITORY_MISMATCH");
    verificationRequest = {
      ...verificationRequest,
      repository: { ...verificationRequest.repository, root },
      isolation: { ...verificationRequest.isolation, acknowledgedUnsafeExecution: false },
    };
  } else reasonCodes.add("VERIFICATION_REQUEST_UNAVAILABLE");

  const candidates = verificationRequest?.candidates.length ?? 0;
  const worlds = verificationRequest?.worlds.length ?? 0;
  const attempts = verificationRequest?.policy.requiredAttempts ?? 0;
  const C = BigInt(candidates),
    W = BigInt(worlds),
    A = BigInt(attempts);
  const executions = (C + 1n) * W * A;
  const sumWorldBytes = BigInt(
    verificationRequest?.worlds.reduce(
      (sum, world) =>
        sum + world.files.reduce((inner, file) => inner + Buffer.byteLength(file.content), 0),
      0,
    ) ?? 0,
  );
  const sumCandidateBytes = BigInt(
    verificationRequest?.candidates.reduce(
      (sum, candidate) =>
        sum + candidate.files.reduce((inner, file) => inner + Buffer.byteLength(file.content), 0),
      0,
    ) ?? 0,
  );
  const overlayBytes = A * ((C + 1n) * sumWorldBytes + W * sumCandidateBytes);
  const final = (await analyzeRepository(root)) as { repositoryDigest: string };
  if (final.repositoryDigest !== initial.repositoryDigest)
    throw new Error("REPOSITORY_CHANGED_DURING_AUDIT");
  return parseRepositoryAudit({
    schemaVersion: "1.0.0",
    root,
    repositoryDigest: initial.repositoryDigest,
    fileCount: initial.files.length,
    repositoryBytes,
    reasonCodes: [...reasonCodes].sort(),
    git: {
      supported: gitSupported,
      headTimestamp,
      windowDays: 90,
      maximumCommits: 1000,
      shallow,
      truncated,
    },
    files,
    modules: ranked,
    cost: {
      candidates,
      worlds,
      attempts,
      executions: executions.toString(),
      controlExecutions: (W * A).toString(),
      candidateExecutions: (C * W * A).toString(),
      overlayBytes: overlayBytes.toString(),
      materializationBytes: (BigInt(repositoryBytes) * (executions + 1n) + overlayBytes).toString(),
      timeoutLimitMs: (
        executions * BigInt(verificationRequest?.budgets.timeoutMsPerExecution ?? 0)
      ).toString(),
      capturedStreamLimitBytes: (
        executions *
        BigInt(verificationRequest?.budgets.maximumOutputBytes ?? 0) *
        2n
      ).toString(),
    },
    verificationRequest,
  });
}

function parseOverlay(value: unknown, forbiddenCode: string, roots: string[]): FileOverlay {
  const record = requireRecord(value, "file_overlay");
  const rawPath = requireString(record.path, "overlay_path");
  let safePath: string;
  try {
    safePath = assertSafeRelativePath(rawPath, roots);
  } catch {
    throw new Error(forbiddenCode);
  }
  return { path: safePath, content: requireText(record.content, "overlay_content") };
}

function normalizePortableCollection<T extends { path: string }>(
  values: T[],
  duplicateCode: string,
): T[] {
  const spellings = new Map<string, string>();
  for (const value of values) {
    const key = portablePathKey(value.path);
    const existing = spellings.get(key);
    if (existing !== undefined) {
      if (existing === value.path) throw new TypeError(duplicateCode);
      throw new Error("PORTABLE_PATH_COLLISION");
    }
    spellings.set(key, value.path);
  }
  return [...values].sort((left, right) => comparePortablePaths(left.path, right.path));
}

function assertPortableStringCollection(values: string[], duplicateCode: string): void {
  normalizePortableCollection(
    values.map((value) => ({ path: value })),
    duplicateCode,
  );
}

function parseRequest(value: unknown): VerificationRequest {
  const request = parseVerificationRequest(value) as unknown as JsonRecord;
  const repository = requireRecord(request.repository, "repository");
  const adapter = requireRecord(request.adapter, "adapter");
  const isolation = requireRecord(request.isolation, "isolation");
  const budgets = requireRecord(request.budgets, "budgets");
  const policy = requireRecord(request.policy, "policy");
  const candidateRoots = requireStringArray(request.candidateRoots, "candidate_roots").map((root) =>
    assertSafeRelativePath(root, [root]),
  );
  if (candidateRoots.length === 0) throw new TypeError("INVALID_CANDIDATE_ROOTS");
  assertPortableStringCollection(candidateRoots, "DUPLICATE_CANDIDATE_ROOT");
  if (adapter.kind !== "node-test" && adapter.kind !== "testforge-command") {
    throw new TypeError("UNSUPPORTED_ADAPTER");
  }
  if (isolation.kind !== "trusted-local") throw new TypeError("UNSUPPORTED_ISOLATION");
  if (isolation.acknowledgedUnsafeExecution !== true) {
    throw new Error("UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED");
  }
  const parsedBudgets = {
    maximumCandidates: requirePositiveInteger(budgets.maximumCandidates, "maximum_candidates"),
    maximumWorlds: requirePositiveInteger(budgets.maximumWorlds, "maximum_worlds"),
    maximumExecutions: requirePositiveInteger(budgets.maximumExecutions, "maximum_executions"),
    maximumRepositoryFiles: requirePositiveInteger(
      budgets.maximumRepositoryFiles,
      "maximum_repository_files",
    ),
    maximumRepositoryBytes: requirePositiveInteger(
      budgets.maximumRepositoryBytes,
      "maximum_repository_bytes",
    ),
    maximumWorldOverlayBytes: requirePositiveInteger(
      budgets.maximumWorldOverlayBytes,
      "maximum_world_overlay_bytes",
    ),
    maximumCandidateBytes: requirePositiveInteger(
      budgets.maximumCandidateBytes,
      "maximum_candidate_bytes",
    ),
    maximumTotalCandidateBytes: requirePositiveInteger(
      budgets.maximumTotalCandidateBytes,
      "maximum_total_candidate_bytes",
    ),
    timeoutMsPerExecution: requirePositiveInteger(
      budgets.timeoutMsPerExecution,
      "timeout_ms_per_execution",
    ),
    maximumOutputBytes: requirePositiveInteger(budgets.maximumOutputBytes, "maximum_output_bytes"),
  };
  if (!Array.isArray(request.worlds) || !Array.isArray(request.candidates)) {
    throw new TypeError("INVALID_CAMPAIGN_COLLECTIONS");
  }
  if (request.worlds.length === 0) throw new TypeError("INVALID_WORLDS");
  if (request.worlds.length > parsedBudgets.maximumWorlds) throw new Error("WORLD_BUDGET_EXCEEDED");
  if (request.candidates.length > parsedBudgets.maximumCandidates) {
    throw new Error("CANDIDATE_BUDGET_EXCEEDED");
  }
  const worlds = request.worlds.map((value): World => {
    const world = requireRecord(value, "world");
    if (!(["REFERENCE", "TARGET", "NEUTRAL"] as unknown[]).includes(world.kind)) {
      throw new TypeError("INVALID_WORLD_KIND");
    }
    if (!Array.isArray(world.files)) throw new TypeError("INVALID_WORLD_FILES");
    if (typeof world.required !== "boolean") throw new TypeError("INVALID_WORLD_REQUIRED");
    const weight = world.weight;
    if (!Number.isSafeInteger(weight) || (weight as number) < 0)
      throw new TypeError("INVALID_WORLD_WEIGHT");
    const files = normalizePortableCollection(
      world.files.map((file) => parseOverlay(file, "FORBIDDEN_WORLD_PATH", ["."])),
      "DUPLICATE_WORLD_FILE_PATH",
    );
    return {
      id: requireString(world.id, "world_id"),
      kind: world.kind as World["kind"],
      required: world.required,
      weight: weight as number,
      ...(typeof world.provenance === "string" ? { provenance: world.provenance } : {}),
      files,
    };
  });
  const candidates = request.candidates.map((value): Candidate => {
    const candidate = requireRecord(value, "candidate");
    if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
      throw new TypeError("INVALID_CANDIDATE_FILES");
    }
    const files = normalizePortableCollection(
      candidate.files.map((file) => parseOverlay(file, "FORBIDDEN_CANDIDATE_PATH", candidateRoots)),
      "DUPLICATE_CANDIDATE_FILE_PATH",
    );
    const size = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
    if (size > parsedBudgets.maximumCandidateBytes) throw new Error("CANDIDATE_BYTES_EXCEEDED");
    return { id: requireString(candidate.id, "candidate_id"), files };
  });
  const worldOverlayBytes = worlds.reduce(
    (total, world) =>
      total +
      world.files.reduce((fileTotal, file) => fileTotal + Buffer.byteLength(file.content), 0),
    0,
  );
  if (worldOverlayBytes > parsedBudgets.maximumWorldOverlayBytes) {
    throw new Error("WORLD_OVERLAY_BYTES_EXCEEDED");
  }
  const totalCandidateBytes = candidates.reduce(
    (total, candidate) =>
      total +
      candidate.files.reduce((fileTotal, file) => fileTotal + Buffer.byteLength(file.content), 0),
    0,
  );
  if (totalCandidateBytes > parsedBudgets.maximumTotalCandidateBytes) {
    throw new Error("TOTAL_CANDIDATE_BYTES_EXCEEDED");
  }
  const requiredAttempts = requirePositiveInteger(policy.requiredAttempts, "required_attempts");
  if (new Set(worlds.map((world) => world.id)).size !== worlds.length) {
    throw new TypeError("DUPLICATE_WORLD_ID");
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new TypeError("DUPLICATE_CANDIDATE_ID");
  }
  const executionCount = worlds.length * requiredAttempts * (candidates.length + 1);
  if (executionCount > parsedBudgets.maximumExecutions)
    throw new Error("EXECUTION_BUDGET_EXCEEDED");
  const environmentAllowlist = requireStringArray(
    isolation.environmentAllowlist,
    "environment_allowlist",
  );
  if (new Set(environmentAllowlist).size !== environmentAllowlist.length) {
    throw new TypeError("DUPLICATE_ENVIRONMENT_ALLOWLIST_ENTRY");
  }
  if (environmentAllowlist.some((key) => key.length === 0 || key.includes("="))) {
    throw new TypeError("INVALID_ENVIRONMENT_ALLOWLIST_ENTRY");
  }
  const reservedEnvironmentVariable = environmentAllowlist.find((key) => {
    const normalized = key.toUpperCase();
    return (
      normalized === "NODE_OPTIONS" ||
      normalized.startsWith("TESTFORGE_") ||
      normalized.startsWith("NODE_TEST_")
    );
  });
  if (reservedEnvironmentVariable !== undefined) {
    throw new Error("RESERVED_ENVIRONMENT_VARIABLE");
  }
  const minimumTargetWeightPermille = requireNonNegativeInteger(
    policy.minimumTargetWeightPermille,
    "minimum_target_weight_permille",
  );
  if (minimumTargetWeightPermille > 1_000) {
    throw new TypeError("INVALID_MINIMUM_TARGET_WEIGHT_PERMILLE");
  }
  const normalizedAdapter: VerificationRequest["adapter"] =
    adapter.kind === "node-test"
      ? (() => {
          const extraArguments = parseNodeTestExtraArguments(adapter.extraArguments);
          const baseTestFiles = requireStringArray(adapter.baseTestFiles, "base_test_files").map(
            (file) => assertSafeRelativePath(file, ["."]),
          );
          assertPortableStringCollection(baseTestFiles, "DUPLICATE_BASE_TEST_FILE");
          return {
            kind: "node-test" as const,
            executable: requireString(adapter.executable, "adapter_executable"),
            baseTestFiles,
            ...(extraArguments === undefined ? {} : { extraArguments }),
          };
        })()
      : {
          kind: "testforge-command",
          executable: requireString(adapter.executable, "adapter_executable"),
          arguments: requireStringArray(adapter.arguments, "adapter_arguments"),
          protocolVersion: "1.0.0",
        };
  return {
    schemaVersion: requireString(request.schemaVersion, "schema_version"),
    repository: {
      root: requireString(repository.root, "repository_root"),
      exclude: requireStringArray(repository.exclude, "repository_exclude"),
    },
    adapter: normalizedAdapter,
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist,
    },
    candidateRoots,
    budgets: parsedBudgets,
    policy: {
      policyVersion: requireString(policy.policyVersion, "policy_version"),
      requiredAttempts,
      minimumTargetWeightPermille,
      maximumSelectedCandidates: requireNonNegativeInteger(
        policy.maximumSelectedCandidates,
        "maximum_selected_candidates",
      ),
      acceptedTargetOutcomes: requireStringArray(
        policy.acceptedTargetOutcomes,
        "accepted_target_outcomes",
      ),
    },
    worlds,
    candidates,
  };
}

function environmentFromAllowlist(allowlist: string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function applyFiles(workspace: string, files: FileOverlay[]): Promise<void> {
  const sortedFiles = [...files].sort((left, right) => comparePortablePaths(left.path, right.path));
  for (const file of sortedFiles) {
    const segments = file.path.split("/");
    const target = path.join(workspace, ...segments);
    let cursor = workspace;
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("SYMLINK_OVERLAY_PATH");
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") break;
        throw error;
      }
    }
    await mkdir(path.dirname(target), { recursive: true });
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error("SYMLINK_OVERLAY_PATH");
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) throw error;
    }
    await writeFile(target, file.content, { flag: "w" });
  }
}

interface StructuredCommandReport {
  protocolVersion: "1.0.0";
  outcome: Observation["outcome"];
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  attributed: boolean;
}

interface NodeTestReport {
  protocolVersion: "1.0.0";
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  candidateFailureCount: number;
  nonCandidateFailureCount: number;
  candidateSyntaxFailureCount: number;
  candidateFailuresAllAssertions: boolean;
}

const STRUCTURED_OUTCOMES = new Set<Observation["outcome"]>([
  "PASS",
  "ASSERTION_FAILURE",
  "COLLECTION_FAILURE",
  "COMPILE_FAILURE",
  "PROCESS_CRASH",
  "TIMEOUT",
  "INFRA_ERROR",
  "NO_TEST_DISCOVERED",
]);

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseStructuredCommandReport(
  value: unknown,
  processResult: ProcessResult,
): StructuredCommandReport | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = [
    "attributed",
    "candidateTestsDiscovered",
    "outcome",
    "protocolVersion",
    "testsDiscovered",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) return undefined;
  if (value.protocolVersion !== "1.0.0") return undefined;
  if (
    typeof value.outcome !== "string" ||
    !STRUCTURED_OUTCOMES.has(value.outcome as Observation["outcome"])
  ) {
    return undefined;
  }
  if (
    !nonNegativeInteger(value.testsDiscovered) ||
    !nonNegativeInteger(value.candidateTestsDiscovered) ||
    value.candidateTestsDiscovered > value.testsDiscovered ||
    typeof value.attributed !== "boolean"
  ) {
    return undefined;
  }
  const attributableOutcome = value.outcome === "PASS" || value.outcome === "ASSERTION_FAILURE";
  if (value.attributed && (!attributableOutcome || value.candidateTestsDiscovered === 0)) {
    return undefined;
  }
  if (value.outcome === "TIMEOUT") return undefined;
  const pass = value.outcome === "PASS";
  if (
    (pass && processResult.exitCode !== 0) ||
    (!pass && (processResult.exitCode === null || processResult.exitCode === 0))
  ) {
    return undefined;
  }
  return {
    protocolVersion: "1.0.0",
    outcome: value.outcome as Observation["outcome"],
    testsDiscovered: value.testsDiscovered,
    candidateTestsDiscovered: value.candidateTestsDiscovered,
    attributed: value.attributed,
  };
}

function parseNodeTestReport(value: unknown): NodeTestReport | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = [
    "candidateFailureCount",
    "candidateFailuresAllAssertions",
    "candidateSyntaxFailureCount",
    "candidateTestsDiscovered",
    "nonCandidateFailureCount",
    "protocolVersion",
    "testsDiscovered",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) return undefined;
  if (value.protocolVersion !== "1.0.0") return undefined;
  if (
    !nonNegativeInteger(value.testsDiscovered) ||
    !nonNegativeInteger(value.candidateTestsDiscovered) ||
    value.candidateTestsDiscovered > value.testsDiscovered ||
    !nonNegativeInteger(value.candidateFailureCount) ||
    !nonNegativeInteger(value.nonCandidateFailureCount) ||
    !nonNegativeInteger(value.candidateSyntaxFailureCount) ||
    value.candidateSyntaxFailureCount > value.candidateFailureCount ||
    typeof value.candidateFailuresAllAssertions !== "boolean"
  ) {
    return undefined;
  }
  return {
    protocolVersion: "1.0.0",
    testsDiscovered: value.testsDiscovered,
    candidateTestsDiscovered: value.candidateTestsDiscovered,
    candidateFailureCount: value.candidateFailureCount,
    nonCandidateFailureCount: value.nonCandidateFailureCount,
    candidateSyntaxFailureCount: value.candidateSyntaxFailureCount,
    candidateFailuresAllAssertions: value.candidateFailuresAllAssertions,
  };
}

async function readBoundedJsonFile(resultFile: string, maximumBytes: number): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(resultFile, "r");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const chunk = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, null);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maximumBytes) return undefined;
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readStructuredCommandReport(
  resultFile: string,
  processResult: ProcessResult,
  maximumBytes: number,
): Promise<StructuredCommandReport | undefined> {
  if (processResult.outcome === "TIMEOUT" || processResult.outcome === "INFRA_ERROR") {
    return undefined;
  }
  return parseStructuredCommandReport(
    await readBoundedJsonFile(resultFile, maximumBytes),
    processResult,
  );
}

async function readNodeTestReport(
  resultFile: string,
  processResult: ProcessResult,
  maximumBytes: number,
): Promise<NodeTestReport | undefined> {
  if (processResult.outcome === "TIMEOUT" || processResult.outcome === "INFRA_ERROR") {
    return undefined;
  }
  return parseNodeTestReport(await readBoundedJsonFile(resultFile, maximumBytes));
}

interface NodeExecutableIdentity {
  requestedExecutable: string;
  resolvedExecutable: string;
  executableDigest: string;
  nodeVersion: string;
}

interface NodeProbeReport {
  execPath: string;
  nodeVersion: string;
}

async function sha256File(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return `${SHA256_PREFIX}${digest.digest("hex")}`;
}

function nodeVersionIsSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 15);
}

async function runNodeExecutableProbe(
  executable: string,
  repositoryRoot: string,
  environmentAllowlist: string[],
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<NodeProbeReport> {
  const result = await runProcess({
    executable,
    args: ["-p", "JSON.stringify({execPath:process.execPath,node:process.versions.node})"],
    cwd: repositoryRoot,
    environment: environmentFromAllowlist(environmentAllowlist),
    timeoutMs: Math.min(timeoutMs, 5_000),
    maximumOutputBytes: Math.min(maximumOutputBytes, CONTROLLED_REPORT_MAXIMUM_BYTES),
  });
  if (result.outcome !== "PASS" || result.stdout.truncated || result.stderr.totalBytes > 0) {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  let report: unknown;
  try {
    report = JSON.parse(result.stdout.text.trim()) as unknown;
  } catch {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (
    !isRecord(report) ||
    Object.keys(report).sort().join("\0") !== "execPath\0node" ||
    typeof report.execPath !== "string" ||
    report.execPath.length === 0 ||
    typeof report.node !== "string"
  ) {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (!nodeVersionIsSupported(report.node)) throw new Error("NODE_TEST_VERSION_UNSUPPORTED");
  return { execPath: report.execPath, nodeVersion: report.node };
}

async function probeNodeTestExecutable(
  requestedExecutable: string,
  repositoryRoot: string,
  environmentAllowlist: string[],
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<NodeExecutableIdentity> {
  const firstProbe = await runNodeExecutableProbe(
    requestedExecutable,
    repositoryRoot,
    environmentAllowlist,
    timeoutMs,
    maximumOutputBytes,
  );
  let resolvedExecutable: string;
  try {
    resolvedExecutable = await realpath(firstProbe.execPath);
    if (!(await stat(resolvedExecutable)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  const secondProbe = await runNodeExecutableProbe(
    resolvedExecutable,
    repositoryRoot,
    environmentAllowlist,
    timeoutMs,
    maximumOutputBytes,
  );
  let secondResolvedExecutable: string;
  try {
    secondResolvedExecutable = await realpath(secondProbe.execPath);
  } catch {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (
    secondResolvedExecutable !== resolvedExecutable ||
    secondProbe.nodeVersion !== firstProbe.nodeVersion
  ) {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  return {
    requestedExecutable,
    resolvedExecutable,
    executableDigest: await sha256File(resolvedExecutable),
    nodeVersion: secondProbe.nodeVersion,
  };
}

function classifyNodeTest(
  result: ProcessResult,
  report: NodeTestReport | undefined,
  hasCandidate: boolean,
): { outcome: Observation["outcome"]; attributed: boolean } {
  if (result.outcome === "TIMEOUT") return { outcome: "TIMEOUT", attributed: false };
  return normalizeRuntimeFacts({
    factsVersion: RUNTIME_FACTS_VERSION,
    reportValid: result.outcome !== "INFRA_ERROR" && report !== undefined,
    hasCandidate,
    processExitedZero: result.exitCode === 0,
    candidateTestsDiscovered: report?.candidateTestsDiscovered ?? 0,
    nonCandidateFailureCount: report?.nonCandidateFailureCount ?? 0,
    candidateCollectionFailureCount: 0,
    candidateCompileFailureCount: report?.candidateSyntaxFailureCount ?? 0,
    candidateFailureCount: report?.candidateFailureCount ?? 0,
    candidateFailuresAllAssertions: report?.candidateFailuresAllAssertions ?? false,
  });
}

async function copyRepository(
  source: string,
  destination: string,
  excludes: ReadonlySet<string>,
): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (sourcePath) => {
      if (sourcePath === source) return true;
      const relative = path.relative(source, sourcePath);
      if (relative.split(path.sep).some((segment) => excludes.has(portablePathKey(segment)))) {
        return false;
      }
      if ((await lstat(sourcePath)).isSymbolicLink()) {
        throw new Error("UNSUPPORTED_REPOSITORY_SYMLINK");
      }
      return true;
    },
  });
}

async function executeObservation(
  request: VerificationRequest,
  repositoryRoot: string,
  world: World,
  candidate: Candidate | null,
  attempt: number,
  nodeTestReporterPath: string | undefined,
): Promise<Observation> {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "testforge-run-")));
  const workspace = path.join(temporaryRoot, "repository");
  try {
    await copyRepository(repositoryRoot, workspace, effectiveExcludes(request.repository.exclude));
    await applyFiles(workspace, world.files);
    if (candidate) await applyFiles(workspace, candidate.files);
    const candidateFiles = candidate ? candidate.files.map((file) => file.path) : [];
    const resultFile = path.join(temporaryRoot, "structured-command-result.json");
    const environment = environmentFromAllowlist(request.isolation.environmentAllowlist);
    if (request.adapter.kind === "testforge-command") {
      environment.TESTFORGE_RESULT_FILE = resultFile;
      environment.TESTFORGE_CANDIDATE_FILES = JSON.stringify(candidateFiles);
    } else {
      if (nodeTestReporterPath === undefined) throw new Error("NODE_TEST_REPORTER_MISSING");
      environment.TESTFORGE_NODE_CANDIDATE_FILES = JSON.stringify(
        candidateFiles.map((file) => path.resolve(workspace, ...file.split("/"))),
      );
    }
    const args =
      request.adapter.kind === "node-test"
        ? [
            "--test",
            `--test-reporter=${pathToFileURL(nodeTestReporterPath as string).href}`,
            `--test-reporter-destination=${resultFile}`,
            ...(request.adapter.extraArguments ?? []),
            "--",
            ...request.adapter.baseTestFiles,
            ...candidateFiles,
          ]
        : request.adapter.arguments;
    const result = await runProcess({
      executable: request.adapter.executable,
      args,
      cwd: workspace,
      environment,
      timeoutMs: request.budgets.timeoutMsPerExecution,
      maximumOutputBytes: request.budgets.maximumOutputBytes,
    });
    const structuredReport =
      request.adapter.kind === "testforge-command"
        ? await readStructuredCommandReport(resultFile, result, CONTROLLED_REPORT_MAXIMUM_BYTES)
        : undefined;
    const nodeTestReport =
      request.adapter.kind === "node-test"
        ? await readNodeTestReport(resultFile, result, CONTROLLED_REPORT_MAXIMUM_BYTES)
        : undefined;
    const nodeClassification =
      request.adapter.kind === "node-test"
        ? classifyNodeTest(result, nodeTestReport, candidate !== null)
        : undefined;
    const outcome: Observation["outcome"] =
      nodeClassification?.outcome ??
      (result.outcome === "TIMEOUT" ? "TIMEOUT" : (structuredReport?.outcome ?? "INFRA_ERROR"));
    return {
      runId: `${candidate?.id ?? "control"}:${world.id}:${attempt}`,
      candidateId: candidate?.id ?? null,
      worldId: world.id,
      attempt,
      outcome,
      testsDiscovered:
        request.adapter.kind === "node-test"
          ? (nodeTestReport?.testsDiscovered ?? 0)
          : (structuredReport?.testsDiscovered ?? 0),
      candidateTestsDiscovered:
        request.adapter.kind === "node-test"
          ? (nodeTestReport?.candidateTestsDiscovered ?? 0)
          : (structuredReport?.candidateTestsDiscovered ?? 0),
      attributed: nodeClassification?.attributed ?? structuredReport?.attributed ?? false,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stdoutDigest: result.stdout.digest,
      stderrDigest: result.stderr.digest,
    };
  } finally {
    await removeTemporaryDirectory(temporaryRoot);
  }
}

export async function verifyCampaign(value: unknown): Promise<unknown> {
  const request = parseRequest(value);
  const repositoryRoot = await resolveRepositoryRoot(request.repository.root);
  const excludes = effectiveExcludes(request.repository.exclude);
  const sourceInventory = await walkFiles(repositoryRoot, excludes);
  if (sourceInventory.files.length > request.budgets.maximumRepositoryFiles) {
    throw new Error("REPOSITORY_FILE_BUDGET_EXCEEDED");
  }
  if (sourceInventory.totalBytes > request.budgets.maximumRepositoryBytes) {
    throw new Error("REPOSITORY_BYTES_BUDGET_EXCEEDED");
  }
  const nodeIdentity =
    request.adapter.kind === "node-test"
      ? await probeNodeTestExecutable(
          request.adapter.executable,
          repositoryRoot,
          request.isolation.environmentAllowlist,
          request.budgets.timeoutMsPerExecution,
          request.budgets.maximumOutputBytes,
        )
      : undefined;
  if (request.adapter.kind === "node-test" && nodeIdentity !== undefined) {
    request.adapter.executable = nodeIdentity.resolvedExecutable;
  }
  const nodeRuntimePreflight: NodeTestRuntimePreflight | undefined =
    request.adapter.kind === "node-test" && nodeIdentity !== undefined
      ? await runNodeTestRuntimePreflight({
          executable: nodeIdentity.resolvedExecutable,
          reporterSource: NODE_TEST_REPORTER_SOURCE,
          environment: environmentFromAllowlist(request.isolation.environmentAllowlist),
          timeoutMs: request.budgets.timeoutMsPerExecution,
          maximumOutputBytes: request.budgets.maximumOutputBytes,
          processRunner: runProcess,
        })
      : undefined;
  const campaignRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "testforge-campaign-")));
  const repositorySnapshot = path.join(campaignRoot, "repository");
  try {
    await copyRepository(repositoryRoot, repositorySnapshot, excludes);
    const snapshotInventory = await walkFiles(repositorySnapshot, excludes);
    if (snapshotInventory.files.length > request.budgets.maximumRepositoryFiles) {
      throw new Error("REPOSITORY_FILE_BUDGET_EXCEEDED");
    }
    if (snapshotInventory.totalBytes > request.budgets.maximumRepositoryBytes) {
      throw new Error("REPOSITORY_BYTES_BUDGET_EXCEEDED");
    }
    const inputPaths = [
      ...request.worlds.flatMap((world) => world.files.map((file) => file.path)),
      ...request.candidates.flatMap((candidate) => candidate.files.map((file) => file.path)),
      ...(request.adapter.kind === "node-test" ? request.adapter.baseTestFiles : []),
      ...request.candidateRoots,
    ];
    for (const inputPath of inputPaths) {
      const segments = inputPath.split("/");
      for (let length = 1; length <= segments.length; length += 1) {
        const spelling = segments.slice(0, length).join("/");
        const inventorySpelling = snapshotInventory.spellings.get(portablePathKey(spelling));
        if (inventorySpelling !== undefined && inventorySpelling !== spelling) {
          throw new Error("PORTABLE_PATH_COLLISION");
        }
      }
    }
    const nodeTestReporterPath =
      request.adapter.kind === "node-test"
        ? path.join(campaignRoot, "node-test-reporter.mjs")
        : undefined;
    if (nodeTestReporterPath !== undefined) {
      await writeFile(nodeTestReporterPath, NODE_TEST_REPORTER_SOURCE, { flag: "wx" });
    }
    const analysis = (await analyzeRepository(repositorySnapshot)) as { repositoryDigest: string };
    const observations: Observation[] = [];

    for (const world of request.worlds) {
      for (let attempt = 1; attempt <= request.policy.requiredAttempts; attempt += 1) {
        observations.push(
          await executeObservation(
            request,
            repositorySnapshot,
            world,
            null,
            attempt,
            nodeTestReporterPath,
          ),
        );
      }
    }
    for (const candidate of request.candidates) {
      for (const world of request.worlds) {
        for (let attempt = 1; attempt <= request.policy.requiredAttempts; attempt += 1) {
          observations.push(
            await executeObservation(
              request,
              repositorySnapshot,
              world,
              candidate,
              attempt,
              nodeTestReporterPath,
            ),
          );
        }
      }
    }

    const evidence = {
      schemaVersion: request.schemaVersion,
      repositoryDigest: analysis.repositoryDigest,
      evidenceContext: {
        engine: { name: "testforge", version: "0.1.0" },
        adapter: {
          name: request.adapter.kind,
          version:
            request.adapter.kind === "testforge-command"
              ? request.adapter.protocolVersion
              : (nodeIdentity?.nodeVersion ?? "unprobed"),
          configuration:
            request.adapter.kind === "node-test" && nodeIdentity !== undefined
              ? {
                  kind: "node-test",
                  profile: {
                    profileId: NODE_TEST_ADAPTER_PROFILE.profileId,
                    profileVersion: NODE_TEST_ADAPTER_PROFILE.profileVersion,
                    official: NODE_TEST_ADAPTER_PROFILE.official,
                    capabilities: NODE_TEST_ADAPTER_PROFILE.capabilities,
                    reporterDigest: NODE_TEST_ADAPTER_PROFILE.reporterDigest,
                  },
                  requestedExecutable: nodeIdentity.requestedExecutable,
                  resolvedExecutable: nodeIdentity.resolvedExecutable,
                  executableDigest: nodeIdentity.executableDigest,
                  nodeVersion: nodeIdentity.nodeVersion,
                  runtimePreflight: nodeRuntimePreflight,
                  arguments: [
                    "--test",
                    ...(request.adapter.extraArguments ?? []),
                    "--",
                    ...request.adapter.baseTestFiles,
                  ],
                }
              : request.adapter,
        },
        execution: {
          isolation: "UNSANDBOXED",
          environmentAllowlist: request.isolation.environmentAllowlist,
          budgets: request.budgets,
          candidateRoots: request.candidateRoots,
        },
        worlds: request.worlds.map((world) => ({
          id: world.id,
          provenance: world.provenance ?? "unspecified",
          digest: sha256Canonical({
            files: world.files,
            provenance: world.provenance ?? null,
          }),
        })),
      },
      policy: request.policy,
      worlds: request.worlds.map(({ files: _files, provenance: _provenance, ...world }) => world),
      candidates: request.candidates.map((candidate) => ({
        id: candidate.id,
        digest: sha256Canonical(candidate.files),
        sizeBytes: candidate.files.reduce(
          (total, file) => total + Buffer.byteLength(file.content),
          0,
        ),
      })),
      observations,
    };
    const manifest = decideEvidence(evidence);
    const finalManifest = {
      ...manifest,
      adapter:
        request.adapter.kind === "testforge-command"
          ? { kind: request.adapter.kind, protocolVersion: request.adapter.protocolVersion }
          : { kind: request.adapter.kind },
      isolation: {
        kind: "trusted-local",
        level: "UNSANDBOXED",
        acknowledgedUnsafeExecution: true,
      },
      limitations: [
        "UNSANDBOXED trusted-local execution cannot safely contain hostile candidate code.",
        "Process-tree termination is best effort and depends on host operating-system facilities.",
      ],
    };
    return sealManifestArtifact(finalManifest);
  } finally {
    await removeTemporaryDirectory(campaignRoot);
  }
}

interface BenchmarkPhaseReport {
  outcome: Observation["outcome"];
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  attributed: boolean;
  phases:
    | [
        { phase: "STARTUP"; durationUs: number },
        { phase: "COMPILE_OR_COLLECTION"; durationUs: number },
        { phase: "EXECUTION"; durationUs: number },
      ]
    | null;
  cpuTimeUs: number | null;
}

function parseBenchmarkPhaseReport(value: unknown): BenchmarkPhaseReport | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = [
    "attributed",
    "candidateTestsDiscovered",
    "cpuTimeUs",
    "outcome",
    "phases",
    "protocolVersion",
    "testsDiscovered",
  ];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) return undefined;
  if (
    value.protocolVersion !== "1.0.0" ||
    typeof value.outcome !== "string" ||
    !STRUCTURED_OUTCOMES.has(value.outcome as Observation["outcome"]) ||
    !nonNegativeInteger(value.testsDiscovered) ||
    !nonNegativeInteger(value.candidateTestsDiscovered) ||
    value.candidateTestsDiscovered > value.testsDiscovered ||
    typeof value.attributed !== "boolean" ||
    !(value.cpuTimeUs === null || nonNegativeInteger(value.cpuTimeUs))
  ) {
    return undefined;
  }
  if (value.outcome !== "PASS") {
    if (value.phases !== null || value.cpuTimeUs !== null) return undefined;
    return {
      outcome: value.outcome as Observation["outcome"],
      testsDiscovered: value.testsDiscovered,
      candidateTestsDiscovered: value.candidateTestsDiscovered,
      attributed: value.attributed,
      phases: null,
      cpuTimeUs: null,
    };
  }
  if (
    value.candidateTestsDiscovered < 1 ||
    value.attributed !== true ||
    !Array.isArray(value.phases) ||
    value.phases.length !== 3
  ) {
    return undefined;
  }
  const expectedPhases = ["STARTUP", "COMPILE_OR_COLLECTION", "EXECUTION"] as const;
  const phases: Array<{ phase: (typeof expectedPhases)[number]; durationUs: number }> = [];
  for (const [index, rawPhase] of value.phases.entries()) {
    if (
      !isRecord(rawPhase) ||
      Object.keys(rawPhase).sort().join("\0") !== "durationUs\0phase" ||
      rawPhase.phase !== expectedPhases[index] ||
      !nonNegativeInteger(rawPhase.durationUs)
    ) {
      return undefined;
    }
    phases.push({
      phase: expectedPhases[index] as (typeof expectedPhases)[number],
      durationUs: rawPhase.durationUs,
    });
  }
  return {
    outcome: "PASS",
    testsDiscovered: value.testsDiscovered,
    candidateTestsDiscovered: value.candidateTestsDiscovered,
    attributed: true,
    phases: phases as BenchmarkPhaseReport["phases"],
    cpuTimeUs: value.cpuTimeUs,
  };
}

function benchmarkFailureOutcome(
  processResult: ProcessResult,
  report: BenchmarkPhaseReport | undefined,
): Exclude<Observation["outcome"], "PASS"> {
  if (processResult.outcome === "TIMEOUT") return "TIMEOUT";
  if (processResult.outcome === "INFRA_ERROR") return "INFRA_ERROR";
  if (report !== undefined && report.outcome !== "PASS") {
    return processResult.exitCode === 0 ? "INFRA_ERROR" : report.outcome;
  }
  return processResult.exitCode === 0 ? "INFRA_ERROR" : "PROCESS_CRASH";
}

function elapsedMicroseconds(start: bigint): number | undefined {
  const elapsed = (process.hrtime.bigint() - start) / 1_000n;
  return elapsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(elapsed) : undefined;
}

async function executeBenchmarkMeasurement(
  request: AgenticBenchmarkAcquisitionRequest,
  snapshotRoot: string,
  referenceWorld: World,
  candidate: Candidate,
  candidateDigest: string,
  cacheDirectory: string,
  regime: "COLD" | "WARM",
  role: "WARMUP" | "MEASUREMENT",
  ordinal: number,
): Promise<AgenticBenchmarkRun> {
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "testforge-benchmark-run-")),
  );
  const workspace = path.join(temporaryRoot, "repository");
  const resultFile = path.join(temporaryRoot, "benchmark-result.json");
  const preparationStartedAt = process.hrtime.bigint();
  let preparationUs: number | undefined;
  try {
    await copyRepository(
      snapshotRoot,
      workspace,
      effectiveExcludes(request.verificationRequest.repository.exclude),
    );
    await applyFiles(workspace, referenceWorld.files);
    await applyFiles(workspace, candidate.files);
    preparationUs = elapsedMicroseconds(preparationStartedAt);

    const environment = environmentFromAllowlist(
      request.verificationRequest.isolation.environmentAllowlist,
    );
    environment.TESTFORGE_BENCHMARK_RESULT_FILE = resultFile;
    environment.TESTFORGE_CANDIDATE_FILES = JSON.stringify(
      candidate.files.map((file) => file.path),
    );
    environment.TESTFORGE_BENCHMARK_CACHE_DIR = cacheDirectory;
    environment.TESTFORGE_BENCHMARK_REGIME = regime;
    environment.TESTFORGE_BENCHMARK_ROLE = role;
    environment.TESTFORGE_BENCHMARK_ORDINAL = String(ordinal);

    const adapter = request.verificationRequest.adapter;
    if (adapter.kind !== "testforge-command") {
      throw new Error("BENCHMARK_PHASE_ACQUISITION_UNSUPPORTED_NODE_TEST");
    }
    const processResult = await runProcess({
      executable: adapter.executable,
      args: adapter.arguments,
      cwd: workspace,
      environment,
      timeoutMs: request.verificationRequest.budgets.timeoutMsPerExecution,
      maximumOutputBytes: request.verificationRequest.budgets.maximumOutputBytes,
    });
    const phaseReport = parseBenchmarkPhaseReport(
      await readBoundedJsonFile(resultFile, CONTROLLED_REPORT_MAXIMUM_BYTES),
    );
    const common = { candidateId: candidate.id, candidateDigest, regime, role, ordinal };
    if (
      processResult.outcome !== "PASS" ||
      processResult.exitCode !== 0 ||
      phaseReport?.outcome !== "PASS" ||
      phaseReport.phases === null ||
      preparationUs === undefined
    ) {
      return {
        ...common,
        status: "INCOMPLETE",
        outcome: benchmarkFailureOutcome(processResult, phaseReport),
        phases: null,
        totalUs: null,
        cpuTimeUs: null,
      };
    }
    const phases = [
      { phase: "PREPARATION" as const, durationUs: preparationUs },
      ...phaseReport.phases,
    ];
    const totalUs = phases.reduce((total, phase) => total + phase.durationUs, 0);
    if (!Number.isSafeInteger(totalUs)) {
      return {
        ...common,
        status: "INCOMPLETE",
        outcome: "INFRA_ERROR",
        phases: null,
        totalUs: null,
        cpuTimeUs: null,
      };
    }
    return {
      ...common,
      status: "COMPLETE",
      outcome: "PASS",
      phases,
      totalUs,
      ...(phaseReport.cpuTimeUs === null ? {} : { cpuTimeUs: phaseReport.cpuTimeUs }),
    };
  } finally {
    await removeTemporaryDirectory(temporaryRoot);
  }
}

async function resolveSnapshotIdentityFile(
  snapshotRoot: string,
  inputPath: string,
): Promise<string> {
  const safePath = assertSafeRelativePath(inputPath, ["."]);
  const target = path.join(snapshotRoot, ...safePath.split("/"));
  const resolved = await realpath(target);
  const relative = path.relative(snapshotRoot, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !(await stat(resolved)).isFile()
  ) {
    throw new Error("AGENTIC_BENCHMARK_ACQUISITION_IDENTITY_INVALID");
  }
  return resolved;
}

function acquisitionResultProjection(
  result: Omit<AgenticBenchmarkAcquisitionResult, "resultDigest">,
): Omit<AgenticBenchmarkAcquisitionResult, "resultDigest"> {
  return result;
}

function assertAcquisitionIdentityIsolation(request: AgenticBenchmarkAcquisitionRequest): void {
  const identityPaths = [
    request.identityFiles.phaseReporter,
    ...request.identityFiles.dependencyGraph,
  ].map((identityPath) => assertSafeRelativePath(identityPath, ["."]));
  const identityKeys = identityPaths.map(portablePathKey);
  if (new Set(identityKeys).size !== identityKeys.length) {
    throw new Error("AGENTIC_BENCHMARK_ACQUISITION_IDENTITY_INVALID");
  }
  const overlayPaths = request.verificationRequest.worlds
    .flatMap((world) => world.files)
    .concat(request.verificationRequest.candidates.flatMap((candidate) => candidate.files))
    .map((file) => portablePathKey(file.path));
  for (const identityKey of identityKeys) {
    if (
      overlayPaths.some(
        (overlayKey) =>
          overlayKey === identityKey ||
          overlayKey.startsWith(`${identityKey}/`) ||
          identityKey.startsWith(`${overlayKey}/`),
      )
    ) {
      throw new Error("AGENTIC_BENCHMARK_ACQUISITION_IDENTITY_OVERLAY_FORBIDDEN");
    }
  }
}

export function benchmarkCacheDirectoryKey(
  _candidateId: string,
  candidateOrdinal: number,
  regime: "COLD" | "WARM",
  runOrdinal: number,
): string {
  const subject = `subject-${String(candidateOrdinal).padStart(6, "0")}`;
  return regime === "COLD"
    ? `${subject}-cold-${String(runOrdinal).padStart(6, "0")}`
    : `${subject}-warm`;
}

export async function acquireAgenticBenchmark(
  value: unknown,
): Promise<AgenticBenchmarkAcquisitionResult> {
  const request = parseAgenticBenchmarkAcquisitionRequest(value);
  assertAcquisitionIdentityIsolation(request);
  if (request.verificationRequest.adapter.kind !== "testforge-command") {
    throw new Error("BENCHMARK_PHASE_ACQUISITION_UNSUPPORTED_NODE_TEST");
  }
  const requestDigest = sha256Canonical(request);
  const repositoryRoot = await resolveRepositoryRoot(request.verificationRequest.repository.root);
  const excludes = effectiveExcludes(request.verificationRequest.repository.exclude);
  const sourceInventory = await walkFiles(repositoryRoot, excludes);
  if (sourceInventory.files.length > request.verificationRequest.budgets.maximumRepositoryFiles) {
    throw new Error("REPOSITORY_FILE_BUDGET_EXCEEDED");
  }
  if (sourceInventory.totalBytes > request.verificationRequest.budgets.maximumRepositoryBytes) {
    throw new Error("REPOSITORY_BYTES_BUDGET_EXCEEDED");
  }
  const acquisitionRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "testforge-benchmark-acquisition-")),
  );
  const snapshotRoot = path.join(acquisitionRoot, "repository");
  try {
    await copyRepository(repositoryRoot, snapshotRoot, excludes);
    const initialAnalysis = (await analyzeRepository(snapshotRoot)) as { repositoryDigest: string };
    const phaseReporterFile = await resolveSnapshotIdentityFile(
      snapshotRoot,
      request.identityFiles.phaseReporter,
    );
    const dependencyFiles = await Promise.all(
      request.identityFiles.dependencyGraph.map(async (dependencyPath) => ({
        path: dependencyPath,
        digest: await sha256File(await resolveSnapshotIdentityFile(snapshotRoot, dependencyPath)),
      })),
    );
    const resolvedExecutable = await realpath(request.verificationRequest.adapter.executable);
    if (!(await stat(resolvedExecutable)).isFile()) {
      throw new Error("AGENTIC_BENCHMARK_ACQUISITION_EXECUTABLE_INVALID");
    }
    const executableDigest = await sha256File(resolvedExecutable);
    const identityDigest = await sha256File(phaseReporterFile);
    const dependencyGraphDigest = sha256Canonical(dependencyFiles);
    const adapterArguments = [...request.verificationRequest.adapter.arguments];
    const baseContext = {
      snapshotRepositoryDigest: initialAnalysis.repositoryDigest,
      referenceWorldId: request.referenceWorldId,
      candidateIds: [] as string[],
      adapter: {
        executable: resolvedExecutable,
        arguments: adapterArguments,
        executableDigest,
        identityFilePath: request.identityFiles.phaseReporter,
        identityDigest,
      },
      dependencyFiles,
      dependencyGraphDigest,
      cachePolicy: {
        cold: "UNIQUE_EMPTY_DIRECTORY_PER_RUN" as const,
        warm: "ONE_INITIALLY_EMPTY_DIRECTORY_PER_CANDIDATE" as const,
        sharedAcrossCandidates: false as const,
      },
    };

    const sourceManifest = parseEvidenceManifest(
      await verifyCampaign({
        ...request.verificationRequest,
        repository: { ...request.verificationRequest.repository, root: snapshotRoot },
        adapter: { ...request.verificationRequest.adapter, executable: resolvedExecutable },
      }),
    );
    const postVerificationAnalysis = (await analyzeRepository(snapshotRoot)) as {
      repositoryDigest: string;
    };
    if (postVerificationAnalysis.repositoryDigest !== initialAnalysis.repositoryDigest) {
      throw new Error("AGENTIC_BENCHMARK_ACQUISITION_SNAPSHOT_DRIFT");
    }
    const sourceReplay = replayEvidenceManifest(sourceManifest);
    if (!sourceReplay.valid || sourceManifest.decision.status !== "VERIFIED") {
      const base = {
        schemaVersion: "1.0.0" as const,
        requestDigest,
        status: "SOURCE_NOT_VERIFIED" as const,
        reasonCodes: [sourceReplay.valid ? "SOURCE_NOT_VERIFIED" : "SOURCE_REPLAY_INVALID"],
        sourceManifest,
        benchmarkArtifact: null,
        acquisitionContext: baseContext,
        limitations: [
          "No benchmark process runs unless the fresh source campaign is VERIFIED and replay-valid.",
        ],
      };
      return parseAgenticBenchmarkAcquisitionResult({
        ...base,
        resultDigest: sha256Canonical(acquisitionResultProjection(base)),
      });
    }

    const referenceWorld = request.verificationRequest.worlds.find(
      (world) =>
        world.id === request.referenceWorldId && world.kind === "REFERENCE" && world.required,
    ) as World | undefined;
    if (referenceWorld === undefined) {
      throw new Error("AGENTIC_BENCHMARK_ACQUISITION_REFERENCE_INVALID");
    }
    const selectedCandidates = sourceManifest.decision.selectedCandidateIds.map((id) => {
      const assessment = sourceManifest.candidates.find(
        (candidate) => candidate.id === id && candidate.status === "ELIGIBLE",
      );
      const candidate = request.verificationRequest.candidates.find((item) => item.id === id);
      if (assessment === undefined || candidate === undefined) {
        throw new Error("AGENTIC_BENCHMARK_ACQUISITION_SOURCE_BINDING_INVALID");
      }
      return { candidate: candidate as Candidate, digest: assessment.digest };
    });
    const context = {
      ...baseContext,
      candidateIds: selectedCandidates.map(({ candidate }) => candidate.id),
    };
    const cacheRoot = path.join(acquisitionRoot, "cache");
    await mkdir(cacheRoot, { recursive: false });
    const runs: AgenticBenchmarkRun[] = [];
    for (const [candidateIndex, { candidate, digest }] of selectedCandidates.entries()) {
      for (let ordinal = 1; ordinal <= request.policy.coldMeasuredSamples; ordinal += 1) {
        const cacheDirectory = path.join(
          cacheRoot,
          benchmarkCacheDirectoryKey(candidate.id, candidateIndex + 1, "COLD", ordinal),
        );
        await mkdir(cacheDirectory, { recursive: false });
        runs.push(
          await executeBenchmarkMeasurement(
            request,
            snapshotRoot,
            referenceWorld,
            candidate,
            digest,
            cacheDirectory,
            "COLD",
            "MEASUREMENT",
            ordinal,
          ),
        );
      }
      const warmCacheDirectory = path.join(
        cacheRoot,
        benchmarkCacheDirectoryKey(candidate.id, candidateIndex + 1, "WARM", 1),
      );
      await mkdir(warmCacheDirectory, { recursive: false });
      for (let ordinal = 1; ordinal <= request.policy.warmupSamples; ordinal += 1) {
        runs.push(
          await executeBenchmarkMeasurement(
            request,
            snapshotRoot,
            referenceWorld,
            candidate,
            digest,
            warmCacheDirectory,
            "WARM",
            "WARMUP",
            ordinal,
          ),
        );
      }
      for (let ordinal = 1; ordinal <= request.policy.warmMeasuredSamples; ordinal += 1) {
        runs.push(
          await executeBenchmarkMeasurement(
            request,
            snapshotRoot,
            referenceWorld,
            candidate,
            digest,
            warmCacheDirectory,
            "WARM",
            "MEASUREMENT",
            ordinal,
          ),
        );
      }
    }
    const finalAnalysis = (await analyzeRepository(snapshotRoot)) as { repositoryDigest: string };
    if (finalAnalysis.repositoryDigest !== initialAnalysis.repositoryDigest) {
      throw new Error("AGENTIC_BENCHMARK_ACQUISITION_SNAPSHOT_DRIFT");
    }
    const cpus = os.cpus();
    const benchmarkArtifact = createAgenticBenchmark({
      schemaVersion: "1.0.0",
      sourceManifest,
      referenceWorldId: request.referenceWorldId,
      policy: request.policy,
      protocol: request.protocol,
      fingerprint: {
        environmentId: request.environment.environmentId,
        os: { platform: os.platform(), release: os.release(), arch: os.arch() },
        cpu: {
          arch: os.arch(),
          model: cpus[0]?.model ?? "unknown",
          logicalCores: Math.max(1, cpus.length),
        },
        logicalCpuLimit: request.environment.logicalCpuLimit,
        memoryLimitBytes: request.environment.memoryLimitBytes,
        executionBoundary: "UNSANDBOXED",
        tools: [
          {
            role: "phase-adapter",
            name: "testforge-command",
            version: request.verificationRequest.adapter.protocolVersion,
            digest: executableDigest,
            configurationDigest: sha256Canonical({
              arguments: adapterArguments,
              identityFilePath: request.identityFiles.phaseReporter,
              identityDigest,
            }),
          },
        ],
        dependencyGraphDigest,
        phaseReporterDigest: identityDigest,
      },
      runs,
    });
    if (!replayAgenticBenchmark(benchmarkArtifact).valid) {
      throw new Error("AGENTIC_BENCHMARK_ACQUISITION_REPLAY_FAILED");
    }
    const summaryStatuses = benchmarkArtifact.summaries.map((summary) => summary.status);
    const status = summaryStatuses.some((status) => status === "OBSERVED_RUN_FAILURE")
      ? ("OBSERVED_RUN_FAILURE" as const)
      : summaryStatuses.some((status) => status === "INSUFFICIENT_SAMPLES")
        ? ("INSUFFICIENT_SAMPLES" as const)
        : ("COMPLETE" as const);
    const base = {
      schemaVersion: "1.0.0" as const,
      requestDigest,
      status,
      reasonCodes: [status === "COMPLETE" ? "ACQUISITION_COMPLETE" : status],
      sourceManifest,
      benchmarkArtifact,
      acquisitionContext: context,
      limitations: [
        "The phase adapter is part of the trusted computing base and its declarations are not independently authenticated.",
        "STARTUP is adapter-observed initialization and excludes operating-system process spawn latency.",
        "A benchmark cache directory is provided, but the adapter may ignore it.",
        "Benchmark timing outcomes never alter the embedded source VERIFIED decision or its digests.",
      ],
    };
    return parseAgenticBenchmarkAcquisitionResult({
      ...base,
      resultDigest: sha256Canonical(acquisitionResultProjection(base)),
    });
  } finally {
    await removeTemporaryDirectory(acquisitionRoot);
  }
}
