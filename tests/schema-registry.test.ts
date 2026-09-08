import assert from "node:assert/strict";
import { it } from "node:test";
import { publishedSchemas } from "../scripts/schema-registry.js";

it("checks every generated public schema for staleness", () => {
  assert.deepEqual(
    publishedSchemas().map(([filename]) => filename),
    [
      "agentic-corpus-trust-policy.v1.json",
      "agentic-corpus-provenance.v1.json",
      "agentic-benchmark-request.v1.json",
      "agentic-benchmark-artifact.v1.json",
      "agentic-benchmark-replay-result.v1.json",
      "agentic-benchmark-acquisition-request.v1.json",
      "agentic-benchmark-acquisition-result.v1.json",
      "agentic-benchmark-acquisition-replay-result.v1.json",
      "agentic-profile-request.v1.json",
      "agentic-profile-report.v1.json",
      "agentic-profile-replay-result.v1.json",
      "agentic-profile-request.v2.json",
      "agentic-profile-report.v2.json",
      "agentic-profile-replay-result.v2.json",
      "verification-request.v1.json",
      "repository-analysis.v1.json",
      "repository-audit.v1.json",
      "repository-init-config.v1.json",
      "repository-init-lock.v1.json",
      "repository-init-result.v1.json",
      "evidence-manifest.v1.json",
      "replay-result.v1.json",
      "agentic-corpus-allocation-request.v1.json",
      "agentic-corpus-allocation.v1.json",
      "agentic-corpus-allocation-replay-result.v1.json",
      "agentic-corpus-allocation-commitment.v1.json",
      "agentic-corpus-allocation-reveal.v1.json",
      "agentic-corpus-allocation-commitment-replay-result.v1.json",
      "agentic-corpus-experiment-plan.v1.json",
      "agentic-corpus-experiment-plan-replay-result.v1.json",
      "agentic-corpus-experiment-request.v1.json",
      "agentic-corpus-experiment-artifact.v1.json",
      "agentic-corpus-experiment-replay-request.v1.json",
      "agentic-corpus-experiment-replay-result.v1.json",
    ],
  );
});
