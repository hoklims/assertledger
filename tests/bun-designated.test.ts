import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type BunDesignatedEvent,
  classifyBunDesignatedLoad,
  classifyBunDesignatedRun,
  designatedBunConfig,
} from "../integrations/bun/driver.mjs";
import { runCli } from "../src/cli.js";
import { parseEvidenceManifestV4 } from "../src/contracts/index.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import { verifyCampaign } from "../src/engine/index.js";
import {
  type DesignatedCampaignOptions,
  designatedCampaign,
  designatedRepository,
  FAULT,
  KEEPS_DOCS,
  OVERRUNS_UNDER_FAULT,
  TEST_SOURCE,
  writeTree,
} from "./support/designated-campaign.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driver = path.join(repositoryRoot, "integrations", "bun", "driver.mjs");
const helper = path.join(repositoryRoot, "integrations", "bun", "assertions.mjs");
const requestedBun = process.env.ASSERTLEDGER_BUN_EXECUTABLE ?? "bun";
const bunProbe = spawnSync(requestedBun, ["-e", "console.log(process.execPath)"], {
  encoding: "utf8",
  shell: false,
});
if (bunProbe.status !== 0 || !path.isAbsolute(bunProbe.stdout.trim())) {
  throw new Error("BUN_TEST_EXECUTABLE_PROBE_FAILED");
}
const bun = bunProbe.stdout.trim();
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

const found = (designated = true): BunDesignatedEvent => ({
  kind: "found",
  id: "t",
  file: "a.test.ts",
  designated,
});
const end = (status: "pass" | "fail", owned = false): BunDesignatedEvent => ({
  kind: "end",
  id: "t",
  status,
  owned,
});

describe("designated Bun classification", () => {
  it("credits only the owned failure of the one designated test", () => {
    assert.equal(
      classifyBunDesignatedRun(
        [found(), end("fail", true)],
        { tests: 2, failures: 1, skipped: 1 },
        1,
        false,
      ).outcome,
      "ASSERTION_FAILURE",
    );
    assert.equal(
      classifyBunDesignatedRun(
        [found(), end("fail", false)],
        { tests: 2, failures: 1, skipped: 1 },
        1,
        false,
      ).outcome,
      "PROCESS_CRASH",
    );
    assert.equal(
      classifyBunDesignatedRun(
        [found(false), end("fail", true)],
        { tests: 1, failures: 1, skipped: 0 },
        1,
        false,
      ).outcome,
      "INFRA_ERROR",
    );
  });

  it("never credits a test Bun timed out, even when its callback later failed a matcher", () => {
    const result = classifyBunDesignatedRun(
      [found(), end("fail", true)],
      { tests: 1, failures: 1, skipped: 0, timeouts: 1 },
      1,
      false,
    );
    assert.equal(result.outcome, "INFRA_ERROR");
    assert.equal(result.attributed, false);
  });

  it("reports a missing designated test as discovery, never as a failure", () => {
    assert.equal(
      classifyBunDesignatedRun([], { tests: 3, failures: 0, skipped: 3 }, 1, false).outcome,
      "NO_TEST_DISCOVERED",
    );
    assert.equal(
      classifyBunDesignatedLoad(
        [{ kind: "registered", designated: -1, file: "a.test.ts" }],
        undefined,
        1,
        0,
        false,
      ).outcome,
      "NO_TEST_DISCOVERED",
    );
    assert.equal(
      classifyBunDesignatedLoad(
        [{ kind: "registered", designated: 0, file: "a.test.ts" }],
        undefined,
        1,
        0,
        false,
      ).outcome,
      "PASS",
    );
    assert.equal(
      classifyBunDesignatedLoad(
        [{ kind: "registered", designated: 0, file: "a.test.ts" }],
        undefined,
        1,
        1,
        false,
      ).outcome,
      "INFRA_ERROR",
    );
  });
});

