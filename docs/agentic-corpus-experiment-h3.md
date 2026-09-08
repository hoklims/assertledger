# Agentic corpus experiment artifact H3 v1

H3 evaluates historical-fault detection only after three independent operator pins are supplied:
the corpus trust-policy digest, the two-party allocation-commitment digest, and the pre-declared
experiment-plan digest. None may fall back to a digest embedded in the artifact.

## Allocation commitment and reveal

Allocation Commitment/Reveal v1 binds the exact case identity, provenance, source ID and
source-identity digests plus a calibration count for every source stratum. Each source with at
least two cases contributes at least one calibration and one holdout case. Distinct Ed25519 AUTHOR
and REVIEWER principals each commit a
32-byte secret share and sign the same domain-separated commitment projection containing both
share commitments. The reveal must contain both pre-committed shares. AssertLedger sorts them by key
ID, length-prefixes their decoded bytes, derives the final seed, then recomputes and replays Corpus
Allocation v1. This prevents either principal from choosing or replacing a share after the joint
commitment; it does not prove that a principal avoided grinding before committing its own share.

## Pre-declared plan

The externally pinned Experiment Plan v1 contains no outcomes, logs, durations or results. It binds
the allocation and trust anchors, H3 protocol, detailed subject revisions and qualification
receipts, adapter identities, a shared content-addressed candidate universe, each arm's
content-addressed selection and derived suite digest, executable identities plus argument arrays,
repository state, test-suite digests, time/output caps, and the exact schedule. Every
case/arm/attempt/state tuple appears exactly once. Replay derives both equal
`PLANNED_PROCESS_EXECUTION` counts and equal total planned timeout ceilings by summing each
scheduled command's `timeoutMs`. This is comparable pre-declared time allowance, not observed
wall-time or CPU equality.

## Run evidence and derivation

Each scheduled process has one canonical run receipt binding its plan, run and command digests,
case, arm, attempt, subject state, repository and test-suite digests, the applied timeout limit,
process exit/timed-out state,
and SHA-256 digests for stdout, stderr and a structured result. Replay resolves the actual receipt,
stdout, stderr and structured-result bytes and recomputes every digest. The strict
`TESTFORGE_H3_STRUCTURED_RESULT_V1` parser derives normalized outcome and attribution; no outcome
field in the receipt is trusted.

Replay resolves every `candidateDigest` in the frozen universe against the supplied evidence
contents, recomputes its raw SHA-256 digest, and checks the artifact's derived candidate-set digest.
Missing or mismatched candidate bytes invalidate replay. This proves the identity of the bytes
provided to AssertLedger, not that the runner actually executed those bytes.

Process consistency is exact: `PASS` requires `timedOut=false` and exit code zero;
`PROCESS_CRASH` requires `timedOut=false` and a null exit code; `TIMEOUT` requires
`timedOut=true`; every assertion, compile, collection, infrastructure, or no-test failure requires
`timedOut=false` and a nonzero non-null exit code. A contradiction invalidates the artifact rather
than becoming insufficient evidence.

Detection requires an attributed assertion failure on the buggy revision and PASS on the fixed
revision and required suite for every stable attempt. Buggy PASS is a valid non-detection. Compile,
collection, timeout, crash, infrastructure and no-test outcomes are valid operational evidence but
make H3 `INSUFFICIENT`; contradictory attempts do the same. They never become detections.
Non-inferiority must hold both in aggregate and independently for every source stratum, so gains
on one source cannot compensate for regressions on another.

The SDK requires the artifact and replay options as separate arguments. The CLI requires separate
files and flags for all three external pins, policy, commitment/reveal, allocation, plan, subject
evidence and evidence bytes. H3 tools are intentionally absent from the default agent-facing MCP
server because an input JSON document cannot establish those operator-owned roots of trust.

## Compatibility and non-claims

Existing AgenticCorpusCase v1 `h1`-`h4` members remain wire-compatible as
`LEGACY_CASE_METRICS`, but any such member makes a subject inadmissible to mature H3 replay. This
contract establishes deterministic consistency relative to supplied external anchors and bytes. It
does not authenticate the machine that executed commands, prove private custody, or establish that
the corpus represents all real defects. Qualification receipt digests are pre-declared identities;
H3 v1 does not resolve their bytes. A run receipt's applied-timeout field binds the runner's
attestation to the pre-declared limit; it is not an independent execution authority. H1 latency
and H4 mutation strength remain separate and cannot
compensate for H3 failure.

## Migration note

The pre-release v1 allocation and H3 projections were tightened before a stable release. Global
`calibrationCount` plus `caseIds` inputs are rejected; callers must provide source strata. Candidate
IDs became content-addressed references, plan budgets gained derived timeout ceilings, receipts
gained `appliedTimeoutMs`, and results gained per-source strata. Existing stored drafts must be
regenerated and externally repinned. Artifacts also gained a derived candidate-set digest and
replay gained candidate-byte resolution. Redigesting an old document is insufficient.

Recent research reinforces those boundaries: coverage and mutation can be context-dependent
proxies when the code under test may already be buggy ([arXiv:2607.22880](https://arxiv.org/abs/2607.22880)),
while a strong recent baseline and evaluation granularity can materially change measured cost
([arXiv:2601.09695](https://arxiv.org/abs/2601.09695)). AssertLedger therefore requires a frozen shared
candidate universe rather than comparison against a conveniently weak historical prompt.
