import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { ContainerIsolation, ExecutionBackendRecord } from "../contracts/index.js";
import type { ProcessInput, ProcessResult } from "./index.js";
import { type RuntimeTraceContext, traceOperation, withRuntimeTrace } from "./runtime-trace.js";

// Container backend for a Docker-compatible CLI. Nothing on the host is mounted into the container:
// the prepared workspace is streamed into an anonymous volume, only the bounded result file is read
// back as an archive in memory, and every container is removed after one execution.

export const DEFAULT_CONTAINER_RUNTIME_COMMAND: readonly string[] = ["docker"];
export const DEFAULT_CONTAINER_LIMITS = {
  memoryBytes: 1_073_741_824,
  cpuMillicores: 2_000,
  pids: 256,
  temporaryDirectoryBytes: 67_108_864,
} as const;
export const CONTAINER_ROOT = "/assertledger";
export const CONTAINER_WORKSPACE = `${CONTAINER_ROOT}/repository`;
export const CONTAINER_RESULT_FILE = `${CONTAINER_ROOT}/out/result.json`;
export const CONTAINER_REPORTER_FILE = `${CONTAINER_ROOT}/reporter/node-test-reporter.mjs`;
/** Read-only adapter files, such as the Bun driver, are placed beside the reporter. */
export const CONTAINER_ASSET_DIRECTORY = `${CONTAINER_ROOT}/reporter`;
export const CONTAINER_LIMITATIONS = [
  "Container isolation relies on the operator-administered container runtime and the shared host kernel; it is not a virtual machine boundary.",
  "The writable workspace volume has no size limit enforced by AssertLedger; container storage limits remain operator-administered.",
  "An interrupted AssertLedger process can leave a container labeled assertledger.execution until the operator removes it.",
  "The image contents and declared environment values are operator inputs; AssertLedger verifies the image digest but does not inspect its contents.",
];

const SANDBOX_ID = 65_534;
const SANDBOX_USER = `${SANDBOX_ID}:${SANDBOX_ID}`;
const CONTROL_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 600_000;
const CONTROL_OUTPUT_BYTES = 1_048_576;
const RESULT_ARCHIVE_OVERHEAD_BYTES = 16_384;
const TAR_BLOCK_BYTES = 512;
const EMPTY_OUTPUT_DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type ContainerBackendRecord = Extract<ExecutionBackendRecord, { kind: "container" }>;

export interface BoundedProcessResult extends ProcessResult {
  stdoutBytes: Buffer;
}

export type ContainerProcessRunner = (
  input: ProcessInput,
  standardInput?: AsyncIterable<Uint8Array>,
) => Promise<BoundedProcessResult>;

export interface ContainerBackend {
  runtimeCommand: string[];
  isolation: ContainerIsolation;
  record: ContainerBackendRecord;
  traceContext?: RuntimeTraceContext;
  controlRunner?: ContainerProcessRunner;
  /** A sealed snapshot and overlay recipe, assigned only by the engine after qualification. */
  workspaceIdentity?: string;
  uploadArchives?: ContainerUploadArchives;
}

export interface ContainerUploadArchives {
  entries: Map<string, { bytes: Buffer; digest: string; size: number }>;
  bytes: number;
  maximumBytes: number;
}

export interface ContainerExecution {
  workspace: string;
  reporterSource?: string;
  /** Engine-owned files with plain names, written read-only to CONTAINER_ASSET_DIRECTORY. */
  assets?: ReadonlyArray<{ name: string; content: string }>;
  executable: string;
  args: string[];
  environment: Record<string, string>;
  timeoutMs: number;
  maximumOutputBytes: number;
  resultMaximumBytes?: number;
}

export interface ContainerExecutionResult {
  process: ProcessResult;
  result: Buffer | undefined;
}

interface RuntimeContext {
  command: readonly string[];
  runner: ContainerProcessRunner;
  workingDirectory: string;
  traceContext?: RuntimeTraceContext & { container?: string };
  controlRunner?: ContainerProcessRunner;
  uploadReuse?: { reused: boolean };
}

