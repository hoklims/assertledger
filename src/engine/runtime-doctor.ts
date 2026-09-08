import type { RepositoryInitResult } from "../contracts/index.js";
import {
  parseRuntimeDoctorResult,
  type RuntimeDoctorCheck,
  type RuntimeDoctorResult,
} from "../contracts/runtime-doctor.js";

export type { RuntimeDoctorCheck, RuntimeDoctorResult } from "../contracts/runtime-doctor.js";
export {
  parseRuntimeDoctorResult,
  RuntimeDoctorCheckSchema,
  RuntimeDoctorReasonCodeSchema,
  RuntimeDoctorResultSchema,
} from "../contracts/runtime-doctor.js";

export interface RuntimeDoctorDependencies {
  inspectConfiguration(): Promise<RepositoryInitResult>;
  probeExecutable(): Promise<{ nodeVersion: string }>;
  probeDependencies(): Promise<void>;
  probeTemporaryWorkspace(): Promise<void>;
  runSyntheticPreflight(): Promise<void>;
}

const LIMITATIONS = [
  "Runtime doctor uses controlled synthetic node:test probes and does not run repository tests or prove campaign evidence.",
] as const;

function check(
  id: RuntimeDoctorCheck["id"],
  status: RuntimeDoctorCheck["status"],
  summary: string,
  reasonCode: RuntimeDoctorCheck["reasonCode"] = null,
  nextAction: string | null = null,
): RuntimeDoctorCheck {
  return { id, status, reasonCode, summary, nextAction };
}

function result(
  repositoryRoot: string,
  checks: RuntimeDoctorCheck[],
  adapter: "node:test" | null,
  nodeVersion: string | null,
): RuntimeDoctorResult {
  const reasonCodes = checks
    .flatMap((entry) => (entry.status === "BLOCKED" && entry.reasonCode ? [entry.reasonCode] : []))
    .filter((reasonCode, index, values) => values.indexOf(reasonCode) === index)
    .sort();
  return parseRuntimeDoctorResult({
    schemaVersion: "1.0.0",
    status: reasonCodes.length === 0 ? "READY" : "BLOCKED",
    executionMode: "UNSANDBOXED_TRUSTED_LOCAL",
    repositoryRoot,
    adapter,
    nodeVersion,
    checks,
    reasonCodes,
    limitations: [...LIMITATIONS],
  });
}

function finish(
  repositoryRoot: string,
  checks: RuntimeDoctorCheck[],
  adapter: "node:test" | null = null,
  nodeVersion: string | null = null,
): RuntimeDoctorResult {
  return result(
    repositoryRoot,
    [
      ...checks,
      check(
        "repository-campaign",
        "LIMITATION",
        LIMITATIONS[0],
        "RUNTIME_REPOSITORY_TESTS_NOT_EXECUTED",
        "Run an explicitly authorized AssertLedger verification campaign to evaluate repository tests.",
      ),
    ],
    adapter,
    nodeVersion,
  );
}