async function runDriver(
  files: Record<string, string>,
  selection: Record<string, unknown>,
  testFiles: readonly string[] = ["tools/a.test.ts"],
): Promise<{ outcome: string; attributed: boolean; testsDiscovered: number }> {
  const root = await temporaryDirectory("assertledger-designated-driver-");
  await writeTree(root, { "package.json": '{"type":"module"}\n', ...files });
  const result = spawnSync(process.execPath, [driver, bun, helper, ...testFiles], {
    cwd: root,
    env: { ...process.env, ASSERTLEDGER_BUN_DESIGNATED: JSON.stringify(selection) },
    encoding: "utf8",
    timeout: 60_000,
  });
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
    outcome: string;
    attributed: boolean;
    testsDiscovered: number;
  };
}

const execution = { workingDirectory: ".", isolate: false, trustedMatchers: [] };

const run = (expectedFailure: string | null = null, testTimeoutMs: number | null = null) => ({
  mode: "run",
  test: { file: "tools/a.test.ts", path: ["gate routing", "keeps docs"] },
  expectedFailure,
  testTimeoutMs,
  ...execution,
});

describe("designated Bun driver", () => {
  it("runs one named test and classifies its matcher failure with the expected line", async () => {
    const red = {
      "tools/a.test.ts": TEST_SOURCE(KEEPS_DOCS),
      "src/names.ts": 'export const names = () => ["a"];\n',
    };
    assert.deepEqual(await runDriver(red, run("error: expect(received).toContain(expected)")), {
      protocolVersion: "1.0.0",
      outcome: "ASSERTION_FAILURE",
      testsDiscovered: 1,
      candidateTestsDiscovered: 1,
      attributed: true,
    });
    assert.equal(
      (await runDriver(red, run("expect(received).toBe(expected)"))).outcome,
      "PROCESS_CRASH",
    );
    const green = { ...red, "src/names.ts": 'export const names = () => ["docs"];\n' };
    assert.equal((await runDriver(green, run())).outcome, "PASS");
  });

  it("never turns a missing test, a forged message or a broken import into an assertion", async () => {
    const names = { "src/names.ts": 'export const names = () => ["a"];\n' };
    const absent = {
      ...run(),
      test: { file: "tools/a.test.ts", path: ["gate routing", "absent"] },
    };
    assert.equal(
      (await runDriver({ "tools/a.test.ts": TEST_SOURCE(KEEPS_DOCS), ...names }, absent)).outcome,
      "NO_TEST_DISCOVERED",
    );
    const forged = TEST_SOURCE(
      '() => { throw new Error("expect(received).toContain(expected)"); }',
    );
    assert.equal(
      (await runDriver({ "tools/a.test.ts": forged, ...names }, run())).outcome,
      "PROCESS_CRASH",
    );
    const broken = {
      "tools/a.test.ts": TEST_SOURCE(KEEPS_DOCS),
      "src/names.ts": 'import "./missing";\nexport const names = () => [];\n',
    };
    const brokenRun = await runDriver(broken, run());
    assert.notEqual(brokenRun.outcome, "ASSERTION_FAILURE");
    assert.equal(brokenRun.attributed, false);
  });

  it("never credits a synchronous test that overran the declared per-test timeout", async () => {
    const busy = TEST_SOURCE(
      '() => { const stop = Date.now() + 400; while (Date.now() < stop); expect(names()).toContain("docs"); }',
    );
    const result = await runDriver(
      { "tools/a.test.ts": busy, "src/names.ts": 'export const names = () => ["a"];\n' },
      run(null, 50),
    );
    assert.equal(result.outcome, "INFRA_ERROR");
    assert.equal(result.attributed, false);
  });

  it("refuses a selection that omits where and how Bun runs", async () => {
    const { workingDirectory: _directory, ...withoutDirectory } = run();
    const names = { "src/names.ts": 'export const names = () => ["a"];\n' };
    assert.equal(
      (await runDriver({ "tools/a.test.ts": TEST_SOURCE(KEEPS_DOCS), ...names }, withoutDirectory))
        .outcome,
      "INFRA_ERROR",
    );
  });
});

