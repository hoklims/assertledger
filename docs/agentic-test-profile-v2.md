# Agentic Test Profile v2

Status: implemented additive public contract for `testforge-agentic-profile/2.0.0`.

## Why v2 exists

Profile v1 derives latency from wall times embedded in a verification campaign. Those observations
are useful local evidence, but they do not distinguish cold startup, compilation or collection,
warm execution, or the measurement environment. Profile v2 consumes a replay-valid Agentic
Benchmark Artifact and uses one fixed cost basis:

```text
regime:                WARM
measure:               WALL
aggregation:           TOTAL
statistic:             P95
unit:                  MICROSECOND
portfolio aggregation: SUM_OF_INDIVIDUAL_P95
```

No CPU time, phase timing, cold timing, candidate size, APFDc, or composite score may compensate
for this cost basis or enter the Pareto decision.

`benchmark-acquire` is the direct path to a replay-valid artifact for this profile. Profile v2 still
evaluates only the source-selected eligible universe. A successful acquisition establishes neither
a repository-global optimum nor a universal sweet spot, and timing failures never weaken or revise
the source `VERIFIED` verdict.

## Preconditions and status precedence

The request embeds the complete benchmark artifact and names its required
`comparisonScopeDigest`. AssertLedger first replays that artifact. Invalid benchmark evidence produces
no report.

For a valid artifact, report status follows this exact precedence:

1. `COMPARISON_SCOPE_MISMATCH` when the policy and artifact scopes differ;
2. `OBSERVED_BENCHMARK_FAILURE` when any warm measurement failed;
3. `INSUFFICIENT_TIMING_EVIDENCE` when any warm summary lacks enough accepted samples;
4. `QUALIFIED` when at least one declared lane admits a non-zero-strength candidate;
5. `BUDGET_MISSED` otherwise.

The first three states suppress the whole cohort's Pareto frontier and portfolios. A cold failure
remains visible in the embedded benchmark but does not block the warm-cost profile.

## Candidate universe

Profile v2 deliberately evaluates only candidates that the source manifest both classified
`ELIGIBLE` and selected. The report states this as `SOURCE_SELECTED_ELIGIBLE`, lists every included
identifier, and separately lists eligible candidates excluded by source selection.

This boundary matters: the report does not claim to find the best candidate among every submitted
or eligible candidate. Broader comparison requires a benchmark artifact whose source selection
contains that broader cohort.

## Pareto frontier

Candidate A dominates B only when A is no worse on all three dimensions and strictly better on at
least one:

- target-world weight killed: greater is better;
- required target worlds killed: greater is better;
- warm total wall p95: lower is better.

The report does not collapse these dimensions into a single score. Tie-breaking in portfolio
selection uses exact integer cross-products with `BigInt`, followed by marginal weight, cost,
candidate size, digest, and identifier. Candidate size is only a deterministic tie-breaker; it is
not a quality dimension.

## Portfolio semantics

For each strictly increasing lane budget, AssertLedger repeatedly selects the remaining candidate with
the greatest new target weight per unit of warm p95 cost, recomputing marginal gain after every
step. Zero-cost positive gain ranks first. Each step records its marginal targets, marginal weight,
individual cost, and cumulative totals.

`sumIndividualWarmTotalWallP95Us` is exactly the sum of individual candidate p95 values. It is not
a measured portfolio p95: shared startup, caching, parallelism, contention, and test-runner
scheduling could make an executed suite differ materially.

## Replay and compatibility

The report embeds its benchmark, policy, explicit cohort, candidate rows, portfolios, limitations,
and canonical digest. Replay independently verifies:

- benchmark replay;
- benchmark digest and comparison-scope binding;
- policy digest;
- report digest; and
- a complete deterministic semantic recomputation.

Profile v2 is additive. Profile v1 schemas, SDK methods, CLI commands, MCP tools, and report digests
remain unchanged. There is no automatic v1-to-v2 conversion because v1 lacks the fingerprinted,
cold/warm, phase-aware raw evidence required by v2.

## Usage

```sh
assertledger benchmark benchmark-request.json --json > benchmark-artifact.json
assertledger benchmark-replay benchmark-artifact.json --json
assertledger profile-v2 profile-v2-request.json --json > profile-v2-report.json
assertledger profile-v2-replay profile-v2-report.json --json
```

The SDK methods are `profileV2()` and `replayProfileV2()`. MCP exposes the preferred
`assertledger_profile_v2` and `assertledger_profile_v2_replay` tools alongside the legacy
`testforge_profile_v2` and `testforge_profile_v2_replay` aliases.

## Non-claims

Profile v2 does not prove program correctness, world completeness, permanent stability, provenance
authenticity beyond the externally pinned corpus policy, cross-machine portability, global subset optimality, or an empirically optimal
coverage-versus-speed sweet spot. The last claim remains blocked until the public/private corpus
passes its H1-H4 readiness and holdout gates on enough independently reviewed projects. Corpus
readiness now requires canonical dual-signed sidecars; see
[Agentic corpus provenance v1](agentic-corpus-provenance.md).
