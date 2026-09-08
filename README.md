# AssertLedger

AssertLedger checks whether a regression test detects the bug it claims to prevent. It runs the
same candidate against an explicit reference, known fault and neutral control, then produces a
deterministic verdict and replayable evidence. The first built-in adapter supports `node:test`.

This repository contains the development preview (formerly TestForge). The package is still
version `0.1.0`; the [1.0 release criteria](docs/release-1.0.md) are open. Use the source installation
below until a published release is announced. See [distribution checks](docs/distribution.md) for
what the installed-package smoke verifies.

> An agent may propose tests. Only a versioned decision policy may decide what the observed runs
> demonstrate.

AssertLedger does **not** prove program correctness, complete fault detection, universal oracle
quality, or permanent freedom from flakiness. It answers a narrower question: did the submitted
candidate distinguish the operator-supplied worlds during the recorded attempts under the declared
policy?

## Naming migration

The project's preferred public name is **AssertLedger**; the npm package is `assertledger` and the
`AssertLedger` class is the preferred SDK entry point. Existing integrations are not required to
migrate immediately:

- the `testforge` CLI binary remains installed alongside `assertledger` and runs the identical
  entrypoint;
- the `TestForge` SDK class remains exported as a subclass alias of `AssertLedger`;
- the MCP server registers every tool under both an `assertledger_*` and a legacy `testforge_*` name,
  bound to the same handler;
- all wire-level identifiers stay unchanged for replay compatibility: schema `$id` values under
  `https://testforge.dev/...`, the `testforge-command` adapter kind, every `TESTFORGE_*` reserved
  environment variable and canonicalization domain, and all published schema and conformance bytes.

See [`docs/migration-testforge-to-assertledger.md`](docs/migration-testforge-to-assertledger.md) for
the complete compatibility surface and the frozen wire identifiers.

## What works in v0.1

- deterministic repository analysis for agent context;
- candidate test overlays restricted to configured test roots;
- reference, target, and neutral worlds supplied as file overlays;
- one immutable repository snapshot per campaign and a fresh workspace for every attempt;
- repeated execution with explicit budgets, bounded output capture, and stream digests;
- controls showing whether each world was green before adding a candidate;
- a built-in `node:test` adapter with runtime discovery and file-based failure attribution;
- a framework-neutral structured-command adapter protocol;
- deterministic gates, marginal-coverage selection, and decision and artifact digests;
- a replayable Agentic Test Profile that keeps declared oracle strength separate from observed
  feedback latency;
- a replayable Agentic Benchmark Artifact for scoped cold/warm and phase-level cost evidence;
- JSON CLI, TypeScript SDK, MCP stdio server, JSON Schema, and an agent skill.
- static plug-and-play initialization with deterministic config and evidence-lock bytes.

The only execution backend in v0.1 is `trusted-local`. Every manifest records this backend as
`UNSANDBOXED`. **Do not use it for hostile or untrusted code.** Temporary directories, timeouts, and
an environment allowlist are resource controls, not a security boundary. See
[SECURITY.md](SECURITY.md).

## Architecture

```text
Agent or harness
      │
      ▼
Integration facade
Skill / MCP / JSON CLI / TypeScript SDK
      │
      ▼
AssertLedger orchestrator
Analysis / workspaces / execution / budgets / adapters
      │
      ▼
Deterministic core
Canonical evidence / gates / selection / manifest digests
```

Dependencies point downward. The core has no filesystem, process, network, clock, random, model, or
provider dependency. External execution can be nondeterministic; the decision function is
deterministic over normalized observations. See [docs/architecture.md](docs/architecture.md) and
[docs/proof-model.md](docs/proof-model.md).

## Install and verify

Requirements: Node.js 22.15 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

The following command executes repository and candidate code with the unsandboxed local backend.
Review the request first, then run it only on a disposable machine or an otherwise trusted checkout:

```sh
node dist/cli.js verify examples/node-test/request.json --allow-unsafe-execution --json
```

`dist/cli.js` is the same entrypoint installed as both the `assertledger` (preferred) and `testforge`
(legacy) binaries.

Expected process exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Command succeeded, campaign `VERIFIED`, profile `QUALIFIED`, or all benchmark regimes `MEASURED` |
| `2` | Campaign `REJECTED`, profile rejected/budget-missed, or benchmark observed a run failure |
| `3` | Initialization blocked, campaign `INCONCLUSIVE`, or insufficient timing samples |
| `4` | Initialization conflict, invalid request, or invalid manifest |
| `5` | Engine or infrastructure error |
| `64` | CLI usage error |

