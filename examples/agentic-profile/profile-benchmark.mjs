import { readFile } from "node:fs/promises";
import { AssertLedger } from "../../dist/index.js";

const artifactPath = process.argv[2];
if (artifactPath === undefined) {
  throw new Error("Usage: node profile-benchmark.mjs <benchmark-artifact.json>");
}

const benchmarkArtifact = JSON.parse(await readFile(artifactPath, "utf8"));
const assertLedger = new AssertLedger();
const report = assertLedger.profileV2({
  schemaVersion: "2.0.0",
  benchmarkArtifact,
  policy: {
    profileVersion: "2.0.0",
    profileId: "example/hardening-v2",
    mode: "HARDENING",
    requiredComparisonScopeDigest: benchmarkArtifact.comparisonScopeDigest,
    costBasis: {
      regime: "WARM",
      measure: "WALL",
      aggregation: "TOTAL",
      statistic: "P95",
      unit: "MICROSECOND",
      portfolioAggregation: "SUM_OF_INDIVIDUAL_P95",
    },
    lanes: [
      { id: "instant", maximumWarmTotalWallP95Us: 2_000_000 },
      { id: "loop", maximumWarmTotalWallP95Us: 10_000_000 },
    ],
  },
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
