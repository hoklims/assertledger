import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  replayAgenticCorpusAllocationCommitment,
  replayAgenticCorpusExperimentPlan,
} from "../src/core/index.js";

describe("externally anchored H3 evidence", () => {
  it("fails closed before accepting self-attested commitment or plan input", () => {
    assert.equal(replayAgenticCorpusAllocationCommitment({}).valid, false);
    assert.equal(replayAgenticCorpusExperimentPlan({}, "").valid, false);
  });
});
