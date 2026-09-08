# Agentic Test Profile

Status: implemented public contract for `testforge-agentic-profile/1.0.0`.

## Purpose

The Agentic Test Profile describes how much declared fault-detection evidence a test candidate
delivers within an observed execution budget. It is a derived, auditable report for developers,
agents, and CI systems. It does not change the meaning of an evidence manifest or its `VERIFIED`
decision.

The profile answers a bounded question:

> Among candidates that already produced valid AssertLedger evidence, which ones delivered the most
> declared fault-detection value within the repository's stated feedback budget?

It does not answer whether the program is correct, whether the supplied worlds are complete, or
whether a test will remain non-flaky in every future environment.

## Testing mode

Version 1 profiles **hardening tests** only. A hardening test:

- passes on the operator-declared reference implementation;
- passes on required behaviour-preserving neutral worlds;
- produces attributed assertion failures on operator-declared target worlds; and
- is intended to remain in the repository to detect future regressions.

This is different from a **catching test**, which passes on a parent revision and intentionally
fails on a proposed revision to report a possible bug in that change. Catching tests have a
different reference direction, false-positive workflow, and lifecycle. They require a separate
future policy and must not be assigned a hardening profile.

## Two independent layers

The evidence decision and efficiency profile remain separate:

```text
deterministic evidence: VERIFIED | REJECTED | INCONCLUSIVE | ENGINE_ERROR
empirical profile:      QUALIFIED | BUDGET_MISSED | INSUFFICIENT_TIMING_EVIDENCE | NOT_QUALIFIED
```

An efficiency profile may be positive only when:

1. the source manifest strictly validates;
2. replay validates the schema, decision digest, artifact digest, and decision semantics;
3. the campaign decision is `VERIFIED`; and
4. every profiled candidate is selected and `ELIGIBLE`.

Latency never compensates for weak target strength, an invalid reference or neutral observation,
missing evidence, instability, or an unattributed failure.

## Versioned profile policy

Thresholds are repository policy, not universal constants. A policy declares named feedback lanes:

```json
{
  "profileVersion": "1.0.0",
  "profileId": "example-project/default",
  "mode": "HARDENING",
  "minimumTimingSamples": 5,
  "lanes": [
    { "id": "instant", "maximumReferenceP95Ms": 2000 },
    { "id": "loop", "maximumReferenceP95Ms": 10000 },
    { "id": "gate", "maximumReferenceP95Ms": 60000 }
  ]
}
```

Lane identifiers are descriptive labels scoped to the policy. AssertLedger does not claim that two
repositories using an `instant` lane are directly comparable. Lane thresholds must be positive,
strictly increasing, and use unique portable identifiers.

## Report binding

The derived report binds:

- the complete, strictly validated source manifest, preserved in the report so profile replay does
  not depend on a mutable side file;
- the source manifest's `artifactDigest`, which includes operational durations;
- the profile policy and its digest;
- the profile implementation version;
- candidate metrics and classifications; and
- a canonical report digest.

The evidence manifest v1 remains byte-for-byte and semantically unchanged. Adding the profile to
the manifest would break its strict schema and digest projections, so the profile is a separate
public artifact.

## Metrics

### Declared target strength

For a candidate `c`:

```text
targetWeightPermille(c) =
  1000 * weight of target worlds killed by c / total target-world weight
```

The profile metrics preserve required targets killed/total and all killed target identifiers. The
embedded source manifest remains the authoritative location for reference and neutral gate results,
evidence run identifiers, and candidate reason codes; the derived candidate rows do not duplicate
them. Code coverage may be reported by external tools as diagnostic context, but it is not a
qualification gate.

### Observed consistency

The report uses `OBSERVED_CONSISTENT` or `OBSERVED_INCONSISTENT` plus the exact attempt count. It
never calls a test universally stable. Repeating a test three times records three consistent
observations; it does not establish a useful probabilistic upper bound on future failure. Any
contradictory attempt is preserved as observed inconsistency even though the candidate is already
ineligible for a positive profile.

### Latency

Version 1 derives timing from candidate observations already recorded in the source manifest.
Candidate feedback latency is summarized from `REFERENCE` observations because those represent the
normal passing developer loop. The report includes:

- sample count;
- minimum and maximum;
- integer-arithmetic p50 and p95 using the nearest-rank method; and
- total recorded candidate execution time across all worlds and attempts.

Nearest rank sorts non-negative finite durations and selects index `ceil(p * n) - 1`. Fractional
adapter durations are preserved. Empty input has no quantile. The report is
`INSUFFICIENT_TIMING_EVIDENCE` when reference sample count is below the policy minimum.

These durations include the adapter process boundary measured by the current engine. They do not
distinguish cold start, warm execution, compilation, collection, or test-body time. Therefore v1
calls them `RECORDED_REFERENCE_WALL_TIME` and makes no cold/warm claim.

### Marginal evidence

For selected candidates in deterministic selection order, the report includes the target weight
first covered by that candidate. A candidate that only repeats already-covered targets has zero
marginal weight even if its individual target score is high.

### Pareto status

Pareto comparison is performed only among selected `ELIGIBLE` candidates with sufficient timing
evidence, including candidates that miss every declared lane. Candidate A dominates B when A is no
worse on all of these dimensions and strictly better on at least one:

- declared target weight killed: greater is better;
- required targets killed: greater is better;
- reference p95 wall time: lower is better;
- total recorded candidate wall time: lower is better; and
- candidate size in bytes: lower is better.

Candidates without sufficient timing evidence are not placed on the timed frontier. The report
publishes the frontier; it does not collapse the dimensions into a single opaque score.

## Classification

Classification is applied in this order:

