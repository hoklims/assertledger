# SDK surface map

[ADR 0003](decisions/0003-retire-public-javascript-api.md) retires the JavaScript API in 3.0.0 and
requires, before the last 2.x release, a mapping from every public SDK method to a CLI command or an
MCP tool. This page is that mapping, measured on version 2.1.0. A row with status `none` has
no equivalent today.

## Scope

The JavaScript API is the three package exports and every runtime value they expose:

| Export | Runtime values | Content |
| --- | --- | --- |
| `.` | 332 | Everything below |
| `./core` | 40 | A subset of `.`, marked † in this page |
| `./bun` | 2 | `assertSame`, `isAssertSameFailure` |

Type-only exports have no runtime value and are not listed. Every runtime value of `.` appears in
exactly one section below.

Statuses:

- `equivalent`: a CLI command, an MCP tool or a published schema accepts the same inputs and returns
  the same document.
- `partial`: the behavior is reachable, with the restriction given in the note.
- `none`: no command, tool or schema reaches it on its own inputs.

‡ The MCP tool exists only when the server runs with `--allow-unsafe-execution`.

## `AssertLedger` methods

`TestForge` is a subclass that declares no method of its own; its rows are the same.

| Method | CLI | MCP | Status | Note |
| --- | --- | --- | --- | --- |
| `sealQualificationPlan` | `qualification-plan` | `assertledger_qualification_plan` | equivalent |  |
| `qualifyOrchestration` | `qualify --allow-unsafe-execution` | `assertledger_qualify`‡ | equivalent | Only with `allowUnsafeExecution: true`, the one mode the SDK executes. |
| `replayQualification` | `qualification-replay [--domain]` | `assertledger_qualification_replay` | equivalent |  |
| `admitQualificationCi` | `qualification-ci --observation` | `assertledger_qualification_ci` | equivalent |  |
| `explain` | `explain CODE… --json` | `assertledger_explain` | equivalent |  |
| `analyze` | `analyze` | `assertledger_analyze` | equivalent |  |
| `audit` | `audit [--verification-request] [--no-git]` | — | partial | The `afterInitialInventory` callback has no CLI equivalent. |
| `init` | `init` | — | partial | The `afterEvidenceSnapshot` and `onLinkAssessment` callbacks have no CLI equivalent. |
| `doctor` | `doctor [--framework] [--exclude]` | `assertledger_doctor` | partial | The `onLinkAssessment` callback has no CLI or MCP equivalent. |
| `doctorRuntime` | `doctor --runtime --allow-unsafe-execution` | `assertledger_doctor_runtime`‡ | equivalent |  |
| `verify` | `verify --allow-unsafe-execution` (v1 request) | `assertledger_verify`‡ | equivalent |  |
| `verifyV2` | `verify` (v2 request) | — | equivalent | Container runtime and transport through `--container-runtime` and `--container-transport`. |
| `verifyV3` | `verify` (v3 request) | `assertledger_verify_v3`‡ | equivalent |  |
| `verifyV4` | `verify` (v4 request) | — | equivalent |  |
| `verifyV5` | `verify` (v5 request) | — | equivalent |  |
| `importWitness` | `import-witness --out` | — | equivalent | Isolation through `--container-image`, `--allow-unsafe-execution` or `--allow-windows-native-execution`; allowlist through `--env`. |
| `checkGitRegression` | `check --allow-unsafe-execution` | `assertledger_check`‡ | equivalent |  |
| `checkGitRegressionV2` | `check --container-image` | — | equivalent |  |
| `replay` | `replay` | `assertledger_replay` | equivalent |  |
| `profile` | `profile` | `assertledger_profile` | equivalent |  |
| `replayProfile` | `profile-replay` | `assertledger_profile_replay` | equivalent |  |
| `exportEvidence` | `export` | `assertledger_export` | equivalent |  |
| `replayEvidenceExport` | `export-replay` | `assertledger_export_replay` | equivalent |  |
| `providerManifest` | `provider` | `assertledger_provider` | equivalent |  |
| `benchmark` | `benchmark` | `assertledger_benchmark` | equivalent |  |
| `replayBenchmark` | `benchmark-replay` | `assertledger_benchmark_replay` | equivalent |  |
| `acquireBenchmark` | `benchmark-acquire --allow-unsafe-execution` | `assertledger_benchmark_acquire`‡ | equivalent |  |
| `replayBenchmarkAcquisition` | `benchmark-acquire-replay` | `assertledger_benchmark_acquire_replay` | equivalent |  |
| `profileV2` | `profile-v2` | `assertledger_profile_v2` | equivalent |  |
| `replayProfileV2` | `profile-v2-replay` | `assertledger_profile_v2_replay` | equivalent |  |
| `allocateCorpus` | `corpus-allocate` | `assertledger_corpus_allocate` | equivalent |  |
| `replayCorpusAllocation` | `corpus-allocation-replay` | `assertledger_corpus_allocation_replay` | equivalent |  |
| `corpusExperiment` | — | — | none | Creates an H3 experiment artifact; only its replay has a command. |
| `replayCorpusExperiment` | `corpus-experiment-replay` | — | equivalent |  |
| `replayCorpusAllocationCommitment` | — | — | none | Replayed only inside `corpus-experiment-replay`. |
| `schema` | `schema NAME` | `assertledger_schema` | equivalent | MCP accepts 36 of the 48 CLI names. |

