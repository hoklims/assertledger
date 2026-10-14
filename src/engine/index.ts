import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants, type Stats } from "node:fs";
import {
  copyFile,
  cp,
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import type { BunPreflightRefusal } from "../contracts/diagnostics.js";
import {
  AdapterSchema,
  type AgenticBenchmarkAcquisitionRequest,
  type AgenticBenchmarkAcquisitionResult,
  type AgenticBenchmarkRun,
  type ContainerIsolation,
  isRepositoryExcludeName,
  parseAgenticBenchmarkAcquisitionRequest,
  parseAgenticBenchmarkAcquisitionResult,
  parseEvidenceManifest,
  parseRepositoryAuditV2,
  parseRepositoryInitConfig,
  parseRepositoryInitConfigV2,
  parseRepositoryInitLock,
  parseRepositoryInitLockV2,
  parseRepositoryInitResult,
  parseRepositoryInitResultV2,
  parseVerificationRequest,
  parseVersionedRepositoryInitConfig,
  parseVersionedRepositoryInitLock,
  parseVersionedVerificationRequest,
  type RepositoryAuditV2,
  type RepositoryInitConfigV2,
  type RepositoryInitDetections,
  RepositoryInitDetectionsSchema,
  type RepositoryInitDetectionsV2,
  type RepositoryInitLock,
  type RepositoryInitLockV2,
  type RepositoryInitResult,
  type RepositoryInitResultV2,
  repositoryInitConfigDigest,
  repositoryInitConfigV2Digest,
  repositoryInitLockDigest,
  repositoryInitLockV2Digest,
  VERIFICATION_SCHEMA_VERSION_V4,
  VERIFICATION_SCHEMA_VERSION_V5,
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
import { BUN_TEST_DESIGNATED_ADAPTER_PROFILE } from "./adapters/bun-test-designated-profile.js";
import { BUN_TEST_ADAPTER_PROFILE } from "./adapters/bun-test-profile.js";
import { NODE_TEST_ADAPTER_PROFILE } from "./adapters/node-test-profile.js";
import {
  type NodeTestPreflightProbeExecutor,
  type NodeTestRuntimePreflight,
  runNodeTestRuntimePreflight,
} from "./adapters/node-test-runtime.js";
import { normalizeRuntimeFacts, RUNTIME_FACTS_VERSION } from "./adapters/runtime-facts.js";
import { BunPreflightError } from "./bun-preflight.js";
import {
  type BoundedProcessResult,
  CONTAINER_ASSET_DIRECTORY,
  CONTAINER_LIMITATIONS,
  CONTAINER_REPORTER_FILE,
  CONTAINER_RESULT_FILE,
  CONTAINER_WORKSPACE,
  type ContainerBackend,
  type ContainerTransport,
  DEFAULT_CONTAINER_RUNTIME_COMMAND,
  parseContainerTransport,
  prepareContainerBackend,
  runContainerExecution,
} from "./container.js";
import { openDockerStdioControl } from "./docker-stdio.js";
import { scanJavaScriptTokens } from "./javascript-tokens.js";
import { NODE_TEST_REPORTER_SOURCE } from "./node-test-reporter.js";
import {
  type RuntimeDoctorResult,
  type RuntimeDoctorResultV2,
  runBunRuntimeDoctorChecks,
  runRuntimeDoctorChecks,
} from "./runtime-doctor.js";
import { traceOperation, withRuntimeTrace } from "./runtime-trace.js";
import {
  computeTestClosure,
  expandIncludedPaths,
  type TestClosureInput,
  type UnboundedClosureEdge,
} from "./test-closure.js";

const DEFAULT_EXCLUDES = new Set([".git", ".testforge", "node_modules"]);
const SHA256_PREFIX = "sha256:";
const PROCESS_TERMINATION_GRACE_MS = 250;
const CONTROLLED_REPORT_MAXIMUM_BYTES = 64 * 1024;
const BUN_TEST_DRIVER_PATH = fileURLToPath(
  new URL("../../integrations/bun/driver.mjs", import.meta.url),
);
const BUN_TEST_HELPER_PATH = fileURLToPath(
  new URL("../../integrations/bun/assertions.mjs", import.meta.url),
);
const BUN_TEST_PRELOAD_PATH = fileURLToPath(
  new URL("../../integrations/bun/preload.mjs", import.meta.url),
);
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
  /** Entry names excluded beside the defaults; when absent, a valid configuration's list is kept. */
  exclude?: readonly string[];
  adapterConfigPath?: string;
  packageManager?: string;
  framework?: string;
  testCommand?: { executable: string; arguments: string[] };
  afterEvidenceSnapshot?: () => void | Promise<void>;
  /** Receives how repository links were judged, so a facade can name a refused link. */
  onLinkAssessment?: (assessment: RepositoryLinkAssessment) => void;
}

export interface RepositoryInitWriteDependencies {
  openTemporary?(temporaryPath: string): Promise<FileHandle>;
  writeTemporary?(temporaryPath: string, content: string, handle: FileHandle): Promise<void>;
  linkTemporary?(temporaryPath: string, targetPath: string): Promise<void>;
  renameTemporary?(temporaryPath: string, targetPath: string): Promise<void>;
  removeTemporary?(temporaryPath: string): Promise<void>;
}

export class RepositoryInitWriteError extends Error {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly temporaryCleanup: "REMOVED" | "UNRESOLVED" | "NOT_OWNED";
  readonly installedPaths: string[];

  constructor(
    cause: unknown,
    targetPath: string,
    temporaryPath: string,
    temporaryCleanup: "REMOVED" | "UNRESOLVED" | "NOT_OWNED",
    installedPaths: string[],
  ) {
    super("INIT_WRITE_FAILED", { cause });
    this.name = "RepositoryInitWriteError";
    this.targetPath = targetPath;
    this.temporaryPath = temporaryPath;
    this.temporaryCleanup = temporaryCleanup;
    this.installedPaths = installedPaths;
  }
}

export interface RuntimeDoctorOptions {
  allowUnsafeExecution: boolean;
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

/** An existing repository test selected by file and describe path; it overlays no file. */
interface DesignatedSelection {
  file: string;
  path: string[];
  expectedFailure: string | null;
}

interface Candidate {
  id: string;
  files: FileOverlay[];
  designated?: DesignatedSelection;
}

interface VerificationRequest {
  schemaVersion: string;
  repository: {
    root: string;
    exclude: string[];
    includeDependencies: boolean;
    git: "excluded" | "synthesized";
    /** v5: the snapshot extent; earlier versions always snapshot the repository. */
    snapshot: "repository" | "test-closure";
    /** v5: paths a test-closure snapshot also keeps. */
    include: string[];
  };
  adapter:
    | {
        kind: "node-test";
        executable: string;
        baseTestFiles: string[];
        extraArguments?: string[];
      }
    | {
        kind: "bun-test";
        executable: string;
        baseTestFiles: string[];
      }
    | {
        kind: "bun-test-designated";
        executable: string;
        testTimeoutMs: number | null;
        /** v5; earlier versions run in the repository root, without isolation or trust. */
        workingDirectory: "repository-root" | "test-package";
        isolate: boolean;
        trustedMatchers: Array<{ path: string; matchers: string[] }>;
        /** Set from the snapshot before any execution: where Bun runs, relative to the root. */
        runDirectory?: string;
        /** Set from the snapshot: each trusted path read through the snapshot's links. */
        resolvedTrustedMatchers?: Array<{ path: string; matchers: string[] }>;
      }
    | {
        kind: "testforge-command";
        executable: string;
        arguments: string[];
        protocolVersion: "1.0.0";
      };
  isolation:
    | {
        kind: "trusted-local" | "windows-native";
        acknowledgedUnsafeExecution: boolean;
        environmentAllowlist: string[];
      }
    | ContainerIsolation;
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

  capturedBytes(): Buffer {
    return Buffer.concat(this.#parts);
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
  const { stdoutBytes: _stdoutBytes, ...result } = await runBoundedProcess(
    parseProcessInput(value),
  );
  return result;
}

/**
 * Runs a validated process. The optional byte stream is written to standard input; a failure to
 * produce or deliver it makes the run an infrastructure error even when the process exits zero.
 */
async function runBoundedProcess(
  input: ProcessInput,
  standardInput?: AsyncIterable<Uint8Array>,
): Promise<BoundedProcessResult> {
  const cwd = await realpath(input.cwd);
  const cwdStats = await stat(cwd);
  if (!cwdStats.isDirectory()) throw new TypeError("INVALID_CWD");

  return new Promise<BoundedProcessResult>((resolve) => {
    const startedAt = Date.now();
    const stdout = new OutputAccumulator(input.maximumOutputBytes);
    const stderr = new OutputAccumulator(input.maximumOutputBytes);
    let timedOut = false;
    let spawnError: Error | undefined;
    let inputError: Error | undefined;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const child = spawn(input.executable, input.args, {
      cwd,
      detached: process.platform !== "win32",
      env: input.environment,
      shell: false,
      windowsHide: true,
      stdio: [standardInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    const inputDelivered =
      standardInput === undefined || child.stdin === null
        ? Promise.resolve()
        : pipeline(Readable.from(standardInput), child.stdin).catch((error: unknown) => {
            inputError = error instanceof Error ? error : new Error(String(error));
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
        stdoutBytes: stdout.capturedBytes(),
        ...(spawnError
          ? { error: spawnError.message }
          : inputError
            ? { error: inputError.message }
            : {}),
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
      const settle = (): void => {
        const outcome: ProcessOutcome = timedOut
          ? "TIMEOUT"
          : spawnError || inputError
            ? "INFRA_ERROR"
            : exitCode === 0
              ? "PASS"
              : "PROCESS_CRASH";
        finish(outcome, exitCode, signal);
      };
      if (standardInput === undefined) settle();
      else void inputDelivered.then(settle);
    });
  });
}

interface RepositoryInventory {
  files: string[];
  directories: string[];
  spellings: Map<string, string>;
  totalBytes: number;
}

function effectiveExcludes(requestExcludes: readonly string[]): Set<string> {
  return new Set([...DEFAULT_EXCLUDES, ...requestExcludes].map(portablePathKey));
}

function compareOrdinalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

/** The declared list of a valid configuration; anything unreadable falls back to the defaults,
 * which only widens the inventory and so keeps every link check. */
async function configuredRepositoryExcludes(root: string): Promise<readonly string[]> {
  try {
    const configPath = path.join(root, INIT_CONFIG_FILE);
    if (!(await lstat(configPath)).isFile()) return [];
    const value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return parseVersionedRepositoryInitConfig(value).repository.exclude;
  } catch {
    return [];
  }
}

async function configuredRepositoryFramework(root: string): Promise<string | undefined> {
  try {
    const configPath = path.join(root, INIT_CONFIG_FILE);
    if (!(await lstat(configPath)).isFile()) return undefined;
    const value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return parseVersionedRepositoryInitConfig(value).framework;
  } catch {
    return undefined;
  }
}

/** The refusal of a repository link. The message stays the stable code, which callers match and
 * the CLI classifies by value; the link found travels as the cause so a facade can name it. */
function repositoryLinkError(relative: string): Error {
  return new Error("UNSUPPORTED_REPOSITORY_SYMLINK", {
    cause: relative.split(path.sep).join("/"),
  });
}

/** Walks the regular files of a repository. A link refuses the walk unless `links` collects it;
 * a collected link is never followed. */
async function walkFiles(
  root: string,
  excludes: ReadonlySet<string>,
  links?: string[],
): Promise<RepositoryInventory> {
  const files: string[] = [];
  const directories: string[] = [];
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
      if (entryStats.isSymbolicLink()) {
        if (links === undefined) throw repositoryLinkError(relative);
        registerPortablePath(spellings, relative);
        links.push(relative);
        continue;
      }
      registerPortablePath(spellings, relative);
      if (entryStats.isDirectory()) {
        directories.push(relative);
        await visit(relative);
      } else if (entryStats.isFile()) {
        files.push(relative);
        totalBytes += entryStats.size;
      }
    }
  }
  await visit("");
  files.sort(comparePortablePaths);
  links?.sort(comparePortablePaths);
  return { files, directories: directories.sort(comparePortablePaths), spellings, totalBytes };
}

/** Whether a link resolves, or would resolve when dangling, outside the repository root. */
async function linkEscapesRoot(root: string, relative: string): Promise<boolean> {
  const linkPath = path.join(root, ...relative.split("/"));
  let target: string;
  try {
    target = await realpath(linkPath);
  } catch {
    try {
      target = path.resolve(path.dirname(linkPath), await readlink(linkPath));
    } catch {
      return true;
    }
  }
  const fromRoot = path.relative(root, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot);
}

export type RepositoryLinkRefusalCode =
  | "REPOSITORY_LINK_ESCAPES_ROOT"
  | "REPOSITORY_LINK_IN_TEST_CLOSURE"
  | "TEST_CLOSURE_UNBOUNDED"
  | "TEST_CLOSURE_UNSUPPORTED";

/** How the links of an inventory relate to the module closure of the tests that would run. */
export interface RepositoryLinkAssessment {
  links: string[];
  refused: { path: string; reasonCode: RepositoryLinkRefusalCode } | undefined;
  omitted: string[];
  unbounded: UnboundedClosureEdge[];
}

const LINK_DISCOVERY_ENTRY_LIMIT = 100_000;

/**
 * Whether a runner discovering tests from the root could reach one through this link: the link
 * is itself named as a test, or it resolves to a directory holding one. A nested link, or a tree
 * past the entry limit, is assumed to reach one.
 */
async function linkReachesDiscoverableTest(
  root: string,
  link: string,
  discoverable: (file: string) => boolean,
): Promise<boolean> {
  if (discoverable(link)) return true;
  let target: string;
  try {
    target = await realpath(path.join(root, ...link.split("/")));
    if (!(await stat(target)).isDirectory()) return false;
  } catch {
    return false;
  }
  let seen = 0;
  const pending = [""];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
    for (const entry of await readdir(path.join(target, relative), { withFileTypes: true })) {
      seen += 1;
      if (seen > LINK_DISCOVERY_ENTRY_LIMIT || entry.isSymbolicLink()) return true;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else if (discoverable(`${link}/${child}`)) return true;
    }
  }
  return false;
}

/**
 * Refuses a link that leaves the root or lies in the closure of `roots`; every other link stays
 * outside the evidence. With `discoverable`, the tests a runner finds by itself, a link through
 * which one can be reached is in the closure too. `strictUnbounded` also refuses any link when the
 * closure is unbounded, as a campaign must; a static diagnostic reports that case without refusing.
 * Without `roots` the closure is unknown and every link refuses.
 */
async function assessRepositoryLinks(
  root: string,
  files: readonly string[],
  links: readonly string[],
  roots: readonly string[] | undefined,
  read: TestClosureInput["read"],
  strictUnbounded: boolean,
  discoverable?: (file: string) => boolean,
): Promise<RepositoryLinkAssessment> {
  const assessment: RepositoryLinkAssessment = {
    links: [...links],
    refused: undefined,
    omitted: [],
    unbounded: [],
  };
  if (links.length === 0) return assessment;
  for (const link of links) {
    if (await linkEscapesRoot(root, link)) {
      assessment.refused = { path: link, reasonCode: "REPOSITORY_LINK_ESCAPES_ROOT" };
      return assessment;
    }
  }
  if (roots === undefined) {
    assessment.refused = { path: links[0] as string, reasonCode: "TEST_CLOSURE_UNSUPPORTED" };
    return assessment;
  }
  if (discoverable !== undefined) {
    for (const link of links) {
      if (await linkReachesDiscoverableTest(root, link, discoverable)) {
        assessment.refused = { path: link, reasonCode: "REPOSITORY_LINK_IN_TEST_CLOSURE" };
        return assessment;
      }
    }
  }
  const closure = await computeTestClosure({ files, links, roots, read });
  assessment.unbounded = closure.unbounded;
  const linked = closure.links[0];
  if (linked !== undefined) {
    assessment.refused = { path: linked, reasonCode: "REPOSITORY_LINK_IN_TEST_CLOSURE" };
    return assessment;
  }
  if (strictUnbounded && closure.unbounded.length > 0) {
    assessment.refused = { path: links[0] as string, reasonCode: "TEST_CLOSURE_UNBOUNDED" };
    return assessment;
  }
  assessment.omitted = [...links];
  return assessment;
}

/** The digest analyzeRepository computes, over an inventory already walked. */
async function repositoryInventoryDigest(root: string, files: readonly string[]): Promise<string> {
  const digest = createHash("sha256");
  for (const file of files) {
    const content = await readFile(path.join(root, ...file.split("/")));
    digest.update(Buffer.from(`${file}\0${content.byteLength}\0`, "utf8"));
    digest.update(content);
  }
  return `${SHA256_PREFIX}${digest.digest("hex")}`;
}

/**
 * Judges a v4 campaign's links against the module closure of every test the adapter executes,
 * read with each world's and candidate's overlay. A link that leaves the root or lies in that
 * closure refuses the campaign and is named; so does any link when the closure is unbounded or
 * unknown, as for a structured command. The others are left out of the snapshot and recorded.
 */
async function campaignOmittedLinks(
  request: VerificationRequest,
  root: string,
  files: readonly string[],
  links: readonly string[],
): Promise<string[]> {
  const overlays = new Map<string, { path: string; contents: string[] }>();
  for (const overlay of [
    ...request.worlds.flatMap((world) => world.files),
    ...request.candidates.flatMap((candidate) => candidate.files),
  ]) {
    const key = portablePathKey(overlay.path);
    const entry = overlays.get(key) ?? { path: overlay.path, contents: [] };
    entry.contents.push(overlay.content);
    overlays.set(key, entry);
  }
  const repositoryFiles = new Set(files.map(portablePathKey));
  const roots =
    request.adapter.kind === "node-test" || request.adapter.kind === "bun-test"
      ? [
          ...request.adapter.baseTestFiles,
          ...request.candidates.flatMap((candidate) => candidate.files.map((file) => file.path)),
        ]
      : request.adapter.kind === "bun-test-designated"
        ? request.candidates.flatMap((candidate) =>
            candidate.designated === undefined ? [] : [candidate.designated.file],
          )
        : undefined;
  const assessment = await assessRepositoryLinks(
    root,
    [
      ...files,
      ...[...overlays.entries()]
        .filter(([key]) => !repositoryFiles.has(key))
        .map(([, entry]) => entry.path),
    ],
    links,
    roots,
    async (file) => {
      const key = portablePathKey(file);
      const texts = overlays.get(key)?.contents ?? [];
      return repositoryFiles.has(key)
        ? [await readFile(path.join(root, ...file.split("/")), "utf8"), ...texts]
        : texts;
    },
    true,
  );
  const refused = assessment.refused;
  if (refused !== undefined) {
    throw new Error(
      refused.reasonCode === "TEST_CLOSURE_UNSUPPORTED"
        ? "UNSUPPORTED_REPOSITORY_SYMLINK"
        : refused.reasonCode,
      { cause: refused.path },
    );
  }
  return assessment.omitted;
}

/** A repository link reproduced in a v5 snapshot: its path, its target and the target's kind. */
interface PreservedLink {
  path: string;
  /** The target relative to the link's directory, `/`-separated. */
  target: string;
  /** The target relative to the root, `/`-separated: what the closure walks instead. */
  resolved: string;
  type: "dir" | "file";
}

function relativeWithin(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

/**
 * Sorts a v5 inventory's links. A link is internal when its target and its real path both lie
 * inside the root, outside every excluded name, and exist: it is reproduced as a relative link to
 * the same target. Every other link, leaving the root, dangling, cyclic or into an exclusion, is
 * external and can only be left out.
 */
async function classifyRepositoryLinks(
  root: string,
  links: readonly string[],
  excludes: ReadonlySet<string>,
): Promise<{
  internal: Map<string, PreservedLink>;
  external: string[];
  escaping: Set<string>;
}> {
  const internal = new Map<string, PreservedLink>();
  const external: string[] = [];
  const escaping = new Set<string>();
  const excluded = (relative: string) =>
    relative.split("/").some((segment) => excludes.has(portablePathKey(segment)));
  for (const link of links) {
    const linkPath = path.join(root, ...link.split("/"));
    try {
      const lexical = relativeWithin(
        root,
        path.resolve(path.dirname(linkPath), await readlink(linkPath)),
      );
      const real = relativeWithin(root, await realpath(linkPath));
      if (lexical === undefined || real === undefined) escaping.add(portablePathKey(link));
      if (lexical === undefined || real === undefined || excluded(lexical) || excluded(real)) {
        external.push(link);
        continue;
      }
      const type = (await stat(linkPath)).isDirectory() ? "dir" : "file";
      const resolved = lexical === "" ? "." : lexical;
      const target = path.posix.relative(path.posix.dirname(link), resolved) || ".";
      internal.set(portablePathKey(link), { path: link, target, resolved, type });
    } catch {
      // A dangling or cyclic link may still name a target outside the root.
      if (await linkEscapesRoot(root, link)) escaping.add(portablePathKey(link));
      external.push(link);
    }
  }
  return { internal, external: external.sort(comparePortablePaths), escaping };
}

/** The modules `bun test` answers itself, whatever is installed under their names. */
const BUN_RUNNER_MODULES: ReadonlySet<string> = new Set(["vitest", "@jest/globals"]);

/** The files and links a v5 campaign snapshots, with what it records about the links. */
interface SnapshotPlan {
  files: string[];
  directories?: string[];
  links: PreservedLink[];
  omittedLinks: string[];
  unbounded: UnboundedClosureEdge[];
}

/**
 * Plans a v5 snapshot against the closure of the executed tests, followed through internal links.
 * An external link on that closure refuses the campaign and is named. A repository snapshot keeps
 * every file and internal link and leaves the external links out; it refuses an unbounded closure
 * when an external link exists, as v4 does. A test-closure snapshot keeps the closure, the
 * operator's include paths and the overlaid files that exist, and records the unbounded edges.
 */
async function planCampaignSnapshot(
  request: VerificationRequest,
  root: string,
  files: readonly string[],
  links: readonly string[],
  excludes: ReadonlySet<string>,
  directories: readonly string[],
): Promise<SnapshotPlan> {
  const { internal, external, escaping } = await classifyRepositoryLinks(root, links, excludes);
  const overlays = new Map<string, { path: string; contents: string[] }>();
  for (const overlay of [
    ...request.worlds.flatMap((world) => world.files),
    ...request.candidates.flatMap((candidate) => candidate.files),
  ]) {
    const key = portablePathKey(overlay.path);
    const entry = overlays.get(key) ?? { path: overlay.path, contents: [] };
    entry.contents.push(overlay.content);
    overlays.set(key, entry);
  }
  const repositoryFiles = new Set(files.map(portablePathKey));
  const roots =
    request.adapter.kind === "node-test" || request.adapter.kind === "bun-test"
      ? [
          ...request.adapter.baseTestFiles,
          ...request.candidates.flatMap((candidate) => candidate.files.map((file) => file.path)),
        ]
      : request.adapter.kind === "bun-test-designated"
        ? request.candidates.flatMap((candidate) =>
            candidate.designated === undefined ? [] : [candidate.designated.file],
          )
        : undefined;
  const linkTargets = new Map([...internal.values()].map((link) => [link.path, link.resolved]));
  const closureFiles = [
    ...files,
    ...[...overlays.entries()]
      .filter(([key]) => !repositoryFiles.has(key))
      .map(([, entry]) => entry.path),
  ];
  const read = async (file: string) => {
    const key = portablePathKey(file);
    const texts = overlays.get(key)?.contents ?? [];
    return repositoryFiles.has(key)
      ? [await readFile(path.join(root, ...file.split("/")), "utf8"), ...texts]
      : texts;
  };
  const refuseExternal = (reached: readonly string[]) => {
    for (const link of reached) {
      if (internal.has(portablePathKey(link))) continue;
      throw new Error(
        escaping.has(portablePathKey(link))
          ? "REPOSITORY_LINK_ESCAPES_ROOT"
          : roots === undefined
            ? "UNSUPPORTED_REPOSITORY_SYMLINK"
            : "REPOSITORY_LINK_IN_TEST_CLOSURE",
        { cause: link },
      );
    }
  };
  if (roots === undefined) {
    // A structured command names no test: only a repository without external links is snapshot.
    refuseExternal(external);
    return {
      files: [...files],
      directories: [...directories],
      links: [...internal.values()],
      omittedLinks: [],
      unbounded: [],
    };
  }
  const bunRunner =
    request.adapter.kind === "bun-test" || request.adapter.kind === "bun-test-designated";
  const closure = await computeTestClosure({
    files: closureFiles,
    links,
    roots,
    read,
    linkTargets,
    ...(bunRunner ? { runnerModules: BUN_RUNNER_MODULES } : {}),
  });
  refuseExternal(closure.links);
  if (request.repository.snapshot === "repository") {
    if (closure.unbounded.length > 0 && external.length > 0) {
      throw new Error("TEST_CLOSURE_UNBOUNDED", { cause: external[0] });
    }
    return {
      files: [...files],
      directories: [...directories],
      links: [...internal.values()],
      omittedLinks: external,
      unbounded: [],
    };
  }
  const included = expandIncludedPaths(
    { files, links, linkTargets, directories },
    request.repository.include,
  );
  if (included.missing.length > 0) {
    throw new Error("REPOSITORY_INCLUDE_MISSING", { cause: included.missing[0] });
  }
  refuseExternal(included.links);
  const selected = new Map<string, string>();
  for (const file of [
    ...closure.files,
    ...included.files,
    ...[...overlays.values()].map((entry) => entry.path),
  ]) {
    const key = portablePathKey(file);
    if (repositoryFiles.has(key)) selected.set(key, file);
  }
  const selectedLinks = new Map<string, PreservedLink>();
  for (const link of [...closure.links, ...included.links]) {
    const preserved = internal.get(portablePathKey(link));
    if (preserved !== undefined) selectedLinks.set(portablePathKey(link), preserved);
  }
  return {
    files: [...selected.values()].sort(comparePortablePaths),
    directories: [
      ...new Set([
        ...included.directories,
        ...[...selectedLinks.values()]
          .filter((link) => link.type === "dir")
          .flatMap((link) =>
            directories.filter(
              (directory) =>
                directory === link.resolved || directory.startsWith(`${link.resolved}/`),
            ),
          ),
      ]),
    ].sort(comparePortablePaths),
    links: [...selectedLinks.values()].sort((left, right) =>
      comparePortablePaths(left.path, right.path),
    ),
    omittedLinks: external,
    unbounded: closure.unbounded,
  };
}

/** The closure roots of a test framework's discovered sources; undefined when not analyzable. */
function frameworkClosureRoots(framework: string, files: readonly string[]): string[] | undefined {
  if (framework === "bun:test") {
    return files.filter((file) => /(?:^|\/)[^/]+[._](?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
  }
  if (framework === "node:test" || framework === "vitest" || framework === "jest") {
    return files.filter(
      (file) =>
        (initEvidenceKind(file) === "TEST_SOURCE" && /\.[cm]?[jt]sx?$/u.test(file)) ||
        /(?:^|\/)(?:vitest|jest)\.config\.[cm]?[jt]s$/u.test(file),
    );
  }
  return undefined;
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

function initBunTestSource(file: string): boolean {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);
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

const INIT_CONVENTIONAL_TEST_DIRECTORIES = new Set(["test", "tests", "spec", "specs", "__tests__"]);

/**
 * Whether an operand is a path by its spelling alone: a glob, a nested path or a file name the
 * framework's runner discovers as a test.
 */
function initOperandSpelledAsPath(
  argument: string,
  isTestFile: (file: string) => boolean,
): boolean {
  return (
    initSafePathPattern(argument) &&
    (/[*?]/u.test(argument) || argument.includes("/") || isTestFile(argument))
  );
}

/** Whether an operand of a runner's command is a path: by spelling or as an existing entry. */
function initOperandNamesPath(
  argument: string,
  testSources: string[],
  isTestFile: (file: string) => boolean,
): boolean {
  return (
    initOperandSpelledAsPath(argument, isTestFile) ||
    (initSafePathPattern(argument) &&
      testSources.some((file) => file === argument || file.startsWith(`${argument}/`)))
  );
}

function initCommandPathMatchers(
  command: { executable: string; arguments: string[] },
  testSources: string[],
  isTestFile: (file: string) => boolean,
): Array<(file: string) => boolean> {
  const operands =
    command.executable === "bun" && command.arguments[0] === "test"
      ? command.arguments.slice(1)
      : command.arguments;
  return operands
    .filter(
      (argument) =>
        initOperandNamesPath(argument, testSources, isTestFile) ||
        (initSafePathPattern(argument) && INIT_CONVENTIONAL_TEST_DIRECTORIES.has(argument)),
    )
    .map(initPathPatternMatcher);
}

/**
 * Whether the command invokes the framework's own runner, itself or behind a launcher
 * (`pnpm exec node --test`, `tsx --test`, `bunx bun test`): its operands are then that runner's
 * path filters. Node's runner is the `--test` option: options come before the program entry
 * point, so `node runner --test` runs a script of its own and hands it `--test`.
 */
function initCommandInvokesRunner(
  command: { executable: string; arguments: string[] },
  runner: "node" | "bun",
): boolean {
  const words = [command.executable, ...command.arguments];
  if (runner === "bun") {
    // `node runner bun test` hands `bun test` to the script: no runtime may come before the pair.
    return words.some(
      (word, index) =>
        word === "bun" &&
        words[index + 1] === "test" &&
        !words.slice(0, index).some((before) => INIT_NODE_RUNTIMES.has(before)),
    );
  }
  const flag = words.indexOf("--test", 1);
  if (flag < 0) return false;
  // The nearest word at or before `from` that is not an option or the value of an option that
  // takes one: the executable at index 0 always is a word.
  const nearestWord = (from: number): number => {
    let position = from;
    while (
      position >= 1 &&
      ((words[position] ?? "").startsWith("-") ||
        INIT_NODE_VALUE_OPTIONS.has(words[position - 1] ?? ""))
    ) {
      position -= 1;
    }
    return position;
  };
  // The program the option belongs to, and the word that precedes it: when a runtime comes right
  // before it (`node runner`), it is that runtime's entry point and `--test` is its argument.
  const program = nearestWord(flag - 1);
  const previous = program >= 1 ? nearestWord(program - 1) : -1;
  const name = words[program] ?? "";
  const spelledAsScript = name.includes("/") || /\.[cm]?[jt]sx?$/u.test(name);
  const runtimeBefore = previous >= 0 && INIT_NODE_RUNTIMES.has(words[previous] ?? "");
  return !spelledAsScript && !runtimeBefore;
}

const INIT_NODE_RUNTIMES = new Set(["node", "tsx", "ts-node", "babel-node", "nodemon"]);
const INIT_NODE_VALUE_OPTIONS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--conditions",
  "-C",
  "--input-type",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
]);

/**
 * Whether the command does not invoke the framework's runner and spells no test path. Its operands
 * are then task or script names (`turbo test`, `pnpm -r test`), not filters, so no inventory can be
 * derived from them. A bare word such as `test` is a task name here even when a directory of that
 * name exists: only the runner's own operands are read as entries.
 */
function initCommandIsIndirect(
  command: { executable: string; arguments: string[] },
  runner: "node" | "bun",
): boolean {
  const isTestFile = runner === "bun" ? initBunTestSource : initNodeTestSource;
  return (
    !initCommandInvokesRunner(command, runner) &&
    !command.arguments.some((argument) => initOperandSpelledAsPath(argument, isTestFile))
  );
}

const INIT_MANAGER_LOCKFILES: ReadonlyArray<readonly [InitPackageManager, readonly string[]]> = [
  ["pnpm", ["pnpm-lock.yaml"]],
  ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]],
  ["uv", ["uv.lock"]],
  ["poetry", ["poetry.lock"]],
  ["pip", ["Pipfile.lock", "requirements.txt"]],
];
const INIT_WORKSPACE_MANAGERS: readonly InitPackageManager[] = ["pnpm", "npm", "yarn", "bun"];
// pnpm-workspace.yaml is read as text and scanned; a manifest may be larger, as in the contracts.
const INIT_WORKSPACE_FILE_LIMIT_BYTES = 1_048_576;
const INIT_WORKSPACE_MANIFEST_LIMIT_BYTES = 16 * 1_048_576;
// Patterns and the alternations they expand to share one budget.
const INIT_WORKSPACE_PATTERN_COUNT = 1_024;
const INIT_WORKSPACE_PATTERN_LENGTH = 256;
const INIT_WORKSPACE_BRACE_DEPTH = 8;
const INIT_WORKSPACE_PATH_LENGTH = 1_024;

async function initRegularFileStats(file: string): Promise<Stats | undefined> {
  try {
    const stats = await lstat(file);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What is at a workspace file's path: nothing, text, or something that exists but cannot be read
 * as a bounded regular file (a link, a directory, an oversized file). An unreadable file is never
 * the same as an absent one, because the manager that owns the file would still read it.
 */
type InitWorkspaceFileRead =
  | { kind: "ABSENT" }
  | { kind: "UNREADABLE" }
  | { kind: "TEXT"; text: string };

async function initWorkspaceFileRead(
  file: string,
  limit = INIT_WORKSPACE_FILE_LIMIT_BYTES,
): Promise<InitWorkspaceFileRead> {
  let stats: Stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "ABSENT" }
      : { kind: "UNREADABLE" };
  }
  if (!stats.isFile() || stats.size > limit) {
    return { kind: "UNREADABLE" };
  }
  try {
    return { kind: "TEXT", text: await readFile(file, "utf8") };
  } catch {
    return { kind: "UNREADABLE" };
  }
}

/** Splits the inside of a YAML flow list on the commas outside quotes and braces. */
function initFlowListItems(inside: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let index = 0; index < inside.length; index += 1) {
    const character = inside[index] ?? "";
    if (quote !== "") {
      if (quote === '"' && character === "\\") {
        current += character;
        index += 1;
        current += inside[index] ?? "";
        continue;
      }
      if (character === quote) quote = "";
    } else if (initYamlQuoteOpens(inside, index)) {
      quote = character;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current);
  return items;
}

/** Whether a quote character at `index` opens a quoted scalar: at the start of a token. */
function initYamlQuoteOpens(text: string, index: number): boolean {
  const character = text[index];
  if (character !== "'" && character !== '"') return false;
  return index === 0 || " \t[{,:-".includes(text[index - 1] ?? "");
}

/**
 * Drops a trailing YAML comment: a `#` that follows whitespace outside a quoted scalar. Linear,
 * with no backtracking. A quote that opens mid-token (`it's`) does not start a quoted scalar.
 */
function initYamlStripComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote !== "") {
      if (quote === '"' && character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (initYamlQuoteOpens(line, index)) {
      quote = character;
    } else if (character === "#" && index > 0 && /\s/u.test(line[index - 1] ?? "")) {
      return line.slice(0, index);
    }
  }
  return line;
}

function initYamlUnquote(value: string): string {
  const text = value.trim();
  const first = text[0];
  return text.length >= 2 && (first === "'" || first === '"') && text.endsWith(first)
    ? text.slice(1, -1)
    : text;
}

/** The scanner state of a YAML flow list that may span lines. */
interface InitFlowScan {
  quote: string;
  depth: number;
}

/**
 * Scans one more piece of a flow list whose opening bracket is already consumed and returns the
 * index of the closing bracket in it, or -1 while the list is still open. The state carries over,
 * so a list is read once however many lines it spans.
 */
function initFlowScan(state: InitFlowScan, text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (state.quote !== "") {
      if (state.quote === '"' && character === "\\") index += 1;
      else if (character === state.quote) state.quote = "";
    } else if (initYamlQuoteOpens(text, index)) {
      state.quote = character;
    } else if (character === "{" || character === "[") {
      state.depth += 1;
    } else if (character === "}") {
      state.depth = Math.max(0, state.depth - 1);
    } else if (character === "]") {
      if (state.depth === 0) return index;
      state.depth -= 1;
    }
  }
  return -1;
}

/**
 * The `packages` patterns of a pnpm-workspace.yaml. Only the block and flow list forms are read;
 * a file in any other shape declares nothing, so a member is never inferred from it. The text is
 * repository-controlled and up to 1 MiB: it is read in one linear pass, without regular
 * expressions that could backtrack.
 */
function initPnpmWorkspacePatterns(text: string | undefined): string[] {
  if (text === undefined) return [];
  const flowPatterns = (inside: string): string[] =>
    initFlowListItems(inside)
      .map(initYamlUnquote)
      .filter((entry) => entry.length > 0);
  const patterns: string[] = [];
  let inPackages = false;
  // The indentation of the items of the block list under `packages`.
  let itemIndent: number | undefined;
  // The pieces of a flow list still open at the end of a line, and its scanner state.
  let flow: string[] | undefined;
  const scan: InitFlowScan = { quote: "", depth: 0 };
  for (const raw of text.split(/\r?\n/u)) {
    const line = initYamlStripComment(raw);
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (flow !== undefined) {
      const end = initFlowScan(scan, line);
      if (end >= 0) {
        // Only whitespace may follow the closing bracket: anything else is not valid YAML.
        if (line.slice(end + 1).trim().length > 0) return [];
        flow.push(line.slice(0, end));
        patterns.push(...flowPatterns(flow.join(" ")));
        flow = undefined;
      } else {
        flow.push(line);
      }
    } else if (!/^[\s-]/u.test(line)) {
      inPackages = false;
      itemIndent = undefined;
      const rest = line.startsWith("packages") ? line.slice("packages".length).trimStart() : "";
      if (!rest.startsWith(":")) continue;
      const value = rest.slice(1).trim();
      if (value.length === 0) {
        inPackages = true;
      } else if (value.startsWith("[")) {
        const inside = value.slice(1);
        scan.quote = "";
        scan.depth = 0;
        const end = initFlowScan(scan, inside);
        if (end >= 0) {
          if (inside.slice(end + 1).trim().length > 0) return [];
          patterns.push(...flowPatterns(inside.slice(0, end)));
        } else {
          flow = [inside];
        }
      }
    } else if (inPackages) {
      // Every line under `packages` must be an item at one indentation: a mapping or a nested
      // sequence is not the package list, so the file declares nothing.
      const isItem =
        trimmed.startsWith("-") && (trimmed[1] === undefined || /\s/u.test(trimmed[1]));
      const indent = line.length - line.trimStart().length;
      if (!isItem || (itemIndent !== undefined && indent !== itemIndent)) return [];
      itemIndent = indent;
      const item = trimmed.slice(1).trim();
      if (item.length > 0) patterns.push(initYamlUnquote(item));
    }
  }
  // A flow list that never closes is not a declaration.
  return flow === undefined ? patterns : [];
}

/** The deepest nesting of braces in a pattern: sibling groups do not nest. */
function initBraceNesting(pattern: string): number {
  let level = 0;
  let deepest = 0;
  for (const character of pattern) {
    if (character === "{") {
      level += 1;
      deepest = Math.max(deepest, level);
    } else if (character === "}") {
      level = Math.max(0, level - 1);
    }
  }
  return deepest;
}

/**
 * Expands the `{a,b}` alternations of a workspace pattern into the plain patterns they stand for.
 * Each pattern produced spends `budget`, so a repository cannot make the expansion grow without
 * bound. Undefined for anything outside the supported subset: an alternation with one branch
 * (a range such as `{1..3}` has none), unbalanced braces, or an exhausted budget. Nesting depth
 * is bounded by the caller.
 */
function initExpandBraces(pattern: string, budget: { left: number }): string[] | undefined {
  const open = pattern.indexOf("{");
  if (open < 0) {
    if (pattern.includes("}")) return undefined;
    budget.left -= 1;
    return budget.left < 0 ? undefined : [pattern];
  }
  let level = 0;
  let close = -1;
  const cuts: number[] = [open];
  for (let index = open; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "{") {
      level += 1;
    } else if (character === "}") {
      level -= 1;
      if (level === 0) {
        close = index;
        break;
      }
    } else if (character === "," && level === 1) {
      cuts.push(index);
    }
  }
  if (close < 0 || cuts.length < 2) return undefined;
  cuts.push(close);
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const results: string[] = [];
  for (let branch = 0; branch + 1 < cuts.length; branch += 1) {
    const alternative = pattern.slice((cuts[branch] ?? 0) + 1, cuts[branch + 1]);
    const expanded = initExpandBraces(`${prefix}${alternative}${suffix}`, budget);
    if (expanded === undefined) return undefined;
    results.push(...expanded);
  }
  return results;
}

type InitGlobToken =
  | { kind: "literal"; value: string }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "class"; negated: boolean; members: string };

