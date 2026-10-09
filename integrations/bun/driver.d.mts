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

/** The JUnit totals; `timeouts` counts the tests Bun failed with a TimeoutError. */
export interface BunJunitSummary {
  tests: number;
  failures: number;
  skipped: number;
  timeouts?: number;
}

export type BunDesignatedEvent =
  | { kind: "found"; id: string; file: string; designated: boolean }
  | { kind: "end"; id: string; status: "pass" | "fail"; owned: boolean }
  | { kind: "registered"; designated: number; file: string }
  | { kind: "hook-error" };

export function classifyBunDesignatedLoad(
  events: readonly BunDesignatedEvent[] | undefined,
  junit: BunJunitSummary | undefined,
  designatedCount: number,
  exitCode: number | null,
  operationalError: boolean,
): BunInstrumentedResult;

export function classifyBunDesignatedRun(
  events: readonly BunDesignatedEvent[] | undefined,
  junit: BunJunitSummary | undefined,
  exitCode: number | null,
  operationalError: boolean,
): BunInstrumentedResult;

export function classifyBunInstrumentedEvidence(
  events: readonly BunTestEvent[] | undefined,
  junit: BunJunitSummary | undefined,
  baseFiles: ReadonlySet<string>,
  candidateFiles: ReadonlySet<string>,
  exitCode: number | null,
  operationalError?: boolean,
): BunInstrumentedResult;
