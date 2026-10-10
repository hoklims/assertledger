# Changelog

## Unreleased

## 2.0.0 — 2026-10-10

- Breaking producer change: `audit()` and the audit CLI emit schema v2 with the applied exclusion
  names and their source (`request`, `config`, `defaults`). Strict consumers expecting v1 output
  must select the v2 schema/parser. Historical v1 schemas, parsers and artifacts remain supported.
  See the [audit migration guide](docs/repository-audit-v2-migration.md).
- With a verification request, audit inventories exactly the request exclusions plus defaults,
  matching campaign copying and cost projection. Without a request, a valid initialization
  configuration supplies exclusions. Configuration never hides files from a campaign audit.
- Return structured `CONFLICT` results for doctor/init inventory limits instead of validation
  exceptions: base-test count, evidence path length and generated plan content. The 1,000-test
  limit remains unchanged, and conflicts install no managed files.
- Explain all static doctor/init reason codes with actionable guidance, including explicit
  framework selection for ambiguous repositories. Campaign outcome and digest policies are unchanged.

## 1.5.0 — 2026-10-10

- Add obligation-based qualification through CLI, SDK and MCP, with plans sealed before execution,
  strict receipts and deterministic replay. Receipts name covered and open guarantees; omitted or
  unsupported suites remain open. See the [qualification guide](docs/orchestration-qualification.md)
  and [additive contract migration](docs/migration-orchestration-qualification-v1.md).
- Qualify the anonymous `public-turbo-orchestration-2.11.7-bun-1.4.2` profile for seven local
  obligations, using isolated cold, warm and invalidation caches, physical task execution and output
  restoration, uncached-task repetitions, end-to-end failure propagation and local CI routing.
  Its fifteen declared faults are checked against reference and neutral worlds. The nine private
  consumer obligations, including independent observation of real Bitbucket CI, remain open.
- Attribute native Node and Bun assertions to their owning test files. Fresh structured-command
  completion and terminal observations distinguish expected nonzero exits from crashes, timeouts,
  collection failures and exceptions after a report. Opaque zero-exit commands cover only that
  exit-code check and cannot supply a fault discriminant.
- Refuse incomplete or contradictory test inventories, stale reports, unknown adapter versions,
  altered receipts and evidence reused outside its bound domain. Replay verifies integrity and
  decision semantics; it neither reruns tests nor authenticates the observation producer.

Verification request and evidence manifest v4 verify existing Bun tests by name, judge repository
links against the tests that run, and declare every isolation level. V1 to v3 schemas, parsers and
manifests are unchanged. See the [v4 migration guide](docs/migration-verification-v4.md).

- New `bun-test-designated` adapter (v4): runs one existing `bun:test` test, named by file and
  describe path, with an optional expected first failure line and a declared per-test timeout. Only a
  built-in matcher or `assertSame` failure attributed to that test is red; a timeout, crash, hook,
  collection or compile error, or a missing test never is, and diverging runs are `UNSTABLE`. It
  runs trusted-local, Windows-native or in a container, including the native WSL2 engine through
  `--container-runtime`; `bun-test` with candidate files is still refused in a container.
- New `import-witness` command and `importWitness` SDK method: replay a recorded red/green witness
  (mutated targets with base digests, a designated test and its failure line) as a v4 campaign under
  an operator-chosen backend, and save the manifest, executed request and summary in a new directory.
- Behavior change: `doctor` no longer refuses a repository for a link outside every test closure.
  It plans the repository and reports `REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE`, plus
  `TEST_CLOSURE_UNBOUNDED` when a test's imports are computed. A link on a test's module closure,
  one through which a runner could discover a test, or one leaving the root still refuses, now with
  `REPOSITORY_LINK_IN_TEST_CLOSURE` or `REPOSITORY_LINK_ESCAPES_ROOT` beside
  `UNSUPPORTED_REPOSITORY_SYMLINK`, and the CLI names the path. Because the closure depends on the
  framework, a framework conflict is now reported before a link refusal. `analyze`, `audit` and
  v1 to v3 campaigns still refuse any link.
- v4 campaigns leave links outside the executed tests' closure out of the snapshot and record them in
  the manifest; `repository.includeDependencies` keeps `node_modules`, and `repository.git:
  "synthesized"` gives tests a fresh, deterministic Git repository of the snapshot, recorded by tree.
- New `windows-native` isolation (v4) for tests that only run natively on Windows: declared in the
  request, acknowledged with `--allow-windows-native-execution`, refused on other hosts, and
  recorded as `WINDOWS_NATIVE_UNSANDBOXED`.