36 methods: 31 equivalent, 3 partial, 2 none (`corpusExperiment`, `replayCorpusAllocationCommitment`).

## Document contracts

Each published schema in `schemas/` is the equivalent of the Zod schema, parser and JSON Schema
function exported for that document. `schema NAME` prints it from the CLI and the MCP server when
the name is accepted there; the file ships in the package either way.

| Published schema | Exports | CLI `schema` | MCP `schema` | Status | Note |
| --- | --- | --- | --- | --- | --- |
| `agentic-benchmark-acquisition-replay-result.v1.json` | `AgenticBenchmarkAcquisitionReplayResultSchema`, `parseAgenticBenchmarkAcquisitionReplayResult`, `agenticBenchmarkAcquisitionReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-benchmark-acquisition-request.v1.json` | `AgenticBenchmarkAcquisitionRequestSchema`, `parseAgenticBenchmarkAcquisitionRequest`, `agenticBenchmarkAcquisitionRequestJsonSchema` | yes | yes | equivalent |  |
| `agentic-benchmark-acquisition-result.v1.json` | `AgenticBenchmarkAcquisitionResultSchema`, `parseAgenticBenchmarkAcquisitionResult`, `agenticBenchmarkAcquisitionResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-benchmark-artifact.v1.json` | `AgenticBenchmarkArtifactSchema`, `parseAgenticBenchmarkArtifact`, `agenticBenchmarkArtifactJsonSchema` | yes | yes | equivalent |  |
| `agentic-benchmark-replay-result.v1.json` | `AgenticBenchmarkReplayResultSchema`, `parseAgenticBenchmarkReplayResult`, `agenticBenchmarkReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-benchmark-request.v1.json` | `AgenticBenchmarkRequestSchema`, `parseAgenticBenchmarkRequest`, `agenticBenchmarkRequestJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-allocation-commitment-replay-result.v1.json` | `AgenticCorpusAllocationCommitmentReplayResultSchema`, `parseAgenticCorpusAllocationCommitmentReplayResult`, `agenticCorpusAllocationCommitmentReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-allocation-commitment.v1.json` | `AgenticCorpusAllocationCommitmentSchema`, `parseAgenticCorpusAllocationCommitment`, `agenticCorpusAllocationCommitmentJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-allocation-replay-result.v1.json` | `AgenticCorpusAllocationReplayResultSchema`, `parseAgenticCorpusAllocationReplayResult`, `agenticCorpusAllocationReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-allocation-request.v1.json` | `AgenticCorpusAllocationRequestSchema`, `parseAgenticCorpusAllocationRequest`, `agenticCorpusAllocationRequestJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-allocation-reveal.v1.json` | `AgenticCorpusAllocationRevealSchema`, `parseAgenticCorpusAllocationReveal`, `agenticCorpusAllocationRevealJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-allocation.v1.json` | `AgenticCorpusAllocationSchema`, `parseAgenticCorpusAllocation`, `agenticCorpusAllocationJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-experiment-artifact.v1.json` | `AgenticCorpusExperimentArtifactSchema`, `parseAgenticCorpusExperimentArtifact`, `agenticCorpusExperimentArtifactJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-experiment-plan-replay-result.v1.json` | `AgenticCorpusExperimentPlanReplayResultSchema`, `parseAgenticCorpusExperimentPlanReplayResult`, `agenticCorpusExperimentPlanReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-experiment-plan.v1.json` | `AgenticCorpusExperimentPlanSchema`, `parseAgenticCorpusExperimentPlan`, `agenticCorpusExperimentPlanJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-experiment-replay-request.v1.json` | `AgenticCorpusExperimentReplayRequestSchema`, `parseAgenticCorpusExperimentReplayRequest`, `agenticCorpusExperimentReplayRequestJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-experiment-replay-result.v1.json` | `AgenticCorpusExperimentReplayResultSchema`, `parseAgenticCorpusExperimentReplayResult`, `agenticCorpusExperimentReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-experiment-request.v1.json` | `AgenticCorpusExperimentRequestSchema`, `parseAgenticCorpusExperimentRequest`, `agenticCorpusExperimentRequestJsonSchema` | yes | yes | equivalent |  |
| `agentic-corpus-provenance.v1.json` | `AgenticCorpusProvenanceSchema`, `parseAgenticCorpusProvenance`, `agenticCorpusProvenanceJsonSchema` | — | — | equivalent |  |
| `agentic-corpus-trust-policy.v1.json` | `AgenticCorpusTrustPolicySchema`, `parseAgenticCorpusTrustPolicy`, `agenticCorpusTrustPolicyJsonSchema` | — | — | equivalent |  |
| `agentic-profile-replay-result.v1.json` | `AgenticProfileReplayResultSchema`, `parseAgenticProfileReplayResult`, `agenticProfileReplayResultJsonSchema` | yes | yes | equivalent |  |
| `agentic-profile-replay-result.v2.json` | `AgenticProfileReplayResultV2Schema`, `parseAgenticProfileReplayResultV2`, `agenticProfileReplayResultV2JsonSchema` | yes | yes | equivalent |  |
| `agentic-profile-report.v1.json` | `AgenticProfileReportSchema`, `parseAgenticProfileReport`, `agenticProfileReportJsonSchema` | yes | yes | equivalent |  |
| `agentic-profile-report.v2.json` | `AgenticProfileReportV2Schema`, `parseAgenticProfileReportV2`, `agenticProfileReportV2JsonSchema` | yes | yes | equivalent |  |
| `agentic-profile-request.v1.json` | `AgenticProfileRequestSchema`, `parseAgenticProfileRequest`, `agenticProfileRequestJsonSchema` | yes | yes | equivalent |  |
| `agentic-profile-request.v2.json` | `AgenticProfileRequestV2Schema`, `parseAgenticProfileRequestV2`, `agenticProfileRequestV2JsonSchema` | yes | yes | equivalent |  |
| `evidence-export-replay-result.v1.json` | `EvidenceExportReplayResultSchema`, `parseEvidenceExportReplayResult`, `evidenceExportReplayResultJsonSchema` | yes | yes | equivalent |  |
| `evidence-export-request.v1.json` | `EvidenceExportRequestSchema`, `parseEvidenceExportRequest`, `evidenceExportRequestJsonSchema` | yes | yes | equivalent |  |
| `evidence-export.v1.json` | `EvidenceExportSchema`, `parseEvidenceExport`, `evidenceExportJsonSchema` | yes | yes | equivalent |  |
| `evidence-manifest.v1.json` | `EvidenceManifestSchema`, `parseEvidenceManifest`, `evidenceManifestJsonSchema` | yes | yes | equivalent |  |
| `evidence-manifest.v2.json` | `EvidenceManifestV2Schema`, `parseEvidenceManifestV2`, `evidenceManifestV2JsonSchema` | yes | — | equivalent |  |
| `evidence-manifest.v3.json` | `EvidenceManifestV3Schema`, `parseEvidenceManifestV3`, `evidenceManifestV3JsonSchema` | yes | — | equivalent |  |
| `evidence-manifest.v4.json` | `EvidenceManifestV4Schema`, `parseEvidenceManifestV4`, `evidenceManifestV4JsonSchema` | — | — | equivalent |  |
| `evidence-manifest.v5.json` | `EvidenceManifestV5Schema`, `parseEvidenceManifestV5`, `evidenceManifestV5JsonSchema` | — | — | equivalent |  |
| `evidence-provider-manifest.v1.json` | `EvidenceProviderManifestSchema`, `parseEvidenceProviderManifest`, `evidenceProviderManifestJsonSchema` | yes | yes | equivalent |  |
| `qualification-execution-request.v1.json` | `QualificationExecutionRequestSchema`, `qualificationExecutionRequestJsonSchema` | yes | yes | partial | Zod refinements on relative paths, absolute runtime paths and environment names are not representable in the JSON Schema. |
| `qualification-plan.v1.json` | `QualificationPlanSchema`, `parseQualificationPlan`, `qualificationPlanJsonSchema` | yes | yes | partial | Zod refinements on relative paths, absolute runtime paths and environment names are not representable in the JSON Schema. |
| `qualification-receipt.v1.json` | `QualificationReceiptSchema`, `qualificationReceiptJsonSchema` | yes | yes | partial | Zod refinements on relative paths, absolute runtime paths and environment names are not representable in the JSON Schema. |
| `qualification-replay-result.v1.json` | `QualificationReplayResultSchema`, `qualificationReplayResultJsonSchema` | yes | yes | equivalent |  |
| `replay-result.v1.json` | `ReplayResultSchema`, `parseReplayResult`, `replayResultJsonSchema` | yes | yes | equivalent |  |
| `repository-analysis.v1.json` | `RepositoryAnalysisSchema`, `parseRepositoryAnalysis`, `repositoryAnalysisJsonSchema` | yes | yes | equivalent |  |
| `repository-audit.v1.json` | `RepositoryAuditSchema`, `parseRepositoryAudit`, `repositoryAuditJsonSchema` | yes | — | equivalent |  |
| `repository-audit.v2.json` | `RepositoryAuditV2Schema`, `parseRepositoryAuditV2`, `repositoryAuditV2JsonSchema` | yes | — | equivalent |  |
| `repository-init-config.v1.json` | `RepositoryInitConfigSchema`, `parseRepositoryInitConfig`, `repositoryInitConfigJsonSchema` | yes | — | equivalent |  |
| `repository-init-config.v2.json` | `RepositoryInitConfigV2Schema`, `parseRepositoryInitConfigV2`, `repositoryInitConfigV2JsonSchema` | yes | — | equivalent |  |
| `repository-init-lock.v1.json` | `RepositoryInitLockSchema`, `parseRepositoryInitLock`, `repositoryInitLockJsonSchema` | yes | — | equivalent |  |
| `repository-init-lock.v2.json` | `RepositoryInitLockV2Schema`, `parseRepositoryInitLockV2`, `repositoryInitLockV2JsonSchema` | yes | — | equivalent |  |
| `repository-init-result.v1.json` | `RepositoryInitResultSchema`, `parseRepositoryInitResult`, `repositoryInitResultJsonSchema` | yes | — | equivalent |  |
| `repository-init-result.v2.json` | `RepositoryInitResultV2Schema`, `parseRepositoryInitResultV2`, `repositoryInitResultV2JsonSchema` | yes | — | equivalent |  |
| `verification-request.v1.json` | `VerificationRequestSchema`, `parseVerificationRequest`, `verificationRequestJsonSchema` | yes | yes | equivalent |  |
| `verification-request.v2.json` | `VerificationRequestV2Schema`, `parseVerificationRequestV2`, `verificationRequestV2JsonSchema` | yes | — | equivalent |  |
| `verification-request.v3.json` | `VerificationRequestV3Schema`, `parseVerificationRequestV3`, `verificationRequestV3JsonSchema` | yes | — | equivalent |  |
| `verification-request.v4.json` | `VerificationRequestV4Schema`, `parseVerificationRequestV4`, `verificationRequestV4JsonSchema` | — | — | equivalent |  |
| `verification-request.v5.json` | `VerificationRequestV5Schema`, `parseVerificationRequestV5`, `verificationRequestV5JsonSchema` | — | — | equivalent |  |
| `witness-import-request.v1.json` | `WitnessImportRequestSchema`, `parseWitnessImportRequest`, `witnessImportRequestJsonSchema` | — | — | equivalent |  |
| `witness-import-request.v2.json` | `WitnessImportRequestV2Schema`, `parseWitnessImportRequestV2`, `witnessImportRequestV2JsonSchema` | — | — | equivalent |  |