async function runtime(
  context: RuntimeContext,
  args: string[],
  timeoutMs: number,
  maximumOutputBytes: number,
  standardInput?: AsyncIterable<Uint8Array>,
): Promise<BoundedProcessResult> {
  const [executable, ...prefix] = context.command;
  const phase =
    args[0] === "cp"
      ? args.includes("--archive")
        ? "upload"
        : "download"
      : args[0] === "rm"
        ? "remove"
        : args[0] === "image"
          ? "image-inspect"
          : (args[0] ?? "unknown");
  let inputBytes = 0;
  async function* countedInput() {
    if (standardInput)
      for await (const chunk of standardInput) {
        inputBytes += chunk.byteLength;
        yield chunk;
      }
  }
  const control = args[0] === "start" ? undefined : context.controlRunner;
  const result = await traceOperation(
    phase,
    { ...context.traceContext, timeoutMs, transport: control === undefined ? "cli" : "stdio-api" },
    () =>
      (control ?? context.runner)(
        {
          executable: executable as string,
          args: [...prefix, ...args],
          cwd: context.workingDirectory,
          environment: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          timeoutMs,
          maximumOutputBytes,
        },
        standardInput === undefined ? undefined : countedInput(),
      ),
    (result) => ({
      inputBytes,
      runtimeInvocations: control === undefined ? 1 : 0,
      ...(phase === "upload" ? { archiveReused: context.uploadReuse?.reused ?? false } : {}),
      outcome: result?.outcome ?? null,
      processDurationMs: result?.durationMs ?? null,
    }),
  );
  // Only cleanup can retry through the CLI after an ambiguous API failure.
  if (
    control !== undefined &&
    result.outcome !== "PASS" &&
    (args[0] === "kill" || args[0] === "rm")
  ) {
    const { controlRunner: _control, ...cliContext } = context;
    return runtime(cliContext, args, timeoutMs, maximumOutputBytes);
  }
  return result;
}

export type ContainerTransport = "auto" | "cli" | "stdio";

export function parseContainerTransport(value: unknown): ContainerTransport {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "cli" || value === "stdio") return value;
  throw new Error("CONTAINER_TRANSPORT_INVALID");
}

/** Validates an operator runtime command: a non-empty argv array, never a shell string. */
export function parseContainerRuntimeCommand(value: unknown): string[] {
  let command = value;
  if (typeof value === "string") {
    try {
      command = JSON.parse(value) as unknown;
    } catch {
      throw backendError("CONTAINER_RUNTIME_COMMAND_INVALID");
    }
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 16 ||
    !command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4_096)
  ) {
    throw backendError("CONTAINER_RUNTIME_COMMAND_INVALID");
  }
  return [...(command as string[])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maximumLength: number,
  minimumLength = 1,
): string | undefined {
  return typeof value === "string" && value.length >= minimumLength && value.length <= maximumLength
    ? value
    : undefined;
}

function backendError(code: string, detail?: string): Error {
  return new Error(code, detail === undefined ? undefined : { cause: detail });
}

