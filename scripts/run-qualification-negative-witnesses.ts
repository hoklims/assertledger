import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runProcess } from "../src/engine/index.js";
import { qualificationMechanismDigest } from "../src/engine/qualification.js";

// Separate copies execute semantic mutants. Neither the frozen candidate nor its tests are edited.
const root = process.cwd();
const output = process.argv[2];
if (output === undefined || !path.isAbsolute(output))
  throw new Error("Absolute output path required");
const subject = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "") {
  throw new Error("Negative witnesses require a frozen clean candidate");
}
const copies = path.join(root, ".testforge", "qualification-witnesses", subject);
await mkdir(output, { recursive: true });
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const rawDigest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const cases = [
  {
    id: "unassigned-fault-world",
    target: "src/contracts/qualification.ts",
    change: (source: string) =>
      source.replace(
        /if \(world\.kind === "TARGET" && world\.discriminants\.length === 0\)\s*throw new Error\("Target world requires a discriminant"\);/u,
        "",
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "an additional unassigned target cannot disappear from admission",
      "tests/qualification-core.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "numeric-command-failure-admission",
    target: "src/core/qualification.ts",
    change: (source: string) =>
      source.replace('observation.facts.commandOutcome !== "EXPECTED_FAILURE"', "false"),
    args: [
      "--test",
      "--test-name-pattern",
      "ordinary nonzero command results cannot qualify baseline or target evidence",
      "tests/qualification-core.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "contradictory-command-facts",
    target: "src/core/qualification.ts",
    change: (source: string) =>
      source.replace('Object.hasOwn(observation.facts, "commandOutcome")', "false"),
    args: [
      "--test",
      "--test-name-pattern",
      "contradictory command completion facts reject resealed evidence",
      "tests/qualification-core.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "command-completion-collection",
    target: "src/engine/qualification.ts",
    change: (source: string) =>
      source.replace(/\|\|\s*\(action\.adapter === "command" && facts\.exitCode !== 0\)/u, ""),
    args: [
      "--test",
      "--test-name-pattern",
      "nonzero ordinary-error|nonzero compilation|nonzero nested-missing",
      "tests/qualification-command-ci.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "turbo-operational-failure",
    target: "src/engine/qualification.ts",
    change: (source: string) =>
      source.replace(
        /(\/\/ This adapter currently supports successful Turbo completion only\.\s*)if \(processResult\.exitCode !== 0\) state = "COLLECTION_ERROR";/u,
        "$1",
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "numeric Turbo failure with a summary but no qualified completion stays operational",
      "tests/qualification-command-ci.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "ci-execution-conditions",
    target: "src/engine/qualification.ts",
    change: (source: string) =>
      source.replace(
        '{ ...rest, condition: value.condition ?? null, trigger: value.trigger ?? "automatic" }',
        '{ ...rest, condition: null, trigger: "automatic" }',
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "real CI parser detects conditional and manual gates",
      "tests/qualification-command-ci.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "operational-and-suite-admission",
    target: "src/core/qualification.ts",
    change: (source: string) =>
      source.replaceAll(
        'status: rejected ? "REJECTED" : reasons.length > 0 ? "OPEN" : "COVERED"',
        'status: "COVERED"',
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "target TIMEOUT|unobserved file|trusted CI admission",
      "tests/qualification-core.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "bun-per-test-timeout",
    target: "integrations/bun-native/driver.mjs",
    change: (source: string) =>
      source.replace(
        'if (junit.timeouts > 0) return infrastructureFailure("BUN_TEST_TIMEOUT");',
        "",
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "Bun per-test timeout preceding a late matcher failure cannot earn detection",
      "tests/bun-native-qualification.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "matcher-getter-crash",
    target: "integrations/bun-native/preload.mjs",
    change: (source: string) =>
      source.replace(
        "function passive(value, seen = new WeakSet(), depth = 0) {",
        "function passive(value, seen = new WeakSet(), depth = 0) { return;",
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "active getters throwing ordinary errors",
      "tests/bun-native-qualification.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
  {
    id: "new-schema-lock",
    target: "schemas/qualification-plan.v1.json",
    change: (source: string) => source.replace('"const": "1.0.0"', '"const": "9.0.0"'),
    args: ["scripts/check-conformance-v1.ts"],
    diagnostic: "SCHEMA_RAW_DIGEST_MISMATCH",
  },
  {
    id: "frozen-v4-compatibility",
    target: "schemas/evidence-manifest.v4.json",
    change: (source: string) => source.replace('"const": "4.0.0"', '"const": "9.0.0"'),
    args: ["scripts/check-conformance-v1.ts"],
    diagnostic: "SCHEMA_RAW_DIGEST_MISMATCH",
  },
  {
    id: "frozen-v3-compatibility",
    target: "schemas/evidence-manifest.v3.json",
    change: (source: string) => source.replace('"const": "3.0.0"', '"const": "9.0.0"'),
    args: ["scripts/check-conformance-v1.ts"],
    diagnostic: "SCHEMA_RAW_DIGEST_MISMATCH",
  },
] as const;
const records = [];
for (const witness of cases) {
  const copy = path.join(copies, witness.id);
  await mkdir(copy, { recursive: true });
  const excluded = new Set([".git", ".testforge", ".omx", "node_modules", "dist", "coverage"]);
  for (const entry of await readdir(root)) {
    if (excluded.has(entry)) continue;
    await cp(path.join(root, entry), path.join(copy, entry), { recursive: true });
  }
  const target = path.join(copy, witness.target);
  const before = await readFile(target, "utf8");
  const after = witness.change(before);
  if (before === after) throw new Error(`Witness mutation did not apply: ${witness.id}`);
  const input = {
    executable: process.execPath,
    args: [tsx, ...witness.args],
    cwd: copy,
    environment,
    timeoutMs: 60000,
    maximumOutputBytes: 1024 * 1024,
  };
  const green = await runProcess(input);
  if (green.exitCode !== 0 || green.timedOut)
    throw new Error(`Witness baseline failed: ${witness.id}`);
  await writeFile(target, after);
  const red = await runProcess(input);
  const diagnostic = `${red.stdout.text}\n${red.stderr.text}`;
  if (
    red.exitCode === null ||
    red.exitCode === 0 ||
    red.timedOut ||
    !diagnostic.includes(witness.diagnostic)
  )
    throw new Error(`Witness was not a semantic rejection: ${witness.id}`);
  const record = {
    id: witness.id,
    subject,
    target: witness.target,
    beforeDigest: rawDigest(before),
    afterDigest: rawDigest(after),
    before,
    after,
    command: { executable: process.execPath, arguments: input.args },
    green,
    red,
  };
  records.push(record);
  await writeFile(path.join(output, `${witness.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
const result = {
  subject,
  mechanismDigest: await qualificationMechanismDigest(),
  status: "NEGATIVE_WITNESSES_VALID",
  witnesses: records.map(({ id, target, beforeDigest, afterDigest, green, red }) => ({
    id,
    target,
    beforeDigest,
    afterDigest,
    greenExit: green.exitCode,
    redExit: red.exitCode,
  })),
};
await writeFile(path.join(output, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
