#!/usr/bin/env node
// Deterministic stand-in for a Docker-compatible CLI. The first argument is a state directory that
// holds the scenario and receives an audit log of every invocation. It emulates only the verbs used
// by the AssertLedger container backend, and a structured-command adapter that fails on "BUG".
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const [stateDirectory, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(path.join(stateDirectory, "scenario.json"), "utf8"));
appendFileSync(path.join(stateDirectory, "calls.jsonl"), `${JSON.stringify(args)}\n`);

const containerDirectory = (name) => path.join(stateDirectory, "containers", name);
const flagValue = (list, flag) =>
  list.find((item) => item.startsWith(`${flag}=`))?.slice(flag.length + 1);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function octal(buffer, offset, length) {
  const text = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/[\0 ]+$/u, "")
    .trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let paxPath;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const record of data.toString("utf8").split("\n")) {
        const match = /^\d+ path=(.*)$/su.exec(record);
        if (match) paxPath = match[1];
      }
      continue;
    }
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
    const shortName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    entries.push({
      name: paxPath ?? (prefix ? `${prefix}/${shortName}` : shortName),
      type,
      mode: octal(header, 100, 8),
      uid: octal(header, 108, 8),
      gid: octal(header, 116, 8),
      data: Buffer.from(data),
    });
    paxPath = undefined;
  }
  return entries;
}

function tarEntry(name, type, data = Buffer.alloc(0), linkName = "") {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, padding, Buffer.alloc(1_024, 0)]);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  switch (args[0]) {
    case "version":
      if (scenario.version === "unavailable") fail("Cannot connect to the Docker daemon");
      print({
        Client: { Version: "99.0.0-fake" },
        Server: { Version: "99.1.0-fake", Os: scenario.serverOs ?? "linux", Arch: "amd64" },
      });
      return;
    case "info":
      print({
        OSType: scenario.serverOs ?? "linux",
        Architecture: "x86_64",
        CgroupVersion: "2",
        SecurityOptions: ["name=seccomp,profile=builtin", "name=no-new-privileges"],
      });
      return;
    case "image": {
      if (args[1] !== "inspect") fail("unsupported image command");
      if (scenario.image === "missing") fail("Error: No such image");
      const reference = args.at(-1);
      const digest = reference.slice(reference.indexOf("@") + 1);
      print({
        Id: scenario.image === "mismatch" ? `sha256:${"f".repeat(64)}` : digest,
        Os: scenario.imageOs ?? "linux",
        Architecture: "amd64",
        RepoDigests: scenario.image === "mismatch" ? [] : [reference],
      });
      return;
    }
    case "create": {
      const name = flagValue(args, "--name");
      mkdirSync(containerDirectory(name), { recursive: true });
      writeFileSync(path.join(containerDirectory(name), "create.json"), JSON.stringify(args));
      print(`${name}-id`);
      return;
    }
    case "cp": {
      if (args[1] === "--archive" && args[2] === "-") {
        const name = args[3].slice(0, args[3].indexOf(":"));
        const entries = parseTar(await readStdin());
        writeFileSync(
          path.join(containerDirectory(name), "upload.json"),
          JSON.stringify(
            entries.map(({ data, ...entry }) => ({ ...entry, text: data.toString("utf8") })),
          ),
        );
        return;
      }
      const name = args[1].slice(0, args[1].indexOf(":"));
      const resultPath = path.join(containerDirectory(name), "result.json");
      if (!existsSync(resultPath)) fail("Error response from daemon: Could not find the file");
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      process.stdout.write(
        result.symlink
          ? tarEntry("result.json", "2", Buffer.alloc(0), "/etc/passwd")
          : tarEntry(result.name ?? "result.json", "0", Buffer.from(result.content, "utf8")),
      );
      return;
    }
    case "start": {
      const name = args.at(-1);
      const directory = containerDirectory(name);
      const create = JSON.parse(readFileSync(path.join(directory, "create.json"), "utf8"));
      const upload = JSON.parse(readFileSync(path.join(directory, "upload.json"), "utf8"));
      const environment = Object.fromEntries(
        create
          .filter((item) => item.startsWith("--env="))
          .map((item) => {
            const pair = item.slice("--env=".length);
            return [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
          }),
      );
      const candidates = JSON.parse(environment.TESTFORGE_CANDIDATE_FILES ?? "[]");
      const bug = upload.some(
        (entry) => entry.name === "repository/src/value.js" && entry.text.includes("BUG"),
      );
      if (candidates.length > 0 && bug && scenario.hangTarget) {
        const deadline = Date.now() + 60_000;
        while (!existsSync(path.join(directory, "killed")) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        writeFileSync(path.join(directory, "exit.json"), JSON.stringify({ exitCode: 137 }));
        process.exit(137);
      }
      const outcome = candidates.length > 0 && bug ? "ASSERTION_FAILURE" : "PASS";
      const report = {
        protocolVersion: "1.0.0",
        outcome,
        testsDiscovered: candidates.length > 0 ? 2 : 1,
        candidateTestsDiscovered: candidates.length > 0 ? 1 : 0,
        attributed: candidates.length > 0,
      };
      const exitCode = outcome === "PASS" ? 0 : 1;
      const symlink = candidates.length > 0 && bug && scenario.symlinkTargetResult;
      writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify(
          symlink
            ? { symlink: true }
            : {
                name: scenario.renamedResult ? "../result.json" : "result.json",
                content: JSON.stringify(report),
              },
        ),
      );
      writeFileSync(path.join(directory, "exit.json"), JSON.stringify({ exitCode }));
      process.stdout.write(`fake adapter ${outcome}\n`);
      process.exit(exitCode);
      return;
    }
    case "kill":
      writeFileSync(path.join(containerDirectory(args.at(-1)), "killed"), "");
      return;
    case "inspect": {
      const exitPath = path.join(containerDirectory(args.at(-1)), "exit.json");
      const exitCode = existsSync(exitPath)
        ? JSON.parse(readFileSync(exitPath, "utf8")).exitCode
        : 0;
      print({
        Status: "exited",
        ExitCode: exitCode,
        Error: "",
        StartedAt: "2026-09-17T00:00:00Z",
        OOMKilled: false,
      });
      return;
    }
    case "rm":
      if (scenario.rm === "fail") fail("Error response from daemon: removal failed");
      rmSync(path.join(containerDirectory(args.at(-1)), "result.json"), { force: true });
      writeFileSync(path.join(containerDirectory(args.at(-1)), "removed"), "");
      return;
    default:
      fail(`unsupported fake runtime command: ${args[0]}`);
  }
}

await main();
