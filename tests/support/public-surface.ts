/** Drives the built package through its public process boundary only: the CLI as a separate
 * process, with the same call shape as the in-process `runCli`, and the MCP server over stdio.
 * Tests anchored here never reach a source module, so a later implementation of the same commands
 * and tools can be swapped in. */
import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PACKAGE_ROOT } from "./goldens.js";

const CLI_ENTRY = path.join(PACKAGE_ROOT, "dist", "cli.js");
/** A hung command fails its test instead of keeping the runner alive. */
const DEFAULT_DEADLINE_MS = 300_000;

export interface PublicCliIo {
  cwd: string;
  readStdin?(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface PublicCliOptions {
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
}

export async function runPublicCli(
  argv: readonly string[],
  io: PublicCliIo,
  options: PublicCliOptions = {},
): Promise<number> {
  const stdin = io.readStdin === undefined ? "" : await io.readStdin();
  const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
    cwd: io.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => {
    // A command that never reads stdin may exit before the write completes.
  });
  child.stdin.end(stdin);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI ${argv.join(" ")} exceeded ${deadlineMs} ms and was killed`));
    }, deadlineMs);
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve(code ?? -1);
    });
  });
  // Like the in-process writer, an empty stream is never written.
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  if (out.length > 0) io.writeStdout(out);
  if (err.length > 0) io.writeStderr(err);
  return exitCode;
}

export interface PublicMcpOptions {
  /** Passed as `--root`; the server otherwise confines itself to its working directory. */
  root?: string | undefined;
  allowUnsafeExecution?: boolean | undefined;
  cwd?: string;
  name?: string;
}

/** Starts `assertledger mcp` over stdio and returns a connected client; close it to stop the server. */
export async function connectPublicMcp(options: PublicMcpOptions = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      CLI_ENTRY,
      "mcp",
      ...(options.root === undefined ? [] : ["--root", options.root]),
      ...(options.allowUnsafeExecution === true ? ["--allow-unsafe-execution"] : []),
    ],
    cwd: options.cwd ?? process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: options.name ?? "assertledger-public-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The input schema each registered tool publishes through `tools/list`, by tool name. */
export async function listedInputSchemas(client: Client): Promise<Map<string, any>> {
  const { tools } = await client.listTools();
  return new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
}
