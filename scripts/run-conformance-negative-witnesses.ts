#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REPOSITORY = path.resolve(".");
const SOURCE_CONFORMANCE = path.join(REPOSITORY, "conformance");
const SOURCE_SCHEMAS = path.join(REPOSITORY, "schemas");
const SOURCE_SCRIPTS = path.join(REPOSITORY, "scripts");
const SOURCE_SRC = path.join(REPOSITORY, "src");
const TSX = path.join(REPOSITORY, "node_modules", "tsx", "dist", "cli.mjs");
const NON_KILL_CASES = [
  {
    slug: "compile-failure",
    outcome: "COMPILE_FAILURE",
    witnessId: "NON_KILL_SEMANTIC_ASSERTION_COMPILE_FAILURE",
  },
  {
    slug: "collection-failure",
    outcome: "COLLECTION_FAILURE",
    witnessId: "NON_KILL_SEMANTIC_ASSERTION_COLLECTION_FAILURE",
  },
  {
    slug: "timeout",
    outcome: "TIMEOUT",
    witnessId: "NON_KILL_SEMANTIC_ASSERTION_TIMEOUT",
  },
  {
    slug: "process-crash",
    outcome: "PROCESS_CRASH",
    witnessId: "NON_KILL_SEMANTIC_ASSERTION_PROCESS_CRASH",
  },
  {
    slug: "infra-error",
    outcome: "INFRA_ERROR",
    witnessId: "NON_KILL_SEMANTIC_ASSERTION_INFRA_ERROR",
  },
  {
    slug: "no-test-discovered",
    outcome: "NO_TEST_DISCOVERED",
    witnessId: "NON_KILL_SEMANTIC_ASSERTION_NO_TEST_DISCOVERED",
  },
] as const;

interface CommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function outputDigest(result: CommandResult): string {
  return sha256(Buffer.concat([result.stdout, Buffer.from([0]), result.stderr]));
}

function ensureOutsideRepository(target: string): void {
  const relative = path.relative(REPOSITORY, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("WITNESS_TARGET_INSIDE_REPOSITORY");
  }
}

