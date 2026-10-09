# Public orchestration qualification

This independently authored workspace reproduces the evidence gap behind incident #911:
two extractible `node:test` assertions check command shapes and keep passing while actual
cache, failure propagation and pipeline routing faults are present. It contains no private
consumer source, URLs, credentials or hosted infrastructure.

The named profile `public-turbo-orchestration-2.11.7-bun-1.4.2` requires Turbo 2.11.7,
Bun 1.4.2, pnpm 12.9.1 and the exact executable identities recorded in its manifest.
Run the builder under Node with `tsx`, providing absolute paths to those executables:

```text
node node_modules/tsx/dist/cli.mjs scripts/qualify-orchestration-profile.ts --turbo=/absolute/turbo --bun=/absolute/bun --pnpm=/absolute/pnpm --output=/absolute/evidence --commit=reviewed-commit --base=reviewed-base
```

On Windows `--pnpm` names the installed native `pnpm.exe`, rather than a PowerShell
shim, Corepack entry point or shell string. The selected tool directories precede the
operator's PATH. PATH and essential Windows environment values are sealed in the plan.
No tool installation is performed by the campaign builder.

Provision qualification tools in a separate disposable directory, preserving its generated
lockfile, rather than adding dependencies to AssertLedger or a consumer repository:

```text
pnpm --dir /absolute/qualification-tools add --ignore-scripts --save-exact turbo@2.11.7 pnpm@12.9.1
```

Use the platform-specific native Turbo and pnpm executables inside that directory's
`node_modules/.pnpm` distributions. Install Bun 1.4.2 separately using the documented
platform installation method and pass its real executable. The builder probes versions
and hashes executable bytes. It deliberately refuses a different version. Provisioning
needs registry access; fixture setup runs offline with lifecycle scripts disabled.
Workspace links and normalized lockfiles are prepared before cold cache actions.

The operator's manifest declares seven obligations before execution. Reference and
documentation-only neutral worlds must pass. Fourteen declared fault worlds must mismatch
their named discriminants in two independent attempts. The leaf, Turbo and both wrapper
layers must return 7, as observed on this pinned profile. The expected nonzero reference result is not classified as a regression
assertion or a successful target kill.
Each layer validates the fresh nonce-bound semantic completion of its failed child, then emits
its own report with the observed exit. Ordinary errors, compilation failures and missing child
executables cannot supply that report. The trusted-local fixture reports are not authenticated.

Turbo build actions select the application and its leaf dependency. Each attempt has an
independent local cache, reused only across cold, warm and input-invalidation actions.
Warm actions delete generated outputs. Observations collect the real Turbo JSON summary,
selected task IDs, input task hashes, cache states, hashes of both required outputs, and
fresh action-specific nonce traces written by executing tasks. Cached console output does
not establish execution. The `check` task has caching disabled and must execute twice.

The cache worlds omit the verdict input, omit a restored output, or wrongly cache the
uncached task. Propagation worlds absorb an exit code, omit a mandatory stage, select no
work, overwrite failure with a later successful command, or reuse a seeded success.
The selected-task world removes the required dependency from the task graph. The CI worlds
disconnect the pull-request gate, add an unfulfilled changeset condition or make the gate manual
while preserving its command. The parser retains execution policy and full stage/parallel/step
ancestry, and refuses unsupported execution fields. It is an engine-owned asset outside the route
it observes. Configuration observation does not establish hosted execution.

Outputs are `manifest.json`, `receipt.json`, `replay.json`, `matrix.json` and
`incident-reproduction.json`. The builder exits nonzero if the profile is not QUALIFIED,
replay fails, or command-shape extraction detects an orchestration fault unexpectedly.

This public profile qualifies only its named local obligations. It never declares the
private consumer ready. Private suites, preloads, wrappers, browser/E2E/coverage behavior
and hosted Bitbucket execution require their own profile and evidence. Static CI routing
and local commands cannot discharge a hosted-pipeline obligation. Replay checks integrity
and deterministic semantics; it does not run commands again or authenticate their producer.
