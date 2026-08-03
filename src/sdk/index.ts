import {
  type EvidenceManifestContract,
  evidenceManifestJsonSchema,
  parseEvidenceManifest,
  parseReplayResult,
  parseRepositoryAnalysis,
  parseVerificationRequest,
  type ReplayResult,
  type RepositoryAnalysis,
  replayResultJsonSchema,
  repositoryAnalysisJsonSchema,
  verificationRequestJsonSchema,
} from "../contracts/index.js";
import { replayEvidenceManifest } from "../core/index.js";
import { analyzeRepository, verifyCampaign } from "../engine/index.js";

export type SchemaName =
  | "verification-request"
  | "repository-analysis"
  | "evidence-manifest"
  | "replay-result";

/** Provider-neutral programmatic facade over TestForge's deterministic components. */
export class TestForge {
  async analyze(root: string): Promise<RepositoryAnalysis> {
    return parseRepositoryAnalysis(await analyzeRepository(root));
  }

  async verify(request: unknown): Promise<EvidenceManifestContract> {
    return parseEvidenceManifest(await verifyCampaign(parseVerificationRequest(request)));
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

  schema(name: SchemaName): Record<string, unknown> {
    switch (name) {
      case "verification-request":
        return verificationRequestJsonSchema();
      case "repository-analysis":
        return repositoryAnalysisJsonSchema();
      case "evidence-manifest":
        return evidenceManifestJsonSchema();
      case "replay-result":
        return replayResultJsonSchema();
    }
  }
}

export { parseVerificationRequest, verificationRequestJsonSchema } from "../contracts/index.js";
export {
  replayEvidenceManifest,
  verifyDecisionDigest,
  verifyManifestIntegrity,
} from "../core/index.js";
export { analyzeRepository, verifyCampaign } from "../engine/index.js";