Versioned parsers dispatch on `schemaVersion` across the published versions:

| Export | Published schemas | Status |
| --- | --- | --- |
| `parseVersionedEvidenceManifest` | `evidence-manifest.v1.json`, `evidence-manifest.v2.json`, `evidence-manifest.v3.json`, `evidence-manifest.v4.json`, `evidence-manifest.v5.json` | equivalent |
| `parseVersionedRepositoryInitConfig` | `repository-init-config.v1.json`, `repository-init-config.v2.json` | equivalent |
| `parseVersionedRepositoryInitLock` | `repository-init-lock.v1.json`, `repository-init-lock.v2.json` | equivalent |
| `parseVersionedRepositoryInitResult` | `repository-init-result.v1.json`, `repository-init-result.v2.json` | equivalent |
| `parseVersionedRuntimeDoctorResult` | none published | partial |
| `parseVersionedVerificationRequest` | `verification-request.v1.json`, `verification-request.v2.json`, `verification-request.v3.json`, `verification-request.v4.json`, `verification-request.v5.json` | equivalent |
| `parseVersionedWitnessImportRequest` | `witness-import-request.v1.json`, `witness-import-request.v2.json` | equivalent |

Document contracts that have a parser but no published schema. A command or tool produces or
reads the document; no file in `schemas/` describes it:

| Exports | Status | Note |
| --- | --- | --- |
| `parseAgenticCorpusCase` | partial | Read from corpus case files by `corpus-status`, the `corpus-evaluate-*` commands and provenance replay. |
| `parseAgenticCorpusExperimentReceipt`, `AgenticCorpusExperimentReceiptSchema` | partial | Read only inside `corpus-experiment-replay`. |
| `parseAgenticCorpusExperimentStructuredResult`, `AgenticCorpusExperimentStructuredResultSchema` | partial | Read only inside `corpus-experiment-replay`. |
| `parseRuntimeDoctorResult`, `RuntimeDoctorResultSchema` | partial | Returned by `doctor --runtime`; `assertledger_doctor_runtime` declares it as its MCP output schema. |
| `parseRuntimeDoctorResultV2`, `RuntimeDoctorResultV2Schema` | partial | Same, version 2. |

## Workflow functions

Module functions that run a command, or one step of it.

| Function | Equivalent | Status | Note |
| --- | --- | --- | --- |
| `acquireAgenticBenchmark` | `benchmark-acquire` | equivalent | Same path as `acquireBenchmark`. |
| `admitQualificationCi` | `qualification-ci` | equivalent |  |
| `analyzeRepository` | `analyze` | partial | The command fixes `configuredExcludes: true`. |
| `auditRepository` | `audit` | partial | As `audit`, without the callback. |
| `createAgenticBenchmark`† | `benchmark` | equivalent |  |
| `createAgenticCorpusAllocation`† | `corpus-allocate` | equivalent |  |
| `createAgenticCorpusExperimentArtifact`† | — | none | As `corpusExperiment`. |
| `createAgenticProfile`† | `profile` | equivalent | Conformance operation `CREATE_PROFILE_V1`. |
| `createAgenticProfileV2`† | `profile-v2` | equivalent |  |
| `createAssertLedgerServer` | `mcp [--root] [--allow-unsafe-execution]` | partial | The process serves stdio only; no in-process server object. |
| `createTestForgeServer` | `mcp` | partial | Alias of `createAssertLedgerServer`. |
| `createEvidenceExport`† | `export` | equivalent |  |
| `createEvidenceProviderManifest`† | `provider` | partial | The command describes this package only; arbitrary inputs are not accepted. |
| `createQualificationReceipt` | `qualify` | partial | Reached only as the last step of an executed qualification. |
| `decideEvidence`† | — | none | Conformance operation `DECIDE_EVIDENCE`; reached only inside `verify` and `check`. |
| `doctorRepositoryRuntime` | `doctor --runtime` | equivalent |  |
| `evaluateAgenticCorpusHoldout` | `corpus-evaluate-holdout` | equivalent |  |
| `evaluateAgenticCorpusPublic` | `corpus-evaluate-public` | equivalent |  |
| `explainReasonCodes` | `explain --json` | equivalent |  |
| `renderDiagnostics` | `explain` (text) | equivalent |  |
| `initializeRepository` | `init` | partial | As `init`, without the callbacks. |
| `inspectAgenticCorpus` | `corpus-status` | equivalent |  |
| `qualifyGitRegression` | `check --allow-unsafe-execution` | equivalent |  |
| `qualifyOrchestration` | `qualify` | equivalent |  |
| `replayAgenticBenchmark`† | `benchmark-replay` | equivalent | Conformance operation `REPLAY_BENCHMARK_V1`. |
| `replayAgenticBenchmarkAcquisition`† | `benchmark-acquire-replay` | equivalent |  |
| `replayAgenticCorpusAllocation`† | `corpus-allocation-replay` | equivalent |  |
| `replayAgenticCorpusAllocationCommitment`† | — | none | As `replayCorpusAllocationCommitment`. |
| `replayAgenticCorpusExperimentArtifact`† | `corpus-experiment-replay` | equivalent |  |
| `replayAgenticCorpusExperimentPlan`† | — | none | Reached only inside `corpus-experiment-replay`. |
| `replayAgenticCorpusProvenance` | — | none | Reached only inside `corpus-experiment-replay`. |
| `replayAgenticProfile`† | `profile-replay` | equivalent |  |
| `replayAgenticProfileV2`† | `profile-v2-replay` | equivalent |  |
| `replayEvidenceExport`† | `export-replay` | equivalent |  |
| `replayEvidenceManifest`† | `replay` | equivalent | Conformance operation `REPLAY_EVIDENCE`. |
| `replayQualificationReceipt` | `qualification-replay` | equivalent |  |
| `sealQualificationPlan` | `qualification-plan` | equivalent |  |
| `verifyCampaign` | `verify` | equivalent |  |
| `verifyManifestIntegrity`† | `replay` | partial | Its digest checks are fields of the `replay` result. |
| `verifyDecisionDigest`† | `replay` | partial | `decisionDigestValid` in the `replay` result. |
| `verifyQualificationCiObservation` | `qualify` | partial | Reached only inside receipt creation. |
| `verifyAgenticCorpusAllocationCommitmentSignatures` | — | none | Reached only inside `corpus-experiment-replay`. |
| `resolveAgenticCorpusExperimentEvidence`† | — | none | Reached only inside `corpus-experiment-replay`. |
| `selectCandidates`† | — | none | Reached only inside `decideEvidence`. |
| `sealManifestArtifact`† | — | none | Reached only inside evidence-producing commands. |
| `canonicalize`† | — | none | Conformance operation `CANONICALIZE`. |
| `sha256Canonical`† | — | none |  |
| `runProcess` | — | none | Engine process runner. |

