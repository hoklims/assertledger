import {
  type AgenticBenchmarkAcquisitionReplayResult,
  type AgenticBenchmarkAcquisitionResult,
  type AgenticBenchmarkArtifact,
  type AgenticBenchmarkReplayResult,
  type AgenticCorpusAllocation,
  type AgenticCorpusAllocationCommitmentReplayResult,
  type AgenticCorpusAllocationReplayResult,
  type AgenticCorpusExperimentArtifact,
  type AgenticCorpusExperimentReplayResult,
  type AgenticProfileReplayResult,
  type AgenticProfileReplayResultV2,
  type AgenticProfileReport,
  type AgenticProfileReportV2,
  agenticBenchmarkAcquisitionReplayResultJsonSchema,
  agenticBenchmarkAcquisitionRequestJsonSchema,
  agenticBenchmarkAcquisitionResultJsonSchema,
  agenticBenchmarkArtifactJsonSchema,
  agenticBenchmarkReplayResultJsonSchema,
  agenticBenchmarkRequestJsonSchema,
  agenticCorpusAllocationCommitmentJsonSchema,
  agenticCorpusAllocationCommitmentReplayResultJsonSchema,
  agenticCorpusAllocationJsonSchema,
  agenticCorpusAllocationReplayResultJsonSchema,
  agenticCorpusAllocationRequestJsonSchema,
  agenticCorpusAllocationRevealJsonSchema,
  agenticCorpusExperimentArtifactJsonSchema,
  agenticCorpusExperimentPlanJsonSchema,
  agenticCorpusExperimentPlanReplayResultJsonSchema,
  agenticCorpusExperimentReplayRequestJsonSchema,
  agenticCorpusExperimentReplayResultJsonSchema,
  agenticCorpusExperimentRequestJsonSchema,
  agenticProfileReplayResultJsonSchema,
  agenticProfileReplayResultV2JsonSchema,
  agenticProfileReportJsonSchema,
  agenticProfileReportV2JsonSchema,
  agenticProfileRequestJsonSchema,
  agenticProfileRequestV2JsonSchema,
  type EvidenceExport,
  type EvidenceExportReplayResult,
  type EvidenceManifestContract,
  type EvidenceManifestV2Contract,
  type EvidenceManifestV3Contract,
  type EvidenceProviderManifest,
  evidenceExportJsonSchema,
  evidenceExportReplayResultJsonSchema,
  evidenceExportRequestJsonSchema,
  evidenceManifestJsonSchema,
  evidenceManifestV2JsonSchema,
  evidenceManifestV3JsonSchema,
  evidenceProviderManifestJsonSchema,
  parseAgenticBenchmarkAcquisitionReplayResult,
  parseAgenticBenchmarkAcquisitionRequest,
  parseAgenticBenchmarkAcquisitionResult,
  parseAgenticBenchmarkArtifact,
  parseAgenticBenchmarkReplayResult,
  parseAgenticBenchmarkRequest,
  parseAgenticCorpusAllocation,
  parseAgenticCorpusAllocationCommitmentReplayResult,
  parseAgenticCorpusAllocationReplayResult,
  parseAgenticCorpusAllocationRequest,
  parseAgenticCorpusExperimentArtifact,
  parseAgenticCorpusExperimentPlan,
  parseAgenticCorpusExperimentReplayResult,
  parseAgenticCorpusExperimentRequest,
  parseAgenticProfileReplayResult,
  parseAgenticProfileReplayResultV2,
  parseAgenticProfileReport,
  parseAgenticProfileReportV2,
  parseAgenticProfileRequest,
  parseAgenticProfileRequestV2,
  parseEvidenceExport,
  parseEvidenceExportReplayResult,
  parseEvidenceExportRequest,
  parseEvidenceProviderManifest,
  parseReplayResult,
  parseRepositoryAnalysis,
  parseRepositoryAudit,
  parseVersionedRepositoryInitResult,
  parseEvidenceManifest,
  parseEvidenceManifestV2,
  parseEvidenceManifestV3,
  parseVerificationRequest,
  parseVerificationRequestV2,
  parseVerificationRequestV3,
  parseVersionedEvidenceManifest,
  type ReplayResult,
  type RepositoryAnalysis,
  type RepositoryAudit,
  type RepositoryInitResult,
  type RepositoryInitResultV2,
  replayResultJsonSchema,
  repositoryAnalysisJsonSchema,
  repositoryAuditJsonSchema,
  repositoryInitConfigJsonSchema,
  repositoryInitConfigV2JsonSchema,
  repositoryInitLockJsonSchema,
  repositoryInitLockV2JsonSchema,
  repositoryInitResultJsonSchema,
  repositoryInitResultV2JsonSchema,
  verificationRequestJsonSchema,
  verificationRequestV2JsonSchema,
  verificationRequestV3JsonSchema,
} from "../contracts/index.js";
import {
  parseVersionedRuntimeDoctorResult,
  type RuntimeDoctorResult,
  type RuntimeDoctorResultV2,
} from "../contracts/runtime-doctor.js";
import { ASSERTLEDGER_SOURCE_REVISION } from "../build-info.js";
import {
  type AgenticCorpusExperimentReplayDependencies,
  createAgenticBenchmark,
  createAgenticCorpusAllocation,
  createAgenticCorpusExperimentArtifact,
  createAgenticProfile,
  createAgenticProfileV2,
  createEvidenceExport,
  createEvidenceProviderManifest,
  replayAgenticBenchmark,
  replayAgenticBenchmarkAcquisition,
  replayAgenticCorpusAllocation,
  replayAgenticCorpusAllocationCommitment,
  replayAgenticCorpusExperimentArtifact,
  replayAgenticProfile,
  replayAgenticProfileV2,
  replayEvidenceExport,
  replayEvidenceManifest,
} from "../core/index.js";
import { explainReasonCodes } from "../diagnostics.js";
import { NODE_TEST_ADAPTER_PROFILE } from "../engine/adapters/node-test-profile.js";
import {
  type GitRegressionOptions,
  type GitRegressionV2Options,
  qualifyGitRegression,
  qualifyGitRegressionV2,
} from "../engine/git-regression.js";
import {
  acquireAgenticBenchmark,
  analyzeRepository,
  auditRepository,
  doctorRepositoryRuntime,
  initializeRepository,
  type RepositoryAuditOptions,
  type RepositoryInitOptions,
  type RuntimeDoctorOptions,
  type VerifyCampaignOptions,
  verifyCampaign,
} from "../engine/index.js";
import {
  replayAgenticCorpusProvenance,
  verifyAgenticCorpusAllocationCommitmentSignatures,
} from "../evaluation/agentic-corpus.js";
import { ASSERTLEDGER_VERSION } from "../version.js";

