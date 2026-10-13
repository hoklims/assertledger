import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    assert.ok(argument.startsWith("--") && separator > 2, "Use --name=absolute-path");
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }),
);
const required = (name: string) => {
  const value = args[name];
  assert.ok(value && path.isAbsolute(value), `--${name}=absolute-path is required`);
  return value;
};
const turbo = required("turbo");
const bun = required("bun");
const pnpm = required("pnpm");
const output = required("output");
const repository = fileURLToPath(new URL("../", import.meta.url));
const outputRelative = path.relative(repository, output);
assert.ok(
  outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative),
  "Witness output must be outside the repository",
);
const source = fileURLToPath(new URL("../examples/orchestration/workspace/", import.meta.url));
const environment = {
  ...process.env,
  PATH: `${path.dirname(bun)}${path.delimiter}${path.dirname(pnpm)}${path.delimiter}${process.env.PATH ?? ""}`,
  PUBLIC_TURBO_EXECUTABLE: turbo,
};
for (const [executable, version] of [
  [turbo, "2.11.7"],
  [bun, "1.4.2"],
  [pnpm, "12.9.1"],
] as const) {
  const probe = spawnSync(executable, ["--version"], {
    cwd: source,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), version);
}
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "qualification-empty-selection-witness-"));
try {
  for (const [id, emptySelection, expectedExit] of [
    ["reference", false, 7],
    ["empty-selection", true, 0],
  ] as const) {
    const root = path.join(temporary, id);
    await cp(source, root, { recursive: true });
    await writeFile(path.join(root, "faults.json"), JSON.stringify({ emptySelection }));
    const install = spawnSync(
      pnpm,
      ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"],
      { cwd: root, env: environment, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(install.status, 0, install.stderr);
    const control = path.join(temporary, `${id}-control`);
    await mkdir(control);
    const nonce = randomUUID();
    const trace = path.join(control, "trace.jsonl");
    const report = path.join(control, "result.json");
    await writeFile(trace, "");
    const result = spawnSync(bun, ["wrapper.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...environment,
        ASSERTLEDGER_QUALIFICATION_NONCE: nonce,
        ASSERTLEDGER_QUALIFICATION_TRACE: trace,
        ASSERTLEDGER_QUALIFICATION_RESULT_FILE: report,
        ASSERTLEDGER_QUALIFICATION_CACHE: path.join(control, "cache"),
      },
    });
    const events = (await readFile(trace, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    let completion = null;
    try {
      completion = JSON.parse(await readFile(report, "utf8"));
    } catch {
      /* Retain missing completion in RED diagnostics. */
    }
    const runs = path.join(root, ".turbo", "runs");
    let selectedTasks: string[] | null = null;
    try {
      const summaries = (await readdir(runs)).filter((file) => file.endsWith(".json"));
      assert.equal(summaries.length, 1);
      const summary = JSON.parse(await readFile(path.join(runs, summaries[0] ?? ""), "utf8"));
      selectedTasks = summary.tasks.map((task: { taskId: string }) => task.taskId).sort();
    } catch {
      /* A rejected filter need not produce a normal summary. */
    }
    await writeFile(
      path.join(output, `${id}.json`),
      `${JSON.stringify({ exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr, nonce, completion, events, selectedTasks }, null, 2)}\n`,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit, result.stderr);
    assert.ok(completion);
    assert.equal(completion.nonce, nonce);
    assert.equal(completion.facts.exitCode, expectedExit);
    assert.equal(completion.facts.commandOutcome, emptySelection ? "PASS" : "EXPECTED_FAILURE");
    assert.ok(events.every((event) => event.nonce === nonce));
    const leaf = events.filter((event) => event.task === "@public/leaf#fail");
    assert.equal(leaf.length, emptySelection ? 0 : 2);
    if (emptySelection) {
      assert.deepEqual(selectedTasks, []);
      assert.deepEqual(
        events.map((event) => `${event.task}:${event.event}`),
        [
          "terminal:start",
          "orchestrator:start",
          "mandatory-stage:start",
          "mandatory-stage:finish",
          "orchestrator:finish",
          "terminal:finish",
        ],
      );
    }
    console.log(
      `${id}: exit=${expectedExit}, selected=${JSON.stringify(selectedTasks)}, leafEvents=${leaf.length}, freshCompletion=true`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