48 functions: 26 equivalent, 10 partial, 12 none.

## Digest helpers and utilities

Status `none` for all 30. They compute a digest, signing bytes or a binding that commands embed in
their documents, or serve the engine internally:

`agenticCorpusAllocationCommitmentDigest`†, `agenticCorpusAllocationCommitmentSigningBytes`†, `agenticCorpusAllocationDigest`†, `agenticCorpusAllocationFinalSeedDigest`†, `agenticCorpusAllocationRevealDigest`†, `agenticCorpusAllocationShareCommitmentDigest`†, `agenticCorpusExperimentArtifactDigest`†, `agenticCorpusExperimentCandidateSetDigest`†, `agenticCorpusExperimentCommandDigest`†, `agenticCorpusExperimentPlanDigest`†, `agenticCorpusExperimentSelectedSuiteDigest`†, `agenticCorpusProvenanceDigest`, `agenticCorpusProvenanceProjection`, `agenticCorpusProvenanceSigningBytes`, `agenticCorpusTrustPolicyDigest`, `assertSafeRelativePath`†, `benchmarkCacheDirectoryKey`, `isRepositoryExcludeName`, `portablePathKey`†, `qualificationBinding`, `qualificationFileDigest`, `qualificationMechanismDigest`, `qualificationRepositoryDigest`, `qualificationToolDigest`, `quoteRepositoryEntry`, `renderRepositoryLinkRefusal`, `repositoryInitConfigDigest`, `repositoryInitConfigV2Digest`, `repositoryInitLockDigest`, `repositoryInitLockV2Digest`.

