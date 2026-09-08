import { readFile } from "node:fs/promises";
import { AssertLedger } from "assertledger";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
  console.error("Usage: node profile-manifest.mjs <manifest.json> [profile-id]");
  process.exitCode = 64;
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const assertLedger = new AssertLedger();
  const report = assertLedger.profile({
    schemaVersion: "1.0.0",
    manifest,
    policy: {
      profileVersion: "1.0.0",
      profileId: process.argv[3] ?? "example/default",
      mode: "HARDENING",
      minimumTimingSamples: 3,
      lanes: [
        { id: "instant", maximumReferenceP95Ms: 2_000 },
        { id: "loop", maximumReferenceP95Ms: 10_000 },
        { id: "gate", maximumReferenceP95Ms: 60_000 },
      ],
    },
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === "QUALIFIED" ? 0 : 2;
}
