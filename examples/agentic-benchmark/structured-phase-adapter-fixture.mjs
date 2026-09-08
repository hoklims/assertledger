// Deterministic wire-protocol fixture. Fixed durations are illustrative, not measurements.
import { writeFile } from "node:fs/promises";

const candidateFiles = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");
const benchmarkResultFile = process.env.TESTFORGE_BENCHMARK_RESULT_FILE;

if (benchmarkResultFile === undefined) {
  await writeFile(
    process.env.TESTFORGE_RESULT_FILE,
    JSON.stringify({
      protocolVersion: "1.0.0",
      outcome: "PASS",
      testsDiscovered: candidateFiles.length === 0 ? 1 : 2,
      candidateTestsDiscovered: candidateFiles.length === 0 ? 0 : 1,
      attributed: candidateFiles.length > 0,
    }),
  );
} else {
  await writeFile(
    benchmarkResultFile,
    JSON.stringify({
      protocolVersion: "1.0.0",
      outcome: "PASS",
      testsDiscovered: 1,
      candidateTestsDiscovered: 1,
      attributed: true,
      phases: [
        { phase: "STARTUP", durationUs: 10 },
        { phase: "COMPILE_OR_COLLECTION", durationUs: 20 },
        { phase: "EXECUTION", durationUs: 30 },
      ],
      cpuTimeUs: null,
    }),
  );
}
