import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESULT_VERSION = "1.0.0";
const BUN_REVISION = "1.4.3+c6da4a4d3";
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
  // Bun reports a per-test timeout as a TimeoutError failure, even when the callback threw later.
  const timeouts = [...xml.matchAll(/<failure\b[^>]*\btype="TimeoutError"/gu)].length;
  if (timeouts > failures) return undefined;
  return { tests, failures, skipped, timeouts };
}

function parseEvents(content, root, allowedFiles, evidenceKey, designated = false) {
  if (!content.endsWith("\n")) return undefined;
  const lines = content.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const events = [];
  for (const line of lines) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(",") !== "event,mac" ||
      typeof envelope.mac !== "string" ||
      !/^[0-9a-f]{64}$/u.test(envelope.mac)
    )
      return undefined;
    const expectedMac = createHmac("sha256", evidenceKey)
      .update(JSON.stringify(envelope.event))
      .digest();
    if (!timingSafeEqual(expectedMac, Buffer.from(envelope.mac, "hex"))) return undefined;
    const value = envelope.event;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    if (value.kind === "hook-error") {
      if (Object.keys(value).join(",") !== "kind") return undefined;
      events.push({ kind: "hook-error" });
      continue;
    }
    if (value.kind === "registered") {
      if (!designated || Object.keys(value).sort().join(",") !== "designated,file,kind") {
        return undefined;
      }
      const file = normalizeAbsoluteFile(value.file, root);
      if (file === undefined || !allowedFiles.has(file) || !Number.isSafeInteger(value.designated))
        return undefined;
      events.push({ kind: "registered", file, designated: value.designated });
      continue;
    }
    if (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/u.test(value.id)) {
      return undefined;
    }
    if (value.kind === "found") {
      const expectedKeys = designated ? "designated,file,id,kind" : "file,id,kind";
      if (Object.keys(value).sort().join(",") !== expectedKeys) return undefined;
      if (designated && typeof value.designated !== "boolean") return undefined;
      const file = normalizeAbsoluteFile(value.file, root);
      if (file === undefined || !allowedFiles.has(file)) return undefined;
      events.push({ kind: "found", id: value.id, file, designated: value.designated === true });
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
    operationalError ||
    events.some((event) => event.kind === "hook-error")
  ) {
    return infrastructureFailure("INCOMPLETE_CONTROLLED_REPORT");
  }
  // A test Bun timed out is never assertion evidence, whatever its callback threw afterwards.
  if (junit.timeouts > 0) return infrastructureFailure("BUN_TEST_TIMEOUT");
  const found = new Map();
  const ended = new Map();
  for (const event of events) {
    if (event.kind === "found") {
      if (found.has(event.id)) return infrastructureFailure("DUPLICATE_TEST_ID");
      found.set(event.id, event.file);
    } else {
      if (!found.has(event.id)) return infrastructureFailure("UNMATCHED_TEST_END");
      if (ended.has(event.id)) return infrastructureFailure("DUPLICATE_TEST_END");
      ended.set(event.id, event);
    }
  }
  const completed = [...ended.values()];
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
    candidateFailures.length > 0 &&
    failures.length === candidateFailures.length &&
    candidateFailures.every((entry) => entry.owned);
  return report(
    attributed ? "ASSERTION_FAILURE" : "PROCESS_CRASH",
    completed.length,
    candidateIds.length,
    attributed,
  );
}

/**
 * Loads designated files without registering a test. Success proves that each file and every module
 * it imports evaluate in this world and that each designated test is registered exactly once.
 */
export function classifyBunDesignatedLoad(
  events,
  junit,
  designatedCount,
  exitCode,
  operationalError,
) {
  if (
    events === undefined ||
    exitCode !== 0 ||
    operationalError ||
    (junit !== undefined && junit.tests !== 0) ||
    events.some((event) => event.kind !== "registered")
  ) {
    return infrastructureFailure("DESIGNATED_LOAD_INCOMPLETE");
  }
  for (let index = 0; index < designatedCount; index += 1) {
    const matches = events.filter((event) => event.designated === index).length;
    if (matches === 0) return report("NO_TEST_DISCOVERED", events.length, 0, false);
    if (matches > 1) return infrastructureFailure("DESIGNATED_TEST_AMBIGUOUS");
  }
  if (events.some((event) => event.designated < -1 || event.designated >= designatedCount)) {
    return infrastructureFailure("DESIGNATED_TEST_INDEX_INVALID");
  }
  return report("PASS", events.length, 0, false);
}