function parseJsonOutput(result: BoundedProcessResult): unknown {
  if (result.outcome !== "PASS" || result.stdout.truncated) return undefined;
  try {
    return JSON.parse(result.stdout.text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

function runtimeDetail(result: BoundedProcessResult): string {
  return (result.error ?? result.stderr.text).trim().slice(0, 1_024);
}

/** Probes the runtime and the pinned image without pulling, creating or starting anything. */
export async function prepareContainerBackend(
  command: readonly string[],
  isolation: ContainerIsolation,
  runner: ContainerProcessRunner,
  workingDirectory: string,
): Promise<ContainerBackend> {
  const context: RuntimeContext = {
    command: parseContainerRuntimeCommand(command),
    runner,
    workingDirectory,
  };
  const version = await runtime(
    context,
    ["version", "--format={{json .}}"],
    CONTROL_TIMEOUT_MS,
    CONTROL_OUTPUT_BYTES,
  );
  if (version.outcome === "INFRA_ERROR") {
    throw backendError("CONTAINER_RUNTIME_NOT_FOUND", runtimeDetail(version));
  }
  const versionReport = parseJsonOutput(version);
  const client = isRecord(versionReport) ? versionReport.Client : undefined;
  const server = isRecord(versionReport) ? versionReport.Server : undefined;
  if (!isRecord(client) || !isRecord(server)) {
    throw backendError("CONTAINER_RUNTIME_UNAVAILABLE", runtimeDetail(version));
  }
  const clientVersion = boundedString(client.Version, 128);
  const serverVersion = boundedString(server.Version, 128);
  const serverArchitecture = boundedString(server.Arch, 64);
  if (
    clientVersion === undefined ||
    serverVersion === undefined ||
    serverArchitecture === undefined
  ) {
    throw backendError("CONTAINER_RUNTIME_UNAVAILABLE", "unrecognized runtime version report");
  }
  if (server.Os !== "linux") {
    throw backendError("CONTAINER_RUNTIME_PLATFORM_UNSUPPORTED", String(server.Os));
  }

  const info = parseJsonOutput(
    await runtime(
      context,
      ["info", "--format={{json .}}"],
      CONTROL_TIMEOUT_MS,
      CONTROL_OUTPUT_BYTES,
    ),
  );
  const securityOptions = isRecord(info) ? info.SecurityOptions : undefined;
  const cgroupVersion = isRecord(info) ? boundedString(info.CgroupVersion ?? "", 16, 0) : undefined;
  if (
    cgroupVersion === undefined ||
    !Array.isArray(securityOptions) ||
    securityOptions.length > 64 ||
    !securityOptions.every((option) => boundedString(option, 512) !== undefined)
  ) {
    throw backendError("CONTAINER_RUNTIME_UNAVAILABLE", "unrecognized runtime information report");
  }

  const inspected = await runtime(
    context,
    ["image", "inspect", "--format={{json .}}", isolation.image],
    CONTROL_TIMEOUT_MS,
    CONTROL_OUTPUT_BYTES,
  );
  if (inspected.outcome !== "PASS") {
    throw backendError("CONTAINER_IMAGE_NOT_PRESENT", runtimeDetail(inspected));
  }
  const image = parseJsonOutput(inspected);
  if (!isRecord(image)) {
    throw backendError("CONTAINER_RUNTIME_UNAVAILABLE", "unrecognized image inspection report");
  }
  if (image.Os !== "linux") {
    throw backendError("CONTAINER_IMAGE_PLATFORM_UNSUPPORTED", String(image.Os));
  }
  const digest = isolation.image.slice(isolation.image.lastIndexOf("@") + 1);
  const repositoryDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  const imageId = typeof image.Id === "string" ? image.Id : "";
  const architecture = boundedString(image.Architecture, 64);
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(imageId) ||
    architecture === undefined ||
    !(
      imageId === digest ||
      repositoryDigests.some((value) => typeof value === "string" && value.endsWith(`@${digest}`))
    )
  ) {
    throw backendError("CONTAINER_IMAGE_DIGEST_MISMATCH", imageId);
  }

  return {
    runtimeCommand: [...context.command],
    isolation,
    record: {
      kind: "container",
      level: "CONTAINER",
      image: { reference: isolation.image, id: imageId, os: "linux", architecture },
      runtime: {
        clientVersion,
        serverVersion,
        serverOs: "linux",
        serverArchitecture,
        cgroupVersion,
        securityOptions: securityOptions as string[],
      },
      controls: {
        network: "none",
        rootFilesystem: "read-only",
        hostMounts: "none",
        workspace: "anonymous-volume",
        user: SANDBOX_USER,
        capabilities: "none",
        noNewPrivileges: true,
        imagePull: "never",
        logDriver: "none",
        environment: isolation.environment.map(({ name, value }) => ({ name, value })),
        limits: { ...isolation.limits },
      },
    },
  };
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
  return `${length}${body}`;
}

function padding(size: number): Buffer {
  return Buffer.alloc((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES, 0);
}

function ustarHeader(
  name: string,
  type: "0" | "5" | "x",
  size: number,
  mode: number,
  owner: number,
): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, owner);
  writeOctal(header, 116, 8, owner);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function* entryHeaders(
  name: string,
  type: "0" | "5",
  size: number,
  mode: number,
  owner: number,
): Generator<Buffer> {
  // Names that do not fit an ASCII ustar field, and sizes beyond its octal range, use PAX records.
  const asciiName = /^[\x20-\x7e]*$/u.test(name) && Buffer.byteLength(name) <= 100;
  const records = [
    ...(asciiName ? [] : [paxRecord("path", name)]),
    ...(size < 8 ** 11 ? [] : [paxRecord("size", String(size))]),
  ];
  if (records.length > 0) {
    const body = Buffer.from(records.join(""), "utf8");
    yield ustarHeader("PaxHeader", "x", body.length, 0o644, 0);
    yield body;
    yield padding(body.length);
  }
  yield ustarHeader(
    asciiName ? name : `entry${type === "5" ? "/" : ""}`,
    type,
    size < 8 ** 11 ? size : 0,
    mode,
    owner,
  );
}

async function* workspaceEntries(directory: string, archivePath: string): AsyncGenerator<Buffer> {
  const names = (await readdir(directory)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const name of names) {
    const hostPath = path.join(directory, name);
    const entryPath = `${archivePath}/${name}`;
    const stats = await lstat(hostPath);
    if (stats.isDirectory()) {
      yield* entryHeaders(`${entryPath}/`, "5", 0, 0o755, SANDBOX_ID);
      yield* workspaceEntries(hostPath, entryPath);
    } else if (stats.isFile()) {
      yield* entryHeaders(entryPath, "0", stats.size, 0o644, SANDBOX_ID);
      let streamed = 0;
      for await (const chunk of createReadStream(hostPath)) {
        const bytes = chunk as Buffer;
        streamed += bytes.byteLength;
        if (streamed > stats.size) throw new Error("CONTAINER_WORKSPACE_CHANGED");
        yield bytes;
      }
      if (streamed !== stats.size) throw new Error("CONTAINER_WORKSPACE_CHANGED");
      yield padding(stats.size);
    } else {
      throw new Error("CONTAINER_WORKSPACE_ENTRY_UNSUPPORTED");
    }
  }
}

async function* uploadArchive(
  workspace: string,
  reporterSource?: string,
  assets: ReadonlyArray<{ name: string; content: string }> = [],
): AsyncGenerator<Buffer> {
  yield* entryHeaders("out/", "5", 0, 0o755, SANDBOX_ID);
  const files = [
    ...(reporterSource === undefined
      ? []
      : [{ name: "node-test-reporter.mjs", content: reporterSource }]),
    ...assets,
  ];
  if (files.some((file) => !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(file.name))) {
    throw new Error("CONTAINER_ASSET_NAME_INVALID");
  }
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new Error("CONTAINER_ASSET_NAME_INVALID");
  }
  if (files.length > 0) yield* entryHeaders("reporter/", "5", 0, 0o555, 0);
  for (const file of files) {
    const bytes = Buffer.from(file.content, "utf8");
    yield* entryHeaders(`reporter/${file.name}`, "0", bytes.length, 0o444, 0);
    yield bytes;
    yield padding(bytes.length);
  }
  yield* entryHeaders("repository/", "5", 0, 0o755, SANDBOX_ID);
  yield* workspaceEntries(workspace, "repository");
  yield Buffer.alloc(TAR_BLOCK_BYTES * 2, 0);
}

/** Compression coalesces small tar writes; the daemon extracts exactly the same archive. */
async function* compressedUploadArchive(
  workspace: string,
  reporterSource?: string,
  assets?: ReadonlyArray<{ name: string; content: string }>,
): AsyncGenerator<Buffer> {
  // Construct lazily: a failed runtime must not leave an unread stream opening workspace files.
  const source = Readable.from(uploadArchive(workspace, reporterSource, assets), {
    objectMode: false,
  });
  const compressed = source.compose(createGzip({ level: 1, chunkSize: 65_536 }));
  try {
    for await (const chunk of compressed) yield chunk as Buffer;
  } finally {
    compressed.destroy();
    source.destroy();
  }
}

/** Shares immutable transfer bytes within this campaign, never a writable workspace or result. */
async function* executionUploadArchive(
  backend: ContainerBackend,
  execution: ContainerExecution,
  metadata: { reused: boolean },
): AsyncGenerator<Buffer> {
  const source = () =>
    compressedUploadArchive(execution.workspace, execution.reporterSource, execution.assets);
  const store = backend.uploadArchives;
  if (store === undefined || backend.workspaceIdentity === undefined) {
    yield* source();
    return;
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        workspace: backend.workspaceIdentity,
        reporter: execution.reporterSource ?? null,
        assets: (execution.assets ?? []).map(({ name, content }) => ({ name, content })),
      }),
    )
    .digest("hex");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const existing = store.entries.get(key);
  if (existing !== undefined) {
    if (existing.size === existing.bytes.length && existing.digest === digest(existing.bytes)) {
      metadata.reused = true;
      for (let offset = 0; offset < existing.bytes.length; offset += 65_536) {
        // Each delivery owns its writable Buffer; readers cannot mutate the stored bytes.
        yield Buffer.from(existing.bytes.subarray(offset, offset + 65_536));
      }
      return;
    }
    store.entries.delete(key);
    store.bytes = Math.max(0, store.bytes - existing.size);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let retain = true;
  for await (const chunk of source()) {
    length += chunk.length;
    if (retain && length > store.maximumBytes - store.bytes) {
      retain = false;
      chunks.length = 0;
    }
    if (retain) chunks.push(Buffer.from(chunk));
    yield chunk;
  }
  // Reaching this line proves the complete producer stream was consumed, including gzip EOF.
  if (retain && !store.entries.has(key) && length <= store.maximumBytes - store.bytes) {
    const bytes = Buffer.concat(chunks, length);
    store.entries.set(key, { bytes, digest: digest(bytes), size: bytes.length });
    store.bytes += bytes.length;
  }
}

