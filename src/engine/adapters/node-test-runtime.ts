import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRuntimeFacts, RUNTIME_FACTS_VERSION } from "./runtime-facts.js";

const PREFLIGHT_ERROR = "NODE_TEST_PROFILE_PREFLIGHT_FAILED";
const PREFLIGHT_REPORT_LIMIT_BYTES = 64 * 1024;

interface PreflightInput {
  executable: string;
  reporterSource: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maximumOutputBytes: number;
  processRunner: (input: NodeTestPreflightProcessInput) => Promise<NodeTestPreflightProcessResult>;
  /** Replaces the host-workspace probe execution, for example to run each probe in a container. */
  probeExecutor?: NodeTestPreflightProbeExecutor;
}

export interface NodeTestPreflightProbe {
  name: "assertion" | "generic-throw";
  reporterSource: string;
  controlSource: string;
  candidateSource: string;
  timeoutMs: number;
  maximumOutputBytes: number;
  reportMaximumBytes: number;
}

export interface NodeTestPreflightProbeOutcome {
  processResult: NodeTestPreflightProcessResult;
  /** The parsed reporter document, or undefined when it is absent, oversize or not JSON. */
  report: unknown;
}

export type NodeTestPreflightProbeExecutor = (
  probe: NodeTestPreflightProbe,
) => Promise<NodeTestPreflightProbeOutcome>;

interface NodeTestPreflightProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maximumOutputBytes: number;
}

interface NodeTestPreflightProcessResult {
  outcome: "PASS" | "PROCESS_CRASH" | "TIMEOUT" | "INFRA_ERROR";
  exitCode: number | null;
}

interface ProbeEvidence {
  outcome: "ASSERTION_FAILURE" | "PROCESS_CRASH";
  attributed: boolean;
  candidateTestsDiscovered: 1;
  testsDiscovered: 2;
  candidateFailureCount: 1;
  nonCandidateFailureCount: 0;
  candidateSyntaxFailureCount: 0;
  candidateFailuresAllAssertions: boolean;
  processExitedNonZero: true;
}

export interface NodeTestRuntimePreflight {
  protocolVersion: "1.0.0";
  assertionProbe: ProbeEvidence;
  genericThrowProbe: ProbeEvidence;
}

interface ReporterDocument {
  protocolVersion: "1.0.0";
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  candidateFailureCount: number;
  nonCandidateFailureCount: number;
  candidateSyntaxFailureCount: number;
  candidateFailuresAllAssertions: boolean;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseReporterDocument(value: unknown): ReporterDocument | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = [
    "candidateFailureCount",
    "candidateFailuresAllAssertions",
    "candidateSyntaxFailureCount",
    "candidateTestsDiscovered",
    "nonCandidateFailureCount",
    "protocolVersion",
    "testsDiscovered",
  ];
  if (Object.keys(record).sort().join("\0") !== keys.join("\0")) return undefined;
  if (
    record.protocolVersion !== "1.0.0" ||
    !validCount(record.testsDiscovered) ||
    !validCount(record.candidateTestsDiscovered) ||
    record.candidateTestsDiscovered > record.testsDiscovered ||
    !validCount(record.candidateFailureCount) ||
    !validCount(record.nonCandidateFailureCount) ||
    !validCount(record.candidateSyntaxFailureCount) ||
    record.candidateSyntaxFailureCount > record.candidateFailureCount ||
    typeof record.candidateFailuresAllAssertions !== "boolean"
  ) {
    return undefined;
  }
  return record as unknown as ReporterDocument;
}

