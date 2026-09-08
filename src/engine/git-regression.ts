import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EvidenceManifestContract } from "../contracts/index.js";
import { parseEvidenceManifest } from "../contracts/index.js";
import {
  assertSafeRelativePath,
  canonicalize,
  portablePathKey,
  sealManifestArtifact,
} from "../core/index.js";
import { verifyCampaign } from "./index.js";

const GIT_PROCESS_LIMIT = 32;
const GIT_PROCESS_TIMEOUT_MS = 5_000;
const GIT_AGGREGATE_TIMEOUT_MS = 30_000;
const GIT_PROCESS_TERMINATION_GRACE_MS = 250;
const IDENTITY_OUTPUT_LIMIT = 65_536;
const TREE_OUTPUT_LIMIT = 4_194_304;
const MAXIMUM_REPOSITORY_FILES = 10_000;
const MAXIMUM_REPOSITORY_BYTES = 104_857_600;
const MAXIMUM_BLOB_BYTES = 8_388_608;
const MAXIMUM_OVERLAY_BYTES = 1_048_576;
const MAXIMUM_CANDIDATE_BYTES = 1_048_576;
const MAXIMUM_BATCH_BYTES = 107_003_904;
const CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

const PACKAGE_IDENTITY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

interface GitTreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
  bytes?: Buffer;
}

interface ResolvedRevision {
  role: "reference" | "target" | "neutral";
  commit: string;
  tree: string;
  entries: Map<string, GitTreeEntry>;
}

export interface GitRegressionOptions {
  repository: string;
  before: string;
  after?: string;
  neutral: string;
  neutralReason: string;
  test: string;
  baseTests: string[];
  out: string;
  allowUnsafeExecution: boolean;
}

class GitBudget {
  readonly started = Date.now();
  processes = 0;

