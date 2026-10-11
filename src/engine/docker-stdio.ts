import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import type {
  BoundedProcessResult,
  ContainerBackend,
  ContainerProcessRunner,
} from "./container.js";
import type { CapturedOutput, ProcessInput } from "./index.js";

const HANDSHAKE_BYTES = 1_048_576;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

function unavailable(): Error {
  return new Error("CONTAINER_STDIO_UNAVAILABLE");
}

function field(args: readonly string[], key: string): string {
  const values = args.filter((arg) => arg.startsWith(`${key}=`));
  if (values.length !== 1) throw unavailable();
  return (values[0] as string).slice(key.length + 1);
}

function integer(value: string): number {
  if (!/^\d+$/.test(value)) throw unavailable();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw unavailable();
  return result;
}

/** Accept only the engine's hardened invocation; unknown options never silently disappear. */
export function buildDockerCreateRequest(args: readonly string[]): Record<string, unknown> {
  if (args[0] !== "create") throw unavailable();
  const imageIndex = args.findIndex((arg, index) => index > 0 && !arg.startsWith("--"));
  if (imageIndex < 0) throw unavailable();
  const flags = args.slice(1, imageIndex);
  const permitted = new Set([
    "--pull",
    "--name",
    "--label",
    "--network",
    "--read-only",
    "--mount",
    "--tmpfs",
    "--user",
    "--cap-drop",
    "--security-opt",
    "--pids-limit",
    "--memory",
    "--memory-swap",
    "--cpus",
    "--log-driver",
    "--workdir",
    "--env",
    "--entrypoint",
  ]);
  if (flags.some((arg) => !permitted.has(arg.split("=")[0] as string))) throw unavailable();
  const invariant: Record<string, string> = {
    "--pull": "never",
    "--network": "none",
    "--mount": "type=volume,target=/assertledger",
    "--user": "65534:65534",
    "--cap-drop": "ALL",
    "--security-opt": "no-new-privileges",
    "--log-driver": "none",
    "--workdir": "/assertledger/repository",
  };
  for (const [key, value] of Object.entries(invariant)) {
    if (field(flags, key) !== value) throw unavailable();
  }
  if (flags.filter((arg) => arg.split("=")[0] === "--read-only").join() !== "--read-only")
    throw unavailable();
  const name = field(flags, "--name");
  if (!/^assertledger-[\w-]+$/.test(name)) throw unavailable();
  if (field(flags, "--label") !== `assertledger.execution=${name}`) throw unavailable();
  const tmpfs = field(flags, "--tmpfs");
  const tmpfsMatch = /^\/tmp:(rw,nosuid,nodev,size=(\d+))$/.exec(tmpfs);
  if (!tmpfsMatch) throw unavailable();
  integer(tmpfsMatch[2] as string);
  const cpus = field(flags, "--cpus");
  const cpuMatch = /^(\d+)(?:\.(\d{1,3}))?$/.exec(cpus);
  if (!cpuMatch) throw unavailable();
  const nanoCpus = Number(cpuMatch[1]) * 1_000_000_000 + Number((cpuMatch[2] ?? "").padEnd(9, "0"));
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) throw unavailable();
  const image = args[imageIndex] as string;
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw unavailable();
  const env = flags.filter((arg) => arg.startsWith("--env=")).map((arg) => arg.slice(6));
  if (env.some((value) => !/^[^=\0]+=[^\0]*$/.test(value))) throw unavailable();
  const executable = field(flags, "--entrypoint");
  if (executable.length === 0 || executable.includes("\0")) throw unavailable();
  return {
    Image: image,
    Entrypoint: [executable],
    Cmd: args.slice(imageIndex + 1),
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    User: "65534:65534",
    WorkingDir: "/assertledger/repository",
    Labels: { "assertledger.execution": name },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Mounts: [{ Type: "volume", Target: "/assertledger" }],
      Tmpfs: { "/tmp": tmpfsMatch[1] },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: integer(field(flags, "--pids-limit")),
      Memory: integer(field(flags, "--memory")),
      MemorySwap: integer(field(flags, "--memory-swap")),
      NanoCpus: nanoCpus,
      LogConfig: { Type: "none" },
    },
  };
}

