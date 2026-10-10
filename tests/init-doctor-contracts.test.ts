import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { type CliIo, runCli } from "../src/cli.js";
import { parseVersionedRepositoryInitResult } from "../src/contracts/index.js";
import { explainReasonCodes } from "../src/diagnostics.js";
import { initializeRepository } from "../src/engine/index.js";

function capture(root: string) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd: root,
    readStdin: async () => "",
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

async function fixture(root: string, framework: "node:test" | "bun:test", count: number) {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "inventory-limit-fixture",
      packageManager: framework === "bun:test" ? "bun@1.4.2" : "npm@11.0.0",
      scripts: { test: framework === "bun:test" ? "bun test" : "node --test" },
    }),
  );
  await mkdir(path.join(root, "tests"));
  for (let offset = 0; offset < count; offset += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, count - offset) }, (_, index) =>
        writeFile(
          path.join(root, "tests", `base-${offset + index}.test.ts`),
          `import { test } from ${JSON.stringify(framework)}; test("base", () => {});\n`,
        ),
      ),
    );
  }
}

for (const framework of ["node:test", "bun:test"] as const) {
  it(`returns structured conflicts for 1,001 ${framework} base tests without truncating or writing`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-limit-"));
    try {
      await fixture(root, framework, 1_001);
      for (const argv of [
        ["doctor", root, "--framework", framework, "--json"],
        ["init", root, "--framework", framework, "--dry-run", "--json"],
        ["init", root, "--framework", framework, "--json"],
      ]) {
        await context.test(
          `${argv[0]}${argv.includes("--dry-run") ? " --dry-run" : ""}`,
          async () => {
            const output = capture(root);
            assert.equal(await runCli(argv, output.io), 4);
            assert.notEqual(output.stdout(), "", output.stderr());
            assert.equal(output.stderr(), "");
            const result = parseVersionedRepositoryInitResult(JSON.parse(output.stdout()));
            assert.equal(result.status, "CONFLICT");
            assert.deepEqual(result.reasonCodes, ["BASE_TEST_FILES_LIMIT_EXCEEDED"]);
            assert.equal(result.detections.framework, framework);
            assert.deepEqual(result.files, []);
            assert.deepEqual(result.actions, []);
            assert.deepEqual(result.nextCommands, [
              { executable: "assertledger", arguments: ["audit", ".", "--json"] },
            ]);
          },
        );
      }
      assert.deepEqual((await readdir(root)).sort(), ["package.json", "tests"]);

      // The limit remains exactly 1,000; a refusal never silently samples the inventory.
      await rm(path.join(root, "tests", "base-1000.test.ts"));
      const plan = await initializeRepository(root, { dryRun: true, framework });
      assert.equal(plan.status, "WOULD_CREATE");
      const config = JSON.parse(
        plan.files.find((file) => file.path === "assertledger.config.json")?.content ?? "null",
      ) as { adapter: { baseTestFiles: string[] } };
      assert.equal(config.adapter.baseTestFiles.length, 1_000);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

it("returns a structured conflict when an inventory evidence path exceeds its schema limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-path-limit-"));
  try {
    await fixture(root, "node:test", 1);
    const relative = `${Array.from({ length: 7 }, (_, i) => `${i}-${"x".repeat(150)}`).join("/")}/test_extra.py`;
    assert(relative.length > 1_024);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), "");
    for (const command of ["doctor", "init"] as const) {
      const output = capture(root);
      assert.equal(
        await runCli([command, root, "--framework", "node:test", "--json"], output.io),
        4,
      );
      assert.notEqual(output.stdout(), "", output.stderr());
      const result = parseVersionedRepositoryInitResult(JSON.parse(output.stdout()));
      assert.equal(result.status, "CONFLICT");
      assert.deepEqual(result.reasonCodes, ["INIT_EVIDENCE_PATH_LIMIT_EXCEEDED"]);
      assert.equal(output.stderr(), "");
    }
    assert(!(await readdir(root)).includes("assertledger.config.json"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it("returns a structured conflict when the canonical inventory lock exceeds the planned-file limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-content-limit-"));
  try {
    await fixture(root, "node:test", 1);
    const relativeDirectory = `.github/workflows/${Array.from({ length: 5 }, (_, i) => `${i}-${"x".repeat(188)}`).join("/")}`;
    await mkdir(path.join(root, relativeDirectory), { recursive: true });
    for (let offset = 0; offset < 16_000; offset += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          writeFile(path.join(root, relativeDirectory, `ci-${offset + i}.yml`), ""),
        ),
      );
    }
    const output = capture(root);
    assert.equal(await runCli(["init", root, "--dry-run", "--json"], output.io), 4);
    assert.notEqual(output.stdout(), "", output.stderr());
    const result = parseVersionedRepositoryInitResult(JSON.parse(output.stdout()));
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["INIT_FILE_CONTENT_LIMIT_EXCEEDED"]);
    assert.equal(output.stderr(), "");
    assert(!(await readdir(root)).includes("assertledger.config.json"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const INIT_CODES = [
  "ADAPTER_CONFIG_INVALID",
  "ADAPTER_FRAMEWORK_INCOMPATIBLE",
  "BASE_TEST_FILES_LIMIT_EXCEEDED",
  "BASE_TEST_FILES_UNAVAILABLE",
  "CONFIG_CONFLICT",
  "FRAMEWORK_AMBIGUOUS",
  "FRAMEWORK_OVERRIDE_INVALID",
  "FRAMEWORK_UNDETECTED",
  "INIT_EVIDENCE_PATH_LIMIT_EXCEEDED",
  "INIT_EVIDENCE_SNAPSHOT_INCONSISTENT",
  "INIT_FILE_CONTENT_LIMIT_EXCEEDED",
  "INIT_MANAGED_PATH_UNSAFE",
  "INIT_PLAN_INCONSISTENT",
  "INIT_WRITE_FAILED",
  "INVALID_REPOSITORY_EXCLUDE",
  "LOCK_CONFIG_MISMATCH",
  "LOCK_INVALID",
  "OFFICIAL_ADAPTER_UNAVAILABLE",
  "PACKAGE_MANAGER_AMBIGUOUS",
  "PACKAGE_MANAGER_INVALID",
  "PACKAGE_MANAGER_OVERRIDE_INVALID",
  "PACKAGE_MANAGER_UNDETECTED",
  "PACKAGE_MANIFEST_INVALID",
  "PORTABLE_PATH_COLLISION",
  "REPOSITORY_CHANGED_DURING_INIT",
  "REPOSITORY_INIT_CANONICAL_INVALID",
  "REPOSITORY_INIT_CONFIG_INCONSISTENT",
  "REPOSITORY_INIT_CONFIG_INVALID",
  "REPOSITORY_INIT_LOCK_INCONSISTENT",
  "REPOSITORY_INIT_LOCK_INVALID",
  "REPOSITORY_INIT_RESULT_INCONSISTENT",
  "REPOSITORY_INIT_RESULT_INVALID",
  "REPOSITORY_LINK_ESCAPES_ROOT",
  "REPOSITORY_LINK_IN_TEST_CLOSURE",
  "REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE",
  "REPOSITORY_ROOT_INVALID",
  "TEST_CLOSURE_UNBOUNDED",
  "TEST_COMMAND_INVALID",
  "TEST_COMMAND_UNSAFE_OR_AMBIGUOUS",
  "UNSUPPORTED_REPOSITORY_SYMLINK",
];

it("explains every static doctor/init reason and contract error with a next action", async () => {
  const report = explainReasonCodes(INIT_CODES);
  assert.deepEqual(
    report.diagnostics
      .filter((diagnostic) => !diagnostic.known)
      .map((diagnostic) => diagnostic.code),
    [],
  );
  for (const diagnostic of report.diagnostics) {
    assert(diagnostic.explanation.length > 0, diagnostic.code);
    assert(diagnostic.nextAction.length > 0, diagnostic.code);
  }
  const ambiguous = report.diagnostics.find(
    (diagnostic) => diagnostic.code === "FRAMEWORK_AMBIGUOUS",
  );
  assert.match(ambiguous?.explanation ?? "", /multiple.*frameworks/iu);
  assert.match(ambiguous?.nextAction ?? "", /--framework/u);

  const output = capture(process.cwd());
  assert.equal(await runCli(["explain", ...INIT_CODES, "--json"], output.io), 0);
  assert.deepEqual(JSON.parse(output.stdout()), report);
});

it("keeps the catalogue coverage list complete for initialization source codes", async () => {
  const engine = await readFile(new URL("../src/engine/index.ts", import.meta.url), "utf8");
  const init = engine.slice(
    engine.indexOf("export async function initializeRepository("),
    engine.indexOf("async function probeRuntimeTemporaryWorkspace("),
  );
  const internal = new Set([
    "CONFLICT",
    "BLOCKED",
    "UNCHANGED",
    "WOULD_CREATE",
    "CREATED",
    "ABSENT",
    "FILE",
    "UNSAFE",
    "ENOENT",
    "ADAPTER_CONFIG",
    "TEST_SOURCE",
    "CREATE",
    "REGENERATE",
    "REPOSITORY_ROOT_NOT_DIRECTORY",
    "ADAPTER_CONFIG_OUTSIDE_REPOSITORY",
    "TEST_CLOSURE_UNSUPPORTED",
  ]);
  const emitted = [
    ...new Set([...init.matchAll(/"([A-Z][A-Z0-9_]+)"/gu)].map((match) => match[1] as string)),
  ].filter((code) => !internal.has(code));
  assert.deepEqual(
    emitted.filter((code) => !INIT_CODES.includes(code)),
    [],
  );
});
