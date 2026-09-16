import { readFile } from "node:fs/promises";
import { AssertLedger } from "assertledger";

// A minimal external consumer. It applies its own obligations to an AssertLedger evidence export
// and writes nothing back: AssertLedger results stay the same whatever it decides.
const exportPath = process.argv[2];
if (exportPath === undefined) {
  console.error("Usage: node consumer.mjs <evidence-export.json>");
  process.exitCode = 64;
} else {
  const evidence = JSON.parse(await readFile(exportPath, "utf8"));
  const replay = new AssertLedger().replayEvidenceExport(evidence);
  const reasons = [];
  let decision;
  if (!replay.valid) {
    decision = "REJECT";
    reasons.push("EXPORT_REPLAY_INVALID");
  } else if (evidence.result.detection !== "OBSERVED") {
    decision = "IGNORE";
    reasons.push(`DETECTION_${evidence.result.detection}`);
  } else {
    const required = ["CONTROL_WITHOUT_CANDIDATE", "REFERENCE_PASS", "NEUTRAL_PASS"];
    for (const control of required) {
      const executed = evidence.controls.executed.find((item) => item.control === control);
      if (executed?.status !== "EXECUTED") reasons.push(`CONTROL_NOT_EXECUTED_${control}`);
    }
    if (evidence.scope.gitRevisions !== "RECORDED") reasons.push("GIT_REVISIONS_NOT_RECORDED");
    if (evidence.authenticity.status !== "ATTESTED") reasons.push("EVIDENCE_UNAUTHENTICATED");
    // This consumer admits unauthenticated local evidence only as advisory.
    decision = reasons.length === 0 ? "ACCEPT" : "DEGRADE";
  }
  process.stdout.write(
    `${JSON.stringify({ decision, reasons, sourceArtifactDigest: evidence.sourceArtifactDigest ?? null })}\n`,
  );
}
