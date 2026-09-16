#!/usr/bin/env node
/** Record the source revision of a build for the evidence provider manifest. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function git(argumentsList: string[]): string | undefined {
  const result = spawnSync("git", argumentsList, { encoding: "utf8", windowsHide: true });
  return result.status === 0 && result.error === undefined ? result.stdout.trim() : undefined;
}

const commit = git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain", "--untracked-files=normal"]);
const sourceRevision =
  commit !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) && status !== undefined
    ? { status: "RECORDED", commit, worktree: status === "" ? "CLEAN" : "DIRTY" }
    : { status: "UNKNOWN" };

const output = path.resolve("dist", "build-info.json");
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ sourceRevision }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ buildInfo: output, sourceRevision })}\n`);
