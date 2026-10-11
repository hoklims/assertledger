#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

const HELP = `Usage: node scripts/benchmark-container-runtime.mjs
  --producer BUILT_PACKAGE --witness WITNESS_JSON --image NAME@sha256:DIGEST
  --runtime JSON_ARGV --output NEW_EXTERNAL_DIRECTORY
  [--repetitions 3] [--transport auto|cli|stdio] [--compare RESULTS_JSON]

Copies the built package and dependencies before timing. Runs imports serially,
requires VERIFIED and valid replay, and compares every semantic manifest field.
Omit --transport for a producer that predates this option. Output must be fresh
and outside both the witness repository and the producer.
`;

const RUNTIME_PHASES = new Set([
  "version",
  "info",
  "image-inspect",
  "create",
  "upload",
  "start",
  "inspect",
  "download",
  "remove",
  "kill",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function argumentsFrom(argv) {
  const allowed = new Set([
    "--producer",
    "--witness",
    "--image",
    "--runtime",
    "--output",
    "--repetitions",
    "--transport",
    "--compare",
  ]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!allowed.has(flag) || options[flag] !== undefined || !argv[i + 1]) {
      throw new Error(`Invalid or repeated argument: ${flag}`);
    }
    options[flag] = argv[i + 1];
  }
  for (const flag of ["--producer", "--witness", "--image", "--runtime", "--output"]) {
    if (!options[flag]) throw new Error(`Required argument: ${flag}`);
  }
  const repetitions = Number(options["--repetitions"] ?? 3);
  assert.ok(
    Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 20,
    "repetitions must be 1..20",
  );
  assert.match(options["--image"], /.+@sha256:[a-f0-9]{64}$/u, "image must be digest-pinned");
  const runtime = JSON.parse(options["--runtime"]);
  assert.ok(
    Array.isArray(runtime) &&
      runtime.length >= 1 &&
      runtime.length <= 16 &&
      runtime.every((part) => typeof part === "string" && part.trim()),
    "runtime must be a nonempty argv array",
  );
  const transport = options["--transport"];
  assert.ok(
    transport === undefined || ["auto", "cli", "stdio"].includes(transport),
    "invalid transport",
  );
  return { options, repetitions, runtime, transport };
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    !relative ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

// Compare JSON structurally, preserving every field except execution-varying digests and timing.
function semantic(manifest) {
  const copy = structuredClone(manifest);
  delete copy.artifactDigest;
  delete copy.decisionDigest;
  copy.observations = copy.observations.map(
    ({ durationMs, stdoutDigest, stderrDigest, ...observation }) => observation,
  );
  return copy;
}

async function treeIdentity(root) {
  const hash = createHash("sha256");
  let files = 0;
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        hash.update(
          JSON.stringify([
            path.relative(root, absolute).split(path.sep).join("/"),
            bytes.length,
            (await stat(absolute)).mode,
          ]),
        );
        hash.update(bytes);
        files++;
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(absolute);
        assert.ok(within(target, root), "snapshot link escapes its dependency tree");
        hash.update(
          JSON.stringify([
            path.relative(root, absolute).split(path.sep).join("/"),
            "link",
            path.relative(root, target).split(path.sep).join("/"),
          ]),
        );
      } else throw new Error(`Snapshot contains a non-regular entry: ${absolute}`);
    }
  }
  await visit(root);
  return { digest: hash.digest("hex"), files };
}

// Preserve pnpm's package locations and relocate every link into the frozen copy.
// Dereferencing a top-level package changes where Node finds its transitive dependencies.
async function copyDependencies(source, destination) {
  const root = await realpath(source);
  const links = [];
  async function visit(directory, output) {
    await mkdir(output);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const input = path.join(directory, entry.name);
      const copied = path.join(output, entry.name);
      if (entry.isDirectory()) await visit(input, copied);
      else if (entry.isFile()) await copyFile(input, copied);
      else if (entry.isSymbolicLink()) {
        const target = await realpath(input);
        assert.ok(within(target, root), "dependency link escapes its source tree");
        assert.ok(
          (await stat(target)).isDirectory(),
          "only directory dependency links are supported",
        );
        links.push([path.join(destination, path.relative(root, target)), copied]);
      } else throw new Error(`Dependency contains a non-regular entry: ${input}`);
    }
  }
  await visit(root, destination);
  for (const [target, copied] of links) {
    await symlink(target, copied, process.platform === "win32" ? "junction" : "dir");
  }
}

