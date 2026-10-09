import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sha256Canonical } from "../src/core/index.js";
import { AssertLedger } from "../src/sdk/index.js";
import { runCli } from "../src/cli.js";

async function capability() {
  const modulePath = "../src/engine/qualification.js";
  const module = await import(modulePath).catch(() => ({}));
  assert.equal(
    typeof module.qualifyOrchestration,
    "function",
    "orchestration qualification missing",
  );
  return module;
}

test("qualification keeps expected nonzero exits as command facts and executes isolated worlds", async () => {
  const engine = await capability();
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-qualification-"));
  try {
    const completedLeaf = `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.ASSERTLEDGER_QUALIFICATION_RESULT_FILE, JSON.stringify({facts:{commandOutcome:'EXPECTED_FAILURE',exitCode:7},nonce:process.env.ASSERTLEDGER_QUALIFICATION_NONCE,protocolVersion:'1.0.0'})+'\\n');
process.exit(7);\n`;
    await writeFile(path.join(root, "leaf.mjs"), completedLeaf);
    const inputDigest = await engine.qualificationRepositoryDigest(root);
    const candidateDigest = sha256Canonical([]);
    const nodeDigest = await engine.qualificationFileDigest(process.execPath);
    const plan = {
      schemaVersion: "1.0.0",
      profileId: "nonzero-command-v1",
      subject: {
        commit: "fixture-commit",
        baseCommit: "fixture-base",
        candidateDigest,
        inputDigest,
      },
      tools: [{ id: "node", version: process.versions.node, digest: nodeDigest }],
      suites: [],
      allowedCandidatePaths: ["leaf.mjs"],
      obligations: [
        {
          id: "propagation",
          kind: "propagation",
          required: true,
          suiteIds: [],
          checks: [{ id: "terminal", actionId: "leaf", field: "exitCode", expected: 7 }],
          limits: [],
        },
      ],
      actions: [
        {
          id: "leaf",
          adapter: "command",
          executable: process.execPath,
          arguments: ["leaf.mjs"],
          environment: {},
          prepareFiles: [],
          removePaths: [],
          observe: { trace: false, outputs: [], report: null },
        },
      ],
      worlds: [
        { id: "reference", kind: "REFERENCE", files: [], discriminants: [] },
        {
          id: "swallowed",
          kind: "TARGET",
          files: [{ path: "leaf.mjs", content: "process.exit(0);\n" }],
          discriminants: [{ obligationId: "propagation", checkIds: ["terminal"] }],
        },
        {
          id: "neutral",
          kind: "NEUTRAL",
          files: [{ path: "leaf.mjs", content: `// harmless\n${completedLeaf}` }],
          discriminants: [],
        },
      ],
      requiredAttempts: 2,
      timeoutMs: 5000,
      maximumOutputBytes: 65536,
      isolation: { kind: "trusted-local", acknowledgedUnsafeExecution: true },
    };
    const result = await engine.qualifyOrchestration(
      { root, plan, planDigest: sha256Canonical(plan), candidate: { files: [] } },
      { allowUnsafeExecution: true },
    );
    assert.equal(result.decision, "QUALIFIED");
    assert.equal(result.observations.length, 6);
    assert.equal(result.observations[0].state, "COMPLETED");
    const ledger = new AssertLedger();
    assert.equal(ledger.replayQualification(result).valid, true);
    const sdkResult = await ledger.qualifyOrchestration(
      { root, plan, planDigest: sha256Canonical(plan), candidate: { files: [] } },
      { allowUnsafeExecution: true },
    );
    assert.equal(sdkResult.decision, "QUALIFIED");
    let cliOutput = "";
    const cliCode = await runCli(["qualify", "-", "--allow-unsafe-execution"], {
      cwd: root,
      readStdin: async () =>
        JSON.stringify({ root, plan, planDigest: sha256Canonical(plan), candidate: { files: [] } }),
      writeStdout: (text) => {
        cliOutput += text;
      },
      writeStderr: (text) => {
        cliOutput += text;
      },
    });
    assert.equal(cliCode, 0, cliOutput);
    assert.equal(JSON.parse(cliOutput).decision, "QUALIFIED");
    for (const arguments_ of [
      ["leaf.mjs", "--summarize", "--cache=local:rw", "--cache-dir={cache}", "--cache-dir=/shared"],
      ["leaf.mjs", "--summarize", "--cache=local:rw", "--cache-dir={cache}", "--cache=remote:rw"],
      ["leaf.mjs", "--", "--summarize", "--cache=local:rw", "--cache-dir={cache}"],
    ]) {
      const malformed = structuredClone(plan);
      malformed.actions[0]!.adapter = "turbo";
      malformed.actions[0]!.arguments = arguments_;
      await assert.rejects(
        engine.qualifyOrchestration(
          {
            root,
            plan: malformed,
            planDigest: sha256Canonical(malformed),
            candidate: { files: [] },
          },
          { allowUnsafeExecution: true },
        ),
        /TURBO_CACHE_NOT_CONTROLLED/u,
      );
    }
    assert.equal(await readFile(path.join(root, "leaf.mjs"), "utf8"), completedLeaf);
    await assert.rejects(
      engine.qualifyOrchestration({
        root,
        plan,
        planDigest: sha256Canonical(plan),
        candidate: { files: [] },
      }),
      /UNSAFE_EXECUTION/,
    );
    await writeFile(path.join(root, "leaf.mjs"), "process.exit(8);\n");
    await assert.rejects(
      engine.qualifyOrchestration(
        { root, plan, planDigest: sha256Canonical(plan), candidate: { files: [] } },
        { allowUnsafeExecution: true },
      ),
      /INPUT_DIGEST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
