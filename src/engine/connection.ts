import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_DIRECTORY = ".codex";
const CONFIG_FILE = "config.toml";

export type CodexProjectConfigStatus = "EMITTED" | "CREATED" | "UNCHANGED" | "CONFLICT";

export interface CodexProjectConfigResult {
  status: CodexProjectConfigStatus;
  path: string;
  content: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexConfig(nodeExecutable: string, cliEntry: string, root: string): string {
  const argumentsToml = [cliEntry, "mcp", "--root", root].map(tomlString).join(", ");
  return [
    "[mcp_servers.assertledger]",
    `command = ${tomlString(nodeExecutable)}`,
    `args = [${argumentsToml}]`,
    `cwd = ${tomlString(root)}`,
    "",
  ].join("\n");
}

async function existingConfigStatus(
  configPath: string,
  expectedContent: string,
): Promise<"ABSENT" | "UNCHANGED" | "CONFLICT"> {
  try {
    const metadata = await lstat(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
    }
    return (await readFile(configPath, "utf8")) === expectedContent ? "UNCHANGED" : "CONFLICT";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ABSENT";
    throw error;
  }
}

async function ensureSafeConfigDirectory(root: string, directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory);
  }
  const resolvedDirectory = await realpath(directory);
  if (
    path.dirname(resolvedDirectory) !== root ||
    path.basename(resolvedDirectory) !== CONFIG_DIRECTORY
  ) {
    throw new Error("CONNECT_CONFIG_PATH_UNSAFE");
  }
}

export async function createCodexProjectConfig(
  requestedRoot: string,
  requestedCliEntry: string,
  write: boolean,
): Promise<CodexProjectConfigResult> {
  const root = await realpath(requestedRoot);
  if (!(await stat(root)).isDirectory()) throw new Error("REPOSITORY_ROOT_NOT_DIRECTORY");
  const cliEntry = await realpath(requestedCliEntry);
  if (
    !(await stat(cliEntry)).isFile() ||
    path.basename(cliEntry) !== "cli.js" ||
    path.basename(path.dirname(cliEntry)) !== "dist"
  ) {
    throw new Error("CONNECT_BUILD_REQUIRED");
  }

  const content = codexConfig(process.execPath, cliEntry, root);
  const configDirectory = path.join(root, CONFIG_DIRECTORY);
  const configPath = path.join(configDirectory, CONFIG_FILE);
  if (!write) return { status: "EMITTED", path: configPath, content };

  await ensureSafeConfigDirectory(root, configDirectory);
  const existing = await existingConfigStatus(configPath, content);
  if (existing !== "ABSENT") return { status: existing, path: configPath, content };
  try {
    await writeFile(configPath, content, { encoding: "utf8", flag: "wx" });
    return { status: "CREATED", path: configPath, content };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await existingConfigStatus(configPath, content);
    return { status: raced === "UNCHANGED" ? "UNCHANGED" : "CONFLICT", path: configPath, content };
  }
}