  claim(): number {
    this.processes += 1;
    if (this.processes > GIT_PROCESS_LIMIT) throw new Error("GIT_PROCESS_BUDGET_EXCEEDED");
    const remaining = GIT_AGGREGATE_TIMEOUT_MS - (Date.now() - this.started);
    if (remaining <= 0) throw new Error("GIT_AGGREGATE_DEADLINE_EXCEEDED");
    return Math.min(GIT_PROCESS_TIMEOUT_MS, remaining);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

async function runGitBytes(
  repository: string,
  args: readonly string[],
  budget: GitBudget,
  maximumOutputBytes: number,
  stdin?: Buffer,
): Promise<Buffer> {
  const timeoutMs = budget.claim();
  return runBoundedProcessBytes(
    "git",
    ["-C", repository, ...args],
    repository,
    gitEnvironment(),
    timeoutMs,
    maximumOutputBytes,
    stdin,
  );
}

async function runBoundedProcessBytes(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  maximumOutputBytes: number,
  stdin?: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      action();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      graceTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() => reject(new Error("GIT_PROCESS_TIMEOUT")));
      }, GIT_PROCESS_TERMINATION_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumOutputBytes) {
        exceeded = true;
        child.kill("SIGKILL");
      } else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > IDENTITY_OUTPUT_LIMIT) {
        exceeded = true;
        child.kill("SIGKILL");
      } else stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      settle(() => reject(new Error(`GIT_PROCESS_START_FAILED:${error.message}`)));
    });
    child.once("close", (code, signal) => {
      settle(() => {
        if (timedOut) reject(new Error("GIT_PROCESS_TIMEOUT"));
        else if (exceeded) reject(new Error("GIT_OUTPUT_BUDGET_EXCEEDED"));
        else if (code !== 0)
          reject(
            new Error(
              `GIT_COMMAND_FAILED:${String(code)}:${signal ?? "none"}:${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
        else resolve(Buffer.concat(stdout));
      });
    });
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      settle(() => reject(new Error(`GIT_STDIN_WRITE_FAILED:${error.code ?? "UNKNOWN"}`)));
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

export async function runBoundedProcessForTesting(options: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: Buffer;
}): Promise<Buffer> {
  return runBoundedProcessBytes(
    options.executable,
    options.args,
    options.cwd,
    {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
    options.timeoutMs,
    IDENTITY_OUTPUT_LIMIT,
    options.stdin,
  );
}

async function runGitText(
  repository: string,
  args: readonly string[],
  budget: GitBudget,
  maximumOutputBytes = IDENTITY_OUTPUT_LIMIT,
  stdin?: Buffer,
): Promise<string> {
  const bytes = await runGitBytes(repository, args, budget, maximumOutputBytes, stdin);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("GIT_OUTPUT_INVALID_UTF8");
  }
}

function oneLine(value: string, code: string): string {
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) throw new Error(code);
  return value;
}

function decodeGitText(bytes: Uint8Array, code: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(code);
  }
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) throw new Error(code);
  return decoded;
}

export function decodeGitTextForTesting(bytes: Uint8Array): string {
  return decodeGitText(bytes, "GIT_TEXT_INVALID_UTF8");
}

async function resolveRevision(
  repository: string,
  ref: string,
  role: ResolvedRevision["role"],
  objectFormat: string,
  budget: GitBudget,
): Promise<ResolvedRevision> {
  let commit: string;
  try {
    commit = oneLine(
      await runGitText(
        repository,
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        budget,
      ),
      "GIT_REVISION_INVALID",
    );
  } catch {
    throw new Error("GIT_REVISION_INVALID");
  }
  const expectedLength = objectFormat === "sha256" ? 64 : 40;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(commit))
    throw new Error("GIT_REVISION_INVALID");
  const tree = oneLine(
    await runGitText(
      repository,
      ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`],
      budget,
    ),
    "GIT_TREE_INVALID",
  );
  const raw = await runGitBytes(
    repository,
    ["ls-tree", "-rz", "--full-tree", commit],
    budget,
    TREE_OUTPUT_LIMIT,
  );
  const entries = parseTree(raw, expectedLength);
  return { role, commit, tree, entries };
}

function parseTree(raw: Buffer, oidLength: number): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  const portable = new Map<string, string>();
  const fileKeys = new Set<string>();
  const directoryKeys = new Set<string>();
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf(0, start);
    if (end < 0) throw new Error("GIT_TREE_RECORD_TRUNCATED");
    const record = raw.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("GIT_TREE_RECORD_INVALID");
    const header = record.subarray(0, tab).toString("ascii");
    const match = new RegExp(`^(\\d{6}) ([a-z]+) ([0-9a-f]{${oidLength}})$`).exec(header);
    if (!match) throw new Error("GIT_TREE_RECORD_INVALID");
    const entryPath = decodeGitText(record.subarray(tab + 1), "GIT_PATH_INVALID_UTF8");
    const safePath = assertSafeRelativePath(entryPath, ["."]);
    if (safePath !== entryPath) throw new Error("GIT_PATH_NOT_CANONICAL");
    const segments = safePath.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const spelling = segments.slice(0, length).join("/");
      const key = portablePathKey(spelling);
      const prior = portable.get(key);
      if (prior !== undefined && prior !== spelling) throw new Error("PORTABLE_PATH_COLLISION");
      const isFile = length === segments.length;
      if (
        (isFile && (directoryKeys.has(key) || fileKeys.has(key))) ||
        (!isFile && fileKeys.has(key))
      )
        throw new Error("GIT_PATH_TOPOLOGY_COLLISION");
      portable.set(key, spelling);
      if (isFile) fileKeys.add(key);
      else directoryKeys.add(key);
    }
    if (match[1] !== "100644" || match[2] !== "blob") {
      throw new Error("GIT_UNSUPPORTED_ENTRY_MODE");
    }
    entries.set(safePath, {
      mode: match[1],
      type: match[2],
      oid: match[3] as string,
      path: safePath,
    });
  }
  if (entries.size > MAXIMUM_REPOSITORY_FILES)
    throw new Error("GIT_REPOSITORY_FILE_BUDGET_EXCEEDED");
  return entries;
}

export function parseGitTreeForTesting(raw: Buffer): ReadonlyMap<string, unknown> {
  return parseTree(raw, 40);
}

