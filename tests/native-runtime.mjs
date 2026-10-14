import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  decideEvidence,
  replayEvidenceManifest,
  selectCandidates,
  sha256Canonical,
  verifyDecisionDigest,
  verifyManifestIntegrity,
} from "../dist/core/index.js";
import { runProcess as legacyRunProcess } from "../dist/engine/index.js";
import * as facade from "../dist/native/index.js";

const require = createRequire(import.meta.url);
const native = require(
  fileURLToPath(new URL("../.testforge/native/assertledger.node", import.meta.url)),
);

test("native canonicalization preserves ECMAScript bytes and UTF-16 ordering", () => {
  const cases = [
    { z: 1, a: [true, null, "é"] },
    { "\uE000": 1, "\u{10000}": 2 },
    { "\uD800": "\uDC00", "\uDFFF": "\uD800" },
    [-0, 1e-7, 1e-6, 1e20, 1e21, 5e-324, 1.7976931348623157e308, 9007199254740992],
    { escape: '\u0000\b\f\n\r\t"\\\u2028\u2029' },
    Object.assign(Object.create(null), { alpha: 1, beta: [2, 3] }),
  ];
  for (const value of cases) {
    assert.equal(native.canonicalize(value), canonicalize(value));
    assert.equal(native.sha256Canonical(value), sha256Canonical(value));
  }
});

test("native canonicalization refuses values serialization would silently change", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = new Array(2);
  sparse[1] = 1;
  const invalid = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("value"),
    () => 1,
    new Date(),
    new Map(),
    sparse,
    cyclic,
    { omitted: undefined },
  ];
  for (const value of invalid) assert.throws(() => native.canonicalize(value));
});

test("native canonicalization accepts shared children without treating them as cycles", () => {
  const child = { value: "same" };
  const value = { left: child, right: child };
  assert.equal(native.canonicalize(value), canonicalize(value));
});

test("native array getters observe live length like the JavaScript reference", () => {
  for (const mode of ["shrink", "grow"]) {
    const make = () => {
      const array = mode === "shrink" ? [0, 9] : [0];
      Object.defineProperty(array, "0", {
        get() {
          if (mode === "shrink") array.length = 1;
          else array[1] = 9;
          return 7;
        },
      });
      return array;
    };
    assert.equal(native.canonicalize(make()), canonicalize(make()));
    assert.equal(native.sha256Canonical(make()), sha256Canonical(make()));
  }
});

test("native operation dispatch refuses unknown operations", () => {
  assert.throws(() => native.dispatchJson("missing-operation", "[]"));
});

const seed = JSON.parse(
  readFileSync(new URL("../conformance/v1/inputs/decide-verified.json", import.meta.url), "utf8"),
);
const dispatch = (operation, args) =>
  JSON.parse(native.dispatchJson(operation, JSON.stringify(args)));

test("native decisions match complete JS manifests for varied JSON evidence", () => {
  const outcomes = [
    "PASS",
    "ASSERTION_FAILURE",
    "TIMEOUT",
    "INFRA_ERROR",
    "COMPILE_FAILURE",
    "COLLECTION_FAILURE",
    "PROCESS_CRASH",
    "NO_TEST_DISCOVERED",
  ];
  const cases = [seed, {}, null, [], { ...seed, schemaVersion: "99.0.0" }];
  for (let index = 0; index < 160; index++) {
    const input = structuredClone(seed);
    const observation = input.observations[index % input.observations.length];
    observation.outcome = outcomes[Math.floor(index / input.observations.length) % outcomes.length];
    if (index % 3 === 0) observation.attributed = !observation.attributed;
    if (index % 5 === 0) observation.candidateTestsDiscovered = 0;
    if (index % 7 === 0) observation.attempt = 2;
    if (index % 11 === 0) input.observations.pop();
    if (index % 13 === 0) input.worlds.reverse();
    if (index % 17 === 0) input.policy.minimumTargetWeightPermille = 1001;
    cases.push(input);
  }
  for (let version = 2; version <= 5; version++) {
    const input = structuredClone(seed);
    input.schemaVersion = `${version}.0.0`;
    input.evidenceContext.execution.backend = { kind: "trusted-local", level: "UNSANDBOXED" };
    if (version >= 4)
      input.evidenceContext.repository = {
        includeDependencies: false,
        omittedLinks: [],
        git: null,
      };
    if (version === 5)
      Object.assign(input.evidenceContext.repository, {
        snapshot: "repository",
        include: [],
        preservedLinkCount: 0,
        unboundedClosureEdges: [],
      });
    cases.push(input);
  }
  for (const [index, input] of cases.entries()) {
    const expected = decideEvidence(input);
    assert.deepEqual(dispatch("decideEvidence", [input]), expected, `case ${index}`);
    assert.deepEqual(
      dispatch("replayEvidenceManifest", [expected]),
      replayEvidenceManifest(expected),
    );
    assert.deepEqual(dispatch("verifyDecisionDigest", [expected]), verifyDecisionDigest(expected));
    assert.deepEqual(
      dispatch("verifyManifestIntegrity", [expected]),
      verifyManifestIntegrity(expected),
    );
  }
});

test("native selection and development facade use the Rust kernel", () => {
  const manifest = decideEvidence(seed);
  assert.deepEqual(facade.decideEvidence(seed), manifest);
  assert.deepEqual(facade.replayEvidenceManifest(manifest), replayEvidenceManifest(manifest));
  assert.deepEqual(
    facade.selectCandidates(manifest.candidates, 10),
    selectCandidates(manifest.candidates, 10),
  );
  assert.equal(facade.canonicalize({ "\uD800": "\uDFFF" }), canonicalize({ "\uD800": "\uDFFF" }));
  assert.throws(() => facade.canonicalize(undefined), TypeError);
});

test("native process facade preserves completed argv/output behavior", async () => {
  for (const script of [
    "process.stdout.write(process.argv[1]); process.stderr.write('é')",
    "process.exit(23)",
  ]) {
    const input = {
      executable: process.execPath,
      args: ["-e", script, "$(literal); & | >"],
      cwd: process.cwd(),
      environment: {},
      timeoutMs: 5000,
      maximumOutputBytes: 5,
    };
    const original = await legacyRunProcess(input);
    const migrated = await facade.runProcess(input);
    delete original.durationMs;
    delete migrated.durationMs;
    assert.deepEqual(migrated, original);
  }
});

test("native nesting refusal remains an explicit development limitation", () => {
  let value = {};
  for (let index = 0; index < 1000; index++) value = { child: value };
  assert.throws(() => facade.canonicalize(value), /nesting limit/);
});
