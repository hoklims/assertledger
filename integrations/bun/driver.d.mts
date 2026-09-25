export interface BunInspectorResult {
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

export function classifyBunInspectorEvents(
  messages: ReadonlyArray<{ method: string; params: Record<string, unknown> }>,
  candidateFiles: ReadonlySet<string>,
  root: string,
  processExitCode: number | null,
  invalidMessage: boolean,
): BunInspectorResult;
