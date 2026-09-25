import type { RepositoryInitResult, RepositoryInitResultV2 } from "../contracts/index.js";
import {
  parseRuntimeDoctorResult,
  parseRuntimeDoctorResultV2,
  type RuntimeDoctorCheck,
  type RuntimeDoctorCheckV2,
  type RuntimeDoctorResult,
  type RuntimeDoctorResultV2,
} from "../contracts/runtime-doctor.js";

export type {
  RuntimeDoctorCheck,
  RuntimeDoctorResult,
  RuntimeDoctorResultV2,
} from "../contracts/runtime-doctor.js";
export {
  parseRuntimeDoctorResult,
  RuntimeDoctorCheckSchema,
  RuntimeDoctorReasonCodeSchema,
  RuntimeDoctorResultSchema,
  RuntimeDoctorResultV2Schema,
} from "../contracts/runtime-doctor.js";

export interface BunRuntimeDoctorDependencies {
  probeExecutable(): Promise<{ bunVersion: string }>;
  probeDependencies(): Promise<void>;
  probeTemporaryWorkspace(): Promise<void>;
  runSyntheticPreflight(): Promise<void>;
}

const BUN_LIMITATION =
  "Runtime doctor uses controlled synthetic Bun Inspector probes and does not run repository tests or prove campaign evidence." as const;

function bunCheck(
  id: RuntimeDoctorCheckV2["id"],
  status: RuntimeDoctorCheckV2["status"],
  summary: string,
  reasonCode: RuntimeDoctorCheckV2["reasonCode"] = null,
  nextAction: string | null = null,
): RuntimeDoctorCheckV2 {
  return { id, status, reasonCode, summary, nextAction };
}

function finishBunDoctor(
  repositoryRoot: string,
  checks: RuntimeDoctorCheckV2[],
  adapter: "bun:test" | null,
  bunVersion: string | null,
): RuntimeDoctorResultV2 {
  const reasonCodes = checks
    .flatMap((entry) => (entry.status === "BLOCKED" && entry.reasonCode ? [entry.reasonCode] : []))
    .filter((code, index, values) => values.indexOf(code) === index)
    .sort();
  return parseRuntimeDoctorResultV2({
    schemaVersion: "2.0.0",
    status: reasonCodes.length === 0 ? "READY" : "BLOCKED",
    executionMode: "UNSANDBOXED_TRUSTED_LOCAL",
    repositoryRoot,
    adapter,
    nodeVersion: null,
    bunVersion,
    checks: [
      ...checks,
      bunCheck(
        "repository-campaign",
        "LIMITATION",
        BUN_LIMITATION,
        "RUNTIME_REPOSITORY_TESTS_NOT_EXECUTED",
        "Run an explicitly authorized AssertLedger v3 verification campaign.",
      ),
    ],
    reasonCodes,
    limitations: [BUN_LIMITATION],
  });
}

export async function runBunRuntimeDoctorChecks(
  repositoryRoot: string,
  configuration: RepositoryInitResultV2,
  dependencies: BunRuntimeDoctorDependencies,
): Promise<RuntimeDoctorResultV2> {
  const checks: RuntimeDoctorCheckV2[] = [
    bunCheck("authorization", "PASS", "UNSANDBOXED trusted-local runtime probing was authorized."),
  ];
  if (configuration.status !== "UNCHANGED") {
    checks.push(
      bunCheck(
        "configuration",
        "BLOCKED",
        "Bun adapter configuration does not match the repository evidence.",
        configuration.status === "WOULD_CREATE" || configuration.status === "CREATED"
          ? "RUNTIME_CONFIGURATION_STALE"
          : "RUNTIME_CONFIGURATION_BLOCKED",
        "Run assertledger init and repair the reported configuration or lock.",
      ),
    );
    return finishBunDoctor(repositoryRoot, checks, null, null);
  }
  checks.push(bunCheck("configuration", "PASS", "Bun adapter configuration and lock are current."));
  if (
    configuration.detections.framework !== "bun:test" ||
    configuration.detections.adapterRecommendation !== "bun-test"
  ) {
    checks.push(
      bunCheck(
        "adapter",
        "BLOCKED",
        "The generated adapter is not the official Bun test profile.",
        "RUNTIME_ADAPTER_UNSUPPORTED",
        "Generate the Bun test adapter with assertledger init.",
      ),
    );
    return finishBunDoctor(repositoryRoot, checks, null, null);
  }
  checks.push(bunCheck("adapter", "PASS", "The official Bun test adapter is configured."));

  let bunVersion: string;
  try {
    ({ bunVersion } = await dependencies.probeExecutable());
  } catch (error) {
    const unsupported = error instanceof Error && error.message === "BUN_TEST_VERSION_UNSUPPORTED";
    checks.push(
      bunCheck(
        "executable",
        "BLOCKED",
        unsupported ? "The resolved Bun version is unsupported." : "Bun is unavailable.",
        unsupported ? "RUNTIME_BUN_VERSION_UNSUPPORTED" : "RUNTIME_BUN_EXECUTABLE_UNAVAILABLE",
        "Install the qualified Bun release and rerun runtime doctor.",
      ),
    );
    return finishBunDoctor(repositoryRoot, checks, "bun:test", null);
  }
  checks.push(bunCheck("executable", "PASS", `Resolved Bun ${bunVersion}.`));
  try {
    await dependencies.probeDependencies();
  } catch {
    checks.push(
      bunCheck(
        "dependencies",
        "BLOCKED",
        "The Bun test module could not be loaded.",
        "RUNTIME_BUN_DEPENDENCY_UNAVAILABLE",
        "Repair the Bun installation and rerun runtime doctor.",
      ),
    );
    return finishBunDoctor(repositoryRoot, checks, "bun:test", bunVersion);
  }
  checks.push(bunCheck("dependencies", "PASS", "bun:test is available."));
  try {
    await dependencies.probeTemporaryWorkspace();
  } catch {
    checks.push(
      bunCheck(
        "temporary-workspace",
        "BLOCKED",
        "A disposable runtime workspace could not be created and cleaned up.",
        "RUNTIME_TEMPORARY_WORKSPACE_UNAVAILABLE",
        "Grant access to the operating-system temporary directory.",
      ),
    );
    return finishBunDoctor(repositoryRoot, checks, "bun:test", bunVersion);
  }
  checks.push(bunCheck("temporary-workspace", "PASS", "Disposable workspace is available."));
  try {
    await dependencies.runSyntheticPreflight();
  } catch {
    checks.push(
      bunCheck(
        "synthetic-preflight",
        "BLOCKED",
        "Bun Inspector discovery or assertion probes failed.",
        "RUNTIME_BUN_PREFLIGHT_FAILED",
        "Reinstall AssertLedger and rerun runtime doctor.",
      ),
    );
    return finishBunDoctor(repositoryRoot, checks, "bun:test", bunVersion);
  }
  checks.push(bunCheck("synthetic-preflight", "PASS", "Bun Inspector probes passed."));
  return finishBunDoctor(repositoryRoot, checks, "bun:test", bunVersion);
}

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
