# Proof planner (internal module)

The proof planner answers one question: **given a change, the claims it reaches, their criticality
and an explicit assurance policy, which evidence is proportionate?** It lives in
`src/proof-planner/`, is pure and deterministic, and is not exported from the package entry points.

```text
impact provider (e.g. a semantic context tool)   describes what MAY be affected
        │ ChangeImpact (provider-neutral)
        ▼
proof planner                                     decides what MUST be proved
        │ AssurancePlan
        ▼
AssertLedger                                      decides whether required evidence exists and is
                                                  valid: sufficiency, provenance, freshness, identity
```

The planner never claims that evidence exists. AssertLedger never decides what is proportionate.
V1 implements the planner only; the AssertLedger-side satisfaction check is future work.

## 1. Audit of the existing model

| Concept | Present | Where | What exists / what is missing |
| --- | --- | --- | --- |
| Claims | No | `src/contracts/index.ts` (profile `consistency.claim`) | The only `claim` field is a stability label. No claim id, criticality or claim-to-evidence link. The implicit claim of a campaign is "this candidate test detects the declared fault". |
| Evidence | Yes | `EvidenceObservation`, gates, `EvidenceManifest` v1/v2, evidence export | One kind only: repeated test executions across REFERENCE/TARGET/NEUTRAL worlds plus candidate-free controls, scoped to one campaign. Typecheck, CI jobs, reviews or corpora are not AssertLedger evidence. |
| Provenance | Partial | world `provenance` string, `assertledger-git-regression/1`, provider `sourceRevision` | Declared, unauthenticated (`authenticity: UNAUTHENTICATED`). Git commit/tree only inside a world provenance string. |
| Freshness | No | export `cost.execution.freshness: "UNKNOWN"`, capability `EXECUTION_FRESHNESS: UNSUPPORTED` | No timestamp, expiry or validity window; the core forbids the clock. The only usable proxy is digest identity. |
| Candidate identity | Partial | `repositoryDigest` (content digest of the snapshot), git-regression revisions | "Candidate" means a candidate **test**, not a candidate change. No first-class commit or tree of the change under proof. |
| Invalidation | No | replay checks integrity only | Nothing marks evidence stale when the repository changes. Outputs are append-only. |
| Confidence | Partial | export `confidence.level: "REPLAY_CONSISTENT_UNAUTHENTICATED"` | Constant, qualitative; `established` / `notEstablished` token lists are a good residual-uncertainty vocabulary. |
| Verdicts | Yes | `VERIFIED/REJECTED/INCONCLUSIVE/ENGINE_ERROR`, candidate statuses, gate `PASSED/FAILED/NOT_RUN` | All verdicts are about test-evidence quality for one campaign; none says "this change is sufficiently proved". |
| Infra vs product | Partial | outcome taxonomy; `TIMEOUT`/`INFRA_ERROR` are inconclusive | Observation-level only. Nothing distinguishes a change to the proof infrastructure from a change to the product. |

### Where sufficiency is implicit or global

These rules are correct for their own purpose and are **not** weakened by the planner:

- `pnpm check` is the single completion gate for every change, and CI runs it on the full matrix
  without path filters.
- One invalid control makes a whole campaign `INCONCLUSIVE`; one timeout attempt among passes makes a
  candidate `UNSTABLE`; every required target must be killed.
- Consumer `obligations` are `COVERED` only when all are `EXECUTED`, and `EXECUTED` means "observed at
  least once", not "satisfied".
- The init lock digests every test, lockfile and CI file; one changed byte makes the runtime doctor
  report `RUNTIME_CONFIGURATION_STALE`, whatever the change touches.
- The decision digest folds product identity (repository, worlds) and proof-infrastructure identity
  (engine, adapter, budgets, backend) into one value: a budget change re-identifies the evidence.

What was missing is upstream of these gates: a planner that decides **whether** a given gate is
proportionate for a change, and **which** earlier evidence stays admissible after a follow-up commit.

## 2. Model

### Inputs

