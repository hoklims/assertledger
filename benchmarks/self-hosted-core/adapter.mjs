import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NODE_TEST_REPORTER_SOURCE } from "../../dist/engine/node-test-reporter.js";

const SELECTED_TEST_REPORTER_SOURCE = String.raw`
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeFile(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let file = value;
  if (file.startsWith("file:")) {
    try { file = fileURLToPath(file); } catch { return undefined; }
  }
  const normalized = path.normalize(path.resolve(file));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function errorChainHas(error, predicate) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 16 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (predicate(current)) return true;
    current = current.cause;
  }
  return false;
}

const candidateFile = normalizeFile(process.env.TESTFORGE_SELECTED_TEST_FILE);

export default async function* selectedTestReporter(source) {
  let testsDiscovered = 0;
  let candidateTestsDiscovered = 0;
  let candidateFailureCount = 0;
  let nonCandidateFailureCount = 0;
  let candidateSyntaxFailureCount = 0;
  let candidateFailuresAllAssertions = true;
  const candidateTestNames = [];

  for await (const event of source) {
    const data = event && typeof event === "object" ? event.data : undefined;
    const file = normalizeFile(data?.file);
    const selectedFile = file !== undefined && file === candidateFile;
    const fileWrapper = file !== undefined && normalizeFile(data?.name) === file;
    const skipped = data?.details?.skip !== undefined && data.details.skip !== false;

    if (
      (event?.type === "test:pass" || event?.type === "test:fail") &&
      data?.details?.type === "test" &&
      !fileWrapper &&
      !skipped
    ) {
      testsDiscovered += 1;
      if (selectedFile) {
        candidateTestsDiscovered += 1;
        candidateTestNames.push(String(data?.name));
      }
    }

    if (event?.type !== "test:fail") continue;
    if (!fileWrapper && data?.details?.type !== "test") continue;
    if (!selectedFile) {
      if (!skipped) nonCandidateFailureCount += 1;
      continue;
    }
    if (fileWrapper) {
      candidateFailureCount += 1;
    } else if (!skipped) {
      candidateFailureCount += 1;
    } else {
      continue;
    }
    const error = data?.details?.error;
    const assertion = errorChainHas(error, (item) => item.code === "ERR_ASSERTION");
    const syntax = errorChainHas(error, (item) => item.name === "SyntaxError");
    if (!assertion) candidateFailuresAllAssertions = false;
    if (syntax) candidateSyntaxFailureCount += 1;
  }

  yield JSON.stringify({
    protocolVersion: "1.0.0",
    testsDiscovered,
    candidateTestsDiscovered,
    candidateFailureCount,
    nonCandidateFailureCount,
    candidateSyntaxFailureCount,
    candidateFailuresAllAssertions,
    candidateTestNames,
  }) + "\n";
}
`;

const resultFile = process.env.TESTFORGE_RESULT_FILE;
const candidateFiles = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");
const dependencyRoot = process.argv[2];
if (
  typeof resultFile !== "string" ||
  !Array.isArray(candidateFiles) ||
  typeof dependencyRoot !== "string" ||
  !path.isAbsolute(dependencyRoot)
) {
  process.exit(2);
}

