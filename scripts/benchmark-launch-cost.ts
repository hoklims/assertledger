import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const orders = [
  ["rust", "true", "node"],
  ["true", "node", "rust"],
  ["node", "rust", "true"],
  ["rust", "node", "true"],
  ["node", "true", "rust"],
  ["true", "rust", "node"],
];
const probeSource = fileURLToPath(new URL("../benchmarks/launch-cost/probe.rs", import.meta.url));
const driverSource = fileURLToPath(import.meta.url);

type Row = { phase: string; name: string; block?: number; i?: number; elapsedNs: number };

export function summarizeSeries(rows: unknown[], includeTrue: boolean) {
  const names = includeTrue ? ["rust", "true", "node"] : ["rust", "node"];
  const expected = new Set<string>();
  for (const name of names) {
    expected.add(`first-observed:${name}::`);
    for (let i = 0; i < 20; i++) expected.add(`warmup:${name}::${i}`);
    for (let block = 0; block < 6; block++) {
      for (let i = 0; i < 100; i++) expected.add(`measured:${name}:${block}:${i}`);
    }
  }
  const seen = new Set<string>();
  const valid = rows.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid observation");
    const row = value as Record<string, unknown>;
    if (
      row.code !== 0 ||
      row.signal !== null ||
      row.outputBytes !== 0 ||
      typeof row.phase !== "string" ||
      typeof row.name !== "string" ||
      (row.block !== undefined && !Number.isInteger(row.block)) ||
      (row.i !== undefined && !Number.isInteger(row.i)) ||
      typeof row.elapsedNs !== "number" ||
      !Number.isSafeInteger(row.elapsedNs) ||
      row.elapsedNs <= 0
    ) {
      throw new Error("invalid observation");
    }
    const key = `${row.phase}:${row.name}:${row.block ?? ""}:${row.i ?? ""}`;
    if (seen.has(key)) throw new Error(`duplicate observation: ${key}`);
    if (!expected.has(key)) throw new Error(`unexpected observation: ${key}`);
    seen.add(key);
    return row as Row;
  });
  if (seen.size !== expected.size) throw new Error("incomplete series");
  return Object.fromEntries(
    names.map((name) => {
      const values = valid
        .filter((r) => r.phase === "measured" && r.name === name)
        .map((r) => r.elapsedNs / 1e6)
        .sort((a, b) => a - b);
      const percentile = (p: number) => {
        const index = (values.length - 1) * p;
        const low = values[Math.floor(index)] as number;
        return low + ((values[Math.ceil(index)] as number) - low) * (index % 1);
      };
      const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
      return [
        name,
        {
          n: values.length,
          min: values[0],
          p25: percentile(0.25),
          median: percentile(0.5),
          p75: percentile(0.75),
          p95: percentile(0.95),
          p99: percentile(0.99),
          max: values.at(-1),
          mean,
          sd: Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (values.length - 1)),
        },
      ];
    }),
  );
}

