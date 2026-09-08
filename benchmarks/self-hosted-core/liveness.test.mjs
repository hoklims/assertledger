import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../../src/core/index.js";

test("the self-hosted adapter can import the mutated core surface", () => {
  assert.equal(typeof core.decideEvidence, "function");
  assert.equal(typeof core.verifyDecisionDigest, "function");
});