/** The tokens of one path segment: `*`, `?`, `[a-z]` and literal characters; undefined otherwise. */
function initGlobTokens(segment: string): InitGlobToken[] | undefined {
  const tokens: InitGlobToken[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
    if (character === "*") {
      if (tokens[tokens.length - 1]?.kind !== "star") tokens.push({ kind: "star" });
    } else if (character === "?") {
      tokens.push({ kind: "any" });
    } else if (character === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close < 0) return undefined;
      let members = segment.slice(index + 1, close);
      if (members.includes("[")) return undefined;
      const negated = members.startsWith("!") || members.startsWith("^");
      if (negated) members = members.slice(1);
      if (members.length === 0) return undefined;
      tokens.push({ kind: "class", negated, members });
      index = close;
    } else {
      tokens.push({ kind: "literal", value: character });
    }
  }
  return tokens;
}

function initGlobTokenMatches(token: InitGlobToken, character: string): boolean {
  if (token.kind === "literal") return token.value === character;
  if (token.kind === "any") return true;
  if (token.kind !== "class") return false;
  let inside = false;
  for (let index = 0; index < token.members.length && !inside; index += 1) {
    const from = token.members[index] ?? "";
    const range = token.members[index + 1] === "-" && index + 2 < token.members.length;
    if (range) {
      const to = token.members[index + 2] ?? "";
      inside = character >= from && character <= to;
      index += 2;
    } else {
      inside = character === from;
    }
  }
  return inside !== token.negated;
}

