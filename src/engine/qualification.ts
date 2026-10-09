import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  parseQualificationPlan,
  QualificationExecutionRequestSchema,
  type QualificationPlan,
} from "../contracts/qualification.js";
import { canonicalize, sha256Canonical } from "../core/index.js";
import { createQualificationReceipt, qualificationBinding } from "../core/qualification.js";
import { ASSERTLEDGER_VERSION } from "../version.js";
import { collectBunNative, BUN_NATIVE_ADAPTER_VERSION } from "./adapters/bun-native.js";
import { runProcess, type ProcessResult } from "./index.js";
import { NODE_TEST_REPORTER_SOURCE } from "./node-test-reporter.js";

export const ORCHESTRATION_ADAPTER_VERSION = "1.0.0";
const EXCLUDED_ROOTS = new Set([".git", "node_modules", ".testforge", ".turbo", "coverage"]);
const MAXIMUM_INPUT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_FILES = 10_000;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Facts = Record<string, Json>;
type Action = QualificationPlan["actions"][number];
type State = "COMPLETED" | "TIMEOUT" | "CRASH" | "INFRA_ERROR" | "COLLECTION_ERROR" | "NO_TESTS";

export async function qualificationFileDigest(file: string): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(await readFile(file))
    .digest("hex")}`;
}

/** Pin a standalone executable, or the complete transitive distribution of a JavaScript tool. */
export async function qualificationToolDigest(identityPath: string): Promise<string> {
  const resolved = await realpath(identityPath);
  const metadata = await lstat(resolved);
  return metadata.isDirectory()
    ? qualificationRepositoryDigest(resolved)
    : qualificationFileDigest(resolved);
}

/** Identity of the loaded decision/collection implementation, independent of its package version. */
export async function qualificationMechanismDigest(): Promise<string> {
  const sourceExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const relative = [
    "./qualification.js",
    "./index.js",
    "./node-test-reporter.js",
    "./adapters/bun-native.js",
    "../core/qualification.js",
    "../core/index.js",
    "../contracts/qualification.js",
    "../cli.js",
    "../sdk/index.js",
    "../mcp/index.js",
    "../../integrations/bun-native/driver.mjs",
    "../../integrations/bun-native/preload.mjs",
  ];
  const identities = [];
  for (const name of relative) {
    const extension = name.endsWith(".mjs") ? name : name.replace(/\.js$/u, sourceExtension);
    identities.push({
      path: name,
      digest: await qualificationFileDigest(fileURLToPath(new URL(extension, import.meta.url))),
    });
  }
  identities.push({
    path: "engine-node-binary",
    digest: await qualificationFileDigest(await realpath(process.execPath)),
  });
  const require = createRequire(import.meta.url);
  const zodRoot = path.dirname(require.resolve("zod/package.json"));
  identities.push({ path: "zod-distribution", digest: await qualificationToolDigest(zodRoot) });
  return sha256Canonical(identities);
}

function confinedPath(root: string, relative: string): string {
  if (!relative || relative.includes("\\") || relative.startsWith("/") || relative.includes(":")) {
    throw new Error("QUALIFICATION_PATH_INVALID");
  }
  const components = relative.split("/");
  if (components.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("QUALIFICATION_PATH_INVALID");
  }
  return path.join(root, ...components);
}

async function snapshotInputs(
  root: string,
): Promise<Array<{ path: string; content: Buffer; digest: string }>> {
  const files: Array<{ path: string; content: Buffer; digest: string }> = [];
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    const directory = relative === "" ? root : confinedPath(root, relative);
    for (const entry of (await readdir(directory)).sort()) {
      if (relative === "" && EXCLUDED_ROOTS.has(entry)) continue;
      const name = relative === "" ? entry : `${relative}/${entry}`;
      const target = confinedPath(root, name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error("QUALIFICATION_INPUT_SYMLINK");
      if (metadata.isDirectory()) await visit(name);
      else if (metadata.isFile()) {
        const content = await readFile(target);
        bytes += content.byteLength;
        if (bytes > MAXIMUM_INPUT_BYTES || files.length >= MAXIMUM_FILES) {
          throw new Error("QUALIFICATION_INPUT_BUDGET");
        }
        files.push({
          path: name,
          content,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        });
      } else throw new Error("QUALIFICATION_INPUT_NOT_REGULAR");
    }
  }
  await visit("");
  return files;
}

export async function qualificationRepositoryDigest(root: string): Promise<string> {
  const files = await snapshotInputs(await realpath(root));
  return sha256Canonical(files.map(({ path: file, digest }) => ({ path: file, digest })));
}

async function overlay(
  root: string,
  files: ReadonlyArray<{ path: string; content: string | Buffer }>,
): Promise<void> {
  for (const file of files) {
    const target = confinedPath(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: "w" });
  }
}

async function boundedFile(file: string, limit: number): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) {
    throw new Error("QUALIFICATION_REPORT_INVALID");
  }
  return readFile(file, "utf8");
}

function completedState(result: ProcessResult): State {
  if (result.timedOut) return "TIMEOUT";
  if (result.error !== undefined) return "INFRA_ERROR";
  if (result.signal !== null || result.exitCode === null) return "CRASH";
  // Numeric termination alone is only a process fact. Nonzero command completion is
  // admitted below only with a fresh structured semantic attestation.
  return "COMPLETED";
}

async function readTrace(file: string, nonce: string, maximumBytes: number): Promise<Facts> {
  const text = await boundedFile(file, maximumBytes);
  const rows: Array<{ nonce: string; task: string; event: string }> = [];
  if (text !== "") {
    if (!text.endsWith("\n")) throw new Error("QUALIFICATION_TRACE_INCOMPLETE");
    for (const line of text.trimEnd().split("\n")) {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        value.nonce !== nonce ||
        typeof value.task !== "string" ||
        typeof value.event !== "string" ||
        Object.keys(value).sort().join(",") !== "event,nonce,task"
      ) {
        throw new Error("QUALIFICATION_TRACE_INVALID");
      }
      rows.push(value as { nonce: string; task: string; event: string });
    }
  }
  return {
    executedTasks: rows
      .filter((row) => row.event === "start")
      .map((row) => row.task)
      .sort(),
    events: rows.map((row) => `${row.task}:${row.event}`),
    traceDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}

async function turboFacts(root: string, maximumBytes: number): Promise<Facts> {
  const directory = path.join(root, ".turbo", "runs");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
  if (files.length !== 1) throw new Error("QUALIFICATION_TURBO_SUMMARY_MISSING_OR_AMBIGUOUS");
  const text = await boundedFile(path.join(directory, files[0] ?? ""), maximumBytes);
  const summary = JSON.parse(text) as Record<string, unknown>;
  if (!Array.isArray(summary.tasks) || summary.tasks.length === 0)
    throw new Error("QUALIFICATION_TURBO_NO_TASKS");
  const selectedTasks: string[] = [];
  const taskHashes: Record<string, Json> = {};
  const cache: Record<string, Json> = {};
  for (const entry of summary.tasks) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.taskId !== "string" ||
      typeof entry.hash !== "string" ||
      typeof entry.cache !== "object" ||
      entry.cache === null ||
      typeof entry.cache.status !== "string" ||
      selectedTasks.includes(entry.taskId)
    ) {
      throw new Error("QUALIFICATION_TURBO_SUMMARY_INVALID");
    }
    selectedTasks.push(entry.taskId);
    taskHashes[entry.taskId] = entry.hash;
    cache[entry.taskId] = entry.cache.status;
  }
  return {
    selectedTasks: selectedTasks.sort(),
    taskHashes,
    cache,
    summaryDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}

// The parser is an adapter asset outside every candidate/world. YAML structure, never substring
// presence, supplies routes. This observation still says nothing about hosted Bitbucket execution.
const CI_PARSER = `
import { readFile } from "node:fs/promises";
const value = Bun.YAML.parse(await readFile(process.argv[2], "utf8"));
if (!value || typeof value !== "object" || !value.pipelines) throw new Error("CI_PIPELINES_MISSING");
const routes = {};
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("CI_EXECUTION_FIELD_UNSUPPORTED");
}
keys(value, ["definitions", "pipelines"]);
function configuration(value, allowed) {
  keys(value, allowed);
  if (value.trigger !== undefined && !["automatic", "manual"].includes(value.trigger)) throw new Error("CI_TRIGGER_UNSUPPORTED");
  if (value.condition !== undefined && !object(value.condition)) throw new Error("CI_CONDITION_INVALID");
  const { script, steps, ...rest } = value;
  return { ...rest, condition: value.condition ?? null, trigger: value.trigger ?? "automatic" };
}
function steps(items, ancestry) {
  if (!Array.isArray(items)) throw new Error("CI_ROUTE_INVALID");
  const result = [];
  for (const [index, item] of items.entries()) {
    keys(item, ["step", "parallel", "stage"]);
    if (Object.keys(item).length !== 1) throw new Error("CI_STEP_AMBIGUOUS");
    if (item.step) {
      if (!Array.isArray(item.step.script) || !item.step.script.every(x => typeof x === "string")) throw new Error("CI_STEP_INVALID");
      const config = configuration(item.step, ["name", "script", "condition", "trigger"]);
      result.push({ name: item.step.name ?? "", commands: item.step.script, ancestry: [...ancestry, {kind: "step", index, configuration: config}] });
    } else if (item.parallel) {
      const group = Array.isArray(item.parallel) ? { steps: item.parallel } : item.parallel;
      const config = configuration(group, ["steps", "fail-fast", "condition", "trigger"]);
      result.push(...steps(group.steps, [...ancestry, {kind: "parallel", index, configuration: config}]));
    } else if (item.stage) {
      const config = configuration(item.stage, ["name", "steps", "condition", "trigger"]);
      result.push(...steps(item.stage.steps, [...ancestry, {kind: "stage", index, configuration: config}]));
    }
    else throw new Error("CI_STEP_UNSUPPORTED");
  }
  return result;
}
for (const [kind, entries] of Object.entries(value.pipelines)) {
  if (!["default", "branches", "pull-requests", "tags", "custom"].includes(kind)) throw new Error("CI_PIPELINE_KIND_UNSUPPORTED");
  if (Array.isArray(entries)) {
    if (kind !== "default") throw new Error("CI_ROUTE_KIND_INVALID");
    routes[kind] = steps(entries, [{kind: "route", route: kind}]);
  }
  else {
    if (kind === "default") throw new Error("CI_ROUTE_KIND_INVALID");
    if (!object(entries)) throw new Error("CI_ROUTE_INVALID");
    for (const [selector, items] of Object.entries(entries)) {
      const route = kind + ":" + selector;
      routes[route] = steps(items, [{kind: "route", route}]);
    }
  }
}
console.log(JSON.stringify({ ciRoutes: routes }));
`;

const NODE_SUITE_REPORTER = String.raw`
import path from "node:path";
import baseReporter from "./node-base.mjs";
export default async function* reporter(source) {
  const files = new Set();
  async function* observed() {
    for await (const event of source) {
      const data = event?.data;
      if (event?.type === "test:dequeue" && data?.type === "test" && typeof data.file === "string" &&
          (typeof data.name !== "string" || path.resolve(data.name) !== path.resolve(data.file))) {
        files.add(path.relative(process.env.ASSERTLEDGER_QUALIFICATION_WORKSPACE, data.file).split(path.sep).join("/"));
      }
      yield event;
    }
  }
  for await (const chunk of baseReporter(observed())) {
    yield JSON.stringify({ ...JSON.parse(chunk), testFiles: [...files].sort() }) + "\n";
  }
}
`;

async function executeAction(
  action: Action,
  root: string,
  control: string,
  cache: string,
  plan: QualificationPlan,
): Promise<{ state: State; facts: Facts }> {
  await overlay(root, action.prepareFiles);
  for (const relative of action.removePaths)
    await rm(confinedPath(root, relative), { recursive: true, force: true });
  const nonce = randomUUID();
  const trace = path.join(control, `${nonce}.jsonl`);
  await writeFile(trace, "");
  const replace = (value: string) =>
    value
      .replaceAll("{cache}", cache)
      .replaceAll("{workspace}", root)
      .replaceAll("{trace}", trace)
      .replaceAll("{nonce}", nonce);
  const environment = Object.fromEntries(
    Object.entries(action.environment).map(([key, value]) => [key, replace(value)]),
  );
  Object.assign(environment, {
    ASSERTLEDGER_QUALIFICATION_WORKSPACE: root,
    ASSERTLEDGER_QUALIFICATION_TRACE: trace,
    ASSERTLEDGER_QUALIFICATION_NONCE: nonce,
    ASSERTLEDGER_QUALIFICATION_CACHE: cache,
  });
  const structuredResult = path.join(control, `${nonce}.result.json`);
  environment.ASSERTLEDGER_QUALIFICATION_RESULT_FILE = structuredResult;
  let facts: Facts = {};
  let state: State;
  let tapReport: string | undefined;
  if (action.adapter === "bun-native") {
    const result = await collectBunNative({
      executable: action.executable,
      files: action.arguments,
      cwd: root,
      environment,
      timeoutMs: plan.timeoutMs,
      maximumOutputBytes: plan.maximumOutputBytes,
    });
    state = result.state;
    facts = { ...result.facts, adapterRuntime: result.runtime as Json };
  } else {
    let args = action.arguments.map(replace);
    let report: string | undefined;
    if (action.adapter === "node-test") {
      report = path.join(control, `${nonce}.node.json`);
      tapReport = path.join(control, `${nonce}.tap`);
      const reporter = path.join(control, "node-reporter.mjs");
      await writeFile(path.join(control, "node-base.mjs"), NODE_TEST_REPORTER_SOURCE);
      await writeFile(reporter, NODE_SUITE_REPORTER);
      environment.TESTFORGE_NODE_CANDIDATE_FILES = JSON.stringify(
        action.arguments.map((file) => confinedPath(root, file)),
      );
      args = [
        "--test",
        `--test-reporter=${pathToFileURL(reporter).href}`,
        `--test-reporter-destination=${report}`,
        "--test-reporter=tap",
        `--test-reporter-destination=${tapReport}`,
        "--",
        ...action.arguments,
      ];
    } else if (action.adapter === "ci-config") {
      const parser = path.join(control, "ci-parser.mjs");
      await writeFile(parser, CI_PARSER);
      args = [parser, ...args];
    } else if (action.adapter === "turbo") {
      await rm(path.join(root, ".turbo", "runs"), { recursive: true, force: true });
      const separator = action.arguments.indexOf("--");
      const declared = separator < 0 ? action.arguments : action.arguments.slice(0, separator);
      const directoryFlags = declared.filter(
        (value) => value === "--cache-dir" || value.startsWith("--cache-dir="),
      );
      const cacheFlags = declared.filter(
        (value) => value === "--cache" || value.startsWith("--cache="),
      );
      const summaryFlags = declared.filter(
        (value) => value === "--summarize" || value.startsWith("--summarize="),
      );
      const directoryIndex = declared.indexOf("--cache-dir");
      const controlledDirectory =
        declared.includes("--cache-dir={cache}") ||
        (directoryIndex >= 0 && declared[directoryIndex + 1] === "{cache}");
      if (
        summaryFlags.length !== 1 ||
        summaryFlags[0] !== "--summarize" ||
        directoryFlags.length !== 1 ||
        cacheFlags.length !== 1 ||
        !controlledDirectory ||
        cacheFlags[0] !== "--cache=local:rw"
      )
        throw new Error("QUALIFICATION_TURBO_CACHE_NOT_CONTROLLED");
    }
    const processResult = await runProcess({
      executable: action.executable,
      args,
      cwd: root,
      environment,
      timeoutMs: plan.timeoutMs,
      maximumOutputBytes: plan.maximumOutputBytes,
    });
    state = completedState(processResult);
    facts = {
      exitCode: processResult.exitCode,
      stdoutDigest: processResult.stdout.digest,
      stderrDigest: processResult.stderr.digest,
    };
    if (action.adapter === "command" && state === "COMPLETED" && processResult.exitCode === 0)
      facts.commandOutcome = "PASS";
    if (processResult.stdout.truncated || processResult.stderr.truncated)
      state = "COLLECTION_ERROR";
    if (state === "COMPLETED") {
      try {
        if (report !== undefined) {
          const document = JSON.parse(await boundedFile(report, plan.maximumOutputBytes));
          if (
            document.protocolVersion !== "1.0.0" ||
            !Number.isSafeInteger(document.testsDiscovered) ||
            !Number.isSafeInteger(document.candidateTestsDiscovered) ||
            !Number.isSafeInteger(document.candidateFailureCount) ||
            !Number.isSafeInteger(document.nonCandidateFailureCount) ||
            typeof document.candidateFailuresAllAssertions !== "boolean"
          ) {
            throw new Error("QUALIFICATION_NODE_REPORT_INVALID");
          }
          if (
            !Array.isArray(document.testFiles) ||
            !document.testFiles.every((file: unknown) => typeof file === "string")
          )
            throw new Error("QUALIFICATION_NODE_FILE_REPORT_INVALID");
          facts.testFiles = document.testFiles;
          facts.testsDiscovered = document.candidateTestsDiscovered;
          if (action.arguments.some((file) => !document.testFiles.includes(file)))
            state = "NO_TESTS";
          facts.attributed =
            document.candidateFailureCount > 0 &&
            document.nonCandidateFailureCount === 0 &&
            document.candidateFailuresAllAssertions;
          const tap = await boundedFile(tapReport ?? "", plan.maximumOutputBytes);
          for (const name of ["skipped", "cancelled", "todo"]) {
            const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gmu"))];
            if (matches.length !== 1) throw new Error("QUALIFICATION_NODE_SUMMARY_INVALID");
            const count = Number(matches[0]?.[1]);
            facts[`${name}Tests`] = count;
            if (count !== 0) state = "COLLECTION_ERROR";
          }
          facts.testOutcome =
            document.nonCandidateFailureCount > 0 || !document.candidateFailuresAllAssertions
              ? "PROCESS_CRASH"
              : document.candidateFailureCount > 0
                ? "ASSERTION_FAILURE"
                : "PASS";
          if (document.candidateTestsDiscovered === 0) state = "NO_TESTS";
          else if (facts.testOutcome === "PROCESS_CRASH") state = "COLLECTION_ERROR";
          else if ((facts.testOutcome === "PASS") !== (processResult.exitCode === 0))
            state = "COLLECTION_ERROR";
        } else if (action.adapter === "ci-config") {
          if (processResult.exitCode !== 0) state = "COLLECTION_ERROR";
          else facts = { ...facts, ...JSON.parse(processResult.stdout.text) };
        } else if (action.adapter === "turbo")
          facts = {
            ...facts,
            ...(await turboFacts(root, Math.max(plan.maximumOutputBytes, 1024 * 1024))),
          };
      } catch {
        state = "COLLECTION_ERROR";
      }
    }
  }
  if (state === "COMPLETED") {
    try {
      if (
        action.observe.report !== null ||
        (action.adapter === "command" && facts.exitCode !== 0)
      ) {
        const raw = await boundedFile(structuredResult, plan.maximumOutputBytes);
        const document = JSON.parse(raw) as Record<string, unknown>;
        if (
          raw !== `${canonicalize(document)}\n` ||
          Object.keys(document).sort().join(",") !== "facts,nonce,protocolVersion" ||
          document.protocolVersion !== "1.0.0" ||
          document.nonce !== nonce ||
          typeof document.facts !== "object" ||
          document.facts === null ||
          Array.isArray(document.facts)
        ) {
          throw new Error("QUALIFICATION_STRUCTURED_REPORT_INVALID");
        }
        facts.report = document.facts as Json;
        facts.reportDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
        facts.reportProvenance = "STRUCTURED_ADAPTER_REPORTED";
        if (action.adapter === "command" && facts.exitCode !== 0) {
          const completion = document.facts as Record<string, unknown>;
          if (
            completion.commandOutcome !== "EXPECTED_FAILURE" ||
            completion.exitCode !== facts.exitCode
          )
            throw new Error("QUALIFICATION_COMMAND_COMPLETION_INVALID");
          facts.commandOutcome = "EXPECTED_FAILURE";
        }
      }
      if (action.observe.trace)
        facts = { ...facts, ...(await readTrace(trace, nonce, plan.maximumOutputBytes)) };
      const outputs: Record<string, Json> = {};
      for (const file of action.observe.outputs) {
        try {
          const target = confinedPath(root, file);
          const metadata = await lstat(target);
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("INVALID_OUTPUT");
          outputs[file] = await qualificationFileDigest(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") outputs[file] = null;
          else throw error;
        }
      }
      facts.outputs = outputs;
    } catch {
      state = "COLLECTION_ERROR";
    }
  }
  return { state, facts };
}

export interface QualifyOrchestrationOptions {
  allowUnsafeExecution?: boolean;
}

/** The digest of an operator-owned plan must be anchored outside candidate-controlled inputs. */
export async function qualifyOrchestration(
  value: {
    root: string;
    plan: unknown;
    planDigest: string;
    candidate: { files: Array<{ path: string; content: string }> };
  },
  options: QualifyOrchestrationOptions = {},
) {
  if (options.allowUnsafeExecution !== true)
    throw new Error("QUALIFICATION_UNSAFE_EXECUTION_NOT_AUTHORIZED");
  value = QualificationExecutionRequestSchema.parse(value);
  const plan = parseQualificationPlan(value.plan);
  if (sha256Canonical(plan) !== value.planDigest)
    throw new Error("QUALIFICATION_PLAN_DIGEST_MISMATCH");
  const candidateDigest = sha256Canonical(value.candidate.files);
  if (candidateDigest !== plan.subject.candidateDigest)
    throw new Error("QUALIFICATION_CANDIDATE_DIGEST_MISMATCH");
  if (value.candidate.files.some((file) => !plan.allowedCandidatePaths.includes(file.path)))
    throw new Error("QUALIFICATION_CANDIDATE_SCOPE");
  const root = await realpath(value.root);
  const inputs = await snapshotInputs(root);
  const inputDigest = sha256Canonical(
    inputs.map(({ path: file, digest }) => ({ path: file, digest })),
  );
  if (inputDigest !== plan.subject.inputDigest)
    throw new Error("QUALIFICATION_INPUT_DIGEST_MISMATCH");
  const executableFacts: Record<string, Json> = {};
  const actionExecutables = new Map<string, string>();
  for (const executable of new Set(plan.actions.map((action) => action.executable))) {
    if (!path.isAbsolute(executable)) throw new Error("QUALIFICATION_EXECUTABLE_NOT_ABSOLUTE");
    const digest = await qualificationFileDigest(await realpath(executable));
    actionExecutables.set(executable, digest);
    if (!plan.tools.some((entry) => entry.digest === digest))
      throw new Error("QUALIFICATION_TOOL_DIGEST_MISMATCH");
  }
  for (const tool of plan.tools) {
    const inferred = [...actionExecutables].find(([, digest]) => digest === tool.digest)?.[0];
    const identityPath = tool.identityPath ?? inferred;
    if (identityPath === undefined || !path.isAbsolute(identityPath))
      throw new Error("QUALIFICATION_TOOL_IDENTITY_MISSING");
    const digest = await qualificationToolDigest(identityPath);
    if (digest !== tool.digest) throw new Error("QUALIFICATION_TOOL_DIGEST_MISMATCH");
    const executable = tool.versionCommand?.executable ?? inferred;
    if (
      executable === undefined ||
      !path.isAbsolute(executable) ||
      !actionExecutables.has(executable)
    )
      throw new Error("QUALIFICATION_TOOL_PROBE_UNBOUND");
    const args = tool.versionCommand?.arguments ?? ["--version"];
    const probe = await runProcess({
      executable,
      args,
      cwd: root,
      environment:
        plan.actions.find((action) => action.executable === executable)?.environment ?? {},
      timeoutMs: 5000,
      maximumOutputBytes: 65536,
    });
    if (
      probe.exitCode !== 0 ||
      probe.timedOut ||
      probe.stdout.truncated ||
      probe.stdout.text.trim().replace(/^v/u, "") !== tool.version
    )
      throw new Error("QUALIFICATION_TOOL_VERSION_MISMATCH");
    executableFacts[tool.id] = {
      executable,
      identityPath,
      digest,
      version: tool.version,
      versionArguments: args,
    };
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "assertledger-orchestration-"));
  const mechanismDigest = await qualificationMechanismDigest();
  const observations = [];
  try {
    for (const world of plan.worlds) {
      for (let attempt = 1; attempt <= plan.requiredAttempts; attempt += 1) {
        const domain = path.join(temporary, `${world.id}-${attempt}`);
        const workspace = path.join(domain, "workspace");
        const control = path.join(domain, "control");
        const cache = path.join(domain, "cache");
        await Promise.all([
          mkdir(workspace, { recursive: true }),
          mkdir(control, { recursive: true }),
          mkdir(cache, { recursive: true }),
        ]);
        await overlay(workspace, inputs);
        await overlay(workspace, value.candidate.files);
        await overlay(workspace, world.files);
        for (const action of plan.actions) {
          const observation = await executeAction(action, workspace, control, cache, plan);
          observations.push({
            worldId: world.id,
            attempt,
            actionId: action.id,
            ...observation,
            bindingDigest: qualificationBinding(
              value.planDigest,
              candidateDigest,
              world.id,
              attempt,
              action.id,
            ),
          });
        }
      }
    }
    // Protect domain reuse against source/tool mutation while observations were collected.
    if ((await qualificationRepositoryDigest(root)) !== inputDigest)
      throw new Error("QUALIFICATION_INPUT_DIGEST_CHANGED");
    if ((await qualificationMechanismDigest()) !== mechanismDigest)
      throw new Error("QUALIFICATION_MECHANISM_CHANGED");
    for (const fact of Object.values(executableFacts)) {
      const tool = fact as { identityPath: string; digest: string };
      if ((await qualificationToolDigest(tool.identityPath)) !== tool.digest)
        throw new Error("QUALIFICATION_TOOL_DIGEST_CHANGED");
    }
    return createQualificationReceipt({
      plan,
      planDigest: value.planDigest,
      candidateDigest,
      observations,
      provenance: {
        engineVersion: ASSERTLEDGER_VERSION,
        adapterVersions: {
          command: ORCHESTRATION_ADAPTER_VERSION,
          turbo: ORCHESTRATION_ADAPTER_VERSION,
          "node-test": ORCHESTRATION_ADAPTER_VERSION,
          "ci-config": ORCHESTRATION_ADAPTER_VERSION,
          "bun-native": BUN_NATIVE_ADAPTER_VERSION,
        },
        runtime: {
          mechanismDigest,
          platform: process.platform,
          architecture: process.arch,
          node: process.versions.node,
          tools: executableFacts,
          collectorDigest: sha256Canonical({
            ciParser: CI_PARSER,
            nodeReporter: NODE_TEST_REPORTER_SOURCE,
          }),
          snapshotExcludes: [...EXCLUDED_ROOTS].sort(),
          dependencySnapshot: "EXCLUDED_NODE_MODULES",
        },
        executionTrust: "TRUSTED_LOCAL_UNSANDBOXED",
      },
      externalCi: null,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
