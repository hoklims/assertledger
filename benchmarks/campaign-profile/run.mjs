import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
const task = realpathSync(process.argv[2]);
const dependencyRoot = realpathSync(join(task, "base/node_modules/.pnpm"));
mkdirSync(join(task, "runs"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
function tree(root) {
  const rows = [];
  function visit(relative) {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (name === ".e5-private") continue;
      const file = join(relative, name);
      const stat = lstatSync(join(root, file));
      if (stat.isSymbolicLink()) rows.push([file, { link: readlinkSync(join(root, file)) }]);
      else if (stat.isDirectory()) visit(file);
      else rows.push([file, digest(readFileSync(realpathSync(join(root, file))))]);
    }
  }
  visit("");
  return { sha256: digest(JSON.stringify(rows)), files: rows.length };
}
const identities = () => ({
  base: tree(join(task, "base")),
  profile: tree(join(task, "profile")),
  dependencies: tree(dependencyRoot),
  repository: tree(join(task, "repository")),
  request: digest(readFileSync(join(task, "request.json"))),
  node: digest(readFileSync(process.execPath)),
});
const before = identities();
writeFileSync(join(task, "identities-before.json"), JSON.stringify(before, null, 2));
writeFileSync(
  join(task, "environment.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node: process.version,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: os.version(),
      cpus: os.cpus().map((c) => c.model),
      memory: os.totalmem(),
      environment: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      order: [
        "base-warm",
        "profile-warm",
        "base-1",
        "profile-1",
        "profile-2",
        "base-2",
        "base-3",
        "profile-3",
      ],
    },
    null,
    2,
  ),
);
async function command(executable, args, env) {
  const child = spawn(executable, args, {
    cwd: task,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (s) => (stdout += s));
  child.stderr.on("data", (s) => (stderr += s));
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
function projection(manifest) {
  const copy = structuredClone(manifest);
  delete copy.artifactDigest;
  for (const o of copy.observations)
    for (const k of ["durationMs", "stdoutDigest", "stderrDigest"]) delete o[k];
  return digest(JSON.stringify(copy));
}
const summary = [];
let expected;
for (const label of [
  "base-warm",
  "profile-warm",
  "base-1",
  "profile-1",
  "profile-2",
  "base-2",
  "base-3",
  "profile-3",
]) {
  const variant = label.startsWith("base") ? "base" : "profile";
  const out = join(task, "runs", label);
  mkdirSync(out, { recursive: true });
  const cli = join(task, variant, "dist/cli.js");
  const samples = [];
  const sample = () =>
    samples.push({
      at: new Date().toISOString(),
      load: os.loadavg(),
      free: os.freemem(),
      cpu: os.cpus().map((c) => c.times),
    });
  sample();
  const sampling = setInterval(sample, 500);
  const env = {
    ...process.env,
    TMPDIR: join(task, "tmp"),
    ASSERTLEDGER_RUNTIME_TRACE: join(out, "runtime.jsonl"),
  };
  delete env.NODE_OPTIONS;
  delete env.E5_SPANS;
  if (variant === "profile") env.E5_SPANS = join(out, "spans.json");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = await command(
    process.execPath,
    [cli, "verify", join(task, "request.json"), "--allow-unsafe-execution"],
    env,
  );
  const wallMs = performance.now() - started;
  clearInterval(sampling);
  sample();
  writeFileSync(join(out, "stdout.json"), result.stdout);
  writeFileSync(join(out, "stderr.txt"), result.stderr);
  writeFileSync(join(out, "load.json"), JSON.stringify(samples));
  if (result.code !== 0 || result.signal || result.stderr)
    throw new Error(label + ": " + JSON.stringify(result));
  const manifest = JSON.parse(result.stdout);
  if (manifest.decision.status !== "VERIFIED" || manifest.observations.length !== 18)
    throw new Error(label + ": unexpected result");
  const fingerprint = projection(manifest);
  expected ??= fingerprint;
  if (fingerprint !== expected) throw new Error(label + ": semantic divergence");
  const replay = await command(
    process.execPath,
    [join(task, "base/dist/cli.js"), "replay", join(out, "stdout.json")],
    { ...process.env, TMPDIR: join(task, "tmp") },
  );
  writeFileSync(join(out, "replay.json"), replay.stdout);
  if (replay.code !== 0 || !JSON.parse(replay.stdout).valid)
    throw new Error(label + ": invalid replay");
  const trace = readFileSync(join(out, "runtime.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  if (
    trace.length !== 19 ||
    trace.filter((r) => r.phase === "host-snapshot").length !== 1 ||
    trace.filter((r) => r.phase === "host-workspace-copy").length !== 18 ||
    trace.some((r) => r.threw)
  )
    throw new Error(label + ": trace coverage");
  if (variant === "profile") {
    const { records } = JSON.parse(readFileSync(join(out, "spans.json"), "utf8"));
    for (const [name, count] of [
      ["verifyCampaign", 1],
      ["runNodeTestRuntimePreflight", 1],
      ["executeObservation", 18],
      ["runBoundedProcess", 22],
      ["decideEvidence", 1],
    ])
      if (records.filter((r) => r.name === name).length !== count)
        throw new Error(label + ": span coverage " + name);
    if (records.some((r) => !Number.isFinite(r.end))) throw new Error(label + ": unfinished span");
  }
  summary.push({
    label,
    startedAt,
    wallMs,
    code: result.code,
    signal: result.signal,
    stderr: result.stderr,
    decision: manifest.decision,
    observations: manifest.observations.length,
    semanticSha256: fingerprint,
    artifactDigest: manifest.artifactDigest,
    decisionDigest: manifest.decisionDigest,
    replay: JSON.parse(replay.stdout),
  });
  writeFileSync(join(task, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary.at(-1)) + "\n");
}
const after = identities();
writeFileSync(join(task, "identities-after.json"), JSON.stringify(after, null, 2));
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Producer or inputs changed");
