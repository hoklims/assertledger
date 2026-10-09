import assert from "node:assert/strict";
import { test } from "node:test";
import { AssertLedger } from "../src/sdk/index.js";
import { runCli } from "../src/cli.js";

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