function readOctal(header: Buffer, offset: number, length: number): number | undefined {
  const text = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/[\0 ]+$/u, "");
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : undefined;
}

function nulTerminated(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString("utf8");
}

/**
 * Extracts the single regular `result.json` entry that `cp CONTAINER:FILE -` streams. Links, extra
 * entries, other names, corrupt headers, truncation and oversize content are all rejected.
 */
function readContainerResultArchive(archive: Buffer, maximumBytes: number): Buffer | undefined {
  let offset = 0;
  let paxPath: string | undefined;
  let paxSize: number | undefined;
  let result: Buffer | undefined;
  while (offset + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) return result;
    const recordedChecksum = readOctal(header, 148, 8);
    const checksum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    );
    const headerSize = readOctal(header, 124, 12);
    if (recordedChecksum !== checksum || headerSize === undefined) return undefined;
    const size = paxSize ?? headerSize;
    const dataStart = offset + TAR_BLOCK_BYTES;
    const next = dataStart + size + padding(size).length;
    if (next > archive.length) return undefined;
    const data = archive.subarray(dataStart, dataStart + size);
    const type = String.fromCharCode(header[156] ?? 0);
    offset = next;
    if (type === "x" || type === "g") {
      if (type === "g") continue;
      for (const record of data.toString("utf8").split("\n")) {
        const match = /^\d+ (path|size)=(.*)$/su.exec(record);
        if (match?.[1] === "path") paxPath = match[2];
        if (match?.[1] === "size") paxSize = /^\d+$/u.test(match[2] ?? "") ? Number(match[2]) : NaN;
      }
      if (Number.isNaN(paxSize)) return undefined;
      continue;
    }
    const prefix = nulTerminated(header.subarray(345, 500));
    const shortName = nulTerminated(header.subarray(0, 100));
    const name = paxPath ?? (prefix.length > 0 ? `${prefix}/${shortName}` : shortName);
    paxPath = undefined;
    paxSize = undefined;
    if (
      result !== undefined ||
      (type !== "0" && type !== "\0") ||
      name !== "result.json" ||
      size > maximumBytes
    ) {
      return undefined;
    }
    result = Buffer.from(data);
  }
  return undefined;
}

