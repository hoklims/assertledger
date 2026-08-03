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
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseVerificationRequest } from "../contracts/index.js";
import {
  assertSafeRelativePath,
  decideEvidence,
  portablePathKey,
  sealManifestArtifact,
  sha256Canonical,
} from "../core/index.js";
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
    if (/node:test/.test(text)) frameworks.add("node:test");
    if (/\b(vitest|@vitest)\b/.test(text)) frameworks.add("vitest");
    if (/\b(jest|@jest)\b/.test(text)) frameworks.add("jest");
    if (/\bpytest\b/.test(text)) frameworks.add("pytest");
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
): Promise<NodeProbeReport> {
  const result = await runProcess({
    executable,
    args: ["-p", "JSON.stringify({execPath:process.execPath,node:process.versions.node})"],
    cwd: repositoryRoot,
    environment: environmentFromAllowlist(environmentAllowlist),
    timeoutMs: Math.min(timeoutMs, 5_000),
    maximumOutputBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
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
): Promise<NodeExecutableIdentity> {
  const firstProbe = await runNodeExecutableProbe(
    requestedExecutable,
    repositoryRoot,
    environmentAllowlist,
    timeoutMs,
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
): Observation["outcome"] {
  if (result.outcome === "TIMEOUT") return "TIMEOUT";
  if (result.outcome === "INFRA_ERROR" || !report) return "INFRA_ERROR";
  if (!hasCandidate) {
    return result.exitCode === 0 && report.nonCandidateFailureCount === 0
      ? "PASS"
      : "PROCESS_CRASH";
  }
  if (report.candidateTestsDiscovered === 0) {
    if (report.candidateSyntaxFailureCount > 0) return "COMPILE_FAILURE";
    return report.candidateFailureCount > 0 ||
      report.nonCandidateFailureCount > 0 ||
      result.exitCode !== 0
      ? "PROCESS_CRASH"
      : "NO_TEST_DISCOVERED";
  }
  if (report.nonCandidateFailureCount > 0) return "PROCESS_CRASH";
  if (report.candidateFailureCount > 0) {
    if (report.candidateSyntaxFailureCount > 0) return "COMPILE_FAILURE";
    return report.candidateFailuresAllAssertions ? "ASSERTION_FAILURE" : "PROCESS_CRASH";
  }
  return result.exitCode === 0 ? "PASS" : "PROCESS_CRASH";
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
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "testforge-run-"));
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
    const outcome: Observation["outcome"] =
      request.adapter.kind === "node-test"
        ? classifyNodeTest(result, nodeTestReport, candidate !== null)
        : result.outcome === "TIMEOUT"
          ? "TIMEOUT"
          : (structuredReport?.outcome ?? "INFRA_ERROR");
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
      attributed:
        request.adapter.kind === "node-test"
          ? candidate !== null &&
            nodeTestReport !== undefined &&
            nodeTestReport.candidateTestsDiscovered > 0 &&
            nodeTestReport.nonCandidateFailureCount === 0 &&
            (outcome === "PASS" || outcome === "ASSERTION_FAILURE")
          : (structuredReport?.attributed ?? false),
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
  const nodeIdentity =
    request.adapter.kind === "node-test"
      ? await probeNodeTestExecutable(
          request.adapter.executable,
          repositoryRoot,
          request.isolation.environmentAllowlist,
          request.budgets.timeoutMsPerExecution,
        )
      : undefined;
  if (request.adapter.kind === "node-test" && nodeIdentity !== undefined) {
    request.adapter.executable = nodeIdentity.resolvedExecutable;
  }
  const campaignRoot = await mkdtemp(path.join(os.tmpdir(), "testforge-campaign-"));
  const repositorySnapshot = path.join(campaignRoot, "repository");
  try {
    const excludes = effectiveExcludes(request.repository.exclude);
    const sourceInventory = await walkFiles(repositoryRoot, excludes);
    if (sourceInventory.files.length > request.budgets.maximumRepositoryFiles) {
      throw new Error("REPOSITORY_FILE_BUDGET_EXCEEDED");
    }
    if (sourceInventory.totalBytes > request.budgets.maximumRepositoryBytes) {
      throw new Error("REPOSITORY_BYTES_BUDGET_EXCEEDED");
    }
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
                  requestedExecutable: nodeIdentity.requestedExecutable,
                  resolvedExecutable: nodeIdentity.resolvedExecutable,
                  executableDigest: nodeIdentity.executableDigest,
                  nodeVersion: nodeIdentity.nodeVersion,
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