export type SchemaName =
  | "agentic-corpus-allocation-request"
  | "agentic-corpus-allocation"
  | "agentic-corpus-allocation-replay-result"
  | "agentic-corpus-allocation-commitment"
  | "agentic-corpus-allocation-reveal"
  | "agentic-corpus-allocation-commitment-replay-result"
  | "agentic-corpus-experiment-plan"
  | "agentic-corpus-experiment-plan-replay-result"
  | "agentic-corpus-experiment-request"
  | "agentic-corpus-experiment-artifact"
  | "agentic-corpus-experiment-replay-request"
  | "agentic-corpus-experiment-replay-result"
  | "agentic-benchmark-request"
  | "agentic-benchmark-artifact"
  | "agentic-benchmark-replay-result"
  | "agentic-benchmark-acquisition-request"
  | "agentic-benchmark-acquisition-result"
  | "agentic-benchmark-acquisition-replay-result"
  | "agentic-profile-request"
  | "agentic-profile-report"
  | "agentic-profile-replay-result"
  | "agentic-profile-request-v2"
  | "agentic-profile-report-v2"
  | "agentic-profile-replay-result-v2"
  | "verification-request"
  | "verification-request-v2"
  | "verification-request-v3"
  | "repository-analysis"
  | "repository-audit"
  | "repository-init-config"
  | "repository-init-config-v2"
  | "repository-init-lock"
  | "repository-init-lock-v2"
  | "repository-init-result"
  | "repository-init-result-v2"
  | "evidence-manifest"
  | "evidence-manifest-v2"
  | "evidence-manifest-v3"
  | "replay-result"
  | "evidence-provider-manifest"
  | "evidence-export-request"
  | "evidence-export"
  | "evidence-export-replay-result";