## Error classes

Status `partial` for all 5. A command reports the error as an exit code and a message on standard
error, an MCP tool as a JSON-RPC error; neither exposes the class. Whether those messages are
contractual is decided in D5.

`AgenticCorpusError`, `ContractError`, `EvidenceValidationError`, `RepositoryAuditInventoryError`, `RepositoryInitWriteError`.

## Constants

| Constant | Value | Status | Note |
| --- | --- | --- | --- |
| `AGENTIC_CORPUS_ALLOCATION_ALGORITHM`† | `SHA256_ASCENDING_SPLIT_V1` | equivalent | The value appears in a published schema. |
| `ORCHESTRATION_ADAPTER_VERSION` | `1.0.0` | equivalent | The value appears in a published schema. |
| `POLICY_VERSION` | `1.0.0` | equivalent | The value appears in a published schema. |
| `REPOSITORY_INIT_SCHEMA_VERSION_V2` | `2.0.0` | equivalent | The value appears in a published schema. |
| `SCHEMA_VERSION` | `1.0.0` | equivalent | The value appears in a published schema. |
| `VERIFICATION_SCHEMA_VERSION_V2` | `2.0.0` | equivalent | The value appears in a published schema. |
| `VERIFICATION_SCHEMA_VERSION_V3` | `3.0.0` | equivalent | The value appears in a published schema. |
| `VERIFICATION_SCHEMA_VERSION_V4` | `4.0.0` | equivalent | The value appears in a published schema. |
| `VERIFICATION_SCHEMA_VERSION_V5` | `5.0.0` | equivalent | The value appears in a published schema. |