async function readBoundedReporterDocument(reportPath: string): Promise<unknown> {
  const handle = await open(reportPath, "r");
  try {
    const buffer = Buffer.alloc(PREFLIGHT_REPORT_LIMIT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const chunk = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, null);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > PREFLIGHT_REPORT_LIMIT_BYTES) throw new Error(PREFLIGHT_ERROR);
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function hostProbeExecutor(
  input: PreflightInput,
  root: string,
  reporterPath: string,
  controlPath: string,
): NodeTestPreflightProbeExecutor {
  return async (probe) => {
    const candidatePath = path.join(root, `${probe.name}.test.mjs`);
    const reportPath = path.join(root, `${probe.name}.json`);
    await writeFile(candidatePath, probe.candidateSource, { flag: "wx" });

    const processResult = await input.processRunner({
      executable: input.executable,
      args: [
        "--test",
        `--test-reporter=${pathToFileURL(reporterPath).href}`,
        `--test-reporter-destination=${reportPath}`,
        "--",
        controlPath,
        candidatePath,
      ],
      cwd: root,
      environment: {
        ...input.environment,
        TESTFORGE_NODE_CANDIDATE_FILES: JSON.stringify([candidatePath]),
      },
      timeoutMs: probe.timeoutMs,
      maximumOutputBytes: probe.maximumOutputBytes,
    });
    const crashed =
      processResult.outcome === "PROCESS_CRASH" &&
      processResult.exitCode !== null &&
      processResult.exitCode !== 0;
    return {
      processResult,
      report: crashed ? await readBoundedReporterDocument(reportPath) : undefined,
    };
  };
}

async function executeProbe(
  input: PreflightInput,
  executor: NodeTestPreflightProbeExecutor,
  controlSource: string,
  name: NodeTestPreflightProbe["name"],
  body: string,
): Promise<ProbeEvidence> {
  const { processResult, report } = await executor({
    name,
    reporterSource: input.reporterSource,
    controlSource,
    candidateSource: body,
    timeoutMs: Math.min(input.timeoutMs, 5_000),
    maximumOutputBytes: Math.min(input.maximumOutputBytes, PREFLIGHT_REPORT_LIMIT_BYTES),
    reportMaximumBytes: PREFLIGHT_REPORT_LIMIT_BYTES,
  });
  if (
    processResult.outcome !== "PROCESS_CRASH" ||
    processResult.exitCode === null ||
    processResult.exitCode === 0
  ) {
    throw new Error(PREFLIGHT_ERROR);
  }
  const document = parseReporterDocument(report);
  if (document === undefined) throw new Error(PREFLIGHT_ERROR);
  const expectedAssertionFacts = name === "assertion";
  if (
    document.testsDiscovered !== 2 ||
    document.candidateTestsDiscovered !== 1 ||
    document.candidateFailureCount !== 1 ||
    document.nonCandidateFailureCount !== 0 ||
    document.candidateSyntaxFailureCount !== 0 ||
    document.candidateFailuresAllAssertions !== expectedAssertionFacts
  ) {
    throw new Error(PREFLIGHT_ERROR);
  }
  const normalized = normalizeRuntimeFacts({
    factsVersion: RUNTIME_FACTS_VERSION,
    reportValid: true,
    hasCandidate: true,
    processExitedZero: false,
    candidateTestsDiscovered: document.candidateTestsDiscovered,
    nonCandidateFailureCount: document.nonCandidateFailureCount,
    candidateCollectionFailureCount: 0,
    candidateCompileFailureCount: document.candidateSyntaxFailureCount,
    candidateFailureCount: document.candidateFailureCount,
    candidateFailuresAllAssertions: document.candidateFailuresAllAssertions,
  });
  if (
    document.candidateTestsDiscovered !== 1 ||
    (normalized.outcome !== "ASSERTION_FAILURE" && normalized.outcome !== "PROCESS_CRASH")
  ) {
    throw new Error(PREFLIGHT_ERROR);
  }
  return {
    outcome: normalized.outcome,
    attributed: normalized.attributed,
    candidateTestsDiscovered: 1,
    testsDiscovered: 2,
    candidateFailureCount: 1,
    nonCandidateFailureCount: 0,
    candidateSyntaxFailureCount: 0,
    candidateFailuresAllAssertions: document.candidateFailuresAllAssertions,
    processExitedNonZero: true,
  };
}

export async function runNodeTestRuntimePreflight(
  input: PreflightInput,
): Promise<NodeTestRuntimePreflight> {
  let root: string | undefined;
  let result: NodeTestRuntimePreflight | undefined;
  let failure: unknown;
  try {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "assertledger-node-test-preflight-")),
    );
    const reporterPath = path.join(root, "reporter.mjs");
    const controlPath = path.join(root, "control.test.mjs");
    const controlSource = ['import test from "node:test";', 'test("control", () => {});', ""].join(
      "\n",
    );
    await writeFile(reporterPath, input.reporterSource, { flag: "wx" });
    await writeFile(controlPath, controlSource, { flag: "wx" });
    const executor =
      input.probeExecutor ?? hostProbeExecutor(input, root, reporterPath, controlPath);
    const assertionProbe = await executeProbe(
      input,
      executor,
      controlSource,
      "assertion",
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("assertion", () => assert.equal(false, true));',
        "",
      ].join("\n"),
    );
    const genericThrowProbe = await executeProbe(
      input,
      executor,
      controlSource,
      "generic-throw",
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'test("generic throw", () => {',
        '  throw new Error("preflight", { cause: new assert.AssertionError({ message: "nested" }) });',
        "});",
        "",
      ].join("\n"),
    );
    if (
      assertionProbe.outcome !== "ASSERTION_FAILURE" ||
      assertionProbe.attributed !== true ||
      genericThrowProbe.outcome !== "PROCESS_CRASH" ||
      genericThrowProbe.attributed !== false
    ) {
      throw new Error(PREFLIGHT_ERROR);
    }
    result = { protocolVersion: "1.0.0", assertionProbe, genericThrowProbe };
  } catch (error) {
    failure = error;
  }
  if (root !== undefined) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined || result === undefined) {
    throw new Error(PREFLIGHT_ERROR, { cause: failure });
  }
  return result;
}
