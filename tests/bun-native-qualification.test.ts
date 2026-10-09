import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectBunNative } from "../src/engine/adapters/bun-native.js";

test("native Bun expect qualification is available independently of the frozen helper profile", () => {
  assert.ok(
    existsSync(new URL("../src/engine/adapters/bun-native.ts", import.meta.url)),
    "native expect collection capability is absent",
  );
});

const executable = "bun";
async function collect(source: string, files = ["case.test.ts"], timeoutMs = 5000) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-native-"));
  try {
    await writeFile(path.join(cwd, "case.test.ts"), source);
    await writeFile(path.join(cwd, "helper.ts"), "export const actual: number = 2;");
    return await collectBunNative({
      executable,
      files,
      cwd,
      environment: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      timeoutMs,
      maximumOutputBytes: 65536,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("native expect accepts TS/describe/it/helper and test.each forms", async () => {
  const result = await collect(`import {test,it,describe,expect} from "bun:test";
import {actual} from "./helper";
describe("suite", () => { it("typed", async () => { expect(actual).toBe(2); await expect(Promise.resolve(actual)).resolves.toBe(2); }); });
test.each([1,2])("row %i", value => expect(value).not.toBe(0));
test("rejects", async () => { await expect(Promise.reject(new Error("expected"))).rejects.toThrow("expected"); });`);
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.facts.testOutcome, "PASS");
  assert.equal(result.facts.testsDiscovered, 4);
  assert.equal(result.runtime.bunRevision, "1.4.2+744846f84");
  assert.match(result.runtime.preloadDigest, /^[a-f0-9]{64}$/);
});

test("native matcher failure is attributed while a normal error is never an assertion", async () => {
  const fault = await collect(
    'import {test,expect} from "bun:test"; test("fault", () => expect(2).toBe(1));',
  );
  assert.equal(fault.state, "COMPLETED");
  assert.equal(fault.facts.testOutcome, "ASSERTION_FAILURE");
  assert.equal(fault.facts.attributed, true);
  const ordinary = await collect(
    'import {test} from "bun:test"; test("ordinary", () => { throw new Error("expect(received).toBe(expected)"); });',
  );
  assert.equal(ordinary.state, "CRASH");
  assert.equal(ordinary.facts.attributed, false);
});

test("async matcher failures preserve issuing test identity", async () => {
  const result = await collect(
    'import {test,expect} from "bun:test"; test("async", async () => { await expect(Promise.resolve(2)).resolves.toBe(1); });',
  );
  assert.equal(result.facts.testOutcome, "ASSERTION_FAILURE");
  assert.equal(result.facts.attributed, true);
});

test("rethrowing another test's matcher error cannot claim attribution", async () => {
  const result = await collect(
    'import {test,expect} from "bun:test"; let held; test("capture",()=>{try {expect(2).toBe(1);} catch(e){held=e;}}); test("rethrow",()=>{throw held;});',
  );
  assert.equal(result.state, "CRASH");
  assert.equal(result.facts.attributed, false);
});

test("a rejected operand for resolves is not an issued matcher assertion", async () => {
  const result = await collect(
    'import {test,expect} from "bun:test"; test("rejection",async()=>{await expect(Promise.reject(new Error("ordinary"))).resolves.toBe(1);});',
  );
  assert.notEqual(result.facts.testOutcome, "ASSERTION_FAILURE");
  assert.equal(result.facts.attributed, false);
});

test("hooks, collection errors, absence and timeouts cannot detect a fault", async () => {
  for (const source of [
    'import {test,beforeAll,expect} from "bun:test"; beforeAll(() => expect(2).toBe(1)); test("body",()=>{});',
    'import {test} from "bun:test"; throw new Error("collection");',
    "export const empty = true;",
    'import {test} from "bun:test"; test("never",async()=>{await new Promise(()=>{});});',
  ]) {
    const result = await collect(source, ["case.test.ts"], 500);
    assert.notEqual(result.facts.testOutcome, "ASSERTION_FAILURE");
    assert.equal(result.facts.attributed, false);
  }
});

test("candidate-written malformed pipe reports invalidate collection", async () => {
  const result = await collect(
    'import {test,expect} from "bun:test"; import {writeSync} from "node:fs"; test("forge",()=>{writeSync(3,JSON.stringify({event:{kind:"hook-error"},mac:"0".repeat(64)})+"\\n");expect(2).toBe(1);});',
  );
  assert.equal(result.state, "INFRA_ERROR");
  assert.equal(result.facts.attributed, false);
});

test("skip, todo and exclusive selection cannot silently qualify a suite", async () => {
  for (const source of [
    'import {test} from "bun:test"; test.skip("omitted",()=>{}); test("control",()=>{});',
    'import {test} from "bun:test"; test.todo("omitted"); test("control",()=>{});',
    'import {test} from "bun:test"; test("omitted",()=>{}); test.only("control",()=>{});',
  ]) {
    const result = await collect(source);
    assert.notEqual(result.state, "COMPLETED");
    assert.equal(result.facts.attributed, false);
  }
});

test("node:test callback contexts and native assertions are qualified under Bun", async () => {
  const result = await collect(
    'import test from "node:test"; import assert from "node:assert/strict"; import {actual} from "./helper"; for (const expected of [1,2]) { test("row "+expected,(t)=>{t.after(()=>{});assert.equal(actual,expected);}); }',
  );
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.facts.testOutcome, "ASSERTION_FAILURE");
  assert.equal(result.facts.attributed, true);
  assert.equal(result.facts.testsDiscovered, 2);
  const reference = await collect(
    'import test from "node:test"; import assert from "node:assert/strict"; import {actual} from "./helper"; for (const value of [1,2]) { test("row "+value,(t)=>{t.after(()=>{});assert.equal(actual,2);}); }',
  );
  assert.equal(reference.facts.testOutcome, "PASS");
  assert.equal(reference.facts.testsDiscovered, 2);
});

test("node:test after-hook errors and manually constructed AssertionError are not assertions", async () => {
  for (const source of [
    'import test from "node:test"; test("after",(t)=>{t.after(()=>{throw new Error("hook");});});',
    'import test from "node:test"; import assert from "node:assert/strict"; test("fake",()=>{throw new assert.AssertionError({message:"fake"});});',
  ]) {
    const result = await collect(source);
    assert.notEqual(result.facts.testOutcome, "ASSERTION_FAILURE");
    assert.equal(result.facts.attributed, false);
  }
});

test("an empty suite is explicitly no tests", async () => {
  const result = await collect("export const empty = true;");
  assert.equal(result.state, "NO_TESTS");
  assert.equal(result.facts.testsDiscovered, 0);
  assert.equal(result.facts.attributed, false);
});
