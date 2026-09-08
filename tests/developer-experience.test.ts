import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type CliIo, runCli } from "../src/cli.js";
import { parseRepositoryInitResult } from "../src/contracts/index.js";
import { createCodexProjectConfig } from "../src/engine/connection.js";
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

  it("rejects source-only connect and malformed client usage", async () => {
    const root = await fixtureRepository();
    const sourceCapture = captureIo(root);
    assert.equal(await runCli(["connect", ".", "--client", "codex"], sourceCapture.io), 3);
    assert.match(sourceCapture.stderr(), /pnpm build/u);
    assert.equal(sourceCapture.stdout(), "");

    for (const argv of [
      ["connect", "."],
      ["connect", ".", "--client"],
      ["connect", ".", "--client", "--write"],
      ["connect", ".", "--client", "claude"],
      ["connect", ".", "--client", "codex", "--unknown"],
      ["connect", ".", "--client", "codex", "--client", "codex"],
      ["connect", ".", "--client", "codex", "--write", "--write"],
      ["connect", "-x", "--client", "codex"],
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
    const root = await fixtureRepository();
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
    const generated = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "codex"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    const values = new Map(
      generated.stdout
        .trim()
        .split(/\r?\n/u)
        .slice(1)
        .map((line) => {
          const separator = line.indexOf(" = ");
          return [line.slice(0, separator), JSON.parse(line.slice(separator + 3))] as const;
        }),
    );
    assert.equal(values.get("command"), process.execPath);
    assert.equal(values.get("cwd"), root);
    assert.deepEqual(values.get("args"), [cli, "mcp", "--root", root]);

    const created = await execFileAsync(
      process.execPath,
      [cli, "connect", root, "--client", "codex", "--write"],
      { cwd: process.cwd(), timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    assert.match(created.stdout, /^CREATED: /u);
    const configPath = path.join(root, ".codex", "config.toml");
    assert.equal(await readFile(configPath, "utf8"), generated.stdout);
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

    const transport = new StdioClientTransport({
      command: values.get("command") as string,
      args: values.get("args") as string[],
      cwd: values.get("cwd") as string,
      stderr: "pipe",
    });
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
  });
});
