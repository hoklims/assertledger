import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { type CliIo, runCli } from "../src/cli.js";
import { BunPreflightRefusalSchema, DiagnosticReportSchema } from "../src/contracts/diagnostics.js";
import { parseWitnessImportRequest } from "../src/contracts/index.js";
import { witnessVerificationRequest } from "../src/engine/witness-import.js";

const directories: string[] = [];
const BASE = "export const value = 1;\n";
const CODE = "BUN_TEST_PROFILE_PREFLIGHT_FAILED";
const EXPECTED = {
  outcome: "ASSERTION_FAILURE",
  attributed: true,
  testsDiscovered: 1,
  candidateTestsDiscovered: 1,
};
const OBSERVED = {
  outcome: "PASS",
  attributed: false,
  testsDiscovered: 1,
  candidateTestsDiscovered: 1,
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "assertledger-preflight-")));
  directories.push(parent);
  const root = path.join(parent, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "subject.ts"), BASE);
  await writeFile(
    path.join(root, "probe.test.ts"),
    'import { test, expect } from "bun:test"; test("value", () => expect(1).toBe(1));\n',
  );
  const witness = {
    schemaVersion: "1.0.0",
    provenance: "controlled preflight refusal",
    repository: { root, exclude: [], includeDependencies: false, git: "excluded" },
    adapter: { kind: "bun-test-designated", executable: process.execPath, testTimeoutMs: null },
    test: { file: "probe.test.ts", path: ["value"] },
    expectedFailure: "error: expect(received).toBe(expected)",
    targets: [
      {
        path: "subject.ts",
        beforeDigest: `sha256:${createHash("sha256").update(BASE).digest("hex")}`,
        content: "export const value = 2;\n",
      },
    ],
    neutral: null,
    requiredAttempts: 2,
    timeoutMsPerExecution: 10_000,
  };
  return { root, parent, out: path.join(parent, "evidence"), witness };
}