## JSON CLI

```sh
assertledger init . --dry-run --json
assertledger init . --json
assertledger audit . --json
assertledger analyze . --json
assertledger schema verification-request --json
assertledger verify assertledger.request.json --allow-unsafe-execution --json
assertledger replay assertledger.manifest.json --json
assertledger profile assertledger.profile-request.json --json
assertledger profile-replay assertledger.profile-report.json --json
assertledger profile-v2 assertledger.profile-v2-request.json --json
assertledger profile-v2-replay assertledger.profile-v2-report.json --json
assertledger benchmark assertledger.benchmark-request.json --json
assertledger benchmark-replay assertledger.benchmark-artifact.json --json
assertledger benchmark-acquire assertledger.benchmark-acquisition-request.json --allow-unsafe-execution --json
assertledger benchmark-acquire-replay assertledger.benchmark-acquisition-result.json --json
assertledger mcp
# Operator-only opt-in: assertledger mcp --allow-unsafe-execution
```

Every command above also runs identically under the legacy `testforge` binary name.

`init` is static: it never executes detected commands or adapters and manages only
`assertledger.config.json` and `assertledger.lock.json`. It requires operator-owned worlds and
candidates rather than inventing a verification request. See
[`docs/repository-init.md`](docs/repository-init.md) for detection conflicts, recovery behavior,
adapter availability, and the trust boundary.

Repository analysis reports a test framework only from framework-specific evidence such as a
declared dependency, a dedicated configuration file, or a real `node:test` import below a test
directory or in a colocated `*.test.*`/`*.spec.*` source file. Comments, string examples, and
documentation-like config filenames do not count; no evidence produces an empty list. Detection is
intentionally incomplete: an unrecognized manifest layout or test-file convention yields no claim.

`verify`, `replay`, `profile`, `profile-replay`, `profile-v2`, `profile-v2-replay`, `benchmark`, and
`benchmark-replay`, `benchmark-acquire`, and `benchmark-acquire-replay` also accept `-`
or an omitted file argument and
then read JSON from stdin. The CLI rejects file and stdin JSON inputs larger than 16 MiB. JSON
results go to stdout. Diagnostics go to stderr. `assertledger mcp` reserves stdout for JSON-RPC.

`--allow-unsafe-execution` is an external authorization signal. The CLI requires it for every
campaign and sets the request's local acknowledgement before validation. The flag does not create a
sandbox.

Versioned JSON Schemas are published for the
[`verification request`](schemas/verification-request.v1.json),
[`repository analysis`](schemas/repository-analysis.v1.json),
[`repository init config`](schemas/repository-init-config.v1.json),
[`repository init lock`](schemas/repository-init-lock.v1.json),
[`repository init result`](schemas/repository-init-result.v1.json),
[`evidence manifest`](schemas/evidence-manifest.v1.json),
[`replay result`](schemas/replay-result.v1.json),
[`Agentic Test Profile request`](schemas/agentic-profile-request.v1.json),
[`Agentic Test Profile report`](schemas/agentic-profile-report.v1.json),
[`Agentic Test Profile replay result`](schemas/agentic-profile-replay-result.v1.json),
[`Agentic Benchmark request`](schemas/agentic-benchmark-request.v1.json),
[`Agentic Benchmark artifact`](schemas/agentic-benchmark-artifact.v1.json), and
[`Agentic Benchmark replay result`](schemas/agentic-benchmark-replay-result.v1.json),
[`Agentic Benchmark acquisition request`](schemas/agentic-benchmark-acquisition-request.v1.json),
[`Agentic Benchmark acquisition result`](schemas/agentic-benchmark-acquisition-result.v1.json),
[`Agentic Benchmark acquisition replay result`](schemas/agentic-benchmark-acquisition-replay-result.v1.json),
[`Agentic Test Profile v2 request`](schemas/agentic-profile-request.v2.json),
[`Agentic Test Profile v2 report`](schemas/agentic-profile-report.v2.json), and
[`Agentic Test Profile v2 replay result`](schemas/agentic-profile-replay-result.v2.json), plus the
[`corpus trust policy`](schemas/agentic-corpus-trust-policy.v1.json) and paired
[`corpus provenance`](schemas/agentic-corpus-provenance.v1.json), six corpus allocation and
two-party [`commitment/reveal`](schemas/agentic-corpus-allocation-commitment.v1.json) contracts,
plus six pre-declared [`H3 experiment`](schemas/agentic-corpus-experiment-plan.v1.json) contracts.
The main CLI `schema` command prints the thirty-one facade schemas by name; the corpus evaluator consumes
the two trust/provenance schemas directly.
A complete runnable verification request
is available at
[`examples/node-test/request.json`](examples/node-test/request.json).
After building the package, the
[`Agentic Test Profile example`](examples/agentic-profile/profile-manifest.mjs) derives a report
directly from any replay-valid manifest. The first two real-campaign results and their limitations
are recorded in [`docs/agentic-test-profile-pilot.md`](docs/agentic-test-profile-pilot.md).
The [`Agentic Benchmark example`](examples/agentic-benchmark/benchmark-request.mjs) consumes a
strict benchmark request. See [`docs/agentic-benchmark.md`](docs/agentic-benchmark.md) for the fixed
protocol, comparison scope, replay rails, and current acquisition limitation.
The benchmark-backed [`Agentic Test Profile v2`](docs/agentic-test-profile-v2.md) replaces v1's
campaign wall-time proxy with an exact scoped warm-total-wall p95 cost basis. It is additive: v1
artifacts and commands remain supported.