- Tightened: the v3 `bun-test` driver now classifies any test Bun reports as timed out as an
  infrastructure error, so a synchronous test that overran its timeout before failing an assertion
  is no longer counted as an assertion failure.
- New schemas `verification-request.v4.json`, `evidence-manifest.v4.json` and
  `witness-import-request.v1.json` join the post-conformance lock; the frozen v1 bundle is unchanged.

## 1.4.0 — 2026-10-02

- Behavior change: `analyze` now refuses an unknown option with the usage on stderr and exit code 64,
  and writes nothing to stdout. It used to ignore the option silently, so
  `analyze . --exclude .claude` ran on the full set while looking as if the exclusion were applied.
  `--json` stays accepted (the output is always JSON), and `analyze`, `analyze <repository>` and
  `analyze <repository> --json` are unchanged, byte for byte. Exit codes are a public contract: an
  invocation that carried an ignored option and exited 0 now exits 64. Migration: drop the option;
  to leave an entry out of the analyzed set, declare it with `assertledger init --exclude NAME`,
  which records it in `assertledger.config.json` for `analyze` to honor. An argument that starts
  with `-` is an option, so a repository directory whose name starts with `-` is passed as
  `./-name`. No other command changes with this entry; reason codes, schemas and digests are
  unchanged.

## 1.3.1 — 2026-10-02

- A refused repository link is now named. After the unchanged `UNSUPPORTED_REPOSITORY_SYMLINK`
  line, `analyze` on the CLI prints `Link detail: "<path>"` and the catalogue guidance, and
  `assertledger_analyze` returns the same lines in its error. The path is the first link found,
  quoted as a JSON string with every non-printable-ASCII character escaped and long names
  truncated, because a file name is repository content. The error message, exit code 4, schemas and
  digests are unchanged; `doctor` still reports the code only.
- The `UNSUPPORTED_REPOSITORY_SYMLINK` guidance no longer suggests that `analyze` takes
  `--exclude`: it belongs to `doctor` and `init`, and `init` records it in `assertledger.config.json`
  for `analyze` to honor.

## 1.3.0 — 2026-09-25

AssertLedger now offers one conflict-checked onboarding command for static repository initialization
and project-local agent connection, plus a bounded demonstration of the installed engine.

- `setup [repository] --client codex|claude-code` previews initialization and client artifacts as
  one JSON plan. `--write` applies it only after both preflights succeed; a second run is unchanged.
- A connection conflict discovered after initialization rolls back only regular init files created
  by that setup call whose bytes still match the applied plan. Changed or regenerated files are
  preserved and reported as `PARTIAL_FAILURE` with exit code 5 and explicit unresolved paths.
- `demo --allow-unsafe-execution` copies the packaged `node:test` example to a disposable temporary
  directory, executes it there and removes it. Its result is scoped to `SHIPPED_FIXTURE_ONLY`, keeps
  the exact `VERIFIED`, `REJECTED`, `INCONCLUSIVE` or `ENGINE_ERROR` decision and uses the same exit
  codes as `verify`.

## 1.2.0 — 2026-09-25

An explicitly authored `bun:test` regression candidate can now produce attributed AssertLedger
evidence on the qualified Bun 1.4.2 runtime. The built-in v3 adapter wraps `bun:test` callbacks
before test files load and identifies only errors thrown by the packaged `assertSame` helper.
Native Bun `expect` failures stay non-attributed. Bun's JUnit totals check completeness; they
never decide whether a failure is an assertion.

- Add verification request/evidence manifest v3, Bun initialization v2, and Bun runtime doctor v2.
  Historical v1/v2 schema bytes and replay remain unchanged; the new schemas extend the additive
  schema lock. The manifest binds Bun executable, driver, preload, helper, and preflight identity.
- Pin Bun 1.4.2 on the Windows, Linux, and macOS verification matrix. The adapter uses serialized
  `bun:test` callback instrumentation in explicitly unsandboxed trusted-local execution; container
  Bun requests are refused. Missing or inconsistent callback and JUnit counts, ordinary errors,
  and timeouts cannot kill a target.
- Carry assertion ownership from the preload through a signed process pipe and emit the final
  report from the driver. Candidate-written files cannot forge either evidence channel. Ownership
  is scoped to each test callback execution, including each parameterized row, so a saved error
  cannot be replayed. AsyncLocalStorage preserves that scope across asynchronous continuations.
  Multiple failing candidate rows are credited only when every failure is an owned assertion.