Invalid schema or replay evidence is rejected before a report is produced. For a valid source,
classification is applied in this order:

1. `NOT_QUALIFIED` when the campaign is not `VERIFIED`, or a candidate is not both selected and
   `ELIGIBLE`.
2. `INSUFFICIENT_TIMING_EVIDENCE` when the evidence gates pass but the declared minimum number of
   reference timing samples is not present.
3. `BUDGET_MISSED` when evidence is valid but the candidate satisfies no declared latency lane.
4. `QUALIFIED` when evidence is valid, timing evidence is sufficient, and at least one lane is
   satisfied.

The report lists every satisfied lane and a `bestLaneId`, defined as the smallest declared budget
the candidate satisfies. `QUALIFIED` is always scoped to declared worlds, attempts, environment,
and profile policy.

## Portfolio selection under a budget

Each lane also yields a deterministic weighted-coverage portfolio under that lane's wall-time
budget. Selection operates only after evidence qualification:

1. compute uncovered target weight contributed by each remaining eligible candidate;
2. discard candidates whose recorded p95 exceeds the remaining budget;
3. select the greatest marginal target weight per unit of p95 cost;
4. break ties by greater absolute marginal weight, lower p95, lower candidate size, digest, then id;
5. stop when no candidate adds target weight within the remaining budget.

The report records selected identifiers, summed reference p95 cost, covered target weight, required
targets, and coverage permille for every lane. The greedy portfolio is an explainable baseline, not
a proof of a globally optimal subset. The full Pareto frontier remains available so callers can make
another policy choice without falsifying the recorded evidence.

APFDc may be emitted as a diagnostic for a declared sequential order with declared target severity.
It is not the primary score because parallel execution and partial portfolios violate the simple
sequential interpretation.

## Calibration and anti-gaming

A public profile is no stronger than its world portfolio. A mature evaluation corpus should combine:

- historical real faults with independently verified fixes;
- operator-reviewed synthetic mutants;
- behaviour-preserving neutral rewrites;
- boundary and metamorphic properties; and
- explicit dispositions for equivalent, redundant, disputed, or out-of-scope mutants.

Local development may use fully visible worlds. Competitive or certification-like evaluation needs
an independently governed holdout. A commit-reveal workflow can publish the corpus digest before a
campaign and reveal the worlds afterward. Even then, the report claims only performance on that
corpus.

The initial product hypotheses are falsifiable:

- H1: at equal declared target strength, Pareto selection reduces reference-loop p95 versus the full
  eligible suite.
- H2: candidates required to pass neutral worlds survive behaviour-preserving rewrites more often
  than reference-only candidates.
- H3: under equal time budgets, the qualified portfolio detects no fewer held-out historical faults
  than a coverage-guided baseline.
- H4: a reviewed reduced mutant portfolio retains non-inferior historical-fault recall at lower
  execution cost than the exhaustive mutant set.

If H3 or H4 fails, the project must describe the output as an audited declared-world profile, not as
an empirically established testing sweet spot.

The executable corpus gate lives under `benchmarks/agentic-profile`. It requires at least 20 strict
cases from three immutable sources, a non-empty private holdout, and evaluable evidence for H1-H4.
Until those gates pass, the scorer returns `NOT_READY` and no optimization loop is authorized.
Public evaluation exposes exact reason codes; holdout evaluation exposes aggregate outcomes only.

## Provenance maturity

The source manifest does not fingerprint the complete host, effective environment, or dependency
graph, and structured-command adapters remain part of the trusted computing base. The separate
Agentic Benchmark Artifact now binds these declarations and a strict comparison scope. It does not
authenticate them, and the built-in `node:test` reporter cannot yet acquire the four phase markers.
Exact scoped timing therefore requires a trustworthy producer containing at least:

- operating-system and architecture identity;
- CPU and resource-limit identity;
- runtime, adapter, dependency, and executable digests;
- cold/warm preparation protocol;
- raw per-phase samples; and
- drift checks against a calibrated workload.

Until that artifact exists, v1 profile timing is local observed evidence, not a portable benchmark.

## Research basis

- [Just et al., mutants and real faults, FSE 2014](https://homes.cs.washington.edu/~mernst/pubs/mutation-effectiveness-fse2014-abstract.html)
  found mutation detection correlated with real-fault detection independently of code coverage,
  while documenting important limitations.
- [Elbaum, Rothermel, and Penix, regression testing in CI, FSE 2014](https://research.google/pubs/techniques-for-improving-regression-testing-in-continuous-integration-development-environments/)
  treats fast feedback and test cost as first-class CI objectives.
- [Meta predictive test selection](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/)
  demonstrates large-scale cost reduction while explicitly calibrating missed-regression and flaky
  test risk.
- [Kaufman et al., TCAP mutant prioritization, ICSE 2022](https://doi.org/10.1145/3510003.3510187)
  argues that a mutant is useful insofar as it elicits a test that advances test completeness.
- [Meta Mutation-Guided LLM-based Test Generation](https://arxiv.org/abs/2501.12862) uses a small,
  concern-specific mutant portfolio to guide production test generation.
- [Meta Just-in-Time Catching Test Generation](https://arxiv.org/abs/2601.22832) distinguishes
  hardening tests from change-specific catching tests and shows why false-positive drag must be
  measured independently from raw catch generation.

## Explicit non-claims

An Agentic Test Profile does not prove:

- program correctness or complete fault detection;
- semantic correctness or completeness of operator-supplied worlds;
- permanent absence of flakiness;
- portability of recorded timing to another machine;
- resistance to a candidate designed with knowledge of visible worlds;
- provenance authenticity without an external attestation; or
- that a greedy portfolio is globally optimal.