export type AgenticCorpusExperimentReplayOptions = Omit<
  AgenticCorpusExperimentReplayDependencies,
  "replayProvenance" | "verifyCommitmentSignatures"
>;

/** Provider-neutral programmatic facade over AssertLedger's deterministic components. */
export class AssertLedger {
  explain(codes: readonly string[]) {
    return explainReasonCodes(codes);
  }

  async analyze(root: string): Promise<RepositoryAnalysis> {
    return parseRepositoryAnalysis(await analyzeRepository(root, { configuredExcludes: true }));
  }

  async audit(root: string, options: RepositoryAuditOptions = {}): Promise<RepositoryAudit> {
    return parseRepositoryAudit(await auditRepository(root, options));
  }

  async init(
    root: string,
    options: RepositoryInitOptions = {},
  ): Promise<RepositoryInitResult | RepositoryInitResultV2> {
    return parseVersionedRepositoryInitResult(await initializeRepository(root, options));
  }

  async doctor(
    root: string,
    options: Pick<RepositoryInitOptions, "exclude" | "framework"> = {},
  ): Promise<RepositoryInitResult | RepositoryInitResultV2> {
    return this.init(root, { ...options, dryRun: true });
  }

  async doctorRuntime(
    root: string,
    options: RuntimeDoctorOptions,
  ): Promise<RuntimeDoctorResult | RuntimeDoctorResultV2> {
    return parseVersionedRuntimeDoctorResult(await doctorRepositoryRuntime(root, options));
  }

  async verify(request: unknown): Promise<EvidenceManifestContract> {
    return parseEvidenceManifest(await verifyCampaign(parseVerificationRequest(request)));
  }

  /**
   * Executes a v2 campaign. A container request runs through the operator-owned runtime command in
   * `options`; the request itself can never select a host executable.
   */
  async verifyV2(
    request: unknown,
    options: VerifyCampaignOptions = {},
  ): Promise<EvidenceManifestV2Contract> {
    return parseEvidenceManifestV2(
      await verifyCampaign(parseVerificationRequestV2(request), options),
    );
  }

  async verifyV3(
    request: unknown,
    options: VerifyCampaignOptions = {},
  ): Promise<EvidenceManifestV3Contract> {
    return parseEvidenceManifestV3(
      await verifyCampaign(parseVerificationRequestV3(request), options),
    );
  }

  async checkGitRegression(options: GitRegressionOptions): Promise<EvidenceManifestContract> {
    return qualifyGitRegression(options);
  }

  /** Qualifies a committed regression inside digest-pinned containers and returns v2 evidence. */
  async checkGitRegressionV2(options: GitRegressionV2Options): Promise<EvidenceManifestV2Contract> {
    return qualifyGitRegressionV2(options);
  }

  replay(manifest: unknown): ReplayResult {
    let parsedManifest:
      | EvidenceManifestContract
      | EvidenceManifestV2Contract
      | EvidenceManifestV3Contract;
    try {
      parsedManifest = parseVersionedEvidenceManifest(manifest);
    } catch {
      return parseReplayResult({
        valid: false,
        schemaValid: false,
        decisionDigestValid: false,
        artifactDigestValid: false,
        decisionSemanticsValid: false,
      });
    }
    return parseReplayResult({ ...replayEvidenceManifest(parsedManifest), schemaValid: true });
  }

