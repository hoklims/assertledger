# Agentic profile corpus plan

This document defines the first empirical calibration corpus for the Agentic Test Profile. It is a
reconstruction plan, not collected evidence. A case counts only after source-native reproduction,
dual-signed provenance, and admission to the physical corpus.

## Frozen pilot scope

The planned pilot targets 24 independently qualified historical-fault cases: eight from each
source. Four cases per source are intended for public calibration and four for holdout. Case
identifiers are frozen only after the buggy/fixed pair reproduces on the pinned environment. At
present, only the eight TestExplora cases below have qualified, and only for curated calibration.

| Source | Pin | Cases | Primary contribution |
| --- | --- | ---: | --- |
| Defects4J 3.0.1 | `rjust/defects4j@8c16da8230843cdc918eaf4ddb449637f02b83c6` | 8 | H1, H3, and the pilot's only native H4 mutation baseline |
| TestExplora | harness `microsoft/TestExplora@11e6952261f58d3ceb9f4d2571e03aa35dad9523`; dataset `91d8edfb851331bc77eddff40c794336b16c79fe` | 8 | Curated H1/H3 calibration candidates from real Python pull requests; not a holdout |
| SWE-bench Verified | dataset `78f471bf655a3137b2e8a75af1501690ec009ec3`; harness `7a21e05772954cc81471ae19d56f436cecf43c54` | 8 | H1 and H3 for recent Python issue/PR regressions |

TestExplora is admitted only as `ADMITTED_CURATED_CALIBRATION`. Eight cases reproduced with stable
attributable assertion failures on the buggy state and stable passes on the fixed state, but the
selection was calibrated across multiple pre-declared campaigns. It is therefore neither a hidden
holdout nor evidence that the corpus is `READY_H3`. The harness also does not publish a frozen
per-task environment; AssertLedger reconstructed dependency images from pinned inputs and executed
them without network access. See [TestExplora calibration evidence](testexplora-calibration.md).
Subject repositories and container images must be recorded by immutable commit or image digest in
each execution receipt.

## Allocation freeze boundary

Calibration and holdout membership must be created once before any profile threshold, portfolio,
or prompt is tuned. A mature freeze uses Allocation Commitment/Reveal v1: distinct authorized
AUTHOR and REVIEWER principals pre-commit independent secret shares while signing the exact case
identity/provenance/source set and the calibration count for every source stratum. Every source
with at least two admitted cases must retain non-empty calibration and holdout partitions. After
both shares are revealed, AssertLedger derives a
domain-separated seed, applies `SHA256_ASCENDING_SPLIT_V1`, and replays the resulting allocation.
The operator must independently pin the trust-policy and commitment digests.

Real allocation seeds, membership, score ordering, and allocation digests remain in private
holdout custody outside the repository. Public tests use an unrelated synthetic allocation only;
they establish algorithm conformance without revealing any real holdout membership. The admitted
cases remain pending until their complete provenance sidecars and required evidence are present.

The earlier single-nonce pilot commitment is invalidated: one party could choose the seed and the
receipt did not bind dual authorization, case provenance, or the allocation protocol. It is not a
mature freeze and must not be used for an H3 claim. No valid real holdout commitment, seed,
allocation digest, case identifier, or membership is published in this repository.

The existing optional `h1` through `h4` members of an AgenticCorpusCase v1 are retained unchanged
for wire compatibility and are designated `LEGACY_CASE_METRICS`. They are self-contained summary
claims, not replayable experiment artifacts, and therefore cannot support a mature profile,
sweet-spot, or hypothesis claim. Mature H3 evaluation uses the separate versioned
[experiment artifact](agentic-corpus-experiment-h3.md), which requires an externally pinned
two-party allocation commitment and pre-declared experiment plan. H1, H2, and H4 remain blocked on
their own mature experiment artifacts.

## Admission protocol

Every case must record the benchmark pin, exact subject buggy and fixed revisions, environment and
tool versions, an executable-plus-arguments command, input and output digests, and at least three
repeated source-native runs. The expected fault must fail on the buggy revision and pass on the
fixed revision together with the source-required regression suite.

Timeout, setup, compilation, collection, process, and infrastructure failures are inconclusive.
They never count as historical-fault detections or mutant kills. Source files are reconstructed from
their upstream repositories by default; AssertLedger does not assume that a benchmark framework's
license grants redistribution rights for every subject repository.

After reproduction, an authorized author and a different authorized reviewer sign the canonical
case sidecar described in [Agentic corpus provenance v1](agentic-corpus-provenance.md). The expected
trust-policy digest must be distributed outside the corpus. Pending or unsigned cases stay outside
the active `public/` and `private/` splits.

## Hypothesis boundaries

- H1 uses warmed repeated execution p95 for the selected portfolio and the declared full eligible
  suite at equal target strength.
- H2 requires separately constructed, language-specific behavior-preserving neutral worlds and an
  independent preservation review. The three historical-fault datasets do not supply this proof.
  Formatting-only controls may test integrity, but cannot establish substantive neutral robustness.
- H3 uses source-stratified historical-fault holdouts that remain unseen during policy calibration.
- H4 is scoped to the Defects4J tranche in the pilot because it alone exposes a native mutation
  interface. No cross-language H4 claim follows from this tranche.

The corpus becomes mechanically `READY` only after the existing minimum-case, minimum-source,
public/holdout, H1-H4 evaluability, and signed-provenance gates pass. `READY` means the corpus may be
evaluated; it does not mean the hypotheses are supported. A public sweet-spot claim additionally
requires the predeclared public and holdout evaluation criteria to succeed.

## Primary sources

- [Defects4J pinned README](https://raw.githubusercontent.com/rjust/defects4j/8c16da8230843cdc918eaf4ddb449637f02b83c6/README.md)
  and [command reference](https://defects4j.org/html_doc/index.html)
- [TestExplora pinned harness](https://github.com/microsoft/TestExplora/tree/11e6952261f58d3ceb9f4d2571e03aa35dad9523)
  and [dataset](https://huggingface.co/datasets/microsoft/TestExplora/tree/91d8edfb851331bc77eddff40c794336b16c79fe)
- [SWE-bench dataset fields](https://www.swebench.com/SWE-bench/guides/datasets/),
  [pinned harness](https://github.com/SWE-bench/SWE-bench/tree/7a21e05772954cc81471ae19d56f436cecf43c54),
  and [benchmark description](https://www.swebench.com/original.html)

Defects4J, TestExplora, and the SWE-bench harness use MIT licenses at the listed pins. Each
TestExplora subject keeps its own license, verified at the selected base commit; the dataset license
does not replace subject licensing. BugsInPy and Bugs.jar are excluded because their official
repositories do not provide a usable declared license. GitBug-Java remains a later expansion due
to its substantially larger documented storage footprint.
