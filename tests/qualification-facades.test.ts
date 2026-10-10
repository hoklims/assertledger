import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { smokeQualificationPlan, smokeTestSource } from "../scripts/qualification-smoke.js";
import { runCli } from "../src/cli.js";
import { sha256Canonical } from "../src/core/index.js";
import { sealQualificationPlan } from "../src/core/qualification.js";
import {
  qualificationFileDigest,
  qualificationRepositoryDigest,
} from "../src/engine/qualification.js";
import { AssertLedger } from "../src/sdk/index.js";

test("real CLI qualification and CI import preserve OPEN and REJECTED exits and reject forged replay", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "al-cli-"));
  const root = path.join(temporary, "workspace");
  await mkdir(root);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  function invoke(args: string[]) {
    const result = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null, result.stderr);
    return { exit: result.status, json: JSON.parse(result.stdout) };
  }
  try {
    for (const [decision, exit] of [
      ["OPEN", 3],
      ["REJECTED", 2],
    ] as const) {
      const source =
        decision === "REJECTED"
          ? smokeTestSource.replace("equal(1, 1)", "equal(1, 2)")
          : smokeTestSource;
      await writeFile(path.join(root, "public.test.mjs"), source);
      const plan = smokeQualificationPlan();
      // OPEN is a genuinely surviving target; REJECTED has a failing reference.
      const targetFile = plan.worlds[1]?.files[0];
      assert.ok(targetFile);
      if (decision === "OPEN") targetFile.content = smokeTestSource;
      plan.subject.inputDigest = await qualificationRepositoryDigest(root);
      plan.subject.candidateDigest = sha256Canonical([]);
      const tool = plan.tools[0];
      assert.ok(tool);
      tool.digest = await qualificationFileDigest(process.execPath);
      const sealed = sealQualificationPlan(plan);
      const requestPath = path.join(temporary, "request.json");
      await writeFile(requestPath, JSON.stringify({ root, ...sealed, candidate: { files: [] } }));
      const qualified = invoke(["qualify", requestPath, "--allow-unsafe-execution"]);
      assert.equal(qualified.json.decision, decision);
      assert.equal(qualified.exit, exit, `CLI_${decision}_EXIT`);
      assert.ok(
        qualified.json.observations.some((item: { state: string }) => item.state === "COMPLETED"),
      );
      const receiptPath = path.join(temporary, "receipt.json");
      await writeFile(receiptPath, JSON.stringify(qualified.json));
      const observationPath = path.join(temporary, "observation.json");
      // This plan has no CI-live obligation: an untrusted observation cannot change its decision.
      await writeFile(observationPath, "{}");
      const imported = invoke(["qualification-ci", receiptPath, "--observation", observationPath]);
      assert.equal(imported.json.decision, decision);
      assert.equal(imported.exit, exit, `CLI_CI_${decision}_EXIT`);
      const replay = invoke(["qualification-replay", receiptPath]);
      assert.equal(replay.json.valid, true);
      assert.equal(replay.exit, 0);
      qualified.json.observations[0].facts.testOutcome = "FORGED";
      await writeFile(receiptPath, JSON.stringify(qualified.json));
      const forged = invoke(["qualification-replay", receiptPath]);
      assert.equal(forged.json.valid, false);
      assert.equal(forged.exit, 4, "CLI_INVALID_REPLAY_EXIT");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("SDK exposes explicit scoped qualification and replay without interpreting test receipts as PR proof", () => {
  const ledger = new AssertLedger() as AssertLedger & Record<string, unknown>;
  assert.equal(typeof ledger.qualifyOrchestration, "function", "SDK qualification missing");
  assert.equal(typeof ledger.replayQualification, "function", "SDK domain-aware replay missing");
  assert.equal(
    typeof ledger.sealQualificationPlan,
    "function",
    "SDK operator plan sealing missing",
  );
});

test("CLI names plan, execution and replay surfaces and refuses unauthorized execution", async () => {
  let output = "";
  const io = {
    cwd: process.cwd(),
    readStdin: async () => "{}",
    writeStdout: (text: string) => {
      output += text;
    },
    writeStderr: (text: string) => {
      output += text;
    },
  };
  assert.equal(await runCli(["--help"], io), 0);
  assert.match(output, /qualification-plan/u, "qualification plan command missing");
  assert.match(output, /qualification-replay/u);
  assert.equal(await runCli(["qualify", "-"], io), 4);
});