The checked-in [`conformance v1 bundle`](docs/conformance-v1.md) locks autonomous inputs, complete
expected outputs, negative replay witnesses, all published schema bytes, and selected public
digests. `pnpm check` validates this static oracle without regenerating it.

## TypeScript SDK

```ts
import { readFile } from "node:fs/promises";
import { AssertLedger } from "assertledger";

const assertLedger = new AssertLedger();
const initialized = await assertLedger.init("/absolute/path/to/repository", { dryRun: true });
const context = await assertLedger.analyze("/absolute/path/to/repository");
const request = JSON.parse(await readFile("assertledger.request.json", "utf8"));
const manifest = await assertLedger.verify(request);
const integrity = assertLedger.replay(manifest);

const profile = assertLedger.profile({
  schemaVersion: "1.0.0",
  manifest,
  policy: {
    profileVersion: "1.0.0",
    profileId: "my-repository/default",
    mode: "HARDENING",
    minimumTimingSamples: 3,
    lanes: [
      { id: "instant", maximumReferenceP95Ms: 2_000 },
      { id: "loop", maximumReferenceP95Ms: 10_000 },
    ],
  },
});
const profileIntegrity = assertLedger.replayProfile(profile);

const benchmarkRequest = JSON.parse(await readFile("assertledger.benchmark-request.json", "utf8"));
const benchmark = assertLedger.benchmark(benchmarkRequest);
const benchmarkIntegrity = assertLedger.replayBenchmark(benchmark);

const profileV2 = assertLedger.profileV2({
  schemaVersion: "2.0.0",
  benchmarkArtifact: benchmark,
  policy: {
    profileVersion: "2.0.0",
    profileId: "my-repository/hardening-v2",
    mode: "HARDENING",
    requiredComparisonScopeDigest: benchmark.comparisonScopeDigest,
    costBasis: {
      regime: "WARM",
      measure: "WALL",
      aggregation: "TOTAL",
      statistic: "P95",
      unit: "MICROSECOND",
      portfolioAggregation: "SUM_OF_INDIVIDUAL_P95",
    },
    lanes: [{ id: "loop", maximumWarmTotalWallP95Us: 10_000_000 }],
  },
});
const profileV2Integrity = assertLedger.replayProfileV2(profileV2);
```

`AssertLedger` is exported alongside a deprecated `TestForge` subclass alias with an identical
surface, for consumers migrating from the prior name.

The SDK accepts plain JSON-compatible values and validates them against the same contracts as the
CLI. Unlike the CLI and MCP tool, `AssertLedger.verify()` has no separate authorization parameter: the
caller must set `isolation.acknowledgedUnsafeExecution` to `true` after applying its own policy.

`AssertLedger.replay()` reports schema validity, both digest checks, and deterministic
decision-semantic validity. Its aggregate `valid` field is true only when all four checks pass. Replay
does not rerun the campaign, authenticate the producer, or establish that the observations were
truthful.

`AssertLedger.profile()` accepts only a replay-valid manifest. It qualifies selected `ELIGIBLE`
hardening candidates against repository-scoped latency lanes and publishes evidence strength,
observed consistency, nearest-rank p50/p95, marginal target weight, and Pareto status. Latency never
compensates for a failed evidence gate. For each declared lane, the report also selects an
explainable greedy portfolio that maximizes new target weight per unit of recorded reference p95
within the lane's total budget. See
[`docs/agentic-test-profile.md`](docs/agentic-test-profile.md) for the contract and its non-claims.