/** Fake only the executable boundary; CLI, identities, preflight and output handling stay real. */
function fakeProbeExecutor(
  context: TestContext,
  out: string,
  mode: "mismatch" | "unavailable" | "spawn-error" | "execution-error" = "mismatch",
  onProbe?: () => void,
) {
  const calls: { probe: boolean; outExists: boolean }[] = [];
  const mocked = context.mock.method(childProcess, "spawn", ((_command: string, args: string[]) => {
    const identity = args[0] === "-e" && args[1]?.includes("Bun.version");
    const driver = args[0]?.endsWith("driver.mjs") === true;
    assert.ok(identity || driver, `unexpected subprocess: ${JSON.stringify(args)}`);
    calls.push({ probe: driver, outExists: existsSync(out) });
    if (driver) onProbe?.();
    if (driver && mode === "execution-error") throw new Error("controlled executor failure");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new ChildProcess(), {
      stdout,
      stderr,
      stdin: null,
      pid: undefined,
    });
    const document = identity
      ? {
          execPath: process.execPath,
          bunVersion: "1.4.2",
          bunRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
        }
      : {
          protocolVersion: "1.0.0",
          ...OBSERVED,
          testsDiscovered: args.includes("base.test.ts") ? 2 : 1,
        };
    queueMicrotask(() => {
      if (driver && mode === "spawn-error") {
        child.emit("error", new Error("controlled spawn failure"));
        stdout.end();
        stderr.end();
        child.emit("close", null, null);
        return;
      }
      stdout.end(driver && mode === "unavailable" ? "invalid report" : JSON.stringify(document));
      stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  context.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

async function cli(root: string, input: unknown, argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd: root,
    readStdin: async () => JSON.stringify(input),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

for (const backend of [
  "trusted-local",
  ...(process.platform === "win32" ? ["windows-native"] : []),
]) {
  const flag =
    backend === "trusted-local" ? "--allow-unsafe-execution" : "--allow-windows-native-execution";
  for (const json of [false, true]) {
    it(`names a mismatching designated Bun probe on ${backend}, json=${json}`, async (context) => {
      const f = await fixture();
      const calls = fakeProbeExecutor(context, f.out);
      const result = await cli(f.root, f.witness, [
        "import-witness",
        "-",
        "--out",
        f.out,
        flag,
        ...(json ? ["--json"] : []),
      ]);
      assert.equal(result.code, 4);
      assert.equal(
        calls.filter((call) => call.probe).length,
        1,
        "refusal stops before campaign executions",
      );
      assert.match(result.stderr, /expect-assertion/, "stderr names the failed probe");
      assert.match(result.stderr, /expected.*ASSERTION_FAILURE.*true.*1/is);
      assert.match(result.stderr, /observed.*PASS.*false.*1/is);
      if (json) {
        assert.ok(result.stdout.trim(), "--json must emit a preflight refusal");
        const diagnostic = BunPreflightRefusalSchema.parse(JSON.parse(result.stdout));
        assert.equal(diagnostic.code, CODE);
        assert.equal(diagnostic.status, "REFUSED");
        assert.equal(diagnostic.probe, "expect-assertion");
        assert.deepEqual(diagnostic.expected, EXPECTED);
        assert.deepEqual(diagnostic.observed, OBSERVED);
      } else assert.equal(result.stdout, "");
      assert.ok(!existsSync(f.out), "refusal leaves no output");
    });
  }
}

it("never creates --out while executing a Bun preflight probe", async (context) => {
  const f = await fixture();
  const calls = fakeProbeExecutor(context, f.out);
  const result = await cli(f.root, f.witness, [
    "import-witness",
    "-",
    "--out",
    f.out,
    "--allow-unsafe-execution",
  ]);
  assert.equal(result.code, 4);
  assert.ok(calls.some((call) => call.probe));
  assert.ok(
    calls.every((call) => !call.outExists),
    "--out must remain absent throughout preflight, including identity probes",
  );
});

it("names the ordinary Bun runtime probe with its expected discovery counts", async (context) => {
  const f = await fixture();
  fakeProbeExecutor(context, f.out);
  const request = await witnessVerificationRequest(parseWitnessImportRequest(f.witness), {
    kind: "trusted-local",
    environmentAllowlist: [],
  });
  const ordinary = {
    ...request,
    adapter: { kind: "bun-test", executable: process.execPath, baseTestFiles: ["probe.test.ts"] },
    candidateRoots: ["candidate.test.ts"],
    budgets: {
      ...request.budgets,
      maximumCandidateBytes: 10_000,
      maximumTotalCandidateBytes: 10_000,
    },
    candidates: [
      {
        id: "witness",
        files: [
          {
            path: "candidate.test.ts",
            content: 'import { test } from "bun:test"; test("candidate", () => {});\n',
          },
        ],
      },
    ],
  };
  const result = await cli(f.root, ordinary, ["verify", "-", "--allow-unsafe-execution", "--json"]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /assertion/);
  assert.ok(result.stdout.trim(), "--json must emit a preflight refusal");
  const diagnostic = BunPreflightRefusalSchema.parse(JSON.parse(result.stdout));
  assert.equal(diagnostic.probe, "assertion");
  assert.deepEqual(diagnostic.expected, { ...EXPECTED, testsDiscovered: 2 });
  assert.deepEqual(diagnostic.observed, { ...OBSERVED, testsDiscovered: 2 });
});

it("reports unknown observed fields when the Bun probe has no valid report", async (context) => {
  const f = await fixture();
  fakeProbeExecutor(context, f.out, "unavailable");
  const result = await cli(f.root, f.witness, [
    "import-witness",
    "-",
    "--out",
    f.out,
    "--allow-unsafe-execution",
    "--json",
  ]);
  assert.equal(result.code, 4);
  assert.ok(result.stdout.trim(), "--json must emit a preflight refusal");
  const diagnostic = BunPreflightRefusalSchema.parse(JSON.parse(result.stdout));
  assert.equal(diagnostic.probe, "expect-assertion");
  assert.equal(diagnostic.failure, "REPORT_UNAVAILABLE");
  assert.deepEqual(diagnostic.expected, EXPECTED);
  assert.deepEqual(diagnostic.observed, {
    outcome: null,
    attributed: null,
    testsDiscovered: null,
    candidateTestsDiscovered: null,
  });
});

for (const report of ["mismatch", "unavailable"]) {
  it(`reports the designated Bun refusal through the container backend: ${report}`, async () => {
    const f = await fixture();
    const state = path.join(f.parent, "runtime");
    await mkdir(state);
    await writeFile(
      path.join(state, "scenario.json"),
      JSON.stringify({ bunPreflight: { out: f.out, report } }),
    );
    const runtime = fileURLToPath(new URL("./support/fake-container-runtime.mjs", import.meta.url));
    const result = await cli(
      f.root,
      { ...f.witness, adapter: { ...f.witness.adapter, executable: "bun" } },
      [
        "import-witness",
        "-",
        "--out",
        f.out,
        "--container-image",
        `oven/bun:1.4.2@sha256:${"e".repeat(64)}`,
        "--container-runtime",
        JSON.stringify([process.execPath, runtime, state]),
        "--json",
      ],
    );
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /expect-assertion/, "stderr names the failed container probe");
    assert.ok(result.stdout.trim(), "--json must emit a preflight refusal");
    const diagnostic = BunPreflightRefusalSchema.parse(JSON.parse(result.stdout));
    assert.equal(diagnostic.code, CODE);
    assert.equal(diagnostic.probe, "expect-assertion");
    assert.deepEqual(diagnostic.expected, EXPECTED);
    assert.deepEqual(
      diagnostic.observed,
      report === "mismatch"
        ? OBSERVED
        : {
            outcome: null,
            attributed: null,
            testsDiscovered: null,
            candidateTestsDiscovered: null,
          },
    );
    const probes = (await readFile(path.join(state, "preflight.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(probes.length, 1);
    assert.match(probes[0].source, /expect\(1\)\.toBe\(2\)/);
    assert.equal(probes[0].outputExists, false, "container preflight never writes --out");
    const calls = (await readFile(path.join(state, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter((args) => args[0] === "create").length,
      3,
      "two identities and one probe, no campaign",
    );
    for (const call of calls.filter((args) => args[0] === "create")) {
      const name = call.find((arg) => arg.startsWith("--name="))?.slice("--name=".length);
      assert.ok(name);
      const upload = JSON.parse(
        await readFile(path.join(state, "containers", name, "upload-transport.json"), "utf8"),
      );
      assert.equal(
        upload.gzip,
        true,
        "compressed transport must still detect the false preflight probe",
      );
      assert.ok(upload.bytes > 0);
    }
    assert.ok(!existsSync(f.out));
  });
}

for (const mode of ["spawn-error", "execution-error"] as const) {
  it(`preserves the probe and unknown observations after ${mode}`, async (context) => {
    const f = await fixture();
    fakeProbeExecutor(context, f.out, mode);
    const result = await cli(f.root, f.witness, [
      "import-witness",
      "-",
      "--out",
      f.out,
      "--allow-unsafe-execution",
      "--json",
    ]);
    assert.equal(result.code, 4);
    const diagnostic = BunPreflightRefusalSchema.parse(JSON.parse(result.stdout));
    assert.equal(diagnostic.probe, "expect-assertion");
    assert.deepEqual(diagnostic.expected, EXPECTED);
    assert.deepEqual(diagnostic.observed, {
      outcome: null,
      attributed: null,
      testsDiscovered: null,
      candidateTestsDiscovered: null,
    });
    assert.equal(
      diagnostic.failure,
      mode === "spawn-error" ? "REPORT_UNAVAILABLE" : "EXECUTION_ERROR",
    );
    assert.equal(
      diagnostic.process?.outcome ?? null,
      mode === "spawn-error" ? "INFRA_ERROR" : null,
    );
    assert.match(diagnostic.detail ?? "", /controlled .* failure/);
    assert.ok(!existsSync(f.out));
  });
}

it("does not remove another owner's output created during a refused preflight", async (context) => {
  const f = await fixture();
  fakeProbeExecutor(context, f.out, "mismatch", () => {
    mkdirSync(f.out);
    writeFileSync(path.join(f.out, "owner.txt"), "other owner");
  });
  const result = await cli(f.root, f.witness, [
    "import-witness",
    "-",
    "--out",
    f.out,
    "--allow-unsafe-execution",
    "--json",
  ]);
  assert.equal(result.code, 4);
  assert.equal(await readFile(path.join(f.out, "owner.txt"), "utf8"), "other owner");
});

it("keeps explain's catalogue schema compatible and gives actionable Bun probe guidance", async () => {
  const result = await cli(process.cwd(), {}, ["explain", CODE, "--json"]);
  assert.equal(result.code, 0);
  const diagnostic = DiagnosticReportSchema.parse(JSON.parse(result.stdout)).diagnostics[0];
  assert.equal(diagnostic?.known, true);
  assert.match(diagnostic?.nextAction ?? "", /probe.*expected\/observed/i);
  assert.match(diagnostic?.nextAction ?? "", /--json/);
  assert.match(diagnostic?.nextAction ?? "", /never skip/i);
});