/**
 * Runs exactly one designated test. Only its owned assertion failure, with the expected first line
 * when one is declared, is an assertion; no matching test is never a failure.
 */
export function classifyBunDesignatedRun(events, junit, exitCode, operationalError) {
  if (
    events === undefined ||
    junit === undefined ||
    exitCode === null ||
    operationalError ||
    events.some((event) => event.kind === "hook-error" || event.kind === "registered")
  ) {
    return infrastructureFailure("INCOMPLETE_CONTROLLED_REPORT");
  }
  // A test Bun timed out is never assertion evidence, whatever its callback threw afterwards.
  if (junit.timeouts > 0) return infrastructureFailure("BUN_TEST_TIMEOUT");
  const found = new Map();
  const ended = new Map();
  for (const event of events) {
    if (event.kind === "found") {
      if (found.has(event.id)) return infrastructureFailure("DUPLICATE_TEST_ID");
      found.set(event.id, event);
    } else {
      if (!found.has(event.id)) return infrastructureFailure("UNMATCHED_TEST_END");
      if (ended.has(event.id)) return infrastructureFailure("DUPLICATE_TEST_END");
      ended.set(event.id, event);
    }
  }
  if (found.size !== ended.size || found.size !== junit.tests - junit.skipped) {
    return infrastructureFailure("TEST_COUNT_MISMATCH");
  }
  if (found.size === 0) {
    return junit.failures === 0 && exitCode !== 0
      ? report("NO_TEST_DISCOVERED", 0, 0, false)
      : infrastructureFailure("BUN_STATUS_MISMATCH");
  }
  if ([...found.values()].some((event) => !event.designated)) {
    return infrastructureFailure("UNEXPECTED_TEST");
  }
  if (found.size !== 1) return infrastructureFailure("DESIGNATED_TEST_AMBIGUOUS");
  const [end] = ended.values();
  const failed = end.status === "fail";
  if (junit.failures !== (failed ? 1 : 0) || (exitCode === 0) === failed) {
    return infrastructureFailure("BUN_STATUS_MISMATCH");
  }
  if (!failed) return report("PASS", 1, 1, true);
  return end.owned ? report("ASSERTION_FAILURE", 1, 1, true) : report("PROCESS_CRASH", 1, 1, false);
}

function escapeRegularExpression(value) {
  return value.replace(/[\\^$.*+?()[\]{}|/-]/gu, "\\$&");
}