/** A package whose bunfig preload extends expect, as a Modelo package's test setup does. */
const PACKAGE_FILES = {
  "pkg/package.json": '{"name":"pkg","type":"module"}\n',
  "pkg/bunfig.toml":
    '[test]\npreload = ["./setup.ts"] # package setup\ncoverageSkipTestFiles = true\n',
  "pkg/setup.ts": [
    'import { expect } from "vitest";',
    "(globalThis as Record<string, unknown>).packageSetup = true;",
    "expect.extend({",
    '  toEqual() { return { pass: false, message: () => "replaced" }; },',
    '  toFailExtended() { return { pass: false, message: () => "extended" }; },',
    "});",
    "",
  ].join("\n"),
  "pkg/src/a.spec.ts": [
    'import { describe, expect, it } from "vitest";',
    'describe("package", () => {',
    '  it("sees its setup", () => { expect((globalThis as Record<string, unknown>).packageSetup).toBe(true); });',
    '  it("uses a replaced matcher", () => { expect(1).toEqual(1); });',
    '  it("uses an extended matcher", () => { (expect(1) as unknown as { toFailExtended(): void }).toFailExtended(); });',
    "});",
    "",
  ].join("\n"),
  "pkg/src/b.spec.ts": 'import { it } from "vitest";\nit("second", () => {});\n',
};

const packageRun = (name: string, overrides: Record<string, unknown> = {}) => ({
  mode: "run",
  test: { file: "pkg/src/a.spec.ts", path: ["package", name] },
  expectedFailure: null,
  testTimeoutMs: null,
  workingDirectory: "pkg",
  isolate: true,
  trustedMatchers: [],
  ...overrides,
});

describe("designated Bun driver in a package", () => {
  it("runs Bun in the declared directory with its own bunfig preloads", async () => {
    const files = ["pkg/src/a.spec.ts"];
    assert.equal(
      (await runDriver(PACKAGE_FILES, packageRun("sees its setup"), files)).outcome,
      "PASS",
    );
    // From the root the package preload never runs: the same test fails its built-in matcher.
    assert.equal(
      (
        await runDriver(
          PACKAGE_FILES,
          packageRun("sees its setup", { workingDirectory: ".", isolate: false }),
          files,
        )
      ).outcome,
      "ASSERTION_FAILURE",
    );
  });

  it("never credits a matcher that a repository preload replaced or added", async () => {
    const files = ["pkg/src/a.spec.ts"];
    assert.equal(
      (await runDriver(PACKAGE_FILES, packageRun("uses a replaced matcher"), files)).outcome,
      "PROCESS_CRASH",
    );
    assert.equal(
      (await runDriver(PACKAGE_FILES, packageRun("uses an extended matcher"), files)).outcome,
      "PROCESS_CRASH",
    );
  });

  it("credits a declared trusted matcher only from its declared path and name", async () => {
    const files = ["pkg/src/a.spec.ts"];
    const trusted = (path: string, matchers: string[]) => ({
      trustedMatchers: [{ path, matchers }],
    });
    assert.deepEqual(
      await runDriver(
        PACKAGE_FILES,
        packageRun("uses an extended matcher", trusted("pkg/setup.ts", ["toFailExtended"])),
        files,
      ),
      {
        protocolVersion: "1.0.0",
        outcome: "ASSERTION_FAILURE",
        testsDiscovered: 1,
        candidateTestsDiscovered: 1,
        attributed: true,
      },
    );
    assert.equal(
      (
        await runDriver(
          PACKAGE_FILES,
          packageRun("uses an extended matcher", trusted("pkg/other.ts", ["toFailExtended"])),
          files,
        )
      ).outcome,
      "PROCESS_CRASH",
    );
    assert.equal(
      (
        await runDriver(
          PACKAGE_FILES,
          packageRun("uses a replaced matcher", trusted("pkg/setup.ts", ["toFailExtended"])),
          files,
        )
      ).outcome,
      "PROCESS_CRASH",
    );
  });

  it("loads isolated designated files one process each", async () => {
    const files = ["pkg/src/a.spec.ts", "pkg/src/b.spec.ts"];
    const load = (isolate: boolean) => ({
      mode: "load",
      tests: [
        { file: "pkg/src/a.spec.ts", path: ["package", "sees its setup"] },
        { file: "pkg/src/b.spec.ts", path: ["second"] },
      ],
      workingDirectory: "pkg",
      isolate,
      trustedMatchers: [],
    });
    for (const isolate of [true, false]) {
      const result = await runDriver(PACKAGE_FILES, load(isolate), files);
      assert.equal(result.outcome, "PASS", `isolate=${isolate}`);
      assert.equal(result.testsDiscovered, 4, `isolate=${isolate}`);
    }
  });

  it("refuses a bunfig whose test preload it cannot place after its own", async () => {
    const files = ["pkg/src/a.spec.ts"];
    const dotted = { ...PACKAGE_FILES, "pkg/bunfig.toml": 'test.preload = ["./setup.ts"]\n' };
    assert.equal(
      (await runDriver(dotted, packageRun("sees its setup"), files)).outcome,
      "INFRA_ERROR",
    );
  });
});