function batchOutputLimit(sizes: readonly number[], oidLength: number): number {
  let total = 0;
  for (const size of sizes) {
    const next = size + oidLength + 1 + 4 + 1 + String(MAXIMUM_BLOB_BYTES).length + 2;
    if (!Number.isSafeInteger(next) || next < 0 || total > Number.MAX_SAFE_INTEGER - next)
      throw new Error("GIT_BLOB_BATCH_OUTPUT_BUDGET_INVALID");
    total += next;
  }
  return total;
}

export function batchOutputLimitForTesting(sizes: readonly number[], oidLength: number): number {
  return batchOutputLimit(sizes, oidLength);
}

async function loadBlobs(
  repository: string,
  revisions: readonly ResolvedRevision[],
  budget: GitBudget,
): Promise<void> {
  const oids = [
    ...new Set(
      revisions.flatMap((revision) => [...revision.entries.values()].map((entry) => entry.oid)),
    ),
  ];
  const input = Buffer.from(`${oids.join("\n")}\n`, "ascii");
  const metadataText = await runGitText(
    repository,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    budget,
    TREE_OUTPUT_LIMIT,
    input,
  );
  const metadata = metadataText.length === 0 ? [] : metadataText.split("\n");
  if (metadata.length !== oids.length) throw new Error("GIT_BLOB_METADATA_INVALID");
  const expectedSizes = new Map<string, number>();
  const orderedSizes: number[] = [];
  let expectedPayloadBytes = 0;
  for (const [index, line] of metadata.entries()) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    const expectedOid = oids[index];
    if (!match || expectedOid === undefined || match[1] !== expectedOid)
      throw new Error("GIT_BLOB_METADATA_INVALID");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("GIT_BLOB_METADATA_INVALID");
    if (size > MAXIMUM_BLOB_BYTES) throw new Error("GIT_BLOB_BUDGET_EXCEEDED_BEFORE_CONTENT");
    expectedPayloadBytes += size;
    if (expectedPayloadBytes > MAXIMUM_BATCH_BYTES)
      throw new Error("GIT_BLOB_BATCH_BUDGET_EXCEEDED_BEFORE_CONTENT");
    expectedSizes.set(expectedOid, size);
    orderedSizes.push(size);
  }
  const maximumBatchOutputBytes = batchOutputLimit(orderedSizes, oids[0]?.length ?? 40);
  const raw = await runGitBytes(
    repository,
    ["cat-file", "--batch"],
    budget,
    maximumBatchOutputBytes,
    input,
  );
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const expectedOid of oids) {
    const newline = raw.indexOf(10, offset);
    if (newline < 0) throw new Error("GIT_BLOB_BATCH_TRUNCATED");
    const header = raw.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== expectedOid) throw new Error("GIT_BLOB_BATCH_INVALID");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size !== expectedSizes.get(expectedOid))
      throw new Error("GIT_BLOB_BATCH_INVALID");
    const begin = newline + 1;
    const end = begin + size;
    if (end >= raw.length || raw[end] !== 10) throw new Error("GIT_BLOB_BATCH_TRUNCATED");
    blobs.set(expectedOid, Buffer.from(raw.subarray(begin, end)));
    offset = end + 1;
  }
  if (offset !== raw.length) throw new Error("GIT_BLOB_BATCH_INVALID");
  for (const revision of revisions) {
    let total = 0;
    for (const entry of revision.entries.values()) {
      const bytes = blobs.get(entry.oid);
      if (bytes === undefined) throw new Error("GIT_BLOB_MISSING");
      entry.bytes = bytes;
      total += bytes.length;
    }
    if (total > MAXIMUM_REPOSITORY_BYTES) throw new Error("GIT_REPOSITORY_BYTES_BUDGET_EXCEEDED");
  }
}

function requireUtf8(entry: GitTreeEntry, maximumBytes: number, code: string): string {
  const bytes = entry.bytes;
  if (bytes === undefined || bytes.length > maximumBytes) throw new Error(code);
  return decodeGitText(bytes, `${code}_INVALID_UTF8`);
}