const GENERATED_CONFIG_PREFIX = "__assertledger_bunfig_";
const TEST_TABLE_HEADER = /^\s*\[\s*test\s*\]\s*(?:#.*)?$/u;
const TABLE_HEADER = /^\s*\[/u;
const TEST_PRELOAD = /^\s*preload\s*=(.*)$/u;
// Spellings that could set test.preload without the plain key inside a [test] table.
const INDIRECT_TEST_PRELOAD =
  /^\s*(?:(?:test|"test"|'test')\s*\.\s*(?:preload|"preload"|'preload')\s*=|["']?test["']?\s*=|\[\s*["']test["']\s*\]|["']preload["']\s*=)/u;

function unsupportedConfig() {
  return new Error("BUNFIG_TEST_PRELOAD_UNSUPPORTED");
}

/** The strings of a one-line TOML array or string, or undefined when it is anything else. */
function parsePreloadValue(raw) {
  let rest = raw.trim();
  const strings = [];
  const array = rest.startsWith("[");
  if (array) rest = rest.slice(1).trimStart();
  for (;;) {
    if (array && rest.startsWith("]")) {
      rest = rest.slice(1);
      break;
    }
    const basic = /^"((?:[^"\\\p{Cc}]|\\["\\btnfr]|\\u[0-9A-Fa-f]{4})*)"/u.exec(rest);
    const literal = basic === null ? /^'([^'\p{Cc}]*)'/u.exec(rest) : null;
    if (basic === null && literal === null) return undefined;
    strings.push(basic === null ? literal[1] : JSON.parse(`"${basic[1]}"`));
    rest = rest.slice((basic ?? literal)[0].length).trimStart();
    if (!array) break;
    if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
    else if (!rest.startsWith("]")) return undefined;
  }
  return /^\s*(?:#.*)?$/u.test(rest) ? strings : undefined;
}

/**
 * The bunfig a designated run uses: the repository's own, read from the working directory, whose
 * [test] preload list starts with AssertLedger's preload and then keeps every repository preload in
 * order. `bun test --config` reads only this file, so the repository preloads run once, after the
 * instrumentation has recorded Bun's own matchers. A preload set any other way is refused.
 */
export function designatedBunConfig(source, preload) {
  const entry = JSON.stringify(preload);
  if (source === undefined) return `[test]\npreload = [${entry}]\n`;
  const lines = source.split(/\r?\n/u);
  let inTest = false;
  let header = -1;
  let assignment = -1;
  let assignmentEnd = -1;
  let preloads = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (INDIRECT_TEST_PRELOAD.test(line)) throw unsupportedConfig();
    if (TABLE_HEADER.test(line)) {
      inTest = TEST_TABLE_HEADER.test(line);
      if (inTest) {
        if (header >= 0) throw unsupportedConfig();
        header = index;
      }
      continue;
    }
    const match = inTest ? TEST_PRELOAD.exec(line) : null;
    if (match === null) continue;
    if (assignment >= 0) throw unsupportedConfig();
    // An array may continue over the following lines; it ends on the first line that parses.
    let value = match[1];
    let end = index;
    let parsed = parsePreloadValue(value);
    while (parsed === undefined && value.trim().startsWith("[") && end + 1 < lines.length) {
      end += 1;
      if (TABLE_HEADER.test(lines[end]) && !/^\s*\[\s*["']/u.test(lines[end])) break;
      value = `${value} ${lines[end].replace(/^\s*#.*$/u, "")}`;
      parsed = parsePreloadValue(value);
    }
    if (parsed === undefined) throw unsupportedConfig();
    assignment = index;
    assignmentEnd = end;
    preloads = parsed;
    index = end;
  }
  const replacement = `preload = [${[entry, ...preloads.map((value) => JSON.stringify(value))].join(", ")}]`;
  if (assignment >= 0) lines.splice(assignment, assignmentEnd - assignment + 1, replacement);
  else if (header >= 0) lines.splice(header + 1, 0, replacement);
  else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    lines.push(...(lines.length > 0 ? [""] : []), "[test]", replacement);
  }
  return `${lines.join("\n").replace(/\n*$/u, "")}\n`;
}

/** A `/`-separated directory relative to the root, "." for the root itself. */
function normalizeWorkingDirectory(value) {
  if (value === ".") return ".";
  return normalizeRelativeFile(value);
}

function validTrustedMatchers(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Object.keys(entry).sort().join(",") === "matchers,path" &&
        normalizeWorkingDirectory(entry.path) !== undefined &&
        Array.isArray(entry.matchers) &&
        entry.matchers.length > 0 &&
        entry.matchers.every(
          (name) => typeof name === "string" && /^[A-Za-z_$][\w$]*$/u.test(name),
        ),
    )
  );
}

