import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function complete(exitCode) {
  writeFileSync(
    process.env.ASSERTLEDGER_QUALIFICATION_RESULT_FILE,
    `${JSON.stringify({
      facts: { commandOutcome: exitCode === 0 ? "PASS" : "EXPECTED_FAILURE", exitCode },
      nonce: process.env.ASSERTLEDGER_QUALIFICATION_NONCE,
      protocolVersion: "1.0.0",
    })}\n`,
  );
}

export function execute(executable, args, suffix) {
  const report = `${process.env.ASSERTLEDGER_QUALIFICATION_RESULT_FILE}.${suffix}`;
  rmSync(report, { force: true });
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    env: { ...process.env, ASSERTLEDGER_QUALIFICATION_RESULT_FILE: report },
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error("PUBLIC_CHILD_OPERATIONAL_FAILURE", { cause: result.error });
  }
  if (result.status !== 0) {
    // A normal failed leaf must attest completion through each wrapper. Numeric
    // exits, compiler diagnostics and thrown errors are not semantic attestations.
    const document = JSON.parse(readFileSync(report, "utf8"));
    if (
      document.protocolVersion !== "1.0.0" ||
      document.nonce !== process.env.ASSERTLEDGER_QUALIFICATION_NONCE ||
      document.facts.commandOutcome !== "EXPECTED_FAILURE" ||
      document.facts.exitCode !== result.status
    ) {
      throw new Error("PUBLIC_CHILD_COMPLETION_MISSING");
    }
  }
  return result.status;
}