/** Matches one segment against its tokens in time proportional to the product of their lengths. */
function initGlobSegmentMatches(tokens: readonly InitGlobToken[], text: string): boolean {
  let token = 0;
  let position = 0;
  let starToken = -1;
  let starPosition = 0;
  while (position < text.length) {
    const current = tokens[token];
    if (current?.kind === "star") {
      starToken = token;
      starPosition = position;
      token += 1;
    } else if (current !== undefined && initGlobTokenMatches(current, text[position] ?? "")) {
      token += 1;
      position += 1;
    } else if (starToken >= 0) {
      token = starToken + 1;
      starPosition += 1;
      position = starPosition;
    } else {
      return false;
    }
  }
  while (tokens[token]?.kind === "star") token += 1;
  return token === tokens.length;
}

type InitGlobSegment = "**" | InitGlobToken[];

/** The segments of a plain pattern; a whole `**` segment spans any number of directories. */
function initGlobSegments(pattern: string): InitGlobSegment[] | undefined {
  if (pattern.includes("\\") || pattern.includes("(") || pattern.includes(")")) return undefined;
  const segments: InitGlobSegment[] = [];
  for (const segment of pattern.split("/")) {
    if (segment === "**") {
      if (segments[segments.length - 1] !== "**") segments.push("**");
      continue;
    }
    const tokens = initGlobTokens(segment);
    if (tokens === undefined) return undefined;
    segments.push(tokens);
  }
  return segments;
}

/** Whether the pattern selects the whole path, by dynamic programming over its segments. */
function initGlobMatchesPath(
  pattern: readonly InitGlobSegment[],
  path: readonly string[],
): boolean {
  let next: boolean[] = [...path.map(() => false), true];
  for (let index = pattern.length - 1; index >= 0; index -= 1) {
    const part = pattern[index] as InitGlobSegment;
    const current: boolean[] = new Array<boolean>(path.length + 1).fill(false);
    for (let position = path.length; position >= 0; position -= 1) {
      if (part === "**") {
        current[position] =
          next[position] === true || (position < path.length && current[position + 1] === true);
      } else {
        current[position] =
          position < path.length &&
          next[position + 1] === true &&
          initGlobSegmentMatches(part, path[position] ?? "");
      }
    }
    next = current;
  }
  return next[0] === true;
}

/**
 * Whether a directory, given relative to the workspace root, is selected by its patterns:
 * undefined when a pattern is outside the supported subset or past a bound, as the declaration is
 * then not understood and nothing may be inferred from it. Matching never backtracks beyond a
 * product of lengths, and patterns, alternations and path length are bounded before any matching.
 */