async function dependencyDirectory(producer) {
  let directory = producer;
  while (true) {
    const candidate = path.join(directory, "node_modules");
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Producer dependencies cannot be resolved");
    directory = parent;
  }
}

async function command(argv, stdoutPath, stderrPath, env) {
  const stdout = createWriteStream(stdoutPath, { flags: "wx" });
  const stderr = createWriteStream(stderrPath, { flags: "wx" });
  const streams = Promise.all([finished(stdout), finished(stderr)]);
  // Observe stream errors immediately, including an executable that cannot start.
  void streams.catch(() => {});
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env,
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await streams;
    return result;
  } catch (error) {
    child.kill();
    stdout.destroy();
    stderr.destroy();
    throw error;
  }
}

function cpuTimes() {
  const times = os.cpus().map((cpu) => cpu.times);
  return {
    idle: times.reduce((sum, time) => sum + time.idle, 0),
    total: times.reduce((sum, time) => sum + Object.values(time).reduce((a, b) => a + b, 0), 0),
  };
}

function summarize(events) {
  const phases = {};
  const containers = new Map();
  let runtimeInvocations = 0;
  let logicalRuntimeCalls = 0;
  let reusedUploads = 0;
  const margins = [];
  for (const event of events) {
    phases[event.phase] ??= { calls: 0, durationMs: 0, inputBytes: 0 };
    const phase = phases[event.phase];
    phase.calls++;
    phase.durationMs += event.durationMs;
    phase.inputBytes += event.inputBytes ?? 0;
    const runtimeCall = RUNTIME_PHASES.has(event.phase);
    logicalRuntimeCalls += Number(runtimeCall);
    runtimeInvocations += event.runtimeInvocations ?? Number(runtimeCall);
    reusedUploads += Number(event.phase === "upload" && event.archiveReused === true);
    if (event.phase === "create") containers.set(event.container, event.kind ?? "unknown");
    if (Number.isFinite(event.timeoutMs)) margins.push(event.timeoutMs - event.durationMs);
  }
  const classes = {};
  for (const kind of containers.values()) classes[kind] = (classes[kind] ?? 0) + 1;
  return {
    phases,
    classes,
    containers: containers.size,
    logicalRuntimeCalls,
    runtimeInvocations,
    reusedUploads,
    minimumRuntimeMarginMs: margins.length ? Math.min(...margins) : null,
  };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const { options, repetitions, runtime, transport } = argumentsFrom(process.argv.slice(2));
  const producer = await realpath(options["--producer"]);
  const witness = await realpath(options["--witness"]);
  const witnessBytes = await readFile(witness);
  const recordedWitness = JSON.parse(witnessBytes.toString("utf8"));
  const repository = await realpath(recordedWitness.repository.root);
  const output = path.join(
    await realpath(path.dirname(path.resolve(options["--output"]))),
    path.basename(options["--output"]),
  );
  const dependencies = await realpath(await dependencyDirectory(producer));
  assert.ok(
    !within(output, repository) && !within(output, producer) && !within(output, dependencies),
    "output must be outside repository, producer and dependencies",
  );
  await mkdir(output); // Exclusive: preserve previous measurements and evidence.
  const snapshot = path.join(output, "producer");
  await mkdir(snapshot);
  for (const name of ["dist", "integrations", "package.json"]) {
    await cp(path.join(producer, name), path.join(snapshot, name), {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
  }
  await copyDependencies(dependencies, path.join(snapshot, "node_modules"));
  const cli = path.join(snapshot, "dist", "cli.js");
  assert.ok((await stat(cli)).isFile(), "producer must contain a built dist/cli.js");
  const identity = {
    producer: await treeIdentity(snapshot),
    dependencies: await treeIdentity(path.join(snapshot, "node_modules")),
    witnessDigest: digest(witnessBytes),
    image: options["--image"],
    runtime,
    transport: transport ?? "producer-default",
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    repetitions,
  };
  const previous = options["--compare"]
    ? JSON.parse(await readFile(options["--compare"], "utf8"))
    : undefined;
  if (previous) {
    for (const field of [
      "witnessDigest",
      "image",
      "runtime",
      "nodeVersion",
      "platform",
      "architecture",
      "dependencies",
    ]) {
      assert.deepEqual(identity[field], previous.identity[field], `comparison changed ${field}`);
    }
  }
  await writeFile(path.join(output, "identity.json"), JSON.stringify(identity, null, 2), {
    flag: "wx",
  });
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.ASSERTLEDGER_RUNTIME_TRACE;
  const startup = await command(
    [process.execPath, cli, "--help"],
    path.join(output, "startup.stdout.txt"),
    path.join(output, "startup.stderr.txt"),
    cleanEnvironment,
  );
  assert.equal(startup.code, 0, "isolated producer cannot start; inspect startup.stderr.txt");
  const runs = [];
  let expected = previous?.runs[0]?.semantic;
  for (let number = 1; number <= repetitions; number++) {
    const directory = path.join(output, `run-${number}`);
    await mkdir(directory);
    const evidence = path.join(directory, "evidence");
    const trace = path.join(directory, "runtime.jsonl");
    const loads = [];
    let prior = cpuTimes();
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const timer = setInterval(() => {
      const now = cpuTimes();
      const total = now.total - prior.total;
      loads.push({
        elapsedMs: performance.now() - start,
        cpuPercent: total ? 100 * (1 - (now.idle - prior.idle) / total) : null,
        freeMemoryBytes: os.freemem(),
        loadAverage: os.loadavg(),
      });
      prior = now;
      process.stdout.write(
        `${JSON.stringify({ run: number, elapsedSeconds: Math.round((performance.now() - start) / 1000) })}\n`,
      );
    }, 30000);
    let execution;
    let wallMs;
    try {
      execution = await command(
        [
          process.execPath,
          cli,
          "import-witness",
          witness,
          "--out",
          evidence,
          "--container-image",
          options["--image"],
          "--container-runtime",
          JSON.stringify(runtime),
          ...(transport ? ["--container-transport", transport] : []),
          "--json",
        ],
        path.join(directory, "stdout.json"),
        path.join(directory, "stderr.txt"),
        { ...cleanEnvironment, ASSERTLEDGER_RUNTIME_TRACE: trace },
      );
      wallMs = performance.now() - start;
    } finally {
      clearInterval(timer);
      await writeFile(path.join(directory, "load.json"), JSON.stringify(loads, null, 2), {
        flag: "wx",
      });
    }
    assert.equal(
      execution.code,
      0,
      `import refused; inspect ${path.join(directory, "stderr.txt")}`,
    );
    const manifest = JSON.parse(await readFile(path.join(evidence, "manifest.json"), "utf8"));
    assert.equal(manifest.decision.status, "VERIFIED");
    const replay = await command(
      [process.execPath, cli, "replay", path.join(evidence, "manifest.json"), "--json"],
      path.join(directory, "replay.json"),
      path.join(directory, "replay.stderr.txt"),
      cleanEnvironment,
    );
    const replayResult = JSON.parse(await readFile(path.join(directory, "replay.json"), "utf8"));
    assert.equal(replay.code, 0, "replay refused");
    assert.equal(replayResult.valid, true, "replay invalid");
    const projected = semantic(manifest);
    expected ??= projected;
    assert.deepEqual(projected, expected, "semantic manifest changed");
    const stderr = await readFile(path.join(directory, "stderr.txt"), "utf8");
    assert.doesNotMatch(
      stderr,
      /ASSERTLEDGER_RUNTIME_TRACE_(?:DROPPED|WRITE_FAILED|UNSAFE_DESTINATION)/u,
      "trace incomplete",
    );
    const events = (await readFile(trace, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(events.length > 0, "no runtime trace; baseline needs trace-only instrumentation");
    const run = {
      number,
      startedAt,
      wallMs,
      ...execution,
      verdict: manifest.decision.status,
      replay: true,
      semantic: projected,
      ...summarize(events),
    };
    runs.push(run);
    await writeFile(path.join(directory, "summary.json"), JSON.stringify(run, null, 2), {
      flag: "wx",
    });
    process.stdout.write(
      `${JSON.stringify({ run: number, wallMs, containers: run.containers, runtimeInvocations: run.runtimeInvocations })}\n`,
    );
  }
  assert.deepEqual(
    await treeIdentity(snapshot),
    identity.producer,
    "compiled producer snapshot changed",
  );
  assert.equal(digest(await readFile(witness)), identity.witnessDigest, "witness changed");
  const times = runs.map((run) => run.wallMs).sort((a, b) => a - b);
  const midpoint = Math.floor(times.length / 2);
  const medianMs = times.length % 2 ? times[midpoint] : (times[midpoint - 1] + times[midpoint]) / 2;
  const results = {
    identity,
    statistics: { minimumMs: times[0], medianMs, maximumMs: times.at(-1) },
    runs,
  };
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2), {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify(results.statistics)}\n`);
}

await main();
