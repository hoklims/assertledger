import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBunInstrumentedEvidence, type BunTestEvent } from "../integrations/bun/driver.mjs";

const base = new Set(["base.test.ts"]);
const candidates = new Set(["candidate.test.ts"]);
const foundBase = { kind: "found", id: "base", file: "base.test.ts" } as const;
const basePass = { kind: "end", id: "base", status: "pass", owned: false } as const;
const foundCandidate = { kind: "found", id: "candidate", file: "candidate.test.ts" } as const;
const candidateFail = { kind: "end", id: "candidate", status: "fail", owned: true } as const;
const complete = [foundBase, basePass, foundCandidate, candidateFail] satisfies BunTestEvent[];

describe("instrumented Bun test evidence classification", () => {
  it("credits one owned candidate assertion only with complete Bun counts and passing controls", () => {
    assert.deepEqual(
      classifyBunInstrumentedEvidence(
        complete,
        { tests: 2, failures: 1, skipped: 0 },
        base,
        candidates,
        1,
      ),
      {
        protocolVersion: "1.0.0",
        outcome: "ASSERTION_FAILURE",
        testsDiscovered: 2,
        candidateTestsDiscovered: 1,
        attributed: true,
      },
    );
  });

  it("rejects a missing base callback or an extra Bun failure", () => {
    const missingBase = [foundCandidate, candidateFail] satisfies BunTestEvent[];
    const missing = classifyBunInstrumentedEvidence(
      missingBase,
      { tests: 1, failures: 1, skipped: 0 },
      base,
      candidates,
      1,
    );
    assert.equal(missing.outcome, "INFRA_ERROR");
    assert.equal(missing.attributed, false);

    const extraFailure = classifyBunInstrumentedEvidence(
      complete,
      { tests: 2, failures: 2, skipped: 0 },
      base,
      candidates,
      1,
    );
    assert.equal(extraFailure.outcome, "INFRA_ERROR");
    assert.equal(extraFailure.attributed, false);

    const collectionError = classifyBunInstrumentedEvidence(
      complete,
      { tests: 2, failures: 1, skipped: 0 },
      base,
      candidates,
      1,
      true,
    );
    assert.equal(collectionError.outcome, "INFRA_ERROR");
    assert.equal(collectionError.attributed, false);

    const hookError = classifyBunInstrumentedEvidence(
      [...complete, { kind: "hook-error" }],
      { tests: 2, failures: 1, skipped: 0 },
      base,
      candidates,
      1,
    );
    assert.equal(hookError.outcome, "INFRA_ERROR");
    assert.equal(hookError.attributed, false);
  });

  it("keeps generic throws, caught assertions and skipped tests non-attributed", () => {
    const generic = classifyBunInstrumentedEvidence(
      [foundBase, basePass, foundCandidate, { ...candidateFail, owned: false }],
      { tests: 2, failures: 1, skipped: 0 },
      base,
      candidates,
      1,
    );
    assert.equal(generic.outcome, "PROCESS_CRASH");
    assert.equal(generic.attributed, false);

    const skipped = classifyBunInstrumentedEvidence(
      complete,
      { tests: 2, failures: 1, skipped: 1 },
      base,
      candidates,
      1,
    );
    assert.equal(skipped.outcome, "INFRA_ERROR");
  });

  it("counts each parameterized callback execution without duplicate attribution", () => {
    const rows = [
      foundBase,
      basePass,
      foundCandidate,
      { kind: "end", id: "candidate", status: "pass", owned: false },
      { kind: "found", id: "candidate-row-2", file: "candidate.test.ts" },
      { ...candidateFail, id: "candidate-row-2" },
    ] satisfies BunTestEvent[];
    const result = classifyBunInstrumentedEvidence(
      rows,
      { tests: 3, failures: 1, skipped: 0 },
      base,
      candidates,
      1,
    );
    assert.equal(result.outcome, "ASSERTION_FAILURE");
    assert.equal(result.testsDiscovered, 3);
    assert.equal(result.candidateTestsDiscovered, 2);
  });

  it("rejects two callback completions that reuse one execution identity", () => {
    const replayedIdentity = [
      foundBase,
      basePass,
      foundCandidate,
      { kind: "end", id: "candidate", status: "pass", owned: false },
      candidateFail,
    ] satisfies BunTestEvent[];
    const result = classifyBunInstrumentedEvidence(
      replayedIdentity,
      { tests: 3, failures: 1, skipped: 0 },
      base,
      candidates,
      1,
    );
    assert.equal(result.outcome, "INFRA_ERROR");
    assert.equal(result.attributed, false);
  });
});
