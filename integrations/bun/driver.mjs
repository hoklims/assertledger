import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESULT_VERSION = "1.0.0";
const BUN_REVISION = "1.4.2+744846f84";
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
const PRELOAD_SOURCE_PATH = fileURLToPath(new URL("./preload.mjs", import.meta.url));

function report(outcome, testsDiscovered = 0, candidateTestsDiscovered = 0, attributed = false) {
  return {
    protocolVersion: RESULT_VERSION,
    outcome,
    testsDiscovered,
    candidateTestsDiscovered,
    attributed,
  };
}

function infrastructureFailure(reason) {
  console.error(`BUN_TEST_INFRA_ERROR:${reason}`);
  return report("INFRA_ERROR");
}

function normalizeRelativeFile(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("-") ||
    path.isAbsolute(value)
  )
    return undefined;
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeAbsoluteFile(value, root) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  const relative = path.relative(root, path.resolve(value));
  return normalizeRelativeFile(relative);
}

function strictInteger(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseJunitSummary(xml) {
  if (
    typeof xml !== "string" ||
    !xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') ||
    !xml.trimEnd().endsWith("</testsuites>") ||
    xml.includes("<!DOCTYPE")
  )
    return undefined;
  const root = xml.match(/<testsuites\b([^>]*)>/u);
  if (root === null) return undefined;
  const attributes = new Map();
  const matches = [...root[1].matchAll(/\s+([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/gu)];
  if (root[1].replace(/\s+([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/gu, "").trim() !== "") {
    return undefined;
  }
  for (const match of matches) {
    if (attributes.has(match[1])) return undefined;
    attributes.set(match[1], match[2]);
  }
  if (attributes.get("name") !== "bun test") return undefined;
  const tests = strictInteger(attributes.get("tests"));
  const failures = strictInteger(attributes.get("failures"));
  const skipped = strictInteger(attributes.get("skipped"));
  if (
    tests === undefined ||
    failures === undefined ||
    skipped === undefined ||
    failures > tests ||
    skipped > tests
  ) {
    return undefined;
  }
  return { tests, failures, skipped };
}

function parseEvents(content, root, allowedFiles) {
  if (!content.endsWith("\n")) return undefined;
  const lines = content.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const events = [];
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(value.id)
    ) {
      return undefined;
    }
    if (value.kind === "found") {
      if (Object.keys(value).sort().join(",") !== "file,id,kind") return undefined;
      const file = normalizeAbsoluteFile(value.file, root);
      if (file === undefined || !allowedFiles.has(file)) return undefined;
      events.push({ kind: "found", id: value.id, file });
    } else if (value.kind === "end") {
      if (value.status !== "pass" && value.status !== "fail") return undefined;
      const expectedKeys = value.status === "pass" ? "id,kind,status" : "id,kind,owned,status";
      if (Object.keys(value).sort().join(",") !== expectedKeys) return undefined;
      if (value.status === "fail" && typeof value.owned !== "boolean") return undefined;
      events.push({ kind: "end", id: value.id, status: value.status, owned: value.owned ?? false });
    } else return undefined;
  }
  return events;
}

export function classifyBunInstrumentedEvidence(
  events,
  junit,
  baseFiles,
  candidateFiles,
  exitCode,
  operationalError = false,
) {
  if (
    events === undefined ||
    junit === undefined ||
    exitCode === null ||
    junit.skipped !== 0 ||
    operationalError
  ) {
    return infrastructureFailure("INCOMPLETE_CONTROLLED_REPORT");
  }
  const found = new Map();
  const ended = new Map();
  for (const event of events) {
    if (event.kind === "found") {
      if (found.has(event.id)) return infrastructureFailure("DUPLICATE_TEST_ID");
      found.set(event.id, event.file);
    } else {
      if (!found.has(event.id)) return infrastructureFailure("UNMATCHED_TEST_END");
      const completions = ended.get(event.id) ?? [];
      completions.push(event);
      ended.set(event.id, completions);
    }
  }
  const completed = [...ended.values()].flat();
  if (found.size === 0 || found.size !== ended.size || completed.length !== junit.tests) {
    return infrastructureFailure("TEST_COUNT_MISMATCH");
  }
  const files = new Set(found.values());
  if ([...baseFiles].some((file) => !files.has(file))) {
    return infrastructureFailure("BASE_TEST_FILE_NOT_STARTED");
  }
  if ([...files].some((file) => !baseFiles.has(file) && !candidateFiles.has(file))) {
    return infrastructureFailure("UNEXPECTED_TEST_FILE");
  }
  const failures = completed.filter((entry) => entry.status === "fail");
  if (failures.length !== junit.failures || (exitCode === 0) !== (junit.failures === 0)) {
    return infrastructureFailure("BUN_STATUS_MISMATCH");
  }
  const candidateIds = completed
    .filter((entry) => candidateFiles.has(found.get(entry.id)))
    .map((entry) => entry.id);
  if (exitCode === 0) {
    return candidateFiles.size > 0 && candidateIds.length === 0
      ? report("NO_TEST_DISCOVERED", completed.length, 0, false)
      : report("PASS", completed.length, candidateIds.length, candidateFiles.size > 0);
  }
  const candidateFailures = failures.filter((entry) => candidateFiles.has(found.get(entry.id)));
  const baseFailures = failures.filter((entry) => baseFiles.has(found.get(entry.id)));
  if (baseFailures.length > 0 || candidateIds.length === 0) {
    return report("PROCESS_CRASH", completed.length, candidateIds.length, false);
  }
  const attributed =
    failures.length === 1 && candidateFailures.length === 1 && candidateFailures[0].owned;
  return report(
    attributed ? "ASSERTION_FAILURE" : "PROCESS_CRASH",
    completed.length,
    candidateIds.length,
    attributed,
  );
}

async function readBoundedRegularFile(file, root) {
  const details = await lstat(file);
  if (!details.isFile() || details.size > MAX_REPORT_BYTES) throw new Error("INVALID_REPORT_FILE");
  const resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("REPORT_PATH_ESCAPE");
  }
  return readFile(file, "utf8");
}

async function installHelper(helperSource, root) {
  const packageRoot = path.join(root, "node_modules", "assertledger");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "bun.mjs"), helperSource, { flag: "wx" });
  await writeFile(
    path.join(packageRoot, "preload.mjs"),
    await readFile(PRELOAD_SOURCE_PATH, "utf8"),
    { flag: "wx" },
  );
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "assertledger", type: "module", exports: { "./bun": "./bun.mjs" } }, null, 2)}\n`,
    { flag: "wx" },
  );
}

async function runBun(executable, files, eventFile, junitFile, root) {
  const exactPath = (file) => `./${file.replaceAll(path.sep, "/")}`;
  const child = spawn(
    executable,
    [
      "test",
      "--max-concurrency=1",
      "--retry=0",
      "--preload",
      "./node_modules/assertledger/preload.mjs",
      "--reporter=junit",
      `--reporter-outfile=${junitFile}`,
      ...files.map(exactPath),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ASSERTLEDGER_BUN_ROOT: root,
        ASSERTLEDGER_BUN_EVENTS_FILE: eventFile,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let outputBytes = 0;
  let overflow = false;
  let stderr = "";
  const collect = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      overflow = true;
      child.kill();
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", (chunk) => {
    collect(chunk);
    if (!overflow) stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  const plainStderr = stderr.replace(ANSI_SGR, "");
  const operationalError =
    plainStderr.includes("Unhandled error between tests") ||
    /(?:^|\r?\n)\s*[1-9][0-9]*\s+errors?\s*(?:\r?\n|$)/u.test(plainStderr);
  return { exitCode: overflow ? null : exitCode, operationalError };
}

async function main() {
  const root = await realpath(process.cwd());
  const resultFile = process.env.TESTFORGE_RESULT_FILE;
  if (typeof resultFile !== "string" || resultFile.length === 0)
    throw new Error("RESULT_FILE_REQUIRED");
  const [executable, helperSourcePath, ...baseTests] = process.argv.slice(2);
  if (
    !path.isAbsolute(executable ?? "") ||
    !path.isAbsolute(helperSourcePath ?? "") ||
    baseTests.length === 0
  ) {
    throw new Error("INVALID_ARGUMENTS");
  }
  const revision = spawnSync(executable, ["--revision"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (revision.status !== 0 || revision.stderr !== "" || revision.stdout.trim() !== BUN_REVISION) {
    throw new Error("UNSUPPORTED_BUN_REVISION");
  }
  const candidates = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");
  if (!Array.isArray(candidates)) throw new Error("INVALID_CANDIDATES");
  const normalizedBase = baseTests.map(normalizeRelativeFile);
  const normalizedCandidates = candidates.map(normalizeRelativeFile);
  if ([...normalizedBase, ...normalizedCandidates].some((file) => file === undefined)) {
    throw new Error("INVALID_PATH");
  }
  const files = [...normalizedBase, ...normalizedCandidates];
  if (new Set(files).size !== files.length) throw new Error("DUPLICATE_TEST_FILE");
  await installHelper(await readFile(helperSourcePath, "utf8"), root);
  const eventFile = path.join(root, `__assertledger_bun_events_${randomUUID()}.jsonl`);
  const junitFile = path.join(root, `__assertledger_bun_junit_${randomUUID()}.xml`);
  await writeFile(eventFile, "", { flag: "wx" });
  const execution = await runBun(
    executable,
    [...baseTests, ...candidates],
    eventFile,
    junitFile,
    root,
  );
  let outcome;
  try {
    const eventContent = await readBoundedRegularFile(eventFile, root);
    const junitContent = await readBoundedRegularFile(junitFile, root);
    const allowed = new Set(files);
    outcome = classifyBunInstrumentedEvidence(
      parseEvents(eventContent, root, allowed),
      parseJunitSummary(junitContent),
      new Set(normalizedBase),
      new Set(normalizedCandidates),
      execution.exitCode,
      execution.operationalError,
    );
  } catch {
    outcome = infrastructureFailure("MISSING_OR_INVALID_REPORT");
  }
  await writeFile(resultFile, `${JSON.stringify(outcome)}\n`, { flag: "wx" });
  process.exitCode = outcome.outcome === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : "UNKNOWN_DRIVER_ERROR");
    try {
      const resultFile = process.env.TESTFORGE_RESULT_FILE;
      if (typeof resultFile === "string" && resultFile.length > 0) {
        await writeFile(resultFile, `${JSON.stringify(report("INFRA_ERROR"))}\n`, { flag: "wx" });
      }
    } catch {}
    process.exitCode = 1;
  });
}