function captured(bytes: Buffer, totalBytes = bytes.length, truncated = false): CapturedOutput {
  return {
    text: bytes.toString("utf8"),
    totalBytes,
    truncated,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function result(bytes: Buffer, started: number, error?: string): BoundedProcessResult {
  return {
    outcome: error === undefined ? "PASS" : "INFRA_ERROR",
    exitCode: error === undefined ? 0 : null,
    signal: null,
    timedOut: false,
    durationMs: Math.round(performance.now() - started),
    stdoutBytes: bytes,
    stdout: captured(bytes),
    stderr: captured(Buffer.alloc(0)),
    ...(error === undefined ? {} : { error }),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DockerStdioControl {
  run: ContainerProcessRunner;
  /** False after any uncertain HTTP exchange; never retry a mutable operation. */
  readonly alive: boolean;
  close(): Promise<void>;
}

/** One generic operator-argv subprocess, one HTTP connection, no shell or host Docker socket. */
export async function openDockerStdioControl(
  command: readonly string[],
  cwd: string,
  expected: ContainerBackend["record"],
): Promise<DockerStdioControl> {
  const executable = command[0];
  if (!executable || command.some((arg) => arg.length === 0 || arg.includes("\0")))
    throw unavailable();
  const prefix = command.slice(1);
  const child = spawn(executable, [...prefix, "system", "dial-stdio"], {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let alive = true;
  let allocated = false;
  let closed = false;
  let stderrBytes = 0;
  const configurationBytes = new Map<string, number>();
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin }) as Duplex & {
    setKeepAlive(): typeof socket;
    setTimeout(): typeof socket;
    ref(): typeof socket;
    unref(): typeof socket;
  };
  socket.setKeepAlive = () => socket;
  socket.setTimeout = () => socket;
  socket.ref = () => socket;
  socket.unref = () => socket;
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 0 });
  agent.createConnection = (_options, callback) => {
    if (allocated || !alive) {
      callback?.(unavailable(), undefined as unknown as Socket);
      return undefined as unknown as Socket;
    }
    allocated = true;
    return socket as unknown as Socket;
  };
  const poison = () => {
    alive = false;
    agent.destroy();
    socket.destroy();
    child.kill();
  };
  // Errors are handled even when they arrive between requests or during shutdown.
  socket.on("error", poison);
  child.on("error", poison);
  child.stdin.on("error", poison);
  child.stdout.on("error", poison);
  child.stderr.on("error", poison);
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > HANDSHAKE_BYTES) poison();
  });
  const closure = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      alive = false;
      resolve();
    });
  });
  async function close(): Promise<void> {
    poison();
    if (closed) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closure,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async function exchange(
    method: string,
    url: string,
    timeoutMs: number,
    maximumBytes: number,
    body?: AsyncIterable<Uint8Array> | Buffer,
  ): Promise<{ status: number; bytes: Buffer }> {
    if (
      !alive ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    )
      throw unavailable();
    return new Promise((resolve, reject) => {
      let settled = false;
      let length = 0;
      const chunks: Buffer[] = [];
      let inputDelivered = body === undefined || Buffer.isBuffer(body);
      let requestFlushed = false;
      let completedResponse: { status: number; bytes: Buffer } | undefined;
      const succeed = () => {
        if (settled || !inputDelivered || !requestFlushed || completedResponse === undefined)
          return;
        settled = true;
        clearTimeout(timer);
        resolve(completedResponse);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        poison();
        reject(unavailable());
      };
      const req = request({
        method,
        path: url,
        host: "docker",
        agent,
        maxHeaderSize: 16_384,
        headers:
          body === undefined
            ? {}
            : {
                "Content-Type": Buffer.isBuffer(body) ? "application/json" : "application/x-tar",
                ...(Buffer.isBuffer(body) ? { "Content-Length": body.length } : {}),
              },
      });
      const timer = setTimeout(fail, timeoutMs);
      req.on("error", fail);
      req.once("finish", () => {
        requestFlushed = true;
        succeed();
      });
      req.on("response", (response) => {
        response.on("error", fail);
        response.on("aborted", fail);
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maximumBytes) {
            fail();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          if (
            !response.complete ||
            (response.statusCode ?? 0) < 200 ||
            (response.statusCode ?? 0) >= 300
          ) {
            fail();
            return;
          }
          completedResponse = {
            status: response.statusCode ?? 0,
            bytes: Buffer.concat(chunks, length),
          };
          succeed();
        });
      });
      if (body === undefined || Buffer.isBuffer(body)) req.end(body);
      else {
        void (async () => {
          for await (const chunk of body) {
            if (settled) break;
            if (!req.write(chunk))
              await new Promise<void>((done, bad) => {
                const cleanup = () => {
                  req.off("drain", drained);
                  req.off("error", failed);
                  req.off("close", failed);
                };
                const drained = () => {
                  cleanup();
                  done();
                };
                const failed = () => {
                  cleanup();
                  bad(unavailable());
                };
                req.once("drain", drained);
                req.once("error", failed);
                req.once("close", failed);
              });
          }
          if (!settled) {
            req.end();
            inputDelivered = true;
            succeed();
          }
        })().catch(fail);
      }
    });
  }

  let api = "";
  async function json(url: string): Promise<Record<string, unknown>> {
    const response = await exchange("GET", url, HANDSHAKE_TIMEOUT_MS, HANDSHAKE_BYTES);
    if (response.status !== 200) throw unavailable();
    const parsed: unknown = JSON.parse(response.bytes.toString("utf8"));
    if (!object(parsed)) throw unavailable();
    return parsed;
  }
  try {
    const version = await json("/version");
    const match =
      typeof version.ApiVersion === "string" ? /^1\.(\d+)$/.exec(version.ApiVersion) : null;
    if (
      !match ||
      Number(match[1]) < 41 ||
      version.Version !== expected.runtime.serverVersion ||
      version.Os !== expected.runtime.serverOs ||
      version.Arch !== expected.runtime.serverArchitecture
    ) {
      throw unavailable();
    }
    api = `/v1.${Math.min(55, Number(match[1]))}`;
    const info = await json(`${api}/info`);
    const image = await json(`${api}/images/${encodeURIComponent(expected.image.reference)}/json`);
    if (
      info.OSType !== "linux" ||
      info.CgroupVersion !== expected.runtime.cgroupVersion ||
      !Array.isArray(info.SecurityOptions) ||
      JSON.stringify([...info.SecurityOptions].sort()) !==
        JSON.stringify([...expected.runtime.securityOptions].sort()) ||
      image.Id !== expected.image.id ||
      image.Os !== expected.image.os ||
      image.Architecture !== expected.image.architecture
    ) {
      throw unavailable();
    }
    const pin = /@sha256:([a-f0-9]{64})$/.exec(expected.image.reference)?.[1];
    if (
      !pin ||
      (image.Id !== `sha256:${pin}` &&
        (!Array.isArray(image.RepoDigests) ||
          !image.RepoDigests.some(
            (digest) => typeof digest === "string" && digest.endsWith(`@sha256:${pin}`),
          )))
    ) {
      throw unavailable();
    }
  } catch {
    await close();
    throw unavailable();
  }

  const run: ContainerProcessRunner = async (input: ProcessInput, standardInput) => {
    const started = performance.now();
    try {
      if (
        input.executable !== executable ||
        prefix.some((arg, index) => input.args[index] !== arg)
      ) {
        throw unavailable();
      }
      const args = input.args.slice(prefix.length);
      if (
        standardInput !== undefined &&
        !(args[0] === "cp" && args[1] === "--archive" && args[2] === "-" && args.length === 4)
      ) {
        throw unavailable();
      }
      let response: { status: number; bytes: Buffer };
      let output: Buffer;
      const call = (method: string, url: string, body?: AsyncIterable<Uint8Array> | Buffer) =>
        exchange(method, `${api}${url}`, input.timeoutMs, input.maximumOutputBytes, body);
      if (args[0] === "create") {
        const payload = buildDockerCreateRequest(args);
        if (payload.Image !== expected.image.reference || standardInput !== undefined)
          throw unavailable();
        const body = Buffer.from(JSON.stringify(payload));
        configurationBytes.set(field(args, "--name"), body.length);
        response = await call(
          "POST",
          `/containers/create?name=${encodeURIComponent(field(args, "--name"))}`,
          body,
        );
        if (response.status !== 201) throw unavailable();
        const parsed: unknown = JSON.parse(response.bytes.toString("utf8"));
        if (!object(parsed) || typeof parsed.Id !== "string" || !/^[a-f0-9]{64}$/.test(parsed.Id)) {
          throw unavailable();
        }
        output = Buffer.from(`${parsed.Id}\n`);
      } else if (
        args[0] === "cp" &&
        args[1] === "--archive" &&
        args[2] === "-" &&
        args.length === 4
      ) {
        const match = /^(assertledger-[\w-]+):\/assertledger$/.exec(args[3] as string);
        if (!match || standardInput === undefined) throw unavailable();
        response = await call(
          "PUT",
          `/containers/${encodeURIComponent(match[1] as string)}/archive?path=%2Fassertledger&copyUIDGID=true&noOverwriteDirNonDir=true`,
          standardInput,
        );
        if (response.status !== 200) throw unavailable();
        output = Buffer.alloc(0);
      } else if (
        args[0] === "inspect" &&
        args[1] === "--type=container" &&
        args[2] === "--format={{json .State}}" &&
        args.length === 4
      ) {
        // The API includes Config as well as State; only State spends the public output budget.
        // JSON escaping can expand a known argument byte sixfold. Image metadata was already
        // bounded during qualification. Keep the complete envelope finite without rejecting
        // valid long argv that the CLI's State-only formatting accepts.
        response = await exchange(
          "GET",
          `${api}/containers/${container(args[3])}/json`,
          input.timeoutMs,
          input.maximumOutputBytes +
            HANDSHAKE_BYTES +
            6 * (configurationBytes.get(args[3] as string) ?? 0),
        );
        if (response.status !== 200) throw unavailable();
        const parsed: unknown = JSON.parse(response.bytes.toString("utf8"));
        if (!object(parsed) || !object(parsed.State)) throw unavailable();
        output = Buffer.from(JSON.stringify(parsed.State));
      } else if (args[0] === "cp" && args[2] === "-" && args.length === 3) {
        const match = /^(assertledger-[\w-]+):\/assertledger\/out\/result.json$/.exec(
          args[1] as string,
        );
        if (!match) throw unavailable();
        response = await call(
          "GET",
          `/containers/${container(match[1])}/archive?path=%2Fassertledger%2Fout%2Fresult.json`,
        );
        if (response.status !== 200) throw unavailable();
        output = response.bytes;
      } else if (args[0] === "kill" && args.length === 2) {
        response = await call("POST", `/containers/${container(args[1])}/kill`);
        if (response.status !== 204) throw unavailable();
        output = Buffer.alloc(0);
      } else if (
        args[0] === "rm" &&
        args[1] === "--force" &&
        args[2] === "--volumes" &&
        args.length === 4
      ) {
        response = await call("DELETE", `/containers/${container(args[3])}?force=true&v=true`);
        if (response.status !== 204) throw unavailable();
        configurationBytes.delete(args[3] as string);
        output = Buffer.alloc(0);
      } else throw unavailable();
      if (output.length > input.maximumOutputBytes) throw unavailable();
      return result(output, started);
    } catch {
      // A server error or lost response may follow a successful mutation. Do not reconnect/retry.
      poison();
      return result(Buffer.alloc(0), started, "CONTAINER_STDIO_UNAVAILABLE");
    }
  };
  return {
    run,
    get alive() {
      return alive;
    },
    close,
  };
}

function container(name: string | undefined): string {
  if (!name || !/^assertledger-[\w-]+$/.test(name)) throw unavailable();
  return encodeURIComponent(name);
}