function sameBytes(left: GitTreeEntry | undefined, right: GitTreeEntry | undefined): boolean {
  return left !== undefined && right !== undefined && left.oid === right.oid;
}

function assertPackageBoundary(revisions: readonly ResolvedRevision[]): void {
  const identityPaths = new Set(
    revisions.flatMap((revision) =>
      [...revision.entries.keys()].filter((entryPath) =>
        PACKAGE_IDENTITY_FILES.has(path.posix.basename(entryPath)),
      ),
    ),
  );
  for (const file of identityPaths) {
    const identities = revisions.map((revision) => revision.entries.get(file)?.oid ?? null);
    if (!identities.every((identity) => identity === identities[0]))
      throw new Error("GIT_PACKAGE_IDENTITY_DRIFT_UNSUPPORTED");
  }
  for (const packagePath of [...identityPaths].filter(
    (entryPath) => path.posix.basename(entryPath) === "package.json",
  )) {
    const packageEntry = revisions[0]?.entries.get(packagePath);
    if (packageEntry === undefined) continue;
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(
        requireUtf8(packageEntry, MAXIMUM_BLOB_BYTES, "GIT_PACKAGE_JSON_INVALID"),
      );
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("GIT_PACKAGE_JSON_INVALID");
      throw error;
    }
    if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson))
      throw new Error("GIT_PACKAGE_JSON_INVALID");
    const value = packageJson as Record<string, unknown>;
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const declarations = value[key];
      if (
        typeof declarations === "object" &&
        declarations !== null &&
        Object.keys(declarations).length > 0
      )
        throw new Error("GIT_RUNTIME_DEPENDENCIES_UNSUPPORTED");
    }
  }
}

function validateTopology(
  revisions: readonly ResolvedRevision[],
  selectedTest: string,
  baseTests: readonly string[],
): void {
  const projection = revisions.map((revision) =>
    [...revision.entries.keys()].filter((entryPath) => entryPath !== selectedTest).sort(),
  );
  const canonical = JSON.stringify(projection[0]);
  if (!projection.every((paths) => JSON.stringify(paths) === canonical))
    throw new Error("GIT_UNSUPPORTED_TOPOLOGY_DRIFT");
  for (const baseTest of baseTests) {
    const entries = revisions.map((revision) => revision.entries.get(baseTest));
    if (
      entries.some((entry) => entry === undefined) ||
      !entries.every((entry) => sameBytes(entry, entries[0]))
    )
      throw new Error("GIT_BASE_TEST_DRIFT_UNSUPPORTED");
  }
}

function validateOptions(options: GitRegressionOptions): {
  test: string;
  baseTests: string[];
  out: string;
} {
  if (options.allowUnsafeExecution !== true)
    throw new Error("GIT_REGRESSION_UNSAFE_EXECUTION_NOT_ALLOWED");
  const test = assertSafeRelativePath(options.test, ["."]);
  if (!/\.(?:cjs|mjs|js)$/.test(test)) throw new Error("GIT_REGRESSION_TEST_TYPE_UNSUPPORTED");
  const baseTests = options.baseTests.map((baseTest) => assertSafeRelativePath(baseTest, ["."]));
  if (baseTests.length === 0 || new Set(baseTests.map(portablePathKey)).size !== baseTests.length)
    throw new Error("GIT_REGRESSION_BASE_TESTS_INVALID");
  if (baseTests.some((baseTest) => portablePathKey(baseTest) === portablePathKey(test)))
    throw new Error("GIT_REGRESSION_BASE_TESTS_INVALID");
  const out = assertSafeRelativePath(options.out, ["."]);
  if (out.split("/").some((segment) => portablePathKey(segment) === ".git"))
    throw new Error("GIT_REGRESSION_OUTPUT_METADATA_FORBIDDEN");
  if (
    options.neutralReason.trim().length === 0 ||
    options.neutralReason.length > 256 ||
    [...options.neutralReason].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    })
  )
    throw new Error("GIT_REGRESSION_NEUTRAL_REASON_INVALID");
  return { test, baseTests, out };
}

