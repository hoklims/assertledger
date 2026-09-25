import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { classifyBunInspectorEvents } from "../integrations/bun/driver.mjs";

const root = path.join(os.tmpdir(), "assertledger-bun-classifier-fixture");
const control = path.join(root, "control.test.ts");
const candidate = path.join(root, "candidate.test.ts");
const helper = path.join(root, "node_modules", "assertledger", "bun.mjs");
const candidates = new Set(["candidate.test.ts"]);
const found = [
  { method: "TestReporter.found", params: { id: 1, type: "test", url: control } },
  { method: "TestReporter.found", params: { id: 2, type: "test", url: candidate } },
];
const controlPass = [
  { method: "TestReporter.start", params: { id: 1 } },
  { method: "TestReporter.end", params: { id: 1, status: "pass" } },
];

describe("Bun Inspector event classification", () => {
  it("uses a zero runner exit for a started candidate whose final pass event was lost", () => {
    const events = [...found, ...controlPass, { method: "TestReporter.start", params: { id: 2 } }];
    assert.deepEqual(classifyBunInspectorEvents(events, candidates, root, 0, false), {
      protocolVersion: "1.0.0",
      outcome: "PASS",
      testsDiscovered: 2,
      candidateTestsDiscovered: 1,
      attributed: true,
    });
    const nonzero = classifyBunInspectorEvents(events, candidates, root, 1, false);
    assert.equal(nonzero.outcome, "PROCESS_CRASH");
    assert.equal(nonzero.attributed, false);
  });

  it("requires the owned assertion error and a complete nonzero Inspector trace for a kill", () => {
    const candidateStart = { method: "TestReporter.start", params: { id: 2 } };
    const candidateEnd = { method: "TestReporter.end", params: { id: 2, status: "fail" } };
    const marker = {
      method: "LifecycleReporter.error",
      params: {
        name: "AssertLedgerBunAssertionError",
        message: "AssertLedger assertSame failed",
        urls: [helper],
      },
    };
    const assertion = classifyBunInspectorEvents(
      [...found, ...controlPass, candidateStart, marker, candidateEnd],
      candidates,
      root,
      1,
      false,
    );
    assert.equal(assertion.outcome, "ASSERTION_FAILURE");
    assert.equal(assertion.attributed, true);

    const generic = classifyBunInspectorEvents(
      [
        ...found,
        ...controlPass,
        candidateStart,
        { ...marker, params: { ...marker.params, urls: [candidate] } },
        candidateEnd,
      ],
      candidates,
      root,
      1,
      false,
    );
    assert.equal(generic.outcome, "PROCESS_CRASH");
    assert.equal(generic.attributed, false);
  });

  it("refuses attribution when an expected base file never starts", () => {
    const candidateOnly = [
      found[1]!,
      { method: "TestReporter.start", params: { id: 2 } },
      {
        method: "LifecycleReporter.error",
        params: {
          name: "AssertLedgerBunAssertionError",
          message: "AssertLedger assertSame failed",
          urls: [helper],
        },
      },
      { method: "TestReporter.end", params: { id: 2, status: "fail" } },
    ];
    const result = classifyBunInspectorEvents(
      candidateOnly,
      candidates,
      root,
      1,
      false,
      new Set(["control.test.ts"]),
    );
    assert.equal(result.outcome, "INFRA_ERROR");
    assert.equal(result.attributed, false);
  });
});
