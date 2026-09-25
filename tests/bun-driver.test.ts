import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(repositoryRoot, "integrations", "bun", "driver.mjs");
const helper = path.join(repositoryRoot, "integrations", "bun", "assertions.mjs");
const requestedBun = process.env.ASSERTLEDGER_BUN_EXECUTABLE ?? "bun";
const bunProbe = spawnSync(requestedBun, ["-e", "console.log(process.execPath)"], {
  encoding: "utf8",
  shell: false,
});
if (bunProbe.status !== 0 || !path.isAbsolute(bunProbe.stdout.trim())) {
  throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
}
const bun = bunProbe.stdout.trim();

async function execute(
  candidateSource: string,
  controlSource = 'import { test } from "bun:test";\ntest("control", () => {});\n',
  candidateFiles = ["candidate.test.mjs"],
  extraControlSource?: string,
  extraCandidateSource?: string,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-driver-test-"));
  try {
    await writeFile(path.join(root, "control.test.mjs"), controlSource);
    await writeFile(path.join(root, "candidate.test.mjs"), candidateSource);
    if (extraControlSource !== undefined) {
      await writeFile(path.join(root, "prefix-control.test.mjs"), extraControlSource);
    }
    if (extraCandidateSource !== undefined) {
      await writeFile(path.join(root, "later.test.mjs"), extraCandidateSource);
    }
    const resultPath = path.join(root, "result.json");
    const child = spawn(process.execPath, [driver, bun, helper, "control.test.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        TESTFORGE_RESULT_FILE: resultPath,
        TESTFORGE_CANDIDATE_FILES: JSON.stringify(candidateFiles),
      },
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const result = JSON.parse(stdout) as Record<string, unknown>;
    return { exitCode, result, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Bun instrumented structured-command driver", () => {
  it("observes it aliases and parameterized Bun tests", async () => {
    const observation = await execute(
      'import { it, test } from "bun:test"; it("alias", () => {}); test.each([1, 2])("row %i", (value) => { if (value < 1) throw new Error("invalid"); });\n',
    );
    assert.equal(observation.result.outcome, "PASS", observation.stderr);
    assert.equal(observation.result.testsDiscovered, 4);
    assert.equal(observation.result.candidateTestsDiscovered, 3);
  });

  it("runs exact base paths instead of similarly named tests", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; test("candidate", () => {});\n',
      'import { test } from "bun:test"; test("control", () => {});\n',
      ["candidate.test.mjs"],
      'import { test } from "bun:test"; test("decoy", () => { throw new Error("wrong file"); });\n',
    );
    assert.equal(observation.result.outcome, "PASS", observation.stderr);
    assert.equal(observation.result.testsDiscovered, 2);
  });

  it("reports a candidate file with no registered test as NO_TEST_DISCOVERED", async () => {
    const observation = await execute("export const value = 1;\n");
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "NO_TEST_DISCOVERED", observation.stderr);
    assert.equal(observation.result.candidateTestsDiscovered, 0);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects candidate path tokens that Bun could parse as options", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\ntest("candidate", () => {});\n',
      undefined,
      ["--parallel"],
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "INFRA_ERROR");
    assert.equal(observation.result.attributed, false);
  });

  it("attributes a test nested in a Bun describe suite", async () => {
    const observation = await execute(
      'import { describe, test } from "bun:test";\nimport { assertSame } from "assertledger/bun";\ndescribe("group", () => { test("candidate", () => assertSame(1, 2)); });\n',
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "ASSERTION_FAILURE");
    assert.equal(observation.result.attributed, true);
  });

  it("attributes only assertSame failures in the candidate URL", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\nimport { assertSame } from "assertledger/bun";\ntest("candidate", () => assertSame(1, 2));\n',
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.deepEqual(
      observation.result,
      {
        protocolVersion: "1.0.0",
        outcome: "ASSERTION_FAILURE",
        testsDiscovered: 2,
        candidateTestsDiscovered: 1,
        attributed: true,
      },
      observation.stderr,
    );
  });

  it("keeps a plain throw unattributed", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\ntest("candidate", () => { throw new Error("boom"); });\n',
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a candidate forged engine result file", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("candidate", () => { const file = process.env.TESTFORGE_RESULT_FILE; if (file) writeFileSync(file, JSON.stringify({ protocolVersion: "1.0.0", outcome: "ASSERTION_FAILURE", testsDiscovered: 2, candidateTestsDiscovered: 1, attributed: true })); throw new Error("generic"); });\n',
    );
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a candidate rewrite of preload ownership evidence", async () => {
    const observation = await execute(
      'import { afterAll, test } from "bun:test"; import { readFileSync, writeFileSync } from "node:fs"; afterAll(() => { const file = process.env.ASSERTLEDGER_BUN_EVENTS_FILE; if (file) writeFileSync(file, readFileSync(file, "utf8").replace("\\\"owned\\\":false", "\\\"owned\\\":true")); }); test("candidate", () => { throw new Error("generic"); });\n',
    );
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects unsigned candidate messages on the preload evidence pipe", async () => {
    const observation = await execute(
      'import { afterAll, test } from "bun:test"; import { writeSync } from "node:fs"; afterAll(() => writeSync(3, `${JSON.stringify({ event: { kind: "hook-error" }, mac: "0".repeat(64) })}\\n`)); test("candidate", () => { throw new Error("generic"); });\n',
    );
    assert.equal(observation.result.outcome, "INFRA_ERROR", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("keeps an operand throw unattributed", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\nimport { assertSame } from "assertledger/bun";\nfunction explode() { throw new Error("operand"); }\ntest("candidate", () => assertSame(explode(), 2));\n',
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("keeps a control failure unattributed even when the candidate assertion fails", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\nimport { assertSame } from "assertledger/bun";\ntest("candidate", () => assertSame(1, 2));\n',
      'import { test } from "bun:test";\ntest("control", () => { throw new Error("control"); });\n',
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("does not credit an assertion alongside a collection error", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; test("candidate", () => assertSame(1, 2)); throw new Error("collection");\n',
    );
    assert.equal(observation.result.outcome, "INFRA_ERROR", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("does not credit an assertion when a later candidate file fails during collection", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; test("candidate", () => assertSame(1, 2));\n',
      'import { test } from "bun:test"; test("control", () => {});\n',
      ["candidate.test.mjs", "later.test.mjs"],
      undefined,
      'throw new Error("later collection error");\n',
    );
    assert.notEqual(observation.result.outcome, "ASSERTION_FAILURE", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  for (const hook of ["beforeAll", "afterAll", "beforeEach", "afterEach"]) {
    it(`does not credit an assertion alongside a failing ${hook} hook`, async () => {
      const observation = await execute(
        `import { ${hook}, test } from "bun:test"; import { assertSame } from "assertledger/bun"; ${hook}(() => { throw new Error("hook failure"); }); test("candidate", () => assertSame(1, 2));\n`,
      );
      assert.notEqual(observation.result.outcome, "ASSERTION_FAILURE", observation.stderr);
      assert.equal(observation.result.attributed, false);
    });
  }

  it("rejects a candidate attempt to spoof the helper error name", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\ntest("candidate", () => { const error = new Error("AssertLedger assertSame failed"); error.name = "AssertLedgerBunAssertionError"; throw error; });\n',
    );
    assert.equal(observation.exitCode, 1, observation.stderr);
    assert.equal(observation.result.outcome, "PROCESS_CRASH");
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a fresh error constructed from a caught helper error", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let Captured; try { assertSame(1, 2); } catch (error) { Captured = error.constructor; } test("forged", () => { throw new Captured(); });\n',
    );
    assert.notEqual(observation.result.outcome, "ASSERTION_FAILURE", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a helper error saved outside the active test and thrown later", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let saved; try { assertSame(1, 2); } catch (error) { saved = error; } test("replayed", () => { throw saved; });\n',
    );
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a helper error replayed by a different test callback", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let saved; test("capture", () => { try { assertSame(1, 2); } catch (error) { saved = error; } }); test("replay", () => { throw saved; });\n',
    );
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a saved helper error injected through a changed Reflect.apply", async () => {
    const observation = await execute(
      'import { test } from "bun:test"; import { assertSame } from "assertledger/bun"; let saved; try { assertSame(1, 2); } catch (error) { saved = error; } test("reflect", () => { const original = Reflect.apply; Reflect.apply = () => { throw saved; }; try { assertSame(1, 1); } finally { Reflect.apply = original; } throw new Error("generic"); });\n',
    );
    assert.equal(observation.result.outcome, "PROCESS_CRASH", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("rejects a generic error when a candidate replaces WeakSet.prototype.has", async () => {
    const observation = await execute(
      'import { afterEach, test } from "bun:test"; const original = WeakSet.prototype.has; afterEach(() => { WeakSet.prototype.has = original; }); test("spoof", () => { WeakSet.prototype.has = function(value) { return value instanceof Error ? true : original.call(this, value); }; throw new Error("generic"); });\n',
    );
    assert.notEqual(observation.result.outcome, "ASSERTION_FAILURE", observation.stderr);
    assert.equal(observation.result.attributed, false);
  });

  it("reports a clean control and candidate run as PASS", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\nimport { assertSame } from "assertledger/bun";\ntest("candidate", () => assertSame(1, 1));\n',
    );
    assert.equal(observation.exitCode, 0, observation.stderr);
    assert.equal(observation.result.outcome, "PASS");
    assert.equal(observation.result.attributed, true);
  });

  it("reports a control-only baseline as an unattributed PASS", async () => {
    const observation = await execute(
      'import { test } from "bun:test";\ntest("ordinary base test", () => {});\n',
      'import { test } from "bun:test";\ntest("control", () => {});\n',
      [],
    );
    assert.equal(observation.exitCode, 0, observation.stderr);
    assert.deepEqual(observation.result, {
      protocolVersion: "1.0.0",
      outcome: "PASS",
      testsDiscovered: 1,
      candidateTestsDiscovered: 0,
      attributed: false,
    });
  });
});