- Package the `assertledger/bun` helper and validate its JavaScript and TypeScript exports in a
  fresh package consumer. See [verification v3 migration](docs/migration-verification-v3.md).
- Let static `doctor` select `--framework bun:test` in mixed repositories, including through SDK
  and MCP, without executing repository code.

Compatibility: existing Node and structured-command requests keep their v1/v2 contracts and
decisions. Bun campaigns require v3 requests and new candidate tests that import `assertSame`;
old Bun `expect` tests can remain base controls but their failures do not count as target evidence.
The v1 evidence provider/export surface does not project Bun v3 evidence.

A repository that keeps a local-only symbolic link, such as an agent's skill directory, can now be
diagnosed and initialized without weakening the link refusal.

- `doctor` and `init` accept `--exclude NAME`, repeatable, and the MCP `assertledger_doctor` tool an
  optional `exclude` array. Each value is one portable entry name, skipped at any depth like the
  defaults; anything else is a `CONFLICT` with `INVALID_REPOSITORY_EXCLUDE`. The names are written to
  `repository.exclude`, and a valid configuration's list then applies to `init` and `doctor` without
  flags, `analyze` and runtime doctor's configuration check. A different explicit list fails closed,
  for example with `CONFIG_CONFLICT`, or with `UNSUPPORTED_REPOSITORY_SYMLINK` when it exposes a
  link again.
- `audit`, campaign copies and manifest digests ignore the configured list: they keep the defaults
  and, for a campaign, the verification request's `repository.exclude`. `audit` therefore still
  refuses a repository whose linked entry is only declared in the configuration.
- A link inside the inventory still fails closed. `init` and every static doctor now report it as a
  `CONFLICT` result with `UNSUPPORTED_REPOSITORY_SYMLINK` instead of throwing, so the CLI keeps exit
  code 4 and the MCP tool returns the result instead of an error. `analyze` still throws. Runtime
  doctor therefore reports such a repository as `RUNTIME_CONFIGURATION_BLOCKED` instead of
  `RUNTIME_CONFIGURATION_UNAVAILABLE`.
- `explain UNSUPPORTED_REPOSITORY_SYMLINK` now has a catalogue entry, and the
  `INVALID_REPOSITORY_EXCLUDE` guidance describes entry names.
- `isRepositoryExcludeName` is exported beside the configuration parser, and `analyzeRepository`
  takes an optional `{ configuredExcludes: true }`; without it, the engine function is unchanged.

Compatibility: schema, policy, profile, benchmark and conformance versions, manifest, audit and
benchmark digest projections are unchanged. `setup` and `demo` are additive CLI surfaces; existing
`init`, `connect`, SDK and MCP contracts remain available. The public `analyze` result, whose digest
is not evidence, now omits configured names, so its `files` and `repositoryDigest` can differ from an
audit of the same tree. A configuration written by 1.1.1 plans the same bytes. A configuration whose
`repository.exclude` was edited by hand used to return `CONFIG_CONFLICT`; its names now apply to the
static inventory. SDK callers that caught the `UNSUPPORTED_REPOSITORY_SYMLINK` rejection from `init`
or `doctor` now receive a `CONFLICT` result.

## 1.1.1 — 2026-09-23

A candidate whose runs hang or fail in the infrastructure is no longer reported as an invalid test.
`TIMEOUT` and `INFRA_ERROR` observe nothing, as the proof model already said, so such a candidate
is now inconclusive.

- When every run that fails candidate discovery is `TIMEOUT` or `INFRA_ERROR`, the `DISCOVERY` gate
  fails with `CANDIDATE_EXECUTION_INCONCLUSIVE` and the candidate is `INCONCLUSIVE`, instead of
  `INVALID` with `CANDIDATE_DISCOVERY_INVALID`. A campaign that selects no candidate then ends
  `INCONCLUSIVE` (exit code 3) instead of `REJECTED` (exit code 2), never with a selection.
- A completed run that disproves discovery still makes the candidate `INVALID`, and a timeout or an
  infrastructure error still never counts as a kill.
- Internal: `src/proof-planner`, which is not exported, plans proportionate evidence for a change;
  see `docs/proof-planner.md`.