`AssertLedger.benchmark()` accepts only a replay-valid `VERIFIED` source manifest plus a complete,
fingerprinted cold/warm run plan. It summarizes declared microsecond phase timings and never changes
the source decision. `await AssertLedger.acquireBenchmark()` runs the fresh campaign and strict
framework-neutral phase acquisition directly. The built-in `node:test` adapter remains unsupported
because it cannot faithfully expose all four phase boundaries.
`AssertLedger.replayBenchmarkAcquisition()` independently checks the source, artifact, context, result
digest, and exact status/reason semantics.

H3 replay requires three externally pinned digests and separate SDK options for the trust policy,
two-party commitment/reveal, allocation, pre-declared plan, subject provenance and evidence bytes.
Allocation is source-stratified; arms use content-addressed candidate references and derived suite
digests. Replay resolves and re-hashes every candidate's supplied bytes; this proves byte identity,
not that those bytes were executed. Scheduled process counts and planned timeout ceilings must be
exactly equal. H3
non-inferiority must hold per source and in aggregate. Receipts attest the applied timeout limit but
do not independently prove enforcement or equal observed CPU/wall time.
The CLI exposes the same boundary through mandatory `--trust-policy-digest`,
`--allocation-commitment-digest`, and `--experiment-plan-digest` flags plus separate files. See
[`docs/agentic-corpus-experiment-h3.md`](docs/agentic-corpus-experiment-h3.md).

`AssertLedger.profileV2()` accepts only a replay-valid benchmark artifact. Its comparison scope must
match the policy, all warm measurements must be usable, and every cost is the declared warm total
wall p95 in microseconds. It publishes a Pareto frontier and deterministic greedy portfolios only
over source-selected eligible candidates. The portfolio cost is a sum of individual p95 values,
not a measured portfolio p95 and not a universal optimum.

## Calibration corpus

The versioned scaffold under [`benchmarks/agentic-profile`](benchmarks/agentic-profile) evaluates
the falsifiable H1-H4 hypotheses without an LLM judge. It remains `NOT_READY` until at least 20
strict cases from three sources cover every hypothesis and include physically separate public and
private splits.

```sh
tsx scripts/evaluate-agentic-profile-corpus.ts status benchmarks/agentic-profile \
  --trust-policy operator-policy.json --trust-policy-digest sha256:...
tsx scripts/evaluate-agentic-profile-corpus.ts evaluate-public benchmarks/agentic-profile \
  --trust-policy operator-policy.json --trust-policy-digest sha256:...
tsx scripts/evaluate-agentic-profile-corpus.ts evaluate-holdout benchmarks/agentic-profile \
  --trust-policy operator-policy.json --trust-policy-digest sha256:...
```

Public evaluation returns per-case reason codes. Holdout evaluation returns aggregate hypothesis
counts only and suppresses case identifiers, source identifiers, raw values, and readiness counts.
The repository intentionally contains no fabricated cases; private `*.case.json` files are ignored.
The first empirical calibration is frozen in the
[24-case corpus plan](docs/agentic-corpus-plan.md). The plan fixes sources and admission rules; it
is not evidence that every tranche has already been executed. The receipt-linked
[TestExplora calibration](docs/testexplora-calibration.md) contributes eight real, stable cases but
is explicitly curated calibration rather than holdout or `READY_H3` evidence.

## MCP v2 over stdio

Start the read-only server with `assertledger mcp`, or configure an MCP client with `assertledger` as
the command and `["mcp"]` as its argument array (`testforge mcp` runs the identical server). The
server name reported to clients is `assertledger`. Every tool is registered twice, under a preferred
`assertledger_*` name and a legacy `testforge_*` name bound to the same handler and the same tool
configuration. The schema lookup pair has no single fixed output schema because its selected JSON
Schema document varies; every other pair shares the same output-schema object. The default server
exposes twenty-four read-only tools:

| Preferred tool | Legacy alias | Purpose |
| --- | --- | --- |
| `assertledger_analyze` | `testforge_analyze` | Produce repository context for test generation |
| `assertledger_benchmark` | `testforge_benchmark` | Derive scoped cold/warm phase summaries from declared raw runs |
| `assertledger_benchmark_replay` | `testforge_benchmark_replay` | Replay a self-contained benchmark artifact |
| `assertledger_profile` | `testforge_profile` | Derive an Agentic Test Profile from replay-valid evidence |
| `assertledger_profile_replay` | `testforge_profile_replay` | Replay a self-contained profile report |
| `assertledger_profile_v2` | `testforge_profile_v2` | Derive a benchmark-backed strength and warm-cost profile |
| `assertledger_profile_v2_replay` | `testforge_profile_v2_replay` | Replay a self-contained Profile v2 report |
| `assertledger_schema` | `testforge_schema` | Return any of the twenty-eight facade JSON Schemas |
| `assertledger_replay` | `testforge_replay` | Validate and replay a manifest's schema, digests, and decision semantics |
| `assertledger_benchmark_acquire_replay` | `testforge_benchmark_acquire_replay` | Replay acquisition source, artifact, context, digest, and status bindings |
| `assertledger_corpus_allocate` | `testforge_corpus_allocate` | Create a deterministic calibration/holdout allocation |
| `assertledger_corpus_allocation_replay` | `testforge_corpus_allocation_replay` | Replay allocation scores, partition, and digest semantics |