function provenance(revision: ResolvedRevision, objectFormat: string, reason: string): string {
  const value = canonicalize({
    format: "assertledger-git-regression/1",
    role: revision.role,
    commit: revision.commit,
    tree: revision.tree,
    objectFormat,
    projection: "SELECTED_TEST_REMOVED_FOR_CONTROLS",
    reason,
  });
  if (value.length > 1_024) throw new Error("GIT_REGRESSION_PROVENANCE_TOO_LARGE");
  return value;
}

function changedFiles(
  base: ResolvedRevision,
  revision: ResolvedRevision,
  omitted: ReadonlySet<string>,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  for (const [entryPath, entry] of revision.entries) {
    if (omitted.has(portablePathKey(entryPath))) continue;
    if (entry.oid === base.entries.get(entryPath)?.oid) continue;
    const content = requireUtf8(entry, MAXIMUM_OVERLAY_BYTES, "GIT_WORLD_OVERLAY_UNSUPPORTED");
    bytes += Buffer.byteLength(content);
    if (bytes > MAXIMUM_OVERLAY_BYTES) throw new Error("GIT_WORLD_OVERLAY_BUDGET_EXCEEDED");
    files.push({ path: entryPath, content });
  }
  return files;
}

function assertBaseControlsDiscoveredTests(manifest: EvidenceManifestContract): void {
  for (const worldId of ["fixed", "known-bug", "neutral"]) {
    const observations = manifest.observations.filter(
      (observation) => observation.candidateId === null && observation.worldId === worldId,
    );
    if (
      observations.length !== 2 ||
      observations.some(
        (observation) =>
          observation.outcome !== "PASS" ||
          observation.testsDiscovered < 1 ||
          (observation.attempt !== 1 && observation.attempt !== 2),
      )
    )
      throw new Error("GIT_BASE_TESTS_NOT_DISCOVERED");
  }
}