Compatibility: schema, policy, profile, benchmark and conformance versions, the conformance-v1 lock
and the digest projections are unchanged. Manifests sealed by 1.1.0 or earlier with such a
candidate, including `VERIFIED` ones with an affected neighbour, no longer replay: their decision
semantics fail. Every other manifest replays unchanged.
`docs/migration-timeout-discovery-inconclusive.md` records the decision to keep `policyVersion`
`1.0.0`, its cost and the alternative.

## 1.1.0 — 2026-09-18

AssertLedger can run a qualification campaign in fresh Linux containers instead of on the host.
Version 2 of the verification request and evidence manifest adds this `container` backend beside
v1, which is unchanged. Replay-valid evidence can also be exported to external consumers.

- Container isolation through `check --container-image NAME@sha256:DIGEST`, with an optional
  `--container-runtime` JSON argv, and through `verify` for v2 requests.
- Each probe, preflight and observation runs in a fresh container with no host mount, no network,
  a read-only root filesystem, dropped capabilities, a non-root user and resource limits.
- The backend is probed before any execution: a missing runtime, an unreachable or non-Linux daemon,
  or an absent or differently identified image stops with a cataloged diagnostic; nothing is pulled.
- Verification request and evidence manifest v2 contracts; v2 manifests bind the execution backend
  to the decision digest. `assertledger schema` prints both v2 schemas; the SDK adds `verifyV2()`,
  `checkGitRegressionV2()` and v2 parsers.
- Evidence export: CLI `provider`, `export` and `export-replay`, matching SDK methods and read-only
  MCP tools. Unrecorded data stays `UNKNOWN` or `NOT_RECORDED`, and tampered or re-digested exports
  fail replay.
- `dist/build-info.json` records the source revision of the build.
- Agentic Test Profile v1 CLI exit codes are documented; the copyable profile-manifest example now
  exits like `assertledger profile` instead of returning 2 for every non-qualified status.
- The CI checks job also runs on macOS; Linux CI runs hostile container scenarios against a real
  Docker Engine.

Compatibility: v1 schema bytes, the conformance-v1 lock, decision and artifact digest projections,
outcomes, gates and reason-code semantics are unchanged; v1 requests still produce v1 manifests
that replay as before. SDK `verify()` and `checkGitRegression()` keep their 1.0.0 inputs, results
and types. A request declaring `schemaVersion: "2.0.0"`, previously refused with
`SCHEMA_VERSION_UNSUPPORTED`, is now validated as v2 by CLI `verify`, `verifyV2()` and
`verifyCampaign()`. Container failures use new `CONTAINER_*` and `ISOLATION_MODE_CONFLICT` reason
codes with CLI exit code 4. The six new schemas are locked additively in
`conformance/schema-extensions.json`. New MCP tools also have legacy `testforge_*` names.

Scope: `trusted-local` stays explicitly `UNSANDBOXED` and still requires `--allow-unsafe-execution`.
Containers share the daemon host's kernel, and the daemon, the image and the engine remain trusted.
Only Linux daemons are supported, images must already be present, and AssertLedger does not bound
the workspace volume. MCP, evidence export, Agentic Test Profiles and benchmarks accept only v1.

## 1.0.0 — 2026-09-08

AssertLedger qualifies a committed JavaScript `node:test` regression against a declared buggy
revision, its correction and a neutral control. The same candidate bytes run in all three worlds;
only attributed assertion failures can count as detection. Evidence can be replayed without a model.

- High-level Git qualification through CLI, SDK and operator-enabled MCP.
- Static doctor plus explicitly authorized runtime probes for Node, discovery, reporter and attribution.
- Versioned reason-code explanations with matching CLI, SDK and MCP results.
- Project-local Codex and Claude Code configuration and skills, generic MCP descriptor, safe removal.
- English and French getting-started guides and a reproducible historical bug example.
- Fresh-consumer package checks on Windows/Linux and Node 22.15/24.
- Static discovery keeps progressing when context-free scanning encounters a zero-width token.

Compatibility: legacy `testforge` CLI/MCP names and the `TestForge` SDK alias remain available.
Existing wire major versions, schema identities and manifest digest projections are preserved.
Runtime doctor and diagnostic guidance are additive contracts; neither changes existing evidence.
Client connection preview now includes both configuration and skill content. Existing differing
configuration files are refused. Unsafe managed paths return `INIT_MANAGED_PATH_UNSAFE`.

Scope: trusted-local execution is explicitly unsandboxed. The Git workflow supports committed,
dependency-free JavaScript and stable file topology. Other test frameworks, dependency transport,
hostile-code isolation and empirical performance or adoption claims retain separate qualification.
