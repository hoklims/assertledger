import { createHash, createPublicKey, verify } from "node:crypto";
import {
  parseQualificationPlan,
  QUALIFICATION_ADAPTER_VERSIONS,
  QualificationObservationSchema,
  QualificationProvenanceSchema,
  QualificationCiObservationSchema,
  QualificationReceiptSchema,
  type QualificationObservation,
  type QualificationPlan,
  type QualificationReceipt,
  type QualificationReplayResult,
  type QualificationExpectedDomain,
} from "../contracts/qualification.js";
import { canonicalize, sha256Canonical } from "./index.js";

export function sealQualificationPlan(value: unknown): {
  plan: QualificationPlan;
  planDigest: string;
} {
  const plan = parseQualificationPlan(value);
  return { plan, planDigest: sha256Canonical(plan) };
}

export function qualificationBinding(
  planDigest: string,
  candidateDigest: string,
  worldId: string,
  attempt: number,
  actionId: string,
): string {
  return sha256Canonical({
    schemaVersion: "1.0.0",
    planDigest,
    candidateDigest,
    worldId,
    attempt,
    actionId,
  });
}

function fieldValue(facts: QualificationObservation["facts"], field: string): unknown {
  if (Object.hasOwn(facts, field)) return facts[field];
  let current: unknown = facts;
  for (const part of field.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matches(actual: unknown, expected: unknown): boolean {
  return actual !== undefined && canonicalize(actual) === canonicalize(expected);
}

function observationIssues(
  plan: QualificationPlan,
  planDigest: string,
  candidateDigest: string,
  observations: QualificationObservation[],
): string[] {
  const issues: string[] = [];
  const expected = new Set<string>();
  for (const world of plan.worlds)
    for (let attempt = 1; attempt <= plan.requiredAttempts; attempt++)
      for (const action of plan.actions) expected.add(`${world.id}/${attempt}/${action.id}`);
  const seen = new Set<string>();
  const reportNonces = new Set<string>();
  const terminalNonces = new Set<string>();
  for (const observation of observations) {
    const key = `${observation.worldId}/${observation.attempt}/${observation.actionId}`;
    if (!expected.has(key)) issues.push(`UNEXPECTED_OBSERVATION:${key}`);
    if (seen.has(key)) issues.push(`DUPLICATE_OBSERVATION:${key}`);
    seen.add(key);
    const action = plan.actions.find((item) => item.id === observation.actionId);
    if (observation.state === "COMPLETED") {
      const { report, reportNonce, reportDigest, reportProvenance, exitCode, commandOutcome } =
        observation.facts;
      const reportRequired =
        action?.observe.report !== null ||
        (action?.adapter === "command" && commandOutcome === "EXPECTED_FAILURE");
      const reportPresent = ["report", "reportNonce", "reportDigest", "reportProvenance"].some(
        (field) => Object.hasOwn(observation.facts, field),
      );
      if (reportRequired || reportPresent) {
        if (
          report === null ||
          typeof report !== "object" ||
          Array.isArray(report) ||
          typeof reportNonce !== "string" ||
          reportNonce.length === 0 ||
          reportProvenance !== "STRUCTURED_ADAPTER_REPORTED" ||
          reportDigest !==
            `sha256:${createHash("sha256")
              .update(
                `${canonicalize({ facts: report, nonce: reportNonce, protocolVersion: "1.0.0" })}\n`,
              )
              .digest("hex")}`
        ) {
          issues.push(`INVALID_STRUCTURED_REPORT:${key}`);
        } else {
          if (reportNonces.has(reportNonce)) issues.push(`DUPLICATE_REPORT_NONCE:${key}`);
          reportNonces.add(reportNonce);
          if (
            action?.adapter === "command" &&
            (exitCode !== 0 ||
              Object.hasOwn(report, "exitCode") ||
              Object.hasOwn(report, "commandOutcome")) &&
            (report.exitCode !== exitCode || report.commandOutcome !== commandOutcome)
          )
            issues.push(`CONTRADICTORY_COMMAND_REPORT:${key}`);
        }
      }
      if (action?.adapter === "turbo" && commandOutcome === "EXPECTED_FAILURE")
        issues.push(`UNSUPPORTED_TURBO_COMPLETION:${key}`);
    }
    if (
      observation.state === "COMPLETED" &&
      (typeof observation.facts.exitCode !== "number" ||
        !Number.isSafeInteger(observation.facts.exitCode) ||
        observation.facts.exitCode < 0)
    ) {
      issues.push(`CONTRADICTORY_PROCESS_FACTS:${key}`);
    }
    if (
      observation.state === "COMPLETED" &&
      (action?.adapter === "command" || action?.adapter === "turbo") &&
      Object.hasOwn(observation.facts, "commandOutcome")
    ) {
      const { commandOutcome, exitCode } = observation.facts;
      if (
        (commandOutcome !== "PASS" && commandOutcome !== "EXPECTED_FAILURE") ||
        (commandOutcome === "PASS" && exitCode !== 0) ||
        (commandOutcome === "EXPECTED_FAILURE" &&
          (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode <= 0))
      )
        issues.push(`CONTRADICTORY_COMMAND_FACTS:${key}`);
    }
    if (observation.state === "COMPLETED" && action?.adapter === "command") {
      const { terminal, terminalDigest, terminalProvenance, exitCode, reportNonce } =
        observation.facts;
      if (terminalProvenance === "PROCESS_EXIT_ZERO") {
        if (
          Object.keys(observation.facts).sort().join(",") !==
            "commandOutcome,exitCode,stderrDigest,stdoutDigest,terminalProvenance" ||
          exitCode !== 0 ||
          observation.facts.commandOutcome !== "PASS" ||
          ![observation.facts.stdoutDigest, observation.facts.stderrDigest].every(
            (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value),
          ) ||
          action.observe.trace ||
          action.observe.outputs.length !== 0 ||
          action.observe.report !== null ||
          plan.obligations
            .flatMap((item) => item.checks)
            .some(
              (check) =>
                check.actionId === action.id &&
                (check.field !== "exitCode" || check.expected !== 0),
            )
        )
          issues.push(`INVALID_OPAQUE_COMMAND_COMPLETION:${key}`);
      } else if (
        terminal === null ||
        typeof terminal !== "object" ||
        Array.isArray(terminal) ||
        Object.keys(terminal).sort().join(",") !==
          "exceptional,exitCode,explicit,natural,nonce,protocolVersion,ready,runtime,runtimeVersion" ||
        terminal.protocolVersion !== "1.0.0" ||
        terminal.ready !== true ||
        terminal.exceptional !== false ||
        typeof terminal.explicit !== "boolean" ||
        typeof terminal.natural !== "boolean" ||
        (!terminal.explicit && !terminal.natural) ||
        terminal.exitCode !== exitCode ||
        typeof terminal.nonce !== "string" ||
        terminal.nonce.length === 0 ||
        (reportNonce !== undefined && terminal.nonce !== reportNonce) ||
        (terminal.runtime !== "node" && terminal.runtime !== "bun") ||
        typeof terminal.runtimeVersion !== "string" ||
        terminal.runtimeVersion.length === 0 ||
        terminalProvenance !== "ENGINE_LIFECYCLE_OBSERVED" ||
        terminalDigest !==
          `sha256:${createHash("sha256")
            .update(`${canonicalize(terminal)}\n`)
            .digest("hex")}`
      )
        issues.push(`INVALID_COMMAND_TERMINAL:${key}`);
      else {
        if (terminalNonces.has(terminal.nonce as string))
          issues.push(`DUPLICATE_TERMINAL_NONCE:${key}`);
        terminalNonces.add(terminal.nonce as string);
      }
    }
    if (
      observation.state === "COMPLETED" &&
      (action?.adapter === "node-test" || action?.adapter === "bun-native")
    ) {
      const { testOutcome, exitCode, attributed, testsDiscovered } = observation.facts;
      if (
        (testOutcome !== "PASS" && testOutcome !== "ASSERTION_FAILURE") ||
        (testOutcome === "PASS" && exitCode !== 0) ||
        (testOutcome === "ASSERTION_FAILURE" &&
          (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode <= 0))
      )
        issues.push(`CONTRADICTORY_TEST_FACTS:${key}`);
      if (testOutcome === "ASSERTION_FAILURE" && attributed !== true)
        issues.push(`UNATTRIBUTED_TEST_ASSERTION:${key}`);
      const { assertionFailureFiles, testFiles } = observation.facts;
      const canonicalTestFiles =
        Array.isArray(testFiles) &&
        testFiles.length > 0 &&
        testFiles.every(
          (file) =>
            typeof file === "string" &&
            file.length > 0 &&
            !file.includes("\\") &&
            !file.startsWith("/") &&
            !/^[A-Za-z]:/u.test(file) &&
            !file.split("/").some((part) => part === "" || part === "." || part === ".."),
        ) &&
        canonicalize(testFiles) === canonicalize([...new Set(testFiles)].sort());
      if (!canonicalTestFiles) issues.push(`INVALID_TEST_FILES:${key}`);
      if (
        !Array.isArray(assertionFailureFiles) ||
        !Array.isArray(testFiles) ||
        !assertionFailureFiles.every(
          (file) =>
            typeof file === "string" &&
            file.length > 0 &&
            !file.includes("\\") &&
            !file.startsWith("/") &&
            !/^[A-Za-z]:/u.test(file) &&
            !file.split("/").some((part) => part === "" || part === "." || part === "..") &&
            testFiles.includes(file),
        ) ||
        canonicalize(assertionFailureFiles) !==
          canonicalize([...new Set(assertionFailureFiles)].sort()) ||
        (testOutcome === "ASSERTION_FAILURE" && assertionFailureFiles.length === 0) ||
        (testOutcome === "PASS" && assertionFailureFiles.length !== 0)
      )
        issues.push(`INVALID_ASSERTION_FAILURE_FILES:${key}`);
      if (
        typeof testsDiscovered !== "number" ||
        !Number.isSafeInteger(testsDiscovered) ||
        testsDiscovered <= 0 ||
        (Array.isArray(testFiles) && testsDiscovered < testFiles.length)
      )
        issues.push(`INVALID_TEST_DISCOVERY_COUNT:${key}`);
      if (
        action.adapter === "node-test" &&
        ["skippedTests", "cancelledTests", "todoTests"].some(
          (field) => observation.facts[field] !== 0,
        )
      )
        issues.push(`INVALID_NODE_TEST_COMPLETION:${key}`);
    }
    if (
      observation.bindingDigest !==
      qualificationBinding(
        planDigest,
        candidateDigest,
        observation.worldId,
        observation.attempt,
        observation.actionId,
      )
    )
      issues.push(`INVALID_BINDING:${key}`);
  }
  for (const key of expected) if (!seen.has(key)) issues.push(`MISSING_OBSERVATION:${key}`);
  return issues;
}

export type CreateQualificationReceiptInput = Pick<
  QualificationReceipt,
  "plan" | "planDigest" | "candidateDigest" | "observations" | "provenance" | "externalCi"
>;

function runtimeIssues(
  plan: QualificationPlan,
  provenance: QualificationReceipt["provenance"],
): string[] {
  const issues: string[] = [];
  const tools = provenance.runtime.tools;
  if (
    canonicalize(Object.keys(tools).sort()) !==
    canonicalize(plan.tools.map((tool) => tool.id).sort())
  )
    issues.push("RUNTIME_TOOL_INVENTORY_MISMATCH");
  for (const tool of plan.tools) {
    const observed = tools[tool.id];
    const executable = tool.versionCommand?.executable ?? observed?.executable;
    if (
      !observed ||
      observed.digest !== tool.digest ||
      observed.version !== tool.version ||
      observed.executable !== executable ||
      !plan.actions.some((action) => action.executable === observed.executable) ||
      canonicalize(observed.versionArguments) !==
        canonicalize(tool.versionCommand?.arguments ?? ["--version"])
    )
      issues.push(`RUNTIME_TOOL_CONCORDANCE:${tool.id}`);
  }
  return issues;
}

export function verifyQualificationCiObservation(
  plan: QualificationPlan,
  planDigest: string,
  value: unknown,
): { valid: boolean; reasons: string[] } {
  if (!plan.ciTrust) return { valid: false, reasons: ["LIVE_CI_TRUST_ROOT_MISSING"] };
  if (value === null || value === undefined)
    return { valid: false, reasons: ["LIVE_CI_OBSERVATION_MISSING"] };
  const parsed = QualificationCiObservationSchema.safeParse(value);
  if (!parsed.success) return { valid: false, reasons: ["LIVE_CI_OBSERVATION_INVALID"] };
  const statement = parsed.data;
  const reasons: string[] = [];
  if (
    statement.repositoryId !== plan.ciTrust.repositoryId ||
    statement.observerId !== plan.ciTrust.observerId
  )
    reasons.push("LIVE_CI_OBSERVER_DOMAIN_MISMATCH");
  if (
    statement.planDigest !== planDigest ||
    statement.candidateDigest !== plan.subject.candidateDigest ||
    statement.inputDigest !== plan.subject.inputDigest ||
    statement.commit !== plan.subject.commit ||
    statement.baseCommit !== plan.subject.baseCommit
  )
    reasons.push("LIVE_CI_SUBJECT_MISMATCH");
  if (statement.terminalResult !== "SUCCESS") reasons.push("LIVE_CI_TERMINAL_NOT_SUCCESS");
  if (new Set(statement.steps.map((step) => step.id.toLowerCase())).size !== statement.steps.length)
    reasons.push("LIVE_CI_DUPLICATE_STEP");
  for (const required of plan.ciTrust.requiredSteps) {
    const observed = statement.steps.find((step) => step.id === required.id);
    if (
      observed?.result !== "SUCCESS" ||
      observed.commandDigest !== required.commandDigest ||
      observed.commit !== plan.subject.commit
    )
      reasons.push(`LIVE_CI_REQUIRED_STEP_UNSATISFIED:${required.id}`);
  }
  if (statement.steps.some((step) => step.commit !== plan.subject.commit))
    reasons.push("LIVE_CI_STEP_COMMIT_MISMATCH");
  try {
    const url = new URL(statement.pipelineUrl);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const pipelineIndex = segments.lastIndexOf("pipelines");
    const repositorySegments =
      url.hostname === "api.bitbucket.org"
        ? segments.slice(2, pipelineIndex)
        : segments.slice(0, pipelineIndex);
    const repositoryIdentity =
      repositorySegments.length === 2 &&
      repositorySegments.join("/") === statement.repositoryId &&
      (url.hostname !== "api.bitbucket.org" ||
        (segments[0] === "2.0" && segments[1] === "repositories"));
    const immutableIdentity =
      pipelineIndex >= 0 &&
      ((segments[pipelineIndex + 1] === "results" &&
        segments.length === pipelineIndex + 3 &&
        segments[pipelineIndex + 2] === statement.pipelineId) ||
        (url.hostname === "api.bitbucket.org" &&
          segments.length === pipelineIndex + 2 &&
          segments[pipelineIndex + 1] === statement.pipelineId));
    if (
      url.protocol !== "https:" ||
      !["bitbucket.org", "api.bitbucket.org"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !repositoryIdentity ||
      !immutableIdentity
    )
      reasons.push("LIVE_CI_PIPELINE_IDENTITY_INVALID");
  } catch {
    reasons.push("LIVE_CI_PIPELINE_IDENTITY_INVALID");
  }
  try {
    const key = createPublicKey(plan.ciTrust.publicKeyPem);
    const { signature, ...payload } = statement;
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(canonicalize({ domain: "ASSERTLEDGER_CI_OBSERVATION_V1", statement: payload })),
        key,
        Buffer.from(signature, "base64"),
      )
    )
      reasons.push("LIVE_CI_SIGNATURE_INVALID");
  } catch {
    reasons.push("LIVE_CI_SIGNATURE_INVALID");
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

export function createQualificationReceipt(
  input: CreateQualificationReceiptInput,
): QualificationReceipt {
  const plan = parseQualificationPlan(input.plan);
  if (sha256Canonical(plan) !== input.planDigest)
    throw new Error("Qualification plan digest mismatch");
  if (input.candidateDigest !== plan.subject.candidateDigest)
    throw new Error("Qualification candidate digest mismatch");
  const observations = input.observations.map((observation) =>
    QualificationObservationSchema.parse(observation),
  );
  const provenance = QualificationProvenanceSchema.parse(input.provenance);
  const globalIssues = observationIssues(
    plan,
    input.planDigest,
    input.candidateDigest,
    observations,
  );
  globalIssues.push(...runtimeIssues(plan, provenance));
  for (const observation of observations) {
    const action = plan.actions.find((item) => item.id === observation.actionId);
    if (action?.adapter !== "command" || observation.state !== "COMPLETED") continue;
    const terminal = observation.facts.terminal;
    if (
      terminal !== null &&
      typeof terminal === "object" &&
      !Array.isArray(terminal) &&
      !Object.values(provenance.runtime.tools).some(
        (tool) => tool.executable === action.executable && tool.version === terminal.runtimeVersion,
      )
    )
      globalIssues.push(`COMMAND_TERMINAL_RUNTIME_CONCORDANCE:${observation.actionId}`);
  }
  const missingAdapterVersions = plan.actions.filter(
    (action) => !Object.hasOwn(provenance.adapterVersions, action.adapter),
  );
  for (const action of missingAdapterVersions)
    globalIssues.push(`MISSING_ADAPTER_VERSION:${action.adapter}`);
  for (const [adapter, version] of Object.entries(provenance.adapterVersions)) {
    if (
      !Object.hasOwn(QUALIFICATION_ADAPTER_VERSIONS, adapter) ||
      version !==
        QUALIFICATION_ADAPTER_VERSIONS[adapter as keyof typeof QUALIFICATION_ADAPTER_VERSIONS]
    )
      globalIssues.push(`UNSUPPORTED_ADAPTER_VERSION:${adapter}:${version}`);
  }
  const assessments: QualificationReceipt["assessments"] = plan.obligations.map((obligation) => {
    const reasons: string[] = [...globalIssues];
    for (const suite of plan.suites) {
      if (!plan.obligations.some((item) => item.suiteIds.includes(suite.id)))
        reasons.push(`UNASSIGNED_SUITE:${suite.id}`);
    }
    const mismatches = new Set<string>();
    const checkedActions = new Set(obligation.checks.map((check) => check.actionId));
    let rejected = globalIssues.length > 0;
    for (const suiteId of obligation.suiteIds) {
      const suite = plan.suites.find((item) => item.id === suiteId);
      if (suite?.extraction !== "COMPLETE" || suite.files.length === 0)
        reasons.push(`SUITE_NOT_EXTRACTED:${suiteId}`);
      for (const world of plan.worlds.filter(
        (item) =>
          item.kind !== "TARGET" ||
          item.discriminants.some((discriminant) => discriminant.obligationId === obligation.id),
      )) {
        for (let attempt = 1; attempt <= plan.requiredAttempts; attempt += 1) {
          const observedFiles = new Set(
            observations
              .filter(
                (item) =>
                  item.worldId === world.id &&
                  item.attempt === attempt &&
                  checkedActions.has(item.actionId) &&
                  item.state === "COMPLETED" &&
                  typeof item.facts.testsDiscovered === "number" &&
                  item.facts.testsDiscovered > 0,
              )
              .flatMap((item) => (Array.isArray(item.facts.testFiles) ? item.facts.testFiles : [])),
          );
          for (const file of suite?.files ?? [])
            if (!observedFiles.has(file))
              reasons.push(`SUITE_FILE_NOT_OBSERVED:${suiteId}:${world.id}:${attempt}:${file}`);
        }
      }
    }
    if (obligation.kind === "ci-live") {
      const admission = verifyQualificationCiObservation(plan, input.planDigest, input.externalCi);
      reasons.push(...admission.reasons);
      return {
        obligationId: obligation.id,
        kind: obligation.kind,
        required: obligation.required,
        status: rejected ? "REJECTED" : reasons.length > 0 ? "OPEN" : "COVERED",
        reasons: [...new Set(reasons)].sort(),
        mismatchCheckIds: [],
      };
    }
    const targets = plan.worlds.filter(
      (world) =>
        world.kind === "TARGET" &&
        world.discriminants.some((item) => item.obligationId === obligation.id),
    );
    if (targets.length === 0) reasons.push("MISSING_TARGET_DISCRIMINANT");
    for (const world of plan.worlds) {
      if (world.kind === "TARGET" && !targets.some((target) => target.id === world.id)) continue;
      const discriminant = world.discriminants.find((item) => item.obligationId === obligation.id);
      const signatures: string[] = [];
      for (let attempt = 1; attempt <= plan.requiredAttempts; attempt++) {
        const failed = new Set<string>();
        const checkedValues: unknown[] = [];
        let operational = false;
        for (const check of obligation.checks) {
          const observation = observations.find(
            (item) =>
              item.worldId === world.id &&
              item.attempt === attempt &&
              item.actionId === check.actionId,
          );
          const action = plan.actions.find((item) => item.id === check.actionId);
          if (!observation) {
            operational = true;
            continue;
          }
          const testsRequired =
            action?.adapter === "node-test" ||
            action?.adapter === "bun-native" ||
            obligation.kind === "tests";
          if (
            obligation.kind === "tests" &&
            world.kind !== "TARGET" &&
            (action?.adapter === "node-test" || action?.adapter === "bun-native") &&
            observation.state === "COMPLETED" &&
            (observation.facts.testOutcome !== "PASS" || observation.facts.exitCode !== 0)
          ) {
            rejected = true;
            reasons.push(`TEST_BASELINE_NOT_PASS:${world.id}:${attempt}:${check.actionId}`);
          }
          if (
            observation.state !== "COMPLETED" ||
            ((action?.adapter === "command" || action?.adapter === "turbo") &&
              observation.facts.exitCode !== 0 &&
              observation.facts.commandOutcome !== "EXPECTED_FAILURE") ||
            (testsRequired &&
              (typeof observation.facts.testsDiscovered !== "number" ||
                observation.facts.testsDiscovered <= 0)) ||
            [
              "COLLECTION_FAILURE",
              "COMPILE_FAILURE",
              "PROCESS_CRASH",
              "TIMEOUT",
              "INFRA_ERROR",
              "NO_TEST_DISCOVERED",
            ].includes(String(observation.facts.testOutcome))
          ) {
            operational = true;
            reasons.push(`OPERATIONAL_FAILURE:${world.id}:${attempt}:${check.actionId}`);
          }
          const actual = fieldValue(observation.facts, check.field);
          checkedValues.push(actual === undefined ? { absent: check.field } : actual);
          if (actual === undefined) {
            operational = true;
            reasons.push(`MISSING_FACT:${world.id}:${attempt}:${check.id}`);
          }
          if (!matches(actual, check.expected)) {
            failed.add(check.id);
            mismatches.add(check.id);
          }
        }
        signatures.push(canonicalize({ operational, checkedValues }));
        if (operational) continue;
        if (world.kind !== "TARGET" && failed.size > 0) {
          rejected = true;
          reasons.push(`BASELINE_MISMATCH:${world.id}:${attempt}`);
        }
        if (world.kind === "TARGET") {
          const discriminating = discriminant?.checkIds.some((id) => {
            if (!failed.has(id)) return false;
            if (obligation.kind !== "tests") return true;
            const check = obligation.checks.find((item) => item.id === id);
            const action = plan.actions.find((item) => item.id === check?.actionId);
            const observation = observations.find(
              (item) =>
                item.worldId === world.id &&
                item.attempt === attempt &&
                item.actionId === check?.actionId,
            );
            return (
              (action?.adapter === "node-test" || action?.adapter === "bun-native") &&
              Array.isArray(observation?.facts.assertionFailureFiles) &&
              observation.facts.assertionFailureFiles.some(
                (file) =>
                  typeof file === "string" &&
                  action.arguments.includes(file) &&
                  plan.suites.some(
                    (suite) => obligation.suiteIds.includes(suite.id) && suite.files.includes(file),
                  ),
              ) &&
              observation?.state === "COMPLETED" &&
              observation.facts.testOutcome === "ASSERTION_FAILURE" &&
              observation.facts.attributed === true
            );
          });
          if (!discriminating) reasons.push(`FAULT_NOT_DETECTED:${world.id}:${attempt}`);
          if ([...failed].some((id) => !discriminant?.checkIds.includes(id)))
            reasons.push(`UNDECLARED_MISMATCH:${world.id}:${attempt}`);
        }
      }
      if (new Set(signatures).size !== 1) reasons.push(`UNSTABLE_OBSERVATIONS:${world.id}`);
    }
    return {
      obligationId: obligation.id,
      kind: obligation.kind,
      required: obligation.required,
      status: rejected ? "REJECTED" : reasons.length > 0 ? "OPEN" : "COVERED",
      reasons: [...new Set(reasons)].sort(),
      mismatchCheckIds: [...mismatches].sort(),
    };
  });
  const coveredGuaranteeIds = assessments
    .filter((item) => item.status === "COVERED")
    .map((item) => item.obligationId);
  const openGuaranteeIds = assessments
    .filter((item) => item.status !== "COVERED")
    .map((item) => item.obligationId);
  const required = assessments.filter((item) => item.required);
  const decision =
    globalIssues.length > 0 || required.some((item) => item.status === "REJECTED")
      ? "REJECTED"
      : required.some((item) => item.status !== "COVERED")
        ? "OPEN"
        : "QUALIFIED";
  const decisionProjection = {
    planDigest: input.planDigest,
    candidateDigest: input.candidateDigest,
    assessments,
    coveredGuaranteeIds,
    openGuaranteeIds,
    decision,
  };
  const artifact = {
    schemaVersion: "1.0.0" as const,
    plan,
    ...decisionProjection,
    observations,
    provenance,
    externalCi: input.externalCi,
    decisionDigest: sha256Canonical(decisionProjection),
  };
  return QualificationReceiptSchema.parse({
    ...artifact,
    artifactDigest: sha256Canonical(artifact),
  });
}

export type { QualificationExpectedDomain } from "../contracts/qualification.js";

export function replayQualificationReceipt(
  value: unknown,
  expectedDomain?: QualificationExpectedDomain,
): QualificationReplayResult {
  const result: QualificationReplayResult = {
    valid: false,
    integrityValid: false,
    semanticsValid: false,
    domainValid: false,
    reexecuted: false,
    producerAuthenticated: false,
  };
  try {
    const receipt = QualificationReceiptSchema.parse(value);
    const { artifactDigest, ...artifact } = receipt;
    const {
      assessments,
      coveredGuaranteeIds,
      openGuaranteeIds,
      decision,
      planDigest,
      candidateDigest,
    } = receipt;
    result.integrityValid =
      artifactDigest === sha256Canonical(artifact) &&
      receipt.decisionDigest ===
        sha256Canonical({
          planDigest,
          candidateDigest,
          assessments,
          coveredGuaranteeIds,
          openGuaranteeIds,
          decision,
        });
    const computed = createQualificationReceipt(receipt);
    result.semanticsValid =
      runtimeIssues(receipt.plan, receipt.provenance).length === 0 &&
      observationIssues(receipt.plan, planDigest, candidateDigest, receipt.observations).length ===
        0 &&
      canonicalize(computed) === canonicalize(receipt);
    result.domainValid =
      expectedDomain === undefined ||
      (expectedDomain.planDigest === planDigest &&
        expectedDomain.candidateDigest === candidateDigest &&
        expectedDomain.inputDigest === receipt.plan.subject.inputDigest &&
        expectedDomain.commit === receipt.plan.subject.commit &&
        expectedDomain.baseCommit === receipt.plan.subject.baseCommit &&
        (expectedDomain.mechanismDigest === undefined ||
          (receipt.provenance.runtime !== null &&
            typeof receipt.provenance.runtime === "object" &&
            !Array.isArray(receipt.provenance.runtime) &&
            receipt.provenance.runtime.mechanismDigest === expectedDomain.mechanismDigest)));
    result.valid = result.integrityValid && result.semanticsValid && result.domainValid;
  } catch {
    /* Strict parsing or recomputation failure is a failed replay. */
  }
  return result;
}

/** Attach observations only to an intact receipt whose operator-pinned trust policy is unchanged. */
export function admitQualificationCi(value: unknown, externalCi: unknown): QualificationReceipt {
  if (!replayQualificationReceipt(value).valid)
    throw new Error("QUALIFICATION_SOURCE_RECEIPT_INVALID");
  const receipt = QualificationReceiptSchema.parse(value);
  return createQualificationReceipt({
    ...receipt,
    externalCi: externalCi as QualificationReceipt["externalCi"],
  });
}
