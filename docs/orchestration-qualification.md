# Orchestration qualification v1

## Delivery contract

Deliver a named, version-pinned qualification profile with a sealed obligation inventory, executable
reference/fault/neutral worlds, independent observations, deterministic receipts and domain-aware
replay. A test-only receipt cannot satisfy a cache, wrapper, selection or CI obligation.

The public reproduction is authored from scratch. Private consumer sources and resources are not
distributed. Approval gates, brokers, shared skills and merge authorization are outside this change.

## Work and acceptance

1. Inventory the published CLI/SDK/MCP and consumer version/test forms; preserve concurrent work.
2. Add versioned contracts/core and qualify native Bun assertions without changing frozen v1-v4.
3. Execute real pinned Turbo cold/warm/invalidation, selection and failure propagation campaigns.
4. Expose CLI/SDK/MCP, retain receipts/replay and the obligation matrix; run `pnpm check`.
5. Freeze the aggregate candidate and obtain independent proof-integrity review before publishing PR.

Contracts/core and Bun collection are authored in separate worktrees. The lead integrates, owns the
campaign, verifies the complete candidate and publishes. Operational errors never earn detection.

## Qualification boundary

Local configuration analysis, local command execution and hosted CI observation are separate
obligations. No local fixture establishes Bitbucket execution. Unknown/omitted consumer suites stay
open. A qualified public reproduction does not establish whole-consumer readiness.

`trusted-local` is explicitly unsandboxed. Digests establish replay integrity and domain binding;
they do not authenticate the producer or cause test reexecution.

## Existing capabilities and the consumer

The existing `verify` CLI, SDK `verify`/`verifyV2`/`verifyV3`/`verifyV4`, MCP verification tools and versioned
manifest replay remain available. Node uses its owned reporter and shallow `ERR_ASSERTION`
attribution. The frozen Bun v3 profile admits only errors issued by `assertledger/bun` helpers.
The integrated v4 baseline also supports designated Bun tests with native expectations and imported
witness execution. Its controls load/register a selected test without executing it; this qualification
profile executes its declared complete suites in the reference and neutral worlds.
Those paths prove their declared test campaign; they do not supply Turbo, wrapper or hosted-CI
qualification. The native qualification collector retains a separate event/JUnit protocol and
passive matcher boundary, and reuses the v4 parser's per-test timeout refusal rule.
The existing structured-command v1 protocol requires exit zero for `PASS`; it cannot represent a
successful propagation check whose tested command intentionally exits seven. This extension reuses
the bounded process runner, canonical hashing, Node reporter and existing versioned contracts.

Source inspection of the incident consumer found Bun **1.4.2**, pnpm **12.9.1** and Turbo **2.11.7**;
the Vitest compatibility dependency is **5.0.3**. Thirty workspace manifests declare tests, nine
declare E2E, and ten delivery suites use `node:test` under Bun. Actual forms include callback
contexts, generated registrations, TypeScript/TSX, helper imports, native assertions, preloads,
isolation, filters and a development-condition test route. These pins and counts are an inventory,
not qualification of those private suites. The published reproduction contains independently
authored generic sources only.

The new Bun profile pins the full runtime revision and qualifies five passive native matchers and
three Node assertions. Its [capability boundary](../integrations/bun-native/README.md) names every
qualified form. Unsupported assertions, active operands, custom matchers, absent files, skips,
hooks, compilation/collection failures and no tests stay operational. They cannot earn detection.

## Actions, observations and decisions

An operator seals the inventory, worlds, actions and exact expected checks before execution. Only
candidate file overlays on explicitly allowed paths are accepted afterward. The sealed plan digest
must be anchored outside candidate control; this API does not create an authority or security boundary.

Adapters collect facts. The pure core compares them with the operator checks, requires stable
reference and neutral runs and the specifically declared target mismatches in every attempt.
Missing reports, duplicates, contradictions, unobserved suite files and undeclared mismatches are
not admission. Receipts list `coveredGuaranteeIds`, `openGuaranteeIds`, reasons and check IDs.

| Guarantee | Action and observations | Oracle | Executable discriminant |
|---|---|---|---|
| Extracted command tests | Owned Node reporter, actual started files and TAP completion | Positive discovery, assertion attribution, exit consistency | Changed command shape |
| Native Bun tests | Pinned runtime, signed event pipe, JUnit concordance, actual files | Matcher-issued error belongs to the same test | Changed native assertion value; getter/crash refusals |
| Selection | Real Turbo summary, selected IDs and dependency closure | Exact required task IDs | Required dependency removed; actual empty filter |
| Cache | Cold/warm/invalidation; fresh external execution traces; deleted/restored output bytes | Required executions and hashes equal expected values | Forgotten input; incomplete restoration; wrongly cached disabled task |
| Propagation and wrappers | Actual leaf → Turbo → wrappers → terminal exit, fresh semantic completion report and required-stage traces | Exact expected nonzero exit, matching attestation and mandatory trace | Absorbed exit, omitted stage, empty filter, later success, stale success; ordinary throws/compile/spawn errors stay operational |
| CI configuration | Bun YAML parser outside the mutated candidate route; anchors resolved; step/stage/parallel ancestry, conditions and triggers retained | Required route/step/command/execution-policy relationships | Pull-request gate disconnected, conditional gate, manual gate |
| Hosted CI | Independently signed external observation | Pinned observer, exact commit/base/plan/input, executed steps and terminal success | Bad signature, wrong domain, missing/skipped step, failed terminal |
| Receipt/replay | Strict parsing, recomputed bindings, decisions, digests and external domain | Complete evidence matches its actual validity domain | Tamper, resealed summary forgery, duplicate/missing/rebound report, changed mechanism |

