import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runPublicCli } from "./support/public-surface.js";

async function refusedWitness(transport: string, capable = false) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "assertledger-transport-"));
  const root = path.join(parent, "repo"),
    state = path.join(parent, "runtime"),
    out = path.join(parent, "evidence");
  await mkdir(root);
  await mkdir(state);
  const base = "export const value = 1;\n";
  await writeFile(path.join(root, "value.ts"), base);
  await writeFile(
    path.join(root, "probe.test.ts"),
    'import { test, expect } from "bun:test"; test("value", () => expect(1).toBe(1));\n',
  );
  await writeFile(
    path.join(state, "scenario.json"),
    JSON.stringify({ bunPreflight: { out, report: "mismatch" } }),
  );
  const witness = {
    schemaVersion: "1.0.0",
    provenance: "transport must preserve qualification",
    repository: { root, exclude: [], includeDependencies: false, git: "excluded" },
    adapter: { kind: "bun-test-designated", executable: "bun", testTimeoutMs: null },
    test: { file: "probe.test.ts", path: ["value"] },
    expectedFailure: "error: expect(received).toBe(expected)",
    targets: [
      {
        path: "value.ts",
        beforeDigest: `sha256:${createHash("sha256").update(base).digest("hex")}`,
        content: "export const value = 2;\n",
      },
    ],
    neutral: null,
    requiredAttempts: 2,
    timeoutMsPerExecution: 10000,
  };
  let stdout = "",
    stderr = "";
  const runtime = fileURLToPath(
    new URL(
      capable ? "./support/fake-container-stdio.mjs" : "./support/fake-container-runtime.mjs",
      import.meta.url,
    ),
  );
  const code = await runPublicCli(
    [
      "import-witness",
      "-",
      "--out",
      out,
      "--container-image",
      `image@sha256:${"e".repeat(64)}`,
      "--container-runtime",
      JSON.stringify([process.execPath, ...(capable ? ["--no-warnings"] : []), runtime, state]),
      "--container-transport",
      transport,
      "--json",
    ],
    {
      cwd: root,
      readStdin: async () => JSON.stringify(witness),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    },
  );
  return { parent, state, out, code, stdout, stderr };
}

for (const transport of ["cli", "auto"]) {
  it(`retains the false-probe refusal in ${transport} transport without writing evidence`, async () => {
    const result = await refusedWitness(transport);
    try {
      assert.equal(result.code, 4, result.stderr);
      assert.ok(result.stdout.length > 0, `refusal must remain structured: ${result.stderr}`);
      const refusal = JSON.parse(result.stdout);
      assert.equal(refusal.code, "BUN_TEST_PROFILE_PREFLIGHT_FAILED");
      assert.equal(refusal.probe, "expect-assertion");
      assert.equal(refusal.failure, "REPORT_MISMATCH");
      assert.deepEqual(refusal.expected, {
        outcome: "ASSERTION_FAILURE",
        attributed: true,
        testsDiscovered: 1,
        candidateTestsDiscovered: 1,
      });
      assert.deepEqual(refusal.observed, {
        outcome: "PASS",
        attributed: false,
        testsDiscovered: 1,
        candidateTestsDiscovered: 1,
      });
      assert.equal(existsSync(result.out), false);
      const calls = (await readFile(path.join(result.state, "calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.filter((call) => call[0] === "create").length, 3);
      if (transport === "auto") assert.ok(calls.some((call) => call[0] === "system"));
    } finally {
      await rm(result.parent, { recursive: true, force: true });
    }
  });
}

for (const transport of ["auto", "stdio"]) {
  it(`uses one qualified control connection in ${transport} without bypassing a false probe`, async () => {
    const result = await refusedWitness(transport, true);
    try {
      assert.equal(result.code, 4, result.stderr);
      assert.ok(result.stdout.length > 0, `refusal must remain structured: ${result.stderr}`);
      const refusal = JSON.parse(result.stdout);
      assert.equal(refusal.code, "BUN_TEST_PROFILE_PREFLIGHT_FAILED");
      assert.equal(refusal.probe, "expect-assertion");
      assert.equal(refusal.failure, "REPORT_MISMATCH");
      assert.deepEqual(refusal.expected, {
        outcome: "ASSERTION_FAILURE",
        attributed: true,
        testsDiscovered: 1,
        candidateTestsDiscovered: 1,
      });
      assert.deepEqual(refusal.observed, {
        outcome: "PASS",
        attributed: false,
        testsDiscovered: 1,
        candidateTestsDiscovered: 1,
      });
      assert.equal(existsSync(result.out), false);
      const launches = (await readFile(path.join(result.state, "runtime-launches.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(
        launches.length,
        7,
        "three qualification calls, one connection and three attached starts",
      );
      assert.equal(launches.filter((call) => call[0] === "system").length, 1);
      assert.equal(launches.filter((call) => call[0] === "start").length, 3);
    } finally {
      await rm(result.parent, { recursive: true, force: true });
    }
  });
}

for (const [transport, code] of [
  ["stdio", "CONTAINER_STDIO_UNAVAILABLE"],
  ["wrong", "CONTAINER_TRANSPORT_INVALID"],
]) {
  it(`refuses ${transport} transport before any container is created`, async () => {
    const result = await refusedWitness(transport as string);
    try {
      assert.equal(result.code, 4, result.stderr);
      assert.ok(result.stderr.includes(code as string));
      assert.equal(result.stdout, "");
      assert.equal(existsSync(result.out), false);
      const calls = await readFile(path.join(result.state, "calls.jsonl"), "utf8").catch(() => "");
      assert.doesNotMatch(calls, /\["create"/);
    } finally {
      await rm(result.parent, { recursive: true, force: true });
    }
  });
}
