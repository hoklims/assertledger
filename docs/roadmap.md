# Roadmap

This roadmap separates locally implemented v0.1 behavior from the agreed 1.0 delivery scope.
See the [intent assessment](project-intent.md) and [1.0 release contract](release-1.0.md) for the
regression-test qualification workflow, acceptance criteria, and evidence boundaries.

## Implemented locally in v0.1

- deterministic repository analysis;
- thirty-four versioned public JSON Schemas, all frozen by conformance v1;
- reference, target, and neutral overlay worlds;
- one campaign snapshot and disposable execution workspaces;
- built-in `node:test` runtime reporter and structured-command adapter;
- deterministic gates, candidate selection, reason codes, and evidence run links;
- decision and artifact integrity digests;
- derived Agentic Test Profiles with replay, repository-scoped latency lanes, marginal evidence,
  and a multi-dimensional Pareto frontier;
- replayable Agentic Benchmark Artifacts with fingerprinted comparison scopes, cold/warm regimes,
  deterministic phase quantiles, and explicit sample/failure states;
- fresh phase-aware benchmark acquisition for `testforge-command`, gated by replay-valid
  `VERIFIED` evidence and bound to adapter and dependency identities;
- benchmark-backed Agentic Test Profile v2 reports with an exact warm-total-wall p95 cost basis,
  selected-only cohort disclosure, deterministic Pareto comparison, and summed-cost portfolios;
- externally pinned Ed25519 corpus trust policies and canonical dual-signed provenance sidecars;
- deterministic source-stratified corpus allocations with dual-principal commitment/reveal and
  private holdout custody;
- externally pinned H3 experiment plans and artifacts with byte-resolved run receipts, exact
  planned-process and planned-timeout equality, content-addressed suites, per-source
  non-inferiority, and a shared frozen candidate universe;
- a static conformance-v1 oracle locking canonicalization, decisions, replay witnesses, Profile v1,
  Benchmark v1, and all 34 published schema bytes;
- a pinned 24-case, three-source empirical corpus plan with signed admission and holdout rules,
  including eight receipt-linked TestExplora cases admitted only for curated calibration;
- JSON CLI, TypeScript SDK, MCP v2 stdio server, and integration skill;
- `trusted-local`, explicitly recorded as `UNSANDBOXED`.

## Release 1.0 priority

1. Qualify a regression test against declared buggy, fixed, and neutral revisions using existing
   deterministic gates, with useful diagnostics and preserved artifacts.
2. Verify installation and the documented workflow from the packed package in a fresh consumer.
3. Add repository diagnostics and agent integration, then a PR/CI report and replay path.
4. Publish only after exact-candidate checks and required independent review; install and verify
   the published version before closing delivery.

The first built-in adapter is `node:test`. Broader adapters and optimizations follow pilot needs.
The empirical work below remains required for scientific claims, rather than for releasing the
scoped deterministic qualification workflow.

## Further evidence and extensions

1. Complete the [24-case corpus plan](agentic-corpus-plan.md), including provenance sidecars, a
   separately selected and pre-committed holdout, reviewed historical faults, mutants, and neutral
   rewrites, before claiming an empirically established sweet spot. The current TestExplora 8/8
   tranche is curated calibration evidence and cannot satisfy the holdout requirement.
2. Add faithful framework-specific phase adapters. The framework-neutral acquisition path is
   shipped, but the built-in `node:test` reporter cannot attribute all four phases.
3. Add an isolation backend backed by an independently administered container or VM boundary.
4. Add framework reporters beyond `node:test` that derive discovery and attribution from runtime
   events.
5. Publish cross-runtime conformance fixtures for canonicalization, decisions, and both digests.
6. Add mature replayable experiment artifacts for H1, H2, and H4 without allowing them to
   compensate for an H3 failure.
7. Add adapters only when their outcome mapping has adversarial contract tests.
8. Extend provenance to cover executed dependencies, structured-command binary identities, and
   effective environment inputs without leaking secrets.

## Explicitly out of scope for v0.1

- hostile-code containment;
- automatic trust in agent-supplied worlds or policy;
- proof of program correctness or complete fault detection;
- proof that a test will never become flaky;
- SLSA conformance or authenticated provenance.
