import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { runCli, type CliIo } from "../src/cli.js";
import {
  parseRepositoryInitConfig,
  parseRepositoryInitLock,
  parseRepositoryInitResult,
  repositoryInitLockDigest,
  repositoryInitConfigJsonSchema,
  repositoryInitLockJsonSchema,
  repositoryInitResultJsonSchema,
} from "../src/contracts/index.js";
import { initializeRepository } from "../src/engine/index.js";
import { canonicalize } from "../src/core/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const rawDigest = (content: string) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  packageDocument: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-"));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageDocument)}\n`);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  return root;
}

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

const nodePackage = {
  name: "fixture",
  packageManager: "pnpm@10.0.0",
  scripts: { test: "node --test test/*.test.js" },
};

describe("repository init v1", () => {
  it("publishes three strict schemas and fail-closed semantic parsers", async () => {
    for (const schema of [
      repositoryInitConfigJsonSchema(),
      repositoryInitLockJsonSchema(),
      repositoryInitResultJsonSchema(),
    ]) {
      assert.equal(schema.additionalProperties, false);
    }
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const result = await initializeRepository(root, { dryRun: true });
    parseRepositoryInitResult(result);
    const configFile = result.files.find((file) => file.path === "assertledger.config.json");
    const lockFile = result.files.find((file) => file.path === "assertledger.lock.json");
    assert(configFile);
    assert(lockFile);
    const config = JSON.parse(configFile.content);
    const lock = JSON.parse(lockFile.content);
    parseRepositoryInitConfig(config);
    parseRepositoryInitLock(lock);
    assert.throws(
      () => parseRepositoryInitLock({ ...lock, lockDigest: lock.configDigest }),
      /LOCK/u,
    );
    assert.throws(
      () => parseRepositoryInitResult({ ...result, reasonCodes: ["Z", "A"] }),
      /RESULT/u,
    );
  });

  it("detects Node and pnpm, plans exact bytes, writes atomically, then stays byte and mtime stable", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      ".github/workflows/test.yml": "jobs: {}\n",
      "test/base.test.js": "import test from 'node:test';\ntest('x', () => {});\n",
    });
    const dry = await initializeRepository(root, { dryRun: true });
    assert.equal(dry.status, "WOULD_CREATE");
    assert.deepEqual(dry.detections.ciProviders, ["github-actions"]);
    assert.equal(dry.detections.packageManager, "pnpm");
    assert.equal(dry.detections.framework, "node:test");
    await assert.rejects(readFile(path.join(root, "assertledger.config.json")), /ENOENT/u);

    const created = await initializeRepository(root);
    assert.equal(created.status, "CREATED");
    assert.deepEqual(created.files, dry.files);
    for (const planned of dry.files) {
      assert.equal(await readFile(path.join(root, planned.path), "utf8"), planned.content);
    }
    const configPath = path.join(root, "assertledger.config.json");
    const lockPath = path.join(root, "assertledger.lock.json");
    const mtimes = [(await stat(configPath)).mtimeMs, (await stat(lockPath)).mtimeMs];
    const unchanged = await initializeRepository(root);
    assert.equal(unchanged.status, "UNCHANGED");
    assert.deepEqual([(await stat(configPath)).mtimeMs, (await stat(lockPath)).mtimeMs], mtimes);
  });

  it("excludes candidate roots from controls, evidence, inference, and change detection", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
      "tests/candidates/generated.test.js": "import test from 'node:test';\n",
    });
    const created = await initializeRepository(root);
    assert.equal(created.status, "CREATED");
    const config = parseRepositoryInitConfig(
      JSON.parse(await readFile(path.join(root, "assertledger.config.json"), "utf8")),
    );
    const lock = parseRepositoryInitLock(
      JSON.parse(await readFile(path.join(root, "assertledger.lock.json"), "utf8")),
    );
    assert.equal(config.adapter.kind, "node-test");
    if (config.adapter.kind === "node-test") {
      assert.deepEqual(config.adapter.baseTestFiles, ["test/base.test.js"]);
    }
    assert.equal(
      lock.evidence.some((entry) => entry.path.startsWith("tests/candidates/")),
      false,
    );
    await writeFile(
      path.join(root, "tests", "candidates", "generated.test.js"),
      "import { describe } from 'vitest';\n",
    );
    assert.equal((await initializeRepository(root)).status, "UNCHANGED");
  });

  it("binds node-test controls to explicit safe test-command path operands", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
      "examples/other.test.js": "import test from 'node:test';\n",
    });
    const result = await initializeRepository(root, { dryRun: true });
    assert.equal(result.status, "WOULD_CREATE");
    const configFile = result.files.find((file) => file.path === "assertledger.config.json");
    assert(configFile);
    const config = parseRepositoryInitConfig(JSON.parse(configFile.content));
    assert.equal(config.adapter.kind, "node-test");
    if (config.adapter.kind === "node-test") {
      assert.deepEqual(config.adapter.baseTestFiles, ["test/base.test.js"]);
    }

    const unmatched = await fixture(
      { ...nodePackage, scripts: { test: "node --test missing/*.test.js" } },
      {
        "pnpm-lock.yaml": "",
        "test/base.test.js": "import test from 'node:test';\n",
      },
    );
    const blocked = await initializeRepository(unmatched, { dryRun: true });
    assert.equal(blocked.status, "BLOCKED");
    assert.deepEqual(blocked.reasonCodes, ["BASE_TEST_FILES_UNAVAILABLE"]);

    const matcherCases = [
      ["test/exact.test.js", ["test/exact.test.js"]],
      [
        "test",
        [
          "test/exact.test.js",
          "test/nested/deep.test.js",
          "test/unit1.test.js",
          "test/unit12.test.js",
        ],
      ],
      [
        "test/**/*.test.js",
        [
          "test/exact.test.js",
          "test/nested/deep.test.js",
          "test/unit1.test.js",
          "test/unit12.test.js",
        ],
      ],
      ["test/unit?.test.js", ["test/unit1.test.js"]],
    ] as const;
    for (const [operand, expected] of matcherCases) {
      const matcherRoot = await fixture(
        { ...nodePackage, scripts: { test: `node --test ${operand}` } },
        {
          "pnpm-lock.yaml": "",
          "test/exact.test.js": "import test from 'node:test';\n",
          "test/nested/deep.test.js": "import test from 'node:test';\n",
          "test/unit1.test.js": "import test from 'node:test';\n",
          "test/unit12.test.js": "import test from 'node:test';\n",
        },
      );
      const matched = await initializeRepository(matcherRoot, { dryRun: true });
      assert.equal(matched.status, "WOULD_CREATE");
      const matchedConfigFile = matched.files.find(
        (file) => file.path === "assertledger.config.json",
      );
      assert(matchedConfigFile);
      const matchedConfig = parseRepositoryInitConfig(JSON.parse(matchedConfigFile.content));
      assert.equal(matchedConfig.adapter.kind, "node-test");
      if (matchedConfig.adapter.kind === "node-test") {
        assert.deepEqual(matchedConfig.adapter.baseTestFiles, expected);
      }
    }
  });

  it("ignores framework names inside JavaScript comments, strings, and templates", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": [
        "import test from 'node:test';",
        "const selectedModule = 'node:assert/strict';",
        "void import(selectedModule);",
        "// import { describe } from 'vitest';",
        "const fakeVitest = \"import { describe } from 'vitest'\";",
        "const fakeJest = \"require('@jest/globals')\";",
        "const fakeBun = `fixture $" + "{String('value')} import 'bun:test'`;",
        "test('real', () => {});",
        "",
      ].join("\n"),
    });
    const result = await initializeRepository(root, { dryRun: true });
    assert.equal(result.status, "WOULD_CREATE");
    assert.equal(result.detections.framework, "node:test");
  });

  it("detects frameworks through each supported JavaScript module-specifier syntax", async () => {
    const cases = [
      {
        packageDocument: {
          name: "static-from",
          packageManager: "pnpm@10",
          scripts: { test: "framework-runner test/*.test.js" },
        },
        lockfile: "pnpm-lock.yaml",
        source: "import { describe } from 'vitest';\n",
        framework: "vitest",
        status: "BLOCKED",
      },
      {
        packageDocument: {
          name: "side-effect",
          packageManager: "bun@1",
          scripts: { test: "framework-runner test/*.test.js" },
        },
        lockfile: "bun.lock",
        source: "import 'bun:test';\n",
        framework: "bun:test",
        status: "BLOCKED",
      },
      {
        packageDocument: {
          name: "dynamic-import",
          packageManager: "pnpm@10",
          scripts: { test: "framework-runner test/*.test.js" },
        },
        lockfile: "pnpm-lock.yaml",
        source: "void import('@jest/globals');\n",
        framework: "jest",
        status: "BLOCKED",
      },
      {
        packageDocument: {
          name: "require",
          packageManager: "pnpm@10",
          scripts: { test: "framework-runner test/*.test.js" },
        },
        lockfile: "pnpm-lock.yaml",
        source: "require('node:test');\n",
        framework: "node:test",
        status: "WOULD_CREATE",
      },
    ] as const;
    for (const scenario of cases) {
      const root = await fixture(scenario.packageDocument, {
        [scenario.lockfile]: "",
        "test/base.test.js": scenario.source,
      });
      const result = await initializeRepository(root, { dryRun: true });
      assert.equal(result.status, scenario.status, JSON.stringify({ scenario, result }));
      assert.equal(result.detections.framework, scenario.framework);
    }
  });

  it("uses conservative Node discovery when the test command has no path operand", async () => {
    const root = await fixture(
      {
        name: "node-default-discovery",
        packageManager: "pnpm@10",
        scripts: { test: "node --test" },
      },
      {
        "pnpm-lock.yaml": "",
        "test/base.test.js": "import test from 'node:test';\n",
        "other/also.test.js": "import test from 'node:test';\n",
      },
    );
    const result = await initializeRepository(root, { dryRun: true });
    assert.equal(result.status, "WOULD_CREATE");
    const configFile = result.files.find((file) => file.path === "assertledger.config.json");
    assert(configFile);
    const config = parseRepositoryInitConfig(JSON.parse(configFile.content));
    assert.equal(config.adapter.kind, "node-test");
    if (config.adapter.kind === "node-test") {
      assert.deepEqual(config.adapter.baseTestFiles, ["other/also.test.js", "test/base.test.js"]);
    }
  });

  it("binds the real repository controls to its tests glob", async () => {
    const result = await initializeRepository(process.cwd(), { dryRun: true });
    assert.equal(result.status, "WOULD_CREATE");
    const configFile = result.files.find((file) => file.path === "assertledger.config.json");
    assert(configFile);
    const config = parseRepositoryInitConfig(JSON.parse(configFile.content));
    assert.equal(config.adapter.kind, "node-test");
    if (config.adapter.kind === "node-test") {
      assert(config.adapter.baseTestFiles.length > 0);
      assert(config.adapter.baseTestFiles.every((file) => /^tests\/[^/]+\.test\.ts$/u.test(file)));
      assert.equal(
        config.adapter.baseTestFiles.some(
          (file) => file.startsWith("examples/") || file.startsWith("benchmarks/"),
        ),
        false,
      );
    }
  });

  it("exposes init through the provider-neutral SDK and never executes the detected command", async () => {
    const root = await fixture(
      { ...nodePackage, scripts: { test: "definitely-impossible-executable --test" } },
      {
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "test/base.test.js": "import test from 'node:test';\n",
      },
    );
    const result = await new AssertLedger().init(root, {
      testCommand: { executable: "definitely-impossible-executable", arguments: ["--test"] },
    });
    assert.equal(result.status, "CREATED");
  });

  it("detects Bun and pytest but blocks unavailable official adapters without writes", async () => {
    const bun = await fixture(
      { name: "bun", packageManager: "bun@1.2.0", scripts: { test: "bun test" } },
      { "bun.lock": "", "src/a.test.ts": "import { test } from 'bun:test';\n" },
    );
    const python = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-python-"));
    temporaryDirectories.push(python);
    await writeFile(path.join(python, "pyproject.toml"), "[tool.pytest.ini_options]\n[tool.uv]\n");
    await writeFile(path.join(python, "uv.lock"), "version = 1\n");
    await writeFile(path.join(python, "test_app.py"), "def test_app(): assert True\n");
    for (const [root, expected] of [
      [bun, ["bun", "bun:test"]],
      [python, ["uv", "pytest"]],
    ] as const) {
      const result = await initializeRepository(root);
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.detections.packageManager, expected[0]);
      assert.equal(result.detections.framework, expected[1]);
      assert(result.reasonCodes.includes("OFFICIAL_ADAPTER_UNAVAILABLE"));
      await assert.rejects(readFile(path.join(root, "assertledger.config.json")), /ENOENT/u);
    }
  });

  it("allows an explicit operator-owned structured adapter to unblock pytest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-python-adapter-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "requirements.txt"), "pytest==9.0.0\n");
    await writeFile(path.join(root, "test_app.py"), "def test_app(): assert True\n");
    const adapterPath = path.join(root, "adapter.json");
    await writeFile(
      adapterPath,
      JSON.stringify({
        kind: "testforge-command",
        executable: "python",
        arguments: ["adapter.py"],
        protocolVersion: "1.0.0",
      }),
    );
    const result = await initializeRepository(root, { adapterConfigPath: adapterPath });
    assert.equal(result.status, "CREATED");
    assert.equal(result.detections.adapterRecommendation, "operator-supplied");
  });

  it("rejects node-test adapters for every non-node framework in parsers and engine", async () => {
    const nodeRoot = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const dry = await initializeRepository(nodeRoot, { dryRun: true });
    const configFile = dry.files.find((file) => file.path === "assertledger.config.json");
    assert(configFile);
    const config = JSON.parse(configFile.content);
    assert.throws(
      () => parseRepositoryInitConfig({ ...config, framework: "pytest" }),
      /CONFIG_INCONSISTENT/u,
    );

    const pythonRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-node-adapter-"));
    temporaryDirectories.push(pythonRoot);
    await writeFile(path.join(pythonRoot, "requirements.txt"), "pytest==9.0.0\n");
    await writeFile(path.join(pythonRoot, "test_app.py"), "def test_app(): assert True\n");
    await writeFile(
      path.join(pythonRoot, "adapter.json"),
      JSON.stringify({
        kind: "node-test",
        executable: "node",
        baseTestFiles: ["test_app.py"],
      }),
    );
    const result = await initializeRepository(pythonRoot, {
      adapterConfigPath: "adapter.json",
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["ADAPTER_FRAMEWORK_INCOMPATIBLE"]);
    await assert.rejects(readFile(path.join(pythonRoot, "assertledger.config.json")), /ENOENT/u);
  });

  it("requires sorted unique node-test controls disjoint from candidate roots", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const dry = await initializeRepository(root, { dryRun: true });
    const configFile = dry.files.find((file) => file.path === "assertledger.config.json");
    assert(configFile);
    const config = JSON.parse(configFile.content);
    for (const baseTestFiles of [
      ["test/z.test.js", "test/a.test.js"],
      ["test/base.test.js", "test/base.test.js"],
      ["tests/candidates/generated.test.js"],
      ["README.md"],
    ]) {
      assert.throws(
        () =>
          parseRepositoryInitConfig({
            ...config,
            adapter: { ...config.adapter, baseTestFiles },
          }),
        /CONFIG_INCONSISTENT/u,
      );
    }
  });

  it("returns a zero-write conflict when evidence changes after the frozen snapshot", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "before\n",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const result = await initializeRepository(root, {
      afterEvidenceSnapshot: () => writeFile(path.join(root, "pnpm-lock.yaml"), "after\n"),
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["REPOSITORY_CHANGED_DURING_INIT"]);
    await assert.rejects(readFile(path.join(root, "assertledger.config.json")), /ENOENT/u);
  });

  it("fails closed on contradictory managers, multiple frameworks, unsafe scripts, and invalid overrides", async () => {
    const cases: Array<[string, () => Promise<string>, Record<string, unknown> | undefined]> = [
      [
        "manager",
        () => fixture(nodePackage, { "pnpm-lock.yaml": "", "package-lock.json": "{}" }),
        undefined,
      ],
      [
        "framework",
        () =>
          fixture(nodePackage, {
            "pnpm-lock.yaml": "",
            "test/a.test.js": "import test from 'node:test';\nimport { describe } from 'vitest';\n",
          }),
        undefined,
      ],
      [
        "unsafe",
        () =>
          fixture(
            { ...nodePackage, scripts: { test: "node --test && echo owned" } },
            { "pnpm-lock.yaml": "" },
          ),
        undefined,
      ],
      [
        "override",
        () => fixture(nodePackage, { "pnpm-lock.yaml": "" }),
        { packageManager: "cargo" },
      ],
    ];
    for (const [, create, options] of cases) {
      const root = await create();
      const result = await initializeRepository(root, options);
      assert.equal(result.status, "CONFLICT");
      await assert.rejects(readFile(path.join(root, "assertledger.config.json")), /ENOENT/u);
    }
  });

  it("uses an exact framework override to resolve multiple plausible framework facts", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/a.test.js": "import test from 'node:test';\nimport { describe } from 'vitest';\n",
    });
    const result = await initializeRepository(root, { framework: "vitest" });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.detections.framework, "vitest");
    assert(result.reasonCodes.includes("OFFICIAL_ADAPTER_UNAVAILABLE"));
  });

  it("rejects non-portable Windows and Unicode paths at the public config boundary", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const dry = await initializeRepository(root, { dryRun: true });
    const configFile = dry.files.find((file) => file.path === "assertledger.config.json");
    assert(configFile);
    const config = JSON.parse(configFile.content);
    for (const invalid of [
      "file:stream",
      "con.txt",
      "aux",
      "bad<name",
      "trailing.",
      "trailing ",
      "control\u0001name",
      "cafe\u0301",
    ]) {
      assert.throws(
        () =>
          parseRepositoryInitConfig({
            ...config,
            repository: { root: ".", exclude: [invalid] },
          }),
        /CONFIG_INCONSISTENT/u,
        invalid,
      );
    }
  });

  it("requires one canonical next command and legal action/test-command plans", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const result = await initializeRepository(root, { dryRun: true });
    const cases = [
      {
        ...structuredClone(result),
        nextCommands: [
          ...result.nextCommands,
          { executable: "assertledger", arguments: ["analyze", ".", "--json"] },
        ],
      },
      {
        ...structuredClone(result),
        actions: [{ kind: "REGENERATE", path: "assertledger.config.json" }],
      },
      {
        ...structuredClone(result),
        detections: {
          ...result.detections,
          testCommand: { executable: "bad command", arguments: [] },
        },
      },
    ];
    for (const inconsistent of cases) {
      assert.throws(() => parseRepositoryInitResult(inconsistent), /RESULT_INCONSISTENT/u);
    }
  });

  it("preserves conflicting config, recovers a missing lock, regenerates stale same-config lock, and rejects invalid locks", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const created = await initializeRepository(root);
    const configPath = path.join(root, "assertledger.config.json");
    const lockPath = path.join(root, "assertledger.lock.json");
    const configBytes = await readFile(configPath, "utf8");
    await rm(lockPath);
    assert.equal((await initializeRepository(root)).status, "CREATED");
    assert.equal(await readFile(configPath, "utf8"), configBytes);

    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const { lockDigest: _oldDigest, ...staleBase } = { ...lock, evidence: [] };
    const staleLock = { ...staleBase, lockDigest: repositoryInitLockDigest(staleBase) };
    await writeFile(lockPath, `${JSON.stringify(staleLock)}\n`);
    assert.equal((await initializeRepository(root)).status, "CREATED");

    const validBytes = await readFile(lockPath, "utf8");
    const tamperedLock = JSON.parse(validBytes);
    tamperedLock.lockDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const tamperedBytes = `${JSON.stringify(tamperedLock)}\n`;
    await writeFile(lockPath, tamperedBytes);
    const tamperedResult = await initializeRepository(root);
    assert.equal(tamperedResult.status, "CONFLICT");
    assert.deepEqual(tamperedResult.reasonCodes, ["LOCK_INVALID"]);
    assert.equal(await readFile(lockPath, "utf8"), tamperedBytes);

    await writeFile(lockPath, "not-json\n");
    assert.equal((await initializeRepository(root)).status, "CONFLICT");
    assert.equal(await readFile(lockPath, "utf8"), "not-json\n");

    await writeFile(configPath, '{"operator":"owned"}\n');
    assert.equal((await initializeRepository(root)).status, "CONFLICT");
    assert.equal(await readFile(configPath, "utf8"), '{"operator":"owned"}\n');
    assert.equal(created.requiredOperatorInputs.join(","), "worlds,candidates");
  });

  it("implements CLI status codes and structured next commands", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const output = capture(root);
    assert.equal(await runCli(["init", ".", "--dry-run", "--json"], output.io), 0);
    const result = JSON.parse(output.stdout());
    assert.equal(result.status, "WOULD_CREATE");
    assert.deepEqual(result.nextCommands[0], {
      executable: "assertledger",
      arguments: ["audit", ".", "--json"],
    });
    assert.deepEqual(result.requiredOperatorInputs, ["worlds", "candidates"]);

    const blocked = await fixture(
      { name: "bun", packageManager: "bun@1", scripts: { test: "bun test" } },
      { "bun.lock": "", "a.test.ts": "import { test } from 'bun:test';\n" },
    );
    const blockedOutput = capture(blocked);
    assert.equal(await runCli(["init", ".", "--json"], blockedOutput.io), 3);
  });

  it("resolves CLI adapter paths against the repository root when cwd differs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-cli-cwd-"));
    temporaryDirectories.push(cwd);
    const repository = path.join(cwd, "nested", "repository");
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, "requirements.txt"), "pytest==9.0.0\n");
    await writeFile(path.join(repository, "test_app.py"), "def test_app(): assert True\n");
    await writeFile(
      path.join(repository, "adapter.json"),
      JSON.stringify({
        kind: "testforge-command",
        executable: "python",
        arguments: ["adapter.py"],
        protocolVersion: "1.0.0",
      }),
    );
    const output = capture(cwd);
    assert.equal(
      await runCli(["init", repository, "--adapter-config", "adapter.json", "--json"], output.io),
      0,
    );
    assert.equal(JSON.parse(output.stdout()).status, "CREATED");
  });

  it("returns structured conflicts for unsafe command and adapter overrides", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const commandResult = await initializeRepository(root, {
      testCommand: { executable: path.join(root, "runner.exe"), arguments: [] },
    });
    assert.equal(commandResult.status, "CONFLICT");
    assert.deepEqual(commandResult.reasonCodes, ["TEST_COMMAND_INVALID"]);
    const overlongResult = await initializeRepository(root, {
      testCommand: { executable: "node", arguments: ["x".repeat(1_025)] },
    });
    assert.equal(overlongResult.status, "CONFLICT");
    assert.deepEqual(overlongResult.reasonCodes, ["TEST_COMMAND_INVALID"]);

    const pythonRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-absolute-adapter-"));
    temporaryDirectories.push(pythonRoot);
    await writeFile(path.join(pythonRoot, "requirements.txt"), "pytest==9.0.0\n");
    await writeFile(path.join(pythonRoot, "test_app.py"), "def test_app(): assert True\n");
    await writeFile(
      path.join(pythonRoot, "adapter.json"),
      JSON.stringify({
        kind: "testforge-command",
        executable: path.join(pythonRoot, "adapter.exe"),
        arguments: [],
        protocolVersion: "1.0.0",
      }),
    );
    const adapterResult = await initializeRepository(pythonRoot, {
      adapterConfigPath: "adapter.json",
    });
    assert.equal(adapterResult.status, "CONFLICT");
    assert.deepEqual(adapterResult.reasonCodes, ["ADAPTER_CONFIG_INVALID"]);
  });

  it("binds evidence kinds to their portable path category", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const dry = await initializeRepository(root, { dryRun: true });
    const lockFile = dry.files.find((file) => file.path === "assertledger.lock.json");
    assert(lockFile);
    const lock = JSON.parse(lockFile.content);
    lock.evidence = lock.evidence.map((entry: { path: string }) =>
      entry.path === "package.json" ? { ...entry, kind: "TEST_SOURCE" } : entry,
    );
    const { lockDigest: _digest, ...base } = lock;
    lock.lockDigest = repositoryInitLockDigest(base);
    assert.throws(() => parseRepositoryInitLock(lock), /LOCK_INCONSISTENT/u);
  });

  it("binds adapter provenance and node control files through lock and result parsing", async () => {
    const root = await fixture(nodePackage, {
      "pnpm-lock.yaml": "",
      "test/base.test.js": "import test from 'node:test';\n",
    });
    const dry = await initializeRepository(root, { dryRun: true });
    const lockFile = dry.files.find((file) => file.path === "assertledger.lock.json");
    assert(lockFile);
    const originalLock = JSON.parse(lockFile.content);

    for (const mutated of [
      {
        ...structuredClone(originalLock),
        detections: { ...originalLock.detections, adapterRecommendation: "operator-supplied" },
      },
      {
        ...structuredClone(originalLock),
        evidence: [
          ...originalLock.evidence,
          {
            path: "adapter.json",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            kind: "ADAPTER_CONFIG",
          },
        ].sort((left, right) => left.path.localeCompare(right.path)),
      },
    ]) {
      const { lockDigest: _digest, ...base } = mutated;
      mutated.lockDigest = repositoryInitLockDigest(base);
      assert.throws(() => parseRepositoryInitLock(mutated), /LOCK_INCONSISTENT/u);
    }

    const missingControl = structuredClone(originalLock);
    missingControl.evidence = missingControl.evidence.filter(
      (entry: { path: string }) => entry.path !== "test/base.test.js",
    );
    const { lockDigest: _digest, ...missingControlBase } = missingControl;
    missingControl.lockDigest = repositoryInitLockDigest(missingControlBase);
    const missingControlContent = `${canonicalize(missingControl)}\n`;
    const result = structuredClone(dry);
    const resultLock = result.files.find(
      (file: { path: string }) => file.path === "assertledger.lock.json",
    );
    assert(resultLock);
    resultLock.content = missingControlContent;
    resultLock.digest = rawDigest(missingControlContent);
    assert.throws(() => parseRepositoryInitResult(result), /RESULT_INCONSISTENT/u);
  });

  it("packs the built package and initializes a clean consumer through the installed entrypoint", {
    timeout: 120_000,
  }, async () => {
    // The invoking pnpm supplies its actual CLI path on every supported platform.
    // Node 24 no longer bundles Corepack alongside the Node executable.
    const packageManagerCli = process.env.npm_execpath;
    assert(packageManagerCli, "Run this package test through pnpm test or pnpm exec.");
    assert.equal((await stat(packageManagerCli)).isFile(), true);
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-init-package-smoke-"));
    temporaryDirectories.push(root);
    const consumer = path.join(root, "consumer");
    const repository = path.join(root, "repository");
    await mkdir(consumer, { recursive: true });
    await mkdir(path.join(repository, "src"), { recursive: true });
    await mkdir(path.join(repository, "test"), { recursive: true });
    await writeFile(
      path.join(consumer, "package.json"),
      '{"name":"consumer","private":true,"packageManager":"pnpm@11.1.2"}\n',
    );
    await writeFile(path.join(repository, "package.json"), `${JSON.stringify(nodePackage)}\n`);
    await writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(path.join(repository, "src", "value.js"), "export const value = true;\n");
    await writeFile(
      path.join(repository, "test", "base.test.js"),
      "import test from 'node:test';\ntest('base', () => {});\n",
    );
    await execFileAsync(process.execPath, [packageManagerCli, "pack", "--pack-destination", root], {
      cwd: path.resolve("."),
    });
    const tarballName = (await readdir(root)).find((name) => name.endsWith(".tgz"));
    assert(tarballName);
    await execFileAsync(
      process.execPath,
      [packageManagerCli, "add", "--ignore-scripts", path.join(root, tarballName)],
      { cwd: consumer },
    );
    const cli = path.join(consumer, "node_modules", "assertledger", "dist", "cli.js");
    const installedPackageRoot = await realpath(
      path.join(consumer, "node_modules", "assertledger"),
    );
    const installedRuntime = path.join(
      consumer,
      "node_modules",
      "assertledger",
      "dist",
      "engine",
      "adapters",
      "node-test-runtime.js",
    );
    assert.equal((await stat(installedRuntime)).isFile(), true);
    const installedCliRealpath = await realpath(cli);
    const installedRuntimeRealpath = await realpath(installedRuntime);
    assert.deepEqual(
      [installedCliRealpath, installedRuntimeRealpath].map((file) =>
        path.relative(installedPackageRoot, file).replaceAll("\\", "/"),
      ),
      ["dist/cli.js", "dist/engine/adapters/node-test-runtime.js"],
    );
    for (const installedPath of [
      installedPackageRoot,
      installedCliRealpath,
      installedRuntimeRealpath,
    ]) {
      assert.equal(path.relative(repository, installedPath).split(path.sep)[0], "..");
    }
    const { stdout } = await execFileAsync(process.execPath, [cli, "init", repository, "--json"], {
      cwd: consumer,
    });
    assert.equal(JSON.parse(stdout).status, "CREATED");
    parseRepositoryInitConfig(
      JSON.parse(await readFile(path.join(repository, "assertledger.config.json"), "utf8")),
    );
    parseRepositoryInitLock(
      JSON.parse(await readFile(path.join(repository, "assertledger.lock.json"), "utf8")),
    );

    const requestPath = path.join(consumer, "request.json");
    const manifestPath = path.join(consumer, "manifest.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: "1.0.0",
        repository: { root: repository, exclude: ["node_modules", ".git", ".testforge"] },
        adapter: {
          kind: "node-test",
          executable: process.execPath,
          baseTestFiles: ["test/base.test.js"],
        },
        isolation: {
          kind: "trusted-local",
          acknowledgedUnsafeExecution: false,
          environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
        },
        candidateRoots: ["test/candidates"],
        budgets: {
          maximumCandidates: 1,
          maximumWorlds: 3,
          maximumExecutions: 6,
          maximumRepositoryFiles: 1_000,
          maximumRepositoryBytes: 10_000_000,
          maximumWorldOverlayBytes: 10_000,
          maximumCandidateBytes: 10_000,
          maximumTotalCandidateBytes: 10_000,
          timeoutMsPerExecution: 5_000,
          maximumOutputBytes: 65_536,
        },
        policy: {
          policyVersion: "1.0.0",
          requiredAttempts: 1,
          minimumTargetWeightPermille: 1_000,
          maximumSelectedCandidates: 1,
          acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
        },
        worlds: [
          {
            id: "reference",
            kind: "REFERENCE",
            required: true,
            weight: 0,
            provenance: "package-consumer:reference",
            files: [],
          },
          {
            id: "target",
            kind: "TARGET",
            required: true,
            weight: 1,
            provenance: "package-consumer:target",
            files: [{ path: "src/value.js", content: "export const value = false;\n" }],
          },
          {
            id: "neutral",
            kind: "NEUTRAL",
            required: true,
            weight: 0,
            provenance: "package-consumer:neutral",
            files: [],
          },
        ],
        candidates: [
          {
            id: "candidate",
            files: [
              {
                path: "test/candidates/value.test.js",
                content: [
                  'import test from "node:test";',
                  'import assert from "node:assert/strict";',
                  'import { value } from "../../src/value.js";',
                  'test("value", () => assert.equal(value, true));',
                  "",
                ].join("\n"),
              },
            ],
          },
        ],
      }),
    );
    const verified = await execFileAsync(
      process.execPath,
      [cli, "verify", requestPath, "--allow-unsafe-execution", "--json"],
      { cwd: consumer },
    );
    const manifest = JSON.parse(verified.stdout);
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["candidate"]);
    assert.equal(
      manifest.evidenceContext.adapter.configuration.runtimePreflight.protocolVersion,
      "1.0.0",
    );
    await writeFile(manifestPath, JSON.stringify(manifest));
    const replayed = await execFileAsync(
      process.execPath,
      [cli, "replay", manifestPath, "--json"],
      { cwd: consumer },
    );
    assert.deepEqual(JSON.parse(replayed.stdout), {
      valid: true,
      decisionDigestValid: true,
      artifactDigestValid: true,
      decisionSemanticsValid: true,
      schemaValid: true,
    });
  });
});
