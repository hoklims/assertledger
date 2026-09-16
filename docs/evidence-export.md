# Interoperable evidence export

AssertLedger can hand its results to an external engine, such as a change-governance tool, as
typed evidence. The export is a thin, deterministic projection of a replay-valid
[evidence manifest](proof-model.md). It adds no gate, no authority, and no runtime dependency on
any consumer: AssertLedger behaves identically whether a consumer exists, accepts the evidence,
degrades it, or ignores it.

Three public contracts are involved, each with a versioned JSON Schema:

| Contract | Schema | Produced by |
| --- | --- | --- |
| Provider manifest | [`evidence-provider-manifest.v1.json`](../schemas/evidence-provider-manifest.v1.json) | `assertledger provider`, `AssertLedger.providerManifest()`, `assertledger_provider` |
| Export request | [`evidence-export-request.v1.json`](../schemas/evidence-export-request.v1.json) | The consumer or operator |
| Evidence export | [`evidence-export.v1.json`](../schemas/evidence-export.v1.json) | `assertledger export`, `AssertLedger.exportEvidence()`, `assertledger_export` |
| Export replay result | [`evidence-export-replay-result.v1.json`](../schemas/evidence-export-replay-result.v1.json) | `assertledger export-replay`, `AssertLedger.replayEvidenceExport()`, `assertledger_export_replay` |

## Provider manifest: what is announced

The provider manifest describes the installed provider: its version, the source revision recorded
at build time, its scope, the formats it accepts and emits, its capabilities, its supported
adapters, its cost model, and its limits. It carries a `manifestDigest` over its canonical
projection.

The source revision is `RECORDED` with the commit and a `CLEAN` or `DIRTY` worktree only when the
package build captured it (`dist/build-info.json`). A source checkout or a build without Git reports
`UNKNOWN`; the current checkout never fills in a missing value.

Capabilities are announcements. `CONTROL_WITHOUT_CANDIDATE`, `REFERENCE_PASS`,
`REGRESSION_DETECTION`, `NEUTRAL_PASS`, and `STABILITY_REPETITION` are `SUPPORTED` test-observed
controls. `GIT_REVISION_PROVENANCE` is `SUPPORTED_WHEN_RECORDED`. `EXECUTION_FRESHNESS`,
`PRODUCER_AUTHENTICATION`, and `SANDBOXED_EXECUTION` are `UNSUPPORTED`. A capability never proves
that a control ran: only the recorded observations of an exported manifest do.

## Export request

```json
{
  "schemaVersion": "1.0.0",
  "manifest": { "...": "a replay-valid evidence manifest v1" },
  "consumerRequest": {
    "reference": "change-42",
    "profileId": null,
    "obligations": [
      { "id": "detect", "control": "REGRESSION_DETECTION" },
      { "id": "sandbox", "control": "SANDBOXED_EXECUTION" }
    ]
  }
}
```

`consumerRequest` may be `null`. Obligation identifiers must be unique. The request is not a
policy for AssertLedger: it only lets the export state which requested controls were executed,
not executed, or unsupported. No particular plan format is required.

The export refuses a manifest that fails replay with `EVIDENCE_EXPORT_SOURCE_INVALID` (CLI exit
code `4`, no output). A malformed request fails with `EVIDENCE_EXPORT_REQUEST_INVALID`.

## Evidence export: what was observed

The export embeds its `sourceManifest` and is self-contained. Its sections are deliberately
separate:

- `result`: the verbatim campaign decision, a per-candidate and per-world view, and a single
  conservative `detection` with a stable `reasonCode`.
- `integrity`: the replay rails that were verified before export and the bound digests (artifact,
  decision, repository, policy, and world digests).
- `authenticity`: always `UNAUTHENTICATED` with attestation `NONE`; the producer name and version
  are only declared by the manifest.
- `environment`: `trusted-local`/`UNSANDBOXED` isolation, the environment allowlist names, and the
  adapter. The framework is `RECORDED` only for a `node:test` manifest that recorded its official
  adapter profile; otherwise it stays `UNKNOWN`.
- `confidence`: the level `REPLAY_CONSISTENT_UNAUTHENTICATED`, with the properties that replay
  established and those it did not (producer authenticity, observation truthfulness, execution
  isolation, execution freshness, and the semantic relevance of the declared worlds).
