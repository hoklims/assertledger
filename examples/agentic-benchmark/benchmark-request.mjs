import { readFile } from "node:fs/promises";
import { AssertLedger } from "assertledger";

const requestPath = process.argv[2];
if (requestPath === undefined) {
  console.error("Usage: node benchmark-request.mjs <agentic-benchmark-request.json>");
  process.exitCode = 64;
} else {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const assertLedger = new AssertLedger();
  const artifact = assertLedger.benchmark(request);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
  const statuses = artifact.summaries.map((summary) => summary.status);
  process.exitCode = statuses.every((status) => status === "MEASURED")
    ? 0
    : statuses.some((status) => status === "OBSERVED_RUN_FAILURE")
      ? 2
      : 3;
}