function initWorkspaceDeclaresMember(
  patterns: readonly string[],
  relative: string,
): boolean | undefined {
  if (patterns.length > INIT_WORKSPACE_PATTERN_COUNT) return undefined;
  if (relative.length > INIT_WORKSPACE_PATH_LENGTH) return undefined;
  const path = relative.split("/");
  const budget = { left: INIT_WORKSPACE_PATTERN_COUNT };
  let included = false;
  let excluded = false;
  for (const raw of patterns) {
    if (raw.length > INIT_WORKSPACE_PATTERN_LENGTH + 1) return undefined;
    const negated = raw.startsWith("!");
    let pattern = negated ? raw.slice(1) : raw;
    if (pattern.startsWith("./")) pattern = pattern.slice(2);
    while (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    if (pattern.length === 0 || pattern.startsWith("/") || pattern.split("/").includes("..")) {
      continue;
    }
    if (pattern.length > INIT_WORKSPACE_PATTERN_LENGTH) return undefined;
    if (initBraceNesting(pattern) > INIT_WORKSPACE_BRACE_DEPTH) return undefined;
    const expansions = initExpandBraces(pattern, budget);
    if (expansions === undefined) return undefined;
    for (const expansion of expansions) {
      const segments = initGlobSegments(expansion);
      if (segments === undefined) return undefined;
      if (initGlobMatchesPath(segments, path)) {
        if (negated) excluded = true;
        else included = true;
      }
    }
  }
  return included && !excluded;
}

interface InitWorkspaceRootFacts {
  managers: Set<InitPackageManager>;
  invalidManagerField: boolean;
  /** The workspace root has a package.json that is not a JSON object. */
  invalidManifest: boolean;
}

/** A stable comparison key of what the workspace search concluded. */
function initWorkspaceFactsKey(facts: InitWorkspaceRootFacts | undefined): string {
  return JSON.stringify(
    facts === undefined
      ? null
      : {
          managers: [...facts.managers].sort(),
          invalid: facts.invalidManagerField,
          invalidManifest: facts.invalidManifest,
        },
  );
}

/**
 * The package-manager facts of the nearest workspace whose patterns select `root`. The search
 * starts above `root`, stops at the first directory holding a `.git` (included), and does not run
 * at all when `root` is itself a repository top or when no `.git` bounds it: it never reads past
 * the repository that holds the package.
 */
async function initWorkspaceRootFacts(root: string): Promise<InitWorkspaceRootFacts | undefined> {
  const exists = async (entry: string): Promise<boolean> => {
    try {
      await lstat(entry);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists(path.join(root, ".git"))) return undefined;
  const ancestors: string[] = [];
  for (let current = root; ; ) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    ancestors.push(parent);
    if (await exists(path.join(parent, ".git"))) break;
    current = parent;
  }
  for (const directory of ancestors) {
    const relative = path.relative(directory, root).split(path.sep).join("/");
    // pnpm-workspace.yaml is the only declaration read. One that exists but cannot be read is
    // still pnpm's declaration: nothing is inferred from it.
    const workspaceRead = await initWorkspaceFileRead(path.join(directory, "pnpm-workspace.yaml"));
    if (workspaceRead.kind === "UNREADABLE") return undefined;
    if (workspaceRead.kind !== "TEXT") continue;
    const declared = initWorkspaceDeclaresMember(
      initPnpmWorkspacePatterns(workspaceRead.text),
      relative,
    );
    if (declared === undefined) return undefined;
    if (!declared) continue;
    const manifestRead = await initWorkspaceFileRead(
      path.join(directory, "package.json"),
      INIT_WORKSPACE_MANIFEST_LIMIT_BYTES,
    );
    // A manifest that exists but cannot be read within its bound is neither absent nor invalid
    // JSON: nothing is inferred from this directory.
    if (manifestRead.kind === "UNREADABLE") return undefined;
    const manifest = initPackageDocument(
      manifestRead.kind === "TEXT" ? manifestRead.text : undefined,
    );
    // The yaml makes the directory a pnpm workspace; the manifest field and the lockfiles of the
    // JavaScript managers must converge on it, or the facts conflict.
    const managers = new Set<InitPackageManager>(["pnpm"]);
    let invalidManagerField = false;
    const field = manifest?.packageManager;
    if (typeof field === "string") {
      const id = field.split("@")[0] ?? "";
      if (isInitPackageManager(id)) managers.add(id);
      else invalidManagerField = true;
    }
    for (const [manager, files] of INIT_MANAGER_LOCKFILES) {
      if (!INIT_WORKSPACE_MANAGERS.includes(manager)) continue;
      for (const file of files) {
        if ((await initRegularFileStats(path.join(directory, file))) !== undefined) {
          managers.add(manager);
          break;
        }
      }
    }
    return {
      managers,
      invalidManagerField,
      invalidManifest: manifest === undefined && manifestRead.kind === "TEXT",
    };
  }
  return undefined;
}

function initJavaScriptModuleSpecifiers(source: string, file?: string): Set<string> {
  const tokens = [...scanJavaScriptTokens(source, file)];
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

async function atomicInitWrite(
  root: string,
  relative: string,
  content: string,
  action: "CREATE" | "REGENERATE",
  installedPaths: readonly string[],
  dependencies: RepositoryInitWriteDependencies = {},
): Promise<void> {
  const target = path.join(root, relative);
  const temporary = path.join(root, `.${relative}.${process.pid}.${Date.now()}.tmp`);
  const openTemporary =
    dependencies.openTemporary ?? ((temporaryPath: string) => open(temporaryPath, "wx"));
  const writeTemporary =
    dependencies.writeTemporary ??
    ((_temporaryPath: string, temporaryContent: string, handle: FileHandle) =>
      handle.writeFile(temporaryContent));
  const renameTemporary = dependencies.renameTemporary ?? rename;
  const linkTemporary = dependencies.linkTemporary ?? link;
  const removeTemporary =
    dependencies.removeTemporary ?? ((temporaryPath: string) => rm(temporaryPath, { force: true }));
  let temporaryOwned = false;
  let temporaryHandle: FileHandle | undefined;
  let temporaryHandleClosed = true;
  let targetInstalled = false;
  try {
    temporaryHandle = await openTemporary(temporary);
    temporaryOwned = true;
    temporaryHandleClosed = false;
    try {
      await writeTemporary(temporary, content, temporaryHandle);
    } finally {
      await temporaryHandle.close();
      temporaryHandleClosed = true;
    }
    if (action === "CREATE") {
      await linkTemporary(temporary, target);
      targetInstalled = true;
      await removeTemporary(temporary);
    } else {
      await renameTemporary(temporary, target);
      targetInstalled = true;
    }
  } catch (error) {
    let temporaryCleanup: "REMOVED" | "UNRESOLVED" | "NOT_OWNED" = "NOT_OWNED";
    if (!temporaryOwned) {
      try {
        await lstat(temporary);
        temporaryCleanup = "UNRESOLVED";
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
          temporaryCleanup = "UNRESOLVED";
        }
      }
    }
    if (temporaryOwned && !temporaryHandleClosed && temporaryHandle !== undefined) {
      try {
        await temporaryHandle.close();
        temporaryHandleClosed = true;
      } catch {
        temporaryCleanup = "UNRESOLVED";
      }
    }
    if (temporaryOwned) {
      temporaryCleanup = "REMOVED";
      try {
        await removeTemporary(temporary);
      } catch {
        temporaryCleanup = "UNRESOLVED";
      }
    }
    throw new RepositoryInitWriteError(error, target, temporary, temporaryCleanup, [
      ...installedPaths,
      ...(targetInstalled ? [target] : []),
    ]);
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
  detections: RepositoryInitDetections | RepositoryInitDetectionsV2,
  reasonCodes: string[],
): RepositoryInitResult | RepositoryInitResultV2 {
  const bunBuiltIn = detections.adapterRecommendation === "bun-test";
  const result = {
    schemaVersion: bunBuiltIn ? "2.0.0" : "1.0.0",
    status,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    detections: { ...detections, reasonCodes: [...new Set(detections.reasonCodes)].sort() },
    actions: [],
    files: [],
    requiredOperatorInputs: ["worlds", "candidates"],
    nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
  };
  return bunBuiltIn ? parseRepositoryInitResultV2(result) : parseRepositoryInitResult(result);
}

export async function initializeRepository(
  requestedRoot: string,
  options: RepositoryInitOptions = {},
  writeDependencies: RepositoryInitWriteDependencies = {},
): Promise<RepositoryInitResult | RepositoryInitResultV2> {
  let root: string;
  try {
    root = await realpath(requestedRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("REPOSITORY_ROOT_NOT_DIRECTORY");
  } catch {
    return initTerminalResult("CONFLICT", initEmptyDetections(["REPOSITORY_ROOT_INVALID"]), [
      "REPOSITORY_ROOT_INVALID",
    ]);
  }

  const declaredExcludes = options.exclude ?? (await configuredRepositoryExcludes(root));
  const repositoryExclude = [...new Set([...DEFAULT_EXCLUDES, ...declaredExcludes])].sort();
  if (
    repositoryExclude.length > 1_000 ||
    options.exclude?.some((entry) => !isRepositoryExcludeName(entry))
  ) {
    return initTerminalResult("CONFLICT", initEmptyDetections(["INVALID_REPOSITORY_EXCLUDE"]), [
      "INVALID_REPOSITORY_EXCLUDE",
    ]);
  }
  const inventoryExcludes = effectiveExcludes([...INIT_MANAGED_FILES, ...repositoryExclude]);

  const candidateRoots = ["tests/candidates"] as const;
  const outsideCandidateRoots = (file: string): boolean =>
    !candidateRoots.some((candidateRoot) => {
      const rootKey = portablePathKey(candidateRoot);
      const fileKey = portablePathKey(file);
      return fileKey === rootKey || fileKey.startsWith(`${rootKey}/`);
    });
  const links: string[] = [];
  const inventory = await walkFiles(root, inventoryExcludes, links);
  // A link is judged against the tests that would run, once the framework is known; one that
  // leaves the root refuses the repository whatever the framework.
  const linkConflict = (
    assessment: RepositoryLinkAssessment,
    detections: RepositoryInitDetections,
  ) => {
    options.onLinkAssessment?.(assessment);
    const code = assessment.refused?.reasonCode;
    const codes = [
      "UNSUPPORTED_REPOSITORY_SYMLINK",
      ...(code === undefined || code === "TEST_CLOSURE_UNSUPPORTED" ? [] : [code]),
    ];
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: codes }, codes);
  };
  for (const link of links) {
    if (await linkEscapesRoot(root, link)) {
      return linkConflict(
        {
          links: [...links],
          refused: { path: link, reasonCode: "REPOSITORY_LINK_ESCAPES_ROOT" },
          omitted: [],
          unbounded: [],
        },
        initEmptyDetections([]),
      );
    }
  }
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
  for (const [manager, files] of INIT_MANAGER_LOCKFILES) {
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
  let packageManager = managerOverride ?? [...managerFacts][0];
  // Only a package that states nothing itself and receives no override looks at its workspace,
  // and only when it is a package: a directory without a manifest is not a workspace member.
  let managerFromWorkspaceRoot = false;
  let workspaceFactsKey = "";
  if (packageManager === undefined && packageDocument !== undefined) {
    const workspace = await initWorkspaceRootFacts(root);
    if (workspace?.invalidManifest === true) {
      return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANIFEST_INVALID"]), [
        "PACKAGE_MANIFEST_INVALID",
      ]);
    }
    if (workspace?.invalidManagerField === true) {
      return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANAGER_INVALID"]), [
        "PACKAGE_MANAGER_INVALID",
      ]);
    }
    if (workspace !== undefined && workspace.managers.size > 1) {
      return initTerminalResult("CONFLICT", initEmptyDetections(["PACKAGE_MANAGER_AMBIGUOUS"]), [
        "PACKAGE_MANAGER_AMBIGUOUS",
      ]);
    }
    packageManager = [...(workspace?.managers ?? [])][0];
    managerFromWorkspaceRoot = packageManager !== undefined;
    workspaceFactsKey = initWorkspaceFactsKey(workspace);
  }
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
      const specifiers = initJavaScriptModuleSpecifiers(content, file);
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

  const frameworkOverride = options.framework ?? (await configuredRepositoryFramework(root));
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

  const linkReasonCodes: string[] = [];
  if (links.length > 0) {
    const assessment = await assessRepositoryLinks(
      root,
      inScopeFiles,
      links,
      frameworkClosureRoots(framework, inScopeFiles),
      async (file) => [await readFile(path.join(root, ...file.split("/")), "utf8")],
      false,
      (file) => frameworkClosureRoots(framework, [file])?.length === 1,
    );
    if (assessment.refused !== undefined) {
      const detections = initEmptyDetections([]);
      detections.packageManager = packageManager;
      detections.framework = framework;
      return linkConflict(assessment, detections);
    }
    options.onLinkAssessment?.(assessment);
    linkReasonCodes.push("REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE");
    if (assessment.unbounded.length > 0) linkReasonCodes.push("TEST_CLOSURE_UNBOUNDED");
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
  let adapter: RepositoryInitConfigV2["adapter"] | undefined;
  let adapterRecommendation: RepositoryInitDetectionsV2["adapterRecommendation"] = "unavailable";
  let adapterEvidencePath: string | undefined;
  // The test command reaches the runner through a task runner and names no test path.
  let indirectCommand = false;
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
    // An indirect command is judged before its operands are read as path filters: a task name
    // that happens to be a directory must not select a partial inventory.
    indirectCommand = testSources.length > 0 && initCommandIsIndirect(testCommand, "node");
    const pathMatchers = indirectCommand
      ? []
      : initCommandPathMatchers(testCommand, testSources, initNodeTestSource);
    const baseTestFiles = indirectCommand
      ? []
      : pathMatchers.length === 0
        ? testSources
        : testSources.filter((file) => pathMatchers.some((matcher) => matcher(file)));
    if (baseTestFiles.length > 0) {
      adapter = { kind: "node-test", executable: "node", baseTestFiles };
      adapterRecommendation = "node-test";
    }
  } else if (framework === "bun:test") {
    // `bun test` answers `vitest` and `@jest/globals` with its own test API: a Bun repository's
    // tests may import either instead of `bun:test`.
    const testSources = inScopeFiles.filter((file) => {
      if (!initBunTestSource(file)) return false;
      const specifiers = initJavaScriptModuleSpecifiers(contents.get(file) ?? "", file);
      return [...BUN_RUNNER_MODULES, "bun:test"].some((name) => specifiers.has(name));
    });
    indirectCommand = testSources.length > 0 && initCommandIsIndirect(testCommand, "bun");
    const pathMatchers = indirectCommand
      ? []
      : initCommandPathMatchers(testCommand, testSources, initBunTestSource);
    const baseTestFiles = indirectCommand
      ? []
      : pathMatchers.length === 0
        ? testSources
        : testSources.filter((file) => pathMatchers.some((matcher) => matcher(file)));
    if (baseTestFiles.length > 0) {
      adapter = { kind: "bun-test", executable: "bun", baseTestFiles };
      adapterRecommendation = "bun-test";
    }
  }

  const reasonCodes = [
    ...(adapter === undefined
      ? [
          framework === "node:test" || framework === "bun:test"
            ? indirectCommand
              ? "TEST_COMMAND_INDIRECT"
              : "BASE_TEST_FILES_UNAVAILABLE"
            : "OFFICIAL_ADAPTER_UNAVAILABLE",
        ]
      : []),
    ...(managerFromWorkspaceRoot ? ["PACKAGE_MANAGER_FROM_WORKSPACE_ROOT"] : []),
    ...linkReasonCodes,
  ].sort();
  const detections: RepositoryInitDetectionsV2 = {
    packageManager,
    framework,
    testCommand,
    ciProviders,
    adapterRecommendation,
    reasonCodes,
  };
  if (adapter === undefined) return initTerminalResult("BLOCKED", detections, reasonCodes);
  if (
    (adapter.kind === "node-test" || adapter.kind === "bun-test") &&
    adapter.baseTestFiles.length > 1_000
  ) {
    const code = "BASE_TEST_FILES_LIMIT_EXCEEDED";
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: [code] }, [code]);
  }
  await options.afterEvidenceSnapshot?.();

  const bunBuiltIn = adapter.kind === "bun-test";
  const configValue = {
    schemaVersion: bunBuiltIn ? "2.0.0" : "1.0.0",
    repository: { root: ".", exclude: repositoryExclude },
    packageManager,
    framework,
    testCommand,
    adapter,
    candidateRoots: [...candidateRoots],
  };
  const config = bunBuiltIn
    ? parseRepositoryInitConfigV2(configValue)
    : parseRepositoryInitConfig(configValue);
  const configContent = initJsonBytes(config);
  if (configContent.length > 16 * 1024 * 1024) {
    const code = "INIT_FILE_CONTENT_LIMIT_EXCEEDED";
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: [code] }, [code]);
  }
  const configDigest =
    config.schemaVersion === "2.0.0"
      ? repositoryInitConfigV2Digest(config)
      : repositoryInitConfigDigest(config);
  const evidenceFiles = inScopeFiles.filter((file) => initEvidenceKind(file) !== undefined);
  if (adapterEvidencePath !== undefined && !evidenceFiles.includes(adapterEvidencePath))
    evidenceFiles.push(adapterEvidencePath);
  if (evidenceFiles.some((file) => file.length > 1_024)) {
    const code = "INIT_EVIDENCE_PATH_LIMIT_EXCEEDED";
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: [code] }, [code]);
  }
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
  let lock: RepositoryInitLock | RepositoryInitLockV2;
  if (bunBuiltIn) {
    const lockBase: Omit<RepositoryInitLockV2, "lockDigest"> = {
      schemaVersion: "2.0.0",
      configDigest,
      detector: { name: "assertledger-init", version: "2.0.0" },
      evidence,
      detections,
    };
    lock = parseRepositoryInitLockV2({
      ...lockBase,
      lockDigest: repositoryInitLockV2Digest(lockBase),
    });
  } else {
    const lockBase: Omit<RepositoryInitLock, "lockDigest"> = {
      schemaVersion: "1.0.0",
      configDigest,
      detector: { name: "assertledger-init", version: "1.0.0" },
      evidence,
      detections: RepositoryInitDetectionsSchema.parse(detections),
    };
    lock = parseRepositoryInitLock({
      ...lockBase,
      lockDigest: repositoryInitLockDigest(lockBase),
    });
  }
  const lockContent = initJsonBytes(lock);
  if (lockContent.length > 16 * 1024 * 1024) {
    const code = "INIT_FILE_CONTENT_LIMIT_EXCEEDED";
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: [code] }, [code]);
  }
  const plannedFiles: RepositoryInitResult["files"] = [
    { path: INIT_CONFIG_FILE, digest: rawSha256(configContent), content: configContent },
    { path: INIT_LOCK_FILE, digest: rawSha256(lockContent), content: lockContent },
  ];

  let finalInScopeFiles: string[];
  const finalLinks: string[] = [];
  try {
    const finalInventory = await walkFiles(root, inventoryExcludes, finalLinks);
    finalInScopeFiles = finalInventory.files.filter(outsideCandidateRoots);
  } catch {
    finalInScopeFiles = [];
  }
  let repositoryChanged =
    JSON.stringify(finalInScopeFiles) !== JSON.stringify(inScopeFiles) ||
    JSON.stringify(finalLinks) !== JSON.stringify(links);
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
  // The inherited manager is evidence outside the root: the facts it came from are read again.
  if (!repositoryChanged && managerFromWorkspaceRoot) {
    repositoryChanged =
      initWorkspaceFactsKey(await initWorkspaceRootFacts(root)) !== workspaceFactsKey;
  }
  if (repositoryChanged) {
    return initTerminalResult(
      "CONFLICT",
      { ...detections, reasonCodes: ["REPOSITORY_CHANGED_DURING_INIT"] },
      ["REPOSITORY_CHANGED_DURING_INIT"],
    );
  }

  const readManaged = async (
    file: string,
  ): Promise<{ kind: "ABSENT" } | { kind: "FILE"; content: string } | { kind: "UNSAFE" }> => {
    const managedPath = path.join(root, file);
    try {
      const metadata = await lstat(managedPath);
      if (!metadata.isFile()) return { kind: "UNSAFE" };
      return { kind: "FILE", content: await readFile(managedPath, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "ABSENT" };
      throw error;
    }
  };
  const configRead = await readManaged(INIT_CONFIG_FILE);
  const lockRead = await readManaged(INIT_LOCK_FILE);
  if (configRead.kind === "UNSAFE" || lockRead.kind === "UNSAFE") {
    return initTerminalResult(
      "CONFLICT",
      { ...detections, reasonCodes: ["INIT_MANAGED_PATH_UNSAFE"] },
      ["INIT_MANAGED_PATH_UNSAFE"],
    );
  }
  const existingConfig = configRead.kind === "FILE" ? configRead.content : undefined;
  const existingLock = lockRead.kind === "FILE" ? lockRead.content : undefined;
  if (existingConfig !== undefined && existingConfig !== configContent) {
    return initTerminalResult("CONFLICT", { ...detections, reasonCodes: ["CONFIG_CONFLICT"] }, [
      "CONFIG_CONFLICT",
    ]);
  }
  if (existingLock !== undefined) {
    let structural: RepositoryInitLock | RepositoryInitLockV2;
    try {
      const value = JSON.parse(existingLock) as unknown;
      structural = parseVersionedRepositoryInitLock(value);
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
    const result = {
      schemaVersion: bunBuiltIn ? "2.0.0" : "1.0.0",
      status: "UNCHANGED",
      reasonCodes: detections.reasonCodes,
      detections,
      actions: [],
      files: plannedFiles,
      requiredOperatorInputs: ["worlds", "candidates"],
      nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
    };
    return bunBuiltIn ? parseRepositoryInitResultV2(result) : parseRepositoryInitResult(result);
  }
  const actions: RepositoryInitResult["actions"] = [];
  if (existingConfig === undefined) actions.push({ kind: "CREATE", path: INIT_CONFIG_FILE });
  if (existingLock === undefined) actions.push({ kind: "CREATE", path: INIT_LOCK_FILE });
  else if (existingLock !== lockContent) actions.push({ kind: "REGENERATE", path: INIT_LOCK_FILE });
  actions.sort((left, right) => left.path.localeCompare(right.path));
  const status = options.dryRun ? "WOULD_CREATE" : "CREATED";
  const resultValue = {
    schemaVersion: bunBuiltIn ? "2.0.0" : "1.0.0",
    status,
    // Only non-blocking link findings can remain here; the contract mirrors the detections.
    reasonCodes: detections.reasonCodes,
    detections,
    actions,
    files: plannedFiles,
    requiredOperatorInputs: ["worlds", "candidates"],
    nextCommands: [{ executable: "assertledger", arguments: ["audit", ".", "--json"] }],
  };
  const result = bunBuiltIn
    ? parseRepositoryInitResultV2(resultValue)
    : parseRepositoryInitResult(resultValue);
  if (!options.dryRun) {
    const installedPaths: string[] = [];
    for (const action of actions) {
      const file = plannedFiles.find((candidate) => candidate.path === action.path);
      if (file === undefined) throw new Error("INIT_PLAN_INCONSISTENT");
      await atomicInitWrite(
        root,
        file.path,
        file.content,
        action.kind,
        installedPaths,
        writeDependencies,
      );
      if (action.kind === "CREATE") installedPaths.push(path.join(root, file.path));
    }
  }
  return result;
}

async function probeRuntimeTemporaryWorkspace(): Promise<void> {
  let temporaryRoot: string | undefined;
  let failure: unknown;
  try {
    temporaryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "assertledger-runtime-doctor-")),
    );
    await writeFile(path.join(temporaryRoot, "permission-probe"), "assertledger\n", {
      flag: "wx",
    });
  } catch (error) {
    failure = error;
  }
  if (temporaryRoot !== undefined) {
    try {
      await removeTemporaryDirectory(temporaryRoot);
      let removed = false;
      try {
        await lstat(temporaryRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") removed = true;
        else failure ??= error;
      }
      if (!removed) failure ??= new Error("RUNTIME_TEMPORARY_WORKSPACE_CLEANUP_FAILED");
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

export async function doctorRepositoryRuntime(
  requestedRoot: string,
  options: RuntimeDoctorOptions,
): Promise<RuntimeDoctorResult | RuntimeDoctorResultV2> {
  const repositoryRoot = path.resolve(requestedRoot);
  const configuration = options.allowUnsafeExecution
    ? await initializeRepository(repositoryRoot, { dryRun: true })
    : undefined;
  if (
    configuration?.schemaVersion === "2.0.0" &&
    configuration.detections.adapterRecommendation === "bun-test"
  ) {
    const configFile = configuration.files.find((file) => file.path === INIT_CONFIG_FILE);
    if (configFile === undefined) throw new Error("BUN_TEST_CONFIG_MISSING");
    const config = parseRepositoryInitConfigV2(JSON.parse(configFile.content));
    const environmentAllowlist = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"];
    let resolvedExecutable = config.adapter.executable;
    return runBunRuntimeDoctorChecks(repositoryRoot, configuration, {
      probeExecutable: async () => {
        const identity = await probeBunTestExecutable(
          config.adapter.executable,
          repositoryRoot,
          environmentAllowlist,
          5_000,
          CONTROLLED_REPORT_MAXIMUM_BYTES,
        );
        resolvedExecutable = identity.resolvedExecutable;
        return { bunVersion: identity.bunVersion };
      },
      probeDependencies: async () => {
        const result = await runProcess({
          executable: resolvedExecutable,
          args: ["-e", 'import("bun:test").then(() => process.stdout.write("READY"))'],
          cwd: repositoryRoot,
          environment: environmentFromAllowlist(environmentAllowlist),
          timeoutMs: 5_000,
          maximumOutputBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
        });
        if (
          result.outcome !== "PASS" ||
          result.stdout.text !== "READY" ||
          result.stderr.totalBytes !== 0
        ) {
          throw new Error("BUN_TEST_DEPENDENCY_UNAVAILABLE");
        }
      },
      probeTemporaryWorkspace: probeRuntimeTemporaryWorkspace,
      runSyntheticPreflight: async () => {
        await runBunTestRuntimePreflight(
          localBunDriverExecutor(
            resolvedExecutable,
            environmentAllowlist,
            5_000,
            CONTROLLED_REPORT_MAXIMUM_BYTES,
          ),
        );
      },
    });
  }
  let resolvedExecutable = process.execPath;
  return runRuntimeDoctorChecks(repositoryRoot, options.allowUnsafeExecution, {
    inspectConfiguration: async () => {
      const inspected =
        configuration ?? (await initializeRepository(repositoryRoot, { dryRun: true }));
      if (inspected.schemaVersion !== "1.0.0") throw new Error("RUNTIME_CONFIGURATION_UNAVAILABLE");
      return inspected;
    },
    probeExecutable: async () => {
      const identity = await probeNodeTestExecutable(
        process.execPath,
        repositoryRoot,
        [],
        5_000,
        CONTROLLED_REPORT_MAXIMUM_BYTES,
      );
      resolvedExecutable = identity.resolvedExecutable;
      return { nodeVersion: identity.nodeVersion };
    },
    probeDependencies: async () => {
      const dependencyProbe = await runProcess({
        executable: resolvedExecutable,
        args: [
          "-e",
          'import("node:test").then(() => process.exit(0)).catch(() => process.exit(1))',
        ],
        cwd: repositoryRoot,
        environment: environmentFromAllowlist([]),
        timeoutMs: 5_000,
        maximumOutputBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
      });
      if (
        dependencyProbe.outcome !== "PASS" ||
        dependencyProbe.stdout.totalBytes !== 0 ||
        dependencyProbe.stderr.totalBytes !== 0
      ) {
        throw new Error("NODE_TEST_DEPENDENCY_UNAVAILABLE");
      }
    },
    probeTemporaryWorkspace: probeRuntimeTemporaryWorkspace,
    runSyntheticPreflight: async () => {
      await runNodeTestRuntimePreflight({
        executable: resolvedExecutable,
        reporterSource: NODE_TEST_REPORTER_SOURCE,
        environment: environmentFromAllowlist([]),
        timeoutMs: 5_000,
        maximumOutputBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
        processRunner: runProcess,
      });
    },
  });
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

export interface RepositoryAnalysisOptions {
  /** Also skip a valid configuration's names; campaign inventories never pass this. */
  configuredExcludes?: boolean;
  /** Explicit snapshotted names override configuration for audit inventory consistency. */
  excludes?: readonly string[];
}

export async function analyzeRepository(
  rootInput: string,
  options: RepositoryAnalysisOptions = {},
): Promise<unknown> {
  const root = await resolveRepositoryRoot(rootInput);
  const declaredExcludes =
    options.excludes ??
    (options.configuredExcludes === true ? await configuredRepositoryExcludes(root) : []);
  const { files } = await walkFiles(root, effectiveExcludes(declaredExcludes));
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

export class RepositoryAuditInventoryError extends Error {
  constructor(
    message: string,
    readonly appliedExcludes: RepositoryAuditV2["appliedExcludes"],
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "RepositoryAuditInventoryError";
  }
}

type AuditFile = RepositoryAuditV2["files"][number];
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

function auditAst(
  text: string,
  file: string,
): {
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
  for (const token of scanJavaScriptTokens(text, file)) {
    const { kind } = token;
    if (kind === SyntaxKind.Identifier) identifiers.add(token.value);
    if (decisionKinds.has(kind)) decisionPoints += 1;
    lexicalTokens.push(
      kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        kind === SyntaxKind.TemplateHead ||
        kind === SyntaxKind.TemplateMiddle ||
        kind === SyntaxKind.TemplateTail
        ? '"__LITERAL__"'
        : token.text,
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
): Promise<RepositoryAuditV2> {
  const root = await resolveRepositoryRoot(rootInput);
  let verificationRequest: VerificationRequestContract | null = null;
  let declaredExcludes: readonly string[] = [];
  let source: RepositoryAuditV2["appliedExcludes"]["source"] = "defaults";
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
    declaredExcludes = verificationRequest.repository.exclude;
    source = "request";
  } else {
    try {
      const configPath = path.join(root, INIT_CONFIG_FILE);
      if ((await lstat(configPath)).isFile()) {
        const config = parseVersionedRepositoryInitConfig(
          JSON.parse(await readFile(configPath, "utf8")),
        );
        declaredExcludes = config.repository.exclude;
        source = "config";
      }
    } catch {
      /* Invalid configurations retain the default inventory. */
    }
  }
  const appliedExcludes = { source, entries: [...effectiveExcludes(declaredExcludes)].sort() };
  const inventory = async () => {
    try {
      return (await analyzeRepository(root, { excludes: appliedExcludes.entries })) as {
        repositoryDigest: string;
        files: string[];
      };
    } catch (error) {
      if (error instanceof Error && error.message === "UNSUPPORTED_REPOSITORY_SYMLINK") {
        throw new RepositoryAuditInventoryError(error.message, appliedExcludes, error.cause);
      }
      throw error;
    }
  };
  const initial = await inventory();
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
    const ast = auditAst(content.toString("utf8"), file);
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

  if (verificationRequest === null) reasonCodes.add("VERIFICATION_REQUEST_UNAVAILABLE");

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
  const final = await inventory();
  if (final.repositoryDigest !== initial.repositoryDigest)
    throw new Error("REPOSITORY_CHANGED_DURING_AUDIT");
  return parseRepositoryAuditV2({
    schemaVersion: "2.0.0",
    appliedExcludes,
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
  const request = parseVersionedVerificationRequest(value) as unknown as JsonRecord;
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
  if (
    adapter.kind !== "node-test" &&
    adapter.kind !== "bun-test" &&
    adapter.kind !== "bun-test-designated" &&
    adapter.kind !== "testforge-command"
  ) {
    throw new TypeError("UNSUPPORTED_ADAPTER");
  }
  // The versioned contract already restricts container isolation to v2 requests.
  const containerIsolation =
    isolation.kind === "container"
      ? (() => {
          const parsed = isolation as unknown as ContainerIsolation;
          return {
            kind: "container" as const,
            image: parsed.image,
            environment: parsed.environment.map(({ name, value }) => ({ name, value })),
            limits: { ...parsed.limits },
          };
        })()
      : undefined;
  if (containerIsolation === undefined) {
    if (isolation.kind !== "trusted-local" && isolation.kind !== "windows-native") {
      throw new TypeError("UNSUPPORTED_ISOLATION");
    }
    if (isolation.acknowledgedUnsafeExecution !== true) {
      throw new Error(
        isolation.kind === "windows-native"
          ? "WINDOWS_NATIVE_EXECUTION_NOT_ACKNOWLEDGED"
          : "UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED",
      );
    }
    // The declared level names a Windows host; it is never claimed for any other platform.
    if (isolation.kind === "windows-native" && process.platform !== "win32") {
      throw new Error("WINDOWS_NATIVE_HOST_REQUIRED");
    }
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
    if (candidate.test !== undefined) {
      const test = requireRecord(candidate.test, "designated_test");
      let file: string;
      try {
        file = assertSafeRelativePath(
          requireString(test.file, "designated_test_file"),
          candidateRoots,
        );
      } catch {
        throw new Error("FORBIDDEN_CANDIDATE_PATH");
      }
      return {
        id: requireString(candidate.id, "candidate_id"),
        files: [],
        designated: {
          file,
          path: requireStringArray(test.path, "designated_test_path"),
          expectedFailure:
            candidate.expectedFailure === null
              ? null
              : requireString(candidate.expectedFailure, "expected_failure"),
        },
      };
    }
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
  const environmentAllowlist =
    containerIsolation === undefined
      ? requireStringArray(isolation.environmentAllowlist, "environment_allowlist")
      : [];
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
    adapter.kind === "node-test" || adapter.kind === "bun-test"
      ? (() => {
          const extraArguments =
            adapter.kind === "node-test"
              ? parseNodeTestExtraArguments(adapter.extraArguments)
              : undefined;
          const baseTestFiles = requireStringArray(adapter.baseTestFiles, "base_test_files").map(
            (file) => assertSafeRelativePath(file, ["."]),
          );
          assertPortableStringCollection(baseTestFiles, "DUPLICATE_BASE_TEST_FILE");
          return {
            kind: adapter.kind,
            executable: requireString(adapter.executable, "adapter_executable"),
            baseTestFiles,
            ...(extraArguments === undefined ? {} : { extraArguments }),
          };
        })()
      : adapter.kind === "bun-test-designated"
        ? {
            kind: "bun-test-designated",
            executable: requireString(adapter.executable, "adapter_executable"),
            testTimeoutMs:
              adapter.testTimeoutMs === null || adapter.testTimeoutMs === undefined
                ? null
                : requirePositiveInteger(adapter.testTimeoutMs, "adapter_test_timeout_ms"),
            workingDirectory:
              adapter.workingDirectory === "test-package" ? "test-package" : "repository-root",
            isolate: adapter.isolate === true,
            trustedMatchers: (Array.isArray(adapter.trustedMatchers)
              ? adapter.trustedMatchers
              : []
            ).map((value) => {
              const entry = requireRecord(value, "trusted_matcher");
              let trustedPath: string;
              try {
                trustedPath = assertSafeRelativePath(
                  requireString(entry.path, "trusted_matcher_path"),
                  ["."],
                );
              } catch {
                throw new Error("TRUSTED_MATCHER_PATH_INVALID", { cause: entry.path });
              }
              return {
                path: trustedPath,
                matchers: [
                  ...new Set(requireStringArray(entry.matchers, "trusted_matchers")),
                ].sort(),
              };
            }),
          }
        : {
            kind: "testforge-command",
            executable: requireString(adapter.executable, "adapter_executable"),
            arguments: requireStringArray(adapter.arguments, "adapter_arguments"),
            protocolVersion: "1.0.0",
          };
  // A designated test runs with the same bytes in every world: no world may overlay it.
  const designatedFiles = new Set(
    candidates.flatMap((candidate) =>
      candidate.designated === undefined ? [] : [portablePathKey(candidate.designated.file)],
    ),
  );
  if (
    worlds.some((world) =>
      world.files.some((file) => designatedFiles.has(portablePathKey(file.path))),
    )
  ) {
    throw new Error("DESIGNATED_TEST_OVERLAID");
  }
  const includeDependencies = repository.includeDependencies === true;
  const exclude = requireStringArray(repository.exclude, "repository_exclude");
  if (includeDependencies && exclude.some((entry) => portablePathKey(entry) === "node_modules")) {
    throw new Error("REPOSITORY_DEPENDENCIES_EXCLUDED");
  }
  const include = (Array.isArray(repository.include) ? repository.include : []).map((entry) => {
    try {
      return assertSafeRelativePath(requireString(entry, "repository_include"), ["."]);
    } catch {
      throw new Error("REPOSITORY_INCLUDE_INVALID", { cause: entry });
    }
  });
  assertPortableStringCollection(include, "DUPLICATE_REPOSITORY_INCLUDE");
  return {
    schemaVersion: requireString(request.schemaVersion, "schema_version"),
    repository: {
      root: requireString(repository.root, "repository_root"),
      exclude,
      includeDependencies,
      git: repository.git === "synthesized" ? "synthesized" : "excluded",
      snapshot: repository.snapshot === "test-closure" ? "test-closure" : "repository",
      include: [...include].sort(),
    },
    adapter: normalizedAdapter,
    isolation: containerIsolation ?? {
      kind: isolation.kind === "windows-native" ? "windows-native" : "trusted-local",
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

function readBunDriverReport(processResult: ProcessResult): StructuredCommandReport | undefined {
  if (
    processResult.outcome === "TIMEOUT" ||
    processResult.outcome === "INFRA_ERROR" ||
    processResult.stdout.truncated ||
    processResult.stdout.totalBytes > CONTROLLED_REPORT_MAXIMUM_BYTES
  )
    return undefined;
  try {
    return parseStructuredCommandReport(JSON.parse(processResult.stdout.text), processResult);
  } catch {
    return undefined;
  }
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

interface BunExecutableIdentity {
  requestedExecutable: string;
  resolvedExecutable: string;
  executableDigest: string;
  bunVersion: string;
  bunRevision: string;
}

async function runBunExecutableProbe(
  executable: string,
  repositoryRoot: string,
  environmentAllowlist: string[],
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<{ execPath: string; bunVersion: string; bunRevision: string }> {
  const result = await runProcess({
    executable,
    args: [
      "-e",
      "console.log(JSON.stringify({execPath:process.execPath,bunVersion:Bun.version,bunRevision:Bun.revision}))",
    ],
    cwd: repositoryRoot,
    environment: environmentFromAllowlist(environmentAllowlist),
    timeoutMs: Math.min(timeoutMs, 5_000),
    maximumOutputBytes: Math.min(maximumOutputBytes, CONTROLLED_REPORT_MAXIMUM_BYTES),
  });
  if (result.outcome !== "PASS" || result.stdout.truncated || result.stderr.totalBytes !== 0) {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  let report: unknown;
  try {
    report = JSON.parse(result.stdout.text.trim()) as unknown;
  } catch {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (
    !isRecord(report) ||
    Object.keys(report).sort().join("\0") !== "bunRevision\0bunVersion\0execPath" ||
    typeof report.execPath !== "string" ||
    report.execPath.length === 0 ||
    typeof report.bunVersion !== "string" ||
    typeof report.bunRevision !== "string"
  ) {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (
    report.bunVersion !== BUN_TEST_ADAPTER_PROFILE.bunVersion ||
    report.bunRevision !== BUN_TEST_ADAPTER_PROFILE.bunRevision
  ) {
    throw new Error("BUN_TEST_VERSION_UNSUPPORTED");
  }
  return {
    execPath: report.execPath,
    bunVersion: report.bunVersion,
    bunRevision: report.bunRevision,
  };
}

async function probeBunTestExecutable(
  requestedExecutable: string,
  repositoryRoot: string,
  environmentAllowlist: string[],
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<BunExecutableIdentity> {
  const first = await runBunExecutableProbe(
    requestedExecutable,
    repositoryRoot,
    environmentAllowlist,
    timeoutMs,
    maximumOutputBytes,
  );
  let resolvedExecutable: string;
  try {
    resolvedExecutable = await realpath(first.execPath);
    if (!(await stat(resolvedExecutable)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  const second = await runBunExecutableProbe(
    resolvedExecutable,
    repositoryRoot,
    environmentAllowlist,
    timeoutMs,
    maximumOutputBytes,
  );
  if (
    (await realpath(second.execPath)) !== resolvedExecutable ||
    second.bunVersion !== first.bunVersion ||
    second.bunRevision !== first.bunRevision
  ) {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  return {
    requestedExecutable,
    resolvedExecutable,
    executableDigest: await sha256File(resolvedExecutable),
    bunVersion: second.bunVersion,
    bunRevision: second.bunRevision,
  };
}

// Evaluated by `node -p` inside a fresh container before any candidate code runs there.
const CONTAINER_NODE_PROBE_SOURCE =
  '(() => { const fs = require("node:fs"); const crypto = require("node:crypto"); const execPath = fs.realpathSync(process.execPath); return JSON.stringify({ digest: "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(execPath)).digest("hex"), execPath, node: process.versions.node }); })()';

function parseJsonBytes(bytes: Buffer | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function withEmptyWorkspace<T>(operation: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "assertledger-container-probe-")),
  );
  try {
    return await operation(workspace);
  } finally {
    await removeTemporaryDirectory(workspace);
  }
}

async function runContainerNodeProbe(
  container: ContainerBackend,
  executable: string,
  workspace: string,
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<{ execPath: string; nodeVersion: string; executableDigest: string }> {
  const { process: result } = await runContainerExecution(
    { ...container, traceContext: { kind: "identity", probe: "node" } },
    {
      workspace,
      executable,
      args: ["-p", CONTAINER_NODE_PROBE_SOURCE],
      environment: {},
      timeoutMs: Math.min(timeoutMs, 30_000),
      maximumOutputBytes: Math.min(maximumOutputBytes, CONTROLLED_REPORT_MAXIMUM_BYTES),
    },
    runBoundedProcess,
    os.tmpdir(),
  );
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
    Object.keys(report).sort().join("\0") !== "digest\0execPath\0node" ||
    typeof report.execPath !== "string" ||
    !report.execPath.startsWith("/") ||
    typeof report.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(report.digest) ||
    typeof report.node !== "string"
  ) {
    throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (!nodeVersionIsSupported(report.node)) throw new Error("NODE_TEST_VERSION_UNSUPPORTED");
  return { execPath: report.execPath, nodeVersion: report.node, executableDigest: report.digest };
}

async function probeContainerNodeExecutable(
  container: ContainerBackend,
  requestedExecutable: string,
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<NodeExecutableIdentity> {
  return withEmptyWorkspace(async (workspace) => {
    const firstProbe = await runContainerNodeProbe(
      container,
      requestedExecutable,
      workspace,
      timeoutMs,
      maximumOutputBytes,
    );
    const secondProbe = await runContainerNodeProbe(
      container,
      firstProbe.execPath,
      workspace,
      timeoutMs,
      maximumOutputBytes,
    );
    if (
      secondProbe.execPath !== firstProbe.execPath ||
      secondProbe.nodeVersion !== firstProbe.nodeVersion ||
      secondProbe.executableDigest !== firstProbe.executableDigest
    ) {
      throw new Error("NODE_TEST_EXECUTABLE_PROBE_FAILED");
    }
    return {
      requestedExecutable,
      resolvedExecutable: firstProbe.execPath,
      executableDigest: firstProbe.executableDigest,
      nodeVersion: firstProbe.nodeVersion,
    };
  });
}

function containerPreflightExecutor(
  container: ContainerBackend,
  executable: string,
): NodeTestPreflightProbeExecutor {
  return (probe) =>
    withEmptyWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "control.test.mjs"), probe.controlSource, {
        flag: "wx",
      });
      await writeFile(path.join(workspace, `${probe.name}.test.mjs`), probe.candidateSource, {
        flag: "wx",
      });
      const candidate = `${CONTAINER_WORKSPACE}/${probe.name}.test.mjs`;
      const executed = await runContainerExecution(
        { ...container, traceContext: { kind: "preflight", probe: probe.name } },
        {
          workspace,
          reporterSource: probe.reporterSource,
          executable,
          args: [
            "--test",
            `--test-reporter=file://${CONTAINER_REPORTER_FILE}`,
            `--test-reporter-destination=${CONTAINER_RESULT_FILE}`,
            "--",
            `${CONTAINER_WORKSPACE}/control.test.mjs`,
            candidate,
          ],
          environment: { TESTFORGE_NODE_CANDIDATE_FILES: JSON.stringify([candidate]) },
          timeoutMs: probe.timeoutMs,
          maximumOutputBytes: probe.maximumOutputBytes,
          resultMaximumBytes: probe.reportMaximumBytes,
        },
        runBoundedProcess,
        os.tmpdir(),
      );
      return {
        processResult: {
          outcome: executed.process.outcome,
          exitCode: executed.process.exitCode,
        },
        report: parseJsonBytes(executed.result),
      };
    });
}

interface AdapterExecution {
  result: ProcessResult;
  structuredReport: StructuredCommandReport | undefined;
  nodeTestReport: NodeTestReport | undefined;
}

const CONTAINER_BUN_PROBE_SOURCE =
  'const fs = require("node:fs"); const crypto = require("node:crypto"); const execPath = fs.realpathSync(process.execPath); console.log(JSON.stringify({ digest: "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(execPath)).digest("hex"), execPath, bunVersion: Bun.version, bunRevision: Bun.revision }));';

async function runContainerBunProbe(
  container: ContainerBackend,
  executable: string,
  workspace: string,
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<{
  execPath: string;
  bunVersion: string;
  bunRevision: string;
  executableDigest: string;
}> {
  const { process: result } = await runContainerExecution(
    { ...container, traceContext: { kind: "identity", probe: "bun" } },
    {
      workspace,
      executable,
      args: ["-e", CONTAINER_BUN_PROBE_SOURCE],
      environment: {},
      timeoutMs: Math.min(timeoutMs, 30_000),
      maximumOutputBytes: Math.min(maximumOutputBytes, CONTROLLED_REPORT_MAXIMUM_BYTES),
    },
    runBoundedProcess,
    os.tmpdir(),
  );
  if (result.outcome !== "PASS" || result.stdout.truncated || result.stderr.totalBytes > 0) {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  let report: unknown;
  try {
    report = JSON.parse(result.stdout.text.trim()) as unknown;
  } catch {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (
    !isRecord(report) ||
    Object.keys(report).sort().join("\0") !== "bunRevision\0bunVersion\0digest\0execPath" ||
    typeof report.execPath !== "string" ||
    !report.execPath.startsWith("/") ||
    typeof report.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(report.digest) ||
    typeof report.bunVersion !== "string" ||
    typeof report.bunRevision !== "string"
  ) {
    throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
  }
  if (
    report.bunVersion !== BUN_TEST_ADAPTER_PROFILE.bunVersion ||
    report.bunRevision !== BUN_TEST_ADAPTER_PROFILE.bunRevision
  ) {
    throw new Error("BUN_TEST_VERSION_UNSUPPORTED");
  }
  return {
    execPath: report.execPath,
    bunVersion: report.bunVersion,
    bunRevision: report.bunRevision,
    executableDigest: report.digest,
  };
}

/** Resolves the image's Bun twice, as the local probe does, and binds its digest. */
async function probeContainerBunExecutable(
  container: ContainerBackend,
  requestedExecutable: string,
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<BunExecutableIdentity> {
  return withEmptyWorkspace(async (workspace) => {
    const first = await runContainerBunProbe(
      container,
      requestedExecutable,
      workspace,
      timeoutMs,
      maximumOutputBytes,
    );
    const second = await runContainerBunProbe(
      container,
      first.execPath,
      workspace,
      timeoutMs,
      maximumOutputBytes,
    );
    if (
      second.execPath !== first.execPath ||
      second.bunVersion !== first.bunVersion ||
      second.bunRevision !== first.bunRevision ||
      second.executableDigest !== first.executableDigest
    ) {
      throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
    }
    return {
      requestedExecutable,
      resolvedExecutable: first.execPath,
      executableDigest: first.executableDigest,
      bunVersion: first.bunVersion,
      bunRevision: first.bunRevision,
    };
  });
}

/** The driver, its preload and the assertion helper, as one container asset set. */
async function bunContainerAssets(): Promise<Array<{ name: string; content: string }>> {
  return [
    { name: "driver.mjs", content: await readFile(BUN_TEST_DRIVER_PATH, "utf8") },
    { name: "preload.mjs", content: await readFile(BUN_TEST_PRELOAD_PATH, "utf8") },
    { name: "assertions.mjs", content: await readFile(BUN_TEST_HELPER_PATH, "utf8") },
  ];
}

/** Runs the Bun driver under the image's own Bun; the report comes back as result.json only. */
async function runContainerBunDriver(
  container: ContainerBackend,
  workspace: string,
  executable: string,
  files: readonly string[],
  environment: Record<string, string>,
  timeoutMs: number,
  maximumOutputBytes: number,
): Promise<{ result: ProcessResult; report: StructuredCommandReport | undefined }> {
  const executed = await runContainerExecution(
    container,
    {
      workspace,
      assets: await bunContainerAssets(),
      executable,
      args: [
        `${CONTAINER_ASSET_DIRECTORY}/driver.mjs`,
        executable,
        `${CONTAINER_ASSET_DIRECTORY}/assertions.mjs`,
        ...files,
      ],
      environment: { ...environment, ASSERTLEDGER_BUN_RESULT_FILE: CONTAINER_RESULT_FILE },
      timeoutMs,
      maximumOutputBytes,
      resultMaximumBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
    },
    runBoundedProcess,
    os.tmpdir(),
  );
  const result = executed.process;
  const document =
    result.outcome === "TIMEOUT" || result.outcome === "INFRA_ERROR"
      ? undefined
      : parseJsonBytes(executed.result);
  return { result, report: parseStructuredCommandReport(document, result) };
}

async function executeContainerBunAdapter(
  request: VerificationRequest,
  container: ContainerBackend,
  workspace: string,
  candidate: Candidate | null,
  candidateFiles: string[],
): Promise<AdapterExecution> {
  const adapter = request.adapter;
  if (adapter.kind !== "bun-test" && adapter.kind !== "bun-test-designated") {
    throw new Error("UNSUPPORTED_ADAPTER");
  }
  const { result, report } = await runContainerBunDriver(
    container,
    workspace,
    adapter.executable,
    adapter.kind === "bun-test" ? adapter.baseTestFiles : designatedFiles(request, candidate),
    adapter.kind === "bun-test"
      ? { TESTFORGE_CANDIDATE_FILES: JSON.stringify(candidateFiles) }
      : { ASSERTLEDGER_BUN_DESIGNATED: JSON.stringify(designatedSelection(request, candidate)) },
    request.budgets.timeoutMsPerExecution,
    request.budgets.maximumOutputBytes,
  );
  return { result, structuredReport: report, nodeTestReport: undefined };
}

async function executeContainerAdapter(
  request: VerificationRequest,
  container: ContainerBackend,
  workspace: string,
  candidate: Candidate | null,
  candidateFiles: string[],
): Promise<AdapterExecution> {
  const adapter = request.adapter;
  if (adapter.kind === "bun-test" || adapter.kind === "bun-test-designated") {
    return executeContainerBunAdapter(request, container, workspace, candidate, candidateFiles);
  }
  const executed = await runContainerExecution(
    container,
    {
      workspace,
      ...(adapter.kind === "node-test" ? { reporterSource: NODE_TEST_REPORTER_SOURCE } : {}),
      executable: adapter.executable,
      args:
        adapter.kind === "node-test"
          ? [
              "--test",
              `--test-reporter=file://${CONTAINER_REPORTER_FILE}`,
              `--test-reporter-destination=${CONTAINER_RESULT_FILE}`,
              ...(adapter.extraArguments ?? []),
              "--",
              ...adapter.baseTestFiles,
              ...candidateFiles,
            ]
          : adapter.arguments,
      environment:
        adapter.kind === "node-test"
          ? {
              TESTFORGE_NODE_CANDIDATE_FILES: JSON.stringify(
                candidateFiles.map((file) => `${CONTAINER_WORKSPACE}/${file}`),
              ),
            }
          : {
              TESTFORGE_RESULT_FILE: CONTAINER_RESULT_FILE,
              TESTFORGE_CANDIDATE_FILES: JSON.stringify(candidateFiles),
            },
      timeoutMs: request.budgets.timeoutMsPerExecution,
      maximumOutputBytes: request.budgets.maximumOutputBytes,
      resultMaximumBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
    },
    runBoundedProcess,
    os.tmpdir(),
  );
  const result = executed.process;
  const document =
    result.outcome === "TIMEOUT" || result.outcome === "INFRA_ERROR"
      ? undefined
      : parseJsonBytes(executed.result);
  return {
    result,
    structuredReport:
      adapter.kind === "testforge-command"
        ? parseStructuredCommandReport(document, result)
        : undefined,
    nodeTestReport: adapter.kind === "node-test" ? parseNodeTestReport(document) : undefined,
  };
}

function trustedLocalEnvironmentAllowlist(request: VerificationRequest): string[] {
  return request.isolation.kind === "container" ? [] : request.isolation.environmentAllowlist;
}

/** The snapshot exclusions: the defaults and the request's names, keeping dependencies on request. */
function campaignExcludes(request: VerificationRequest): Set<string> {
  const excludes = effectiveExcludes(request.repository.exclude);
  if (request.repository.includeDependencies) excludes.delete(portablePathKey("node_modules"));
  return excludes;
}

/** A workspace copy keeps the snapshot's synthesized Git metadata; the source's own never enters. */
function workspaceExcludes(request: VerificationRequest): Set<string> {
  const excludes = campaignExcludes(request);
  if (request.repository.git === "synthesized") excludes.delete(portablePathKey(".git"));
  return excludes;
}

/**
 * Commits the snapshot once into a fresh repository with a fixed identity and date, no template,
 * hooks or global configuration, honoring the snapshot's own .gitignore. Returns the tree identity.
 */
async function synthesizeGitWorktree(
  snapshot: string,
): Promise<{ mode: "synthesized"; treeId: string; gitVersion: string }> {
  // An empty file outside the snapshot: Git for Windows cannot open os.devNull as a config file.
  const globalConfig = path.join(path.dirname(snapshot), "git-global-config");
  await writeFile(globalConfig, "", { flag: "wx" });
  const environment = {
    ...environmentFromAllowlist(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: "AssertLedger",
    GIT_AUTHOR_EMAIL: "snapshot@assertledger.invalid",
    GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "AssertLedger",
    GIT_COMMITTER_EMAIL: "snapshot@assertledger.invalid",
    GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
  };
  const git = async (args: string[]): Promise<string> => {
    const result = await runProcess({
      executable: "git",
      args: [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        "core.fileMode=false",
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      cwd: snapshot,
      environment,
      timeoutMs: 600_000,
      maximumOutputBytes: CONTROLLED_REPORT_MAXIMUM_BYTES,
    });
    if (result.outcome !== "PASS" || result.stdout.truncated) {
      throw new Error("REPOSITORY_GIT_SYNTHESIS_FAILED", {
        cause: result.stderr.text.slice(0, 500),
      });
    }
    return result.stdout.text.trim();
  };
  const gitVersion = await git(["--version"]);
  await git(["init", "--quiet", "--template="]);
  await git(["add", "--all"]);
  await git([
    "commit",
    "--quiet",
    "--no-verify",
    "--allow-empty",
    "--message",
    "AssertLedger snapshot",
  ]);
  const treeId = await git(["rev-parse", "HEAD^{tree}"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(treeId)) {
    throw new Error("REPOSITORY_GIT_SYNTHESIS_FAILED");
  }
  return { mode: "synthesized", treeId, gitVersion };
}

/** The selection a designated campaign gives the Bun driver: load every test, or run one. */
function designatedSelection(request: VerificationRequest, candidate: Candidate | null): unknown {
  const adapter = request.adapter.kind === "bun-test-designated" ? request.adapter : undefined;
  const execution = {
    workingDirectory: adapter?.runDirectory ?? ".",
    isolate: adapter?.isolate ?? false,
    trustedMatchers: adapter?.resolvedTrustedMatchers ?? [],
  };
  if (candidate !== null) {
    const designated = candidate.designated;
    if (designated === undefined) throw new Error("DESIGNATED_CANDIDATE_REQUIRED");
    return {
      mode: "run",
      test: { file: designated.file, path: designated.path },
      expectedFailure: designated.expectedFailure,
      testTimeoutMs: adapter?.testTimeoutMs ?? null,
      ...execution,
    };
  }
  return {
    mode: "load",
    tests: request.candidates.map((entry) => {
      if (entry.designated === undefined) throw new Error("DESIGNATED_CANDIDATE_REQUIRED");
      return { file: entry.designated.file, path: entry.designated.path };
    }),
    ...execution,
  };
}

/** The nearest directory above `file`, up to the root, whose package.json the snapshot holds. */
function nearestPackageDirectory(file: string, snapshotFiles: ReadonlySet<string>): string {
  let directory = path.posix.dirname(file);
  while (directory !== ".") {
    if (snapshotFiles.has(portablePathKey(`${directory}/package.json`))) return directory;
    directory = path.posix.dirname(directory);
  }
  return ".";
}

type DesignatedBunConfig = (source: string | undefined, preload: string) => string;

/**
 * Fixes where a designated campaign runs Bun before any execution: the repository root, or the
 * one package holding every designated test. The bunfig there, in the snapshot and in each world,
 * must let the driver put AssertLedger's preload first; each trusted path must exist and is read
 * through the snapshot's links, as Bun reports module files by their real paths.
 */
async function prepareDesignatedRun(
  request: VerificationRequest,
  snapshot: string,
  snapshotFiles: ReadonlySet<string>,
): Promise<string> {
  const adapter = request.adapter;
  if (adapter.kind !== "bun-test-designated") throw new Error("UNSUPPORTED_ADAPTER");
  const directories = new Set(
    request.candidates.map((candidate) =>
      adapter.workingDirectory === "test-package" && candidate.designated !== undefined
        ? nearestPackageDirectory(candidate.designated.file, snapshotFiles)
        : ".",
    ),
  );
  if (directories.size !== 1) throw new Error("DESIGNATED_WORKING_DIRECTORY_MIXED");
  const runDirectory = [...directories][0] as string;
  const bunfig = runDirectory === "." ? "bunfig.toml" : `${runDirectory}/bunfig.toml`;
  const { designatedBunConfig } = (await import(pathToFileURL(BUN_TEST_DRIVER_PATH).href)) as {
    designatedBunConfig: DesignatedBunConfig;
  };
  const texts: Array<string | undefined> = [];
  try {
    const details = await lstat(path.join(snapshot, ...bunfig.split("/")));
    if (!details.isFile()) throw new Error("BUNFIG_TEST_PRELOAD_UNSUPPORTED", { cause: bunfig });
    texts.push(await readFile(path.join(snapshot, ...bunfig.split("/")), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("BUNFIG_TEST_PRELOAD_UNSUPPORTED", { cause: bunfig });
    }
    texts.push(undefined);
  }
  for (const world of request.worlds) {
    for (const file of world.files) {
      if (portablePathKey(file.path) === portablePathKey(bunfig)) texts.push(file.content);
    }
  }
  for (const text of texts) {
    try {
      designatedBunConfig(text, "/assertledger/preload.mjs");
    } catch {
      throw new Error("BUNFIG_TEST_PRELOAD_UNSUPPORTED", { cause: bunfig });
    }
  }
  const resolvedTrustedMatchers = [];
  for (const entry of adapter.trustedMatchers) {
    let resolved: string | undefined;
    try {
      resolved = relativeWithin(
        snapshot,
        await realpath(path.join(snapshot, ...entry.path.split("/"))),
      );
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined)
      throw new Error("TRUSTED_MATCHER_PATH_MISSING", { cause: entry.path });
    resolvedTrustedMatchers.push({
      path: resolved === "" ? "." : resolved,
      matchers: entry.matchers,
    });
  }
  adapter.runDirectory = runDirectory;
  adapter.resolvedTrustedMatchers = resolvedTrustedMatchers;
  return runDirectory;
}

/** The test files a designated run loads: every designated file for a control, one for a run. */
function designatedFiles(request: VerificationRequest, candidate: Candidate | null): string[] {
  const files = (candidate === null ? request.candidates : [candidate]).map(
    (entry) => entry.designated?.file ?? "",
  );
  return [...new Map(files.map((file) => [portablePathKey(file), file])).values()].sort(
    comparePortablePaths,
  );
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
  omittedLinks: ReadonlySet<string> = new Set(),
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
        // Only a link already judged outside every executed test's closure is left out.
        if (omittedLinks.has(portablePathKey(relative.split(path.sep).join("/")))) return false;
        throw new Error("UNSUPPORTED_REPOSITORY_SYMLINK");
      }
      return true;
    },
  });
}

/** Files and links copied by a v5 snapshot or workspace, both `/`-separated from the root. */
interface CopyPlan {
  files: readonly string[];
  directories?: readonly string[];
  links: ReadonlyArray<Pick<PreservedLink, "path" | "target" | "type">>;
}

const COPY_CONCURRENCY = 16;

/**
 * Copies exactly the planned files, then recreates each planned link with its relative target,
 * once every target exists. A directory link that Windows refuses to create as a symbolic link is
 * created as a junction to the same directory of the copy.
 */
async function copyPlannedTree(source: string, destination: string, plan: CopyPlan): Promise<void> {
  await mkdir(destination, { recursive: false });
  for (const directory of plan.directories ?? []) {
    await mkdir(path.join(destination, ...directory.split("/")), { recursive: true });
  }
  const directories = new Set<string>();
  const ensureParent = async (relative: string) => {
    const parent = path.posix.dirname(relative);
    if (parent === "." || directories.has(parent)) return;
    await mkdir(path.join(destination, ...parent.split("/")), { recursive: true });
    directories.add(parent);
  };
  const files = [...plan.files];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(COPY_CONCURRENCY, files.length) }, async () => {
      for (let index = next++; index < files.length; index = next++) {
        const file = files[index] as string;
        await ensureParent(file);
        await copyFile(
          path.join(source, ...file.split("/")),
          path.join(destination, ...file.split("/")),
          fsConstants.COPYFILE_EXCL,
        );
      }
    }),
  );
  for (const link of plan.links) {
    await ensureParent(link.path);
    const linkPath = path.join(destination, ...link.path.split("/"));
    const target = link.target.split("/").join(path.sep);
    try {
      await symlink(target, linkPath, link.type);
    } catch (error) {
      if (process.platform !== "win32" || link.type !== "dir") throw error;
      await symlink(path.resolve(path.dirname(linkPath), target), linkPath, "junction");
    }
  }
}

/** The links of a copied v5 tree with their targets as written, `/`-separated and relative. */
async function readTreeLinks(root: string, links: readonly string[]): Promise<PreservedLink[]> {
  const read: PreservedLink[] = [];
  for (const link of links) {
    const linkPath = path.join(root, ...link.split("/"));
    const literal = await readlink(linkPath);
    const absolute = path.resolve(path.dirname(linkPath), literal);
    const resolved = relativeWithin(root, absolute);
    if (resolved === undefined) throw new Error("REPOSITORY_LINK_ESCAPES_ROOT", { cause: link });
    const target = path.posix.relative(path.posix.dirname(link), resolved || ".") || ".";
    const type = (await stat(linkPath)).isDirectory() ? "dir" : "file";
    read.push({ path: link, target, resolved: resolved || ".", type });
  }
  return read;
}

/**
 * The v5 repository digest: every file with its size and bytes, and every link with its kind and
 * relative target, in one ordered sequence that no file and link pair can share.
 */
async function snapshotTreeDigest(
  root: string,
  files: readonly string[],
  links: readonly PreservedLink[],
  directories: readonly string[],
): Promise<string> {
  const occupied = [...files, ...links.map((link) => link.path), ...directories];
  const emptyDirectories = directories.filter(
    (directory) => !occupied.some((entry) => entry.startsWith(`${directory}/`)),
  );
  const entries = [
    ...files.map((file) => ({
      path: file,
      link: undefined as PreservedLink | undefined,
      directory: false,
    })),
    ...links.map((link) => ({ path: link.path, link, directory: false })),
    ...emptyDirectories.map((directory) => ({ path: directory, link: undefined, directory: true })),
  ].sort((left, right) => comparePortablePaths(left.path, right.path));
  const digest = createHash("sha256");
  for (const entry of entries) {
    if (entry.directory) {
      digest.update(Buffer.from(`D\0${entry.path}\0`, "utf8"));
      continue;
    }
    if (entry.link !== undefined) {
      digest.update(
        Buffer.from(`L\0${entry.path}\0${entry.link.type}\0${entry.link.target}\0`, "utf8"),
      );
      continue;
    }
    const content = await readFile(path.join(root, ...entry.path.split("/")));
    digest.update(Buffer.from(`F\0${entry.path}\0${content.byteLength}\0`, "utf8"));
    digest.update(content);
  }
  return `${SHA256_PREFIX}${digest.digest("hex")}`;
}

async function executeTrustedLocalAdapter(
  request: VerificationRequest,
  workspace: string,
  temporaryRoot: string,
  candidate: Candidate | null,
  candidateFiles: string[],
  nodeTestReporterPath: string | undefined,
): Promise<AdapterExecution> {
  const resultFile = path.join(temporaryRoot, "structured-command-result.json");
  const environment = environmentFromAllowlist(trustedLocalEnvironmentAllowlist(request));
  if (request.adapter.kind === "testforge-command") {
    environment.TESTFORGE_RESULT_FILE = resultFile;
    environment.TESTFORGE_CANDIDATE_FILES = JSON.stringify(candidateFiles);
  } else if (request.adapter.kind === "bun-test") {
    environment.TESTFORGE_CANDIDATE_FILES = JSON.stringify(candidateFiles);
  } else if (request.adapter.kind === "bun-test-designated") {
    environment.ASSERTLEDGER_BUN_DESIGNATED = JSON.stringify(
      designatedSelection(request, candidate),
    );
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
      : request.adapter.kind === "bun-test"
        ? [
            BUN_TEST_DRIVER_PATH,
            request.adapter.executable,
            BUN_TEST_HELPER_PATH,
            ...request.adapter.baseTestFiles,
          ]
        : request.adapter.kind === "bun-test-designated"
          ? [
              BUN_TEST_DRIVER_PATH,
              request.adapter.executable,
              BUN_TEST_HELPER_PATH,
              ...designatedFiles(request, candidate),
            ]
          : request.adapter.arguments;
  const result = await runProcess({
    executable:
      request.adapter.kind === "bun-test" || request.adapter.kind === "bun-test-designated"
        ? process.execPath
        : request.adapter.executable,
    args,
    cwd: workspace,
    environment,
    timeoutMs: request.budgets.timeoutMsPerExecution,
    maximumOutputBytes: request.budgets.maximumOutputBytes,
  });
  const structuredReport =
    request.adapter.kind === "testforge-command"
      ? await readStructuredCommandReport(resultFile, result, CONTROLLED_REPORT_MAXIMUM_BYTES)
      : request.adapter.kind === "bun-test" || request.adapter.kind === "bun-test-designated"
        ? readBunDriverReport(result)
        : undefined;
  return {
    result,
    structuredReport,
    nodeTestReport:
      request.adapter.kind === "node-test"
        ? await readNodeTestReport(resultFile, result, CONTROLLED_REPORT_MAXIMUM_BYTES)
        : undefined,
  };
}

async function executeObservation(
  request: VerificationRequest,
  repositoryRoot: string,
  world: World,
  candidate: Candidate | null,
  attempt: number,
  nodeTestReporterPath: string | undefined,
  container: ContainerBackend | undefined,
  workspacePlan: CopyPlan | undefined,
): Promise<Observation> {
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "testforge-run-")));
  const workspace = path.join(temporaryRoot, "repository");
  try {
    await traceOperation(
      "host-workspace-copy",
      {
        kind: candidate === null ? "campaign-load" : "campaign-test",
        worldId: world.id,
        candidateId: candidate?.id ?? null,
        attempt,
      },
      () =>
        workspacePlan === undefined
          ? copyRepository(repositoryRoot, workspace, workspaceExcludes(request))
          : copyPlannedTree(repositoryRoot, workspace, workspacePlan),
    );
    await applyFiles(workspace, world.files);
    if (candidate) await applyFiles(workspace, candidate.files);
    const candidateFiles = candidate ? candidate.files.map((file) => file.path) : [];
    const { result, structuredReport, nodeTestReport } =
      container === undefined
        ? await executeTrustedLocalAdapter(
            request,
            workspace,
            temporaryRoot,
            candidate,
            candidateFiles,
            nodeTestReporterPath,
          )
        : await executeContainerAdapter(
            request,
            {
              ...container,
              traceContext: {
                kind: candidate === null ? "campaign-load" : "campaign-test",
                worldId: world.id,
                candidateId: candidate?.id ?? null,
                attempt,
              },
              workspaceIdentity: sha256Canonical({
                snapshot: repositoryRoot,
                world: world.files,
                candidate: candidate?.files ?? [],
              }),
            },
            workspace,
            candidate,
            candidateFiles,
          );
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

export interface VerifyCampaignOptions {
  /** Operator-owned argv prefix of a Docker-compatible CLI; requests cannot provide it. */
  containerRuntime?: { command?: readonly string[]; transport?: ContainerTransport };
}

interface BunTestRuntimePreflight {
  protocolVersion: "1.0.0";
  probes: Array<{
    name: string;
    outcome: Observation["outcome"];
    attributed: boolean;
    testsDiscovered: number;
    candidateTestsDiscovered: number;
  }>;
}

/** Runs the Bun driver in a prepared probe workspace and returns its validated report. */
type BunDriverExecutor = (
  workspace: string,
  files: readonly string[],
  environment: Record<string, string>,
  probe?: string,
) => Promise<{ report: StructuredCommandReport | undefined; result: ProcessResult }>;

function localBunDriverExecutor(
  executable: string,
  environmentAllowlist: string[],
  timeoutMs: number,
  maximumOutputBytes: number,
): BunDriverExecutor {
  return async (workspace, files, environment) => {
    const result = await runProcess({
      executable: process.execPath,
      args: [BUN_TEST_DRIVER_PATH, executable, BUN_TEST_HELPER_PATH, ...files],
      cwd: workspace,
      environment: { ...environmentFromAllowlist(environmentAllowlist), ...environment },
      timeoutMs: Math.min(timeoutMs, 5_000),
      maximumOutputBytes: Math.min(maximumOutputBytes, CONTROLLED_REPORT_MAXIMUM_BYTES),
    });
    return { result, report: readBunDriverReport(result) };
  };
}

function containerBunDriverExecutor(
  container: ContainerBackend,
  executable: string,
  timeoutMs: number,
  maximumOutputBytes: number,
): BunDriverExecutor {
  return async (workspace, files, environment, probe) =>
    runContainerBunDriver(
      {
        ...container,
        traceContext: { kind: "preflight", ...(probe === undefined ? {} : { probe }) },
      },
      workspace,
      executable,
      files,
      environment,
      Math.min(timeoutMs, 30_000),
      Math.min(maximumOutputBytes, CONTROLLED_REPORT_MAXIMUM_BYTES),
    );
}

/** Both Bun modes use the same four qualification predicates and refusal representation. */
async function qualifyBunProbe(
  profile: BunPreflightRefusal["profile"],
  probe: string,
  expected: BunPreflightRefusal["expected"],
  execute: () => ReturnType<BunDriverExecutor>,
): Promise<StructuredCommandReport> {
  let executed: Awaited<ReturnType<BunDriverExecutor>>;
  try {
    executed = await execute();
  } catch (cause) {
    throw new BunPreflightError(
      {
        schemaVersion: "1.0.0",
        status: "REFUSED",
        code: "BUN_TEST_PROFILE_PREFLIGHT_FAILED",
        profile,
        probe,
        failure: "EXECUTION_ERROR",
        expected,
        observed: {
          outcome: null,
          attributed: null,
          testsDiscovered: null,
          candidateTestsDiscovered: null,
        },
        process: null,
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      cause,
    );
  }
  const { report, result } = executed;
  if (
    report?.outcome !== expected.outcome ||
    report.attributed !== expected.attributed ||
    report.testsDiscovered !== expected.testsDiscovered ||
    report.candidateTestsDiscovered !== expected.candidateTestsDiscovered
  ) {
    throw new BunPreflightError(
      {
        schemaVersion: "1.0.0",
        status: "REFUSED",
        code: "BUN_TEST_PROFILE_PREFLIGHT_FAILED",
        profile,
        probe,
        failure: report === undefined ? "REPORT_UNAVAILABLE" : "REPORT_MISMATCH",
        expected,
        observed: {
          outcome: report?.outcome ?? null,
          attributed: report?.attributed ?? null,
          testsDiscovered: report?.testsDiscovered ?? null,
          candidateTestsDiscovered: report?.candidateTestsDiscovered ?? null,
        },
        process: {
          outcome: result.outcome,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        },
        detail: result.error ?? null,
      },
      probe,
    );
  }
  return report;
}

interface BunDesignatedProbe {
  name: string;
  body: string;
  mode: "run" | "load";
  expectedFailure?: string;
  testTimeoutMs?: number;
  /** Further workspace files, such as a bunfig.toml and its preload. */
  files?: Readonly<Record<string, string>>;
  trustedMatchers?: ReadonlyArray<{ path: string; matchers: readonly string[] }>;
  isolate?: boolean;
  /** Further tests a load registers, each in its own file. */
  loadTests?: ReadonlyArray<{ file: string; name: string }>;
  outcome: Observation["outcome"];
  attributed: boolean;
  testsDiscovered: number;
  candidateTestsDiscovered: number;
}

/** A bunfig.toml whose preload extends expect before AssertLedger's preload could, unordered. */
const PRELOAD_EXTENSION_FILES = {
  "bunfig.toml": '[test]\npreload = ["./setup.ts"]\n',
  "setup.ts":
    'import { expect } from "bun:test"; expect.extend({ toBe() { return { pass: false, message: () => "replaced" }; }, toFailExtended() { return { pass: false, message: () => "extended" }; } });\n',
} as const;

const DESIGNATED_PROBES: readonly BunDesignatedProbe[] = (() => {
  const run = (
    name: string,
    body: string,
    outcome: Observation["outcome"],
    expectedFailure?: string,
  ): BunDesignatedProbe => {
    const counted = outcome !== "NO_TEST_DISCOVERED" && outcome !== "INFRA_ERROR";
    return {
      name,
      body,
      mode: "run",
      ...(expectedFailure === undefined ? {} : { expectedFailure }),
      outcome,
      attributed: outcome === "PASS" || outcome === "ASSERTION_FAILURE",
      testsDiscovered: counted ? 1 : 0,
      candidateTestsDiscovered: counted ? 1 : 0,
    };
  };
  const failing = 'test("probe", () => expect(1).toBe(2));';
  return [
    run("expect-assertion", failing, "ASSERTION_FAILURE"),
    run("expected-line", failing, "ASSERTION_FAILURE", "error: expect(received).toBe(expected)"),
    run("other-line", failing, "PROCESS_CRASH", "expect(received).toEqual(expected)"),
    run("assert-same", 'test("probe", () => assertSame(1, 2));', "ASSERTION_FAILURE"),
    run(
      "async-matcher",
      'test("probe", async () => { await expect(Promise.resolve(1)).resolves.toBe(2); });',
      "ASSERTION_FAILURE",
    ),
    run(
      "forged-message",
      'test("probe", () => { throw new Error("expect(received).toBe(expected)"); });',
      "PROCESS_CRASH",
    ),
    run(
      "caught-expect",
      'test("probe", () => { try { expect(1).toBe(2); } catch {} throw new Error("generic"); });',
      "PROCESS_CRASH",
    ),
    run(
      "replayed-expect",
      'let saved; try { expect(1).toBe(2); } catch (error) { saved = error; } test("probe", () => { throw saved; });',
      "PROCESS_CRASH",
    ),
    run("matcher-usage", 'test("probe", () => expect(1).toContain());', "PROCESS_CRASH"),
    run(
      "custom-matcher",
      'expect.extend({ toFail() { throw new Error("expect(received).toFail()"); } }); test("probe", () => expect(1).toFail());',
      "PROCESS_CRASH",
    ),
    // expect.extend can reuse a built-in name; the function it installs is not the built-in one.
    run(
      "replaced-built-in",
      'expect.extend({ toBe() { return { pass: false, message: () => "replaced" }; } }); test("probe", () => expect(1).toBe(1));',
      "PROCESS_CRASH",
    ),
    // A repository preload runs after AssertLedger's: its replacement is never a built-in matcher,
    // and its own matchers are custom unless the operator declared them trusted.
    {
      ...run(
        "preload-replaced-built-in",
        'test("probe", () => expect(1).toBe(1));',
        "PROCESS_CRASH",
      ),
      files: PRELOAD_EXTENSION_FILES,
    },
    {
      ...run(
        "preload-custom-matcher",
        'test("probe", () => expect(1).toFailExtended());',
        "PROCESS_CRASH",
      ),
      files: PRELOAD_EXTENSION_FILES,
    },
    {
      ...run(
        "trusted-matcher",
        'test("probe", () => expect(1).toFailExtended());',
        "ASSERTION_FAILURE",
      ),
      files: PRELOAD_EXTENSION_FILES,
      trustedMatchers: [{ path: "setup.ts", matchers: ["toFailExtended"] }],
    },
    {
      ...run(
        "trusted-matcher-other-name",
        'test("probe", () => expect(1).toBe(1));',
        "PROCESS_CRASH",
      ),
      files: PRELOAD_EXTENSION_FILES,
      trustedMatchers: [{ path: "setup.ts", matchers: ["toFailExtended"] }],
    },
    run("passing", 'test("probe", () => expect(1).toBe(1));', "PASS"),
    run("absent", 'test("other", () => expect(1).toBe(2));', "NO_TEST_DISCOVERED"),
    run(
      "hook-failure",
      'afterEach(() => { throw new Error("hook"); }); test("probe", () => expect(1).toBe(2));',
      "INFRA_ERROR",
    ),
    {
      // The callback fails its matcher only after Bun's per-test timeout: never an assertion.
      ...run(
        "late-after-timeout",
        'test("probe", () => { const end = Date.now() + 300; while (Date.now() < end); expect(1).toBe(2); });',
        "INFRA_ERROR",
      ),
      testTimeoutMs: 50,
    },
    {
      name: "load",
      body: 'test("probe", () => expect(1).toBe(2)); test("other", () => {});',
      mode: "load",
      outcome: "PASS",
      attributed: false,
      testsDiscovered: 2,
      candidateTestsDiscovered: 0,
    },
    {
      name: "load-failure",
      body: 'import "./missing-module"; test("probe", () => {});',
      mode: "load",
      outcome: "INFRA_ERROR",
      attributed: false,
      testsDiscovered: 0,
      candidateTestsDiscovered: 0,
    },
    {
      // Isolated, each further file gets a fresh global: the driver loads one file per process.
      name: "isolated-load",
      body: 'test("probe", () => expect(1).toBe(2));',
      mode: "load",
      isolate: true,
      loadTests: [{ file: "second.test.ts", name: "second" }],
      outcome: "PASS",
      attributed: false,
      testsDiscovered: 2,
      candidateTestsDiscovered: 0,
    },
    {
      ...run("isolated-run", failing, "ASSERTION_FAILURE"),
      isolate: true,
    },
  ];
})();

/**
 * Qualifies the designated mode before a campaign: only a built-in matcher's or assertSame's
 * failure inside the designated test, with the declared first line, is an assertion; forged,
 * caught, replayed, misused and custom failures, hook and load failures and an absent test are not.
 */
async function runBunDesignatedPreflight(
  executor: BunDriverExecutor,
): Promise<BunTestRuntimePreflight> {
  const header =
    'import { afterEach, expect, test } from "bun:test"; import { assertSame } from "assertledger/bun";';
  try {
    const recorded: BunTestRuntimePreflight["probes"] = [];
    for (const probe of DESIGNATED_PROBES) {
      const report = await qualifyBunProbe(
        "bun-test-designated",
        probe.name,
        {
          outcome: probe.outcome,
          attributed: probe.attributed,
          testsDiscovered: probe.testsDiscovered,
          candidateTestsDiscovered: probe.candidateTestsDiscovered,
        },
        () =>
          withEmptyWorkspace(async (workspace) => {
            await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
            await writeFile(path.join(workspace, "probe.test.ts"), `${header} ${probe.body}\n`);
            for (const [name, content] of Object.entries(probe.files ?? {})) {
              await writeFile(path.join(workspace, name), content);
            }
            for (const extra of probe.loadTests ?? []) {
              await writeFile(
                path.join(workspace, extra.file),
                `${header} test(${JSON.stringify(extra.name)}, () => {});\n`,
              );
            }
            const test = { file: "probe.test.ts", path: ["probe"] };
            const execution = {
              workingDirectory: ".",
              isolate: probe.isolate ?? false,
              trustedMatchers: probe.trustedMatchers ?? [],
            };
            const loadTests = [
              test,
              ...(probe.loadTests ?? []).map((extra) => ({ file: extra.file, path: [extra.name] })),
            ];
            return executor(
              workspace,
              probe.mode === "run" ? ["probe.test.ts"] : loadTests.map((entry) => entry.file),
              {
                ASSERTLEDGER_BUN_DESIGNATED: JSON.stringify(
                  probe.mode === "run"
                    ? {
                        mode: "run",
                        test,
                        expectedFailure: probe.expectedFailure ?? null,
                        testTimeoutMs: probe.testTimeoutMs ?? null,
                        ...execution,
                      }
                    : { mode: "load", tests: loadTests, ...execution },
                ),
              },
              probe.name,
            );
          }),
      );
      recorded.push({
        name: probe.name,
        outcome: report.outcome,
        attributed: report.attributed,
        testsDiscovered: report.testsDiscovered,
        candidateTestsDiscovered: report.candidateTestsDiscovered,
      });
    }
    return { protocolVersion: "1.0.0", probes: recorded };
  } catch (error) {
    if (error instanceof BunPreflightError) throw error;
    throw new Error("BUN_TEST_PROFILE_PREFLIGHT_FAILED", { cause: error });
  }
}

async function runBunTestRuntimePreflight(
  executor: BunDriverExecutor,
): Promise<BunTestRuntimePreflight> {
  const probeSources = [
    {
      name: "assertion",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; test("assertion", () => assertSame(1, 2));\n',
      outcome: "ASSERTION_FAILURE",
      attributed: true,
    },
    {
      name: "generic-throw",
      source:
        'import { test } from "bun:test"; test("generic", () => { throw new Error("generic"); });\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "caught-assertion",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; test("caught", () => { try { assertSame(1, 2); } catch {} throw new Error("generic"); });\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "replayed-assertion",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let saved; try { assertSame(1, 2); } catch (error) { saved = error; } test("replayed", () => { throw saved; });\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "replayed-row",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let saved; test.each([0, 1])("row %i", (row) => { if (row === 0) { try { assertSame(1, 2); } catch (error) { saved = error; } return; } throw saved; });\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "async-cross-test",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let signalReady; const ready = new Promise((resolve) => { signalReady = resolve; }); let rejectReceiver; test("origin", () => { ready.then(() => { try { assertSame(1, 2); } catch (error) { rejectReceiver(error); } }); }); test("receiver", () => new Promise((_, reject) => { rejectReceiver = reject; signalReady(); }));\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "multi-assertion-rows",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; test.each([1, 2])("row %i", (row) => assertSame(row, 0));\n',
      outcome: "ASSERTION_FAILURE",
      attributed: true,
    },
    {
      name: "operand-throw",
      source:
        'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; test("operand", () => assertSame((() => { throw new Error("operand"); })(), 1));\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "native-expect",
      source: 'import { test, expect } from "bun:test"; test("native", () => expect(1).toBe(2));\n',
      outcome: "PROCESS_CRASH",
      attributed: false,
    },
    {
      name: "hook-failure",
      source:
        'import { afterEach, test } from "bun:test"; import { assertSame } from "assertledger/bun"; afterEach(() => { throw new Error("hook"); }); test("candidate", () => assertSame(1, 2));\n',
      outcome: "INFRA_ERROR",
      attributed: false,
    },
  ] as const;
  try {
    const probes: BunTestRuntimePreflight["probes"] = [];
    for (const probe of probeSources) {
      const expectedCandidateCount =
        probe.name === "hook-failure"
          ? 0
          : probe.name === "replayed-row" ||
              probe.name === "async-cross-test" ||
              probe.name === "multi-assertion-rows"
            ? 2
            : 1;
      const report = await qualifyBunProbe(
        "bun-test",
        probe.name,
        {
          outcome: probe.outcome,
          attributed: probe.attributed,
          testsDiscovered: expectedCandidateCount === 0 ? 0 : expectedCandidateCount + 1,
          candidateTestsDiscovered: expectedCandidateCount,
        },
        () =>
          withEmptyWorkspace(async (workspace) => {
            await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
            await writeFile(
              path.join(workspace, "base.test.ts"),
              'import { test } from "bun:test"; test("control", () => {});\n',
            );
            const candidatePath = path.join(workspace, "candidate.test.ts");
            await writeFile(candidatePath, probe.source);
            return executor(
              workspace,
              ["base.test.ts"],
              {
                TESTFORGE_CANDIDATE_FILES: JSON.stringify(["candidate.test.ts"]),
              },
              probe.name,
            );
          }),
      );
      probes.push({
        name: probe.name,
        outcome: report.outcome,
        attributed: report.attributed,
        testsDiscovered: report.testsDiscovered,
        candidateTestsDiscovered: report.candidateTestsDiscovered,
      });
    }
    return { protocolVersion: "1.0.0", probes };
  } catch (error) {
    if (error instanceof BunPreflightError) throw error;
    throw new Error("BUN_TEST_PROFILE_PREFLIGHT_FAILED", { cause: error });
  }
}

export async function verifyCampaign(
  value: unknown,
  options: VerifyCampaignOptions = {},
): Promise<unknown> {
  const request = parseRequest(value);
  return withRuntimeTrace([request.repository.root], () =>
    verifyCampaignWithTrace(request, options),
  );
}

async function verifyCampaignWithTrace(
  request: VerificationRequest,
  options: VerifyCampaignOptions,
): Promise<unknown> {
  const transport = parseContainerTransport(options.containerRuntime?.transport);
  const container =
    request.isolation.kind === "container"
      ? await prepareContainerBackend(
          options.containerRuntime?.command ?? DEFAULT_CONTAINER_RUNTIME_COMMAND,
          request.isolation,
          runBoundedProcess,
          os.tmpdir(),
        )
      : undefined;
  if (container === undefined || transport === "cli")
    return verifyPreparedCampaign(request, container);
  let control: Awaited<ReturnType<typeof openDockerStdioControl>> | undefined;
  try {
    control = await traceOperation(
      "stdio-connect",
      { transport: "stdio-api" },
      () => openDockerStdioControl(container.runtimeCommand, os.tmpdir(), container.record),
      () => ({ runtimeInvocations: 1 }),
    );
  } catch (error) {
    if (transport === "stdio") throw error;
    // Capability negotiation has made no mutable request. CLI-compatible runtimes remain valid.
  }
  if (control === undefined) return verifyPreparedCampaign(request, container);
  container.controlRunner = control.run;
  try {
    return await verifyPreparedCampaign(request, container);
  } finally {
    await traceOperation("stdio-close", {}, () => control.close());
  }
}

async function verifyPreparedCampaign(
  request: VerificationRequest,
  container: ContainerBackend | undefined,
): Promise<unknown> {
  const repositoryRoot = await resolveRepositoryRoot(request.repository.root);
  const version5 = request.schemaVersion === VERIFICATION_SCHEMA_VERSION_V5;
  // v4 and v5 bind the snapshot scope to the decision and record it in the manifest.
  const version4 = request.schemaVersion === VERIFICATION_SCHEMA_VERSION_V4 || version5;
  const excludes = campaignExcludes(request);
  // Before v4 any link refuses the walk; v4 collects them and judges each one below.
  const sourceLinks: string[] | undefined = version4 ? [] : undefined;
  const sourceInventory = await walkFiles(repositoryRoot, excludes, sourceLinks);
  if (sourceInventory.files.length > request.budgets.maximumRepositoryFiles) {
    throw new Error("REPOSITORY_FILE_BUDGET_EXCEEDED");
  }
  if (sourceInventory.totalBytes > request.budgets.maximumRepositoryBytes) {
    throw new Error("REPOSITORY_BYTES_BUDGET_EXCEEDED");
  }
  // v5 plans the snapshot against the closure followed through internal links, which it keeps.
  const snapshotPlan = version5
    ? await planCampaignSnapshot(
        request,
        repositoryRoot,
        sourceInventory.files,
        sourceLinks ?? [],
        excludes,
        sourceInventory.directories,
      )
    : undefined;
  const omittedLinks =
    snapshotPlan !== undefined
      ? snapshotPlan.omittedLinks
      : sourceLinks === undefined || sourceLinks.length === 0
        ? []
        : await campaignOmittedLinks(request, repositoryRoot, sourceInventory.files, sourceLinks);
  if (version5 && omittedLinks.length > 10_000) throw new Error("REPOSITORY_LINK_LIMIT_EXCEEDED");
  const nodeIdentity =
    request.adapter.kind !== "node-test"
      ? undefined
      : container === undefined
        ? await probeNodeTestExecutable(
            request.adapter.executable,
            repositoryRoot,
            trustedLocalEnvironmentAllowlist(request),
            request.budgets.timeoutMsPerExecution,
            request.budgets.maximumOutputBytes,
          )
        : await probeContainerNodeExecutable(
            container,
            request.adapter.executable,
            request.budgets.timeoutMsPerExecution,
            request.budgets.maximumOutputBytes,
          );
  if (request.adapter.kind === "node-test" && nodeIdentity !== undefined) {
    request.adapter.executable = nodeIdentity.resolvedExecutable;
  }
  const bunAdapter =
    request.adapter.kind === "bun-test" || request.adapter.kind === "bun-test-designated";
  const bunIdentity =
    request.adapter.kind !== "bun-test" && request.adapter.kind !== "bun-test-designated"
      ? undefined
      : container === undefined
        ? await probeBunTestExecutable(
            request.adapter.executable,
            repositoryRoot,
            trustedLocalEnvironmentAllowlist(request),
            request.budgets.timeoutMsPerExecution,
            request.budgets.maximumOutputBytes,
          )
        : await probeContainerBunExecutable(
            container,
            request.adapter.executable,
            request.budgets.timeoutMsPerExecution,
            request.budgets.maximumOutputBytes,
          );
  if (
    (request.adapter.kind === "bun-test" || request.adapter.kind === "bun-test-designated") &&
    bunIdentity !== undefined
  ) {
    request.adapter.executable = bunIdentity.resolvedExecutable;
  }
  const bunDriverDigest = bunAdapter ? await sha256File(BUN_TEST_DRIVER_PATH) : undefined;
  const bunHelperDigest = bunAdapter ? await sha256File(BUN_TEST_HELPER_PATH) : undefined;
  const bunPreloadDigest = bunAdapter ? await sha256File(BUN_TEST_PRELOAD_PATH) : undefined;
  const nodeRuntimePreflight: NodeTestRuntimePreflight | undefined =
    request.adapter.kind === "node-test" && nodeIdentity !== undefined
      ? await runNodeTestRuntimePreflight({
          executable: nodeIdentity.resolvedExecutable,
          reporterSource: NODE_TEST_REPORTER_SOURCE,
          environment: environmentFromAllowlist(trustedLocalEnvironmentAllowlist(request)),
          timeoutMs: request.budgets.timeoutMsPerExecution,
          maximumOutputBytes: request.budgets.maximumOutputBytes,
          processRunner: runProcess,
          ...(container === undefined
            ? {}
            : {
                probeExecutor: containerPreflightExecutor(
                  container,
                  nodeIdentity.resolvedExecutable,
                ),
              }),
        })
      : undefined;
  const bunExecutor =
    bunIdentity === undefined
      ? undefined
      : container === undefined
        ? localBunDriverExecutor(
            bunIdentity.resolvedExecutable,
            trustedLocalEnvironmentAllowlist(request),
            request.budgets.timeoutMsPerExecution,
            request.budgets.maximumOutputBytes,
          )
        : containerBunDriverExecutor(
            container,
            bunIdentity.resolvedExecutable,
            request.budgets.timeoutMsPerExecution,
            request.budgets.maximumOutputBytes,
          );
  const bunRuntimePreflight =
    bunExecutor === undefined
      ? undefined
      : request.adapter.kind === "bun-test-designated"
        ? await runBunDesignatedPreflight(bunExecutor)
        : await runBunTestRuntimePreflight(bunExecutor);
  const campaignRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "testforge-campaign-")));
  const repositorySnapshot = path.join(campaignRoot, "repository");
  try {
    await traceOperation("host-snapshot", { kind: "snapshot" }, () =>
      snapshotPlan !== undefined
        ? copyPlannedTree(repositoryRoot, repositorySnapshot, snapshotPlan)
        : copyRepository(
            repositoryRoot,
            repositorySnapshot,
            excludes,
            new Set(omittedLinks.map(portablePathKey)),
          ),
    );
    // A v5 snapshot holds the planned links; read back, they are what the digest binds.
    const snapshotLinkPaths: string[] | undefined = version5 ? [] : undefined;
    const snapshotInventory = await walkFiles(repositorySnapshot, excludes, snapshotLinkPaths);
    if (snapshotInventory.files.length > request.budgets.maximumRepositoryFiles) {
      throw new Error("REPOSITORY_FILE_BUDGET_EXCEEDED");
    }
    if (snapshotInventory.totalBytes > request.budgets.maximumRepositoryBytes) {
      throw new Error("REPOSITORY_BYTES_BUDGET_EXCEEDED");
    }
    const snapshotLinks =
      snapshotLinkPaths === undefined
        ? []
        : await readTreeLinks(repositorySnapshot, snapshotLinkPaths);
    if (
      snapshotPlan !== undefined &&
      JSON.stringify(snapshotLinks.map(({ path: link, target, type }) => [link, target, type])) !==
        JSON.stringify(
          snapshotPlan.links.map(({ path: link, target, type }) => [link, target, type]),
        )
    ) {
      throw new Error("REPOSITORY_SNAPSHOT_LINKS_CHANGED");
    }
    const gitRecord =
      request.repository.git === "synthesized"
        ? await synthesizeGitWorktree(repositorySnapshot)
        : null;
    // Each v5 execution copies the snapshot as planned, links and synthesized Git metadata included.
    const workspacePlan: CopyPlan | undefined =
      snapshotPlan === undefined
        ? undefined
        : await (async () => {
            const links: string[] = [];
            const inventory = await walkFiles(
              repositorySnapshot,
              workspaceExcludes(request),
              links,
            );
            return {
              files: inventory.files,
              directories: inventory.directories,
              links: await readTreeLinks(repositorySnapshot, links),
            };
          })();
    const designatedTestFiles = request.candidates.flatMap((candidate) =>
      candidate.designated === undefined ? [] : [candidate.designated.file],
    );
    const snapshotFiles = new Set(snapshotInventory.files.map(portablePathKey));
    if (designatedTestFiles.some((file) => !snapshotFiles.has(portablePathKey(file)))) {
      throw new Error("DESIGNATED_TEST_FILE_MISSING");
    }
    const inputPaths = [
      ...request.worlds.flatMap((world) => world.files.map((file) => file.path)),
      ...request.candidates.flatMap((candidate) => candidate.files.map((file) => file.path)),
      ...designatedTestFiles,
      ...(request.adapter.kind === "node-test" || request.adapter.kind === "bun-test"
        ? request.adapter.baseTestFiles
        : []),
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
    // A v4 digest covers exactly the snapshot, dependencies included when the request says so; a
    // v5 digest also binds every reproduced link and its target.
    const repositoryDigest = version5
      ? await snapshotTreeDigest(
          repositorySnapshot,
          snapshotInventory.files,
          snapshotLinks,
          snapshotInventory.directories,
        )
      : version4
        ? await repositoryInventoryDigest(repositorySnapshot, snapshotInventory.files)
        : ((await analyzeRepository(repositorySnapshot)) as { repositoryDigest: string })
            .repositoryDigest;
    const runDirectory =
      request.adapter.kind === "bun-test-designated"
        ? await prepareDesignatedRun(request, repositorySnapshot, snapshotFiles)
        : undefined;
    const observations: Observation[] = [];
    // Qualification always ran above. Only deterministic upload bytes may be reused here.
    if (container !== undefined)
      container.uploadArchives = { entries: new Map(), bytes: 0, maximumBytes: 32 * 1024 * 1024 };

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
            container,
            workspacePlan,
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
              container,
              workspacePlan,
            ),
          );
        }
      }
    }

    // A designated candidate is identified by its selection and the bytes of its test file.
    const designatedIdentities = new Map<string, { digest: string; sizeBytes: number }>();
    for (const candidate of request.candidates) {
      if (candidate.designated === undefined) continue;
      const bytes = await readFile(
        path.join(repositorySnapshot, ...candidate.designated.file.split("/")),
      );
      designatedIdentities.set(candidate.id, {
        digest: sha256Canonical({
          test: { file: candidate.designated.file, path: candidate.designated.path },
          expectedFailure: candidate.designated.expectedFailure,
          testFileDigest: rawSha256(bytes),
        }),
        sizeBytes: bytes.byteLength,
      });
    }
    const windowsNative = request.isolation.kind === "windows-native";
    const isolationLevel =
      container !== undefined
        ? "CONTAINER"
        : windowsNative
          ? "WINDOWS_NATIVE_UNSANDBOXED"
          : "UNSANDBOXED";
    const evidence = {
      schemaVersion: request.schemaVersion,
      repositoryDigest,
      evidenceContext: {
        engine: { name: "testforge", version: "0.1.0" },
        adapter: {
          name: request.adapter.kind,
          version:
            request.adapter.kind === "testforge-command"
              ? request.adapter.protocolVersion
              : bunAdapter
                ? (bunIdentity?.bunVersion ?? "unprobed")
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
              : request.adapter.kind === "bun-test" && bunIdentity !== undefined
                ? {
                    kind: "bun-test",
                    profile: BUN_TEST_ADAPTER_PROFILE,
                    requestedExecutable: bunIdentity.requestedExecutable,
                    resolvedExecutable: bunIdentity.resolvedExecutable,
                    executableDigest: bunIdentity.executableDigest,
                    bunVersion: bunIdentity.bunVersion,
                    bunRevision: bunIdentity.bunRevision,
                    driverDigest: bunDriverDigest,
                    helperDigest: bunHelperDigest,
                    preloadDigest: bunPreloadDigest,
                    runtimePreflight: bunRuntimePreflight,
                    arguments: [
                      "test",
                      "--max-concurrency=1",
                      "--retry=0",
                      "--preload",
                      "./node_modules/assertledger/preload.mjs",
                      "--reporter=junit",
                      "--reporter-outfile=<generated-junit-file>",
                      ...request.adapter.baseTestFiles,
                    ],
                  }
                : request.adapter.kind === "bun-test-designated" && bunIdentity !== undefined
                  ? {
                      kind: "bun-test-designated",
                      profile: BUN_TEST_DESIGNATED_ADAPTER_PROFILE,
                      requestedExecutable: bunIdentity.requestedExecutable,
                      resolvedExecutable: bunIdentity.resolvedExecutable,
                      executableDigest: bunIdentity.executableDigest,
                      bunVersion: bunIdentity.bunVersion,
                      bunRevision: bunIdentity.bunRevision,
                      driverDigest: bunDriverDigest,
                      helperDigest: bunHelperDigest,
                      preloadDigest: bunPreloadDigest,
                      runtimePreflight: bunRuntimePreflight,
                      arguments: [
                        "test",
                        "--config=<generated-bunfig>",
                        "--max-concurrency=1",
                        "--retry=0",
                        "--reporter=junit",
                        "--reporter-outfile=<generated-junit-file>",
                        ...(request.adapter.isolate ? ["--isolate"] : []),
                        "--test-name-pattern=<anchored-designated-test-path>",
                        ...(request.adapter.testTimeoutMs === null
                          ? []
                          : [`--timeout=${request.adapter.testTimeoutMs}`]),
                        "<designated-test-file>",
                      ],
                      // The generated bunfig is the run directory's own with AssertLedger's
                      // preload placed before every repository preload.
                      bunConfiguration: "repository-bunfig-with-assertledger-preload-first",
                      testTimeoutMs: request.adapter.testTimeoutMs,
                      ...(version5
                        ? {
                            workingDirectory: request.adapter.workingDirectory,
                            runDirectory: runDirectory ?? ".",
                            isolate: request.adapter.isolate,
                            trustedMatchers: request.adapter.trustedMatchers,
                            resolvedTrustedMatchers: request.adapter.resolvedTrustedMatchers ?? [],
                          }
                        : {}),
                      designatedTests: request.candidates.map((candidate) => ({
                        candidateId: candidate.id,
                        file: candidate.designated?.file ?? null,
                        path: candidate.designated?.path ?? [],
                        expectedFailure: candidate.designated?.expectedFailure ?? null,
                      })),
                    }
                  : request.adapter,
        },
        execution: {
          isolation: isolationLevel,
          environmentAllowlist:
            container === undefined
              ? trustedLocalEnvironmentAllowlist(request)
              : container.isolation.environment.map((variable) => variable.name).sort(),
          budgets: request.budgets,
          candidateRoots: request.candidateRoots,
          ...(request.schemaVersion === "1.0.0"
            ? {}
            : {
                backend:
                  container !== undefined
                    ? container.record
                    : windowsNative
                      ? {
                          kind: "windows-native",
                          level: "WINDOWS_NATIVE_UNSANDBOXED",
                          platform: "win32",
                        }
                      : { kind: "trusted-local", level: "UNSANDBOXED" },
              }),
        },
        ...(version4
          ? {
              repository: {
                includeDependencies: request.repository.includeDependencies,
                omittedLinks: [...omittedLinks].sort(),
                git: gitRecord,
                ...(version5
                  ? {
                      snapshot: request.repository.snapshot,
                      include: [...request.repository.include].sort(),
                      preservedLinkCount: snapshotLinks.length,
                      unboundedClosureEdges: [...(snapshotPlan?.unbounded ?? [])].sort(
                        (left, right) =>
                          compareOrdinalStrings(
                            `${left.file}\u0000${left.reason}`,
                            `${right.file}\u0000${right.reason}`,
                          ),
                      ),
                    }
                  : {}),
              },
            }
          : {}),
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
      candidates: request.candidates.map((candidate) => {
        const designated = designatedIdentities.get(candidate.id);
        return {
          id: candidate.id,
          digest: designated?.digest ?? sha256Canonical(candidate.files),
          sizeBytes:
            designated?.sizeBytes ??
            candidate.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
        };
      }),
      observations,
    };
    const manifest = decideEvidence(evidence);
    const designatedLimitations =
      request.adapter.kind === "bun-test-designated"
        ? [
            "Only a failure thrown inside the designated test by a bun:test built-in matcher, in Bun's matcher message form, or by assertSame is admitted as an assertion; with a declared expected line, its first message line must equal it. Custom matchers, usage errors and every other error are not assertion evidence.",
            "Controls load every designated test file without running a test: they show that each world evaluates the file and its imports and still registers the designated test, not that other tests pass.",
            "Bun callback instrumentation determines assertion ownership; JUnit counts only check completeness and never classify assertions.",
            "Bun ran with the run directory's own bunfig, rewritten so that AssertLedger's preload runs before every repository preload; a matcher replaced or added by expect.extend, before or during the test, is not a built-in matcher.",
            ...(request.adapter.trustedMatchers.length > 0
              ? [
                  "The operator declared custom matchers trusted: a failure of a declared matcher, installed by a module at or below its declared path, is admitted as an assertion, including a usage error that the matcher reports in the matcher message form.",
                ]
              : []),
            ...(request.adapter.isolate
              ? [
                  "Bun ran with --isolate; a control that loads several isolated test files runs one Bun process per file.",
                ]
              : []),
          ]
        : [];
    const snapshotLimitations = version4
      ? [
          ...(request.repository.includeDependencies
            ? [
                "Dependency directories (node_modules) are part of the snapshot and its digest as found; AssertLedger did not install or verify them.",
              ]
            : []),
          ...(gitRecord !== null
            ? [
                "Each execution ran in a synthesized Git repository: the snapshot committed once with a fixed identity and date; the source repository's own Git metadata and history were not used.",
              ]
            : []),
          ...(omittedLinks.length > 0
            ? [
                version5
                  ? `${omittedLinks.length} repository link(s) that leave the root, dangle or reach an excluded path lie outside the module closure of every executed test and were left out of the snapshot; the closure follows literal module specifiers only and does not cover files read at run time.`
                  : `${omittedLinks.length} repository link(s) outside the module closure of every executed test were left out of the snapshot; the closure follows literal module specifiers only and does not cover files read at run time.`,
              ]
            : []),
          ...(version5 && snapshotLinks.length > 0
            ? [
                `${snapshotLinks.length} repository-internal link(s) were reproduced in the snapshot with their relative targets; the repository digest binds each link and its target.`,
              ]
            : []),
          ...(version5 && request.repository.snapshot === "test-closure"
            ? [
                "The snapshot holds only the static module closure of the executed tests, the package, TypeScript and Bun configurations on their paths and the operator's include paths; a file read at run time outside them is absent from every world.",
                ...((snapshotPlan?.unbounded.length ?? 0) > 0
                  ? [
                      `${snapshotPlan?.unbounded.length} closure edge(s) could not be followed statically; the modules they load at run time are absent unless an include path holds them.`,
                    ]
                  : []),
              ]
            : []),
        ]
      : [];
    const finalManifest = {
      ...manifest,
      adapter:
        request.adapter.kind === "testforge-command"
          ? { kind: request.adapter.kind, protocolVersion: request.adapter.protocolVersion }
          : { kind: request.adapter.kind },
      isolation:
        container !== undefined
          ? { kind: "container", level: "CONTAINER", runtimeCommand: container.runtimeCommand }
          : windowsNative
            ? {
                kind: "windows-native",
                level: "WINDOWS_NATIVE_UNSANDBOXED",
                acknowledgedUnsafeExecution: true,
              }
            : {
                kind: "trusted-local",
                level: "UNSANDBOXED",
                acknowledgedUnsafeExecution: true,
              },
      limitations:
        container === undefined
          ? [
              ...(windowsNative
                ? [
                    "WINDOWS_NATIVE_UNSANDBOXED execution ran directly on the Windows host at the operator's explicit request; it cannot safely contain hostile code.",
                  ]
                : [
                    "UNSANDBOXED trusted-local execution cannot safely contain hostile candidate code.",
                  ]),
              "Process-tree termination is best effort and depends on host operating-system facilities.",
              ...(request.adapter.kind === "bun-test"
                ? [
                    "Only failures from the AssertLedger-owned assertSame helper are admitted as Bun assertions; native bun:test expect failures are not assertion evidence.",
                    "Bun callback instrumentation determines assertion ownership; JUnit counts only check completeness and never classify assertions.",
                  ]
                : []),
              ...designatedLimitations,
              ...snapshotLimitations,
            ]
          : [...CONTAINER_LIMITATIONS, ...designatedLimitations, ...snapshotLimitations],
    };
    if (
      bunAdapter &&
      ((await sha256File(BUN_TEST_DRIVER_PATH)) !== bunDriverDigest ||
        (await sha256File(BUN_TEST_HELPER_PATH)) !== bunHelperDigest ||
        (await sha256File(BUN_TEST_PRELOAD_PATH)) !== bunPreloadDigest)
    ) {
      throw new Error("BUN_TEST_ASSET_CHANGED_DURING_CAMPAIGN");
    }
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
