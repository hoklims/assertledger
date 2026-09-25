import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type CliIo, runCli } from "../src/cli.js";
import { parseRepositoryInitResult } from "../src/contracts/index.js";
import {
  type ConnectionClient,
  connectClient,
  createCodexProjectConfig,
  disconnectClient,
} from "../src/engine/connection.js";
import { runFixtureDemo } from "../src/engine/demo.js";
import { verifyCampaign as executeCampaign, initializeRepository } from "../src/engine/index.js";
import { type RepositorySetupResult, setupRepository } from "../src/engine/setup.js";
import { AssertLedger } from "../src/sdk/index.js";

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-dx-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "test"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@11.0.0",
      scripts: { test: "node --test test/*.test.js" },
    }),
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(root, "test", "base.test.js"), "import test from 'node:test';\n");
  return root;
}

function captureIo(cwd: string): { io: CliIo; stdout(): string; stderr(): string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      readStdin: async () => "",
      writeStdout(text) {
        stdout += text;
      },
      writeStderr(text) {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("developer entry points", () => {
  it("keeps 1.3.0 release metadata aligned without rewriting historical campaign provenance", async () => {
    assert.equal(packageMetadata.version, "1.3.0");
    const [readme, readmeFr, changelog, site] = await Promise.all([
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../README.fr.md", import.meta.url), "utf8"),
      readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
      readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    ]);
    assert.match(readme, /assertledger@1\.3\.0/u);
    assert.match(readme, /--branch v1\.3\.0/u);
    assert.match(readmeFr, /assertledger@1\.3\.0/u);
    assert.match(readmeFr, /--branch v1\.3\.0/u);
    assert.match(changelog, /^## 1\.3\.0 — 2026-09-25$/mu);
    assert.equal(site.match(/data-version>1\.3\.0/gmu)?.length, 2);
    assert.equal(site.match(/recorded with\s+assertledger 1\.1\.1/giu)?.length, 2);
  });

  it("rolls back only byte-identical init files when a connection conflict appears after init", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-race-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(
      path.join(builtRoot, "integrations", "skill", "SKILL.md"),
      "---\nname: assertledger\n---\n",
    );
    const conflictPath = path.join(root, ".agents", "skills", "assertledger", "SKILL.md");
    const result = await setupRepository(root, builtEntry, "codex", true, {
      async afterInitApplied() {
        await mkdir(path.dirname(conflictPath), { recursive: true });
        await writeFile(conflictPath, "operator-owned race\n");
      },
    });

    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.rollback, {
      status: "COMPLETE",
      removed: ["assertledger.config.json", "assertledger.lock.json"],
      unresolved: [],
    });
    assert.deepEqual(result.reasonCodes, ["CONNECTION_CONTENT_CONFLICT"]);
    assert.deepEqual(result.diagnosticPaths, [
      path.join(await realpath(root), ".agents", "skills", "assertledger", "SKILL.md"),
    ]);
    assert.deepEqual(result.nextActions, [
      "Inspect and resolve conflicting client artifact contents, then rerun setup.",
    ]);
    assert.equal(await readFile(conflictPath, "utf8"), "operator-owned race\n");
    for (const managed of ["assertledger.config.json", "assertledger.lock.json"]) {
      await assert.rejects(readFile(path.join(root, managed), "utf8"), /ENOENT/u);
    }
  });

  it("reports a partial setup failure instead of deleting an init file changed after creation", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-partial-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(
      path.join(builtRoot, "integrations", "skill", "SKILL.md"),
      "---\nname: assertledger\n---\n",
    );
    const conflictPath = path.join(root, ".agents", "skills", "assertledger", "SKILL.md");
    const result = await setupRepository(root, builtEntry, "codex", true, {
      async afterInitApplied() {
        await writeFile(path.join(root, "assertledger.config.json"), '{"operator":"changed"}\n');
        await mkdir(path.dirname(conflictPath), { recursive: true });
        await writeFile(conflictPath, "operator-owned race\n");
      },
    });

    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: ["assertledger.lock.json"],
      unresolved: ["assertledger.config.json"],
    });
    assert.equal(
      await readFile(path.join(root, "assertledger.config.json"), "utf8"),
      '{"operator":"changed"}\n',
    );
  });

  it("reports an init temporary file when atomic rename and cleanup both fail", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-init-write-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const plan = await initializeRepository(root, { dryRun: true });
    const config = plan.files.find((file) => file.path === "assertledger.config.json");
    assert(config);
    let temporaryPath = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyInit: (setupRoot) =>
        initializeRepository(
          setupRoot,
          {},
          {
            async linkTemporary(temporary) {
              temporaryPath = temporary;
              throw new Error("FAULT_INIT_PUBLICATION");
            },
            async removeTemporary(temporary) {
              assert.equal(temporary, temporaryPath);
              throw new Error("FAULT_INIT_TEMP_CLEANUP");
            },
          },
        ),
    });

    const temporaryRelative = path
      .relative(await realpath(root), temporaryPath)
      .replaceAll("\\", "/");
    assert.match(temporaryRelative, /^\.assertledger\.config\.json\.\d+\.\d+\.tmp$/u);
    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: [],
      unresolved: [temporaryRelative],
    });
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.state),
      ["WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE", "PARTIAL"],
    );
    assert.equal(await readFile(temporaryPath, "utf8"), config.content);
    for (const managed of ["assertledger.config.json", "assertledger.lock.json"]) {
      await assert.rejects(readFile(path.join(root, managed), "utf8"), /ENOENT/u);
    }
  });

  it("never overwrites a matching init file created during no-overwrite publication", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-init-race-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const plan = await initializeRepository(root, { dryRun: true });
    const config = plan.files.find((file) => file.path === "assertledger.config.json");
    assert(config);
    let temporaryPath = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyInit: (setupRoot) =>
        initializeRepository(
          setupRoot,
          {},
          {
            async linkTemporary(temporary, target) {
              temporaryPath = temporary;
              await writeFile(target, config.content, { flag: "wx" });
              await link(temporary, target);
            },
          },
        ),
    });

    const temporaryRelative = path
      .relative(await realpath(root), temporaryPath)
      .replaceAll("\\", "/");
    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "COMPLETE",
      removed: [temporaryRelative],
      unresolved: [],
    });
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.state),
      ["WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE", "ROLLED_BACK"],
    );
    assert.equal(await readFile(path.join(root, config.path), "utf8"), config.content);
    await assert.rejects(readFile(path.join(root, "assertledger.lock.json"), "utf8"), /ENOENT/u);
    await assert.rejects(readFile(temporaryPath, "utf8"), /ENOENT/u);
  });

  it("never removes a colliding init temporary file that this invocation did not create", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-temp-collision-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const otherInvocationBytes = "other invocation temporary bytes\n";
    let temporaryPath = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyInit: (setupRoot) =>
        initializeRepository(
          setupRoot,
          {},
          {
            async openTemporary(temporary) {
              temporaryPath = temporary;
              await writeFile(temporary, otherInvocationBytes, { flag: "wx" });
              const collision = new Error("FAULT_INIT_TEMP_COLLISION") as NodeJS.ErrnoException;
              collision.code = "EEXIST";
              throw collision;
            },
          },
        ),
    });

    assert.equal(result.status, "PARTIAL_FAILURE");
    const temporaryRelative = path
      .relative(await realpath(root), temporaryPath)
      .replaceAll("\\", "/");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: [],
      unresolved: [temporaryRelative],
    });
    assert.equal(result.artifacts.at(-1)?.state, "PARTIAL");
    assert.equal(await readFile(temporaryPath, "utf8"), otherInvocationBytes);
  });

  it("does not report an absent init temporary after a pre-creation write failure", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-temp-absent-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    let temporaryPath = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyInit: (setupRoot) =>
        initializeRepository(
          setupRoot,
          {},
          {
            async openTemporary(temporary) {
              temporaryPath = temporary;
              const failure = new Error("FAULT_INIT_TEMP_PRE_CREATE") as NodeJS.ErrnoException;
              failure.code = "EACCES";
              throw failure;
            },
          },
        ),
    });

    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, { status: "COMPLETE", removed: [], unresolved: [] });
    assert.equal(result.artifacts.length, 4);
    await assert.rejects(lstat(temporaryPath), /ENOENT/u);
  });

  it("preserves a foreign init temporary that arrives during a failed reservation", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-temp-foreign-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const planned = await initializeRepository(root, { dryRun: true });
    const config = planned.files.find((file) => file.path === "assertledger.config.json");
    assert(config);
    let temporaryPath = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyInit: (setupRoot) =>
        initializeRepository(
          setupRoot,
          {},
          {
            async openTemporary(temporary) {
              temporaryPath = temporary;
              await writeFile(temporary, config.content, { flag: "wx" });
              const failure = new Error(
                "FAULT_INIT_FOREIGN_AFTER_RESERVATION_FAILURE",
              ) as NodeJS.ErrnoException;
              failure.code = "EIO";
              throw failure;
            },
          },
        ),
    });

    const temporaryRelative = path
      .relative(await realpath(root), temporaryPath)
      .replaceAll("\\", "/");
    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: [],
      unresolved: [temporaryRelative],
    });
    assert.equal(await readFile(temporaryPath, "utf8"), config.content);
  });

  it("reports partial temporary bytes when this invocation writes then fails", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-temp-partial-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const partialBytes = "partial bytes from this invocation\n";
    let temporaryPath = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyInit: (setupRoot) =>
        initializeRepository(
          setupRoot,
          {},
          {
            async writeTemporary(temporary, _content, handle) {
              temporaryPath = temporary;
              await handle.writeFile(partialBytes);
              const failure = new Error("FAULT_INIT_PARTIAL_WRITE") as NodeJS.ErrnoException;
              failure.code = "EIO";
              throw failure;
            },
            async removeTemporary(temporary) {
              assert.equal(temporary, temporaryPath);
              throw new Error("FAULT_INIT_PARTIAL_CLEANUP");
            },
          },
        ),
    });

    const temporaryRelative = path
      .relative(await realpath(root), temporaryPath)
      .replaceAll("\\", "/");
    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: [],
      unresolved: [temporaryRelative],
    });
    assert.equal(result.artifacts.at(-1)?.state, "PARTIAL");
    assert.equal(await readFile(temporaryPath, "utf8"), partialBytes);
  });

  it("reports partial connection bytes and cleanup failures without deleting either file", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-connect-write-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const partialSkill = "partial skill bytes\n";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyConnection: () =>
        connectClient(root, builtEntry, "codex", true, {
          async writeArtifact(artifact, handle) {
            assert(artifact.path);
            if (artifact.kind === "configuration") {
              await handle.writeFile(artifact.content);
              return;
            }
            await handle.writeFile(partialSkill);
            throw new Error("FAULT_PARTIAL_CONNECTION_WRITE");
          },
          async removeArtifact(artifact) {
            assert(artifact.path);
            throw new Error("FAULT_CONNECTION_CLEANUP");
          },
        }),
    });

    const configPath = path.join(root, ".codex", "config.toml");
    const skillPath = path.join(root, ".agents", "skills", "assertledger", "SKILL.md");
    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: ["assertledger.config.json", "assertledger.lock.json"],
      unresolved: [".agents/skills/assertledger/SKILL.md", ".codex/config.toml"],
    });
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.state),
      ["ROLLED_BACK", "ROLLED_BACK", "PARTIAL", "PARTIAL"],
    );
    assert.equal(await readFile(configPath, "utf8"), result.connection.artifacts[0]?.content);
    assert.equal(await readFile(skillPath, "utf8"), partialSkill);
  });

  it("removes owned partial connection bytes so setup can be retried", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-connect-retry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");

    const failed = await setupRepository(root, builtEntry, "codex", true, {
      applyConnection: () =>
        connectClient(root, builtEntry, "codex", true, {
          async writeArtifact(artifact, handle) {
            if (artifact.kind === "configuration") {
              await handle.writeFile(artifact.content);
              return;
            }
            await handle.writeFile("owned partial skill bytes\n");
            throw new Error("FAULT_PARTIAL_CONNECTION_WRITE_RETRY");
          },
        }),
    });

    assert.equal(failed.status, "PARTIAL_FAILURE");
    assert.deepEqual(failed.rollback, {
      status: "COMPLETE",
      removed: [
        ".agents/skills/assertledger/SKILL.md",
        ".codex/config.toml",
        "assertledger.config.json",
        "assertledger.lock.json",
      ],
      unresolved: [],
    });
    assert.deepEqual(
      failed.artifacts.map((artifact) => artifact.state),
      ["ROLLED_BACK", "ROLLED_BACK", "ROLLED_BACK", "ROLLED_BACK"],
    );

    const retried = await setupRepository(root, builtEntry, "codex", true);
    assert.equal(retried.status, "CREATED");
    assert.deepEqual(
      retried.artifacts.map((artifact) => artifact.state),
      ["CREATED", "CREATED", "CREATED", "CREATED"],
    );
  });

  it("does not report an absent connection artifact as rolled back when its write fails", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-connect-absent-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyConnection: () =>
        connectClient(root, builtEntry, "codex", true, {
          async openArtifact() {
            throw new Error("FAULT_CONNECTION_WRITE_BEFORE_CREATE");
          },
        }),
    });

    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "COMPLETE",
      removed: ["assertledger.config.json", "assertledger.lock.json"],
      unresolved: [],
    });
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.state),
      ["ROLLED_BACK", "ROLLED_BACK", "WOULD_CREATE", "WOULD_CREATE"],
    );
    await assert.rejects(readFile(path.join(root, ".codex", "config.toml"), "utf8"), /ENOENT/u);
    await assert.rejects(
      readFile(path.join(root, ".agents", "skills", "assertledger", "SKILL.md"), "utf8"),
      /ENOENT/u,
    );
  });

  it("preserves a foreign same-byte connection artifact after a failed reservation", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-connect-foreign-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    let foreignPath = "";
    let foreignBytes = "";

    const result = await setupRepository(root, builtEntry, "codex", true, {
      applyConnection: () =>
        connectClient(root, builtEntry, "codex", true, {
          async openArtifact(artifact) {
            assert(artifact.path);
            foreignPath = artifact.path;
            foreignBytes = artifact.content;
            await writeFile(artifact.path, artifact.content, { flag: "wx" });
            const failure = new Error(
              "FAULT_CONNECTION_FOREIGN_AFTER_RESERVATION_FAILURE",
            ) as NodeJS.ErrnoException;
            failure.code = "EIO";
            throw failure;
          },
        }),
    });

    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.deepEqual(result.rollback, {
      status: "PARTIAL",
      removed: ["assertledger.config.json", "assertledger.lock.json"],
      unresolved: [".codex/config.toml"],
    });
    assert.equal(await readFile(foreignPath, "utf8"), foreignBytes);
    assert.equal(
      result.artifacts.find((artifact) => artifact.path === foreignPath)?.state,
      "PARTIAL",
    );
  });

  it("returns a typed partial failure for an unexpected connection apply error", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-connect-error-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");

    const capture = captureIo(root);
    const exitCode = await runCli(
      ["setup", root, "--client", "codex", "--write", "--json"],
      capture.io,
      {
        setupEntry: builtEntry,
        setupRepository: (setupRoot, cliEntry, client, write) =>
          setupRepository(setupRoot, cliEntry, client, write, {
            async applyConnection() {
              throw new Error("FAULT_UNEXPECTED_CONNECTION_APPLY");
            },
          }),
      },
    );
    const result = JSON.parse(capture.stdout()) as RepositorySetupResult;

    assert.equal(exitCode, 5);
    assert.equal(capture.stderr(), "");
    assert.equal(result.status, "PARTIAL_FAILURE");
    assert.equal(result.mode, "write");
    assert.deepEqual(result.rollback, {
      status: "COMPLETE",
      removed: ["assertledger.config.json", "assertledger.lock.json"],
      unresolved: [],
    });
    assert.deepEqual(result.reasonCodes, ["CONNECTION_APPLY_FAILED"]);
    assert.deepEqual(result.nextActions, [
      "Inspect rollback details, resolve unresolved paths, then rerun setup.",
    ]);
    assert.deepEqual(result.diagnosticPaths, []);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.state),
      ["ROLLED_BACK", "ROLLED_BACK", "WOULD_CREATE", "WOULD_CREATE"],
    );
  });

  it("reports an injected post-init connection conflict in JSON and plain output", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-apply-conflict-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");
    const configPath = path.join(await realpath(root), ".codex", "config.toml");
    const execute = (capture: ReturnType<typeof captureIo>, json: boolean) =>
      runCli(
        ["setup", root, "--client", "codex", "--write", ...(json ? ["--json"] : [])],
        capture.io,
        {
          setupEntry: builtEntry,
          setupRepository: (setupRoot, cliEntry, client, write) =>
            setupRepository(setupRoot, cliEntry, client, write, {
              async applyConnection() {
                return {
                  client: "codex",
                  status: "CONFLICT",
                  artifacts: [
                    {
                      kind: "configuration",
                      path: configPath,
                      content: "injected conflict\n",
                    },
                  ],
                };
              },
            }),
        },
      );

    const jsonCapture = captureIo(root);
    assert.equal(await execute(jsonCapture, true), 4);
    assert.equal(jsonCapture.stderr(), "");
    const report = JSON.parse(jsonCapture.stdout()) as RepositorySetupResult;
    assert.equal(report.status, "CONFLICT");
    assert.deepEqual(report.reasonCodes, ["CONNECTION_APPLY_CONFLICT"]);
    assert.deepEqual(report.diagnosticPaths, [configPath]);
    assert.deepEqual(report.nextActions, [
      "Inspect conflicting client artifacts, then rerun setup.",
    ]);

    const plainCapture = captureIo(root);
    assert.equal(await execute(plainCapture, false), 4);
    assert.equal(plainCapture.stderr(), "");
    assert.match(plainCapture.stdout(), /^Reason code: CONNECTION_APPLY_CONFLICT$/mu);
    assert.ok(plainCapture.stdout().includes(`Diagnostic path: ${configPath}\n`));
    assert.match(
      plainCapture.stdout(),
      /^Next action: Inspect conflicting client artifacts, then rerun setup\.$/mu,
    );
  });

  it("returns an actionable typed conflict when the built CLI is missing", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-preflight-error-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    const capture = captureIo(root);

    const exitCode = await runCli(
      ["setup", root, "--client", "codex", "--write", "--json"],
      capture.io,
      { setupEntry: builtEntry },
    );
    const result = JSON.parse(capture.stdout()) as RepositorySetupResult;

    assert.equal(exitCode, 4);
    assert.equal(capture.stderr(), "");
    assert.equal(result.status, "CONFLICT");
    assert.equal(result.mode, "write");
    assert.equal(result.connection.status, "CONFLICT");
    assert.deepEqual(result.connection.artifacts, []);
    assert.deepEqual(result.rollback, { status: "NOT_REQUIRED", removed: [], unresolved: [] });
    assert.deepEqual(result.reasonCodes, ["CONNECTION_BUILD_REQUIRED"]);
    assert.deepEqual(result.nextActions, [
      "Run `pnpm build`, invoke the generated dist/cli.js, then rerun setup.",
    ]);
    assert.deepEqual(result.diagnosticPaths, [path.resolve(builtEntry)]);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.state),
      ["WOULD_CREATE", "WOULD_CREATE"],
    );
    await assert.rejects(readFile(path.join(root, "assertledger.config.json")), /ENOENT/u);
    await assert.rejects(readFile(path.join(root, "assertledger.lock.json")), /ENOENT/u);
  });

  it("returns opaque typed JSON when init preflight throws", async () => {
    const root = await fixtureRepository();
    const builtEntry = path.resolve("dist", "cli.js");
    const capture = captureIo(root);
    const exitCode = await runCli(
      ["setup", root, "--client", "codex", "--write", "--json"],
      capture.io,
      {
        setupEntry: builtEntry,
        setupRepository: (setupRoot, cliEntry, client, write) =>
          setupRepository(setupRoot, cliEntry, client, write, {
            async planInit() {
              throw new Error("SENSITIVE_INIT_IO_DETAIL");
            },
          }),
      },
    );
    const result = JSON.parse(capture.stdout()) as RepositorySetupResult;

    assert.equal(exitCode, 4);
    assert.equal(capture.stderr(), "");
    assert.equal(result.status, "CONFLICT");
    assert.equal(result.rollback.status, "NOT_REQUIRED");
    assert.deepEqual(result.reasonCodes, ["INIT_PREFLIGHT_FAILED"]);
    assert.deepEqual(result.diagnosticPaths, [path.resolve(root)]);
    assert.deepEqual(result.nextActions, [
      "Inspect repository readability and permissions, then rerun setup.",
    ]);
    assert.doesNotMatch(capture.stdout(), /SENSITIVE_INIT_IO_DETAIL/u);
  });

  it("maps packaged skill preflight failures without exposing raw errors", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-skill-errors-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    const skillPath = path.join(builtRoot, "integrations", "skill", "SKILL.md");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");

    const missing = await setupRepository(root, builtEntry, "codex", true);
    assert.equal(missing.status, "CONFLICT");
    assert.deepEqual(missing.reasonCodes, ["CONNECTION_SKILL_REQUIRED"]);
    assert.deepEqual(missing.diagnosticPaths, [skillPath]);
    assert.deepEqual(missing.nextActions, [
      "Restore integrations/skill/SKILL.md from the installed package, then rerun setup.",
    ]);

    await mkdir(skillPath, { recursive: true });
    const unsafe = await setupRepository(root, builtEntry, "codex", true);
    assert.equal(unsafe.status, "CONFLICT");
    assert.deepEqual(unsafe.reasonCodes, ["CONNECTION_SKILL_PATH_UNSAFE"]);
    assert.deepEqual(unsafe.diagnosticPaths, [skillPath]);
    assert.deepEqual(unsafe.nextActions, [
      "Replace the packaged skill path with a regular file, then rerun setup.",
    ]);

    const unexpected = await setupRepository(root, builtEntry, "codex", true, {
      async planConnection() {
        throw new Error("SENSITIVE_ARBITRARY_PREFLIGHT_DETAIL");
      },
    });
    assert.equal(unexpected.status, "CONFLICT");
    assert.deepEqual(unexpected.reasonCodes, ["CONNECTION_PREFLIGHT_FAILED"]);
    assert.deepEqual(unexpected.diagnosticPaths, []);
    assert.deepEqual(unexpected.nextActions, [
      "Inspect the installed package and client configuration paths, then rerun setup.",
    ]);
    assert.doesNotMatch(JSON.stringify(unexpected), /SENSITIVE_ARBITRARY_PREFLIGHT_DETAIL/u);
  });

  it("preflights initialization and client conflicts before setup writes any managed file", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(
      path.join(builtRoot, "integrations", "skill", "SKILL.md"),
      "---\nname: assertledger\n---\n",
    );

    const conflictPath = path.join(root, ".agents", "skills", "assertledger", "SKILL.md");
    await mkdir(path.dirname(conflictPath), { recursive: true });
    await writeFile(conflictPath, "operator-owned\n");
    const canonicalConflictPath = path.join(
      await realpath(root),
      ".agents",
      "skills",
      "assertledger",
      "SKILL.md",
    );

    const conflict = await setupRepository(root, builtEntry, "codex", true);
    assert.equal(conflict.status, "CONFLICT");
    assert.deepEqual(conflict.reasonCodes, ["CONNECTION_CONTENT_CONFLICT"]);
    assert.deepEqual(conflict.diagnosticPaths, [canonicalConflictPath]);
    assert.deepEqual(conflict.nextActions, [
      "Inspect and resolve conflicting client artifact contents, then rerun setup.",
    ]);
    assert.equal(await readFile(conflictPath, "utf8"), "operator-owned\n");
    for (const managed of [
      "assertledger.config.json",
      "assertledger.lock.json",
      path.join(".codex", "config.toml"),
    ]) {
      await assert.rejects(readFile(path.join(root, managed), "utf8"), /ENOENT/u);
    }

    const plainConflict = captureIo(root);
    assert.equal(
      await runCli(["setup", root, "--client", "codex", "--dry-run"], plainConflict.io, {
        setupEntry: builtEntry,
      }),
      4,
    );
    assert.equal(plainConflict.stderr(), "");
    assert.match(plainConflict.stdout(), /^Reason code: CONNECTION_CONTENT_CONFLICT$/mu);
    assert.ok(plainConflict.stdout().includes(`Diagnostic path: ${canonicalConflictPath}\n`));
    assert.match(
      plainConflict.stdout(),
      /^Next action: Inspect and resolve conflicting client artifact contents, then rerun setup\.$/mu,
    );

    await rm(conflictPath);
    const preview = await setupRepository(root, builtEntry, "codex", false);
    assert.equal(preview.status, "WOULD_CREATE");
    assert.equal(preview.init.status, "WOULD_CREATE");
    assert.equal(preview.connection.status, "EMITTED");
    assert.match(
      preview.limitations.join("\n"),
      /Concurrent edits can be overwritten during lock regeneration or removed between a rollback byte check and unlink/u,
    );
    assert.deepEqual(
      preview.artifacts.map((artifact) => artifact.state),
      ["WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE", "WOULD_CREATE"],
    );
    await assert.rejects(readFile(path.join(root, "assertledger.config.json"), "utf8"), /ENOENT/u);

    const created = await setupRepository(root, builtEntry, "codex", true);
    assert.equal(created.status, "CREATED");
    assert.equal((await setupRepository(root, builtEntry, "codex", true)).status, "UNCHANGED");
  });

  it("prints typed setup conflict diagnostics in plain output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-plain-conflict-"));
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
    );
    const capture = captureIo(root);

    const exitCode = await runCli(["setup", root, "--client", "codex", "--dry-run"], capture.io, {
      setupEntry: path.resolve("dist", "cli.js"),
    });

    assert.equal(exitCode, 4);
    assert.equal(capture.stderr(), "");
    assert.match(capture.stdout(), /^Setup status: CONFLICT$/mu);
    assert.match(capture.stdout(), /^Reason code: PACKAGE_MANAGER_UNDETECTED$/mu);
    assert.match(capture.stdout(), /^Diagnostic path: .+$/mu);
    assert.match(
      capture.stdout(),
      /^Next action: Resolve the repository initialization reason codes, then rerun setup\.$/mu,
    );
  });

  it("keeps source build refusal and unexpected setup errors typed in JSON", async () => {
    const root = await fixtureRepository();
    const sourceCapture = captureIo(root);
    const sourceExit = await runCli(
      ["setup", root, "--client", "codex", "--dry-run", "--json"],
      sourceCapture.io,
    );
    const sourceReport = JSON.parse(sourceCapture.stdout()) as {
      status: string;
      code: string;
      reasonCodes: string[];
      rollback: { status: string };
      nextActions: string[];
    };
    assert.equal(sourceExit, 3);
    assert.equal(sourceCapture.stderr(), "");
    assert.equal(sourceReport.status, "BLOCKED");
    assert.equal(sourceReport.code, "SETUP_BUILD_REQUIRED");
    assert.deepEqual(sourceReport.reasonCodes, ["SETUP_BUILD_REQUIRED"]);
    assert.equal(sourceReport.rollback.status, "NOT_REQUIRED");
    assert.deepEqual(sourceReport.nextActions, [
      "Run `pnpm build`, invoke the generated dist/cli.js, then rerun setup.",
    ]);

    const failureCapture = captureIo(root);
    const failureExit = await runCli(
      ["setup", root, "--client", "codex", "--write", "--json"],
      failureCapture.io,
      {
        setupEntry: path.resolve("dist", "cli.js"),
        async setupRepository() {
          throw new Error("SENSITIVE_UNEXPECTED_SETUP_DETAIL");
        },
      },
    );
    const failureReport = JSON.parse(failureCapture.stdout()) as {
      status: string;
      code: string;
      reasonCodes: string[];
      rollback: { status: string };
    };
    assert.equal(failureExit, 5);
    assert.equal(failureCapture.stderr(), "");
    assert.equal(failureReport.status, "PARTIAL_FAILURE");
    assert.equal(failureReport.code, "SETUP_UNEXPECTED_FAILURE");
    assert.deepEqual(failureReport.reasonCodes, ["SETUP_UNEXPECTED_FAILURE"]);
    assert.equal(failureReport.rollback.status, "UNKNOWN");
    assert.doesNotMatch(failureCapture.stdout(), /SENSITIVE_UNEXPECTED_SETUP_DETAIL/u);
  });

  it("prints typed diagnostics for invalid plain setup arguments", async () => {
    const capture = captureIo(process.cwd());
    const exitCode = await runCli(
      ["setup", ".", "--client", "codex", "--dry-run", "--write"],
      capture.io,
    );

    assert.equal(exitCode, 64);
    assert.equal(capture.stderr(), "");
    assert.match(capture.stdout(), /^Setup status: BLOCKED$/mu);
    assert.match(capture.stdout(), /^Reason code: SETUP_ARGUMENT_INVALID$/mu);
    assert.match(
      capture.stdout(),
      /^Next action: Correct the setup arguments and rerun setup\.$/mu,
    );
  });

  it("returns a structured JSON conflict for an invalid setup repository root", async () => {
    const missingParent = await mkdtemp(path.join(os.tmpdir(), "assertledger-setup-missing-"));
    temporaryDirectories.push(missingParent);
    const missingRoot = path.join(missingParent, "absent");
    const cli = path.resolve("dist", "cli.js");

    await assert.rejects(
      execFileAsync(process.execPath, [cli, "setup", missingRoot, "--client", "codex", "--json"], {
        cwd: process.cwd(),
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }),
      (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        assert.equal(error.code, 4);
        assert.equal(error.stderr, "");
        const result = JSON.parse(error.stdout ?? "null");
        assert.equal(result.status, "CONFLICT");
        assert.deepEqual(result.init.reasonCodes, ["REPOSITORY_ROOT_INVALID"]);
        assert.equal(result.connection.status, "CONFLICT");
        assert.deepEqual(result.artifacts, []);
        assert.deepEqual(result.rollback, {
          status: "NOT_REQUIRED",
          removed: [],
          unresolved: [],
        });
        return true;
      },
    );
  });

  it("returns a structured JSON conflict for an unsafe setup connection target", async () => {
    const root = await fixtureRepository();
    await mkdir(path.join(root, ".codex", "config.toml"), { recursive: true });
    const cli = path.resolve("dist", "cli.js");
    const resolvedRoot = await realpath(root);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "setup", root, "--client", "codex", "--dry-run", "--json"],
        { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
      ),
      (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
        assert.equal(error.code, 4);
        assert.equal(error.stderr, "");
        const result = JSON.parse(error.stdout ?? "null");
        assert.equal(result.status, "CONFLICT");
        assert.equal(result.connection.status, "CONFLICT");
        assert.equal(result.connection.artifacts.length, 2);
        assert.equal(result.artifacts[2]?.state, "CONFLICT");
        assert.deepEqual(result.reasonCodes, ["CONNECTION_TARGET_PATH_UNSAFE"]);
        assert.deepEqual(result.diagnosticPaths, [
          path.join(resolvedRoot, ".codex", "config.toml"),
        ]);
        assert.deepEqual(result.nextActions, [
          "Replace unsafe client target paths with regular local paths, then rerun setup.",
        ]);
        assert.deepEqual(result.rollback, {
          status: "NOT_REQUIRED",
          removed: [],
          unresolved: [],
        });
        return true;
      },
    );
    assert.equal((await lstat(path.join(root, ".codex", "config.toml"))).isDirectory(), true);
  });

  it("runs the shipped demonstration only with explicit unsafe authorization and limits its claim", async () => {
    const builtEntry = path.resolve("dist", "cli.js");
    await assert.rejects(
      runFixtureDemo(builtEntry, false),
      /UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED/u,
    );

    const result = await runFixtureDemo(builtEntry, true);
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.scope, "SHIPPED_FIXTURE_ONLY");
    assert.deepEqual(result.selectedCandidateIds, ["strong"]);
    assert.match(result.limitation, /does not prove.*user repository/iu);
    assert.equal(result.temporaryWorkspaceRemoved, true);
  });

  it("keeps invalid and unexpected demo JSON failures typed and opaque", async () => {
    const invalidCapture = captureIo(process.cwd());
    assert.equal(await runCli(["demo", "--json", "--unknown"], invalidCapture.io), 64);
    assert.equal(invalidCapture.stderr(), "");
    const invalid = JSON.parse(invalidCapture.stdout()) as {
      status: string;
      scope: string;
      reasonCodes: string[];
      execution: string;
    };
    assert.equal(invalid.status, "REFUSED");
    assert.equal(invalid.scope, "SHIPPED_FIXTURE_ONLY");
    assert.deepEqual(invalid.reasonCodes, ["DEMO_ARGUMENT_INVALID"]);
    assert.equal(invalid.execution, "NOT_STARTED");

    const failureCapture = captureIo(process.cwd());
    assert.equal(
      await runCli(["demo", "--allow-unsafe-execution", "--json"], failureCapture.io, {
        async runFixtureDemo() {
          throw new Error("SENSITIVE_DEMO_FAILURE_DETAIL");
        },
      }),
      5,
    );
    assert.equal(failureCapture.stderr(), "");
    const failure = JSON.parse(failureCapture.stdout()) as {
      status: string;
      scope: string;
      reasonCodes: string[];
      execution: string;
    };
    assert.equal(failure.status, "ENGINE_ERROR");
    assert.equal(failure.scope, "SHIPPED_FIXTURE_ONLY");
    assert.deepEqual(failure.reasonCodes, ["DEMO_UNEXPECTED_FAILURE"]);
    assert.equal(failure.execution, "UNSANDBOXED");
    assert.doesNotMatch(failureCapture.stdout(), /SENSITIVE_DEMO_FAILURE_DETAIL/u);
  });

  it("preserves INCONCLUSIVE and ENGINE_ERROR demo decisions instead of relabeling them", async () => {
    const builtEntry = path.resolve("dist", "cli.js");
    const inconclusive = await runFixtureDemo(builtEntry, true, {
      transformRequest(value) {
        const request = structuredClone(value) as {
          budgets: { timeoutMsPerExecution: number };
          policy: { requiredAttempts: number };
          candidates: Array<{ files: Array<{ content: string }> }>;
        };
        request.budgets.timeoutMsPerExecution = 5_000;
        request.policy.requiredAttempts = 1;
        request.candidates = [request.candidates[0] as (typeof request.candidates)[number]];
        const candidate = request.candidates[0];
        const file = candidate?.files[0];
        if (candidate === undefined || file === undefined)
          throw new Error("fixture candidate missing");
        candidate.files = [{ ...file, content: "while (true) {}\n" }];
        return request;
      },
    });
    assert.equal(inconclusive.status, "INCONCLUSIVE");
    assert.deepEqual(inconclusive.selectedCandidateIds, []);
    assert.deepEqual(inconclusive.reasonCodes, ["CANDIDATE_EVIDENCE_INCONCLUSIVE"]);

    const engineError = await runFixtureDemo(builtEntry, true, {
      async verifyCampaign(request) {
        const manifest = (await executeCampaign(request)) as {
          repositoryDigest: string;
          evidenceContext: Record<string, unknown>;
          policy: Record<string, unknown>;
          worlds: unknown[];
          candidates: unknown[];
          observations: unknown[];
          decision: Record<string, unknown>;
        };
        manifest.repositoryDigest = "invalid";
        manifest.evidenceContext = {
          engine: { name: "invalid", version: "invalid" },
          adapter: { name: "invalid", version: "invalid", configuration: {} },
          execution: {
            isolation: "invalid",
            environmentAllowlist: [],
            budgets: {},
            candidateRoots: [],
          },
          worlds: [],
        };
        manifest.policy = {
          policyVersion: "invalid",
          requiredAttempts: 1,
          minimumTargetWeightPermille: 1_000,
          maximumSelectedCandidates: 0,
          acceptedTargetOutcomes: [],
        };
        manifest.worlds = [];
        manifest.candidates = [];
        manifest.observations = [];
        manifest.decision = {
          status: "ENGINE_ERROR",
          selectedCandidateIds: [],
          reasonCodes: ["EVIDENCE_INPUT_INVALID"],
        };
        return manifest;
      },
    });
    assert.equal(engineError.status, "ENGINE_ERROR");
    assert.deepEqual(engineError.selectedCandidateIds, []);
    assert.deepEqual(engineError.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("exposes setup preview, setup write, and the bounded demo through the built CLI", async () => {
    const root = await fixtureRepository();
    const cli = path.resolve("dist", "cli.js");

    const preview = await execFileAsync(
      process.execPath,
      [cli, "setup", root, "--client", "claude-code", "--dry-run", "--json"],
      { cwd: root },
    );
    assert.equal(JSON.parse(preview.stdout).status, "WOULD_CREATE");
    await assert.rejects(readFile(path.join(root, "assertledger.config.json"), "utf8"), /ENOENT/u);

    const applied = await execFileAsync(
      process.execPath,
      [cli, "setup", root, "--client", "claude-code", "--write", "--json"],
      { cwd: root },
    );
    assert.equal(JSON.parse(applied.stdout).status, "CREATED");
    assert.equal(
      JSON.parse(await readFile(path.join(root, "assertledger.config.json"), "utf8")).schemaVersion,
      "1.0.0",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")).mcpServers !== undefined,
      true,
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cli, "demo", "--json"], { cwd: root }),
      (error: unknown) => {
        const refusal = error as { code: number; stderr: string; stdout: string };
        assert.equal(refusal.code, 4);
        assert.equal(refusal.stderr, "");
        assert.deepEqual(JSON.parse(refusal.stdout), {
          schemaVersion: "1.0.0",
          status: "REFUSED",
          reasonCodes: ["UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED"],
          scope: "SHIPPED_FIXTURE_ONLY",
          requiredFlag: "--allow-unsafe-execution",
          execution: "UNSANDBOXED",
        });
        return true;
      },
    );
    const demo = await execFileAsync(
      process.execPath,
      [cli, "demo", "--allow-unsafe-execution", "--json"],
      { cwd: root },
    );
    const demoResult = JSON.parse(demo.stdout);
    assert.equal(demoResult.status, "VERIFIED");
    assert.equal(demoResult.scope, "SHIPPED_FIXTURE_ONLY");
    assert.match(demoResult.limitation, /does not prove.*user repository/iu);
  });

  it("reports static doctor JSON through the existing init result without mutation", async () => {
    const root = await fixtureRepository();
    const before = await readFile(path.join(root, "package.json"), "utf8");
    const capture = captureIo(root);

    assert.equal(await runCli(["doctor", ".", "--json"], capture.io), 0);
    const result = parseRepositoryInitResult(JSON.parse(capture.stdout()));
    assert.equal(result.status, "WOULD_CREATE");
    assert.deepEqual(result.requiredOperatorInputs, ["worlds", "candidates"]);
    assert.equal(capture.stderr(), "");
    assert.equal(await readFile(path.join(root, "package.json"), "utf8"), before);
    await assert.rejects(readFile(path.join(root, "assertledger.config.json"), "utf8"), /ENOENT/u);
  });

  it("provides the same static doctor result through the SDK", async () => {
    const root = await fixtureRepository();
    const expected = await new AssertLedger().init(root, { dryRun: true });
    assert.deepEqual(await new AssertLedger().doctor(root), expected);
  });

  it("prints stable human readiness guidance without claiming connectivity", async () => {
    const root = await fixtureRepository();
    const capture = captureIo(root);

    assert.equal(await runCli(["doctor", "."], capture.io), 0);
    assert.match(capture.stdout(), /Status: WOULD_CREATE/u);
    assert.match(capture.stdout(), /Required operator inputs: worlds, candidates/u);
    assert.match(capture.stdout(), /UNSANDBOXED trusted-local/u);
    assert.match(capture.stdout(), /does not prove.*MCP connectivity/iu);
    assert.equal(capture.stderr(), "");
  });

  it("supports help and version aliases while preserving empty and unknown usage errors", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const capture = captureIo(process.cwd());
      assert.equal(await runCli(argv, capture.io), 0);
      assert.match(capture.stdout(), /Usage: assertledger/u);
      assert.equal(capture.stderr(), "");
    }
    for (const argv of [["version"], ["--version"], ["-v"]]) {
      const capture = captureIo(process.cwd());
      assert.equal(await runCli(argv, capture.io), 0);
      assert.equal(capture.stdout(), `assertledger ${packageMetadata.version}\n`);
      assert.equal(capture.stderr(), "");
    }
    for (const argv of [[], ["unknown"]]) {
      const capture = captureIo(process.cwd());
      assert.equal(await runCli(argv, capture.io), 64);
      assert.equal(capture.stdout(), "");
      assert.match(capture.stderr(), /Usage: assertledger/u);
    }
  });

  it("emits and writes a create-only project Codex configuration", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-built-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");

    const emitted = await createCodexProjectConfig(root, builtEntry, false);
    assert.equal(emitted.status, "EMITTED");
    assert.match(emitted.content, /^\[mcp_servers\.assertledger\]$/mu);
    assert.match(emitted.content, /"mcp", "--root"/u);
    assert.match(emitted.content, /cwd = /u);
    await assert.rejects(readFile(path.join(root, ".codex", "config.toml"), "utf8"), /ENOENT/u);

    const created = await createCodexProjectConfig(root, builtEntry, true);
    assert.equal(created.status, "CREATED");
    assert.equal(await readFile(path.join(root, ".codex", "config.toml"), "utf8"), emitted.content);
    const unchanged = await createCodexProjectConfig(root, builtEntry, true);
    assert.equal(unchanged.status, "UNCHANGED");

    await writeFile(path.join(root, ".codex", "config.toml"), "[operator_owned]\n");
    const conflict = await createCodexProjectConfig(root, builtEntry, true);
    assert.equal(conflict.status, "CONFLICT");
    assert.equal(
      await readFile(path.join(root, ".codex", "config.toml"), "utf8"),
      "[operator_owned]\n",
    );
  });

  it("compares legacy Codex configuration bytes without UTF-8 replacement equivalence", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "assertledger-byte-config-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "repository-�");
    await mkdir(root);
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-byte-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");

    const emitted = await createCodexProjectConfig(root, builtEntry, false);
    await mkdir(path.dirname(emitted.path), { recursive: true });
    const expectedBytes = Buffer.from(emitted.content, "utf8");
    const replacement = Buffer.from("�", "utf8");
    const replacementOffset = expectedBytes.indexOf(replacement);
    assert.notEqual(replacementOffset, -1);
    const malformedBytes = Buffer.concat([
      expectedBytes.subarray(0, replacementOffset),
      Buffer.from([0x80]),
      expectedBytes.subarray(replacementOffset + replacement.length),
    ]);
    await writeFile(emitted.path, malformedBytes);

    assert.equal((await createCodexProjectConfig(root, builtEntry, true)).status, "CONFLICT");
  });

  it("rejects a symlinked project configuration directory", async (context) => {
    const root = await fixtureRepository();
    const outside = await mkdtemp(path.join(os.tmpdir(), "assertledger-dx-outside-"));
    temporaryDirectories.push(outside);
    try {
      await (await import("node:fs/promises")).symlink(
        outside,
        path.join(root, ".codex"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("directory links require privileges on this host");
        return;
      }
      throw error;
    }
    const builtEntry = path.join(outside, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await assert.rejects(
      createCodexProjectConfig(root, builtEntry, true),
      /CONNECT_CONFIG_PATH_UNSAFE/u,
    );
  });

  it("rejects a linked client artifact parent before creating any sibling artifact", async (context) => {
    const root = await fixtureRepository();
    const outside = await mkdtemp(path.join(os.tmpdir(), "assertledger-client-link-outside-"));
    temporaryDirectories.push(outside);
    try {
      await symlink(
        outside,
        path.join(root, ".agents"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("directory links require privileges on this host");
        return;
      }
      throw error;
    }
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-client-link-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Fixture\n");

    const conflict = await connectClient(root, builtEntry, "codex", true);
    assert.equal(conflict.status, "CONFLICT");
    await assert.rejects(readFile(path.join(root, ".codex", "config.toml"), "utf8"), /ENOENT/u);
    await assert.rejects(
      readFile(path.join(outside, "skills", "assertledger", "SKILL.md"), "utf8"),
      /ENOENT/u,
    );
  });

  it("plans, installs, and removes byte-owned Codex and Claude Code project artifacts", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-client-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    const skill = "---\nname: assertledger\ndescription: Fixture skill.\n---\n\n# Fixture\n";
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), skill);

    for (const client of ["codex", "claude-code"] as const) {
      const preview = await connectClient(root, builtEntry, client, false);
      assert.equal(preview.status, "EMITTED");
      assert.equal(preview.artifacts.length, 2);
      for (const artifact of preview.artifacts) {
        assert.notEqual(artifact.path, null);
        if (artifact.path === null) throw new Error("expected a managed artifact path");
        await assert.rejects(readFile(artifact.path, "utf8"), /ENOENT/u);
      }

      const created = await connectClient(root, builtEntry, client, true);
      assert.equal(created.status, "CREATED");
      for (const artifact of created.artifacts) {
        assert.notEqual(artifact.path, null);
        if (artifact.path === null) throw new Error("expected a managed artifact path");
        assert.equal(await readFile(artifact.path, "utf8"), artifact.content);
      }
      assert.equal((await connectClient(root, builtEntry, client, true)).status, "UNCHANGED");

      const removalPreview = await disconnectClient(root, builtEntry, client, false);
      assert.equal(removalPreview.status, "EMITTED");
      for (const artifact of created.artifacts) {
        assert.notEqual(artifact.path, null);
        if (artifact.path === null) throw new Error("expected a managed artifact path");
        assert.equal(await readFile(artifact.path, "utf8"), artifact.content);
      }
      assert.equal((await disconnectClient(root, builtEntry, client, true)).status, "REMOVED");
      assert.equal((await disconnectClient(root, builtEntry, client, true)).status, "ABSENT");
      for (const artifact of created.artifacts) {
        assert.notEqual(artifact.path, null);
        if (artifact.path === null) throw new Error("expected a managed artifact path");
        await assert.rejects(readFile(artifact.path, "utf8"), /ENOENT/u);
      }
    }
  });

  it("refuses divergent client artifacts without partial install or removal", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-client-conflict-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(
      path.join(builtRoot, "integrations", "skill", "SKILL.md"),
      "---\nname: assertledger\n---\n",
    );

    await mkdir(path.join(root, ".agents", "skills", "assertledger"), { recursive: true });
    const skillPath = path.join(root, ".agents", "skills", "assertledger", "SKILL.md");
    await writeFile(skillPath, "operator-owned\n");
    const conflict = await connectClient(root, builtEntry, "codex", true);
    assert.equal(conflict.status, "CONFLICT");
    assert.equal(await readFile(skillPath, "utf8"), "operator-owned\n");
    await assert.rejects(readFile(path.join(root, ".codex", "config.toml"), "utf8"), /ENOENT/u);

    await writeFile(skillPath, conflict.artifacts[1]?.content ?? "");
    assert.equal((await connectClient(root, builtEntry, "codex", true)).status, "CREATED");
    await writeFile(skillPath, "changed after installation\n");
    const removalConflict = await disconnectClient(root, builtEntry, "codex", true);
    assert.equal(removalConflict.status, "CONFLICT");
    assert.equal(await readFile(skillPath, "utf8"), "changed after installation\n");
    assert.equal(
      await readFile(path.join(root, ".codex", "config.toml"), "utf8"),
      removalConflict.artifacts[0]?.content,
    );
  });

  it("compares managed skill bytes exactly and rejects unsupported runtime clients", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-client-byte-entry-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await mkdir(path.join(builtRoot, "integrations", "skill"), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");
    await writeFile(path.join(builtRoot, "integrations", "skill", "SKILL.md"), "# Skill �\n");

    const preview = await connectClient(root, builtEntry, "codex", false);
    const config = preview.artifacts[0];
    const skill = preview.artifacts[1];
    assert.ok(config !== undefined && config.path !== null);
    assert.ok(skill !== undefined && skill.path !== null);
    if (
      config === undefined ||
      config.path === null ||
      skill === undefined ||
      skill.path === null
    ) {
      throw new Error("expected managed client artifact paths");
    }
    await mkdir(path.dirname(config.path), { recursive: true });
    await mkdir(path.dirname(skill.path), { recursive: true });
    await writeFile(config.path, config.content);
    await writeFile(skill.path, Buffer.from("# Skill \x80\n", "binary"));
    assert.equal((await connectClient(root, builtEntry, "codex", true)).status, "CONFLICT");

    await assert.rejects(
      connectClient(root, builtEntry, "unsupported" as ConnectionClient, false),
      /CONNECT_CLIENT_UNSUPPORTED/u,
    );
  });

  it("emits a generic stdio descriptor without claiming a universal config path", async () => {
    const root = await fixtureRepository();
    const builtRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-generic-mcp-"));
    temporaryDirectories.push(builtRoot);
    const builtEntry = path.join(builtRoot, "dist", "cli.js");
    await mkdir(path.dirname(builtEntry), { recursive: true });
    await writeFile(builtEntry, "// fixture built entry\n");

    const result = await connectClient(root, builtEntry, "mcp", false);
    assert.equal(result.status, "EMITTED");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]?.path, null);
    const descriptor = JSON.parse(result.artifacts[0]?.content ?? "null") as {
      transport: string;
      command: string;
      args: string[];
      cwd: string;
    };
    assert.equal(descriptor.transport, "stdio");
    assert.equal(descriptor.command, process.execPath);
    assert.deepEqual(descriptor.args, [
      await realpath(builtEntry),
      "mcp",
      "--root",
      await realpath(root),
    ]);
    assert.equal(descriptor.cwd, await realpath(root));
  });

  it("rejects source-only connect and malformed client usage", async () => {
    const root = await fixtureRepository();
    for (const argv of [
      ["connect", ".", "--client", "codex"],
      ["connect", ".", "--client", "claude-code"],
      ["connect", ".", "--client", "mcp"],
      ["disconnect", ".", "--client", "codex"],
    ]) {
      const sourceCapture = captureIo(root);
      assert.equal(await runCli(argv, sourceCapture.io), 3);
      assert.match(sourceCapture.stderr(), /pnpm build/u);
      assert.equal(sourceCapture.stdout(), "");
    }

    for (const argv of [
      ["connect", "."],
      ["connect", ".", "--client"],
      ["connect", ".", "--client", "--write"],
      ["connect", ".", "--client", "claude"],
      ["connect", ".", "--client", "codex", "--unknown"],
      ["connect", ".", "--client", "codex", "--client", "codex"],
      ["connect", ".", "--client", "codex", "--write", "--write"],
      ["connect", "-x", "--client", "codex"],
      ["connect", ".", "--client", "mcp", "--write"],
      ["disconnect", ".", "--client", "mcp"],
      ["disconnect", ".", "--client", "claude"],
    ]) {
      const capture = captureIo(root);
      assert.equal(await runCli(argv, capture.io), 64);
      assert.match(capture.stderr(), /Usage: assertledger/u);
      assert.equal(capture.stdout(), "");
    }
  });

  it("rejects unknown short options before resolving repository paths", async () => {
    for (const argv of [
      ["doctor", "-x"],
      ["doctor", "--unknown"],
      ["mcp", "--root", "-x"],
    ]) {
      const capture = captureIo(process.cwd());
      assert.equal(await runCli(argv, capture.io), 64);
      assert.equal(capture.stdout(), "");
      assert.match(capture.stderr(), /Usage: assertledger/u);
    }
  });

  it("uses generated Node argv and the explicit root in a fresh read-only MCP handshake", {
    timeout: 30_000,
  }, async () => {
    const canonicalRoot = await realpath(await fixtureRepository());
    const aliasDirectory = await mkdtemp(path.join(os.tmpdir(), "assertledger-dx-root-alias-"));
    temporaryDirectories.push(aliasDirectory);
    const root = path.join(aliasDirectory, "repository");
    await symlink(canonicalRoot, root, process.platform === "win32" ? "junction" : "dir");
    // Build inside the checkout for module resolution, but under a directory that concurrent
    // whole-repository walkers exclude by default, so they never read a disappearing scratch file.
    await mkdir(path.join(process.cwd(), ".testforge"), { recursive: true });
    const buildRoot = await mkdtemp(
      path.join(process.cwd(), ".testforge", "assertledger-dx-build-"),
    );
    temporaryDirectories.push(buildRoot);
    await writeFile(
      path.join(buildRoot, "package.json"),
      JSON.stringify({
        name: "assertledger-dx-build",
        private: true,
        type: "module",
        version: "9.8.7-dx-fixture",
      }),
    );
    const outDir = path.join(buildRoot, "dist");
    const tsc = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
    await execFileAsync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", outDir], {
      cwd: process.cwd(),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const cli = path.join(outDir, "cli.js");
    const packagedSkillDirectory = path.join(buildRoot, "integrations", "skill");
    await mkdir(packagedSkillDirectory, { recursive: true });
    await writeFile(
      path.join(packagedSkillDirectory, "SKILL.md"),
      await readFile(path.join(process.cwd(), "integrations", "skill", "SKILL.md"), "utf8"),
    );
    const generic = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "mcp"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    const descriptor = JSON.parse(generic.stdout) as {
      command: string;
      args: string[];
      cwd: string;
    };
    assert.equal(descriptor.command, process.execPath);
    assert.equal(descriptor.cwd, canonicalRoot);
    assert.deepEqual(descriptor.args, [cli, "mcp", "--root", canonicalRoot]);

    const preview = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "codex"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(preview.stdout, /^EMITTED: .*\.codex.*config\.toml/mu);
    assert.match(preview.stdout, /^EMITTED: .*\.agents.*SKILL\.md/mu);
    assert.match(preview.stdout, /--- BEGIN ASSERTLEDGER CONFIGURATION ---/u);
    assert.match(preview.stdout, /^\[mcp_servers\.assertledger\]$/mu);
    assert.match(preview.stdout, /--- END ASSERTLEDGER CONFIGURATION ---/u);
    assert.match(preview.stdout, /--- BEGIN ASSERTLEDGER SKILL ---/u);
    assert.match(preview.stdout, /^# AssertLedger skill$/mu);
    assert.match(preview.stdout, /--- END ASSERTLEDGER SKILL ---/u);
    assert.match(preview.stdout, /No files changed/u);
    const codexPlan = await connectClient(root, cli, "codex", false);
    const codexValues = new Map(
      (codexPlan.artifacts[0]?.content ?? "")
        .trim()
        .split(/\r?\n/u)
        .slice(1)
        .map((line) => {
          const separator = line.indexOf(" = ");
          return [line.slice(0, separator), JSON.parse(line.slice(separator + 3))] as const;
        }),
    );

    const created = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "codex", "--write"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(created.stdout, /^CREATED: /u);
    const configPath = path.join(root, ".codex", "config.toml");
    assert.match(await readFile(configPath, "utf8"), /^\[mcp_servers\.assertledger\]$/mu);
    assert.equal(
      await readFile(path.join(root, ".agents", "skills", "assertledger", "SKILL.md"), "utf8"),
      await readFile(path.join(packagedSkillDirectory, "SKILL.md"), "utf8"),
    );
    const claudeCreated = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "claude-code", "--write"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(claudeCreated.stdout, /^CREATED: /u);
    const claudeConfig = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")) as {
      mcpServers: {
        assertledger: { command: string; args: string[]; type: string };
      };
    };
    assert.equal(claudeConfig.mcpServers.assertledger.type, "stdio");
    const unchanged = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "codex", "--write"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(unchanged.stdout, /^UNCHANGED: /u);
    await writeFile(configPath, "[operator_owned]\n");
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "connect", root, "--client", "codex", "--write"], {
        cwd: process.cwd(),
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.equal(error.code, 4);
        assert.match(error.stderr ?? "", /^CONFLICT: /u);
        return true;
      },
    );
    assert.equal(await readFile(configPath, "utf8"), "[operator_owned]\n");

    const connections = [
      descriptor,
      {
        command: codexValues.get("command") as string,
        args: codexValues.get("args") as string[],
        cwd: codexValues.get("cwd") as string,
      },
      { ...claudeConfig.mcpServers.assertledger, cwd: canonicalRoot },
    ];
    for (const connection of connections) {
      const transport = new StdioClientTransport({ ...connection, stderr: "pipe" });
      const client = new Client({ name: "assertledger-dx-test", version: "1.0.0" });
      await client.connect(transport);
      try {
        assert.equal(client.getServerVersion()?.version, "9.8.7-dx-fixture");
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === "assertledger_analyze"));
        assert.ok(!tools.tools.some((tool) => tool.name === "assertledger_verify"));
        const analyzed = await client.callTool({
          name: "assertledger_analyze",
          arguments: { root },
        });
        assert.equal(analyzed.isError, undefined);
        const outside = await mkdtemp(path.join(os.tmpdir(), "assertledger-dx-forbidden-"));
        temporaryDirectories.push(outside);
        const forbidden = await client.callTool({
          name: "assertledger_analyze",
          arguments: { root: outside },
        });
        assert.equal(forbidden.isError, true);
      } finally {
        await client.close();
      }
    }
    const disconnectPreview = await execFileAsync(
      process.execPath,
      [cli, "disconnect", root, "--client", "claude-code"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(disconnectPreview.stdout, /No files changed/u);
    const disconnected = await execFileAsync(
      process.execPath,
      [cli, "disconnect", root, "--client", "claude-code", "--write"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(disconnected.stdout, /^REMOVED: /u);
    await assert.rejects(readFile(path.join(root, ".mcp.json"), "utf8"), /ENOENT/u);
  });
});