H3 creation and replay are deliberately absent from the default agent-facing MCP server. Its
operator-owned policy, commitment and plan pins cannot be supplied safely as self-attested tool
input.

`assertledger_verify`/`testforge_verify` and `assertledger_benchmark_acquire`/`testforge_benchmark_acquire`
are absent by default. A server operator may register both pairs by starting
`assertledger mcp --allow-unsafe-execution`, or by calling `createAssertLedgerServer({
allowUnsafeExecution: true })` (the deprecated `createTestForgeServer` alias calls the identical
factory). The tool then accepts a verification request and executes it without a second per-call
authorization field. Run that server only inside the intended isolation boundary; do not let an MCP
caller decide whether the capability exists. The server resolves repository roots to real paths and
confines them to the server process's current working directory by default. Programmatic operators
may supply a different `allowedRepositoryRoots` allowlist.

## Continuous integration

Run `pnpm check` on every change. The included GitHub Actions workflow runs this gate on Node.js 22
and 24 on Ubuntu and Windows, then performs a package dry run. A CI job that executes campaigns must
also treat `trusted-local` as `UNSANDBOXED`: use an isolated runner without secrets or host
credentials, and pass `--allow-unsafe-execution` only from reviewed CI configuration.

## Decision semantics

- `VERIFIED`: at least one candidate completed all required evidence and was selected.
- `REJECTED`: the campaign completed, but no candidate satisfied the policy.
- `INCONCLUSIVE`: controls or candidate evidence were incomplete, unstable, timed out, or affected
  by infrastructure failure.
- `ENGINE_ERROR`: the deterministic core could not normalize the supplied evidence safely.

Only an attributed `ASSERTION_FAILURE` can kill a target in protocol v1. Compilation errors,
collection failures, crashes, timeouts, and infrastructure errors never count as target evidence.

Campaign budgets cover aggregate candidate, world, repository, overlay, and execution counts or
bytes. `timeoutMsPerExecution` and `maximumOutputBytes` apply to each process execution; the timeout
and process-tree termination are best effort on the local host.

Before a built-in `node:test` campaign runs, AssertLedger probes the requested executable, resolves its
real path, probes that resolved file again, and requires matching Node.js versions of at least
22.15. The manifest records the requested executable, resolved path, Node.js version, and executable
SHA-256 digest.

Each candidate records the ordered gates `COMPLETENESS`, `STABILITY`, `DISCOVERY`, `REFERENCE`,
`NEUTRAL`, and `TARGET_STRENGTH`, including evidence run IDs and reason codes. See
[docs/proof-model.md](docs/proof-model.md) for candidate statuses, controls, selection, and digest
scope.

The manifest is sufficient to replay AssertLedger's deterministic decision, but it is not a complete
audit archive. It stores content and process-output digests, not candidate or world bodies, a
repository archive, or raw logs. Preserve the original request, repository snapshot or trusted
source reference, raw logs, dependencies, and any structured-command executable identity separately
when independent audit or reproduction matters. Manifest digests detect changes; they do not
authenticate the producer.

## Project status and roadmap

The [intent and restart assessment](docs/project-intent.md) records the current implementation,
adoption gaps, and proposed delivery order. It distinguishes local evidence from release and
empirical claims.

Version `0.1.0` is a production-oriented foundation, not a claim of ecosystem completeness. The
deterministic core and protocols are framework-independent; `node:test` is the first built-in
framework adapter. Other frameworks integrate through the structured-command protocol described in
[docs/adapter-protocol.md](docs/adapter-protocol.md).

Planned work is not shipped behavior. Priorities include a real sandbox backend, additional
framework reporters with runtime attribution, signed provenance, cross-runtime conformance
fixtures, and more built-in adapters. See [docs/roadmap.md](docs/roadmap.md).

Contributions are welcome under the [MIT license](LICENSE). Read [CONTRIBUTING.md](CONTRIBUTING.md)
before changing a public contract.