## Schema components

Status `partial` for all 57. Zod schemas and data constants for documents or parts of documents;
none has a file in `schemas/`. Three describe a whole command input or output, and the MCP server
declares them in its tool schemas: `DiagnosticReportSchema` (output of `explain --json`), `QualificationExpectedDomainSchema` (input of `qualification-replay --domain`), `QualificationCiObservationSchema` (input of `qualification-ci --observation`).

`AdapterSchema`, `AdapterV3Schema`, `AdapterV4Schema`, `AdapterV5Schema`, `AgenticBenchmarkFingerprintSchema`, `AgenticBenchmarkPolicySchema`, `AgenticBenchmarkProtocolSchema`, `AgenticBenchmarkRunSchema`, `AgenticProfileCostBasisV2Schema`, `AgenticProfileLaneSchema`, `AgenticProfileLaneV2Schema`, `AgenticProfilePolicySchema`, `AgenticProfilePolicyV2Schema`, `BudgetsSchema`, `BunDesignatedTestAdapterSchema`, `BunDesignatedTestAdapterV5Schema`, `BunTestAdapterSchema`, `CandidateAssessmentSchema`, `CandidateSchema`, `CandidateV4Schema`, `ContainerImageReferenceSchema`, `ContainerIsolationSchema`, `ContainerLimitsSchema`, `DesignatedCandidateSchema`, `DesignatedTestSchema`, `DiagnosticCodesSchema`, `DiagnosticReportSchema`, `EvidenceObservationSchema`, `FileOverlaySchema`, `GateResultSchema`, `NodeTestAdapterSchema`, `ObservationOutcomeSchema`, `PolicySchema`, `QUALIFICATION_ADAPTER_VERSIONS`, `QUALIFICATION_SNAPSHOT_EXCLUDES`, `QualificationAssessmentSchema`, `QualificationCiObservationSchema`, `QualificationExpectedDomainSchema`, `QualificationJsonSchema`, `QualificationObservationSchema`, `QualificationProvenanceSchema`, `QualificationRuntimeSchema`, `RepositoryGitModeSchema`, `RepositoryInitDetectionsSchema`, `RepositoryInitDetectionsV2Schema`, `RepositorySnapshotScopeSchema`, `RepositoryV5Schema`, `RuntimeDoctorCheckSchema`, `RuntimeDoctorCheckV2Schema`, `RuntimeDoctorReasonCodeSchema`, `RuntimeDoctorReasonCodeV2Schema`, `StructuredCommandAdapterSchema`, `StructuredCommandSchema`, `TrustedLocalIsolationSchema`, `TrustedMatcherSourceSchema`, `WindowsNativeIsolationSchema`, `WorldSchema`.

