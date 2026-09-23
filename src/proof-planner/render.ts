import type { AssurancePlan, EvidenceRequirement } from "./plan.js";

function scope(requirement: EvidenceRequirement): string {
  return requirement.surfaces.length > 0 ? ` [${requirement.surfaces.join(", ")}]` : "";
}

function requirementLine(requirement: EvidenceRequirement): string {
  return `  - ${requirement.kind} (${requirement.binding})${scope(requirement)} <- ${requirement.because.join(", ")}`;
}

/** Human-readable view of a plan. The JSON plan stays the authoritative, machine-readable form. */
export function renderAssurancePlan(plan: AssurancePlan): string {
  const lines: string[] = [];
  lines.push(
    `AssurancePlan ${plan.level} ${plan.status} - revision ${plan.subject.revision} (baseline ${plan.subject.baseline})`,
  );
  lines.push(
    `policy ${plan.policy.id}@${plan.policy.version}; impact ${plan.impactBound}; ${plan.levelBySubject.map((entry) => `${entry.subject} ${entry.level}`).join(", ")}`,
  );
  lines.push("");
  lines.push("WHY");
  for (const decision of plan.rationale) {
    if (decision.step === "floor" && decision.fact && decision.level) {
      lines.push(`  - floor ${decision.level} ${decision.fact}: ${decision.detail}`);
    } else if (decision.step === "raise" && decision.fact) {
      lines.push(`  - raise ${decision.fact}: ${decision.detail}`);
    } else if (decision.step !== "floor" && decision.step !== "raise") {
      lines.push(`  - ${decision.step}: ${decision.detail}`);
    }
  }
  lines.push("");
  lines.push("REQUIRED");
  for (const requirement of plan.requiredEvidence) lines.push(requirementLine(requirement));
  if (plan.recommendedEvidence.length > 0) {
    lines.push("");
    lines.push("RECOMMENDED");
    for (const requirement of plan.recommendedEvidence) lines.push(requirementLine(requirement));
  }
  const heavy = plan.explicitlyNotRequired.filter(
    (entry) => entry.requirement.weight !== "targeted",
  );
  const light = plan.explicitlyNotRequired.filter(
    (entry) => entry.requirement.weight === "targeted",
  );
  if (plan.explicitlyNotRequired.length > 0) {
    lines.push("");
    lines.push("NOT REQUIRED");
    for (const entry of heavy) lines.push(`  - ${entry.requirement.kind}: ${entry.rationale}`);
    if (light.length > 0) {
      lines.push(
        `  - targeted, not triggered: ${light.map((entry) => entry.requirement.kind).join(", ")}`,
      );
    }
  }
  if (plan.undeterminedEvidence.length > 0) {
    lines.push("");
    lines.push("UNDETERMINED");
    for (const entry of plan.undeterminedEvidence) {
      lines.push(`  - ${entry.requirement.kind}: ${entry.rationale}`);
    }
  }
  lines.push("");
  lines.push("ESCALATE IF");
  for (const escalation of plan.escalations) {
    lines.push(`  - ${escalation.signal} (${escalation.variant}): ${escalation.rationale}`);
  }
  if (plan.signals.length > 0) {
    lines.push("");
    lines.push("SIGNALS");
    for (const signal of plan.signals) {
      lines.push(`  - ${signal.id} ${signal.signal} -> ${signal.classification}: ${signal.reason}`);
    }
  }
  if (plan.residualUncertainty.length > 0) {
    lines.push("");
    lines.push("RESIDUAL UNCERTAINTY");
    for (const entry of plan.residualUncertainty) lines.push(`  - ${entry.statement}`);
  }
  return `${lines.join("\n")}\n`;
}
