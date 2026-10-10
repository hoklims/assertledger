import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runProcess } from "../src/engine/index.js";
import { qualificationMechanismDigest } from "../src/engine/qualification.js";
import { NODE_TEST_REPORTER_SOURCE } from "../src/engine/node-test-reporter.js";

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
type Witness = {
  id: string;
  target: string;
  change: (source: string) => string;
  args: string[];
  diagnostic: string;
  companions?: (
    copy: string,
    before: string,
    after: string,
  ) => Promise<Array<{ path: string; before: string; after: string }>>;
  frozen?: boolean;
};
const cases: Witness[] = [
  {
    id: "physical-workspace-attribution",
    target: "src/engine/qualification.ts",
    change: (source: string) =>
      source.replace(
        /const temporary = await realpath\([\s\S]*?\);/u,
        'const temporary = await mkdtemp(path.join(os.tmpdir(), "assertledger-orchestration-"));',
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "node:test qualification preserves suite attribution through a temporary-directory alias",
      "tests/qualification-engine.test.ts",
    ],
    diagnostic: "ERR_ASSERTION",
  },
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
    id: "contradictory-nested-command-report",
    target: "src/core/qualification.ts",
    change: (source: string) =>
      source.replace(
        "(report.exitCode !== exitCode || report.commandOutcome !== commandOutcome)",
        "false",
      ),
    args: [
      "--test",
      "--test-name-pattern",
      "resealed contradictory nested command reports invalidate replay",
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
    args: ["scripts/check-schemas.ts"],
    diagnostic: "STALE_JSON_SCHEMAS",
  },
  {
    id: "frozen-v4-compatibility",
    target: "schemas/evidence-manifest.v4.json",
    change: (source: string) => source.replace('"const": "4.0.0"', '"const": "9.0.0"'),
    args: [],
    diagnostic: "FROZEN_BASE_BYTES_CHANGED",
    frozen: true,
    companions: regenerateFrozenLock,
  },
  {
    id: "frozen-v3-compatibility",
    target: "schemas/evidence-manifest.v3.json",
    change: (source: string) => source.replace('"const": "3.0.0"', '"const": "9.0.0"'),
    args: [],
    diagnostic: "FROZEN_BASE_BYTES_CHANGED",
    frozen: true,
    companions: regenerateFrozenLock,
  },
];
async function regenerateFrozenLock(copy: string, before: string, after: string) {
  const extensionPath = "conformance/schema-extensions.json";
  const lockPath = "scripts/conformance-v1-lock.ts";
  const extensionBefore = await readFile(path.join(copy, extensionPath), "utf8");
  const extensionAfter = extensionBefore.replace(rawDigest(before), rawDigest(after));
  if (extensionBefore === extensionAfter) throw new Error("Frozen schema lock entry missing");
  const lockBefore = await readFile(path.join(copy, lockPath), "utf8");
  const lockAfter = lockBefore.replace(rawDigest(extensionBefore), rawDigest(extensionAfter));
  if (lockBefore === lockAfter) throw new Error("Frozen extension digest missing");
  return [
    { path: extensionPath, before: extensionBefore, after: extensionAfter },
    { path: lockPath, before: lockBefore, after: lockAfter },
  ];
}
const testCase = (
  id: string,
  target: string,
  change: Witness["change"],
  title: string,
  file: string,
): Witness => ({
  id,
  target,
  change,
  args: ["--test", "--test-name-pattern", title, file],
  diagnostic: "ATTRIBUTED_ASSERTION_FAILURE",
});
cases.push(
  testCase(
    "fixture-package-manager-pin",
    "examples/orchestration/workspace/package.json",
    (source) => source.replace("pnpm@12.9.1", "pnpm@12.9.2"),
    "public fixture package manager matches its qualified tool pin",
    "tests/qualification-fixture-integrity.test.ts",
  ),
  testCase(
    "fixture-root-routing-absence",
    "examples/orchestration/workspace/package.json",
    (source) =>
      `${JSON.stringify({ ...JSON.parse(source), scripts: { test: "bun task.mjs fail" } }, null, 2)}\n`,
    "public fixture root manifest has no executable routing keys",
    "tests/qualification-fixture-integrity.test.ts",
  ),
  testCase(
    "fixture-lock-pin-link",
    "examples/orchestration/workspace/pnpm-lock.yaml",
    (source) => source.replace("specifier: 12.9.1", "specifier: 12.9.2"),
    "public fixture lock binds the declared manager and workspace dependency",
    "tests/qualification-fixture-integrity.test.ts",
  ),
  testCase(
    "retained-report-payload",
    "src/core/qualification.ts",
    (source) =>
      source.replace(
        /issues\.push\(`INVALID_STRUCTURED_REPORT:\$\{key\}`\);/u,
        "/* faulty acceptance */",
      ),
    "missing altered and duplicate retained reports invalidate resealed replay",
    "tests/qualification-core.test.ts",
  ),
  testCase(
    "fixture-command-construction",
    "examples/orchestration/workspace/commands.mjs",
    (source) => source.replace('"--filter=@public/app..."', '"--filter=@public/app"'),
    "structured Turbo failure selection",
    "examples/orchestration/workspace/command-shape.test.mjs",
  ),
  testCase(
    "schema-registry-omission",
    "scripts/schema-registry.ts",
    (source) =>
      source.replace('["qualification-plan.v1.json", qualificationPlanJsonSchema()],', ""),
    "qualification registry publishes all four generated contracts",
    "tests/qualification-witness-runner.test.ts",
  ),
  testCase(
    "mcp-registration-omission",
    "src/mcp/index.ts",
    (source) =>
      source.replace(
        '"assertledger_qualification_plan",',
        '"assertledger_qualification_plan_omitted",',
      ),
    "publishes strict output schemas and the exhaustive facade schema names",
    "tests/integration.test.ts",
  ),
  testCase(
    "mcp-schema-enum-omission",
    "src/mcp/index.ts",
    (source) => source.replace('      "qualification-plan",', ""),
    "publishes strict output schemas and the exhaustive facade schema names",
    "tests/integration.test.ts",
  ),
  testCase(
    "init-framework-route",
    "src/engine/index.ts",
    (source) =>
      source.replace(
        '} else if (framework === "node:test") {',
        '} else if (framework === "node:test-disabled") {',
      ),
    "binds the real repository controls to its tests glob",
    "tests/repository-init.test.ts",
  ),
  testCase(
    "native-operational-classification",
    "src/engine/adapters/bun-native.ts",
    (source) => source.replace('PROCESS_CRASH: "CRASH"', 'PROCESS_CRASH: "COMPLETED"'),
    "native matcher failure is attributed while a normal error is never an assertion",
    "tests/bun-native-qualification.test.ts",
  ),
  {
    id: "qualification-lock-entry",
    target: "scripts/qualification-schema-lock.ts",
    change: (source) => source.replace(/sha256:[a-f0-9]{64}/u, `sha256:${"0".repeat(64)}`),
    args: ["scripts/check-conformance-v1.ts"],
    diagnostic: "SCHEMA_RAW_DIGEST_MISMATCH",
  },
);
for (const name of [
  "qualification-execution-request",
  "qualification-receipt",
  "qualification-replay-result",
]) {
  cases.push({
    id: `${name}-regeneration`,
    target: `schemas/${name}.v1.json`,
    change: (source) =>
      name === "qualification-replay-result"
        ? source.replace('"type": "boolean"', '"type": "string"')
        : source.replace('"const": "1.0.0"', '"const": "9.0.0"'),
    args: ["scripts/check-schemas.ts"],
    diagnostic: "STALE_JSON_SCHEMAS",
  });
}
const filterIndex = process.argv.indexOf("--case");
const selected =
  filterIndex < 0
    ? cases
    : cases.filter((witness) => process.argv[filterIndex + 1]?.split(",").includes(witness.id));
