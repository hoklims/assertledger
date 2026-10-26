/** Runs the frozen CLI and MCP golden cases against the built package entry, as a separate process.
 * Goldens describe the public process boundary only: argv, standard streams, exit code and MCP
 * messages. They never import source modules, so a later implementation can be swapped in. */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GOLDEN_ROOT = path.join(PACKAGE_ROOT, "tests", "goldens");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "dist", "cli.js");

export interface CliGoldenCase {
  id: string;
  argv: string[];
  /** Fixture copied to a fresh temporary directory used as the working directory. */
  fixture?: string;
  stdin?: string;
}

export interface McpCall {
  method: "tools/list" | "tools/call";
  params?: Record<string, unknown>;
}

export interface McpGoldenCase {
  id: string;
  /** Arguments after `mcp`; `--root .` is resolved from the fixture working directory. */
  argv: string[];
  fixture?: string;
  calls: McpCall[];
}

export interface GoldenCases {
  cli: CliGoldenCase[];
  mcp: McpGoldenCase[];
}

export interface CliGolden {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface McpGolden {
  serverVersion: unknown;
  protocolVersion: string | undefined;
  responses: unknown[];
}

export async function loadCases(): Promise<GoldenCases> {
  return JSON.parse(await readFile(path.join(GOLDEN_ROOT, "cases.json"), "utf8")) as GoldenCases;
}

export function goldenPath(surface: "cli" | "mcp", id: string): string {
  return path.join(GOLDEN_ROOT, surface, `${id}.json`);
}

interface Workspace {
  cwd: string;
  dispose(): Promise<void>;
}

async function prepareWorkspace(fixture: string | undefined): Promise<Workspace> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assertledger-golden-"));
  const cwd = path.join(directory, "repository");
  if (fixture === undefined) {
    await mkdir(cwd);
  } else {
    await cp(path.join(PACKAGE_ROOT, fixture), cwd, { recursive: true });
  }
  return { cwd, dispose: () => rm(directory, { recursive: true, force: true }) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches an absolute path whatever its separator or JSON escaping depth. */
function pathPattern(absolute: string): RegExp {
  const segments = absolute.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const prefix = absolute.startsWith("/") ? "/" : "";
  return new RegExp(
    escapeRegExp(prefix) + segments.map(escapeRegExp).join("(?:\\\\+|/)"),
    process.platform === "win32" ? "gi" : "g",
  );
}

/** The only normalizations applied to observed output. Each one removes a value that depends on
 * the machine, the checkout or the release number, never on the behavior under test. */
export async function normalizer(cwd: string): Promise<(text: string) => string> {
  const placeholders: Array<[string, string]> = [];
  for (const [placeholder, value] of [
    ["<FIXTURE>", cwd],
    ["<PACKAGE>", PACKAGE_ROOT],
    ["<NODE>", process.execPath],
  ] as const) {
    placeholders.push([placeholder, value]);
    placeholders.push([placeholder, await realpath(value)]);
  }
  placeholders.sort((left, right) => right[1].length - left[1].length);
  const version = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"))
    .version as string;
  return (text) => {
    let normalized = text;
    for (const [placeholder, value] of placeholders) {
      normalized = normalized.replace(pathPattern(value), placeholder);
    }
    return (
      normalized
        // Separators after a placeholder, whatever the platform or escaping depth.
        // A separator counts only when a path segment follows it, so escaped quotes are kept.
        .replace(/(<(?:FIXTURE|PACKAGE|NODE)>)((?:(?:\\+|\/)[\w.@-]+)*)/g, (_match, head, tail) => {
          return head + tail.replace(/\\+/g, "/");
        })
        // Release number of the package itself, not of any contract, at any escaping depth.
        .replace(
          new RegExp(
            `(\\\\*")name\\1:\\1assertledger\\1,\\1version\\1:\\1(?:${escapeRegExp(version)})\\1`,
            "g",
          ),
          "$1name$1:$1assertledger$1,$1version$1:$1<VERSION>$1",
        )
        .replaceAll(`assertledger ${version}\n`, "assertledger <VERSION>\n")
        // Build provenance recorded by scripts/write-build-info.ts, at any escaping depth.
        .replace(/(\\*")sourceRevision\1:\{[^{}]*\}/g, "$1sourceRevision$1:$1<SOURCE_REVISION>$1")
        // The provider manifest digest covers the two values above, so it varies with them too.
        // Only an output that carried a provider revision has it replaced.
        .replace(/(\\*")manifestDigest\1:\1sha256:[0-9a-f]{64}\1/g, (match, quote) =>
          normalized.includes("sourceRevision")
            ? `${quote}manifestDigest${quote}:${quote}<PROVIDER_MANIFEST_DIGEST>${quote}`
            : match,
        )
    );
  };
}

/** Only what a process needs to start; the caller's terminal and color settings never leak in. */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  const inherited = ["PATH", "Path", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"];
  return Object.fromEntries(
    inherited.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export async function runCliCase(testCase: CliGoldenCase): Promise<CliGolden> {
  const workspace = await prepareWorkspace(testCase.fixture);
  try {
    const normalize = await normalizer(workspace.cwd);
    const child = spawn(process.execPath, [CLI_ENTRY, ...testCase.argv], {
      cwd: workspace.cwd,
      env: isolatedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(testCase.stdin ?? "");
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
    return {
      exitCode,
      stdout: normalize(Buffer.concat(stdout).toString("utf8")),
      stderr: normalize(Buffer.concat(stderr).toString("utf8")),
    };
  } finally {
    await workspace.dispose();
  }
}

export async function runMcpCase(testCase: McpGoldenCase): Promise<McpGolden> {
  const workspace = await prepareWorkspace(testCase.fixture);
  try {
    const normalize = await normalizer(workspace.cwd);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRY, "mcp", ...testCase.argv],
      cwd: workspace.cwd,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "assertledger-golden", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 5_000 } } },
    );
    await client.connect(transport);
    try {
      const responses: unknown[] = [];
      for (const call of testCase.calls) {
        const response = await client
          .request({ method: call.method, params: call.params ?? {} } as never)
          .then(
            (result: unknown) => ({ result }),
            (error: { code?: unknown; message?: unknown; data?: unknown }) => ({
              error: { code: error.code, message: error.message, data: error.data },
            }),
          );
        responses.push(JSON.parse(normalize(JSON.stringify(response))));
      }
      return {
        serverVersion: JSON.parse(normalize(JSON.stringify(client.getServerVersion()))),
        protocolVersion: client.getNegotiatedProtocolVersion(),
        responses,
      };
    } finally {
      await client.close();
    }
  } finally {
    await workspace.dispose();
  }
}
