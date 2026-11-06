import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { observeLaunch, summarizeSeries } from "../scripts/benchmark-launch-cost.js";

test("launch observations refuse failed children instead of recording performance", async () => {
  await assert.rejects(observeLaunch(process.execPath, ["--eval", "process.exit(3)"]), /exit/);
  await assert.rejects(observeLaunch("assertledger-e1-absent-executable", []), /spawn/);
  await assert.rejects(observeLaunch(process.execPath, ["--eval", "console.log(1)"]), /output/);
  await assert.rejects(observeLaunch(process.execPath, ["--eval", "console.error(1)"]), /output/);
  await assert.rejects(
    observeLaunch(process.execPath, ["--eval", "setTimeout(() => {}, 10000)"], 100),
    /timeout/,
  );
  const observation = await observeLaunch(process.execPath, ["--eval", ""]);
  assert.equal(observation.code, 0);
  assert.equal(observation.signal, null);
  assert.equal(observation.outputBytes, 0);
  assert.ok(observation.elapsedNs > 0);
});

test("summary replays the retained series and rejects incomplete or failed observations", async () => {
  const content = await readFile(
    new URL("../benchmarks/launch-cost/2026-11-06-macos-arm64/samples.jsonl", import.meta.url),
    "utf8",
  );
  const rows = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const summary = summarizeSeries(rows, true);
  assert.equal(summary.rust?.n, 600);
  assert.equal(summary.rust?.median, 2.84675);
  assert.throws(() => summarizeSeries(rows.slice(1), true), /incomplete/);
  assert.throws(() => summarizeSeries([...rows, rows[0]], true), /duplicate/);
  assert.throws(
    () => summarizeSeries([{ ...rows[0], code: 3 }, ...rows.slice(1)], true),
    /invalid observation/,
  );
  assert.throws(
    () => summarizeSeries([{ ...rows[0], elapsedNs: -1 }, ...rows.slice(1)], true),
    /invalid observation/,
  );
  const measured = rows.findIndex((row) => row.phase === "measured");
  const malformed = rows.map((row, index) => (index === measured ? { ...row, i: "0" } : row));
  assert.throws(() => summarizeSeries(malformed, true), /invalid observation/);
});