- `ChangeImpact`: the revision (git object id or `sha256:` digest), its merge-base `baseline`, an
  optional `runtimeTreeDigest`, and the surfaces changed since the baseline (cumulative). Each
  surface has a role (`product`, `execution-context`, `evaluation`, `test`, `proof-infrastructure`,
  `documentation`), a reach (`direct`, `transitive`), a runtime (`none`, `build`,
  `offline-analysis`, `live`), boundaries (protocol, persistence, replay, analysis, decision,
  admission, security, public-api, benchmark, holdout), a declared behavior change (`none`,
  `suspected`, `fix`, `feature`), coverage, environment sensitivity, an optional typed content
  digest, and for test and proof-infrastructure surfaces the surfaces they exercise. The analysis
  states its method (`static-graph` or `declared`), completeness, uncertainty, localized unknowns
  and omitted surfaces.
- `AssuranceClaim[]`: the project's claim registry or the claims a change makes. Pass the registry,
  not a hand-picked subset: untouched claims are filtered by the planner, not by the caller.
- `ProofSignal[]`: what proof runs revealed, for one revision each. A signal may also name the
  baseline and runtime tree it was observed on: an unresolved signal (a product signal, or a failure
  that may exercise the change) then still counts on a later revision whose product is
  byte-identical, so a proof-only commit cannot erase a regression.
- `AssurancePolicy`: versioned data, digested into the plan (default `DEFAULT_ASSURANCE_POLICY`).

### Facts, not a level table

Code derives a closed vocabulary of **facts** (`product:fix`, `boundary:replay:behavior`,
`runtime:live:behavior`, `claim:critical:direct`, `impact:unbounded`, `observed:regression`, …).
The policy is data that maps facts to:

- **floors**: the minimal level a fact implies;
- **raises**: one step up, once per subject, capped at P4 (a raise never creates P5);
- **triggers**: evidence a fact requires or recommends;
- **status**: facts that put the plan on `HOLD` or `BLOCKED`.

Levels are computed **per subject** (product, evaluation, proof infrastructure, documentation) and
the plan level is their maximum. A fact may concern several subjects. A level baseline (P1 static
checks and affected tests, P2 targeted regression and revision identity, P3 targeted integration and
production-path test, P4 independent review, P5 preregistration and provenance) only applies to the
subjects that reached that level, and only to the impact surfaces of that subject: a holdout change
at P5 does not drag product ceremony in, and criticality deepens proof without widening it. Breadth
(full suite, full corpus, multi-environment) comes only from impact facts.

Subjects follow what the evidence is about, not only the role of the surface:

- benchmark and holdout boundaries always concern the evaluation subject, whatever role carries them;
- security, admission and decision boundaries keep their weight on a changed gate or oracle
  (proof-infrastructure surfaces, and test surfaces whose oracle changed), under the
  proof-infrastructure subject;
- within the impact, a claim is reached through the product only by product, execution-context or
  evaluation surfaces (outside an unbounded impact, its surfaces are treated as reached product).
  A high or critical claim whose test or gate changed (the test lists a claim surface in
  `exercises`, or the claim lists the test) gets `claim:<criticality>:oracle` under the
  proof-infrastructure subject: an `ORACLE_WITNESS` (the changed oracle still fails where the
  violation is present) and, for a critical claim, an independent review, but no product
  requalification;
- a documentation claim whose documented surfaces change behavior requires the documentation check;
  otherwise it is unaffected.

| Level | Typical source facts |
| --- | --- |
| P0 | documentation only |
| P1 | refactor; changed tests that no product evidence runs; proof infrastructure; evaluation touched |
| P2 | product behavior change, new behavior, execution context, compatibility boundary touched; oracle of a high claim changed |
| P3 | behavior across protocol, persistence, replay, analysis or public API; live surface touched; security boundary touched; high claim reached directly; oracle of a critical claim changed; unbounded impact; costly reversal |
| P4 | live behavior; decision, admission or security behavior; critical claim reached directly; system-scope claim; irreversible change; observed corpus divergence or live runtime |
| P5 | empirical claim; benchmark or holdout behavior |

### Impact bound and exemptions