The public campaign executes fifteen fault worlds, reference and neutral twice. Cache directories
are distinct for each world/attempt and reused only between that attempt's ordered phases. Task
traces use a fresh nonce and a file outside the cache on every action. A cached log is never an
execution observation. Configurations, tool binaries, environments and source inputs are sealed;
the loaded proof mechanism has a separate digest. Root dependency directories are excluded from
this snapshot profile; repositories needing them require an explicit admitted dependency snapshot.

## CLI, SDK and MCP

```text
assertledger qualification-plan plan.json
assertledger qualify request.json --allow-unsafe-execution
assertledger qualification-replay receipt.json --domain current-domain.json
assertledger qualification-ci receipt.json --observation signed-pipeline.json
```

`qualify` exits 0 for `QUALIFIED`, 3 for `OPEN`, 2 for `REJECTED`; unauthorized execution and invalid
replay exit 4. SDK methods are `sealQualificationPlan`, `qualifyOrchestration`, `replayQualification`
and `admitQualificationCi`. MCP exposes plan, replay and CI import in read-only mode; execution is
available only when the server operator enabled unsafe execution, within its allowed repository roots.

Structured command observations can additionally use `observe.report`: the adapter writes canonical
JSON plus a newline to `ASSERTLEDGER_QUALIFICATION_RESULT_FILE`, with exactly `protocolVersion`,
`nonce` and `facts`. The nonce is `ASSERTLEDGER_QUALIFICATION_NONCE`. These facts remain in the
`report` namespace and never override engine-measured process facts. Missing, incomplete, stale or
noncanonical reports become collection failures. Such reports are adapter-reported observations.

For the `command` adapter, a normal zero exit supplies `commandOutcome: PASS`. A numeric nonzero
exit is operational unless the fresh canonical report additionally attests
`facts.commandOutcome: EXPECTED_FAILURE` and `facts.exitCode` equal to the engine-measured exit.
The collector exposes that admitted semantic outcome separately from `report`; report fields never
replace the measured exit. The public fixture writes the report only after normal leaf/wrapper
completion, checks each child report before forwarding a nonzero exit, and emits no completion
on spawn errors, signals, null statuses, ordinary exceptions or compilation failures. Completion
reports are trusted-local adapter statements, not authenticated evidence: a malicious unsandboxed
candidate can forge them. They cannot select operator checks or establish hosted CI admission.
The Turbo summary collector has no qualified nonzero completion protocol; a numeric Turbo
failure remains a collection error even when its summary is present. The propagation fixture
qualifies its terminal command separately through the leaf/wrapper completion chain.

The CI configuration collector retains the complete route/step/stage/parallel ancestry, positions,
conditions, manual/automatic triggers and parallel fail-fast settings. Commands alone do not
establish an unconditional gate. This narrow local profile supports only the documented execution
fields; other step/group fields and pipeline kinds are refused as collection failures rather than
silently projected away. Preserved conditions are configuration facts, not a claim that a hosted
runner evaluated or executed them.

## Independent hosted CI admission

`ciTrust` is part of the operator-sealed plan, including a pinned Ed25519 public key, observer,
repository URI identity (`workspace/repository`) and required step command digests. No local
campaign generates this trust root or a hosted-pipeline observation. The external observer signs
canonical JSON `{domain: "ASSERTLEDGER_CI_OBSERVATION_V1", statement: unsignedStatement}`.
The statement names the pipeline URL/identity, repository, exact commit/base, plan/input/candidate
digests, actual executed steps and terminal result. The key's owner must observe those facts through
an independently trusted CI channel. A signature alone cannot establish that its signer is honest.

CI import accepts only an intact existing receipt with that unchanged trust root. Unit signing
fixtures test the verifier; they are never observations of Bitbucket. No real consumer pipeline
observation is delivered by this local public campaign, so the consumer's hosted CI obligation stays open.

## Replay and reuse

Replay recalculates schema, integrity, completeness, deterministic decisions and the optional
external validity domain. `reexecuted` and `producerAuthenticated` are always false. It does not
rerun tests, authenticate local observations or independently confirm a pipeline. The CI verifier
checks a supplied observation signature against the trust policy; it does not authenticate the
receipt maker or infer a hosted observation from local execution.

For reuse, supply the current externally trusted plan/candidate/input/commit/base and loaded
`mechanismDigest`. An old saved domain file establishes its original domain only. Changed tools,
inputs, environment, scope, adapters or proof policy invalidate the dependent qualification. Every
change to the proof mechanism or policy requires fresh independent validation. Receipt replay never
grants approval or merge authority.

## Compatibility and delivery

The four qualification v1 schemas are additive. Existing verification/manifest v1–v4, conformance
v1 projections, schema bytes and the old extension lock remain unchanged. The new schema lock is
separate. [Migration notes](migration-orchestration-qualification-v1.md) describe opt-in adoption.

The complete candidate is verified with `pnpm check`, package smoke, the pinned public campaign,
negative gate witnesses and a fresh independent aggregate proof review. Local verification, hosted
GitHub CI, review and PR publication are separate delivery facts. Consumer readiness is conditional
on the [required obligation inventory](../examples/orchestration/consumer-obligations.json), never
on the public profile's success alone.