## `./bun`

| Export | Status | Note |
| --- | --- | --- |
| `assertSame` | none | Replaced by Bun's native `expect` matchers ([ADR 0004](decisions/0004-bun-native-matcher-attribution.md)). |
| `isAssertSameFailure` | none | Same. |

## Gaps

ADR 0003 blocks the last 2.x release on a public method without an equivalent. These have status
`none`; each needs a command, or a decision that removes it from the public surface:

- methods: `corpusExperiment`, `replayCorpusAllocationCommitment`;
- workflow functions: `createAgenticCorpusExperimentArtifact`, `decideEvidence`, `replayAgenticCorpusAllocationCommitment`, `replayAgenticCorpusExperimentPlan`, `replayAgenticCorpusProvenance`, `verifyAgenticCorpusAllocationCommitmentSignatures`, `resolveAgenticCorpusExperimentEvidence`, `selectCandidates`, `sealManifestArtifact`, `canonicalize`, `sha256Canonical`, `runProcess`;
- the 30 digest helpers and utilities, and `./bun`.

The scope of `assertledger core <op>` is decided in D11; the conformance bundle names six
operations, of which `CANONICALIZE` and `DECIDE_EVIDENCE` have no command today. Closing the gaps
is E10.

## Regenerating

This page is generated from the built package. It refuses an export it cannot classify:

```sh
pnpm build
node scripts/sdk-surface-map.mjs . docs/sdk-surface-map.md
```
