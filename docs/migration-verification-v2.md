# Verification request and evidence manifest v2

Version `2.0.0` of the verification request and evidence manifest adds
[container isolation](container-isolation.md). It is a new major contract beside v1, not a change
to v1.

## What stays the same

- The 34 v1 schema bytes, the conformance-v1 lock root, v1 decision and artifact digest
  projections, outcomes, gates and reason-code semantics are unchanged.
- A v1 request still produces a v1 manifest, and v1 manifests replay exactly as before.
- `parseVerificationRequest()` and `parseEvidenceManifest()` still accept only v1 and reject v2.
- The SDK methods `verify()` and `checkGitRegression()` keep their v1 inputs, results and TypeScript
  types; `verify()` still refuses a v2 request with `SCHEMA_VERSION_UNSUPPORTED`.
- `trusted-local` keeps its fields, stays `UNSANDBOXED` and still requires explicit authorization.
- MCP tool schemas, evidence export, Agentic Test Profiles and benchmarks still accept only v1.

## What v2 adds

- `schemas/verification-request.v2.json`: the v1 request with `schemaVersion: "2.0.0"` and an
  `isolation` union of the unchanged `trusted-local` object and a `container` object with a
  digest-pinned image, declared environment and limits. A request cannot name the runtime command
  or forward host variables.
- `schemas/evidence-manifest.v2.json`: the v1 manifest with `evidenceContext.execution.backend`,
  which the decision digest covers, and a top-level `isolation` union whose container form records
  the runtime argv. A v2 `trusted-local` manifest records `{ "kind": "trusted-local", "level":
  "UNSANDBOXED" }` as its backend.
- Both schemas join the additive schema-extension lock, whose published digest changes
  accordingly.
- `parseVerificationRequestV2()` and `parseEvidenceManifestV2()` accept only v2;
  `parseVersionedVerificationRequest()` and `parseVersionedEvidenceManifest()` accept either version.
- The SDK adds `verifyV2(request, options)` and `checkGitRegressionV2(options)`, which return
  `EvidenceManifestV2Contract`, and the `GitRegressionV2Options` type.

## Changes visible to existing callers

- A request declaring `schemaVersion: "2.0.0"` previously failed with
  `SCHEMA_VERSION_UNSUPPORTED` everywhere. The CLI `verify` command, `verifyV2()` and the exported
  engine function `verifyCampaign()` now validate it as v2. Other unknown versions still fail with
  that code.
- CLI and SDK container failures use new `CONTAINER_*` and `ISOLATION_MODE_CONFLICT` reason codes,
  with CLI exit code `4`, before any repository code runs.
- `assertledger schema` also prints `verification-request-v2` and `evidence-manifest-v2`.

## Compatibility witnesses

- `tests/verification-v2.test.ts`: v2 acceptance and rejection, digest binding of the backend,
  replay tampering, v1 parsers and export closed to v2, and published schema identities.
- `tests/conformance-v1.test.ts` and `tests/schema-registry.test.ts`: unchanged v1 bytes and lock,
  registered v2 schemas.
- `tests/container-backend.test.ts` and `tests/container-facades.test.ts`: backend selection,
  hardened runtime arguments, archive handling and CLI/SDK behavior against a fake runtime.
- `tests/container-isolation-docker.test.ts`: hostile scenarios against a real Docker Engine.
- `tests/engine.test.ts` and `tests/core.test.ts` now use `3.0.0` as their unsupported-version
  witness, because `2.0.0` became a supported version.