| Bound | When | Effect on heavy evidence |
| --- | --- | --- |
| `no-product-runtime` | a complete, static, low-uncertainty analysis finds no product, execution-context or evaluation surface | may be `NOT REQUIRED` |
| `bounded-confident` | the same analysis, with runtime surfaces | may be `NOT REQUIRED`; untouched claims are unaffected |
| `bounded-uncertain` | declared analysis, partial with named unknowns, non-low uncertainty or localized unknowns | computed against the **worst case** of the enumerated surfaces; what the worst case needs becomes `RECOMMENDED`, the rest `NOT REQUIRED`; a high or critical claim outside the impact earns a recommended invariant check, never a floor |
| `unbounded` | unknown completeness, unnamed unknowns, omitted surfaces, execution context changed, unknowns touching live or high-critical surfaces, observed unknown dependency or unplanned impact, whatever the enumerated surfaces are | full test suite `REQUIRED`; claims outside the impact are treated as reached transitively; everything not selected is `UNDETERMINED`, never `NOT REQUIRED` |

The bound is checked before the roles: an incomplete analysis of what looks like a proof-only change
is unbounded, because the omitted part may be product. An unbounded impact is treated as reaching
the product. The worst case keeps the declared analysis, so it is never more trusting than the plan;
if the worst case is itself unbounded, nothing can be exempted.

Size is not uncertainty: a large, enumerated transitive set bounds the targeted evidence's scope,
it does not trigger a global suite. A declared impact recommends the full suite, because surfaces
it omits are not bounded.

Every evidence kind of the catalog ends in exactly one status: required, recommended, not required
or undetermined. Each `NOT REQUIRED` entry carries its activation condition (the triggers and level
baselines that would require it, with current values) and states whether it was evaluated against
the actual change or the worst case.

### Product evidence versus proof-infrastructure evidence

Product signals (`UNEXPECTED_BEHAVIOR`, `UNPLANNED_IMPACT`, `UNKNOWN_DEPENDENCY`,
`LIVE_RUNTIME_TOUCHED`, `CORPUS_DIVERGENCE`, `WITNESS_NOT_CAUSAL`, `REGRESSION`) become facts.
A regression blocks; unexpected behavior and missing causality hold the plan and raise it. A
regression, an unexpected behavior or a corpus divergence that reproduces on the baseline is a
pre-existing defect: it does not block or escalate, but the reproduction becomes required evidence
(`FAILURE_ATTRIBUTION`). An unplanned impact reopens the bound unless the impact already names the
observed surfaces; a live-runtime observation escalates unless every observed surface is already
declared live.

Infrastructure signals (`TIMEOUT`, `ENVIRONMENT_FAILURE`, `TOOLING_FAILURE`) are attributed in a
fixed order, after the bound is known:

1. `exercises` is recomputed: if the failing job's surfaces are changed runtime surfaces, or changed
   proof surfaces that exercise one, it is `yes`, whatever was declared. A changed test that
   exercises nothing changed stays proof evidence, so a repaired ceiling can still be attributed
   when it flakes. A declared `no` is only trusted under a confident bound and when the failure
   names its surfaces.
2. A job that does not exercise the change is attributed to the proof infrastructure by any
   admissible basis (baseline reproduction, pass on the same revision, outside impact, reported
   infrastructure error, declared environment factor).
3. A job that may exercise the change is attributed only by `REPRODUCES_ON_BASELINE`. A retry that
   passes proves nondeterminism, not innocence: a slower code path can time out once and pass once.
   An attribution that rests on the reproduction alone requires `FAILURE_ATTRIBUTION`.
4. Otherwise the failure is unattributed: the plan holds and requires `FAILURE_ATTRIBUTION`, but the
   level does **not** rise automatically.

An attributed infrastructure failure never changes the level, the status or the evidence required
on the changed surfaces; it adds `AFFECTED_JOB_RERUN` on the failing job, and `FAILURE_ATTRIBUTION`
there too when a reproduction on the baseline is its only basis. An unattributed one adds
`FAILURE_ATTRIBUTION` on the failing job; it widens the product evidence only to a failing job that
is itself a product surface of the impact, never to a test, a harness or a job outside the impact.
A proof-infrastructure surface without an `exercises` list is taken not to exercise the change when
its failure is classified, so an outside-impact attribution declared for it stands under a
confident bound.

### Evidence bindings and carry-over

Each kind declares what it stays valid for:

