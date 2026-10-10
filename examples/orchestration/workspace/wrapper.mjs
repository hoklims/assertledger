import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { complete, execute } from "./completion.mjs";
import { failCommandArgs, wrapperCommandArgs } from "./commands.mjs";
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
  if (faults.omitStage || faults.staleResult) status = 0;
  else {
    emit("mandatory-stage", "start");
    emit("mandatory-stage", "finish");
    status = execute(
      process.env.PUBLIC_TURBO_EXECUTABLE,
      failCommandArgs({
        emptySelection: faults.emptySelection,
        cacheDirectory: process.env.ASSERTLEDGER_QUALIFICATION_CACHE,
      }),
      "leaf",
    );
    if (faults.swallow) status = 0;
    if (faults.trailingMask) {
      // A subsequent successful command replaces the failing command's status.
      status = execute(process.execPath, ["-e", "process.exit(0)"], "trailing");
    }
  }
} else if (faults.staleResult) {
  // A prior success is deliberately seeded by a separate, ordered action.
  status = JSON.parse(readFileSync("success-receipt.json", "utf8")).exitCode;
} else {
  status = execute(process.execPath, wrapperCommandArgs(import.meta.filename), "orchestrator");
}
emit(layer, status === 0 ? "finish" : "fail");
complete(status);
process.exit(status);