describe("designated bunfig rewriting", () => {
  const ours = "/root/node_modules/assertledger/preload.mjs";
  it("puts AssertLedger's preload first and keeps every repository preload and setting", () => {
    assert.equal(designatedBunConfig(undefined, ours), `[test]\npreload = ["${ours}"]\n`);
    assert.equal(
      designatedBunConfig('[test]\npreload = "./a.ts"\ntimeout = 5\n', ours),
      `[test]\npreload = ["${ours}", "./a.ts"]\ntimeout = 5\n`,
    );
    assert.equal(
      designatedBunConfig("[install]\nexact = true\n[test]\ncoverage = true\n", ours),
      `[install]\nexact = true\n[test]\npreload = ["${ours}"]\ncoverage = true\n`,
    );
    assert.equal(
      designatedBunConfig("[install]\nexact = true\n", ours),
      `[install]\nexact = true\n\n[test]\npreload = ["${ours}"]\n`,
    );
    assert.equal(
      designatedBunConfig('[test]\npreload = [\n  "./a.ts",\n  \'./b.ts\',\n]\nroot = "."\n', ours),
      `[test]\npreload = ["${ours}", "./a.ts", "./b.ts"]\nroot = "."\n`,
    );
    // A top-level preload is not a test preload for bun test: it stays as found.
    assert.equal(
      designatedBunConfig('preload = ["./run.ts"]\n', ours),
      `preload = ["./run.ts"]\n\n[test]\npreload = ["${ours}"]\n`,
    );
  });

  it("refuses every test preload spelling it does not rewrite", () => {
    for (const source of [
      'test.preload = ["./a.ts"]\n',
      'test = { preload = ["./a.ts"] }\n',
      '[test]\n"preload" = ["./a.ts"]\n',
      '[test]\npreload = ["./a.ts"]\npreload = ["./b.ts"]\n',
      '[test]\npreload = [\n  "./a.ts", # comment\n]\n',
      "[test]\npreload = ./a.ts\n",
      "[test]\n[test]\n",
    ]) {
      assert.throws(
        () => designatedBunConfig(source, ours),
        /BUNFIG_TEST_PRELOAD_UNSUPPORTED/u,
        source,
      );
    }
  });
});

async function campaignRepository(testBody = KEEPS_DOCS, extra: Record<string, string> = {}) {
  return designatedRepository(
    await temporaryDirectory("assertledger-designated-campaign-"),
    testBody,
    extra,
  );
}

const campaign = (root: string, targetSource: string, options: DesignatedCampaignOptions = {}) =>
  designatedCampaign(root, bun, targetSource, options);