export const readContainerResultArchiveForTesting = readContainerResultArchive;

interface ContainerState {
  status: string;
  exitCode: number;
  error: string;
  startedAt: string;
}

async function inspectState(
  context: RuntimeContext,
  name: string,
): Promise<ContainerState | undefined> {
  const state = parseJsonOutput(
    await runtime(
      context,
      ["inspect", "--type=container", "--format={{json .State}}", name],
      CONTROL_TIMEOUT_MS,
      CONTROL_OUTPUT_BYTES,
    ),
  );
  if (
    !isRecord(state) ||
    typeof state.Status !== "string" ||
    !Number.isSafeInteger(state.ExitCode) ||
    typeof state.Error !== "string" ||
    typeof state.StartedAt !== "string"
  ) {
    return undefined;
  }
  return {
    status: state.Status,
    exitCode: state.ExitCode as number,
    error: state.Error,
    startedAt: state.StartedAt,
  };
}

function emptyOutput(): ProcessResult["stdout"] {
  return { text: "", totalBytes: 0, truncated: false, digest: EMPTY_OUTPUT_DIGEST };
}

function infrastructureFailure(source: BoundedProcessResult | undefined): ProcessResult {
  return {
    outcome: "INFRA_ERROR",
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: source?.durationMs ?? 0,
    stdout: source?.stdout ?? emptyOutput(),
    stderr: source?.stderr ?? emptyOutput(),
    ...(source?.error === undefined ? {} : { error: source.error }),
  };
}

