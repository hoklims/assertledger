import { test } from "node:test";
import assert from "node:assert/strict";
import { failCommandArgs, wrapperCommandArgs } from "./commands.mjs";

test("structured Turbo failure selection", () => {
  assert.deepEqual(failCommandArgs({ cacheDirectory: "mock-cache" }), [
    "run",
    "fail",
    "--filter=@public/app...",
    "--cache=local:rw",
    "--cache-dir=mock-cache",
    "--summarize",
  ]);
  assert.deepEqual(failCommandArgs({ emptySelection: true, cacheDirectory: "mock-cache" }), [
    "run",
    "fail",
    "--filter=!@public/*",
    "--cache=local:rw",
    "--cache-dir=mock-cache",
    "--summarize",
  ]);
});
test("structured wrapper command", () => {
  assert.deepEqual(wrapperCommandArgs("wrapper.mjs"), ["wrapper.mjs", "orchestrator"]);
});
