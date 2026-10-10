import {
  DiagnosticCodesSchema,
  type DiagnosticReport,
  DiagnosticReportSchema,
} from "./contracts/diagnostics.js";

export type { DiagnosticReport };
export { DiagnosticCodesSchema, DiagnosticReportSchema };

type Entry = readonly [explanation: string, nextAction: string, severity?: "info" | "limitation"];
const CATALOGUE: Readonly<Record<string, Entry>> = {
  REPOSITORY_ROOT_INVALID: [
    "The initialization root does not resolve to an accessible directory.",
    "Pass an existing repository directory to init or doctor and check its access permissions.",
  ],
  PACKAGE_MANIFEST_INVALID: [
    "The repository package.json is not a valid JSON object.",
    "Repair package.json and rerun static doctor before applying initialization.",
  ],
  PACKAGE_MANAGER_INVALID: [
    "The packageManager field names an unsupported package manager.",
    "Use pnpm, npm, yarn, bun, uv, poetry or pip in the package manifest, matching the repository toolchain.",
  ],
  PACKAGE_MANAGER_OVERRIDE_INVALID: [
    "The explicit package-manager choice is unsupported.",
    "Select pnpm, npm, yarn, bun, uv, poetry or pip with --package-manager.",
  ],
  PACKAGE_MANAGER_AMBIGUOUS: [
    "The detected package managers conflict or disagree with the explicit choice.",
    "Inspect the packageManager field and lockfiles, then choose the intended manager with --package-manager.",
  ],
  PACKAGE_MANAGER_UNDETECTED: [
    "No supported package manager was detected.",
    "Declare the intended package manager with --package-manager or add its package metadata or lockfile.",
  ],
  FRAMEWORK_AMBIGUOUS: [
    "Multiple test frameworks were detected, or the explicit choice disagrees with the detected frameworks.",
    "Inspect test imports, dependencies and test scripts, then choose a detected framework with --framework (node:test, bun:test, vitest, jest or pytest). The current init result schema cannot list all detected frameworks.",
  ],
  FRAMEWORK_UNDETECTED: [
    "No supported test framework was detected.",
    "Declare the intended runner with --framework or add its test imports, dependency or test script.",
  ],
  FRAMEWORK_OVERRIDE_INVALID: [
    "The explicit framework choice is unsupported.",
    "Select node:test, bun:test, vitest, jest or pytest with --framework.",
  ],
  TEST_COMMAND_INVALID: [
    "The explicit test command is not a safe bounded executable and argument array.",
    "Pass --test-command-json with a relative executable name and at most 100 arguments; avoid shell syntax, absolute paths and control characters.",
  ],
  TEST_COMMAND_UNSAFE_OR_AMBIGUOUS: [
    "The package test script cannot be interpreted as one safe executable and argument array.",
    "Review the runner command and declare it through --test-command-json; initialization does not execute shell scripts.",
  ],
  BASE_TEST_FILES_UNAVAILABLE: [
    "No base test files were found for the selected built-in adapter and test command.",
    "Check the test paths and runner selection, then rerun doctor with the intended framework and test command.",
  ],
  BASE_TEST_FILES_LIMIT_EXCEEDED: [
    "The selected built-in adapter inventory contains more than the 1,000 base test files allowed by the contract.",
    "Scope the test command to an operator-reviewed suite of at most 1,000 base tests, or declare exclusions only for files the campaign does not need. Initialization never truncates the inventory.",
  ],
  INIT_EVIDENCE_PATH_LIMIT_EXCEEDED: [
    "An inventoried evidence path exceeds the initialization lock limit of 1,024 characters.",
    "Shorten the repository-relative path, or exclude only evidence the intended campaign does not need, then rerun static doctor.",
  ],
  INIT_FILE_CONTENT_LIMIT_EXCEEDED: [
    "A generated configuration or evidence lock exceeds the planned-file limit of 16,777,216 characters.",
    "Review the inventory and narrow initialization to the intended repository scope; exclude only irrelevant files. No managed file has been written for this plan.",
  ],
  OFFICIAL_ADAPTER_UNAVAILABLE: [
    "The detected framework has no built-in initialization adapter.",
    "Supply a supported structured-command adapter with --adapter-config and validate its attribution protocol before running a campaign.",
  ],
  REPOSITORY_INIT_CONFIG_INVALID: [
    "The generated initialization configuration does not satisfy its versioned schema.",
    "Inspect the adapter, test command and inventory limits; rerun static doctor after correcting the inputs and report a reproducible generated-config failure.",
  ],
  REPOSITORY_INIT_CONFIG_INCONSISTENT: [
    "Initialization configuration fields do not satisfy their semantic consistency rules.",
    "Check portable paths, framework and adapter agreement, then validate the configuration before applying it.",
  ],
  REPOSITORY_INIT_LOCK_INVALID: [
    "The initialization evidence lock does not satisfy its versioned schema.",
    "Inspect evidence paths and the lock schema; preserve configuration and regenerate the lock through init after correcting the inputs.",
  ],
  REPOSITORY_INIT_LOCK_INCONSISTENT: [
    "The initialization lock evidence, detections or digests are inconsistent.",
    "Restore stable repository evidence and regenerate the lock through init; do not repair its digest by hand.",
  ],
  REPOSITORY_INIT_RESULT_INVALID: [
    "The initialization result does not satisfy its versioned output schema.",
    "Inspect the reported plan and generated-file size limits; retain a reproduction and report the output-contract failure.",
  ],
  REPOSITORY_INIT_RESULT_INCONSISTENT: [
    "The initialization result, planned files and actions disagree.",
    "Preserve managed files, rerun static doctor on a stable repository and report a reproducible inconsistent plan.",
  ],
  REPOSITORY_INIT_CANONICAL_INVALID: [
    "Initialization could not canonicalize a contract value safely.",
    "Use schema-valid JSON inputs and retain a reproduction if generated initialization values still fail canonicalization.",
  ],
  PORTABLE_PATH_COLLISION: [
    "Repository paths collide under the portable case and Unicode normalization rules.",
    "Rename the conflicting entries so their portable paths are distinct before rerunning doctor or init.",
  ],
  INIT_EVIDENCE_SNAPSHOT_INCONSISTENT: [
    "An initialization evidence file has no matching captured bytes.",
    "Keep repository files stable and rerun static doctor; report a reproducible snapshot mismatch.",
  ],
  INIT_PLAN_INCONSISTENT: [
    "An initialization write action has no matching planned file.",
    "Preserve existing configuration and report the inconsistent plan before retrying initialization.",
  ],
  INIT_WRITE_FAILED: [
    "Initialization could not install a managed file atomically.",
    "Inspect permissions and the reported installed paths and temporary cleanup state; preserve partial files and rerun static doctor before retrying.",
  ],
  INVALID_REPOSITORY_EXCLUDE: [
    "A repository exclusion is malformed.",
    "For init and doctor, declare bare file or directory names without separators, at most 1,000 including the defaults; a verification request needs an array of strings. Every entry with an excluded name is skipped at any depth. Retain every source and base test required by the declared campaign.",
  ],
  UNSUPPORTED_REPOSITORY_SYMLINK: [
    "The analyzed repository set contains a symbolic link; AssertLedger neither follows nor copies links.",
    "Replace the link with a regular file or directory, or declare the name of the entry that contains it when no campaign needs it: pass --exclude to doctor or init, and init records it in assertledger.config.json for analyze and audit without a request to honor. Audit with a verification request uses only that request's exclusions plus defaults, matching the campaign copy; configuration cannot hide campaign files. Never exclude sources or tests the campaign requires.",
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
  BUN_TEST_VERSION_UNSUPPORTED: [
    "The selected Bun runtime is outside the qualified version and revision.",
    "Install Bun 1.4.2 and rerun the controlled runtime preflight.",
  ],
  BUN_TEST_EXECUTABLE_PROBE_FAILED: [
    "The selected executable could not establish a stable Bun identity.",
    "Check the Bun executable and its permissions, then rerun the runtime diagnostic.",
  ],
  BUN_TEST_PROFILE_PREFLIGHT_FAILED: [
    "Controlled Bun callback probes did not separate assertions from ordinary errors.",
    "Keep the campaign unqualified and inspect the Bun installation and AssertLedger package.",
  ],
  BUN_TEST_CONTAINER_UNSUPPORTED: [
    "The Bun file-candidate profile has not been qualified in the container backend.",
    "Use explicitly authorized trusted-local execution for the qualified Bun version, or a v4 campaign with the bun-test-designated adapter, which runs in the container backend.",
  ],
  BUN_TEST_ASSET_CHANGED_DURING_CAMPAIGN: [
    "The bundled Bun driver, preload or assertion helper changed during the campaign.",
    "Restore a stable installation and run the complete campaign again.",
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
  REPOSITORY_LINK_IN_TEST_CLOSURE: [
    "A symbolic link is on the module closure of a test that would run, or a runner discovering tests could reach one through it; AssertLedger neither follows nor copies links.",
    "Replace the named link with a regular file or directory; excluding it would remove code the test needs.",
  ],
  REPOSITORY_LINK_ESCAPES_ROOT: [
    "A symbolic link resolves, or would resolve, outside the repository root.",
    "Remove the named link or replace it with repository content; a link out of the repository is never admitted.",
  ],
  TEST_CLOSURE_UNBOUNDED: [
    "A test module imports a computed or absolute specifier, so the files it can load are not statically bounded.",
    "A campaign refuses repository links in that case; replace the links, or make the named imports literal and repository-relative.",
  ],
  REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE: [
    "Every repository link lies outside the module closure of the tests that would run; v4 campaigns leave such links out of the snapshot and record them.",
    "No action is required; v1 to v3 campaigns and analyze still refuse any link, so declare the entry's name with --exclude when they must run.",
  ],
  WINDOWS_NATIVE_EXECUTION_NOT_ACKNOWLEDGED: [
    "Windows-native execution was requested without the operator acknowledgement.",
    "Run it only for trusted code, with --allow-windows-native-execution or acknowledgedUnsafeExecution set; the manifest then records WINDOWS_NATIVE_UNSANDBOXED.",
  ],
  WINDOWS_NATIVE_HOST_REQUIRED: [
    "Windows-native execution was requested on a host that is not Windows.",
    "Use the container backend for Linux-runnable tests, or run the campaign on Windows.",
  ],
  DESIGNATED_CANDIDATE_REQUIRED: [
    "The bun-test-designated adapter runs only designated tests, and a candidate declares files instead.",
    "Name each candidate's existing test by file and describe path, or use the bun-test adapter for candidate files.",
  ],
  DESIGNATED_CANDIDATE_ADAPTER_MISMATCH: [
    "A designated test candidate was given to an adapter that runs candidate files.",
    "Use the bun-test-designated adapter for designated tests.",
  ],
  DESIGNATED_TEST_OVERLAID: [
    "A world rewrites the designated test file, so the test under verification would differ between worlds.",
    "Keep the designated test identical in every world and mutate only the code it covers.",
  ],
  DESIGNATED_TEST_FILE_MISSING: [
    "A designated test file is absent from the repository snapshot.",
    "Check the file path against the repository and its declared exclusions.",
  ],
  DESIGNATED_TEST_TIMEOUT_EXCEEDS_EXECUTION: [
    "Bun's per-test timeout is not shorter than the execution timeout, so it could never be observed.",
    "Declare a per-test timeout below timeoutMsPerExecution, or null for Bun's default.",
  ],
  REPOSITORY_DEPENDENCIES_EXCLUDED: [
    "The request includes dependency directories but also excludes node_modules.",
    "Remove node_modules from the exclusions, or set includeDependencies to false.",
  ],
  REPOSITORY_GIT_SYNTHESIS_FAILED: [
    "The synthesized Git repository of the snapshot could not be created.",
    "Check that git is installed and runnable, or set repository.git to excluded when the tests do not need Git.",
  ],
  WITNESS_IMPORT_REQUEST_INVALID: [
    "The witness import request does not satisfy its published schema.",
    "Validate it against witness-import-request.v1.json.",
  ],
  WITNESS_TARGET_BASE_MISMATCH: [
    "A witness target is missing or no longer holds the bytes the witness recorded as its base.",
    "Replay the witness on the exact revision it was recorded against.",
  ],
  WITNESS_TARGET_UNCHANGED: [
    "A witness target's mutated content equals the repository's bytes, so it would not inject a fault.",
    "Check the recorded mutation.",
  ],
  WITNESS_OUTPUT_EXISTS: [
    "The witness import output directory already exists.",
    "Choose a new directory; an import never overwrites earlier evidence.",
  ],
  WITNESS_OUTPUT_INSIDE_REPOSITORY: [
    "The witness import output directory is inside the repository it replays.",
    "Choose a directory outside the repository so the evidence cannot change the snapshot.",
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

const LINK_REFUSAL_CODES = new Set([
  "UNSUPPORTED_REPOSITORY_SYMLINK",
  "REPOSITORY_LINK_IN_TEST_CLOSURE",
  "REPOSITORY_LINK_ESCAPES_ROOT",
  "TEST_CLOSURE_UNBOUNDED",
]);
const MAXIMUM_QUOTED_ENTRY_LENGTH = 200;

/** Quotes a repository entry name for a refusal message. A file name is repository content, so it
 * is untrusted: every character outside printable ASCII is escaped, and a long name is cut. */
export function quoteRepositoryEntry(entry: string): string {
  const quoted = JSON.stringify(entry.slice(0, MAXIMUM_QUOTED_ENTRY_LENGTH)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return entry.length > MAXIMUM_QUOTED_ENTRY_LENGTH ? `${quoted} (truncated)` : quoted;
}

/** The lines that follow the stable code when a repository link refuses an analysis: the link
 * itself, then the catalogue guidance. Undefined for any other error, or when no link is named. */
export function renderRepositoryLinkRefusal(error: unknown): string | undefined {
  if (
    !(error instanceof Error) ||
    !LINK_REFUSAL_CODES.has(error.message) ||
    typeof error.cause !== "string"
  ) {
    return undefined;
  }
  return `Link detail: ${quoteRepositoryEntry(error.cause)}\n${renderDiagnostics([error.message])}`;
}

export function renderDiagnostics(codes: readonly string[]): string {
  return explainReasonCodes(codes)
    .diagnostics.map(
      (entry) => `${entry.code}: ${entry.explanation}\nNext action: ${entry.nextAction}`,
    )
    .join("\n");
}