async function materializeBase(
  root: string,
  revision: ResolvedRevision,
  selectedTest: string,
): Promise<void> {
  let total = 0;
  for (const entry of revision.entries.values()) {
    if (entry.path === selectedTest) continue;
    const bytes = entry.bytes;
    if (bytes === undefined) throw new Error("GIT_BLOB_MISSING");
    total += bytes.length;
    if (total > MAXIMUM_REPOSITORY_BYTES) throw new Error("GIT_REPOSITORY_BYTES_BUDGET_EXCEEDED");
    const target = path.join(root, ...entry.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

async function reserveOutputTarget(
  repository: string,
  output: string,
  sourcePaths: readonly string[],
  metadataRoots: readonly string[],
): Promise<string> {
  const target = path.resolve(repository, ...output.split("/"));
  const relative = path.relative(repository, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("GIT_REGRESSION_OUTPUT_OUTSIDE_REPOSITORY");
  const isWithin = (candidate: string, root: string) => {
    const relation = path.relative(root, candidate);
    return (
      relation === "" ||
      (!relation.startsWith(`..${path.sep}`) && relation !== ".." && !path.isAbsolute(relation))
    );
  };
  if (metadataRoots.some((root) => isWithin(target, root)))
    throw new Error("GIT_REGRESSION_OUTPUT_METADATA_FORBIDDEN");
  const outputKey = portablePathKey(output);
  if (
    sourcePaths.some((source) => {
      const key = portablePathKey(source);
      return (
        key === outputKey || key.startsWith(`${outputKey}/`) || outputKey.startsWith(`${key}/`)
      );
    })
  )
    throw new Error("GIT_REGRESSION_OUTPUT_OVERLAPS_SOURCE");
  try {
    await lstat(target);
    throw new Error("GIT_REGRESSION_OUTPUT_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let current = repository;
  for (const segment of output.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink() || !information.isDirectory())
        throw new Error("GIT_REGRESSION_OUTPUT_PARENT_UNSAFE");
      const resolved = await realpath(current);
      if (metadataRoots.some((root) => isWithin(resolved, root)))
        throw new Error("GIT_REGRESSION_OUTPUT_METADATA_FORBIDDEN");
      const rel = path.relative(repository, resolved);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        throw new Error("GIT_REGRESSION_OUTPUT_PARENT_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  const resolvedParent = await realpath(path.dirname(target));
  const parentRelative = path.relative(repository, resolvedParent);
  if (
    parentRelative === ".." ||
    parentRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(parentRelative)
  )
    throw new Error("GIT_REGRESSION_OUTPUT_PARENT_UNSAFE");
  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("GIT_REGRESSION_OUTPUT_EXISTS");
    throw error;
  }
  return target;
}

function markdown(value: string): string {
  return value
    .replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function resolvedWorldCommit(manifest: EvidenceManifestContract, worldId: string): string {
  const provenance = manifest.evidenceContext.worlds.find(
    (world) => world.id === worldId,
  )?.provenance;
  if (provenance === undefined) throw new Error("GIT_REGRESSION_PROVENANCE_INVALID");
  try {
    const value = JSON.parse(provenance) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("commit" in value) ||
      typeof value.commit !== "string"
    )
      throw new Error("GIT_REGRESSION_PROVENANCE_INVALID");
    return value.commit;
  } catch (error) {
    if (error instanceof Error && error.message === "GIT_REGRESSION_PROVENANCE_INVALID")
      throw error;
    throw new Error("GIT_REGRESSION_PROVENANCE_INVALID");
  }
}

function inlineCode(value: string): string {
  const longestBackticks = Math.max(
    0,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBackticks + 1);
  return `${fence} ${value} ${fence}`;
}

function shellArgument(value: string): string {
  const escaped = value.replaceAll("'", process.platform === "win32" ? "''" : "'\"'\"'");
  return `'${escaped}'`;
}

export function renderGitRegressionSummary(
  manifest: EvidenceManifestContract,
  options: GitRegressionOptions,
): string {
  const targetCommit = resolvedWorldCommit(manifest, "known-bug");
  const referenceCommit = resolvedWorldCommit(manifest, "fixed");
  const manifestPath = path.resolve(options.repository, options.out, "manifest.json");
  const replayCommand = `assertledger replay ${shellArgument(manifestPath)} --json`;
  const detection = manifest.observations
    .filter(
      (observation) =>
        observation.candidateId === "git-regression-candidate" &&
        observation.worldId === "known-bug",
    )
    .map(
      (observation) =>
        `attempt ${observation.attempt}: ${observation.outcome}, attributed=${String(observation.attributed)}`,
    )
    .join("; ");
  return [
    "# AssertLedger Git regression qualification",
    "",
    `- Verdict: **${manifest.decision.status}**`,
    `- Candidate: ${inlineCode(options.test)}`,
    `- Known bug commit: \`${targetCommit}\``,
    `- Fixed commit: \`${referenceCommit}\``,
    `- Known-bug observations: ${detection || "none"}`,
    `- Reason codes: ${manifest.decision.reasonCodes.join(", ") || "none"}`,
    ...manifest.candidates.map(
      (candidate) =>
        `- Candidate reasons (${candidate.id}): ${candidate.reasonCodes.join(", ") || "none"}`,
    ),
    `- Neutral reason: ${markdown(options.neutralReason)}`,
    "- Execution: **UNSANDBOXED trusted-local** (explicit operator opt-in)",
    "",
    "## Limitations:",
    "",
    ...manifest.limitations.map((limitation) => `- ${markdown(limitation)}`),
    "",
    "The saved executed request points to a removed disposable snapshot and is inspection evidence, not a standalone rerun input.",
    `Replay (${process.platform === "win32" ? "PowerShell" : "POSIX shell"}): ${inlineCode(replayCommand)}`,
    "A REJECTED verdict only describes this declared fault model; it does not prove that the test has no value elsewhere.",
    "",
  ].join("\n");
}

async function writeEvidence(
  target: string,
  manifest: EvidenceManifestContract,
  request: unknown,
  summaryText: string,
): Promise<void> {
  const pendingManifest = path.join(target, `.manifest-${randomUUID()}.tmp`);
  const ownedFiles: string[] = [];
  let completed = false;
  try {
    const executedRequest = path.join(target, "executed-request.json");
    await writeFile(executedRequest, `${canonicalize(request)}\n`, {
      flag: "wx",
    });
    ownedFiles.push(executedRequest);
    const summaryPath = path.join(target, "summary.md");
    await writeFile(summaryPath, summaryText, { flag: "wx" });
    ownedFiles.push(summaryPath);
    await writeFile(pendingManifest, `${canonicalize(manifest)}\n`, { flag: "wx" });
    ownedFiles.push(pendingManifest);
    await rename(pendingManifest, path.join(target, "manifest.json"));
    completed = true;
  } finally {
    if (!completed) {
      for (const ownedFile of ownedFiles.reverse()) await rm(ownedFile, { force: true });
    }
  }
}

async function cleanupReservedOutput(target: string): Promise<void> {
  try {
    await rmdir(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

export async function qualifyGitRegression(
  options: GitRegressionOptions,
): Promise<EvidenceManifestContract> {
  const validated = validateOptions(options);
  const repository = await realpath(path.resolve(options.repository));
  if (!(await stat(repository)).isDirectory()) throw new Error("GIT_REPOSITORY_INVALID");
  const budget = new GitBudget();
  const topLevel = await realpath(
    oneLine(
      await runGitText(repository, ["rev-parse", "--show-toplevel"], budget),
      "GIT_REPOSITORY_INVALID",
    ),
  );
  if (topLevel !== repository) throw new Error("GIT_REPOSITORY_ROOT_REQUIRED");
  const gitDirectory = await realpath(
    await runGitText(repository, ["rev-parse", "--absolute-git-dir"], budget),
  );
  const commonDirectoryValue = await runGitText(
    repository,
    ["rev-parse", "--git-common-dir"],
    budget,
  );
  const gitCommonDirectory = await realpath(
    path.isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : path.resolve(repository, commonDirectoryValue),
  );
  const objectFormat = oneLine(
    await runGitText(repository, ["rev-parse", "--show-object-format"], budget),
    "GIT_OBJECT_FORMAT_INVALID",
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw new Error("GIT_OBJECT_FORMAT_INVALID");
  const afterRef = options.after ?? "HEAD";
  const reference = await resolveRevision(repository, afterRef, "reference", objectFormat, budget);
  const target = await resolveRevision(repository, options.before, "target", objectFormat, budget);
  const neutral = await resolveRevision(
    repository,
    options.neutral,
    "neutral",
    objectFormat,
    budget,
  );
  if (target.tree === reference.tree) throw new Error("GIT_BEFORE_AFTER_IDENTICAL");
  try {
    await runGitText(
      repository,
      ["merge-base", "--is-ancestor", target.commit, reference.commit],
      budget,
    );
  } catch {
    throw new Error("GIT_BEFORE_NOT_ANCESTOR_OF_AFTER");
  }
  await loadBlobs(repository, [reference, target, neutral], budget);
  validateTopology([reference, target, neutral], validated.test, validated.baseTests);
  assertPackageBoundary([reference, target, neutral]);
  const candidateEntry = reference.entries.get(validated.test);
  if (candidateEntry === undefined) throw new Error("GIT_REGRESSION_TEST_MISSING_AT_AFTER");
  const candidateContent = requireUtf8(
    candidateEntry,
    MAXIMUM_CANDIDATE_BYTES,
    "GIT_REGRESSION_CANDIDATE_BUDGET_EXCEEDED",
  );
  const outputTarget = await reserveOutputTarget(
    repository,
    validated.out,
    [...reference.entries.keys()],
    [gitDirectory, gitCommonDirectory],
  );
  const omitted = new Set([validated.test, ...validated.baseTests].map(portablePathKey));
  let temporaryRoot: string | undefined;
  let outputCompleted = false;
  let operationError: unknown;
  let cleanupError: unknown;
  let result: EvidenceManifestContract | undefined;
  try {
    temporaryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "assertledger-git-regression-")),
    );
    const snapshot = path.join(temporaryRoot, "repository");
    await mkdir(snapshot, { recursive: false });
    await materializeBase(snapshot, reference, validated.test);
    const request = {
      schemaVersion: "1.0.0",
      repository: { root: snapshot, exclude: ["node_modules", ".git", ".testforge"] },
      adapter: {
        kind: "node-test" as const,
        executable: process.execPath,
        baseTestFiles: validated.baseTests,
      },
      isolation: {
        kind: "trusted-local" as const,
        acknowledgedUnsafeExecution: true,
        environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
      },
      candidateRoots: [validated.test],
      budgets: {
        maximumCandidates: 1,
        maximumWorlds: 3,
        maximumExecutions: 12,
        maximumRepositoryFiles: MAXIMUM_REPOSITORY_FILES,
        maximumRepositoryBytes: MAXIMUM_REPOSITORY_BYTES,
        maximumWorldOverlayBytes: MAXIMUM_OVERLAY_BYTES,
        maximumCandidateBytes: MAXIMUM_CANDIDATE_BYTES,
        maximumTotalCandidateBytes: MAXIMUM_CANDIDATE_BYTES,
        timeoutMsPerExecution: 5_000,
        maximumOutputBytes: 65_536,
      },
      policy: {
        policyVersion: "1.0.0",
        requiredAttempts: 2,
        minimumTargetWeightPermille: 1_000,
        maximumSelectedCandidates: 1,
        acceptedTargetOutcomes: ["ASSERTION_FAILURE" as const],
      },
      worlds: [
        {
          id: "fixed",
          kind: "REFERENCE" as const,
          required: true,
          weight: 0,
          provenance: provenance(
            reference,
            objectFormat,
            "fixed revision with selected test removed for controls",
          ),
          files: [],
        },
        {
          id: "known-bug",
          kind: "TARGET" as const,
          required: true,
          weight: 1,
          provenance: provenance(
            target,
            objectFormat,
            "known bug revision projected onto the fixed snapshot",
          ),
          files: changedFiles(reference, target, omitted),
        },
        {
          id: "neutral",
          kind: "NEUTRAL" as const,
          required: true,
          weight: 0,
          provenance: provenance(neutral, objectFormat, options.neutralReason),
          files: changedFiles(reference, neutral, omitted),
        },
      ],
      candidates: [
        {
          id: "git-regression-candidate",
          files: [{ path: validated.test, content: candidateContent }],
        },
      ],
    };
    const sourceManifest = parseEvidenceManifest(await verifyCampaign(request));
    assertBaseControlsDiscoveredTests(sourceManifest);
    const limitations = [
      ...sourceManifest.limitations,
      "Git regression qualification covers committed revisions only; dirty checkout content is ignored.",
      "The first Git slice supports node:test JavaScript with built-in and relative imports and no runtime dependencies.",
      neutral.tree === reference.tree
        ? "The neutral control repeats the fixed tree and provides no independent robustness evidence."
        : "The operator supplied the neutral revision and reason; AssertLedger does not infer its independence.",
      "Manifest integrity binds recorded Git provenance but replay does not independently authenticate Git objects or execution.",
    ];
    const manifest = parseEvidenceManifest(
      sealManifestArtifact({ ...sourceManifest, limitations }),
    );
    await rm(temporaryRoot, CLEANUP_OPTIONS);
    temporaryRoot = undefined;
    await writeEvidence(
      outputTarget,
      manifest,
      request,
      renderGitRegressionSummary(manifest, options),
    );
    outputCompleted = true;
    result = manifest;
  } catch (error) {
    operationError = error;
  } finally {
    try {
      if (temporaryRoot !== undefined) await rm(temporaryRoot, CLEANUP_OPTIONS);
    } catch (error) {
      cleanupError = error;
    } finally {
      if (!outputCompleted) {
        try {
          await cleanupReservedOutput(outputTarget);
        } catch (error) {
          cleanupError ??= error;
        }
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error("GIT_REGRESSION_RESULT_MISSING");
  return result;
}
