import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

    await assert.rejects(
      connectClient(root, builtEntry, "codex", true),
      /CONNECT_CONFIG_PATH_UNSAFE/u,
    );
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
    assert.deepEqual(descriptor.args, [builtEntry, "mcp", "--root", await realpath(root)]);
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
    await mkdir(path.join(process.cwd(), ".omx"), { recursive: true });
    const buildRoot = await mkdtemp(path.join(process.cwd(), ".omx", "assertledger-dx-build-"));
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
