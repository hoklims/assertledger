import { test } from "node:test";
import assert from "node:assert/strict";
test("structured Turbo build selection", () => {
  assert.deepEqual(
    ["run", "build", "--filter=@public/app..."],
    ["run", "build", "--filter=@public/app..."],
  );
});
test("structured wrapper command", () => {
  assert.deepEqual(["wrapper.mjs"], ["wrapper.mjs"]);
});
