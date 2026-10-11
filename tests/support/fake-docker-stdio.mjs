import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Duplex } from "node:stream";

const state = process.argv[2];
const scenario = JSON.parse(readFileSync(path.join(state, "scenario.json"), "utf8"));
appendFileSync(path.join(state, "launches.jsonl"), `${JSON.stringify(process.argv.slice(3))}\n`);
const digest = "e".repeat(64);
if (scenario.stderrFlood) {
  await new Promise((resolve, reject) => {
    process.stderr.write(Buffer.alloc(1_048_577, 97), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
const socket = Duplex.from({ readable: process.stdin, writable: process.stdout });
socket.setTimeout = () => socket;
socket.setNoDelay = () => socket;
socket.setKeepAlive = () => socket;
const server = createServer(async (request, response) => {
  if (scenario.earlyUploadResponse && request.method === "PUT") {
    request.resume();
    response.writeHead(200);
    response.end("");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  appendFileSync(
    path.join(state, "requests.jsonl"),
    `${JSON.stringify({
      method: request.method,
      url: request.url,
      body: body.toString("base64"),
    })}\n`,
  );
  const url = request.url.replace(/^\/v1\.\d+/, "");
  if (scenario.largeHeaders) response.setHeader("x-test", "a".repeat(20000));
  let value;
  let status = 200;
  if (url === "/version")
    value = {
      ApiVersion: scenario.api ?? "1.55",
      Version: scenario.version ?? "29.7.2",
      Os: "linux",
      Arch: "amd64",
    };
  else if (url === "/info")
    value = {
      OSType: "linux",
      CgroupVersion: "2",
      SecurityOptions: scenario.security ?? ["seccomp", "cgroupns"],
    };
  else if (url.startsWith("/images/"))
    value = {
      Id: scenario.image ?? `sha256:${digest}`,
      Os: "linux",
      Architecture: "amd64",
      RepoDigests: [`oven/bun@sha256:${digest}`],
    };
  else if (url.startsWith("/containers/create")) {
    if (scenario.loseCreate) {
      socket.destroy();
      return;
    }
    status = 201;
    value = { Id: "a".repeat(64), Warnings: [] };
  } else if (url.endsWith("/json"))
    value = {
      State: { Status: "exited", ExitCode: 0, Error: "", StartedAt: "2026-10-11T00:00:00Z" },
      ...(scenario.inspectMetadata
        ? { Config: { Cmd: ["x".repeat(scenario.inspectMetadata)] } }
        : {}),
    };
  else if (request.method === "PUT") {
    if (scenario.hangUpload) return;
    value = "";
  } else if (request.method === "DELETE" || url.endsWith("/kill")) {
    status = request.method === "DELETE" && scenario.removeMissing ? 404 : 204;
    value = "";
  } else if (url.includes("/archive")) {
    if (scenario.truncated) {
      response.writeHead(200, { "Content-Length": 100 });
      response.write("short");
      socket.destroy();
      return;
    }
    if (scenario.httpError) {
      status = 500;
      value = { message: "daemon refused" };
    } else value = Buffer.alloc(scenario.large ? 5000 : 8, 97);
  } else {
    status = 404;
    value = {};
  }
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(
    Buffer.isBuffer(value) ? value : typeof value === "string" ? value : JSON.stringify(value),
  );
});
server.emit("connection", socket);
process.stdin.on("end", () => process.exit(0));
