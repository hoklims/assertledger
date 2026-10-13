import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publishedSchemas } from "../scripts/schema-registry.js";
import { runProcess } from "../src/engine/index.js";

test("qualification registry publishes all four generated contracts", () => {
  const schemas = new Map(publishedSchemas());
  for (const name of [
    "qualification-plan",
    "qualification-execution-request",
    "qualification-receipt",
    "qualification-replay-result",
  ]) {
    const filename = `${name}.v1.json`;
    const schema = schemas.get(filename);
    assert.ok(schema, `missing published schema: ${filename}`);
    assert.equal(schema.$id, `https://testforge.dev/schemas/${filename}`);
  }
});

test("the real witness runner refuses an interrupted repeated red without a fresh test report", async (context) => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(path.join(repository, ".testforge"), { recursive: true });
  const artifacts = await mkdtemp(path.join(repository, ".testforge", "report-freshness-"));
  const temporaryRoot = path.resolve(os.tmpdir());
  const fixture = await mkdtemp(path.join(temporaryRoot, "al-witness-"));
  try {
    for (const name of [
      ".gitignore",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "tsconfig.build.json",
      "src",
      "scripts",
      "tests",
      "integrations",
      "schemas",
      "conformance",
    ])
      await cp(path.join(repository, name), path.join(fixture, name), { recursive: true });
    await symlink(
      path.join(repository, "node_modules"),
      path.join(fixture, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const enginePath = path.join(fixture, "src/engine/index.ts");
    const engine = await readFile(enginePath, "utf8");
    assert.equal(engine.split("export async function runProcess(").length, 2);
    const interruptedChild = `const fs=require('node:fs'),crypto=require('node:crypto');const target='src/contracts/qualification.ts';console.log('WITNESS_INPUT:'+JSON.stringify({target,digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}));console.error('CONTROLLED_REPORTER_INTERRUPTION');process.exit(1);`;
    await writeFile(
      enginePath,
      engine.replace("export async function runProcess(", "async function actualRunProcess(") +
        `\nlet witnessPhaseCalls=0;\nexport const runProcess: typeof actualRunProcess = async (value) => {\n  witnessPhaseCalls++;\n  if (witnessPhaseCalls===3 && process.env.ASSERTLEDGER_TEST_INTERRUPT_SECOND_RED==='1') {\n    return actualRunProcess({...value as Record<string,unknown>,executable:process.execPath,args:['-e',${JSON.stringify(interruptedChild)}]});\n  }\n  return actualRunProcess(value);\n};\n`,
    );
    const git = (args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          fixture,
          "-c",
          "core.autocrlf=false",
          "-c",
          "user.name=Guillaume Fossier",
          "-c",
          "user.email=g.fossier1@gmail.com",
          ...args,
        ],
        { encoding: "utf8" },
      );
    git(["init", "--quiet"]);
    git(["config", "core.longpaths", "true"]);
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "test fixture"]);
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete environment.NODE_TEST_CONTEXT;
    async function execute(directory: string, interrupt: boolean) {
      return runProcess({
        executable: process.execPath,
        args: [
          path.join(repository, "node_modules/tsx/dist/cli.mjs"),
          path.join(fixture, "scripts/run-qualification-negative-witnesses.ts"),
          directory,
          "--case",
          "unassigned-fault-world",
        ],
        cwd: fixture,
        environment: {
          ...environment,
          ASSERTLEDGER_TEST_INTERRUPT_SECOND_RED: interrupt ? "1" : "0",
        },
        timeoutMs: 60000,
        maximumOutputBytes: 1024 * 1024,
      });
    }
    const healthyDirectory = path.join(artifacts, "healthy");
    const healthy = await execute(healthyDirectory, false);
    await writeFile(path.join(artifacts, "healthy-process.json"), JSON.stringify(healthy, null, 2));
    assert.equal(healthy.exitCode, 0, healthy.stderr.text);
    const normal = JSON.parse(
      await readFile(path.join(healthyDirectory, "unassigned-fault-world.json"), "utf8"),
    );
    assert.deepEqual(
      [
        normal.green.result.exitCode,
        normal.red.result.exitCode,
        normal.repeatedRed.result.exitCode,
        normal.restoredGreen.result.exitCode,
      ],
      [0, 1, 1, 0],
    );
    const interruptedDirectory = path.join(artifacts, "interrupted");
    const interrupted = await execute(interruptedDirectory, true);
    await writeFile(
      path.join(artifacts, "interrupted-process.json"),
      JSON.stringify(interrupted, null, 2),
    );
    const positive = JSON.parse(
      await readFile(
        path.join(interruptedDirectory, "unassigned-fault-world-positive.json"),
        "utf8",
      ),
    );
    const red = JSON.parse(
      await readFile(path.join(interruptedDirectory, "unassigned-fault-world-red-1.json"), "utf8"),
    );
    const repeated = JSON.parse(
      await readFile(path.join(interruptedDirectory, "unassigned-fault-world-red-2.json"), "utf8"),
    );
    context.diagnostic(
      JSON.stringify({
        artifacts,
        healthyExit: healthy.exitCode,
        interruptedExit: interrupted.exitCode,
        positive: positive.classification,
        red: red.classification,
        repeated: repeated.classification,
      }),
    );
    assert.equal(positive.valid, true);
    assert.equal(red.classification, "ATTRIBUTED_ASSERTION_FAILURE");
    assert.equal(repeated.result.exitCode, 1);
    assert.equal(repeated.result.timedOut, false);
    assert.match(repeated.result.stderr.text, /CONTROLLED_REPORTER_INTERRUPTION/u);
    assert.equal(repeated.inputDigests.length, 1);
    assert.notEqual(
      interrupted.exitCode,
      0,
      "the interrupted producer must not borrow the previous assertion report",
    );
    assert.equal(repeated.valid, false);
    assert.equal(repeated.classification, "NOT_ADMISSIBLE");
    assert.deepEqual(repeated.reporter, []);
  } finally {
    assert.ok(fixture.startsWith(temporaryRoot + path.sep));
    await rm(fixture, { recursive: true, force: true });
  }
});