describe("v4 designated campaigns", () => {
  it("verifies an existing test, leaves the unrelated link out and keeps the isolation visible", async () => {
    const root = await campaignRepository();
    const manifest = parseEvidenceManifestV4(await verifyCampaign(campaign(root, FAULT)));
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.equal(manifest.isolation.level, "UNSANDBOXED");
    assert.deepEqual(manifest.evidenceContext.repository, {
      includeDependencies: false,
      omittedLinks: [".claude/skills"],
      git: null,
    });
    assert.deepEqual(
      manifest.observations
        .filter(
          (observation) => observation.worldId === "target" && observation.candidateId !== null,
        )
        .map((observation) => [observation.outcome, observation.attributed]),
      [
        ["ASSERTION_FAILURE", true],
        ["ASSERTION_FAILURE", true],
      ],
    );
    assert.equal(replayEvidenceManifest(JSON.parse(JSON.stringify(manifest))).valid, true);

    // The recorded isolation level and repository snapshot are bound to the sealed digests.
    const copy = () => JSON.parse(JSON.stringify(manifest));
    const relabeled = copy();
    relabeled.isolation = { ...relabeled.isolation, level: "CONTAINER" };
    assert.equal(replayEvidenceManifest(relabeled).valid, false);
    const hiddenLink = copy();
    hiddenLink.evidenceContext.repository.omittedLinks = [];
    assert.equal(replayEvidenceManifest(hiddenLink).valid, false);
    const unsorted = copy();
    unsorted.evidenceContext.repository.omittedLinks = [".z", ".a"];
    assert.throws(() => parseEvidenceManifestV4(unsorted));
    const forgedGit = copy();
    forgedGit.evidenceContext.repository.git = {
      mode: "synthesized",
      treeId: "x",
      gitVersion: "git",
    };
    assert.equal(replayEvidenceManifest(forgedGit).valid, false);
  });

  it("never verifies a fault that breaks the module import instead of the assertion", async () => {
    const root = await campaignRepository();
    const manifest = parseEvidenceManifestV4(
      await verifyCampaign(
        campaign(root, 'import "./missing";\nexport const names = () => ["a"];\n'),
      ),
    );
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some((observation) => observation.outcome === "ASSERTION_FAILURE"),
      false,
    );
  });

  it("never credits a test that overran its per-test timeout, whatever it threw afterwards", async () => {
    const root = await campaignRepository(OVERRUNS_UNDER_FAULT);
    const manifest = parseEvidenceManifestV4(
      await verifyCampaign(campaign(root, FAULT, { testTimeoutMs: 200 })),
    );
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some((observation) => observation.outcome === "ASSERTION_FAILURE"),
      false,
    );
    assert.ok(
      (
        manifest.evidenceContext.adapter.configuration as { arguments: string[] }
      ).arguments.includes("--timeout=200"),
    );
  });

  it("refuses a campaign whose test imports through a link, naming the link", async () => {
    const root = await campaignRepository(KEEPS_DOCS, { "lib/real/names.ts": FAULT });
    await writeFile(
      path.join(root, "tools", "a.test.ts"),
      TEST_SOURCE(KEEPS_DOCS).replace("../src/names", "../lib/linked/names"),
    );
    await symlink(
      path.join(root, "lib", "real"),
      path.join(root, "lib", "linked"),
      directoryLinkType,
    );
    await assert.rejects(verifyCampaign(campaign(root, FAULT)), (error: Error) => {
      assert.equal(error.message, "REPOSITORY_LINK_IN_TEST_CLOSURE");
      assert.equal(error.cause, "lib/linked");
      return true;
    });
  });

  it("marks a designated test whose repeated runs diverge as UNSTABLE, never VERIFIED", async () => {
    // Under the fault the test fails, then passes on its next run: a marker outside the workspace
    // carries the state between executions.
    const marker = `assertledger-flip-${process.pid}-${Date.now()}`;
    const flipping = `() => {
    const marker = join(tmpdir(), ${JSON.stringify(marker)});
    let listed = names();
    if (!listed.includes("docs")) {
      if (existsSync(marker)) { rmSync(marker); listed = ["docs"]; } else writeFileSync(marker, "");
    }
    expect(listed).toContain("docs");
  }`;
    const root = await campaignRepository(flipping);
    await writeFile(
      path.join(root, "tools", "a.test.ts"),
      `import { existsSync, rmSync, writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n${TEST_SOURCE(flipping)}`,
    );
    try {
      const manifest = parseEvidenceManifestV4(await verifyCampaign(campaign(root, FAULT)));
      assert.notEqual(manifest.decision.status, "VERIFIED");
      assert.equal(manifest.candidates[0]?.status, "UNSTABLE");
    } finally {
      await rm(path.join(os.tmpdir(), marker), { force: true });
    }
  });

  it("keeps refusing any repository link in a v3 campaign", async () => {
    const root = await campaignRepository();
    const designated = campaign(root, FAULT);
    const request = {
      ...designated,
      budgets: {
        ...designated.budgets,
        maximumCandidateBytes: 10_000,
        maximumTotalCandidateBytes: 10_000,
      },
      schemaVersion: "3.0.0",
      repository: { root, exclude: [] },
      adapter: { kind: "bun-test", executable: bun, baseTestFiles: ["tools/a.test.ts"] },
      candidateRoots: ["tests/candidates"],
      candidates: [
        {
          id: "candidate",
          files: [
            {
              path: "tests/candidates/c.test.ts",
              content: 'import { test } from "bun:test";\ntest("c", () => {});\n',
            },
          ],
        },
      ],
    };
    await assert.rejects(verifyCampaign(request), /UNSUPPORTED_REPOSITORY_SYMLINK/u);
  });

  it("gives a test that asks Git for tracked files a synthesized repository, recorded by tree", async () => {
    const gitTest =
      '() => { const listed = Bun.spawnSync({ cmd: ["git", "ls-files"] }); expect(listed.exitCode).toBe(0); expect(names()).toContain("docs"); }';
    const root = await campaignRepository(gitTest);
    const allowlist = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"];
    const isolation = {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: allowlist,
    };
    const synthesized = parseEvidenceManifestV4(
      await verifyCampaign(campaign(root, FAULT, { git: "synthesized", isolation })),
    );
    assert.equal(synthesized.decision.status, "VERIFIED");
    assert.match(synthesized.evidenceContext.repository.git?.treeId ?? "", /^[a-f0-9]{40,64}$/u);
    assert.ok(synthesized.limitations.some((line) => line.includes("synthesized Git repository")));

    const excluded = parseEvidenceManifestV4(
      await verifyCampaign(
        campaign(root, FAULT, {
          git: "excluded",
          isolation,
          expectedFailure: "error: expect(received).toContain(expected)",
        }),
      ),
    );
    assert.notEqual(excluded.decision.status, "VERIFIED");
  });

  it("declares Windows-native execution only when acknowledged, on Windows, and records its level", async () => {
    const root = await campaignRepository();
    const isolation = (acknowledged: boolean) => ({
      kind: "windows-native",
      acknowledgedUnsafeExecution: acknowledged,
      environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
    });
    await assert.rejects(
      verifyCampaign(campaign(root, FAULT, { isolation: isolation(false) })),
      /WINDOWS_NATIVE_EXECUTION_NOT_ACKNOWLEDGED/u,
    );
    if (process.platform !== "win32") {
      await assert.rejects(
        verifyCampaign(campaign(root, FAULT, { isolation: isolation(true) })),
        /WINDOWS_NATIVE_HOST_REQUIRED/u,
      );
      return;
    }
    const manifest = parseEvidenceManifestV4(
      await verifyCampaign(campaign(root, FAULT, { isolation: isolation(true) })),
    );
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.isolation, {
      kind: "windows-native",
      level: "WINDOWS_NATIVE_UNSANDBOXED",
      acknowledgedUnsafeExecution: true,
    });
  });

  it("requires exactly one authorized backend on the CLI", async () => {
    const root = await campaignRepository();
    const requestFile = path.join(root, "..", `${path.basename(root)}-request.json`);
    temporaryDirectories.push(requestFile);
    await writeFile(requestFile, JSON.stringify(campaign(root, FAULT)));
    let stderr = "";
    const io = {
      cwd: root,
      readStdin: async () => "",
      writeStdout: () => undefined,
      writeStderr: (text: string) => {
        stderr += text;
      },
    };
    assert.equal(
      await runCli(
        ["verify", requestFile, "--allow-unsafe-execution", "--allow-windows-native-execution"],
        io,
      ),
      4,
    );
    assert.match(stderr, /ISOLATION_MODE_CONFLICT/u);
  });
});