/** Validates a designated selection against the files the driver was asked to load or run. */
function parseDesignatedSelection(value, files) {
  if (value === undefined) return undefined;
  const selection = JSON.parse(value);
  const validTest = (test) =>
    typeof test === "object" &&
    test !== null &&
    Object.keys(test).sort().join(",") === "file,path" &&
    normalizeRelativeFile(test.file) !== undefined &&
    Array.isArray(test.path) &&
    test.path.length > 0 &&
    test.path.every((name) => typeof name === "string" && name.length > 0);
  const fileSet = (tests) => [...new Set(tests.map((test) => normalizeRelativeFile(test.file)))];
  const sameFiles = (tests) =>
    JSON.stringify(fileSet(tests).sort()) === JSON.stringify([...files].sort());
  const validExecution =
    typeof selection === "object" &&
    selection !== null &&
    normalizeWorkingDirectory(selection.workingDirectory) !== undefined &&
    typeof selection.isolate === "boolean" &&
    validTrustedMatchers(selection.trustedMatchers);
  if (
    validExecution &&
    selection.mode === "run" &&
    Object.keys(selection).sort().join(",") ===
      "expectedFailure,isolate,mode,test,testTimeoutMs,trustedMatchers,workingDirectory" &&
    validTest(selection.test) &&
    (selection.expectedFailure === null || typeof selection.expectedFailure === "string") &&
    (selection.testTimeoutMs === null ||
      (Number.isSafeInteger(selection.testTimeoutMs) &&
        selection.testTimeoutMs >= 1 &&
        selection.testTimeoutMs <= 3_600_000)) &&
    sameFiles([selection.test])
  ) {
    return selection;
  }
  if (
    validExecution &&
    selection.mode === "load" &&
    Object.keys(selection).sort().join(",") ===
      "isolate,mode,tests,trustedMatchers,workingDirectory" &&
    Array.isArray(selection.tests) &&
    selection.tests.length > 0 &&
    selection.tests.every(validTest) &&
    sameFiles(selection.tests)
  ) {
    return selection;
  }
  throw new Error("INVALID_DESIGNATED_SELECTION");
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

/**
 * Runs `bun test` on `files`, relative to the root. Without `config` the preload comes from the
 * command line in the root, as for candidate files; with it, Bun runs in `config.cwd` and reads only
 * the generated bunfig there, whose first preload is AssertLedger's.
 */
async function runBun(
  executable,
  files,
  junitFile,
  root,
  evidenceKey,
  extraArguments = [],
  config = undefined,
) {
  const cwd = config?.cwd ?? root;
  const exactPath = (file) =>
    `./${path.relative(cwd, path.join(root, file)).replaceAll(path.sep, "/")}`;
  const childEnvironment = { ...process.env };
  delete childEnvironment.TESTFORGE_RESULT_FILE;
  delete childEnvironment.TESTFORGE_CANDIDATE_FILES;
  delete childEnvironment.ASSERTLEDGER_BUN_EVENTS_FILE;
  delete childEnvironment.ASSERTLEDGER_BUN_RESULT_FILE;
  childEnvironment.ASSERTLEDGER_BUN_ROOT = root;
  const child = spawn(
    executable,
    [
      "test",
      ...(config === undefined
        ? [
            "--max-concurrency=1",
            "--retry=0",
            "--preload",
            "./node_modules/assertledger/preload.mjs",
          ]
        : [`--config=./${config.name}`, "--max-concurrency=1", "--retry=0"]),
      "--reporter=junit",
      `--reporter-outfile=${junitFile}`,
      ...extraArguments,
      ...files.map(exactPath),
    ],
    {
      cwd,
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  let keyDeliveryError = false;
  child.stdio[4].on("error", () => {
    keyDeliveryError = true;
  });
  child.stdio[4].end(evidenceKey);
  let outputBytes = 0;
  let overflow = false;
  let stderr = "";
  let evidenceBytes = 0;
  const evidenceChunks = [];
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
  child.stdio[3].on("data", (chunk) => {
    evidenceBytes += chunk.length;
    if (evidenceBytes > MAX_REPORT_BYTES) {
      overflow = true;
      child.kill();
    } else {
      evidenceChunks.push(chunk);
    }
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  const plainStderr = stderr.replace(ANSI_SGR, "");
  const operationalError =
    plainStderr.includes("Unhandled error between tests") ||
    /(?:^|\r?\n)\s*[1-9][0-9]*\s+errors?\s*(?:\r?\n|$)/u.test(plainStderr);
  return {
    exitCode: overflow || keyDeliveryError ? null : exitCode,
    operationalError,
    eventContent: overflow ? undefined : Buffer.concat(evidenceChunks).toString("utf8"),
  };
}

async function main() {
  const root = await realpath(process.cwd());
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
  const selection = parseDesignatedSelection(process.env.ASSERTLEDGER_BUN_DESIGNATED, files);
  if (selection !== undefined && normalizedCandidates.length > 0) {
    throw new Error("INVALID_DESIGNATED_SELECTION");
  }
  await installHelper(await readFile(helperSourcePath, "utf8"), root);
  const junitFile = path.join(root, `__assertledger_bun_junit_${randomUUID()}.xml`);
  const evidenceKey = randomBytes(32);
  if (selection !== undefined) {
    await runDesignated(executable, baseTests, files, selection, junitFile, root, evidenceKey);
    return;
  }
  const execution = await runBun(
    executable,
    [...baseTests, ...candidates],
    junitFile,
    root,
    evidenceKey,
  );
  let outcome;
  try {
    const junitContent = await readBoundedRegularFile(junitFile, root);
    const allowed = new Set(files);
    outcome = classifyBunInstrumentedEvidence(
      execution.eventContent === undefined
        ? undefined
        : parseEvents(execution.eventContent, root, allowed, evidenceKey),
      parseJunitSummary(junitContent),
      new Set(normalizedBase),
      new Set(normalizedCandidates),
      execution.exitCode,
      execution.operationalError,
    );
  } catch {
    outcome = infrastructureFailure("MISSING_OR_INVALID_REPORT");
  }
  await emit(outcome);
}

async function runDesignated(
  executable,
  testFiles,
  files,
  selection,
  junitFile,
  root,
  evidenceKey,
) {
  const cwd = path.resolve(root, selection.workingDirectory);
  const relativeCwd = path.relative(root, cwd);
  if (
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCwd)
  )
    throw new Error("INVALID_DESIGNATED_SELECTION");
  let original;
  try {
    const bunfig = path.join(cwd, "bunfig.toml");
    if ((await lstat(bunfig)).isFile()) original = await readFile(bunfig, "utf8");
    else throw unsupportedConfig();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await emit(infrastructureFailure("BUNFIG_TEST_PRELOAD_UNSUPPORTED"));
      return;
    }
  }
  let generated;
  try {
    generated = designatedBunConfig(
      original,
      path.join(root, "node_modules", "assertledger", "preload.mjs").replaceAll(path.sep, "/"),
    );
  } catch {
    await emit(infrastructureFailure("BUNFIG_TEST_PRELOAD_UNSUPPORTED"));
    return;
  }
  const config = { cwd, name: `${GENERATED_CONFIG_PREFIX}${randomUUID()}.toml` };
  await writeFile(path.join(cwd, config.name), generated, { flag: "wx" });
  const pattern = [
    ...(selection.isolate ? ["--isolate"] : []),
    ...(selection.mode === "run"
      ? [
          `--test-name-pattern=^${escapeRegularExpression(selection.test.path.join(" "))}$`,
          ...(selection.testTimeoutMs === null ? [] : [`--timeout=${selection.testTimeoutMs}`]),
        ]
      : []),
  ];
  // An isolated run evaluates the preload again in a fresh global for each further file, and the
  // evidence key can be read only once: an isolated load therefore runs one file per process.
  const batches =
    selection.isolate && selection.mode === "load" ? testFiles.map((file) => [file]) : [testFiles];
  const executions = [];
  for (const batch of batches) {
    executions.push(await runBun(executable, batch, junitFile, root, evidenceKey, pattern, config));
  }
  let outcome;
  try {
    let junit;
    try {
      junit = parseJunitSummary(await readBoundedRegularFile(junitFile, root));
    } catch (error) {
      // A load registers no test, so Bun writes no report; a run must always have one.
      if (selection.mode === "run" || error?.code !== "ENOENT") throw error;
    }
    // No registration or no matching test leaves the signed channel empty.
    let events = [];
    for (const execution of executions) {
      const parsed =
        execution.eventContent === undefined
          ? undefined
          : execution.eventContent === ""
            ? []
            : parseEvents(execution.eventContent, root, new Set(files), evidenceKey, true);
      events = events === undefined || parsed === undefined ? undefined : [...events, ...parsed];
    }
    const exitCode = executions.some((execution) => execution.exitCode === null)
      ? null
      : (executions.find((execution) => execution.exitCode !== 0)?.exitCode ?? 0);
    const operationalError = executions.some((execution) => execution.operationalError);
    outcome =
      selection.mode === "run"
        ? classifyBunDesignatedRun(events, junit, exitCode, operationalError)
        : classifyBunDesignatedLoad(
            events,
            junit,
            selection.tests.length,
            exitCode,
            operationalError,
          );
  } catch {
    outcome = infrastructureFailure("MISSING_OR_INVALID_REPORT");
  }
  await emit(outcome);
}

/** Prints the report and, inside a container, also writes it where the engine reads it back. */
async function emit(outcome) {
  const body = `${JSON.stringify(outcome)}\n`;
  const resultFile = process.env.ASSERTLEDGER_BUN_RESULT_FILE;
  if (resultFile !== undefined) await writeFile(resultFile, body, { flag: "wx" });
  process.stdout.write(body);
  process.exitCode = outcome.outcome === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "UNKNOWN_DRIVER_ERROR");
    process.stdout.write(`${JSON.stringify(report("INFRA_ERROR"))}\n`);
    process.exitCode = 1;
  });
}