- `exact-revision`: static checks and revision identity (cheap, re-run on every revision);
- `surface-content`: valid per scoped surface while that surface, the proof surfaces that exercise
  it (a test without an `exercises` list exercises everything; a proof-infrastructure surface
  counts where it names the surface, and a directly changed one whose behavior change is not
  declared `none` and that names nothing is reported as `proof.exercises-unknown`), the baseline and the runtime tree
  keep their digests. Only documentation-only evidence about a surface both plans call
  documentation ignores the runtime tree: a gate delta
  review is redone when the code its budget measures changes, and a documentation claim scoped to a
  runtime surface is checked again when the behavior it describes may have changed. Without a
  scope, it is revision-wide;
- `runtime-tree`: full suite, full corpus, multi-environment, live shadow, system requalification,
  benchmark and holdout runs: valid while the baseline and runtime tree digest are unchanged.

`carryOverEvidence(previous, next)` lists what may be reused and what must be produced again. Reuse
is keyed on the kind's semantic digest (id, weight, binding, subjects, verification,
`semanticsVersion`), never on its wording and never on the whole policy digest. Missing digests, a
changed baseline (rebase) or a changed runtime tree force re-production of every kind that depends
on them, and evidence never crosses to another revision on the surfaces that a signal unresolved in
either plan may concern, read in both plans: the surfaces it names and what a named test or proof
surface lists as exercised, or everything when it names no surface, a surface either impact does not
know, an execution context, or a proof surface that does not list what it exercises. A signal the
next plan observes counts too, because it contradicts evidence produced before it. Within one
revision, only an observation the previous plan did not already have counts, compared by what was
observed (id, revision, signal, classification, exercises, attribution basis and surfaces), not by
id: evidence produced beside an observation answers it. Evidence that answers observations, such as
a failure attribution or a job rerun, is reused only for the observations it was produced for, each
scoped by the surfaces it names; exact-revision evidence is reused within its revision whatever was
observed. A block lifts when the previous plan is planned again; the next plan does not revise its
classification. A failure attributed to the proof infrastructure, or unattributed on a job that a
confidently bounded impact places outside the change, concerns no product evidence. AssertLedger
must still verify that reused evidence exists and carries the listed digests.

### Escalations

Each plan precomputes, by replanning with a canonical hypothetical signal, what every product
signal and an attributed or unattributed infrastructure failure would do to its level, status and
required evidence. The tests pin every row of the bounded replay fix with values derived from the
policy by hand, and check the product rows for consistency with a replan through the public API
(the same planner, so that check alone would not catch a planner error).

## 3. Examples

Produced by the V1 default policy; the tests in `tests/proof-planner.test.ts` assert these
decisions.

| Scenario | Level | Required | Heavy evidence |
| --- | --- | --- | --- |
| A documentation only | P0 | documentation check | all 11 broad or ceremonial kinds not required |
| B local refactor | P1 | static checks, affected tests (+ characterization tests if untested) | all not required |
| C local bugfix | P2 | causal witness, affected tests, targeted regression, static checks, revision identity | all not required |
| D bounded replay fix | P3 | C + targeted integration, production-path test, targeted corpus, documentation check | all not required, including full corpus and system requalification |
| D, declared impact | P3 | D | full test suite, characterization tests and an invariant check for the untouched critical claim recommended; the rest not required against the worst case |
| D, partial analysis | P3 | D + full test suite, invariant check (the untouched critical claim is treated as reached) | full corpus and independent review recommended; everything else undetermined |
| E live decoder fix | P4 | C + boundary compatibility, targeted integration, production-path test, live shadow, rollback plan, full corpus, independent review | benchmark, holdout, full suite, multi-environment, system requalification not required |
| E tactical decision | P4 | acceptance test, affected tests, targeted regression and integration, production-path test, live shadow, rollback plan, full corpus, system requalification, independent review, static checks, revision identity | benchmark, holdout, full suite, multi-environment not required |
| F holdout evaluator + empirical claim | P5 | preregistration, provenance, benchmark protocol, holdout evaluation, contamination check, independent review, affected tests, static checks, revision identity | live shadow, full suite, full corpus, system requalification not required |
| G timeout ceiling repair | P1 | gate delta review, affected job rerun, static checks | all not required; no functional requalification |
| G, the repaired test checks a critical claim | P3 (proof infrastructure) | G + oracle witness, independent review of the test, revision identity | no product requalification: every requirement is scoped to the changed test or revision-wide |

Rendered plan for the bounded replay fix (abridged):