function sha256Bytes(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function exactPattern(title) {
  return `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function stableCandidateId(title) {
  return `core-it-${createHash("sha256").update(title).digest("hex").slice(0, 16)}`;
}

async function selectedTestConfiguration(files) {
  if (files.length !== 2) return undefined;
  const selectionFile = files.find((file) => path.basename(file) === "selection.json");
  const sourceFile = files.find((file) => path.basename(file) === "core.test.ts");
  if (!selectionFile || !sourceFile) return undefined;
  let selection;
  try {
    selection = JSON.parse(await readFile(selectionFile, "utf8"));
  } catch {
    return undefined;
  }
  const expectedKeys = [
    "candidateId",
    "mode",
    "pattern",
    "schemaVersion",
    "sourceDigest",
    "sourcePath",
    "title",
  ];
  if (
    typeof selection !== "object" ||
    selection === null ||
    Object.keys(selection).sort().join("\0") !== expectedKeys.sort().join("\0") ||
    selection.schemaVersion !== "1.0.0" ||
    selection.mode !== "existing-core-test" ||
    typeof selection.candidateId !== "string" ||
    path.basename(path.dirname(sourceFile)) !== selection.candidateId ||
    typeof selection.title !== "string" ||
    typeof selection.pattern !== "string" ||
    selection.candidateId !== stableCandidateId(selection.title) ||
    selection.pattern !== exactPattern(selection.title) ||
    selection.sourcePath !== "core.test.ts" ||
    typeof selection.sourceDigest !== "string"
  ) {
    return undefined;
  }
  const source = await readFile(sourceFile);
  if (sha256Bytes(source) !== selection.sourceDigest) return undefined;
  return { sourceFile, pattern: selection.pattern, title: selection.title };
}

const workspaceDependencies = path.join(process.cwd(), "node_modules");
try {
  await lstat(workspaceDependencies);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await symlink(
    dependencyRoot,
    workspaceDependencies,
    process.platform === "win32" ? "junction" : "dir",
  );
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-self-hosted-adapter-"));
try {
  const reporterPath = path.join(temporaryRoot, "node-test-reporter.mjs");
  const reporterResultPath = path.join(temporaryRoot, "node-test-result.json");
  const selectedTest =
    candidateFiles.length > 0 ? await selectedTestConfiguration(candidateFiles) : undefined;
  const selectedMode = candidateFiles.some((file) => path.basename(file) === "selection.json");
  await writeFile(
    reporterPath,
    selectedMode ? SELECTED_TEST_REPORTER_SOURCE : NODE_TEST_REPORTER_SOURCE,
    "utf8",
  );
  if (selectedMode && selectedTest === undefined) {
    await writeFile(
      resultFile,
      JSON.stringify({
        protocolVersion: "1.0.0",
        outcome: "INFRA_ERROR",
        testsDiscovered: 0,
        candidateTestsDiscovered: 0,
        attributed: false,
      }),
      "utf8",
    );
    process.exitCode = 1;
  } else {
    const testFiles =
      candidateFiles.length === 0
        ? ["benchmarks/self-hosted-core/liveness.test.mjs"]
        : selectedTest
          ? [selectedTest.sourceFile]
          : candidateFiles;
    const environment = {
      ...process.env,
      TESTFORGE_NODE_CANDIDATE_FILES: JSON.stringify(
        (selectedTest ? [selectedTest.sourceFile] : candidateFiles).map((file) =>
          path.resolve(file),
        ),
      ),
      ...(selectedTest
        ? { TESTFORGE_SELECTED_TEST_FILE: path.resolve(selectedTest.sourceFile) }
        : {}),
    };
    const args = [
      "--import",
      "tsx",
      "--test",
      `--test-reporter=${pathToFileURL(reporterPath).href}`,
      `--test-reporter-destination=${reporterResultPath}`,
      ...(selectedTest ? [`--test-name-pattern=${selectedTest.pattern}`] : []),
      "--",
      ...testFiles,
    ];
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: environment,
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    let report;
    try {
      report = JSON.parse(await readFile(reporterResultPath, "utf8"));
    } catch {
      report = undefined;
    }
    const candidateRun = candidateFiles.length > 0;
    const exactCandidateCount = selectedTest
      ? report?.testsDiscovered === 1 &&
        report?.candidateTestsDiscovered === 1 &&
        Array.isArray(report?.candidateTestNames) &&
        report.candidateTestNames.length === 1 &&
        report.candidateTestNames[0] === selectedTest.title
      : report?.candidateTestsDiscovered >= 1;
    const pass =
      exitCode === 0 &&
      report?.testsDiscovered >= 1 &&
      report?.candidateFailureCount === 0 &&
      report?.nonCandidateFailureCount === 0 &&
      (!candidateRun || exactCandidateCount);
    const attributedAssertionFailure =
      candidateRun &&
      exitCode !== 0 &&
      exactCandidateCount &&
      report?.candidateFailureCount === 1 &&
      report?.nonCandidateFailureCount === 0 &&
      report?.candidateSyntaxFailureCount === 0 &&
      report?.candidateFailuresAllAssertions === true;
    const outcome =
      report === undefined
        ? "INFRA_ERROR"
        : pass
          ? "PASS"
          : attributedAssertionFailure
            ? "ASSERTION_FAILURE"
            : report.testsDiscovered === 0
              ? "NO_TEST_DISCOVERED"
              : "PROCESS_CRASH";
    const structured = {
      protocolVersion: "1.0.0",
      outcome,
      testsDiscovered: Number.isSafeInteger(report?.testsDiscovered) ? report.testsDiscovered : 0,
      candidateTestsDiscovered:
        candidateRun && Number.isSafeInteger(report?.candidateTestsDiscovered)
          ? report.candidateTestsDiscovered
          : 0,
      attributed: candidateRun && (pass || attributedAssertionFailure),
    };
    await writeFile(resultFile, JSON.stringify(structured), "utf8");
    process.exitCode = outcome === "PASS" ? 0 : 1;
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