- `scope`: attempts, candidate and observation counts, and each world with its digest, declared
  provenance, and Git revision. Git commits and trees are exported only when the provenance is the
  exact canonical record written by [Git regression qualification](git-regression.md);
  `gitRevisions` is `RECORDED`, `PARTIAL`, or `NOT_RECORDED`.
- `controls`: executed controls with their observation counts, requested obligations with
  `EXECUTED`, `NOT_EXECUTED`, or `UNSUPPORTED` coverage, and gates that did not run.
- `profile`: `NOT_REQUESTED`, or `UNKNOWN_PROFILE` for any requested profile identifier. No usage
  profile is defined yet, so none is ever applied or inferred.
- `policy`: the effective AssertLedger policy version and digest.
- `cost`: the estimated process executions derived from the recorded campaign shape, the observed
  executions and recorded wall time with its coverage, and execution freshness `UNKNOWN` with cache
  provenance `NOT_RECORDED`, because evidence manifest v1 does not record them.

### Detection mapping

The first matching row applies.

| Situation | `detection` | `modality` | `reasonCode` |
| --- | --- | --- | --- |
| Campaign `VERIFIED` | `OBSERVED` | `TEST_OBSERVED` | `REGRESSION_ASSERTION_OBSERVED` |
| Campaign `ENGINE_ERROR` | `NOT_ESTABLISHED` | `NONE` | `ENGINE_ERROR` |
| Invalid controls | `NOT_ESTABLISHED` | `NONE` | `CONTROL_EVIDENCE_INVALID` |
| An `UNSTABLE` or `INCONCLUSIVE` candidate | `NOT_ESTABLISHED` | `NONE` | `CANDIDATE_EVIDENCE_INCONCLUSIVE` |
| An `INVALID` candidate | `NOT_ESTABLISHED` | `NONE` | `CANDIDATE_EVIDENCE_INVALID` |
| A target outcome that is neither a stable attributed `PASS` nor a stable attributed assertion | `NOT_ESTABLISHED` | `NONE` | `OPERATIONAL_OUTCOME_NOT_DETECTION` |
| At least one target observed passing | `NOT_OBSERVED` | `TEST_OBSERVED` | `TARGET_PASSED_WITHOUT_DETECTION` |
| Otherwise, such as every target killed without meeting the policy | `NOT_ESTABLISHED` | `NONE` | `TARGET_STRENGTH_INSUFFICIENT` |

The targeted test is the candidate: its `id` and content `digest`, the SHA-256 of the canonical JSON
of its `[{ "path", "content" }]` overlay files. Evidence manifest v1 does not record the file paths
themselves; a consumer holding the verification request (for example `executed-request.json`
written by `assertledger check`) can recompute the digest to bind paths to the exported evidence.

Per world, `signal` is `RED` only for complete, stable, attributed `ASSERTION_FAILURE` runs and
`GREEN` only for complete, stable, attributed `PASS` runs. A target world's `detection` is
`OBSERVED` or `NOT_OBSERVED` only when controls are valid and the candidate is `ELIGIBLE` or
`WEAK_ORACLE`. Compilation, collection, crash, timeout, infrastructure, and no-test outcomes are
never promoted to detection evidence in either direction.

## Determinism and replay

The same manifest and consumer request always produce the same export bytes after canonical
serialization, independent of JSON key order; obligations are ordered by identifier. The
`exportDigest` covers the whole export except itself.

`assertledger export-replay` validates the export schema, replays the embedded source manifest,
recomputes `exportDigest`, and rebuilds the export from the embedded manifest and consumer request.
`valid` requires all four rails. It exits with `0` when valid and `4` otherwise. A re-digested
forgery keeps `exportDigestValid` true but fails `semanticsValid`.

## Consumer responsibilities

A consumer decides admissibility with its own obligations. The
[`consumer example`](../examples/evidence-export/consumer.mjs) rejects an export that fails replay,
ignores exports without observed detection, and degrades observed detection to advisory when
controls or Git revisions are missing or the evidence is unauthenticated, which is always the case
for this version. Rejecting, degrading, or ignoring an export changes nothing in AssertLedger.

## Non-claims

The export does not rerun tests, authenticate the producer, attest isolation, prove that recorded
observations were truthful, prove freshness, or make declared worlds semantically relevant. It
covers only the recorded worlds, candidates, and attempts.

## Versioning

These four schemas are additive to the frozen [conformance v1](conformance-v1.md) set and are
locked by `conformance/schema-extensions.json`. Any change to their bytes, their mapping, or their
digest projections requires a new schema version, a migration note, and compatibility tests.