```text
AssurancePlan P3 PROVE - revision 1111… (baseline 0000…)
policy assertledger.default-assurance@1.0.0; impact bounded-confident; product P3, documentation P0

WHY
  - impact: bounded-confident: static analysis, complete, low uncertainty
  - claim: live-decoder-pins-unchanged: none of its runtime surfaces is in an impact bounded with confidence
  - floor P3 boundary:replay:behavior: channel/replay-fold, channel/replay-safe-keys: replay behavior may change
  - floor P2 product:behavior-change: channel/replay-safe-keys: product behavior may change

REQUIRED
  - CAUSAL_WITNESS (surface-content) [channel/replay-safe-keys] <- product:fix
  - TARGETED_CORPUS (surface-content) [channel/replay-fold, channel/replay-safe-keys] <- boundary:analysis:behavior, boundary:replay:behavior
  - PRODUCTION_PATH_TEST, TARGETED_INTEGRATION, TARGETED_REGRESSION, AFFECTED_TESTS, REVISION_IDENTITY, STATIC_CHECKS, DOCUMENTATION_CHECK

NOT REQUIRED
  - FULL_CORPUS: Not required: the policy asks for FULL_CORPUS when one of [boundary:decision:behavior,
    impact:unbounded, observed:corpus-divergence, observed:live-runtime, runtime:live:behavior] holds;
    none holds for this change, whose impact is bounded with confidence.
  - SYSTEM_REQUALIFICATION, INDEPENDENT_REVIEW, FULL_TEST_SUITE, BENCHMARK_PROTOCOL, HOLDOUT_EVALUATION, …

ESCALATE IF
  - CORPUS_DIVERGENCE (product): Evidence about the product: level moves P3 -> P4, status PROVE, adds FAILURE_ATTRIBUTION, FULL_CORPUS, INDEPENDENT_REVIEW.
  - REGRESSION (product): Evidence about the product: level stays P3, status BLOCKED, adds nothing.
  - TIMEOUT (infrastructure-attributed): Evidence about the proof infrastructure: level stays P3, status PROVE, adds AFFECTED_JOB_RERUN, FAILURE_ATTRIBUTION.
  - TIMEOUT (infrastructure-unattributed): Unattributed failure: level stays P3, status HOLD, adds FAILURE_ATTRIBUTION.
  - …
```

## 4. Before and after: a localized fix with two peripheral timeouts

Abstract reproduction of an observed consumer pull request: a three-line fix in a replay-only
adapter, legitimate targeted proof, then two wall-clock ceilings in untouched packages that timed
out one after the other (a property at 30.4 s for 30 s that had passed in 12.2 s on the same tree,
then a performance guard at 2.78 s for 1.5 s whose literal ignored the declared CI latency factor).
Observed cost before: 3 candidate commits, 5 CI runs, about 6 fresh audits; each ceiling repair
created a new commit that invalidated the whole aggregate proof although the product claims never
changed.

The test suite replays the sequence with the default policy and with a modeled revision-bound
global policy (every kind bound to the exact revision, full suite and independent audit at P3):

| Step | Before (revision-bound global model) | After (default policy) |
| --- | --- | --- |
| r1, replay fix | P3, 12 required kinds | P3, 10 required kinds (full suite and audit not required) |
| timeout 1 (outside impact, passed on the same tree) | proof infrastructure | proof infrastructure; level, status and product evidence unchanged |
| r1 → r2, first ceiling routed | 13 kinds re-produced | 4 kinds: static checks, revision identity, gate delta review on the ceiling, job reruns on the ceiling and on the job of timeout 2 |
| timeout 2 (outside impact, environment factor) | proof infrastructure | proof infrastructure |
| r2 → r3, second ceiling routed | 13 kinds re-produced | 4 kinds, on the new ceiling only; the first ceiling's review is reused |

The planner stays conservative on the same path: a corpus divergence moves the plan to P4 with the
full corpus; a timeout on a job that exercises the replay surface holds the plan unless it
reproduces on the baseline; a rebase, a changed runtime tree, a missing digest, a test without an
`exercises` list, a harness that names the replay surface, or a product digest changed by a
so-called infrastructure commit forces the product evidence to be produced again; and a regression
left unresolved on r1 blocks the reuse of the evidence on its surfaces. Each of these is a test.

## 5. Mapping to neighbours

