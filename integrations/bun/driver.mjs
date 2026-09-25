import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_VERSION = "1.0.0";
const ASSERTION_ERROR_NAME = "AssertLedgerBunAssertionError";
const ASSERTION_ERROR_MESSAGE = "AssertLedger assertSame failed";
const HELPER_RELATIVE_PATH = path.join("node_modules", "assertledger", "bun.mjs");
const MAX_OUTPUT_BYTES = 64 * 1024;
const STARTUP_TIMEOUT_MS = 5_000;
const BUN_REVISION = "1.4.2+744846f84";

function report(outcome, testsDiscovered = 0, candidateTestsDiscovered = 0, attributed = false) {
  return {
    protocolVersion: RESULT_VERSION,
    outcome,
    testsDiscovered,
    candidateTestsDiscovered,
    attributed,
  };
}

function infrastructureFailure(reason) {
  console.error(`BUN_TEST_INFRA_ERROR:${reason}`);
  return report("INFRA_ERROR");
}

function normalizeRelativeFile(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("-") ||
    path.isAbsolute(value)
  )
    return undefined;
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeEventUrl(value, root) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let file = value;
  if (file.startsWith("file:")) {
    try {
      file = new URL(file).pathname;
      if (/^\/[A-Za-z]:\//u.test(file)) file = file.slice(1);
      file = decodeURIComponent(file);
    } catch {
      return undefined;
    }
  }
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  return normalizeRelativeFile(relative);
}

