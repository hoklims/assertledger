// Test-only dual CLI / daemon stand-in. State and adapter behavior remain in the legacy fixture.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

// A fixture must not fabricate adapter stderr from the parent test runner's color settings.
delete process.env.FORCE_COLOR;

const [state, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(path.join(state, "scenario.json"), "utf8"));
const legacy = fileURLToPath(new URL("./fake-container-runtime.mjs", import.meta.url));
appendFileSync(path.join(state, "runtime-launches.jsonl"), `${JSON.stringify(args)}\n`);
const MAXIMUM_BYTES = 1_048_576;
const CHILD_TIMEOUT_MS = 20_000;

function insist(condition) {
  if (!condition) throw new Error("invalid fixture API request");
}

function name(value) {
  insist(typeof value === "string" && /^assertledger-[\w-]+$/.test(value));
  return value;
}

function positive(value) {
  insist(Number.isSafeInteger(value) && value > 0);
  return value;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(actual, expected) {
  insist(JSON.stringify(actual) === JSON.stringify(expected));
}

function createArgs(payload, container) {
  insist(object(payload) && object(payload.HostConfig));
  const host = payload.HostConfig;
  insist(host.NetworkMode === "none" && host.ReadonlyRootfs === true);
  same(host.Mounts, [{ Type: "volume", Target: "/assertledger" }]);
  same(host.CapDrop, ["ALL"]);
  same(host.SecurityOpt, ["no-new-privileges"]);
  same(host.LogConfig, { Type: "none" });
  insist(host.AutoRemove === undefined || host.AutoRemove === false);
  insist(host.Binds === undefined && host.Privileged !== true);
  insist(payload.User === "65534:65534" && payload.WorkingDir === "/assertledger/repository");
  same(payload.Labels, { "assertledger.execution": container });
  insist(object(host.Tmpfs) && Object.keys(host.Tmpfs).length === 1);
  const tmpfs = host.Tmpfs["/tmp"];
  const temporary = /^rw,nosuid,nodev,size=(\d+)$/.exec(tmpfs);
  insist(temporary !== null);
  positive(Number(temporary[1]));
  positive(host.PidsLimit);
  positive(host.Memory);
  positive(host.MemorySwap);
  insist(host.MemorySwap === host.Memory);
  positive(host.NanoCpus);
  insist(host.NanoCpus % 1_000_000 === 0);
  insist(
    Array.isArray(payload.Env) &&
      payload.Env.every((entry) => typeof entry === "string" && /^[^=\0]+=[^\0]*$/.test(entry)),
  );
  insist(
    Array.isArray(payload.Entrypoint) &&
      payload.Entrypoint.length === 1 &&
      typeof payload.Entrypoint[0] === "string" &&
      payload.Entrypoint[0].length > 0,
  );
  insist(Array.isArray(payload.Cmd) && payload.Cmd.every((entry) => typeof entry === "string"));
  insist(typeof payload.Image === "string" && /@sha256:[a-f0-9]{64}$/.test(payload.Image));
  return [
    "create",
    "--pull=never",
    `--name=${container}`,
    `--label=assertledger.execution=${container}`,
    "--network=none",
    "--read-only",
    "--mount=type=volume,target=/assertledger",
    `--tmpfs=/tmp:${tmpfs}`,
    "--user=65534:65534",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${host.PidsLimit}`,
    `--memory=${host.Memory}`,
    `--memory-swap=${host.MemorySwap}`,
    `--cpus=${host.NanoCpus / 1_000_000_000}`,
    "--log-driver=none",
    "--workdir=/assertledger/repository",
    ...payload.Env.map((entry) => `--env=${entry}`),
    `--entrypoint=${payload.Entrypoint[0]}`,
    payload.Image,
    ...payload.Cmd,
  ];
}

async function boundedLegacy(argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [legacy, state, ...argv], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error("fixture legacy process failed"));
    };
    const timer = setTimeout(fail, CHILD_TIMEOUT_MS);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAXIMUM_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAXIMUM_BYTES) fail();
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error("fixture legacy process refused"));
      else resolve(Buffer.concat(chunks, bytes));
    });
    child.stdin.end(input);
  });
}

if (args.length !== 2 || args[0] !== "system" || args[1] !== "dial-stdio") {
  const child = spawn(process.execPath, [legacy, state, ...args], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", () => process.exit(1));
  child.once("close", (code) => process.exit(code ?? 1));
} else {
  const socket = Duplex.from({ readable: process.stdin, writable: process.stdout });
  socket.setTimeout = () => socket;
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  socket.on("error", () => process.exit(1));
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        insist(bytes <= MAXIMUM_BYTES);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, bytes);
      const url = new URL(request.url, "http://fixture");
      const route = url.pathname.replace(/^\/v1\.\d+/, "");
      let output;
      let status = 200;
      if (request.method === "GET" && route === "/version") {
        insist(scenario.version !== "unavailable");
        output = {
          ApiVersion: "1.55",
          Version: "99.1.0-fake",
          Os: scenario.serverOs ?? "linux",
          Arch: "amd64",
        };
      } else if (request.method === "GET" && route === "/info") {
        output = {
          OSType: scenario.serverOs ?? "linux",
          Architecture: "x86_64",
          CgroupVersion: "2",
          SecurityOptions: ["name=seccomp,profile=builtin", "name=no-new-privileges"],
        };
      } else if (
        request.method === "GET" &&
        route.startsWith("/images/") &&
        route.endsWith("/json")
      ) {
        insist(scenario.image !== "missing");
        const reference = decodeURIComponent(route.slice(8, -5));
        insist(/@sha256:[a-f0-9]{64}$/.test(reference));
        output = {
          Id:
            scenario.image === "mismatch"
              ? `sha256:${"f".repeat(64)}`
              : reference.slice(reference.indexOf("@") + 1),
          Os: scenario.imageOs ?? "linux",
          Architecture: "amd64",
          RepoDigests: scenario.image === "mismatch" ? [] : [reference],
        };
      } else if (request.method === "POST" && route === "/containers/create") {
        const container = name(url.searchParams.get("name"));
        await boundedLegacy(createArgs(JSON.parse(body.toString("utf8")), container));
        output = { Id: "a".repeat(64), Warnings: [] };
        status = 201;
      } else {
        const match = /^\/containers\/([^/]+)(\/archive|\/json|\/kill)?$/.exec(route);
        insist(match !== null);
        const container = name(decodeURIComponent(match[1]));
        if (request.method === "PUT" && match[2] === "/archive") {
          insist(
            url.searchParams.get("path") === "/assertledger" &&
              url.searchParams.get("copyUIDGID") === "true" &&
              url.searchParams.get("noOverwriteDirNonDir") === "true",
          );
          await boundedLegacy(["cp", "--archive", "-", `${container}:/assertledger`], body);
          output = "";
        } else if (request.method === "GET" && match[2] === "/json") {
          const stateBytes = await boundedLegacy([
            "inspect",
            "--type=container",
            "--format={{json .State}}",
            container,
          ]);
          output = { State: JSON.parse(stateBytes.toString("utf8")) };
        } else if (request.method === "GET" && match[2] === "/archive") {
          insist(url.searchParams.get("path") === "/assertledger/out/result.json");
          output = await boundedLegacy(["cp", `${container}:/assertledger/out/result.json`, "-"]);
        } else if (request.method === "POST" && match[2] === "/kill") {
          await boundedLegacy(["kill", container]);
          output = "";
          status = 204;
        } else if (request.method === "DELETE" && match[2] === undefined) {
          insist(url.searchParams.get("force") === "true" && url.searchParams.get("v") === "true");
          await boundedLegacy(["rm", "--force", "--volumes", container]);
          output = "";
          status = 204;
        } else throw new Error("unknown fixture endpoint");
      }
      response.writeHead(status, {
        "Content-Type": Buffer.isBuffer(output) ? "application/x-tar" : "application/json",
      });
      response.end(
        Buffer.isBuffer(output) || typeof output === "string" ? output : JSON.stringify(output),
      );
    } catch {
      if (!response.destroyed) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "fixture API request failed" }));
      }
    }
  });
  server.emit("connection", socket);
  process.stdin.on("end", () => process.exit(0));
}