if (selected.length === 0) throw new Error("No selected witnesses");
const base = "5a9d0dc4cbb473dbdc524a35251a3fee464e975a";
const records = [];
for (const witness of selected) {
  await mkdir(copies, { recursive: true });
  const copy = await mkdtemp(path.join(copies, `${witness.id}-`));
  const excluded = new Set([".git", ".testforge", ".omx", "node_modules", "dist", "coverage"]);
  for (const entry of await readdir(root)) {
    if (excluded.has(entry)) continue;
    await cp(path.join(root, entry), path.join(copy, entry), { recursive: true });
  }
  await symlink(
    path.join(root, "node_modules"),
    path.join(copy, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const target = path.join(copy, witness.target);
  const before = await readFile(target, "utf8");
  const after = witness.change(before);
  if (before === after) throw new Error(`Witness mutation did not apply: ${witness.id}`);
  const targets = [
    { path: witness.target, before, after },
    ...((await witness.companions?.(copy, before, after)) ?? []),
  ];
  const reporterPath = path.join(output, `${witness.id}-reporter.mjs`);
  const reportPath = path.join(output, `${witness.id}-report.ndjson`);
  // Retain the production assertion taxonomy and additionally retain the actual failing title.
  await writeFile(
    reporterPath,
    NODE_TEST_REPORTER_SOURCE.replace(
      'if (event?.type !== "test:fail") continue;',
      'if (event?.type !== "test:fail" || data?.details?.type === "suite") continue;',
    ).replace(
      "if (!assertion) candidateFailuresAllAssertions = false;",
      'if (!assertion) candidateFailuresAllAssertions = false;\n    yield JSON.stringify({failureName:data.name, assertion, candidateFile}) + "\\n";',
    ),
  );
  const testFile = witness.args.at(-1);
  const isTest = witness.args.includes("--test");
  const commandArgs = isTest
    ? [
        tsx,
        "--test-reporter",
        "tap",
        "--test-reporter-destination",
        "stdout",
        "--test-reporter",
        pathToFileURL(reporterPath).href,
        "--test-reporter-destination",
        reportPath,
        ...witness.args,
      ]
    : [tsx, ...witness.args];
  // This oracle is outside the disposable candidate and reads immutable base Git bytes.
  const frozenBytes = witness.frozen
    ? execFileSync("git", ["show", `${base}:${witness.target}`], { cwd: root })
    : undefined;
  const wrapperPath = path.join(output, `${witness.id}-execute.mjs`);
  await writeFile(
    wrapperPath,
    `import {readFileSync} from "node:fs";\nimport {createHash} from "node:crypto";\nimport {spawnSync} from "node:child_process";\nconst digest = bytes => "sha256:"+createHash("sha256").update(bytes).digest("hex");\nfor(const target of ${JSON.stringify(targets.map((target) => target.path))}) console.log("WITNESS_INPUT:"+JSON.stringify({target,digest:digest(readFileSync(target))}));\n${frozenBytes ? `if (digest(readFileSync(${JSON.stringify(witness.target)})) !== ${JSON.stringify(rawDigest(frozenBytes.toString("utf8")))}) { console.error("FROZEN_BASE_BYTES_CHANGED:${witness.target}"); process.exit(23); }\nconsole.log("FROZEN_BASE_BYTES_UNCHANGED:${witness.target}");` : `const result=spawnSync(${JSON.stringify(process.execPath)},${JSON.stringify(commandArgs)},{stdio:"inherit",env:process.env}); if(result.error) throw result.error; process.exit(result.status ?? 99);`}`,
  );
  const input = {
    executable: process.execPath,
    args: [wrapperPath],
    cwd: copy,
    environment: {
      ...environment,
      TESTFORGE_NODE_CANDIDATE_FILES: JSON.stringify(
        isTest ? [path.join(copy, testFile ?? "")] : [],
      ),
    },
    timeoutMs: 60000,
    maximumOutputBytes: 1024 * 1024,
  };
  async function observe(phase: string, expectRed: boolean) {
    const result = await runProcess(input);
    const diagnostic = `${result.stdout.text}\n${result.stderr.text}`;
    const reporter = isTest
      ? (await readFile(reportPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const summary = reporter.at(-1);
    const designatedPattern = new RegExp(
      witness.args[witness.args.indexOf("--test-name-pattern") + 1] ?? ".*",
    );
    const classified = isTest
      ? summary?.candidateTestsDiscovered > 0 &&
        summary.nonCandidateFailureCount === 0 &&
        summary.candidateFailuresAllAssertions === true &&
        (expectRed
          ? summary.candidateFailureCount > 0 &&
            reporter.some(
              (row) =>
                row.candidateFile && row.assertion && designatedPattern.test(row.failureName ?? ""),
            )
          : summary.candidateFailureCount === 0 && /# pass [1-9][0-9]*/u.test(diagnostic))
      : !expectRed || diagnostic.includes(witness.diagnostic);
    const actualInputs = diagnostic
      .split("\n")
      .filter((line) => line.startsWith("WITNESS_INPUT:"))
      .map((line) => JSON.parse(line.slice("WITNESS_INPUT:".length)));
    const inputsBound =
      actualInputs.length === targets.length &&
      targets.every(
        (item, index) =>
          actualInputs[index]?.target === item.path &&
          actualInputs[index]?.digest ===
            rawDigest(phase.startsWith("red") ? item.after : item.before),
      );
    const valid =
      inputsBound &&
      !result.timedOut &&
      !result.stdout.truncated &&
      !result.stderr.truncated &&
      result.exitCode !== null &&
      (expectRed ? result.exitCode !== 0 : result.exitCode === 0) &&
      classified;
    const observation = {
      phase,
      result,
      reporter,
      valid,
      classification: valid
        ? expectRed
          ? isTest
            ? "ATTRIBUTED_ASSERTION_FAILURE"
            : "EXPLICIT_REFUSAL"
          : "PASS"
        : "NOT_ADMISSIBLE",
      inputDigests: actualInputs,
      claimMarker: valid
        ? `WITNESS_${expectRed ? "RED" : "GREEN"}:${subject}:${witness.id}:${phase}`
        : null,
    };
    await writeFile(
      path.join(output, `${witness.id}-${phase}.json`),
      `${JSON.stringify(observation, null, 2)}\n`,
    );
    if (!valid) throw new Error(`Witness ${phase} was not admissible: ${witness.id}`);
    return observation;
  }
  const green = await observe("positive", false);
  let red: Awaited<ReturnType<typeof observe>>;
  let repeatedRed: Awaited<ReturnType<typeof observe>>;
  try {
    for (const item of targets) await writeFile(path.join(copy, item.path), item.after);
    red = await observe("red-1", true);
    repeatedRed = await observe("red-2", true);
  } finally {
    for (const item of targets) await writeFile(path.join(copy, item.path), item.before);
  }
  const restoredDigests = [];
  for (const item of targets) {
    const restored = await readFile(path.join(copy, item.path), "utf8");
    if (restored !== item.before) throw new Error(`Restoration failed: ${item.path}`);
    restoredDigests.push({ path: item.path, digest: rawDigest(restored) });
  }
  const restoredGreen = await observe("restored", false);
  const record = {
    id: witness.id,
    subject,
    target: witness.target,
    beforeDigest: rawDigest(before),
    afterDigest: rawDigest(after),
    before,
    after,
    targets: targets.map((item) => ({
      ...item,
      beforeDigest: rawDigest(item.before),
      afterDigest: rawDigest(item.after),
    })),
    restoredDigests,
    base: witness.frozen ? base : null,
    command: { executable: process.execPath, arguments: input.args },
    green,
    red,
    repeatedRed,
    restoredGreen,
    toolGap: isTest
      ? "TOOL_GAP:assertledger:typescript-witness-execution:legacy importWitness accepts the frozen Bun helper profile; node+tsx is classified by the production Node reporter, not formal VERIFIED"
      : null,
  };
  records.push(record);
  await writeFile(path.join(output, `${witness.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}
const result = {
  subject,
  mechanismDigest: await qualificationMechanismDigest(),
  status: "NEGATIVE_WITNESSES_VALID",
  witnesses: records.map(
    ({ id, target, beforeDigest, afterDigest, green, red, repeatedRed, restoredGreen }) => ({
      id,
      target,
      beforeDigest,
      afterDigest,
      greenExit: green.result.exitCode,
      redExit: red.result.exitCode,
      repeatedRedExit: repeatedRed.result.exitCode,
      restoredGreenExit: restoredGreen.result.exitCode,
    }),
  ),
};
await writeFile(path.join(output, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
