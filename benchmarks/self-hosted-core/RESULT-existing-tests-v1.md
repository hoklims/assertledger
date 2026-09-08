# Existing core tests — measured result v1

This is the first measured output of the existing-test inventory campaign. It evaluates the 36
literal `it(...)` cases present in `tests/core.test.ts` independently against the frozen reference,
one behavior-equivalent neutral rewrite, and four required target mutations.

## Deterministic verdict

- Decision: `REJECTED`
- Reason: `NO_ELIGIBLE_CANDIDATE`
- Replay: valid on all five rails
- Observations: 444 total; 432 `PASS`, 12 attributed `ASSERTION_FAILURE`
- Stability: two matching attempts for every candidate/world pair
- Candidate statuses: 36 `WEAK_ORACLE`; zero `INVALID`, `UNSTABLE`, or `INCONCLUSIVE`
- Repository digest: `sha256:b466310b3ad8bae2e6028eb3f788255c81bb6c9c801a4efae7fc5b719417fc49`
- Decision digest: `sha256:d32fb425bde1e706f28fdb7e7e547c3d3305d2282eefc31d4f86a86d400dea2b`
- Artifact digest: `sha256:a68eeb4ab4a3383edd0c861ac6fc1eda893fa33b9fb1ff536c6c049754795a9c`

`REJECTED` is the correct result. The 250-permille threshold records a one-of-four kill, but all four
target worlds are required. None of the existing tests kills all four mutations independently.

## Tests that detect a target

| Existing test | Target killed |
| --- | --- |
| `keeps semantic and decision replay valid when only duration is altered` | `target-duration-in-decision-digest` |
| `excludes volatile durations from the decision digest` | `target-duration-in-decision-digest` |
| `rejects forged decision semantics even when both public digests are recomputed` | `target-duration-in-decision-digest` |
| `is inconclusive when repeated observations disagree` | `target-stability-completeness-only` |
| `preserves run metadata and binds operational changes only into the artifact digest` | `target-duration-in-decision-digest` |
| `rejects auto-sealed deterministic observation fields unknown to the core` | `target-duration-in-decision-digest` |

No existing test independently detects `target-dependent-gate-order` or
`target-threshold-strict-greater`.

## Explicit zero-kill inventory

The following 30 tests killed zero target worlds:

1. `does not let an inconclusive candidate poison an independently eligible selection`
2. `rejects non-SHA-256 digests on every published evidence boundary`
3. `is inconclusive when a target attempt times out`
4. `verifies a stable candidate that passes reference and neutral worlds and kills targets`
5. `accepts only the eight version-one observation outcomes`
6. `links candidate gate results to the observations that justify them`
7. `rejects impossible candidate discovery attribution`
8. `rejects evidence that omits the execution provenance context`
9. `detects decision-relevant tampering`
10. `uses deterministic marginal target coverage before patch size`
11. `rejects unknown schema and policy versions at the direct core boundary`
12. `enforces core policy bounds independently of the request contract`
13. `requires candidates and one required world of every kind with portable weights`
14. `produces deterministic NFC case-insensitive keys for portable collision detection`
15. `binds engine, adapter, execution and world provenance into the decision digest`
16. `does not mask unexpected decision-engine exceptions as invalid evidence`
17. `replays an authentic manifest from its reduced evidence input`
18. `does not let a caller configure collection failures as target evidence`
19. `canonicalizes object keys independently of insertion order`
20. `rejects non-portable candidate identifiers at the core boundary`
21. `accepts only the exact singleton assertion-failure outcome policy`
22. `is inconclusive rather than an engine error when control evidence is not green`
23. `accepts normalized test paths and rejects traversal, absolute paths, and Windows ADS`
24. `does not count compilation failures as target discrimination`
25. `rejects Windows device names even with extensions and mixed casing`
26. `rejects evident evidence-manifest bound violations`
27. `produces the same selection and digest for candidate permutations`
28. `rejects values outside canonical JSON`
29. `uses ordinal ordering without consulting the host locale`
30. `rejects control characters and Windows-forbidden filename characters`

## Artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| `operator-plan.json` | `c54e96a54e9333ef296a4781c23066ca998fc848808a203f06fdc595c8011c42` |
| `request.json` | `395378a3432826b34827a9051bcbf86dffb6a14b4b129a73adeee5b1f8b596fe` |
| `worlds.json` | `8ec4c7fa0695f04c1e12fa0854a6ea472cf0f08a6be0a2bb76530d7bc250f16b` |
| `candidates.json` | `9cb0dad3379b78744ce1a0c2e4b1a0e12546b639ee316aa88f29292d5bbbc3d6` |
| `existing-test-catalogue.json` | `133cf64526f1a814168a2e653f223fc3b0ff9a9d77c9a851c7764c19ac81f96c` |
| `mutation-definitions.json` | `5ca8852c4b6e625ecb96a6b19f8e7fe100ace0d56c16e328d2e6bfab08281743` |
| `manifest.json` | `921b91e8705f1b18a387553ab8263366b62da813e393615cf03ad1bd70e29621` |
| `replay.json` | `ca4071a788eb569b4a8c9a99d289ed93e36d16ee9c28ee4be4235ad348706312` |

The current local evidence directory is `E:\testforge-evidence\self-hosted-core-existing-tests-v3`.
It is not a standalone reproduction bundle: the adapter, Node executable, installed dependencies,
repository checkout, mutation semantics, and execution host remain part of the trusted computing
base. This report file is explicitly excluded from the measured repository snapshot to avoid a
self-referential digest; executable campaign code and test sources remain included. The two attempts
do not prove absence of flakiness beyond this campaign.
