import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const faults = JSON.parse(readFileSync("faults.json", "utf8"));
const emit = (task, event) =>
  appendFileSync(
    process.env.ASSERTLEDGER_QUALIFICATION_TRACE,
    `${JSON.stringify({ nonce: process.env.ASSERTLEDGER_QUALIFICATION_NONCE, task, event })}\n`,
  );
const layer = process.argv[2] ?? "terminal";
emit(layer, "start");
if (layer === "seed") {
  writeFileSync("success-receipt.json", JSON.stringify({ exitCode: 0 }));
  emit(layer, "finish");
  process.exit(0);
}
let status;
if (layer === "orchestrator") {
  if (faults.omitStage || faults.emptySelection || faults.staleResult) status = 0;
  else {
    emit("mandatory-stage", "start");
    emit("mandatory-stage", "finish");
    status = spawnSync(
      process.env.PUBLIC_TURBO_EXECUTABLE,
      [
        "run",
        "fail",
        "--filter=@public/app...",
        "--cache=local:rw",
        `--cache-dir=${process.env.ASSERTLEDGER_QUALIFICATION_CACHE}`,
        "--summarize",
      ],
      {
        stdio: "inherit",
      },
    ).status;
    if (faults.swallow) status = 0;
    if (faults.trailingMask) {
      // A subsequent successful command replaces the failing command's status.
      status = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "inherit" }).status;
    }
  }
} else if (faults.staleResult) {
  // A prior success is deliberately seeded by a separate, ordered action.
  status = JSON.parse(readFileSync("success-receipt.json", "utf8")).exitCode;
} else {
  status = spawnSync(process.execPath, [import.meta.filename, "orchestrator"], {
    stdio: "inherit",
  }).status;
}
emit(layer, status === 0 ? "finish" : "fail");
process.exit(status ?? 99);