async function installHelper(helperSource) {
  const packageRoot = path.join(process.cwd(), "node_modules", "assertledger");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "bun.mjs"), helperSource, { flag: "wx" });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "assertledger", type: "module", exports: { "./bun": "./bun.mjs" } }, null, 2)}\n`,
    { flag: "wx" },
  );
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) throw new Error("OUTPUT_LIMIT");
  return next;
}

async function verifyBunRevision(executable) {
  const child = spawn(executable, ["--revision"], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let invalidOutput = false;
  const collect = (chunk, stream) => {
    try {
      if (stream === "stdout") stdout = appendBounded(stdout, chunk);
      else stderr = appendBounded(stderr, chunk);
    } catch {
      invalidOutput = true;
      child.kill();
    }
  };
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, STARTUP_TIMEOUT_MS);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  if (
    timedOut ||
    invalidOutput ||
    exitCode !== 0 ||
    stderr.length !== 0 ||
    stdout.trim() !== BUN_REVISION
  ) {
    throw new Error("UNSUPPORTED_BUN_REVISION");
  }
}

async function connectInspector(url, events) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (message) => {
    let document;
    try {
      document = JSON.parse(String(message.data));
    } catch {
      events.invalidMessage = true;
      return;
    }
    if (typeof document?.id === "number") {
      const entry = pending.get(document.id);
      if (entry !== undefined) {
        pending.delete(document.id);
        if (document.error !== undefined) entry.reject(new Error("INSPECTOR_COMMAND_FAILED"));
        else entry.resolve(document.result);
      }
      return;
    }
    if (typeof document?.method === "string") events.messages.push(document);
    else events.invalidMessage = true;
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("INSPECTOR_CONNECTION_FAILED")), {
      once: true,
    });
  });
  const send = (method) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method }));
    });
  await send("Inspector.enable");
  await send("TestReporter.enable");
  await send("LifecycleReporter.enable");
  await send("Inspector.initialized");
  return socket;
}

async function drainInspector(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    socket.addEventListener("close", finish, { once: true });
  });
  if (socket.readyState !== WebSocket.CLOSED) socket.close();
}

export function classifyBunInspectorEvents(
  messages,
  candidateFiles,
  root,
  processExitCode,
  invalidMessage,
) {
  if (invalidMessage) return infrastructureFailure("INVALID_INSPECTOR_MESSAGE");
  const found = [];
  const active = new Map();
  const started = new Set();
  const completed = [];
  let ambiguous = false;

  for (const message of messages) {
    const params = message.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      ambiguous = true;
      continue;
    }
    if (message.method === "TestReporter.found") {
      const id = params.id;
      if (params.type === "describe") continue;
      const file = normalizeEventUrl(params.url, root);
      if (
        (typeof id !== "number" && typeof id !== "string") ||
        file === undefined ||
        params.type !== "test"
      ) {
        ambiguous = true;
      } else found.push({ id: String(id), file });
    } else if (message.method === "TestReporter.start") {
      const id = params.id;
      if (
        (typeof id !== "number" && typeof id !== "string") ||
        started.has(String(id)) ||
        active.size !== 0
      )
        ambiguous = true;
      else {
        started.add(String(id));
        active.set(String(id), { errors: [] });
      }
    } else if (message.method === "LifecycleReporter.error") {
      if (active.size !== 1) ambiguous = true;
      else active.values().next().value.errors.push(params);
    } else if (message.method === "TestReporter.end") {
      const id = params.id;
      const entry = active.get(String(id));
      if (entry === undefined) ambiguous = true;
      else {
        active.delete(String(id));
        if (params.status !== "pass" && params.status !== "fail") ambiguous = true;
        completed.push({ id: String(id), errors: entry.errors, status: params.status });
      }
    }
  }
  if (ambiguous || found.length === 0 || started.size === 0) {
    return infrastructureFailure("AMBIGUOUS_OR_INCOMPLETE_EVENTS");
  }
  const foundById = new Map();
  for (const item of found) {
    if (foundById.has(item.id)) return infrastructureFailure("DUPLICATE_TEST_ID");
    foundById.set(item.id, item.file);
  }
  if ([...started].some((id) => !foundById.has(id))) {
    return infrastructureFailure("START_WITHOUT_DISCOVERY");
  }
  const tests = completed.filter((item) => foundById.has(item.id));
  if (
    tests.length !== completed.length ||
    new Set(tests.map((item) => item.id)).size !== tests.length
  ) {
    return infrastructureFailure("TEST_DISCOVERY_COMPLETION_MISMATCH");
  }
  if (processExitCode === 0) {
    if (
      tests.some((item) => item.status !== "pass" || item.errors.length !== 0) ||
      [...active.values()].some((item) => item.errors.length !== 0)
    ) {
      return infrastructureFailure("ZERO_EXIT_WITH_TEST_FAILURE");
    }
    const candidateStarted = [...started].filter((id) =>
      candidateFiles.has(foundById.get(id)),
    ).length;
    if (candidateFiles.size > 0 && candidateStarted === 0) {
      return report("NO_TEST_DISCOVERED", started.size, 0, false);
    }
    return report("PASS", started.size, candidateStarted, candidateFiles.size > 0);
  }
  if (active.size !== 0 || tests.length !== found.length) {
    return infrastructureFailure("NONZERO_EXIT_WITH_INCOMPLETE_EVENTS");
  }
  const candidateTests = tests.filter((item) => candidateFiles.has(foundById.get(item.id)));
  if (
    tests.some(
      (item) =>
        (item.status === "pass" && item.errors.length !== 0) ||
        (item.status === "fail" && item.errors.length === 0),
    ) ||
    tests.every((item) => item.status === "pass")
  ) {
    return infrastructureFailure("TEST_PROCESS_CONTRADICTION");
  }
  const candidateFailures = candidateTests.filter((item) => item.errors.length > 0);
  const nonCandidateFailures = tests.filter(
    (item) => !candidateFiles.has(foundById.get(item.id)) && item.errors.length > 0,
  );
  if (candidateFiles.size === 0) {
    return report("PROCESS_CRASH", tests.length);
  }
  if (candidateTests.length === 0) {
    return report("PROCESS_CRASH", tests.length, 0, false);
  }
  if (nonCandidateFailures.length > 0 || candidateFailures.length > 1) {
    return report("PROCESS_CRASH", tests.length, candidateTests.length, false);
  }
  if (candidateFailures.length === 1) {
    const failure = candidateFailures[0];
    if (failure.errors.length !== 1)
      return report("PROCESS_CRASH", tests.length, candidateTests.length, false);
    const error = failure.errors[0];
    const assertion =
      error?.name === ASSERTION_ERROR_NAME &&
      error?.message === ASSERTION_ERROR_MESSAGE &&
      Array.isArray(error?.urls) &&
      normalizeEventUrl(error.urls[0], root) === HELPER_RELATIVE_PATH;
    return report(
      assertion ? "ASSERTION_FAILURE" : "PROCESS_CRASH",
      tests.length,
      candidateTests.length,
      assertion,
    );
  }
  return report("PROCESS_CRASH", tests.length, candidateTests.length, false);
}

async function main() {
  const resultFile = process.env.TESTFORGE_RESULT_FILE;
  if (typeof resultFile !== "string" || resultFile.length === 0)
    throw new Error("RESULT_FILE_REQUIRED");
  const [bunExecutable, helperSourcePath, ...testFiles] = process.argv.slice(2);
  if (bunExecutable === undefined || helperSourcePath === undefined || testFiles.length === 0) {
    throw new Error("INVALID_ARGUMENTS");
  }
  if (!path.isAbsolute(bunExecutable) || !path.isAbsolute(helperSourcePath)) {
    throw new Error("INVALID_ARGUMENTS");
  }
  const parsedCandidates = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]");
  if (!Array.isArray(parsedCandidates)) throw new Error("INVALID_CANDIDATES");
  const normalizedBaseTests = testFiles.map(normalizeRelativeFile);
  const normalizedCandidates = parsedCandidates.map(normalizeRelativeFile);
  if (
    normalizedBaseTests.some((file) => file === undefined) ||
    normalizedCandidates.some((file) => file === undefined)
  ) {
    throw new Error("INVALID_PATH");
  }
  const candidateFiles = new Set(normalizedCandidates);
  const normalizedTests = [...normalizedBaseTests, ...normalizedCandidates];
  if (
    new Set(normalizedTests).size !== normalizedTests.length ||
    candidateFiles.size !== normalizedCandidates.length
  ) {
    throw new Error("INVALID_CANDIDATES");
  }
  await verifyBunRevision(bunExecutable);
  await installHelper(
    await import("node:fs/promises").then(({ readFile }) => readFile(helperSourcePath, "utf8")),
  );

  const events = { messages: [], invalidMessage: false };
  const child = spawn(
    bunExecutable,
    [
      "--inspect-wait=ws://127.0.0.1:0",
      "test",
      "--max-concurrency=1",
      ...testFiles,
      ...parsedCandidates,
    ],
    { cwd: process.cwd(), env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let settled = false;
  const startupTimer = setTimeout(() => {
    child.kill();
  }, STARTUP_TIMEOUT_MS);
  const inspectUrl = await new Promise((resolve, reject) => {
    const inspect = (chunk, stream) => {
      try {
        if (stream === "stdout") stdout = appendBounded(stdout, chunk);
        else stderr = appendBounded(stderr, chunk);
      } catch (error) {
        events.invalidMessage = true;
        reject(error);
        child.kill();
        return;
      }
      const match = `${stdout}\n${stderr}`.match(/ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9-]*/u);
      if (match !== null && !settled) {
        settled = true;
        resolve(match[0]);
      }
    };
    child.stdout.on("data", (chunk) => inspect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => inspect(chunk, "stderr"));
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(`BUN_EXITED_BEFORE_INSPECTOR\n${stdout}\n${stderr}`)),
    );
  });
  clearTimeout(startupTimer);
  const socket = await connectInspector(inspectUrl, events);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  await drainInspector(socket);
  const result = classifyBunInspectorEvents(
    events.messages,
    candidateFiles,
    process.cwd(),
    exitCode,
    events.invalidMessage,
  );
  await writeFile(resultFile, `${JSON.stringify(result)}\n`, { flag: "wx" });
  process.exitCode = result.outcome === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : "UNKNOWN_DRIVER_ERROR");
    try {
      const resultFile = process.env.TESTFORGE_RESULT_FILE;
      if (typeof resultFile === "string" && resultFile.length > 0) {
        await writeFile(resultFile, `${JSON.stringify(report("INFRA_ERROR"))}\n`, { flag: "wx" });
      }
    } catch {}
    process.exitCode = 1;
  });
}