  profile(request: unknown): AgenticProfileReport {
    return parseAgenticProfileReport(createAgenticProfile(parseAgenticProfileRequest(request)));
  }

  replayProfile(report: unknown): AgenticProfileReplayResult {
    try {
      return parseAgenticProfileReplayResult(
        replayAgenticProfile(parseAgenticProfileReport(report)),
      );
    } catch {
      return parseAgenticProfileReplayResult({
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        policyDigestValid: false,
        reportDigestValid: false,
        semanticsValid: false,
      });
    }
  }

  exportEvidence(request: unknown): EvidenceExport {
    return parseEvidenceExport(createEvidenceExport(parseEvidenceExportRequest(request)));
  }

  replayEvidenceExport(evidenceExport: unknown): EvidenceExportReplayResult {
    try {
      return parseEvidenceExportReplayResult(replayEvidenceExport(evidenceExport));
    } catch {
      return parseEvidenceExportReplayResult({
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        exportDigestValid: false,
        semanticsValid: false,
      });
    }
  }

  providerManifest(): EvidenceProviderManifest {
    return parseEvidenceProviderManifest(
      createEvidenceProviderManifest({
        version: ASSERTLEDGER_VERSION,
        sourceRevision: ASSERTLEDGER_SOURCE_REVISION,
        adapters: [
          {
            kind: "node-test",
            profileId: NODE_TEST_ADAPTER_PROFILE.profileId,
            profileVersion: NODE_TEST_ADAPTER_PROFILE.profileVersion,
            official: NODE_TEST_ADAPTER_PROFILE.official,
          },
          { kind: "testforge-command", profileId: null, profileVersion: null, official: false },
        ],
      }),
    );
  }

  benchmark(request: unknown): AgenticBenchmarkArtifact {
    return parseAgenticBenchmarkArtifact(
      createAgenticBenchmark(parseAgenticBenchmarkRequest(request)),
    );
  }

  replayBenchmark(artifact: unknown): AgenticBenchmarkReplayResult {
    try {
      return parseAgenticBenchmarkReplayResult(
        replayAgenticBenchmark(parseAgenticBenchmarkArtifact(artifact)),
      );
    } catch {
      return parseAgenticBenchmarkReplayResult({
        valid: false,
        schemaValid: false,
        sourceManifestValid: false,
        sourceBindingValid: false,
        policyDigestValid: false,
        protocolDigestValid: false,
        fingerprintDigestValid: false,
        comparisonScopeDigestValid: false,
        artifactDigestValid: false,
        summarySemanticsValid: false,
      });
    }
  }

  async acquireBenchmark(request: unknown): Promise<AgenticBenchmarkAcquisitionResult> {
    return parseAgenticBenchmarkAcquisitionResult(
      await acquireAgenticBenchmark(parseAgenticBenchmarkAcquisitionRequest(request)),
    );
  }

  replayBenchmarkAcquisition(result: unknown): AgenticBenchmarkAcquisitionReplayResult {
    return parseAgenticBenchmarkAcquisitionReplayResult(replayAgenticBenchmarkAcquisition(result));
  }

  profileV2(request: unknown): AgenticProfileReportV2 {
    return parseAgenticProfileReportV2(
      createAgenticProfileV2(parseAgenticProfileRequestV2(request)),
    );
  }

  replayProfileV2(report: unknown): AgenticProfileReplayResultV2 {
    try {
      return parseAgenticProfileReplayResultV2(
        replayAgenticProfileV2(parseAgenticProfileReportV2(report)),
      );
    } catch {
      return parseAgenticProfileReplayResultV2({
        valid: false,
        schemaValid: false,
        sourceBenchmarkValid: false,
        sourceBindingValid: false,
        policyDigestValid: false,
        reportDigestValid: false,
        semanticsValid: false,
      });
    }
  }