async function copyCandidate(target: string): Promise<void> {
  ensureOutsideRepository(target);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(SOURCE_CONFORMANCE, path.join(target, "conformance"), { recursive: true }),
    cp(SOURCE_SCHEMAS, path.join(target, "schemas"), { recursive: true }),
    cp(SOURCE_SRC, path.join(target, "src"), { recursive: true }),
    cp(path.join(REPOSITORY, "package.json"), path.join(target, "package.json")),
  ]);
  await mkdir(path.join(target, "scripts"), { recursive: true });
  await Promise.all([
    cp(
      path.join(SOURCE_SCRIPTS, "check-conformance-v1.ts"),
      path.join(target, "scripts", "check-conformance-v1.ts"),
    ),
    cp(
      path.join(SOURCE_SCRIPTS, "conformance-v1-lock.ts"),
      path.join(target, "scripts", "conformance-v1-lock.ts"),
    ),
  ]);
  await symlink(
    path.join(REPOSITORY, "node_modules"),
    path.join(target, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function runChecker(target: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...environment } = process.env;
    const child = spawn(
      process.execPath,
      [TSX, path.join(target, "scripts", "check-conformance-v1.ts")],
      {
        cwd: target,
        env: { ...environment, NO_COLOR: "1" },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("WITNESS_CHECKER_TIMEOUT"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function lockedEntries(target: string) {
  const root = path.join(target, "conformance", "v1");
  async function walk(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await import("node:fs/promises").then(({ readdir }) =>
      readdir(directory, { withFileTypes: true }),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(absolute)));
      else if (entry.isFile()) files.push(absolute);
      else throw new Error("WITNESS_SPECIAL_FILE_FORBIDDEN");
    }
    return files;
  }
  const entries = [];
  for (const absolute of await walk(root)) {
    const bytes = await readFile(absolute);
    entries.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      digest: sha256(bytes),
    });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const rootHash = createHash("sha256");
  for (const entry of entries) rootHash.update(`${entry.path}\0${entry.digest}\n`);
  return { entries, rootDigest: `sha256:${rootHash.digest("hex")}` };
}

async function replaceLockLiteral(target: string, before: string, after: string): Promise<void> {
  const lockPath = path.join(target, "scripts", "conformance-v1-lock.ts");
  const source = await readFile(lockPath, "utf8");
  if (!source.includes(before)) throw new Error(`WITNESS_LOCK_LITERAL_MISSING: ${before}`);
  await writeFile(lockPath, source.replace(before, after), "utf8");
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "testforge-conformance-witness-"));
  ensureOutsideRepository(temporaryRoot);
  let removed = false;
  try {
    await copyCandidate(temporaryRoot);
    const initialGreen = await runChecker(temporaryRoot);
    if (initialGreen.exitCode !== 0) throw new Error("WITNESS_INITIAL_GREEN_FAILED");

    const rawPath = "inputs/canonical-order-a.json";
    const rawAbsolute = path.join(temporaryRoot, "conformance", "v1", rawPath);
    const rawBefore = await readFile(rawAbsolute);
    const rawAfter = Buffer.from(rawBefore.toString("utf8").replace('"z": 1', '"z": 2'));
    if (rawAfter.equals(rawBefore)) throw new Error("WITNESS_RAW_MUTATION_FAILED");
    await writeFile(rawAbsolute, rawAfter);
    const rawRed = await runChecker(temporaryRoot);
    if (rawRed.exitCode === 0) throw new Error("WITNESS_RAW_MUTATION_UNDETECTED");

    const sourceLock = await readFile(
      path.join(REPOSITORY, "scripts", "conformance-v1-lock.ts"),
      "utf8",
    );
    const canonicalRootDigest = (await import("./conformance-v1-lock.js"))
      .CONFORMANCE_V1_ROOT_DIGEST;
    const verifiedExpected = await readFile(
      path.join(REPOSITORY, "conformance", "v1", "expected", "decide-verified.json"),
    );
    const expectedNewDigest = sha256(verifiedExpected);
    const semanticWitnesses = [];
    for (const semanticCase of NON_KILL_CASES) {
      await copyCandidate(temporaryRoot);
      const semanticInputPath = `inputs/decide-${semanticCase.slug}-non-kill.json`;
      const semanticExpectedPath = `expected/decide-${semanticCase.slug}-non-kill.json`;
      const semanticInputAbsolute = path.join(
        temporaryRoot,
        "conformance",
        "v1",
        semanticInputPath,
      );
      const semanticExpectedAbsolute = path.join(
        temporaryRoot,
        "conformance",
        "v1",
        semanticExpectedPath,
      );
      const semanticInputBefore = await readFile(semanticInputAbsolute);
      const semanticExpectedBefore = await readFile(semanticExpectedAbsolute);
      const semanticInputAfter = Buffer.from(
        semanticInputBefore
          .toString("utf8")
          .replace(`"outcome": "${semanticCase.outcome}"`, '"outcome": "ASSERTION_FAILURE"'),
      );
      if (semanticInputAfter.equals(semanticInputBefore)) {
        throw new Error(`WITNESS_SEMANTIC_INPUT_MUTATION_FAILED: ${semanticCase.outcome}`);
      }
      await Promise.all([
        writeFile(semanticInputAbsolute, semanticInputAfter),
        writeFile(semanticExpectedAbsolute, verifiedExpected),
      ]);
      const relocked = await lockedEntries(temporaryRoot);
      const inputOldDigest = sha256(semanticInputBefore);
      const expectedOldDigest = sha256(semanticExpectedBefore);
      const inputNewDigest = sha256(semanticInputAfter);
      if (!sourceLock.includes(inputOldDigest) || !sourceLock.includes(expectedOldDigest)) {
        throw new Error(`WITNESS_SOURCE_LOCK_MISMATCH: ${semanticCase.outcome}`);
      }
      await replaceLockLiteral(temporaryRoot, inputOldDigest, inputNewDigest);
      await replaceLockLiteral(temporaryRoot, expectedOldDigest, expectedNewDigest);
      await replaceLockLiteral(temporaryRoot, canonicalRootDigest, relocked.rootDigest);
      const semanticRed = await runChecker(temporaryRoot);
      if (semanticRed.exitCode === 0) {
        throw new Error(`WITNESS_SEMANTIC_MUTATION_UNDETECTED: ${semanticCase.outcome}`);
      }
      const expectedMarker = `CONFORMANCE_NON_KILL_ASSERTION_FAILED:decide-${semanticCase.slug}-non-kill`;
      if (!semanticRed.stderr.toString("utf8").includes(expectedMarker)) {
        throw new Error(`WITNESS_SEMANTIC_FAILURE_CAUSE_MISMATCH: ${semanticCase.outcome}`);
      }
      semanticWitnesses.push({
        id: semanticCase.witnessId,
        preRawDigests: {
          [semanticInputPath]: inputOldDigest,
          [semanticExpectedPath]: expectedOldDigest,
        },
        postRawDigests: {
          [semanticInputPath]: inputNewDigest,
          [semanticExpectedPath]: expectedNewDigest,
        },
        redExitCode: semanticRed.exitCode,
        redOutputDigest: outputDigest(semanticRed),
      });
    }

    await copyCandidate(temporaryRoot);
    const finalGreen = await runChecker(temporaryRoot);
    if (finalGreen.exitCode !== 0) throw new Error("WITNESS_FINAL_GREEN_FAILED");

    await rm(temporaryRoot, { recursive: true, force: true });
    removed = true;
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        status: "NEGATIVE_WITNESSES_VALID",
        witnesses: [
          {
            id: "RAW_FIXTURE_DIGEST_MUTATION",
            preRawDigests: { [rawPath]: sha256(rawBefore) },
            postRawDigests: { [rawPath]: sha256(rawAfter) },
            redExitCode: rawRed.exitCode,
            redOutputDigest: outputDigest(rawRed),
            greenExitCode: initialGreen.exitCode,
            greenOutputDigest: outputDigest(initialGreen),
          },
          ...semanticWitnesses.map((witness) => ({
            ...witness,
            greenExitCode: finalGreen.exitCode,
            greenOutputDigest: outputDigest(finalGreen),
          })),
        ],
        temporaryDirectory: { kind: "OS_TEMP", removed },
      })}\n`,
    );
  } finally {
    if (!removed) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
