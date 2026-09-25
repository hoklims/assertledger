export interface BunInstrumentedResult {
  protocolVersion: "1.0.0";
  outcome:
    | "PASS"
    | "ASSERTION_FAILURE"
    | "PROCESS_CRASH"
    | "TIMEOUT"
    | "INFRA_ERROR"
    | "NO_TEST_DISCOVERED";
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  attributed: boolean;
}

export type BunTestEvent =
  | { kind: "found"; id: string; file: string }
  | { kind: "end"; id: string; status: "pass" | "fail"; owned: boolean }
  | { kind: "hook-error" };

export function classifyBunInstrumentedEvidence(
  events: readonly BunTestEvent[] | undefined,
  junit: { tests: number; failures: number; skipped: number } | undefined,
  baseFiles: ReadonlySet<string>,
  candidateFiles: ReadonlySet<string>,
  exitCode: number | null,
  operationalError?: boolean,
): BunInstrumentedResult;
