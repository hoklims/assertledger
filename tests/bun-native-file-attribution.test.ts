import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { collectBunNative } from "../src/engine/adapters/bun-native.js";

async function collect(files: Record<string, string>, rewrite = "") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-file-attribution-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), source);
    }
    const helper =
      'import {expect} from "bun:test"; export function check(value){expect(value).toBe(1);}';
    await writeFile(path.join(cwd, "helper.ts"), helper);
    const preload = path.join(cwd, "rewrite.mjs");
    await writeFile(
      preload,
      `if (process.argv[1]?.endsWith("driver.mjs")) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, ...args) {
    const row = JSON.parse(String(chunk));
    ${rewrite}
    return write(JSON.stringify(row)+"\\n", ...args);
  };
}`,
    );
    return await collectBunNative({
      executable: "bun",
      files: Object.keys(files),
      cwd,
      environment: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...(rewrite ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}),
      },
      timeoutMs: 5000,
      maximumOutputBytes: 65536,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const bunTest = (value: number) =>
  `import {test} from "bun:test"; import {check} from "./helper"; test("case",()=>check(${value}));`;
const nodeTest = (value: number) =>
  `import test from "node:test"; import assert from "node:assert/strict"; test("case",()=>assert.equal(${value},1));`;

for (const [name, source] of [
  ["Bun helper assertion", bunTest],
  ["Node assertion under Bun", nodeTest],
] as const) {
  for (const failingFile of ["a.test.ts", "b.test.ts"]) {
    test(`${name} attributes only ${failingFile} when the other file passes`, async () => {
      const result = await collect({
        "a.test.ts": source(failingFile === "a.test.ts" ? 2 : 1),
        "b.test.ts": source(failingFile === "b.test.ts" ? 2 : 1),
      });
      assert.equal(result.state, "COMPLETED");
      assert.equal(result.facts.testOutcome, "ASSERTION_FAILURE");
      assert.deepEqual(result.facts.testFiles, ["a.test.ts", "b.test.ts"]);
      assert.deepEqual(result.facts.assertionFailureFiles, [failingFile]);
    });
  }
}

test("failure files are sorted unique test owners and exclude helpers", async () => {
  const repeated =
    'import {test} from "bun:test"; import {check} from "./helper"; test.each([2,3])("row %i",value=>check(value));';
  const result = await collect({ "b.test.ts": repeated, "a.test.ts": repeated });
  assert.equal(result.facts.testOutcome, "ASSERTION_FAILURE");
  assert.deepEqual(result.facts.assertionFailureFiles, ["a.test.ts", "b.test.ts"]);
});

for (const failingFile of ["Nested/Alpha.test.ts", "Nested/Beta.test.ts"]) {
  test(`nested mixed-case failure owner remains canonical ${failingFile}`, async () => {
    const files = ["Nested/Alpha.test.ts", "Nested/Beta.test.ts"];
    const result = await collect(
      Object.fromEntries(
        files.map((file) => [
          file,
          bunTest(file === failingFile ? 2 : 1).replace('"./helper"', '"../helper"'),
        ]),
      ),
    );
    assert.equal(result.state, "COMPLETED");
    assert.equal(result.facts.testOutcome, "ASSERTION_FAILURE");
    assert.deepEqual(result.facts.testFiles, files);
    assert.deepEqual(result.facts.assertionFailureFiles, [failingFile]);
    assert.ok(result.facts.assertionFailureFiles.every((file) => !file.includes("\\")));
  });
}

test("aliased declarations cannot claim distinct test owners", async () => {
  const result = await collect({ "a.test.ts": bunTest(2), "./a.test.ts": bunTest(2) });
  assert.equal(result.state, "INFRA_ERROR");
  assert.equal(result.facts.attributed, false);
  assert.deepEqual(result.facts.assertionFailureFiles, []);
});

test("passing and mixed operational runs cannot name assertion failure files", async () => {
  const passing = await collect({ "a.test.ts": bunTest(1), "b.test.ts": bunTest(1) });
  assert.equal(passing.facts.testOutcome, "PASS");
  assert.deepEqual(passing.facts.assertionFailureFiles, []);
  for (const operational of [
    'import {test} from "bun:test";test("error",()=>{throw Error("ordinary");});',
    'import {test,beforeAll} from "bun:test";import {check} from "./helper";beforeAll(()=>check(2));test("hook",()=>{});',
    'import {test} from "bun:test";throw Error("collection");',
  ]) {
    const result = await collect({ "a.test.ts": bunTest(2), "b.test.ts": operational });
    assert.notEqual(result.state, "COMPLETED");
    assert.equal(result.facts.attributed, false);
    assert.deepEqual(result.facts.assertionFailureFiles, []);
  }
});

for (const [label, rewrite] of [
  ["missing failure files", "delete row.assertionFailureFiles;"],
  ["empty assertion failure files", "row.assertionFailureFiles=[];"],
  ["duplicate failure files", 'row.assertionFailureFiles=["a.test.ts","a.test.ts"];'],
  ["unstarted helper file", 'row.assertionFailureFiles=["helper.ts"];'],
  ["noncanonical file", 'row.assertionFailureFiles=["./a.test.ts"];'],
  ["nonattributed assertion", "row.attributed=false;"],
  ["invalid candidate count", "row.candidateTestsDiscovered=row.testsDiscovered+1;"],
  ["zero inner exit for assertion failure", "row.exitCode=0;"],
  [
    "operational outcome carrying failure files",
    'row.outcome="PROCESS_CRASH";row.attributed=false;',
  ],
] as const) {
  test(`native adapter refuses ${label} in an otherwise complete assertion report`, async () => {
    const result = await collect({ "a.test.ts": bunTest(2) }, rewrite);
    assert.equal(result.state, "INFRA_ERROR");
    assert.equal(result.facts.attributed, false);
    assert.deepEqual(result.facts.assertionFailureFiles, []);
  });
}

test("native adapter refuses failure files in a passing report", async () => {
  const result = await collect(
    { "a.test.ts": bunTest(1) },
    'row.assertionFailureFiles=["a.test.ts"];',
  );
  assert.equal(result.state, "INFRA_ERROR");
  assert.equal(result.facts.attributed, false);
  assert.deepEqual(result.facts.assertionFailureFiles, []);
});

test("native adapter refuses unsorted failure files", async () => {
  const result = await collect(
    { "a.test.ts": bunTest(2), "b.test.ts": bunTest(2) },
    'row.assertionFailureFiles=["b.test.ts","a.test.ts"];',
  );
  assert.equal(result.state, "INFRA_ERROR");
  assert.equal(result.facts.attributed, false);
  assert.deepEqual(result.facts.assertionFailureFiles, []);
});
