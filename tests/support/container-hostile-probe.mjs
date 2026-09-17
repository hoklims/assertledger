// testforge-command adapter executed inside a real container by
// tests/container-isolation-docker.test.ts. Each world selects a hostile behavior with a
// `// SCENARIO:<name>` marker in src/value.js; any containment breach is reported as PROCESS_CRASH
// so the campaign can never be VERIFIED through an escaped execution.
import { spawn } from "node:child_process";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";

const candidate = JSON.parse(process.env.TESTFORGE_CANDIDATE_FILES ?? "[]").length > 0;
const implementation = await readFile("src/value.js", "utf8");
const scenario = /\/\/ SCENARIO:([a-z]+)/u.exec(implementation)?.[1] ?? "none";

async function report(outcome) {
  await writeFile(
    process.env.TESTFORGE_RESULT_FILE,
    JSON.stringify({
      protocolVersion: "1.0.0",
      outcome,
      testsDiscovered: candidate ? 2 : 1,
      candidateTestsDiscovered: candidate ? 1 : 0,
      attributed: candidate && (outcome === "PASS" || outcome === "ASSERTION_FAILURE"),
    }),
  );
  process.exitCode = outcome === "PASS" ? 0 : 1;
}

async function refused(breaches, label, operation, codes) {
  try {
    await operation();
    breaches.push(`${label}:ALLOWED`);
  } catch (error) {
    if (!codes.includes(error.code)) breaches.push(`${label}:${error.code}`);
  }
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(Object.assign(new Error("connect timed out"), { code: "TIMEOUT" }));
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function containmentBreaches() {
  const breaches = [];
  const interfaces = Object.keys(os.networkInterfaces()).sort();
  if (interfaces.join(",") !== "lo") breaches.push(`network-interfaces:${interfaces.join(",")}`);
  // RFC 5737 TEST-NET-1 is never routed; without an interface the kernel refuses immediately.
  await refused(breaches, "network-connect", () => connect("192.0.2.1", 9), ["ENETUNREACH"]);
  // /var/tmp is world-writable in the image, so only the read-only root file system refuses it.
  await refused(breaches, "root-filesystem", () => writeFile("/var/tmp/escape", "x"), ["EROFS"]);
  await refused(breaches, "host-path", () => readFile(process.env.HOST_CANARY_PATH), ["ENOENT"]);
  await refused(
    breaches,
    "temporary-directory",
    () => writeFile("/tmp/fill", Buffer.alloc(32 * 1024 * 1024, 1)),
    ["ENOSPC"],
  );
  await rm("/tmp/fill", { force: true });

  const expected = new Set(JSON.parse(process.env.ASSERTLEDGER_EXPECTED_ENVIRONMENT ?? "[]"));
  for (const name of Object.keys(process.env).sort()) {
    if (!expected.has(name)) breaches.push(`environment:${name}`);
  }
  if (process.getuid() !== 65534 || process.getgid() !== 65534) {
    breaches.push(`user:${process.getuid()}:${process.getgid()}`);
  }
  const status = await readFile("/proc/self/status", "utf8");
  for (const [field, value] of [
    ["CapEff", "0000000000000000"],
    ["CapBnd", "0000000000000000"],
    ["NoNewPrivs", "1"],
  ]) {
    if (!new RegExp(`^${field}:\\s+${value}$`, "mu").test(status))
      breaches.push(`privilege:${field}`);
  }

  const children = [];
  let refusedSpawns = 0;
  for (let index = 0; index < 200; index += 1) {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    child.on("error", () => {
      refusedSpawns += 1;
    });
    children.push(child);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (const child of children) child.kill("SIGKILL");
  if (refusedSpawns === 0) breaches.push("process-count:UNBOUNDED");
  return breaches;
}

if (scenario === "contained" || scenario === "detected") {
  const breaches = await containmentBreaches();
  if (breaches.length > 0) {
    process.stderr.write(`${breaches.join("\n")}\n`);
    await report("PROCESS_CRASH");
  } else {
    await report(candidate && scenario === "detected" ? "ASSERTION_FAILURE" : "PASS");
  }
} else if (!candidate) {
  await report("PASS");
} else if (scenario === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  setInterval(() => {}, 1_000);
} else if (scenario === "link") {
  await report("PASS");
  await rm(process.env.TESTFORGE_RESULT_FILE);
  await symlink("/etc/passwd", process.env.TESTFORGE_RESULT_FILE);
} else if (scenario === "memory") {
  // Bounded at three times the configured limit so a missing limit cannot exhaust the host.
  const chunks = [];
  for (let allocated = 0; allocated < 768 * 1024 * 1024; allocated += 16 * 1024 * 1024) {
    chunks.push(Buffer.alloc(16 * 1024 * 1024, 1));
  }
  process.stderr.write("memory:UNBOUNDED\n");
  await report("ASSERTION_FAILURE");
} else {
  await report("PASS");
}
