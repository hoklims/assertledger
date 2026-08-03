export const NODE_TEST_REPORTER_SOURCE = String.raw`
import path from "node:path";
import { fileURLToPath } from "node:url";

function normalizeFile(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let file = value;
  if (file.startsWith("file:")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return undefined;
    }
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

const candidateFiles = new Set(
  JSON.parse(process.env.TESTFORGE_NODE_CANDIDATE_FILES ?? "[]")
    .map(normalizeFile)
    .filter((file) => file !== undefined),
);

export default async function* testforgeReporter(source) {
  let testsDiscovered = 0;
  let candidateTestsDiscovered = 0;
  let candidateFailureCount = 0;
  let nonCandidateFailureCount = 0;
  let candidateSyntaxFailureCount = 0;
  let candidateFailuresAllAssertions = true;

  for await (const event of source) {
    const data = event && typeof event === "object" ? event.data : undefined;
    const file = normalizeFile(data?.file);
    const candidateFile = file !== undefined && candidateFiles.has(file);
    const fileWrapper = file !== undefined && normalizeFile(data?.name) === file;

    if (event?.type === "test:dequeue" && data?.type === "test" && !fileWrapper) {
      testsDiscovered += 1;
      if (candidateFile) candidateTestsDiscovered += 1;
      continue;
    }

    if (event?.type !== "test:fail") continue;
    if (!candidateFile) {
      nonCandidateFailureCount += 1;
      continue;
    }

    candidateFailureCount += 1;
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
  }) + "\n";
}
`;