  allocateCorpus(request: unknown): AgenticCorpusAllocation {
    return parseAgenticCorpusAllocation(
      createAgenticCorpusAllocation(parseAgenticCorpusAllocationRequest(request)),
    );
  }

  replayCorpusAllocation(allocation: unknown): AgenticCorpusAllocationReplayResult {
    try {
      return parseAgenticCorpusAllocationReplayResult(
        replayAgenticCorpusAllocation(parseAgenticCorpusAllocation(allocation)),
      );
    } catch {
      return parseAgenticCorpusAllocationReplayResult({
        valid: false,
        schemaValid: false,
        allocationDigestValid: false,
        sourceCaseIdsValid: false,
        assignmentScoresValid: false,
        partitionSemanticsValid: false,
      });
    }
  }

  corpusExperiment(request: unknown, plan: unknown): AgenticCorpusExperimentArtifact {
    return parseAgenticCorpusExperimentArtifact(
      createAgenticCorpusExperimentArtifact(
        parseAgenticCorpusExperimentRequest(request),
        parseAgenticCorpusExperimentPlan(plan),
      ),
    );
  }

  replayCorpusExperiment(
    artifact: unknown,
    options: AgenticCorpusExperimentReplayOptions,
  ): AgenticCorpusExperimentReplayResult {
    return parseAgenticCorpusExperimentReplayResult(
      replayAgenticCorpusExperimentArtifact(
        { artifact },
        {
          ...options,
          replayProvenance: replayAgenticCorpusProvenance,
          verifyCommitmentSignatures: verifyAgenticCorpusAllocationCommitmentSignatures,
        },
      ),
    );
  }

  replayCorpusAllocationCommitment(
    input: Parameters<typeof replayAgenticCorpusAllocationCommitment>[0],
  ): AgenticCorpusAllocationCommitmentReplayResult {
    return parseAgenticCorpusAllocationCommitmentReplayResult(
      replayAgenticCorpusAllocationCommitment(input, {
        verifySignatures: verifyAgenticCorpusAllocationCommitmentSignatures,
      }),
    );
  }