function formatCpus(millicores: number): string {
  return String(millicores / 1_000);
}

/** Executes one adapter process in a fresh container and always removes that container. */
export async function runContainerExecution(
  backend: ContainerBackend,
  execution: ContainerExecution,
  runner: ContainerProcessRunner,
  workingDirectory: string,
): Promise<ContainerExecutionResult> {
  return withRuntimeTrace([execution.workspace], () =>
    runSingleContainerExecution(backend, execution, runner, workingDirectory),
  );
}

async function runSingleContainerExecution(
  backend: ContainerBackend,
  execution: ContainerExecution,
  runner: ContainerProcessRunner,
  workingDirectory: string,
): Promise<ContainerExecutionResult> {
  const context: RuntimeContext = {
    command: backend.runtimeCommand,
    runner,
    workingDirectory,
    ...(backend.controlRunner === undefined ? {} : { controlRunner: backend.controlRunner }),
  };
  const limits = backend.isolation.limits;
  const name = `assertledger-${randomUUID()}`;
  context.traceContext = { ...backend.traceContext, container: name };
  context.uploadReuse = { reused: false };
  const environment = new Map<string, string>(
    backend.isolation.environment.map(({ name: key, value }) => [key, value]),
  );
  for (const [key, value] of Object.entries(execution.environment)) environment.set(key, value);
  const createArguments = [
    "create",
    "--pull=never",
    `--name=${name}`,
    `--label=assertledger.execution=${name}`,
    "--network=none",
    "--read-only",
    `--mount=type=volume,target=${CONTAINER_ROOT}`,
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.temporaryDirectoryBytes}`,
    `--user=${SANDBOX_USER}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${limits.pids}`,
    `--memory=${limits.memoryBytes}`,
    `--memory-swap=${limits.memoryBytes}`,
    `--cpus=${formatCpus(limits.cpuMillicores)}`,
    "--log-driver=none",
    `--workdir=${CONTAINER_WORKSPACE}`,
    ...[...environment.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `--env=${key}=${value}`),
    `--entrypoint=${execution.executable}`,
    backend.isolation.image,
    ...execution.args,
  ];

  let created: BoundedProcessResult | undefined;
  let outcome: ContainerExecutionResult | undefined;
  let failure: unknown;
  try {
    created = await runtime(context, createArguments, LIFECYCLE_TIMEOUT_MS, CONTROL_OUTPUT_BYTES);
    if (created.outcome !== "PASS") {
      outcome = { process: infrastructureFailure(created), result: undefined };
    } else {
      const uploaded = await runtime(
        context,
        ["cp", "--archive", "-", `${name}:${CONTAINER_ROOT}`],
        UPLOAD_TIMEOUT_MS,
        CONTROL_OUTPUT_BYTES,
        executionUploadArchive(backend, execution, context.uploadReuse),
      );
      if (uploaded.outcome !== "PASS") {
        outcome = { process: infrastructureFailure(uploaded), result: undefined };
      } else {
        outcome = await startAndCollect(context, name, execution);
      }
    }
  } catch (error) {
    failure = error;
  }

  const removed = await runtime(
    context,
    ["rm", "--force", "--volumes", name],
    LIFECYCLE_TIMEOUT_MS,
    CONTROL_OUTPUT_BYTES,
  );
  if (removed.outcome !== "PASS" && created?.outcome === "PASS") {
    throw backendError("CONTAINER_CLEANUP_FAILED", `${name}: ${runtimeDetail(removed)}`);
  }
  if (failure !== undefined) throw failure;
  return outcome as ContainerExecutionResult;
}

async function startAndCollect(
  context: RuntimeContext,
  name: string,
  execution: ContainerExecution,
): Promise<ContainerExecutionResult> {
  const run = await runtime(
    context,
    ["start", "--attach", name],
    execution.timeoutMs,
    execution.maximumOutputBytes,
  );
  if (run.outcome === "TIMEOUT") {
    // Killing the attached client does not stop the container; the runtime kills its cgroup.
    await runtime(context, ["kill", name], CONTROL_TIMEOUT_MS, CONTROL_OUTPUT_BYTES);
    const { stdoutBytes: _stdoutBytes, ...timedOut } = run;
    return { process: { ...timedOut, exitCode: null, signal: null }, result: undefined };
  }
  const state = await inspectState(context, name);
  if (
    run.outcome === "INFRA_ERROR" ||
    state === undefined ||
    state.status !== "exited" ||
    state.error !== "" ||
    state.startedAt.startsWith("0001-") ||
    state.exitCode !== run.exitCode
  ) {
    if (state?.status === "running") {
      await runtime(context, ["kill", name], CONTROL_TIMEOUT_MS, CONTROL_OUTPUT_BYTES);
    }
    return { process: infrastructureFailure(run), result: undefined };
  }
  const { stdoutBytes: _stdoutBytes, ...completed } = run;
  const process: ProcessResult = {
    ...completed,
    outcome: state.exitCode === 0 ? "PASS" : "PROCESS_CRASH",
    exitCode: state.exitCode,
  };
  const maximumBytes = execution.resultMaximumBytes ?? 0;
  if (maximumBytes === 0) return { process, result: undefined };
  const copied = await runtime(
    context,
    ["cp", `${name}:${CONTAINER_RESULT_FILE}`, "-"],
    CONTROL_TIMEOUT_MS,
    maximumBytes + RESULT_ARCHIVE_OVERHEAD_BYTES,
  );
  return {
    process,
    result:
      copied.outcome === "PASS" && !copied.stdout.truncated
        ? readContainerResultArchive(copied.stdoutBytes, maximumBytes)
        : undefined,
  };
}