export async function observeLaunch(executable: string, argv: string[], timeoutMs = 2000) {
  return await new Promise<{
    pid: number | undefined;
    elapsedNs: number;
    code: number;
    signal: null;
    outputBytes: number;
  }>((resolve, reject) => {
    const start = process.hrtime.bigint();
    const child = spawn(executable, argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let outputBytes = 0;
    let failure: string | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
    });
    child.stderr.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
    });
    child.stdin.on("error", (error) => {
      failure = `stdin: ${error.message}`;
    });
    child.on("error", (error) => {
      failure = `spawn: ${error.message}`;
    });
    child.once("close", (code, signal) => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      clearTimeout(timeout);
      const reason =
        failure ??
        (timedOut
          ? "timeout"
          : signal
            ? "signal"
            : code !== 0
              ? "exit"
              : outputBytes !== 0
                ? "output"
                : undefined);
      if (reason) {
        reject(new Error(JSON.stringify({ reason, code, signal, outputBytes, pid: child.pid })));
        return;
      }
      resolve({ pid: child.pid, elapsedNs, code: 0, signal: null, outputBytes });
    });
    child.stdin.end();
  });
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function ambient() {
  const cpuTimes = os.cpus().reduce<Record<string, number>>((sum, cpu) => {
    for (const [key, value] of Object.entries(cpu.times)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  }, {});
  return {
    at: new Date().toISOString(),
    loadavg: os.loadavg(),
    freeMemory: os.freemem(),
    cpuTimes,
  };
}

export function verifyHost(target: string) {
  const hosts: Record<string, [string, string]> = {
    "x86_64-unknown-linux-gnu": ["linux", "x64"],
    "aarch64-unknown-linux-gnu": ["linux", "arm64"],
    "x86_64-pc-windows-msvc": ["win32", "x64"],
    "aarch64-apple-darwin": ["darwin", "arm64"],
  };
  const host = hosts[target];
  if (
    !host ||
    host[0] !== os.platform() ||
    host[1] !== os.arch() ||
    !(host[1] === "arm64" ? ["arm64", "aarch64"] : ["x86_64", "AMD64"]).includes(os.machine())
  ) {
    throw new Error(
      `native host mismatch: ${target}, ${os.platform()}, ${os.arch()}, ${os.machine()}`,
    );
  }
  const compiler = execFileSync("rustc", ["-vV"], { encoding: "utf8", timeout: 10000 });
  if (!compiler.startsWith("rustc 1.99.1 ") || !compiler.includes(`host: ${target}\n`)) {
    throw new Error("compiler version or native host mismatch");
  }
  return compiler;
}

async function controls(probe: string) {
  const args = [
    "",
    "two words",
    "é/日本語",
    "$(touch SHOULD_NOT_EXIST)",
    "a;b",
    '"quoted"',
    "line\nbreak",
    "--flag=value",
  ];
  const echo = spawnSync(probe, ["--echo-argv", ...args], { timeout: 2000, shell: false });
  assert.ifError(echo.error);
  assert.equal(echo.status, 0);
  assert.equal(echo.signal, null);
  assert.equal(echo.stderr.length, 0);
  assert.deepEqual(echo.stdout, Buffer.from(`${args.join("\0")}\0`));
  await observeLaunch(probe, ["core", "noop"]);
  await observeLaunch(process.execPath, ["--eval", "", "core", "noop"]);
  if (os.platform() !== "win32") await observeLaunch("/usr/bin/true", ["core", "noop"]);
  console.log("PASS: argument boundary and quiet positive controls");
}

async function measure(probe: string, target: string, output: string, revision: string) {
  const compiler = verifyHost(target);
  const definitions: Record<string, [string, string[]]> = {
    rust: [probe, ["core", "noop"]],
    node: [process.execPath, ["--eval", "", "core", "noop"]],
  };
  const includeTrue = os.platform() !== "win32";
  if (includeTrue) definitions.true = ["/usr/bin/true", ["core", "noop"]];
  await mkdir(output);
  const identities = Object.fromEntries(
    await Promise.all(
      Object.entries(definitions).map(async ([name, [exe, argv]]) => [
        name,
        {
          executable: path.basename(exe),
          argv,
          sha256: await sha256(exe),
          size: (await stat(exe)).size,
        },
      ]),
    ),
  );
  const metadata = {
    target,
    revision,
    compiler,
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    machine: os.machine(),
    release: os.release(),
    osVersion: os.version(),
    cpus: os.cpus().length,
    model: os.cpus()[0]?.model,
    totalMemory: os.totalmem(),
    executableIdentities: identities,
    sources: { driver: await sha256(driverSource), probe: await sha256(probeSource) },
    timeoutMs: 2000,
    budgetMs: 120000,
    warmupPerTarget: 20,
    samplesPerTarget: 600,
    orders: orders.map((order) => order.filter((name) => definitions[name])),
    start: ambient(),
    telemetry: [] as ReturnType<typeof ambient>[],
    end: null as ReturnType<typeof ambient> | null,
  };
  const save = async (name: string, value: unknown) =>
    writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  await save("metadata.json", metadata);
  const raw = await open(path.join(output, "samples.jsonl"), "wx");
  const rows: unknown[] = [];
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  const record = async (
    phase: string,
    name: string,
    index: { i?: number; block?: number } = {},
  ) => {
    const remaining = Number(deadline - process.hrtime.bigint()) / 1e6;
    if (remaining <= 0) throw new Error("series budget exhausted");
    const definition = definitions[name];
    assert.ok(definition);
    const row = {
      phase,
      name,
      ...index,
      ...(await observeLaunch(...definition, Math.min(2000, remaining))),
    };
    rows.push(row);
    await raw.write(`${JSON.stringify(row)}\n`);
  };
  try {
    for (const name of metadata.orders[0] ?? []) await record("first-observed", name);
    for (let i = 0; i < 20; i++) {
      for (const name of metadata.orders[i % 6] ?? []) await record("warmup", name, { i });
    }
    for (const [block, order] of metadata.orders.entries()) {
      metadata.telemetry.push(ambient());
      for (let i = 0; i < 100; i++) {
        for (const name of order) await record("measured", name, { block, i });
      }
      metadata.telemetry.push(ambient());
    }
    metadata.end = ambient();
    await save("metadata.json", metadata);
    await save("summary.json", summarizeSeries(rows, includeTrue));
    console.log(
      JSON.stringify({ completed: true, target, start: metadata.start.at, end: metadata.end.at }),
    );
  } catch (error) {
    await save("failure.json", {
      completed: false,
      error: String(error),
      observations: rows.length,
    });
    throw error;
  } finally {
    await raw.close();
  }
}

async function main(args: string[]) {
  const [command, ...values] = args;
  if (command === "build" && values.length === 2) {
    const [target, output] = values as [string, string];
    verifyHost(target);
    execFileSync(
      "rustc",
      [
        "--edition=2024",
        "--target",
        target,
        "-C",
        "opt-level=3",
        "-C",
        "debuginfo=0",
        probeSource,
        "-o",
        path.resolve(output),
      ],
      { timeout: 60000, stdio: "inherit" },
    );
  } else if (command === "controls" && values.length === 1) {
    await controls(path.resolve(values[0] as string));
  } else if (command === "measure" && values.length === 4) {
    await measure(
      path.resolve(values[0] as string),
      values[1] as string,
      path.resolve(values[2] as string),
      values[3] as string,
    );
  } else if (command === "summarize" && values.length === 1) {
    const directory = path.resolve(values[0] as string);
    const rows = (await readFile(path.join(directory, "samples.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8"));
    console.log(JSON.stringify(summarizeSeries(rows, metadata.platform !== "win32"), null, 2));
  } else {
    throw new Error(
      "Use build TARGET PROBE | controls PROBE | measure PROBE TARGET NEW_DIRECTORY REVISION | summarize DIRECTORY",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === driverSource) {
  await main(process.argv.slice(2));
}