/** @internal Orchestrates fixed runtime probes supplied by the engine boundary. */
export async function runRuntimeDoctorChecks(
  repositoryRoot: string,
  allowUnsafeExecution: boolean,
  dependencies: RuntimeDoctorDependencies,
): Promise<RuntimeDoctorResult> {
  const checks: RuntimeDoctorCheck[] = [];
  if (allowUnsafeExecution !== true) {
    checks.push(
      check(
        "authorization",
        "BLOCKED",
        "Runtime probes require explicit authorization because they execute UNSANDBOXED trusted-local processes.",
        "RUNTIME_EXECUTION_NOT_AUTHORIZED",
        "Rerun with --runtime --allow-unsafe-execution only for a trusted local repository.",
      ),
    );
    return finish(repositoryRoot, checks);
  }
  checks.push(
    check(
      "authorization",
      "PASS",
      "UNSANDBOXED trusted-local runtime probing was explicitly authorized.",
    ),
  );

  let configuration: RepositoryInitResult;
  try {
    configuration = await dependencies.inspectConfiguration();
  } catch {
    checks.push(
      check(
        "configuration",
        "BLOCKED",
        "Repository configuration could not be inspected safely.",
        "RUNTIME_CONFIGURATION_UNAVAILABLE",
        "Run assertledger doctor --json and resolve its static diagnostics.",
      ),
    );
    return finish(repositoryRoot, checks);
  }
  if (configuration.status !== "UNCHANGED") {
    const stale = configuration.status === "WOULD_CREATE" || configuration.status === "CREATED";
    checks.push(
      check(
        "configuration",
        "BLOCKED",
        stale
          ? "AssertLedger configuration does not match the current repository evidence."
          : "AssertLedger configuration is blocked or conflicted.",
        stale ? "RUNTIME_CONFIGURATION_STALE" : "RUNTIME_CONFIGURATION_BLOCKED",
        "Run assertledger doctor --json, then apply or repair the reported initialization plan.",
      ),
    );
    return finish(repositoryRoot, checks);
  }
  checks.push(
    check("configuration", "PASS", "AssertLedger configuration and lock evidence are current."),
  );

  if (
    configuration.detections.framework !== "node:test" ||
    configuration.detections.adapterRecommendation !== "node-test"
  ) {
    checks.push(
      check(
        "adapter",
        "BLOCKED",
        "Runtime doctor 1.0 supports only the generated official node:test adapter.",
        "RUNTIME_ADAPTER_UNSUPPORTED",
        "Use static doctor output or configure a supported node:test repository.",
      ),
    );
    return finish(repositoryRoot, checks);
  }
  checks.push(check("adapter", "PASS", "The generated official node:test adapter is supported."));

  let nodeVersion: string;
  try {
    ({ nodeVersion } = await dependencies.probeExecutable());
  } catch (error) {
    const unsupported = error instanceof Error && error.message === "NODE_TEST_VERSION_UNSUPPORTED";
    checks.push(
      check(
        "executable",
        "BLOCKED",
        unsupported
          ? "The resolved Node.js version is unsupported."
          : "Node.js is unavailable or could not be resolved consistently.",
        unsupported ? "RUNTIME_NODE_VERSION_UNSUPPORTED" : "RUNTIME_EXECUTABLE_UNAVAILABLE",
        "Install Node.js 22.15 or newer and rerun runtime doctor.",
      ),
    );
    return finish(repositoryRoot, checks, "node:test");
  }
  checks.push(
    check("executable", "PASS", `Resolved a supported Node.js ${nodeVersion} executable.`),
  );

  try {
    await dependencies.probeDependencies();
  } catch {
    checks.push(
      check(
        "dependencies",
        "BLOCKED",
        "The built-in node:test dependency could not be loaded by the resolved executable.",
        "RUNTIME_DEPENDENCY_UNAVAILABLE",
        "Repair the Node.js installation and rerun runtime doctor.",
      ),
    );
    return finish(repositoryRoot, checks, "node:test", nodeVersion);
  }
  checks.push(check("dependencies", "PASS", "The built-in node:test dependency is available."));

  try {
    await dependencies.probeTemporaryWorkspace();
  } catch {
    checks.push(
      check(
        "temporary-workspace",
        "BLOCKED",
        "A disposable runtime workspace could not be created, written, and cleaned up.",
        "RUNTIME_TEMPORARY_WORKSPACE_UNAVAILABLE",
        "Grant the current user access to the operating-system temporary directory.",
      ),
    );
    return finish(repositoryRoot, checks, "node:test", nodeVersion);
  }
  checks.push(
    check("temporary-workspace", "PASS", "A disposable workspace was created and cleaned up."),
  );

  try {
    await dependencies.runSyntheticPreflight();
  } catch {
    checks.push(
      check(
        "synthetic-preflight",
        "BLOCKED",
        "Controlled reporter, discovery, liveness, or attribution probes failed.",
        "RUNTIME_PREFLIGHT_FAILED",
        "Reinstall AssertLedger and rerun runtime doctor before starting a campaign.",
      ),
    );
    return finish(repositoryRoot, checks, "node:test", nodeVersion);
  }
  checks.push(
    check(
      "synthetic-preflight",
      "PASS",
      "Controlled discovery and liveness passed; assertion failure was attributed and generic throw was not.",
    ),
  );

  return finish(repositoryRoot, checks, "node:test", nodeVersion);
}
