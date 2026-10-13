import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { collectBunNative } from "../src/engine/adapters/bun-native.js";

type Termination = "normal" | "exit-seven" | "inconsistent-exit" | "signal" | "timeout";

async function collectAfterReport(assertion: boolean, termination: Termination) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-termination-"));
  try {
    const marker = path.join(cwd, "driver-report.json");
    const outerExit = path.join(cwd, "outer-exit.txt");
    const preload = path.join(cwd, "outer-preload.mjs");
    await writeFile(
      path.join(cwd, "case.test.ts"),
      `import {test,expect} from "bun:test"; test("case",()=>expect(1).toBe(${assertion ? 2 : 1}));`,
    );
    // Affect the Node driver only, after its complete inner report has been emitted.
    await writeFile(
      preload,
      `import {writeFileSync} from "node:fs";
if (process.argv[1]?.endsWith("driver.mjs")) {
  process.on("exit", code => writeFileSync(${JSON.stringify(outerExit)}, String(code)));
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, ...args) {
    const result = write(chunk, ...args);
    writeFileSync(${JSON.stringify(marker)}, chunk);
    return result;
  };
  process.once("beforeExit", () => {
    ${termination === "exit-seven" ? "process.exit(7);" : ""}
    ${termination === "inconsistent-exit" ? "process.exit(1);" : ""}
    ${termination === "signal" ? 'process.kill(process.pid, "SIGKILL");' : ""}
    ${termination === "timeout" ? "setInterval(() => {}, 1000);" : ""}
  });
}`,
    );
    const result = await collectBunNative({
      executable: "bun",
      files: ["case.test.ts"],
      cwd,
      environment: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
      timeoutMs: 2000,
      maximumOutputBytes: 65536,
    });
    const report = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
    assert.equal(report.outcome, assertion ? "ASSERTION_FAILURE" : "PASS");
    assert.equal(report.attributed, true);
    assert.equal(report.testsDiscovered, 1);
    if (termination === "normal") assert.equal(await readFile(outerExit, "utf8"), "0");
    return result;
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

for (const assertion of [false, true]) {
  const outcome = assertion ? "ASSERTION_FAILURE" : "PASS";
  test(`normal outer completion preserves ${outcome}`, async () => {
    const result = await collectAfterReport(assertion, "normal");
    assert.equal(result.state, "COMPLETED");
    assert.equal(result.facts.testOutcome, outcome);
    assert.equal(result.facts.exitCode, assertion ? 1 : 0);
    assert.equal(result.facts.attributed, true);
  });

  for (const termination of ["exit-seven", "inconsistent-exit", "signal", "timeout"] as const) {
    test(`outer ${termination} after ${outcome} cannot qualify or detect`, async () => {
      const result = await collectAfterReport(assertion, termination);
      assert.notEqual(result.state, "COMPLETED");
      assert.equal(result.facts.attributed, false);
      assert.notEqual(result.facts.testOutcome, "ASSERTION_FAILURE");
      assert.notEqual(result.facts.testOutcome, "PASS");
      if (termination === "timeout") assert.equal(result.state, "TIMEOUT");
    });
  }
}