**Impact provider.** Any provider can fill `ChangeImpact`. From semctx, for example:
`changedFiles`/`changedSymbols` give direct surfaces; `impactedConsumers` and `control_impact`
paths give transitive ones; `impactedInvariants`/`impactedContracts` and change-contract
`preserves` give claims (criticality from `criticalInvariantTags`); `unknowns` and the
`analysis_scope_incomplete` / `index_binding_stale` findings give completeness and unknowns;
`recommendedTests` only feed test surfaces, never required evidence. semctx reports neither a
candidate commit nor content digests through MCP: the caller supplies `revision`, `baseline` and
digests. Such an adapter belongs outside `src/` (a test forbids that name in source files).

**AssertLedger.** Today AssertLedger can verify `CAUSAL_WITNESS` and `ACCEPTANCE_TEST` as a
qualification campaign (TARGET = baseline, REFERENCE = revision, NEUTRAL = justified variation) with
replay-valid manifests. Other kinds (static checks, CI jobs, reviews, corpora, preregistration) have
no AssertLedger evidence type yet; kinds marked `attested` can only be recorded, not executed.

## 6. Limits and risks

- Inputs are trusted declarations. A caller can mislabel a live surface as offline or omit a surface;
  the planner limits the damage (declared analysis never yields confident exemptions, contradicted
  `exercises` values are overridden, incomplete analyses are unbounded whatever they enumerate,
  untouched critical claims come back as recommendations under uncertainty and as requirements when
  unbounded) but cannot detect a consistent lie. A policy-owned surface classifier is not in V1.
- Claims come from the caller. Pass the full registry; V1 has no registry of its own. A changed proof
  surface without an `exercises` list only reaches the claims that list it; the plan reports it as
  residual uncertainty (`proof.exercises-unknown`).
- The default policy is a first calibration, not a measured optimum. A caller-supplied policy must be
  at least as strict as the default: every kind (verification, binding, subjects), baseline, floor,
  trigger, raise and status rule of the default must still hold with at least the same strength, or
  parsing fails with `PROOF_PLANNER_POLICY_BELOW_MINIMUM`. The tests pin the default by digest and
  check its non-negotiable rules against an independent list. A project that wants a looser policy
  must fork the default; that is deliberate in V1.
- Signals carried across revisions need the caller to report the baseline and runtime tree they were
  observed on. Without them, the carry-over still refuses reuse on the surfaces an unresolved signal
  may concern, but the next plan does not hold or block by itself. An unattributed failure on a job
  that a confidently bounded impact places outside the change holds its own revision only: it is
  never carried and blocks no reuse, so the next revision must observe that job again.
- Freshness is identity-based (digests, baseline, runtime tree), not time-based: the core forbids a
  clock. Time-bound validity windows remain an AssertLedger-side concern.
- The satisfaction check (does evidence exist for each requirement, bound to the listed digests) is
  not implemented; the plan is advisory until it is.
- Attribution bases are declared by whoever reports the signal. A pre-existing product defect, and
  an infrastructure attribution that rests on `REPRODUCES_ON_BASELINE` alone, require
  `FAILURE_ATTRIBUTION`, which AssertLedger should eventually verify; the other bases are trusted
  as declared, within the limits above.
- The module is compiled into `dist/proof-planner/` but not reachable through the package exports;
  its types and digests are not a public contract yet.

## 7. When should it become a separate tool?

Not now. Extract it only when several of these hold, with evidence:

1. **Used without AssertLedger**: at least one consumer plans assurance without producing or
   verifying AssertLedger evidence (for example a CI router or a review bot).
2. **Own policy and configuration lifecycle**: projects version their assurance policy independently
   of AssertLedger releases, with their own compatibility promises.
3. **Several consumers**: two or more independent harnesses or repositories call it, so its release
   cadence conflicts with AssertLedger's.
4. **Autonomous data model**: `ChangeImpact`, `AssurancePlan` and the policy need published JSON
   schemas and conformance fixtures of their own.
5. **Significant algorithms**: work beyond V1's fact derivation, such as learned calibration,
   cross-revision planning or cost models, would bloat AssertLedger's evidence core.
6. **Stable API**: the input and output shapes survive a few real projects without breaking changes.

The module is built for that move: it imports only `zod`, its own files and `sha256Canonical` from
the public `./core` API, and a test enforces that boundary.