  schema(name: SchemaName): Record<string, unknown> {
    switch (name) {
      case "agentic-corpus-allocation-request":
        return agenticCorpusAllocationRequestJsonSchema();
      case "agentic-corpus-allocation":
        return agenticCorpusAllocationJsonSchema();
      case "agentic-corpus-allocation-replay-result":
        return agenticCorpusAllocationReplayResultJsonSchema();
      case "agentic-corpus-allocation-commitment":
        return agenticCorpusAllocationCommitmentJsonSchema();
      case "agentic-corpus-allocation-reveal":
        return agenticCorpusAllocationRevealJsonSchema();
      case "agentic-corpus-allocation-commitment-replay-result":
        return agenticCorpusAllocationCommitmentReplayResultJsonSchema();
      case "agentic-corpus-experiment-plan":
        return agenticCorpusExperimentPlanJsonSchema();
      case "agentic-corpus-experiment-plan-replay-result":
        return agenticCorpusExperimentPlanReplayResultJsonSchema();
      case "agentic-corpus-experiment-request":
        return agenticCorpusExperimentRequestJsonSchema();
      case "agentic-corpus-experiment-artifact":
        return agenticCorpusExperimentArtifactJsonSchema();
      case "agentic-corpus-experiment-replay-request":
        return agenticCorpusExperimentReplayRequestJsonSchema();
      case "agentic-corpus-experiment-replay-result":
        return agenticCorpusExperimentReplayResultJsonSchema();
      case "agentic-benchmark-request":
        return agenticBenchmarkRequestJsonSchema();
      case "agentic-benchmark-artifact":
        return agenticBenchmarkArtifactJsonSchema();
      case "agentic-benchmark-replay-result":
        return agenticBenchmarkReplayResultJsonSchema();
      case "agentic-benchmark-acquisition-request":
        return agenticBenchmarkAcquisitionRequestJsonSchema();
      case "agentic-benchmark-acquisition-result":
        return agenticBenchmarkAcquisitionResultJsonSchema();
      case "agentic-benchmark-acquisition-replay-result":
        return agenticBenchmarkAcquisitionReplayResultJsonSchema();
      case "agentic-profile-request":
        return agenticProfileRequestJsonSchema();
      case "agentic-profile-report":
        return agenticProfileReportJsonSchema();
      case "agentic-profile-replay-result":
        return agenticProfileReplayResultJsonSchema();
      case "agentic-profile-request-v2":
        return agenticProfileRequestV2JsonSchema();
      case "agentic-profile-report-v2":
        return agenticProfileReportV2JsonSchema();
      case "agentic-profile-replay-result-v2":
        return agenticProfileReplayResultV2JsonSchema();
      case "verification-request":
        return verificationRequestJsonSchema();
      case "verification-request-v2":
        return verificationRequestV2JsonSchema();
      case "verification-request-v3":
        return verificationRequestV3JsonSchema();
      case "repository-analysis":
        return repositoryAnalysisJsonSchema();
      case "repository-audit":
        return repositoryAuditJsonSchema();
      case "repository-init-config":
        return repositoryInitConfigJsonSchema();
      case "repository-init-config-v2":
        return repositoryInitConfigV2JsonSchema();
      case "repository-init-lock":
        return repositoryInitLockJsonSchema();
      case "repository-init-lock-v2":
        return repositoryInitLockV2JsonSchema();
      case "repository-init-result":
        return repositoryInitResultJsonSchema();
      case "repository-init-result-v2":
        return repositoryInitResultV2JsonSchema();
      case "evidence-manifest":
        return evidenceManifestJsonSchema();
      case "evidence-manifest-v2":
        return evidenceManifestV2JsonSchema();
      case "evidence-manifest-v3":
        return evidenceManifestV3JsonSchema();
      case "replay-result":
        return replayResultJsonSchema();
      case "evidence-provider-manifest":
        return evidenceProviderManifestJsonSchema();
      case "evidence-export-request":
        return evidenceExportRequestJsonSchema();
      case "evidence-export":
        return evidenceExportJsonSchema();
      case "evidence-export-replay-result":
        return evidenceExportReplayResultJsonSchema();
    }
  }
}

/** @deprecated Use `AssertLedger`. Alias retained for v1 compatibility. */
export class TestForge extends AssertLedger {}

export { parseVerificationRequest, verificationRequestJsonSchema } from "../contracts/index.js";
export {
  createAgenticBenchmark,
  createAgenticCorpusAllocation,
  createAgenticCorpusExperimentArtifact,
  createAgenticProfile,
  createAgenticProfileV2,
  createEvidenceExport,
  createEvidenceProviderManifest,
  replayAgenticBenchmark,
  replayAgenticBenchmarkAcquisition,
  replayAgenticCorpusAllocation,
  replayAgenticCorpusExperimentArtifact,
  replayAgenticProfile,
  replayAgenticProfileV2,
  replayEvidenceExport,
  replayEvidenceManifest,
  verifyDecisionDigest,
  verifyManifestIntegrity,
} from "../core/index.js";
export type { GitRegressionOptions, GitRegressionV2Options } from "../engine/git-regression.js";
export { qualifyGitRegression } from "../engine/git-regression.js";
export type { RuntimeDoctorOptions } from "../engine/index.js";
export {
  acquireAgenticBenchmark,
  analyzeRepository,
  auditRepository,
  doctorRepositoryRuntime,
  initializeRepository,
  verifyCampaign,
} from "../engine/index.js";
