import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runProcess } from "../index.js";

export const BUN_NATIVE_ADAPTER_VERSION = "1.0.0";
const revision = "1.4.2+744846f84";
const driver = new URL("../../../integrations/bun-native/driver.mjs", import.meta.url);
const preload = new URL("../../../integrations/bun-native/preload.mjs", import.meta.url);

export interface BunNativeInput {
  executable: string;
  files: string[];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maximumOutputBytes: number;
}
export interface BunNativeCollection {
  state: "COMPLETED" | "TIMEOUT" | "CRASH" | "INFRA_ERROR" | "COLLECTION_ERROR" | "NO_TESTS";
  facts: {
    exitCode: number | null;
    testsDiscovered: number;
    testOutcome: string;
    attributed: boolean;
    stdoutDigest?: string;
    stderrDigest?: string;
  };
  runtime: {
    adapterVersion: string;
    bunRevision: string;
    executable: string;
    executableDigest: string;
    driverDigest: string;
    preloadDigest: string;
    isolation: "trusted-local-unsandboxed";
    provenance: "controlled-local-pipe-not-producer-authentication";
  };
}
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Collects observations only; admission and world comparisons belong to the decision engine. */
export async function collectBunNative(input: BunNativeInput): Promise<BunNativeCollection> {
  const runtime: BunNativeCollection["runtime"] = {
    adapterVersion: BUN_NATIVE_ADAPTER_VERSION,
    bunRevision: revision,
    executable: input.executable,
    executableDigest: "",
    driverDigest: digest(await readFile(driver)),
    preloadDigest: digest(await readFile(preload)),
    isolation: "trusted-local-unsandboxed",
    provenance: "controlled-local-pipe-not-producer-authentication",
  };
  const empty = (state: BunNativeCollection["state"]): BunNativeCollection => ({
    state,
    facts: { exitCode: null, testsDiscovered: 0, testOutcome: state, attributed: false },
    runtime,
  });
  try {
    // Resolve through the runtime itself so PATH shims never become the claimed binary identity.
    const probe = await runProcess({
      ...input,
      args: [
        "-e",
        "console.log(JSON.stringify({execPath:process.execPath,revision:Bun.version+'+'+Bun.revision}))",
      ],
    });
    if (probe.outcome !== "PASS" || probe.stdout.truncated) return empty("INFRA_ERROR");
    const identity = JSON.parse(probe.stdout.text) as { execPath?: unknown; revision?: unknown };
    if (
      identity.revision !== "1.4.2+744846f844374847c902b5e7fd59b4342a51ef99" ||
      typeof identity.execPath !== "string"
    )
      return empty("INFRA_ERROR");
    runtime.executable = await realpath(identity.execPath);
    runtime.executableDigest = digest(await readFile(runtime.executable));
    if (input.files.length === 0) return empty("NO_TESTS");
    const execution = await runProcess({
      executable: process.execPath,
      args: [fileURLToPath(driver), runtime.executable, ...input.files],
      cwd: input.cwd,
      environment: input.environment,
      timeoutMs: input.timeoutMs,
      maximumOutputBytes: input.maximumOutputBytes,
    });
    if (execution.timedOut) return empty("TIMEOUT");
    if (execution.stdout.truncated || execution.stderr.truncated) return empty("INFRA_ERROR");
    let report: unknown;
    try {
      report = JSON.parse(execution.stdout.text);
    } catch {
      return empty("INFRA_ERROR");
    }
    if (report === null || typeof report !== "object") return empty("INFRA_ERROR");
    const row = report as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !==
        "attributed,candidateTestsDiscovered,exitCode,outcome,protocolVersion,testsDiscovered" ||
      row.protocolVersion !== "1.0.0" ||
      !Number.isSafeInteger(row.testsDiscovered) ||
      (row.testsDiscovered as number) < 0 ||
      typeof row.attributed !== "boolean" ||
      (row.exitCode !== null && !Number.isInteger(row.exitCode))
    )
      return empty("INFRA_ERROR");
    const states: Record<string, BunNativeCollection["state"]> = {
      PASS: "COMPLETED",
      ASSERTION_FAILURE: "COMPLETED",
      PROCESS_CRASH: "CRASH",
      INFRA_ERROR: "INFRA_ERROR",
      NO_TEST_DISCOVERED: "NO_TESTS",
    };
    if (typeof row.outcome !== "string" || states[row.outcome] === undefined)
      return empty("INFRA_ERROR");
    return {
      state: states[row.outcome] as BunNativeCollection["state"],
      facts: {
        exitCode: row.exitCode as number | null,
        testsDiscovered: row.testsDiscovered as number,
        testOutcome: row.outcome,
        attributed: row.attributed,
        stdoutDigest: execution.stdout.digest,
        stderrDigest: execution.stderr.digest,
      },
      runtime,
    };
  } catch {
    return empty("INFRA_ERROR");
  }
}
