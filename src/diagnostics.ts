import {
  DiagnosticCodesSchema,
  type DiagnosticReport,
  DiagnosticReportSchema,
} from "./contracts/diagnostics.js";

export type { DiagnosticReport };
export { DiagnosticCodesSchema, DiagnosticReportSchema };

type Entry = readonly [explanation: string, nextAction: string, severity?: "info" | "limitation"];
const CATALOGUE: Readonly<Record<string, Entry>> = {
  INVALID_REPOSITORY_EXCLUDE: [
    "A repository exclusion is malformed.",
    "For init and doctor, declare bare file or directory names without separators, at most 1,000 including the defaults; a verification request needs an array of strings. Every entry with an excluded name is skipped at any depth. Retain every source and base test required by the declared campaign.",
  ],
  UNSUPPORTED_REPOSITORY_SYMLINK: [
    "The analyzed repository set contains a symbolic link; AssertLedger neither follows nor copies links.",
    "Replace the link with a regular file or directory, or declare the name of the entry that contains it with --exclude when no campaign needs it; never exclude sources or tests the campaign requires.",
  ],
  EXECUTION_BUDGET_EXCEEDED: [
    "The complete declared campaign exceeds the execution budget.",
    "Reduce the candidate batch while preserving required worlds and attempts; inspect the projected cost before retrying.",
  ],
  CANDIDATE_BUDGET_EXCEEDED: [
    "The candidate batch exceeds the declared limit.",
    "Submit a smaller candidate batch and retain the original evidence policy.",
  ],
  WORLD_BUDGET_EXCEEDED: [
    "The declared worlds exceed the campaign limit.",
    "Review the intended campaign scope and its budget; do not remove required controls to obtain a favorable verdict.",
  ],
  REPOSITORY_BYTES_BUDGET_EXCEEDED: [
    "The repository snapshot exceeds its byte budget.",
    "Inspect large generated files and exclude only irrelevant artifacts; required source and controls must remain included.",
  ],
  REPOSITORY_FILE_BUDGET_EXCEEDED: [
    "The repository snapshot exceeds its file-count budget.",
    "Inspect generated directories and narrow only irrelevant input; keep required source and controls.",
  ],
  UNSUPPORTED_ISOLATION: [
    "The requested isolation backend is unsupported.",
    "Keep the case unqualified unless a supported execution boundary is available. Trusted-local requires reviewed code and explicit consent; it is not a sandbox.",
  ],
  RUNTIME_EXECUTION_NOT_AUTHORIZED: [
    "Runtime probes have no explicit operator capability.",
    "Review the local trust boundary before explicitly permitting runtime probes.",
  ],
  RUNTIME_CONFIGURATION_STALE: [
    "Configuration or its evidence lock does not match the repository.",
    "Run static doctor and review the initialization plan before applying it.",
  ],
  RUNTIME_CONFIGURATION_BLOCKED: [
    "Configuration inspection reports a blocking conflict.",
    "Run static doctor and resolve its precise configuration reasons.",
  ],
  RUNTIME_CONFIGURATION_UNAVAILABLE: [
    "Configuration could not be inspected safely.",
    "Check the repository path and its managed configuration files with static doctor.",
  ],
  RUNTIME_ADAPTER_UNSUPPORTED: [
    "The runtime diagnostic does not support this adapter.",
    "Use the supported generated node:test adapter; detection does not establish qualification.",
  ],
  RUNTIME_DEPENDENCY_UNAVAILABLE: [
    "The controlled Node runtime cannot load its built-in test dependency.",
    "Repair the Node installation and rerun the runtime diagnostic.",
  ],
  RUNTIME_EXECUTABLE_UNAVAILABLE: [
    "The Node executable cannot establish a stable supported identity.",
    "Check the installed executable and permissions, then rerun runtime doctor.",
  ],
  RUNTIME_NODE_VERSION_UNSUPPORTED: [
    "The selected Node version is unsupported.",
    "Use Node 22.15 or later and rerun runtime doctor.",
  ],
  RUNTIME_PREFLIGHT_FAILED: [
    "The controlled reporter, discovery or attribution probes failed.",
    "Check Node and AssertLedger installation, then repeat the probes; do not count this as regression evidence.",
  ],
  RUNTIME_TEMPORARY_WORKSPACE_UNAVAILABLE: [
    "A disposable workspace could not be created, written or removed.",
    "Check access to the operating-system temporary directory and rerun the diagnostic.",
  ],
  RUNTIME_REPOSITORY_TESTS_NOT_EXECUTED: [
    "Runtime doctor checks synthetic probes without executing repository tests.",
    "Use an explicitly authorized check or verify campaign to assess the declared regression.",
    "limitation",
  ],
  POLICY_SATISFIED: [
    "The observations satisfy the declared policy.",
    "Replay the manifest and review the declared worlds and limitations before relying on it.",
    "info",
  ],
  TARGET_STRENGTH_INSUFFICIENT: [
    "The candidate did not detect enough declared bugs through an attributed assertion failure.",
    "Assert the corrected behavior, then rerun the same candidate against the declared buggy and control revisions.",
  ],
  NO_ELIGIBLE_CANDIDATE: [
    "No candidate passed all required evidence gates.",
    "Read the candidate reasons and fix the first failed gate before rerunning.",
  ],
  REFERENCE_NOT_GREEN: [
    "The candidate fails on a required corrected reference.",
    "Check the expected behavior and make the test pass on the corrected revision first.",
  ],
  NEUTRAL_NOT_GREEN: [
    "The candidate fails on a declared neutral control.",
    "Check that the control preserves the intended behavior and inspect the failed assertion.",
  ],
  OBSERVATIONS_DIVERGE: [
    "Repeated observations disagree.",
    "Remove nondeterministic inputs and rerun every required attempt; do not select the convenient observation.",
  ],
  CANDIDATE_DISCOVERY_INVALID: [
    "The runner did not discover and identify the expected candidate test.",
    "Check the committed test path, title and runner selection; ensure exactly the intended test is discovered.",
  ],
  CANDIDATE_EVIDENCE_INCOMPLETE: [
    "Required observations are missing.",
    "Resolve execution or budget failures and run the complete declared campaign again.",
  ],
  CANDIDATE_EXECUTION_INCONCLUSIVE: [
    "An operational failure prevents a conclusion about this candidate.",
    "Fix the timeout or infrastructure failure and rerun; operational errors do not prove bug detection.",
  ],
  CANDIDATE_EVIDENCE_INCONCLUSIVE: [
    "At least one candidate has unstable or incomplete evidence.",
    "Inspect candidate reasons and complete stable observations before accepting evidence.",
  ],
  CONTROL_EVIDENCE_INVALID: [
    "The base controls do not establish a valid campaign baseline.",
    "Fix the base tests or runner configuration on every declared world before testing the candidate.",
  ],
  EVIDENCE_INPUT_INVALID: [
    "The evidence does not satisfy the input contract.",
    "Validate the input with this package version's published schema and regenerate it from the original observations.",
  ],
  PREREQUISITE_GATE_FAILED: [
    "An earlier gate failed, so this gate was not evaluated.",
    "Resolve the first failed gate; an unrun gate is not a pass.",
  ],
  TIMEOUT: [
    "Execution exceeded its allowed duration.",
    "Diagnose the slow or stuck process and rerun; a timeout does not count as bug detection.",
  ],
  PROCESS_CRASH: [
    "The process failed without an attributable candidate assertion.",
    "Fix the runtime error and rerun; a generic throw does not count as bug detection.",
  ],
  INFRA_ERROR: [
    "The execution environment failed.",
    "Restore the required runtime and permissions, then repeat the campaign.",
  ],
  NO_TEST_DISCOVERED: [
    "The runner did not discover the required test.",
    "Check file selection and test registration before rerunning.",
  ],
  COMPILE_FAILURE: [
    "Compilation failed before valid assertion evidence was produced.",
    "Fix compilation and rerun; compiler errors do not count as bug detection.",
  ],
  COLLECTION_FAILURE: [
    "Test collection failed before valid assertion evidence was produced.",
    "Fix imports and test discovery, then rerun.",
  ],
  UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED: [
    "Local execution has not been authorized by the operator.",
    "Review the code and trust boundary. Use the explicit execution capability only for a trusted repository.",
  ],
  GIT_REGRESSION_UNSAFE_EXECUTION_NOT_ALLOWED: [
    "Git qualification requires an isolated container or explicit operator authorization for local code execution.",
    "Prefer a digest-pinned container image. Authorize UNSANDBOXED trusted-local execution only for reviewed code.",
  ],
  ISOLATION_MODE_CONFLICT: [
    "Container isolation and trusted-local authorization were requested together.",
    "Choose one execution mode: a container image for isolation, or trusted-local authorization for reviewed code only.",
  ],
  CONTAINER_RUNTIME_COMMAND_INVALID: [
    "The container runtime command is not a non-empty JSON argv array.",
    'Pass the executable and its arguments as a JSON array, for example ["docker"]; shell strings are never executed.',
  ],
  CONTAINER_RUNTIME_NOT_FOUND: [
    "The configured container runtime command could not be started; nothing was executed.",
    'Install a Docker-compatible CLI or pass its argv explicitly, for example ["wsl.exe","-d","Ubuntu","--exec","docker"].',
  ],
  CONTAINER_RUNTIME_UNAVAILABLE: [
    "The container runtime did not report a reachable daemon; nothing was executed.",
    "Start or repair the container daemon, confirm the runtime version command succeeds, then rerun.",
  ],
  CONTAINER_RUNTIME_PLATFORM_UNSUPPORTED: [
    "The container daemon does not run Linux containers.",
    "Use a daemon that runs Linux containers; Windows containers are unsupported.",
  ],
  CONTAINER_IMAGE_REFERENCE_INVALID: [
    "The container image is not pinned by a sha256 digest.",
    "Use NAME@sha256:DIGEST; mutable tags cannot identify the execution environment.",
  ],
  CONTAINER_IMAGE_NOT_PRESENT: [
    "The digest-pinned image is not present locally, and AssertLedger never pulls images.",
    "Review the image, pull it by the same digest with the runtime, for example docker pull NAME@sha256:DIGEST, then rerun.",
  ],
  CONTAINER_IMAGE_DIGEST_MISMATCH: [
    "The local image does not carry the pinned digest.",
    "Pull the exact digest again or correct the reference; do not substitute a mutable tag.",
  ],
  CONTAINER_IMAGE_PLATFORM_UNSUPPORTED: [
    "The pinned image is not a Linux image.",
    "Select a Linux image that provides the adapter executable.",
  ],
  CONTAINER_CLEANUP_FAILED: [
    "A finished container could not be removed, so no campaign result was produced.",
    "Remove containers labeled assertledger.execution with the runtime, check the daemon, then rerun.",
  ],
  MCP_REPOSITORY_ROOT_FORBIDDEN: [
    "The requested repository is outside this server's allowed roots.",
    "Use the intended project root or ask the operator to configure a server for that trusted project.",
  ],
  GIT_RUNTIME_DEPENDENCIES_UNSUPPORTED: [
    "This Git qualification path does not transport runtime dependencies.",
    "Use a dependency-free JavaScript node:test case with built-in or relative imports; keep other cases unqualified.",
  ],
  GIT_PACKAGE_IDENTITY_DRIFT_UNSUPPORTED: [
    "Dependency or package identity differs between the declared revisions.",
    "Choose compatible revisions for this supported path; do not conceal dependency changes.",
  ],
  GIT_REGRESSION_OUTPUT_EXISTS: [
    "The evidence directory already exists.",
    "Choose a new output directory so existing evidence stays intact.",
  ],
  GIT_REGRESSION_BASE_TESTS_INVALID: [
    "The base-test selection does not satisfy the supported Git contract.",
    "Declare existing JavaScript base tests whose bytes remain identical across the three revisions.",
  ],
  NODE_TEST_VERSION_UNSUPPORTED: [
    "The selected Node runtime is outside the supported range.",
    "Use Node 22.15 or later and rerun the runtime diagnostic.",
  ],
  NODE_TEST_EXECUTABLE_PROBE_FAILED: [
    "The selected executable could not establish its Node identity.",
    "Check the installed Node executable and its permissions, then rerun the runtime diagnostic.",
  ],
  NODE_TEST_REPORTER_MISSING: [
    "The package's controlled Node reporter is unavailable.",
    "Reinstall the complete published package and rerun the runtime diagnostic.",
  ],
  NODE_TEST_PROFILE_PREFLIGHT_FAILED: [
    "Controlled reporter discovery or attribution did not match the supported protocol.",
    "Check the package and Node versions, then reinstall and rerun the diagnostic; keep the evidence unqualified.",
  ],
  INIT_MANAGED_PATH_UNSAFE: [
    "A managed configuration path is a link or a nonregular file.",
    "Inspect the path manually and use regular project-local files; existing content is preserved.",
  ],
  CONFIG_CONFLICT: [
    "Existing configuration differs from the detected initialization plan.",
    "Review the proposed configuration alongside your existing file and resolve the difference explicitly.",
  ],
  LOCK_INVALID: [
    "The initialization lock does not satisfy the contract.",
    "Inspect the lock and regenerate it through initialization after preserving your configuration.",
  ],
  LOCK_CONFIG_MISMATCH: [
    "The lock refers to different configuration bytes.",
    "Review the configuration change, then regenerate its lock through initialization.",
  ],
  REPOSITORY_CHANGED_DURING_INIT: [
    "Repository evidence changed while the initialization plan was being prepared.",
    "Wait until the repository is stable and rerun the diagnostic.",
  ],
  ADAPTER_CONFIG_INVALID: [
    "The adapter configuration is invalid.",
    "Validate it against the published schema and use the supported node:test adapter.",
  ],
  ADAPTER_FRAMEWORK_INCOMPATIBLE: [
    "The adapter and detected test framework do not match.",
    "Select the adapter matching the test runner; detection alone does not establish official support.",
  ],
};

/** Derived guidance only: never changes a verdict or either manifest digest. */
export function explainReasonCodes(codes: readonly string[]): DiagnosticReport {
  const parsed = DiagnosticCodesSchema.safeParse(codes);
  if (!parsed.success) throw new TypeError("DIAGNOSTIC_CODES_INVALID");
  return DiagnosticReportSchema.parse({
    catalogueVersion: "1.0.0",
    diagnostics: [...new Set(parsed.data)].sort().map((code) => {
      const entry = CATALOGUE[code];
      return {
        code,
        known: entry !== undefined,
        severity: entry?.[2] ?? (entry ? "blocking" : "limitation"),
        explanation: entry?.[0] ?? "This code has no explanation in the installed catalogue.",
        nextAction:
          entry?.[1] ??
          "Keep the original result and consult the matching package version's reference; do not infer a pass.",
      };
    }),
  });
}

export function renderDiagnostics(codes: readonly string[]): string {
  return explainReasonCodes(codes)
    .diagnostics.map(
      (entry) => `${entry.code}: ${entry.explanation}\nNext action: ${entry.nextAction}`,
    )
    .join("\n");
}
