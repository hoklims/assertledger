# TestExplora curated calibration evidence

TestExplora is the third real-fault source selected after BugsJS, ManyBugs, and BugSwarm failed the
declared reproducibility gates. Its admission status is `ADMITTED_CURATED_CALIBRATION`: eight cases
are suitable for threshold and protocol calibration, but they are not a hidden holdout, a
population-rate estimate, or evidence that H3 is ready.

## Immutable source inputs

- harness: `microsoft/TestExplora@11e6952261f58d3ceb9f4d2571e03aa35dad9523`;
- harness tree: `98bb0effbcb55b9d15c442660a9de145a7268e14`;
- harness MIT license bytes: `sha256:98a96c38494df4963951e32b81ec4effebe4c8a812ab8d9e7d185d59e86fe2fc`;
- dataset revision: `91d8edfb851331bc77eddff40c794336b16c79fe`;
- source parquet: 19,131,078 bytes,
  `sha256:0d107eb22a082a3549adaf3ea52473d07ffee13b8d9eec908a243916de171c0a`.

The pinned parquet contains 1,552 rows from 482 repositories. Its released schema exposes
`instance_id`, `repo`, `pull_number`, `base_commit`, `pr_patch`, `code_patch`, `test_patch`,
`documentation`, and `test_invokes`. It does not expose the `FAIL_TO_PASS` or `test_invoke_path`
fields described by earlier material. `test_invokes` is dependency metadata, not an execution
command or an outcome oracle.

## Qualification protocol

Each admitted case uses the upstream production patch and test patch, while keeping the test patch
outside any future generator context. The environment was reconstructed from pinned base images,
wheel or source distributions, and subject commits. Dependencies were downloaded before the lock;
project images were built and all observations executed with networking disabled.

Every case required three fresh buggy observations with an assertion failure attributable to the
introduced test, three fresh fixed observations that passed, and a green positive sentinel. A
compilation, collection, process, timeout, infrastructure, generic-exception, or positive-suite
failure was inconclusive and never counted as detection.

The eight admitted cases are:

- `almarklein__timetagger-117`;
- `rigetti__pyquil-1758`;
- `cloud-custodian__cloud-custodian-9970`;
- `pyinfra-dev__pyinfra-930`;
- `reata__sqllineage-431`;
- `PyCQA__pyflakes-438`;
- `adrienverge__yamllint-422`;
- `googleapis__python-genai-739`.

## Evidence index

The external evidence root is `E:\testforge-evidence\corpus-sources`. Subject sources and images
are not redistributed from this repository.

| Campaign | Admitted | Manifest SHA-256 |
| --- | ---: | --- |
| `testexplora-preflight-v1` | 5 | `e461cd48f252b9c16705656f42ca3cb8a6389c70c9be0bedac3ce4aafe5f50ad` |
| `testexplora-replacements-v1` | 1 | `9faf9acec63b96f9e3849a9b37066607394bc5c5899ecc63cf312a3171470e76` |
| `testexplora-replacements-v2` | 1 | `ca545ccb83841b929181cbac6cf508974ba2d856f008b4922277b42bc85ef9d5` |
| `testexplora-replacements-v3` | 1 | `121078b7d80ce677148ae5fc0bb79a44e45297631765059b2189122b77c82b09` |

The combined admission document is
`testexplora-replacements-v3/COMBINED_ADMISSION.json`, SHA-256
`05695fb7afa269eb740c092e438561b54aa55f89857ce58d2d842b5a79603560`.
It binds the prior campaign manifests and the final campaign's selection, plan, pre-run lock, and
results. The final recursive manifest lists 61 payloads with zero mismatch and zero unlisted file.

## Proof boundary

The environments are AssertLedger reconstructions, not reference environments supplied by
TestExplora. The multi-campaign selection is intentionally calibrated from prior outcomes. These
receipts establish eight stable real-fault calibration cases, not sampling representativeness,
generalization, independent temporal custody, or holdout integrity. TestExplora can contribute to
mature H3 only through a new unseen selection, a two-party committed allocation, signed provenance,
an externally pinned experiment plan, and independently executed receipts.
