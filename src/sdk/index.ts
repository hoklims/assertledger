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
  type EvidenceManifestContract,
  evidenceManifestJsonSchema,
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
  parseEvidenceManifest,
  parseReplayResult,
  parseRepositoryAnalysis,
  parseRepositoryAudit,
  parseRepositoryInitResult,
  parseVerificationRequest,
  type ReplayResult,
  type RepositoryAnalysis,
  type RepositoryAudit,
  type RepositoryInitResult,
  replayResultJsonSchema,
  repositoryAnalysisJsonSchema,
  repositoryAuditJsonSchema,
  repositoryInitConfigJsonSchema,
  repositoryInitLockJsonSchema,
  repositoryInitResultJsonSchema,
  verificationRequestJsonSchema,
} from "../contracts/index.js";
import { parseRuntimeDoctorResult, type RuntimeDoctorResult } from "../contracts/runtime-doctor.js";
import {
  type AgenticCorpusExperimentReplayDependencies,
  createAgenticBenchmark,
  createAgenticCorpusAllocation,
  createAgenticCorpusExperimentArtifact,
  createAgenticProfile,
  createAgenticProfileV2,
  replayAgenticBenchmark,
  replayAgenticBenchmarkAcquisition,
  replayAgenticCorpusAllocation,
  replayAgenticCorpusAllocationCommitment,
  replayAgenticCorpusExperimentArtifact,
  replayAgenticProfile,
  replayAgenticProfileV2,
  replayEvidenceManifest,
} from "../core/index.js";
import { explainReasonCodes } from "../diagnostics.js";
import { type GitRegressionOptions, qualifyGitRegression } from "../engine/git-regression.js";
import {
  acquireAgenticBenchmark,
  analyzeRepository,
  auditRepository,
  doctorRepositoryRuntime,
  initializeRepository,
  type RepositoryAuditOptions,
  type RepositoryInitOptions,
  type RuntimeDoctorOptions,
  verifyCampaign,
} from "../engine/index.js";
import {
  replayAgenticCorpusProvenance,
  verifyAgenticCorpusAllocationCommitmentSignatures,
} from "../evaluation/agentic-corpus.js";

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
  | "repository-analysis"
  | "repository-audit"
  | "repository-init-config"
  | "repository-init-lock"
  | "repository-init-result"
  | "evidence-manifest"
  | "replay-result";

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
    return parseRepositoryAnalysis(await analyzeRepository(root));
  }

  async audit(root: string, options: RepositoryAuditOptions = {}): Promise<RepositoryAudit> {
    return parseRepositoryAudit(await auditRepository(root, options));
  }

  async init(root: string, options: RepositoryInitOptions = {}): Promise<RepositoryInitResult> {
    return parseRepositoryInitResult(await initializeRepository(root, options));
  }

  async doctor(root: string): Promise<RepositoryInitResult> {
    return this.init(root, { dryRun: true });
  }

  async doctorRuntime(root: string, options: RuntimeDoctorOptions): Promise<RuntimeDoctorResult> {
    return parseRuntimeDoctorResult(await doctorRepositoryRuntime(root, options));
  }

  async verify(request: unknown): Promise<EvidenceManifestContract> {
    return parseEvidenceManifest(await verifyCampaign(parseVerificationRequest(request)));
  }

  async checkGitRegression(options: GitRegressionOptions): Promise<EvidenceManifestContract> {
    return qualifyGitRegression(options);
  }

  replay(manifest: unknown): ReplayResult {
    let parsedManifest: EvidenceManifestContract;
    try {
      parsedManifest = parseEvidenceManifest(manifest);
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
      case "repository-analysis":
        return repositoryAnalysisJsonSchema();
      case "repository-audit":
        return repositoryAuditJsonSchema();
      case "repository-init-config":
        return repositoryInitConfigJsonSchema();
      case "repository-init-lock":
        return repositoryInitLockJsonSchema();
      case "repository-init-result":
        return repositoryInitResultJsonSchema();
      case "evidence-manifest":
        return evidenceManifestJsonSchema();
      case "replay-result":
        return replayResultJsonSchema();
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
  replayAgenticBenchmark,
  replayAgenticBenchmarkAcquisition,
  replayAgenticCorpusAllocation,
  replayAgenticCorpusExperimentArtifact,
  replayAgenticProfile,
  replayAgenticProfileV2,
  replayEvidenceManifest,
  verifyDecisionDigest,
  verifyManifestIntegrity,
} from "../core/index.js";
export type { GitRegressionOptions } from "../engine/git-regression.js";
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
